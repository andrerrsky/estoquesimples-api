import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../../src/platform/auth/password.js';
import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { createTestApp, registerUser, resetDatabase, type TestContext } from '../helpers/test-app.js';

let context: TestContext;
let storageDir: string;

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'es-errors-'));
  context = await createTestApp({ IMAGE_FS_DIR: storageDir });
});

afterAll(async () => {
  await context.close();
  await rm(storageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase(context);
});

/** A gravação do erro não segura a resposta: espera ela chegar ao banco. */
async function eventsWhere(condition: ReturnType<typeof sql>, expected = 1) {
  for (let i = 0; i < 40; i += 1) {
    const rows = (await context.services.db.execute(sql`SELECT * FROM error_events WHERE ${condition} ORDER BY id`)).rows as Array<Record<string, unknown>>;
    if (rows.length >= expected) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [];
}

describe('registro de erros', () => {
  it('falha do armazenamento de fotos vira 503 claro e o erro completo fica registrado com o correlationId', async () => {
    const user = await registerUser(context);
    const ws = (await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: user.authHeader, payload: { name: 'Loja' } })).json().id as string;
    const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#2a7' } }).png().toBuffer();

    const storage = context.services.storage as { put: (...args: unknown[]) => Promise<void> };
    const original = storage.put;
    storage.put = async () => {
      throw new Error('AccessDenied: credencial do bucket recusada');
    };
    try {
      const response = await context.app.inject({ method: 'PUT', url: `/v1/workspaces/${ws}/images`, headers: { ...user.authHeader, 'content-type': 'image/png' }, payload: image });
      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.error.code).toBe('IMAGES_UNAVAILABLE');
      expect(body.error.message).toContain('salve o produto sem foto');

      const [event] = await eventsWhere(sql`correlation_id = ${body.error.correlationId}`);
      expect(event).toMatchObject({
        source: 'api',
        kind: 'api',
        code: 'IMAGES_UNAVAILABLE',
        status: 503,
        http_method: 'PUT',
        route: '/v1/workspaces/:workspaceId/images',
        user_id: user.userId,
        workspace_id: ws,
      });
      // A causa do bucket é o que permite corrigir.
      expect(event?.['message']).toContain('credencial do bucket recusada');
    } finally {
      storage.put = original;
    }
  });

  it('recebe erros da web e do app, com ou sem login, e tira e-mails e tokens das mensagens', async () => {
    const user = await registerUser(context);
    const payload = {
      errors: [
        { source: 'web', kind: 'exception', message: `TypeError: falhou para ${user.email} token=abc.def.ghi`, stack: 'TypeError\n    at salvar (https://web.test/assets/app-1.js:10:5)', route: '/app/estoque', appVersion: '1.2.3', platform: 'web app', occurredAt: Date.now() },
        { source: 'android', kind: 'crash', level: 'fatal', message: 'java.lang.NullPointerException: x', appVersion: '25 (25)', platform: 'Android 16 · Google Pixel' },
      ],
    };
    const signed = await context.app.inject({ method: 'POST', url: '/v1/client-errors', headers: user.authHeader, payload });
    expect(signed.statusCode).toBe(202);
    expect(signed.json()).toEqual({ accepted: 2 });

    // Token vencido/errado não impede o registro (o erro só fica sem a pessoa).
    const stale = await context.app.inject({ method: 'POST', url: '/v1/client-errors', headers: { authorization: 'Bearer token-invalido' }, payload: { errors: [payload.errors[1]] } });
    expect(stale.statusCode).toBe(202);

    const web = await eventsWhere(sql`source = 'web'`);
    expect(web[0]).toMatchObject({ kind: 'exception', user_id: user.userId, route: '/app/estoque', app_version: '1.2.3' });
    expect(web[0]?.['message']).not.toContain(user.email);
    expect(web[0]?.['message']).toContain('<email>');
    expect(web[0]?.['message']).not.toContain('abc.def.ghi');

    const android = await eventsWhere(sql`source = 'android'`, 2);
    expect(android).toHaveLength(2);
    expect(android[0]?.['level']).toBe('fatal');
    // O mesmo erro cai no mesmo grupo.
    expect(android[0]?.['fingerprint']).toBe(android[1]?.['fingerprint']);
    expect(android[1]?.['user_id']).toBeNull();
  });

  it('recusa lote malformado e origem desconhecida', async () => {
    const empty = await context.app.inject({ method: 'POST', url: '/v1/client-errors', payload: { errors: [] } });
    expect(empty.statusCode).toBe(400);
    const wrong = await context.app.inject({ method: 'POST', url: '/v1/client-errors', payload: { errors: [{ source: 'api', kind: 'x', message: 'y' }] } });
    expect(wrong.statusCode).toBe(400);
  });

  it('o painel agrupa os erros e mostra as ocorrências; a busca acha pelo código curto', async () => {
    const email = `admin.${randomUUID()}@exemplo.com.br`;
    await context.services.db.insert(platformAdmins).values({ email, name: 'Admin', passwordHash: await hashPassword('PainelSeguro#2026'), role: 'viewer' });
    const login = await context.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: { 'x-requested-with': 'estoquesimples-admin' }, payload: { email, password: 'PainelSeguro#2026' } });
    const raw = login.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)!.split(';')[0]!;

    const correlationId = randomUUID();
    for (let i = 0; i < 3; i += 1) {
      await context.app.inject({ method: 'POST', url: '/v1/client-errors', payload: { errors: [{ source: 'web', kind: 'api', code: 'INTERNAL', status: 500, message: `500 INTERNAL: Erro interno (produto ${i})`, correlationId: i === 0 ? correlationId : null }] } });
    }
    await eventsWhere(sql`source = 'web'`, 3);

    const list = await context.app.inject({ method: 'GET', url: '/admin/api/errors?period=24h', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const groups = list.json().groups as Array<{ fingerprint: string; count: number; source: string }>;
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 3, source: 'web' });

    const search = await context.app.inject({ method: 'GET', url: `/admin/api/errors?q=${correlationId.slice(0, 8)}`, headers: { cookie } });
    expect(search.json().groups).toHaveLength(1);

    const detail = await context.app.inject({ method: 'GET', url: `/admin/api/errors/${groups[0]!.fingerprint}`, headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().occurrences).toHaveLength(3);

    const anonymous = await context.app.inject({ method: 'GET', url: '/admin/api/errors' });
    expect(anonymous.statusCode).toBe(401);
  });
});
