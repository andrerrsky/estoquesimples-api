import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ACCOUNT_RECOVERY_DAYS, PrivacyService, RETENTION } from '../../src/modules/privacy/privacy.service.js';
import { imageKey } from '../../src/platform/storage/object-storage.js';
import { createTestApp, registerUser, resetDatabase, type TestContext } from '../helpers/test-app.js';

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

const count = async (query: ReturnType<typeof sql>) => Number((await context.services.db.execute<{ n: number }>(query)).rows[0]?.n ?? 0);

describe('exclusão de conta (LGPD)', () => {
  it('expurga a conta depois do prazo de recuperação e não antes', async () => {
    const user = await registerUser(context, { installId: 'aparelho-expurgo-0000000000000000000' });
    const deleted = await context.app.inject({ method: 'DELETE', url: '/v1/me', headers: user.authHeader, payload: { password: user.password } });
    expect(deleted.statusCode).toBe(200);

    const service = new PrivacyService(context.services);
    expect(await service.purgeDeletedAccounts()).toEqual({ purged: 0, skipped: 0 });
    expect(await count(sql`SELECT count(*)::int AS n FROM users WHERE id = ${user.userId}`)).toBe(1);

    const later = new Date(Date.now() + (ACCOUNT_RECOVERY_DAYS + 1) * 86_400_000);
    expect(await service.purgeDeletedAccounts(later)).toEqual({ purged: 1, skipped: 0 });
    expect(await count(sql`SELECT count(*)::int AS n FROM users WHERE id = ${user.userId}`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${user.userId}`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM devices WHERE user_id = ${user.userId}`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.purged' AND entity_id = ${user.userId}`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM audit_log WHERE actor_user_id IS NULL AND ip_address IS NOT NULL AND entity_id = ${user.userId}`)).toBe(0);
  });
});

describe('retenção', () => {
  it('apaga sessões encerradas antigas e tira o IP da auditoria antiga', async () => {
    const user = await registerUser(context);
    const old = new Date(Date.now() - (RETENTION.endedSessions + 5) * 86_400_000);
    await context.services.db.execute(sql`UPDATE sessions SET revoked_at = ${old} WHERE user_id = ${user.userId}`);
    const oldAudit = new Date(Date.now() - (RETENTION.auditIp + 5) * 86_400_000);
    await context.services.db.execute(sql`UPDATE audit_log SET created_at = ${oldAudit}, ip_address = '203.0.113.7' WHERE actor_user_id = ${user.userId}`);

    const removed = await new PrivacyService(context.services).applyRetention();
    expect(removed['sessions']).toBeGreaterThanOrEqual(1);
    expect(Object.values(removed).every((value) => value >= 0)).toBe(true);
    expect(await count(sql`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${user.userId}`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM audit_log WHERE actor_user_id = ${user.userId} AND ip_address IS NOT NULL`)).toBe(0);
  });
});

describe('exportar meus dados', () => {
  it('devolve os dados da própria conta e registra o pedido', async () => {
    const user = await registerUser(context, { installId: 'aparelho-export-00000000000000000000' });
    const response = await context.app.inject({ method: 'GET', url: '/v1/me/export', headers: user.authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-disposition']).toContain('attachment');
    const body = response.json();
    expect(body.profile.email).toBe(user.email);
    expect(body.profile).not.toHaveProperty('password_hash');
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.devices.length).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.data_exported' AND actor_user_id = ${user.userId}`)).toBe(1);
  });

  it('exige sessão', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/v1/me/export' });
    expect(response.statusCode).toBe(401);
  });
});

describe('expurgo: o que não está ligado por chave estrangeira', () => {
  it('tira o e-mail de públicos de campanha e da trilha do painel, inclusive aninhado', async () => {
    const user = await registerUser(context);
    const other = 'outra.pessoa@exemplo.com.br';
    await context.services.db.execute(sql`
      INSERT INTO push_campaigns (title, body, audience, status, created_by_email) VALUES ('Aviso', 'Texto', ${JSON.stringify({ type: 'users', emails: [user.email, other] })}::jsonb, 'draft', 'admin@exemplo.com.br')
    `);
    await context.services.db.execute(sql`
      INSERT INTO admin_audit_log (admin_email, action, target_type, target_id, metadata)
      VALUES ('admin@exemplo.com.br', 'user.updated', 'user', ${user.userId}, ${JSON.stringify({ changes: { email: { from: user.email, to: 'novo@x.com' }, name: { from: 'Fulana', to: 'Ciclana' } }, reason: 'pedido' })}::jsonb),
             ('admin@exemplo.com.br', 'push.test_sent', 'push_campaign', ${randomUUID()}, ${JSON.stringify({ email: user.email.toUpperCase() })}::jsonb)
    `);
    await context.app.inject({ method: 'DELETE', url: '/v1/me', headers: user.authHeader, payload: { password: user.password } });
    const later = new Date(Date.now() + (ACCOUNT_RECOVERY_DAYS + 1) * 86_400_000);
    expect((await new PrivacyService(context.services).purgeDeletedAccounts(later)).purged).toBe(1);

    const audience = (await context.services.db.execute<{ audience: { emails: string[] } }>(sql`SELECT audience FROM push_campaigns`)).rows[0]!.audience;
    expect(audience.emails).toEqual([other]);
    const metadata = (await context.services.db.execute<{ metadata: Record<string, unknown> }>(sql`SELECT metadata FROM admin_audit_log ORDER BY action DESC`)).rows.map((row) => row.metadata);
    expect(JSON.stringify(metadata)).not.toContain(user.email);
    expect(JSON.stringify(metadata)).not.toContain('Fulana');
    expect(JSON.stringify(metadata)).toContain('pedido');
  });

  it('apaga do bucket as fotos das empresas excluídas da conta antes de apagar as linhas', async () => {
    const user = await registerUser(context);
    const created = await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: user.authHeader, payload: { name: 'Loja Fechada' } });
    const workspaceId = created.json().workspace?.id ?? created.json().id;
    const hash = 'a'.repeat(64);
    await context.services.db.execute(sql`INSERT INTO workspace_images (workspace_id, hash, source_hash, content_type, bytes, width, height) VALUES (${workspaceId}, ${hash}, ${hash}, 'image/webp', 10, 1, 1)`);
    await context.services.db.execute(sql`UPDATE workspaces SET deleted_at = now() WHERE id = ${workspaceId}`);
    await context.services.db.execute(sql`UPDATE users SET status = 'pending_deletion', deletion_requested_at = now() - interval '40 days' WHERE id = ${user.userId}`);

    const deleted: string[] = [];
    const storage = context.services.storage;
    const original = { configured: storage.configured, delete: storage.delete };
    Object.defineProperty(storage, 'configured', { value: true, configurable: true });
    storage.delete = async (key: string) => {
      deleted.push(key);
    };
    try {
      expect((await new PrivacyService(context.services).purgeDeletedAccounts()).purged).toBe(1);
    } finally {
      Object.defineProperty(storage, 'configured', { value: original.configured, configurable: true });
      storage.delete = original.delete;
    }
    expect(deleted).toEqual([imageKey(workspaceId, hash)]);
    expect(await count(sql`SELECT count(*)::int AS n FROM workspaces WHERE id = ${workspaceId}`)).toBe(0);
  });
});

