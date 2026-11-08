import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrivacyService, RETENTION } from '../../src/modules/privacy/privacy.service.js';
import { hashPassword } from '../../src/platform/auth/password.js';
import { platformAdmins, workspaceMembers } from '../../src/platform/db/schema/index.js';
import { imageKey } from '../../src/platform/storage/object-storage.js';
import { createTestApp, registerUser, resetDatabase, type RegisteredUser, type TestContext } from '../helpers/test-app.js';

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

async function createWorkspace(user: RegisteredUser, name: string): Promise<string> {
  const response = await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: user.authHeader, payload: { name } });
  expect(response.statusCode).toBe(201);
  return response.json().id;
}

const deleteAccount = (user: RegisteredUser, closeWorkspaces?: boolean) =>
  context.app.inject({ method: 'DELETE', url: '/v1/me', headers: user.authHeader, payload: { password: user.password, ...(closeWorkspaces === undefined ? {} : { closeWorkspaces }) } });

describe('excluir a conta junto com as empresas', () => {
  it('mostra o que sai junto e, sem confirmar as empresas, recusa com a lista', async () => {
    const owner = await registerUser(context);
    const member = await registerUser(context);
    const workspaceId = await createWorkspace(owner, 'Loja do Dono');
    await context.services.db.insert(workspaceMembers).values({ workspaceId, userId: member.userId, roleKey: 'operador', status: 'active', invitedBy: owner.userId });

    const preview = await context.app.inject({ method: 'GET', url: '/v1/me/deletion-preview', headers: owner.authHeader });
    expect(preview.json().workspaces).toEqual([{ id: workspaceId, name: 'Loja do Dono', otherMembers: 1, subscription: null }]);

    const refused = await deleteAccount(owner);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('LAST_OWNER');
    expect(refused.json().error.workspaces[0].id).toBe(workspaceId);
  });

  it('com a confirmação, exclui a conta e as empresas; a equipe perde o acesso', async () => {
    const owner = await registerUser(context);
    const member = await registerUser(context);
    const workspaceId = await createWorkspace(owner, 'Loja Fechando');
    await context.services.db.insert(workspaceMembers).values({ workspaceId, userId: member.userId, roleKey: 'operador', status: 'active', invitedBy: owner.userId });

    const done = await deleteAccount(owner, true);
    expect(done.statusCode).toBe(200);
    const [row] = (await context.services.db.execute<{ deleted: boolean }>(sql`SELECT deleted_at IS NOT NULL AS deleted FROM workspaces WHERE id = ${workspaceId}`)).rows;
    expect(row?.deleted).toBe(true);

    // A versão de permissão do membro subiu: o token dele não vale mais e, renovado, não abre a empresa.
    const login = await context.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: member.email, password: member.password } });
    const fresh = { authorization: `Bearer ${login.json().accessToken}` };
    expect((await context.app.inject({ method: 'GET', url: `/v1/workspaces/${workspaceId}`, headers: fresh })).statusCode).toBe(404);
  });

  it('assinatura do Google Play que ainda renova bloqueia (só a pessoa cancela na Play Store)', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner, 'Loja Assinante');
    await context.services.db.execute(sql`
      INSERT INTO subscriptions (workspace_id, purchaser_user_id, plan_key, provider, state, auto_renewing, purchase_token_hash, purchase_token_enc, google_product_id)
      VALUES (${workspaceId}, ${owner.userId}, 'basico', 'google_play', 'ativa', true, ${randomUUID()}, 'v2:k1:teste', 'assinatura')
    `);
    const blocked = await deleteAccount(owner, true);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('WORKSPACE_SUBSCRIPTION_ACTIVE');
    const [row] = (await context.services.db.execute<{ status: string }>(sql`SELECT status FROM users WHERE id = ${owner.userId}`)).rows;
    expect(row?.status).toBe('active');
  });

  it('o suporte cancela a exclusão e as empresas fechadas junto voltam', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner, 'Loja Volta');
    expect((await deleteAccount(owner, true)).statusCode).toBe(200);

    const adminEmail = `owner.${randomUUID()}@exemplo.com.br`;
    await context.services.db.insert(platformAdmins).values({ email: adminEmail, name: 'Admin', passwordHash: await hashPassword('PainelSeguro#2026'), role: 'owner' });
    const CSRF = { 'x-requested-with': 'estoquesimples-admin' };
    const login = await context.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: CSRF, payload: { email: adminEmail, password: 'PainelSeguro#2026' } });
    const raw = login.headers['set-cookie'];
    const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
    const cancel = await context.app.inject({ method: 'POST', url: `/admin/api/users/${owner.userId}/cancel-deletion`, headers: { ...CSRF, cookie }, payload: { reason: 'pedido do cliente' } });
    expect(cancel.statusCode).toBe(200);

    const [row] = (await context.services.db.execute<{ deleted: boolean }>(sql`SELECT deleted_at IS NOT NULL AS deleted FROM workspaces WHERE id = ${workspaceId}`)).rows;
    expect(row?.deleted).toBe(false);
  });
});

