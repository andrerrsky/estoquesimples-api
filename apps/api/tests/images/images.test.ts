import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ImageService } from '../../src/modules/images/images.service.js';
import { workspaceMembers } from '../../src/platform/db/schema/index.js';
import { imageKey } from '../../src/platform/storage/object-storage.js';
import { createTestApp, registerUser, resetDatabase, type RegisteredUser, type TestContext } from '../helpers/test-app.js';

let context: TestContext;
let storageDir: string;

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'es-images-'));
  context = await createTestApp({ IMAGE_FS_DIR: storageDir, IMAGE_MAX_UPLOAD_BYTES: '400000' });
});

afterAll(async () => {
  await context.close();
  await rm(storageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase(context);
});

const base = (ws: string) => `/v1/workspaces/${ws}`;
const SYNC = { 'x-sync-protocol': '1' };

async function workspaceOf(user: RegisteredUser): Promise<string> {
  const response = await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: user.authHeader, payload: { name: 'Loja de Teste' } });
  expect(response.statusCode).toBe(201);
  return response.json().id;
}

async function addMember(workspaceId: string, owner: RegisteredUser, user: RegisteredUser, role: string): Promise<void> {
  await context.services.db.insert(workspaceMembers).values({ workspaceId, userId: user.userId, roleKey: role, status: 'active', invitedBy: owner.userId });
}

/** Foto "de verdade": ruído para a compressão não zerar o tamanho. */
async function photo(format: 'png' | 'jpeg' | 'webp', width = 800, height = 600, seed = 7, noise = 1): Promise<Buffer> {
  // `noise` < 1: ruído em resolução menor, ampliado — imagem grande em pixels e leve em bytes.
  const nw = Math.max(8, Math.round(width * noise));
  const nh = Math.max(8, Math.round(height * noise));
  const raw = Buffer.alloc(nw * nh * 3);
  let x = seed;
  for (let i = 0; i < raw.length; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = (x >> 16) & 0xff;
  }
  const image = noise < 1 ? sharp(raw, { raw: { width: nw, height: nh, channels: 3 } }).resize(width, height, { kernel: 'nearest' }) : sharp(raw, { raw: { width, height, channels: 3 } });
  if (format === 'png') return image.png().toBuffer();
  if (format === 'jpeg') return image.jpeg({ quality: 70 }).toBuffer();
  return image.webp({ quality: 60 }).toBuffer();
}

const put = (ws: string, user: RegisteredUser, body: Buffer, contentType: string) =>
  context.app.inject({ method: 'PUT', url: `${base(ws)}/images`, headers: { ...user.authHeader, 'content-type': contentType }, payload: body });
const get = (ws: string, user: RegisteredUser, hash: string, headers: Record<string, string> = {}) =>
  context.app.inject({ method: 'GET', url: `${base(ws)}/images/${hash}`, headers: { ...user.authHeader, ...headers } });

