import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { contrast, normalizeSlug, slugProblem } from '../../src/modules/branding/brand-rules.js';
import { workspaceMembers } from '../../src/platform/db/schema/index.js';
import { createTestApp, registerUser, resetDatabase, type RegisteredUser, type TestContext } from '../helpers/test-app.js';

let context: TestContext;
let storageDir: string;

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'es-brand-'));
  context = await createTestApp({ IMAGE_FS_DIR: storageDir, BRAND_PUBLIC_CACHE_MS: '0' });
});
afterAll(async () => {
  await context.close();
  await rm(storageDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDatabase(context);
});

const base = (ws: string) => `/v1/workspaces/${ws}`;

async function workspaceOf(user: RegisteredUser, name = 'Padaria do Zé'): Promise<string> {
  const response = await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: user.authHeader, payload: { name } });
  expect(response.statusCode).toBe(201);
  return response.json().id;
}

async function subscribe(ws: string, token: string): Promise<void> {
  const sealed = context.services.purchaseTokens;
  await context.services.db.execute(sql`
    INSERT INTO subscriptions (workspace_id, plan_key, purchase_token_hash, purchase_token_enc, google_product_id, state, last_verified_at, current_period_end)
    VALUES (${ws}::uuid, 'basico', ${sealed.hash(token)}, ${sealed.encrypt(token)}, 'assinatura', 'ativa', now(), now() + interval '20 days')`);
}

const save = (ws: string, user: RegisteredUser, body: Record<string, unknown>) =>
  context.app.inject({ method: 'PUT', url: `${base(ws)}/branding`, headers: user.authHeader, payload: { slug: 'padaria-ze', primaryColor: '#8a2be2', accentColor: null, textColor: null, font: 'default', ...body } });

const entitlement = async (ws: string, user: RegisteredUser) => (await context.app.inject({ method: 'GET', url: `${base(ws)}/entitlement`, headers: user.authHeader })).json();
const publicBrand = async (slug: string) => (await context.app.inject({ method: 'GET', url: `/v1/public/brand/${slug}` })).json();

async function logo(width = 400, height = 200): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 138, g: 43, b: 226, alpha: 0.5 } } }).png().toBuffer();
}

describe('regras puras', () => {
  it('normaliza e valida identificadores', () => {
    expect(normalizeSlug('  Padaria do Zé & Cia!! ')).toBe('padaria-do-ze-cia');
    expect(slugProblem('ab')).not.toBeNull();
    expect(slugProblem('app')).not.toBeNull();
    expect(slugProblem('123456')).not.toBeNull();
    expect(slugProblem('padaria-ze')).toBeNull();
  });
  it('mede contraste', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(contrast('#1c679d', '#ffffff')).toBeGreaterThan(4.5);
  });
});

