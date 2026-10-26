import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../../src/platform/auth/password.js';
import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { createTestApp, registerUser, resetDatabase, type TestContext } from '../helpers/test-app.js';

const ADMIN_PASSWORD = 'PainelSeguro#2026';
const CSRF = { 'x-requested-with': 'estoquesimples-admin' };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

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

async function adminCookie(): Promise<string> {
  const email = `owner.${randomUUID()}@exemplo.com.br`;
  await context.services.db.insert(platformAdmins).values({ email, name: 'Dona do Painel', passwordHash: await hashPassword(ADMIN_PASSWORD), role: 'owner' });
  const response = await context.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: { ...CSRF, 'user-agent': UA }, payload: { email, password: ADMIN_PASSWORD } });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  return ((Array.isArray(raw) ? raw[0] : raw) as string).split(';')[0] as string;
}

async function actions(userId: string): Promise<Array<{ action: string; user_agent: string | null }>> {
  const result = await context.services.db.execute<{ action: string; user_agent: string | null }>(
    sql`SELECT action, user_agent FROM audit_log WHERE actor_user_id = ${userId} ORDER BY id`,
  );
  return result.rows;
}

describe('trilha de segurança da conta', () => {
  it('grava perfil, sessão encerrada e aparelho novo, com o navegador de quem fez', async () => {
    const user = await registerUser(context);
    const headers = { ...user.authHeader, 'user-agent': UA };

    expect((await context.app.inject({ method: 'PATCH', url: '/v1/me', headers, payload: { name: 'Nome Novo' } })).statusCode).toBe(200);

    const login = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'user-agent': UA },
      payload: { email: user.email, password: user.password, device: { installId: 'aparelho-1', platform: 'android' } },
    });
    expect(login.statusCode).toBe(200);
    // Mesmo aparelho de novo: não é "novo aparelho".
    await context.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: user.email, password: user.password, device: { installId: 'aparelho-1', platform: 'android' } } });

    const closed = await context.app.inject({ method: 'DELETE', url: `/v1/me/sessions/${login.json().sessionId}`, headers });
    expect(closed.statusCode).toBe(200);

    const rows = await actions(user.userId);
    const names = rows.map((row) => row.action);
    expect(names).toContain('user.profile_updated');
    expect(names).toContain('user.session_revoked');
    expect(names.filter((name) => name === 'device.registered')).toHaveLength(1);
    expect(rows.find((row) => row.action === 'user.profile_updated')?.user_agent).toBe(UA);
    expect(rows.find((row) => row.action === 'device.registered')?.user_agent).toBe(UA);
  });

  it('login de conta suspensa e tentativa durante o bloqueio ficam registrados', async () => {
    const user = await registerUser(context);
    await context.services.db.execute(sql`UPDATE users SET status = 'suspended' WHERE id = ${user.userId}`);
    const denied = await context.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: user.email, password: user.password } });
    expect(denied.statusCode).toBe(403);
    expect((await actions(user.userId)).map((row) => row.action)).toContain('user.login_denied');

    await context.services.db.execute(sql`UPDATE users SET status = 'active' WHERE id = ${user.userId}`);
    let status = 0;
    for (let attempt = 0; attempt < 30 && status !== 429; attempt += 1) {
      status = (await context.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: user.email, password: 'SenhaErrada#123' } })).statusCode;
    }
    expect(status).toBe(429);
    await context.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: user.email, password: 'SenhaErrada#123' } });
    // Um registro por minuto, por mais que a pessoa insista.
    expect((await actions(user.userId)).filter((row) => row.action === 'user.login_blocked')).toHaveLength(1);
  });
});

describe('painel: logs por usuário e por administrador', () => {
  it('a ficha da conta mostra quem fez, navegador e filtra só segurança', async () => {
    const cookie = await adminCookie();
    const user = await registerUser(context);
    await context.app.inject({ method: 'PATCH', url: '/v1/me', headers: { ...user.authHeader, 'user-agent': UA }, payload: { name: 'Outro Nome' } });
    await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: user.authHeader, payload: { name: 'Loja' } });

    const all = await context.app.inject({ method: 'GET', url: `/admin/api/users/${user.userId}/timeline`, headers: { cookie } });
    expect(all.statusCode).toBe(200);
    const profile = all.json().items.find((item: { action: string }) => item.action === 'user.profile_updated');
    expect(profile).toMatchObject({ actor: user.email, actorUserId: user.userId, userAgent: UA });
    expect(all.json().items.some((item: { action: string }) => item.action === 'workspace.created')).toBe(true);

    const onlySecurity = await context.app.inject({ method: 'GET', url: `/admin/api/users/${user.userId}/timeline?security=true`, headers: { cookie } });
    const names = onlySecurity.json().items.map((item: { action: string }) => item.action);
    expect(names).toContain('user.profile_updated');
    expect(names).not.toContain('workspace.created');

    const explorer = await context.app.inject({ method: 'GET', url: `/admin/api/audit/users?security=true&actorUserId=${user.userId}`, headers: { cookie } });
    expect(explorer.json().items.every((item: { actorUserId: string }) => item.actorUserId === user.userId)).toBe(true);
    expect(explorer.json().items.map((item: { action: string }) => item.action)).not.toContain('workspace.created');
  });

  it('a trilha dos administradores identifica quem e de qual navegador', async () => {
    const cookie = await adminCookie();
    const response = await context.app.inject({ method: 'GET', url: '/admin/api/audit/admins?security=true', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const loginEntry = response.json().items.find((item: { action: string }) => item.action === 'admin.logged_in');
    expect(loginEntry).toMatchObject({ adminName: 'Dona do Painel', userAgent: UA });
    expect(loginEntry.adminId).toBeTruthy();
  });
});
