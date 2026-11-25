import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../../src/platform/auth/password.js';
import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { createTestApp, resetDatabase, type TestContext } from '../helpers/test-app.js';

const CSRF = { 'x-requested-with': 'estoquesimples-admin' };
const SENHA = 'PainelSeguro#2026';

let context: TestContext;

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
});

async function cookieDeDono(): Promise<string> {
  const email = `dono.${randomUUID()}@exemplo.com.br`;
  await context.services.db.insert(platformAdmins).values({
    email,
    name: 'Dono',
    passwordHash: await hashPassword(SENHA),
    role: 'owner',
  });
  const login = await context.app.inject({
    method: 'POST',
    url: '/admin/api/auth/login',
    headers: CSRF,
    payload: { email, password: SENHA },
  });
  expect(login.statusCode).toBe(200);
  const raw = login.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';
}

async function config() {
  const response = await context.app.inject({ method: 'GET', url: '/v1/config' });
  expect(response.statusCode).toBe(200);
  return response.json().app;
}

describe('versões do app pelo painel', () => {
  it('sem configuração, ninguém é avisado nem bloqueado', async () => {
    // O estado em que o recurso ficou por meses: zero significa "não sei",
    // e o app não inventa aviso nenhum.
    expect(await config()).toMatchObject({ latestVersionCode: 0, minRequiredVersionCode: 0, message: null });
  });

  it('o painel informa a versão mais nova e ela chega nos aparelhos', async () => {
    const cookie = await cookieDeDono();
    const salvo = await context.app.inject({
      method: 'PUT',
      url: '/admin/api/ops/app-version',
      headers: { ...CSRF, cookie },
      payload: { latestVersionCode: 41, minRequiredVersionCode: 0, message: null, reason: 'versão 41 aprovada na Play' },
    });
    expect(salvo.statusCode).toBe(200);

    expect(await config()).toMatchObject({ latestVersionCode: 41, minRequiredVersionCode: 0 });

    const auditoria = await context.app.inject({
      method: 'GET',
      url: '/admin/api/audit/admins?action=ops.app_version_changed',
      headers: { cookie },
    });
    expect(auditoria.statusCode).toBe(200);
    expect(auditoria.json().items.length).toBeGreaterThan(0);
  });

  it('nunca exige uma versão que não existe na loja', async () => {
    const cookie = await cookieDeDono();
    await context.app.inject({
      method: 'PUT',
      url: '/admin/api/ops/app-version',
      headers: { ...CSRF, cookie },
      payload: { latestVersionCode: 41, minRequiredVersionCode: 99, message: 'Atualize para continuar', reason: 'teste do teto' },
    });

    // Bloquear acima do que está publicado deixaria a base inteira sem saída.
    const app = await config();
    expect(app.minRequiredVersionCode).toBe(41);
    expect(app.message).toBe('Atualize para continuar');
  });

  it('só o dono muda as versões', async () => {
    const email = `suporte.${randomUUID()}@exemplo.com.br`;
    await context.services.db.insert(platformAdmins).values({
      email,
      name: 'Suporte',
      passwordHash: await hashPassword(SENHA),
      role: 'support',
    });
    const login = await context.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: CSRF, payload: { email, password: SENHA } });
    const raw = login.headers['set-cookie'];
    const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';

    const tentativa = await context.app.inject({
      method: 'PUT',
      url: '/admin/api/ops/app-version',
      headers: { ...CSRF, cookie },
      payload: { latestVersionCode: 41, minRequiredVersionCode: 0, message: null, reason: 'não deveria passar' },
    });
    expect(tentativa.statusCode).toBe(403);
  });
});