describe('identidade visual por empresa', () => {
  it('sem plano: não configura, e o entitlement fica no visual padrão', async () => {
    const owner = await registerUser(context);
    const ws = await workspaceOf(owner);
    const denied = await save(ws, owner, {});
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('BRAND_NOT_IN_PLAN');
    const ent = await entitlement(ws, owner);
    expect(ent.branding).toMatchObject({ eligible: false, active: false, theme: null, logo: null });
    expect((await publicBrand('padaria-ze')).active).toBe(false);
  });

  it('assinante: valida cores e identificador, aplica, e a perda do plano volta ao padrão sem apagar nada', async () => {
    const owner = await registerUser(context);
    const ws = await workspaceOf(owner);
    await subscribe(ws, 't-brand');

    // Contraste insuficiente: recusa com sugestão.
    const light = await save(ws, owner, { primaryColor: '#ffd54f' });
    expect(light.statusCode).toBe(422);
    expect(light.json().error.code).toBe('BRAND_INVALID');
    expect(light.json().error.suggestions?.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect((await save(ws, owner, { textColor: '#999999' })).statusCode).toBe(422);
    expect((await save(ws, owner, { primaryColor: 'azul' })).statusCode).toBe(400);
    expect((await save(ws, owner, { slug: 'admin' })).statusCode).toBe(422);

    const ok = await save(ws, owner, { accentColor: '#0b5d3b', textColor: '#101820', font: 'serif' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ slug: 'padaria-ze', primaryColor: '#8a2be2', font: 'serif', version: 1 });

    const ent = await entitlement(ws, owner);
    expect(ent.branding).toMatchObject({ eligible: true, active: true, slug: 'padaria-ze', loginPath: '/padaria-ze/entrar' });
    expect(ent.branding.theme).toMatchObject({ primary: '#8a2be2', accent: '#0b5d3b', text: '#101820', font: 'serif', onPrimary: '#ffffff' });
    expect(contrast(ent.branding.theme.textMuted, '#f4f7fa')).toBeGreaterThanOrEqual(4.5);

    // Público, sem login (e com o nome da empresa para a tela de entrada).
    const pub = await publicBrand('padaria-ze');
    expect(pub).toMatchObject({ active: true, slug: 'padaria-ze', displayName: 'Padaria do Zé' });
    expect(pub.theme.primary).toBe('#8a2be2');

    // Assinatura cancelada/expirada: some da leitura; a configuração continua guardada.
    await context.services.db.execute(sql`UPDATE subscriptions SET state = 'expirada', current_period_end = now() - interval '1 day' WHERE workspace_id = ${ws}::uuid`);
    const after = await entitlement(ws, owner);
    expect(after.branding).toMatchObject({ eligible: false, active: false, theme: null });
    const stored = await context.app.inject({ method: 'GET', url: `${base(ws)}/branding`, headers: owner.authHeader });
    expect(stored.json().config.primaryColor).toBe('#8a2be2');
    expect(stored.json().effective.active).toBe(false);

    // Reassinar restaura.
    await context.services.db.execute(sql`UPDATE subscriptions SET state = 'ativa', current_period_end = now() + interval '20 days' WHERE workspace_id = ${ws}::uuid`);
    expect((await entitlement(ws, owner)).branding.active).toBe(true);
  });

  it('identificador é único, e o antigo fica reservado para a empresa de origem', async () => {
    const a = await registerUser(context);
    const b = await registerUser(context);
    const wa = await workspaceOf(a, 'Alfa');
    const wb = await workspaceOf(b, 'Beta');
    await subscribe(wa, 't-a');
    await subscribe(wb, 't-b');
    expect((await save(wa, a, { slug: 'minha-loja' })).statusCode).toBe(200);
    const clash = await save(wb, b, { slug: 'Minha Loja' });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('BRAND_SLUG_TAKEN');

    // A troca libera o endereço, mas só para a dona dele (reserva de 90 dias).
    expect((await save(wa, a, { slug: 'loja-nova' })).statusCode).toBe(200);
    expect((await save(wb, b, { slug: 'minha-loja' })).statusCode).toBe(409);
    expect((await publicBrand('minha-loja')).slug).toBe('loja-nova');
    expect((await save(wa, a, { slug: 'minha-loja' })).statusCode).toBe(200);
  });

  it('só proprietário e administrador configuram; outra empresa não enxerga nem altera', async () => {
    const owner = await registerUser(context);
    const operator = await registerUser(context);
    const stranger = await registerUser(context);
    const ws = await workspaceOf(owner);
    await subscribe(ws, 't-roles');
    await context.services.db.insert(workspaceMembers).values({ workspaceId: ws, userId: operator.userId, roleKey: 'operador', status: 'active', invitedBy: owner.userId });
    expect((await save(ws, operator, {})).statusCode).toBe(403);
    expect((await save(ws, stranger, {})).statusCode).toBeGreaterThanOrEqual(403);
    expect((await context.app.inject({ method: 'GET', url: `${base(ws)}/branding`, headers: stranger.authHeader })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await save(ws, owner, {})).statusCode).toBe(200);
    // O operador recebe a marca da empresa pelo entitlement (só leitura).
    expect((await entitlement(ws, operator)).branding.active).toBe(true);
  });

  it('logotipo: valida pelo conteúdo, otimiza, serve publicamente com cache e some sem plano', async () => {
    const owner = await registerUser(context);
    const ws = await workspaceOf(owner);
    await subscribe(ws, 't-logo');
    const put = (bytes: Buffer, type: string) => context.app.inject({ method: 'PUT', url: `${base(ws)}/branding/logo`, headers: { ...owner.authHeader, 'content-type': type }, payload: bytes });

    // Antes de definir o identificador não há onde publicar.
    expect((await put(await logo(), 'image/png')).statusCode).toBe(422);
    await save(ws, owner, {});

    expect((await put(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png')).statusCode).toBe(415);
    expect((await put(await logo(), 'image/jpeg')).statusCode).toBe(415);

    const sent = await put(await sharp({ create: { width: 2000, height: 1000, channels: 4, background: { r: 10, g: 90, b: 160, alpha: 1 } } }).png().toBuffer(), 'image/png');
    expect(sent.statusCode).toBe(200);
    const { logo: info } = sent.json();
    expect(info.width).toBe(640);
    expect(info.url).toBe(`/v1/public/brand/padaria-ze/logo?v=${info.hash}`);

    const file = await context.app.inject({ method: 'GET', url: info.url });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/webp');
    expect(file.headers['cache-control']).toContain('immutable');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect((await context.app.inject({ method: 'GET', url: info.url, headers: { 'if-none-match': `"${info.hash}"` } })).statusCode).toBe(304);

    // Sem plano: o logotipo some da rota pública (e a marca, do entitlement).
    await context.services.db.execute(sql`UPDATE subscriptions SET state = 'expirada', current_period_end = now() - interval '1 day' WHERE workspace_id = ${ws}::uuid`);
    expect((await context.app.inject({ method: 'GET', url: info.url })).statusCode).toBe(404);
    expect((await publicBrand('padaria-ze')).active).toBe(false);

    // Remover e restaurar o padrão.
    await context.services.db.execute(sql`UPDATE subscriptions SET state = 'ativa', current_period_end = now() + interval '20 days' WHERE workspace_id = ${ws}::uuid`);
    expect((await context.app.inject({ method: 'DELETE', url: `${base(ws)}/branding/logo`, headers: owner.authHeader })).json().logo).toBeNull();
    const reset = await context.app.inject({ method: 'DELETE', url: `${base(ws)}/branding`, headers: owner.authHeader });
    expect(reset.json()).toMatchObject({ primaryColor: null, font: 'default', logo: null, slug: 'padaria-ze' });
    expect((await entitlement(ws, owner)).branding.active).toBe(false);
  });

  it('empresa bloqueada pelo painel não aplica a marca', async () => {
    const owner = await registerUser(context);
    const ws = await workspaceOf(owner);
    await subscribe(ws, 't-block');
    await save(ws, owner, {});
    await context.services.db.execute(sql`UPDATE workspace_brandings SET blocked_at = now() WHERE workspace_id = ${ws}::uuid`);
    expect((await entitlement(ws, owner)).branding.active).toBe(false);
  });
});
