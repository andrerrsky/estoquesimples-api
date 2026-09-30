import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { hashPassword } from '../../src/platform/auth/password.js';
import { createTestApp, registerUser, resetDatabase, type TestContext } from '../helpers/test-app.js';

const ADMIN_PASSWORD = 'PainelSeguro#2026';
const CSRF = { 'x-requested-with': 'estoquesimples-admin' };

let context: TestContext;

async function createAdmin(role: 'owner' | 'support' | 'viewer', email = `${role}.${randomUUID()}@exemplo.com.br`) {
  await context.services.db.insert(platformAdmins).values({
    email,
    name: `Admin ${role}`,
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role,
  });
  return email;
}

async function loginAdmin(email: string): Promise<{ cookie: string }> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/admin/api/auth/login',
    headers: CSRF,
    payload: { email, password: ADMIN_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(raw).toContain('HttpOnly');
  expect(raw).toContain('SameSite=Strict');
  return { cookie: (raw as string).split(';')[0] as string };
}

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
});

describe('painel administrativo: sessão', () => {
  it('recusa login sem o cabeçalho anti-CSRF', async () => {
    const email = await createAdmin('owner');
    const response = await context.app.inject({
      method: 'POST',
      url: '/admin/api/auth/login',
      payload: { email, password: ADMIN_PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });

  it('autentica, identifica e encerra a sessão', async () => {
    const email = await createAdmin('owner');
    const { cookie } = await loginAdmin(email);

    const me = await context.app.inject({ method: 'GET', url: '/admin/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email, role: 'owner' });

    const logout = await context.app.inject({
      method: 'POST',
      url: '/admin/api/auth/logout',
      headers: { cookie, ...CSRF },
    });
    expect(logout.statusCode).toBe(200);

    const after = await context.app.inject({ method: 'GET', url: '/admin/api/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('não aceita o Bearer do aplicativo', async () => {
    const user = await registerUser(context);
    const response = await context.app.inject({
      method: 'GET',
      url: '/admin/api/overview',
      headers: user.authHeader,
    });
    expect(response.statusCode).toBe(401);
  });

  it('bloqueia progressivamente após senhas erradas', async () => {
    const email = await createAdmin('support');
    for (let i = 0; i < 5; i += 1) {
      await context.app.inject({
        method: 'POST',
        url: '/admin/api/auth/login',
        headers: CSRF,
        payload: { email, password: 'errada-errada-errada' },
      });
    }
    const response = await context.app.inject({
      method: 'POST',
      url: '/admin/api/auth/login',
      headers: CSRF,
      payload: { email, password: ADMIN_PASSWORD },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('AUTH_ACCOUNT_LOCKED');
  });
});

describe('painel administrativo: papéis', () => {
  it('viewer lê mas não altera', async () => {
    const viewer = await createAdmin('viewer');
    const { cookie } = await loginAdmin(viewer);
    const user = await registerUser(context);

    const list = await context.app.inject({ method: 'GET', url: '/admin/api/users', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(1);

    const suspend = await context.app.inject({
      method: 'POST',
      url: `/admin/api/users/${user.userId}/suspend`,
      headers: { cookie, ...CSRF },
      payload: { reason: 'teste' },
    });
    expect(suspend.statusCode).toBe(403);
    expect(suspend.json().error.code).toBe('MISSING_PERMISSION');
  });

  it('somente owner administra outros administradores', async () => {
    const support = await createAdmin('support');
    const { cookie } = await loginAdmin(support);
    const response = await context.app.inject({ method: 'GET', url: '/admin/api/admins', headers: { cookie } });
    expect(response.statusCode).toBe(403);
  });
});

describe('painel administrativo: suporte a contas', () => {
  it('suspende a conta, derruba as sessões e registra nas duas trilhas', async () => {
    const support = await createAdmin('support');
    const { cookie } = await loginAdmin(support);
    const user = await registerUser(context, { installId: 'aparelho-teste-123' });

    const suspend = await context.app.inject({
      method: 'POST',
      url: `/admin/api/users/${user.userId}/suspend`,
      headers: { cookie, ...CSRF },
      payload: { reason: 'Uso indevido relatado' },
    });
    expect(suspend.statusCode).toBe(200);

    // O token do cliente deixa de valer imediatamente.
    const me = await context.app.inject({ method: 'GET', url: '/v1/me', headers: user.authHeader });
    expect(me.statusCode).toBe(401);

    const detail = await context.app.inject({
      method: 'GET',
      url: `/admin/api/users/${user.userId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().status).toBe('suspended');
    expect(detail.json().sessions).toHaveLength(0);

    const timeline = await context.app.inject({
      method: 'GET',
      url: `/admin/api/users/${user.userId}/timeline`,
      headers: { cookie },
    });
    const actions = timeline.json().items.map((item: { action: string; source: string }) => `${item.source}:${item.action}`);
    expect(actions).toContain('admin:user.suspended');
    expect(actions).toContain('user:user.registered');

    const adminAudit = await context.app.inject({
      method: 'GET',
      url: '/admin/api/audit/admins',
      headers: { cookie },
    });
    expect(adminAudit.json().items[0]).toMatchObject({
      action: 'user.suspended',
      adminEmail: support,
      targetId: user.userId,
      metadata: { reason: 'Uso indevido relatado' },
    });
  });

  it('exige motivo nas ações destrutivas', async () => {
    const support = await createAdmin('support');
    const { cookie } = await loginAdmin(support);
    const user = await registerUser(context);
    const response = await context.app.inject({
      method: 'POST',
      url: `/admin/api/users/${user.userId}/suspend`,
      headers: { cookie, ...CSRF },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('analytics', () => {
  it('aceita lote do app, deduplica e atribui ao usuário autenticado', async () => {
    const user = await registerUser(context, { installId: 'instalacao-analytics-1' });
    const eventId = randomUUID();
    const payload = {
      device: { installId: 'instalacao-analytics-1', platform: 'android', appVersionCode: 24 },
      events: [
        { id: eventId, name: 'app.opened', occurredAt: Date.now(), properties: { coldStart: true } },
        { id: randomUUID(), name: 'screen.viewed', occurredAt: Date.now(), properties: { screen: 'MainActivity' } },
      ],
    };

    const first = await context.app.inject({
      method: 'POST',
      url: '/v1/analytics/events',
      headers: user.authHeader,
      payload,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ accepted: 2, duplicated: 0, rejected: 0 });

    const again = await context.app.inject({
      method: 'POST',
      url: '/v1/analytics/events',
      headers: user.authHeader,
      payload,
    });
    expect(again.json()).toEqual({ accepted: 0, duplicated: 2, rejected: 0 });

    const owner = await createAdmin('owner');
    const { cookie } = await loginAdmin(owner);
    const events = await context.app.inject({
      method: 'GET',
      url: `/admin/api/users/${user.userId}/events`,
      headers: { cookie },
    });
    // Dois do app + user.registered emitido pela API.
    expect(events.json().total).toBe(3);

    const summary = await context.app.inject({
      method: 'GET',
      url: '/admin/api/analytics/summary?days=7',
      headers: { cookie },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().active.dau).toBe(1);
    expect(summary.json().topScreens[0]).toMatchObject({ screen: 'MainActivity', views: 1 });
  });

  it('não atribui evento a empresa da qual o usuário não participa', async () => {
    const user = await registerUser(context, { installId: 'instalacao-analytics-2' });
    const outro = await registerUser(context);
    const empresa = await context.app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: outro.authHeader,
      payload: { name: 'Empresa alheia' },
    });
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/analytics/events',
      headers: user.authHeader,
      payload: {
        device: { installId: 'instalacao-analytics-2' },
        events: [
          { id: randomUUID(), name: 'product.created', occurredAt: Date.now(), workspaceId: empresa.json().id },
        ],
      },
    });
    expect(response.statusCode).toBe(202);

    const owner = await createAdmin('owner');
    const { cookie } = await loginAdmin(owner);
    const events = await context.app.inject({
      method: 'GET',
      url: '/admin/api/analytics/events?name=product.created',
      headers: { cookie },
    });
    expect(events.json().items[0].workspaceId).toBeNull();
  });

  it('rejeita nome de evento fora do formato', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/analytics/events',
      payload: {
        device: { installId: 'instalacao-analytics-3' },
        events: [{ id: randomUUID(), name: 'Evento Inválido!', occurredAt: Date.now() }],
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('painel administrativo: visão geral e operação', () => {
  it('devolve o retrato com séries preenchidas', async () => {
    await registerUser(context);
    const owner = await createAdmin('owner');
    const { cookie } = await loginAdmin(owner);

    const overview = await context.app.inject({ method: 'GET', url: '/admin/api/overview', headers: { cookie } });
    expect(overview.statusCode).toBe(200);
    const body = overview.json();
    expect(body.kpis.usersTotal).toBe(1);
    expect(body.series.registrations.length).toBeGreaterThanOrEqual(30);
    expect(body.series.registrations.at(-1).v).toBe(1);

    const ops = await context.app.inject({ method: 'GET', url: '/admin/api/ops/status', headers: { cookie } });
    expect(ops.statusCode).toBe(200);
    expect(ops.json().sync.source).toBe('ambiente');

    const toggle = await context.app.inject({
      method: 'PUT',
      url: '/admin/api/ops/sync',
      headers: { cookie, ...CSRF },
      payload: { enabled: false, minAppVersionCode: 0, reason: 'incidente simulado' },
    });
    expect(toggle.statusCode).toBe(200);

    const config = await context.app.inject({ method: 'GET', url: '/v1/config' });
    expect(config.json().sync.enabled).toBe(false);
  });

  it('serve a interface em /admin com CSP', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/admin/usuarios' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-type']).toContain('text/html');
  });
});