describe('purga de empresas excluídas', () => {
  it('apaga de vez (com as fotos do bucket) só as excluídas há mais de 90 dias', async () => {
    const owner = await registerUser(context);
    const antiga = await createWorkspace(owner, 'Excluída há muito');
    const recente = await createWorkspace(owner, 'Excluída ontem');
    const hash = 'b'.repeat(64);
    await context.services.db.execute(sql`INSERT INTO workspace_images (workspace_id, hash, source_hash, content_type, bytes, width, height) VALUES (${antiga}, ${hash}, ${hash}, 'image/webp', 10, 1, 1)`);
    await context.services.db.execute(sql`UPDATE workspaces SET deleted_at = now() - make_interval(days => ${RETENTION.deletedWorkspaces + 1}) WHERE id = ${antiga}`);
    await context.services.db.execute(sql`UPDATE workspaces SET deleted_at = now() - interval '1 day' WHERE id = ${recente}`);

    const deleted: string[] = [];
    const storage = context.services.storage;
    const original = { configured: storage.configured, delete: storage.delete };
    Object.defineProperty(storage, 'configured', { value: true, configurable: true });
    storage.delete = async (key: string) => {
      deleted.push(key);
    };
    try {
      expect(await new PrivacyService(context.services).purgeDeletedWorkspaces()).toBe(1);
    } finally {
      Object.defineProperty(storage, 'configured', { value: original.configured, configurable: true });
      storage.delete = original.delete;
    }
    expect(deleted).toEqual([imageKey(antiga, hash)]);
    const restantes = (await context.services.db.execute<{ id: string }>(sql`SELECT id FROM workspaces`)).rows.map((row) => row.id);
    expect(restantes).toEqual([recente]);
    const [audit] = (await context.services.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'workspace.purged' AND entity_id = ${antiga}`)).rows;
    expect(audit?.n).toBe(1);
  });
});

describe('exclusão definitiva pelo painel (contas de teste)', () => {
  async function ownerSession(role: 'owner' | 'support' = 'owner') {
    const adminEmail = `${role}.${randomUUID()}@exemplo.com.br`;
    await context.services.db.insert(platformAdmins).values({ email: adminEmail, name: 'Admin', passwordHash: await hashPassword('PainelSeguro#2026'), role });
    const CSRF = { 'x-requested-with': 'estoquesimples-admin' };
    const login = await context.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: CSRF, payload: { email: adminEmail, password: 'PainelSeguro#2026' } });
    const raw = login.headers['set-cookie'];
    return { ...CSRF, cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]! };
  }
  const purge = (headers: Record<string, string>, userId: string, confirmEmail: string) =>
    context.app.inject({ method: 'POST', url: `/admin/api/users/${userId}/purge`, headers, payload: { reason: 'conta de teste do dono', confirmEmail } });

  it('apaga na hora a conta, a empresa e os eventos de uso; exige o e-mail certo e papel owner', async () => {
    const user = await registerUser(context);
    const workspaceId = await createWorkspace(user, 'Loja Teste');
    await context.services.db.execute(sql`INSERT INTO analytics_events (name, occurred_at, user_id, platform) VALUES ('screen.viewed', now(), ${user.userId}, 'web')`);

    const support = await ownerSession('support');
    expect((await purge(support, user.userId, user.email)).statusCode).toBe(403);

    const owner = await ownerSession();
    const wrong = await purge(owner, user.userId, 'outro@exemplo.com.br');
    expect(wrong.statusCode).toBe(400);

    const done = await purge(owner, user.userId, user.email.toUpperCase());
    expect(done.statusCode).toBe(200);
    const left = (
      await context.services.db.execute<{ users: number; workspaces: number; events: number }>(sql`
        SELECT (SELECT count(*)::int FROM users WHERE id = ${user.userId}) AS users,
               (SELECT count(*)::int FROM workspaces WHERE id = ${workspaceId}) AS workspaces,
               (SELECT count(*)::int FROM analytics_events WHERE name = 'screen.viewed') AS events
      `)
    ).rows[0];
    expect(left).toEqual({ users: 0, workspaces: 0, events: 0 });
    const [audit] = (await context.services.db.execute<{ action: string }>(sql`SELECT action FROM admin_audit_log WHERE target_id = ${user.userId}`)).rows;
    expect(audit?.action).toBe('user.purged');
  });

  it('recusa conta dona de empresa com outras pessoas', async () => {
    const user = await registerUser(context);
    const member = await registerUser(context);
    const workspaceId = await createWorkspace(user, 'Loja Compartilhada');
    await context.services.db.insert(workspaceMembers).values({ workspaceId, userId: member.userId, roleKey: 'operador', status: 'active', invitedBy: user.userId });
    const owner = await ownerSession();
    const preview = await context.app.inject({ method: 'GET', url: `/admin/api/users/${user.userId}/purge-preview`, headers: owner });
    expect(preview.json().blockers).toMatchObject([{ reason: 'members', workspaceId, members: [{ userId: member.userId, email: member.email }] }]);
    const refused = await purge(owner, user.userId, user.email);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.blockers[0].members[0].userId).toBe(member.userId);
    const [row] = (await context.services.db.execute<{ status: string }>(sql`SELECT status FROM users WHERE id = ${user.userId}`)).rows;
    expect(row?.status).toBe('active');
  });

  it('assinatura pagante bloqueia; suspensa (fatura em aberto) não bloqueia', async () => {
    const owner = await ownerSession();
    const paying = await registerUser(context);
    const payingWs = await createWorkspace(paying, 'Loja Pagante');
    await context.services.db.execute(sql`
      INSERT INTO subscriptions (workspace_id, purchaser_user_id, plan_key, provider, state, auto_renewing, purchase_token_hash, purchase_token_enc, google_product_id)
      VALUES (${payingWs}, ${paying.userId}, 'basico', 'google_play', 'ativa', false, ${randomUUID()}, 'v2:k1:teste', 'assinatura')
    `);
    const blocked = await purge(owner, paying.userId, paying.email);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.blockers[0].reason).toBe('paying_subscription');

    const unpaid = await registerUser(context);
    const unpaidWs = await createWorkspace(unpaid, 'Loja Inadimplente');
    await context.services.db.execute(sql`UPDATE subscriptions SET state = 'suspensa' WHERE workspace_id = ${payingWs}`);
    await context.services.db.execute(sql`UPDATE subscriptions SET workspace_id = ${unpaidWs}, purchaser_user_id = ${unpaid.userId} WHERE workspace_id = ${payingWs}`);
    expect((await purge(owner, unpaid.userId, unpaid.email)).statusCode).toBe(200);
  });
});