describe('expurgo e retenção: suporte anônimo e avisos de cobrança', () => {
  it('apaga a conversa anônima com o e-mail da conta expurgada e mantém a de outra pessoa', async () => {
    const user = await registerUser(context);
    await context.services.db.execute(sql`
      INSERT INTO support_tickets (install_id, subject, contact_email) VALUES
        ('instalacao-anonima-000000000000000001', 'Dúvida', ${user.email.toUpperCase()}),
        ('instalacao-anonima-000000000000000002', 'Outra dúvida', 'outra.pessoa@exemplo.com.br')
    `);
    await context.services.db.execute(sql`UPDATE users SET status = 'pending_deletion', deletion_requested_at = now() - interval '40 days' WHERE id = ${user.userId}`);
    expect((await new PrivacyService(context.services).purgeDeletedAccounts()).purged).toBe(1);
    const restantes = (await context.services.db.execute<{ contact_email: string }>(sql`SELECT contact_email FROM support_tickets`)).rows;
    expect(restantes.map((row) => row.contact_email)).toEqual(['outra.pessoa@exemplo.com.br']);
  });

  it('apaga avisos de cobrança com mais de 400 dias (processados ou não) e mantém os recentes', async () => {
    const old = new Date(Date.now() - (RETENTION.billingEvents + 5) * 86_400_000);
    await context.services.db.execute(sql`
      INSERT INTO subscription_events (notification_id, received_at, processed_at) VALUES
        ('evento-antigo-processado', ${old}, ${old}),
        ('evento-antigo-falhou', ${old}, NULL),
        ('evento-recente', now(), NULL)
    `);
    const removed = await new PrivacyService(context.services).applyRetention();
    expect(removed['billingEvents']).toBe(2);
    const restantes = (await context.services.db.execute<{ notification_id: string }>(sql`SELECT notification_id FROM subscription_events`)).rows;
    expect(restantes.map((row) => row.notification_id)).toEqual(['evento-recente']);
  });
});

describe('retenção: conversas de quem nunca teve conta', () => {
  it('apaga a conversa anônima parada há mais de 2 anos e mantém a recente e a de conta', async () => {
    const user = await registerUser(context);
    const old = new Date(Date.now() - (RETENTION.closedSupport + 5) * 86_400_000);
    await context.services.db.execute(sql`
      INSERT INTO support_tickets (install_id, subject, last_message_at, user_id) VALUES
        ('instalacao-anonima-antiga-0000000000001', 'Antiga', ${old}, NULL),
        ('instalacao-anonima-recente-000000000001', 'Recente', now(), NULL),
        ('instalacao-da-conta-antiga-000000000001', 'De conta', ${old}, ${user.userId})
    `);
    const removed = await new PrivacyService(context.services).applyRetention();
    expect(removed['anonymousSupport']).toBe(1);
    const restantes = (await context.services.db.execute<{ subject: string }>(sql`SELECT subject FROM support_tickets ORDER BY subject`)).rows;
    expect(restantes.map((row) => row.subject)).toEqual(['De conta', 'Recente']);
  });
});