describe('imagens de produto', () => {
  it('guarda como WebP dentro do limite, é idempotente e entrega com cache imutável', async () => {
    const owner = await registerUser(context);
    const ws = await workspaceOf(owner);
    const original = await photo('jpeg', 3000, 2000, 5, 0.01);

    const first = await put(ws, owner, original, 'image/jpeg');
    expect(first.statusCode).toBe(201);
    const stored = first.json();
    expect(stored).toMatchObject({ contentType: 'image/webp', created: true });
    expect(Math.max(stored.width, stored.height)).toBe(1280);
    expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);

    // Reenvio do mesmo arquivo (queda de conexão, outro aparelho): mesma imagem, nada novo.
    const again = await put(ws, owner, original, 'image/jpeg');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ hash: stored.hash, created: false });
    expect((await context.services.db.execute(sql`SELECT count(*)::int AS n FROM workspace_images`)).rows[0]).toEqual({ n: 1 });
    expect(await readdir(join(storageDir, 'workspaces', ws, 'images'))).toHaveLength(1);

    const download = await get(ws, owner, stored.hash);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('image/webp');
    expect(download.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['content-security-policy']).toContain('sandbox');
    expect(download.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    const meta = await sharp(download.rawPayload).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1280);

    const cached = await get(ws, owner, stored.hash, { 'if-none-match': `"${stored.hash}"` });
    expect(cached.statusCode).toBe(304);
    expect(cached.rawPayload).toHaveLength(0);

    // WebP já otimizado e pequeno entra como veio (sem recomprimir com perda).
    const small = await photo('webp', 640, 480, 11);
    const smallRes = await put(ws, owner, small, 'image/webp');
    expect(smallRes.statusCode).toBe(201);
    expect(smallRes.json().bytes).toBe(small.length);
  });

  it('recusa o que não é imagem aceita, tipo falsificado, corrompido, enorme e sem login', async () => {
    const owner = await registerUser(context);
    const ws = await workspaceOf(owner);
    const png = await photo('png', 200, 200);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await put(ws, owner, svg, 'image/png')).statusCode).toBe(415);
    expect((await put(ws, owner, Buffer.from('GIF89a......'), 'image/png')).statusCode).toBe(415);
    expect((await put(ws, owner, Buffer.from('<?php system($_GET[1]); ?>'), 'image/jpeg')).statusCode).toBe(415);
    // Conteúdo é PNG, cabeçalho diz JPEG: não é "corrigido", é recusado.
    expect((await put(ws, owner, png, 'image/jpeg')).statusCode).toBe(415);
    // Tipo que nem é de imagem.
    const wrongType = await context.app.inject({ method: 'PUT', url: `${base(ws)}/images`, headers: { ...owner.authHeader, 'content-type': 'application/pdf' }, payload: png });
    expect(wrongType.statusCode).toBe(415);
    // Cabeçalho de PNG válido, resto truncado.
    const broken = await put(ws, owner, png.subarray(0, Math.floor(png.length / 3)), 'image/png');
    expect(broken.statusCode).toBe(422);
    expect(broken.json().error.code).toBe('IMAGE_INVALID');
    // Acima do limite configurado (400 KB neste teste).
    const huge = await photo('png', 1600, 1200);
    expect(huge.length).toBeGreaterThan(400_000);
    expect((await put(ws, owner, huge, 'image/png')).statusCode).toBe(413);
    // Sem corpo e sem login.
    expect((await put(ws, owner, Buffer.alloc(0), 'image/png')).statusCode).toBeGreaterThanOrEqual(400);
    const anonymous = await context.app.inject({ method: 'PUT', url: `${base(ws)}/images`, headers: { 'content-type': 'image/png' }, payload: png });
    expect(anonymous.statusCode).toBe(401);
    expect((await context.services.db.execute(sql`SELECT count(*)::int AS n FROM workspace_images`)).rows[0]).toEqual({ n: 0 });
  });

  it('PNG com conteúdo escondido no fim é reescrito sem o extra', async () => {
    const owner = await registerUser(context);
    const ws = await workspaceOf(owner);
    const marker = 'SEGREDO_EXECUTAVEL_<script>alert(1)</script>';
    const polyglot = Buffer.concat([await photo('png', 300, 300), Buffer.from(marker)]);

    const res = await put(ws, owner, polyglot, 'image/png');
    expect(res.statusCode).toBe(201);
    const stored = await get(ws, owner, res.json().hash);
    expect(stored.rawPayload.includes(Buffer.from('SEGREDO_EXECUTAVEL'))).toBe(false);
    expect(stored.headers['content-type']).toBe('image/webp');
  });

  it('isola as empresas: hash de outra empresa não existe, não se aponta produto para ele e nada vaza', async () => {
    const a = await registerUser(context);
    const b = await registerUser(context);
    const wsA = await workspaceOf(a);
    const wsB = await workspaceOf(b);
    const image = await photo('png', 400, 300);
    const { hash } = (await put(wsA, a, image, 'image/png')).json();

    // B pela URL da própria empresa e pela da empresa de A.
    expect((await get(wsB, b, hash)).statusCode).toBe(404);
    expect((await get(wsA, b, hash)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await put(wsA, b, image, 'image/png')).statusCode).toBeGreaterThanOrEqual(403);

    // B não consegue apontar o produto dele para a imagem de A.
    const product = (await context.app.inject({ method: 'POST', url: `${base(wsB)}/products`, headers: b.authHeader, payload: { name: 'Item B', quantity: 1 } })).json();
    const steal = await context.app.inject({ method: 'PATCH', url: `${base(wsB)}/products/${product.id}`, headers: b.authHeader, payload: { rev: product.rev, changes: { photoHash: hash } } });
    expect(steal.statusCode).toBe(422);
    const stealCreate = await context.app.inject({ method: 'POST', url: `${base(wsB)}/products`, headers: b.authHeader, payload: { name: 'Item B2', quantity: 1, photoHash: hash } });
    expect(stealCreate.statusCode).toBe(422);

    // Mesmo arquivo enviado por B vira imagem de B (linha e objeto próprios).
    const own = await put(wsB, b, image, 'image/png');
    expect(own.statusCode).toBe(201);
    expect(own.json().hash).toBe(hash);
    expect((await context.services.db.execute(sql`SELECT count(*)::int AS n FROM workspace_images`)).rows[0]).toEqual({ n: 2 });
    expect(await readFile(join(storageDir, imageKey(wsB, hash)))).toBeTruthy();

    // Por sincronização: o ponteiro para imagem desconhecida é ignorado, o resto do produto vale.
    const pid = randomUUID();
    const push = await context.app.inject({
      method: 'POST',
      url: `${base(wsB)}/sync/push`,
      headers: { ...b.authHeader, ...SYNC },
      payload: { operations: [{ opId: randomUUID(), entity: 'produto', op: 'upsert', entityId: pid, baseRev: 0, payload: { id: pid, name: 'Via sync', quantity: 0, photoHash: 'a'.repeat(64), rev: 0 } }] },
    });
    expect(push.statusCode).toBe(200);
    expect(push.json().results[0].status).toBe('aplicada');
    const row = await context.services.db.execute<{ photo_hash: string | null }>(sql`SELECT photo_hash FROM products WHERE id = ${pid}`);
    expect(row.rows[0]?.photo_hash).toBeNull();
  });

  it('respeita o papel: consulta vê e baixa, mas não envia', async () => {
    const owner = await registerUser(context);
    const viewer = await registerUser(context);
    const ws = await workspaceOf(owner);
    await addMember(ws, owner, viewer, 'consulta');
    // Plano Equipe: sem isso a nuvem é só do proprietário.
    const sealed = context.services.purchaseTokens;
    await context.services.db.execute(sql`
      INSERT INTO subscriptions (workspace_id, plan_key, purchase_token_hash, purchase_token_enc, google_product_id, state, last_verified_at, current_period_end)
      VALUES (${ws}::uuid, 'basico', ${sealed.hash('t-img')}, ${sealed.encrypt('t-img')}, 'assinatura', 'ativa', now(), now() + interval '20 days')`);
    const image = await photo('png', 300, 300);
    const { hash } = (await put(ws, owner, image, 'image/png')).json();

    expect((await get(ws, viewer, hash)).statusCode).toBe(200);
    const denied = await put(ws, viewer, await photo('png', 300, 300, 3), 'image/png');
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('MISSING_PERMISSION');
  });

  it('aplica a cota do plano e a liberada pelo painel', async () => {
    const owner = await registerUser(context);
    const ws = await workspaceOf(owner);
    await context.services.db.execute(sql`UPDATE plan_features SET limit_value = 0 WHERE plan_key = 'gratuito' AND feature_key = 'imagens.armazenamento_mb'`);
    try {
      const blocked = await put(ws, owner, await photo('png', 300, 300), 'image/png');
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error.code).toBe('PLAN_LIMIT_REACHED');
    } finally {
      await context.services.db.execute(sql`UPDATE plan_features SET limit_value = 100 WHERE plan_key = 'gratuito' AND feature_key = 'imagens.armazenamento_mb'`);
    }
    expect((await put(ws, owner, await photo('png', 300, 300), 'image/png')).statusCode).toBe(201);
  });

  it('web: cria, troca e remove a foto do produto; sincronização entrega o ponteiro; ponteiro omitido não apaga', async () => {
    const owner = await registerUser(context);
    const ws = await workspaceOf(owner);
    const first = (await put(ws, owner, await photo('png', 500, 400, 1), 'image/png')).json();
    const second = (await put(ws, owner, await photo('png', 500, 400, 2), 'image/png')).json();

    const created = (await context.app.inject({ method: 'POST', url: `${base(ws)}/products`, headers: owner.authHeader, payload: { name: 'Com foto', quantity: 3, photoHash: first.hash } })).json();
    expect(created.photoHash).toBe(first.hash);

    // Outro aparelho (Android) recebe o ponteiro no pull.
    const pull = await context.app.inject({ method: 'GET', url: `${base(ws)}/sync/pull?cursor=0`, headers: { ...owner.authHeader, ...SYNC } });
    const changed = (pull.json().changes as Array<{ entity: string; data: { id: string; photoHash?: string | null } }>).find((change) => change.entity === 'produto' && change.data.id === created.id);
    expect(changed?.data.photoHash).toBe(first.hash);

    // Aparelho antigo edita outro campo sem informar a foto: a foto fica.
    const old = await context.app.inject({
      method: 'POST',
      url: `${base(ws)}/sync/push`,
      headers: { ...owner.authHeader, ...SYNC },
      payload: { operations: [{ opId: randomUUID(), entity: 'produto', op: 'upsert', entityId: created.id, baseRev: created.rev, payload: { id: created.id, name: 'Com foto', quantity: 0, category: 'Teste', rev: created.rev } }] },
    });
    expect(old.json().results[0].status).toBe('aplicada');
    const afterOld = (await context.app.inject({ method: 'GET', url: `${base(ws)}/products/${created.id}`, headers: owner.authHeader })).json();
    expect(afterOld).toMatchObject({ category: 'Teste', photoHash: first.hash });

    // Android troca a foto por sincronização (com `previous`) e depois remove (null).
    const swap = await context.app.inject({
      method: 'POST',
      url: `${base(ws)}/sync/push`,
      headers: { ...owner.authHeader, ...SYNC },
      payload: { operations: [{ opId: randomUUID(), entity: 'produto', op: 'upsert', entityId: created.id, baseRev: afterOld.rev, payload: { id: created.id, name: 'Com foto', quantity: 0, photoHash: second.hash, previous: { photoHash: first.hash }, rev: afterOld.rev } }] },
    });
    expect(swap.json().results[0].status).toBe('aplicada');
    const swapped = (await context.app.inject({ method: 'GET', url: `${base(ws)}/products/${created.id}`, headers: owner.authHeader })).json();
    expect(swapped.photoHash).toBe(second.hash);

    const removed = await context.app.inject({ method: 'PATCH', url: `${base(ws)}/products/${created.id}`, headers: owner.authHeader, payload: { rev: swapped.rev, changes: { photoHash: null } } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().photoHash).toBeNull();

    // Edição concorrente da foto (mesmo ponto de partida): o servidor prevalece.
    const stale = await context.app.inject({
      method: 'POST',
      url: `${base(ws)}/sync/push`,
      headers: { ...owner.authHeader, ...SYNC },
      payload: { operations: [{ opId: randomUUID(), entity: 'produto', op: 'upsert', entityId: created.id, baseRev: afterOld.rev, payload: { id: created.id, name: 'Com foto', quantity: 0, photoHash: first.hash, previous: { photoHash: first.hash }, rev: afterOld.rev } }] },
    });
    expect(['aplicada', 'conflito']).toContain(stale.json().results[0].status);
  });

  it('coleta de lixo: só apaga imagem sem produto, depois da carência, e nunca a que voltou a ser usada', async () => {
    const owner = await registerUser(context);
    const ws = await workspaceOf(owner);
    const used = (await put(ws, owner, await photo('png', 400, 300, 21), 'image/png')).json();
    const replaced = (await put(ws, owner, await photo('png', 400, 300, 22), 'image/png')).json();
    const product = (await context.app.inject({ method: 'POST', url: `${base(ws)}/products`, headers: owner.authHeader, payload: { name: 'Item', quantity: 1, photoHash: replaced.hash } })).json();
    await context.app.inject({ method: 'PATCH', url: `${base(ws)}/products/${product.id}`, headers: owner.authHeader, payload: { rev: product.rev, changes: { photoHash: used.hash } } });
    // `replaced` ficou sem uso; `used` está em uso.

    const service = new ImageService(context.services);
    const old = (hash: string, days: number) => context.services.db.execute(sql`UPDATE workspace_images SET created_at = now() - make_interval(days => ${days}) WHERE hash = ${hash}`);
    const orphaned = (hash: string, days: number) => context.services.db.execute(sql`UPDATE workspace_images SET orphaned_at = now() - make_interval(days => ${days}) WHERE hash = ${hash}`);
    const exists = async (hash: string) => (await context.services.db.execute(sql`SELECT 1 FROM workspace_images WHERE hash = ${hash}`)).rows.length > 0;
    const onDisk = (hash: string) => readFile(join(storageDir, imageKey(ws, hash))).then(() => true, () => false);

    // Imagem recém-enviada nunca é marcada (o aparelho pode estar prestes a apontar para ela).
    expect(await service.collectGarbage()).toMatchObject({ marked: 0, deleted: 0 });
    await old(replaced.hash, 3);
    await old(used.hash, 3);
    expect(await service.collectGarbage()).toMatchObject({ marked: 1, deleted: 0 });
    // Marcada, mas dentro da carência: continua lá.
    expect(await exists(replaced.hash)).toBe(true);
    expect(await onDisk(replaced.hash)).toBe(true);

    // Alguém volta a usá-la durante a carência: sai da fila.
    await context.app.inject({ method: 'PATCH', url: `${base(ws)}/products/${product.id}`, headers: owner.authHeader, payload: { rev: 2, changes: { photoHash: replaced.hash } } });
    await orphaned(replaced.hash, 30);
    const reused = await service.collectGarbage();
    expect(reused.deleted).toBe(0);
    expect(await exists(replaced.hash)).toBe(true);

    // Agora sem uso de novo, marcada há mais que a carência: é apagada (objeto e linha); a que está em uso fica.
    await context.app.inject({ method: 'PATCH', url: `${base(ws)}/products/${product.id}`, headers: owner.authHeader, payload: { rev: 3, changes: { photoHash: used.hash } } });
    await service.collectGarbage();
    await orphaned(replaced.hash, 30);
    expect((await service.collectGarbage()).deleted).toBe(1);
    expect(await exists(replaced.hash)).toBe(false);
    expect(await onDisk(replaced.hash)).toBe(false);
    expect(await exists(used.hash)).toBe(true);
    expect(await onDisk(used.hash)).toBe(true);
  });
});
