import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAuth } from '../../platform/http/authenticate.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { errorSchema } from '../auth/auth.schemas.js';
import { requestMeta } from '../auth/auth.routes.js';

/**
 * Portabilidade e acesso (LGPD art. 18, II e V): tudo o que o sistema guarda
 * sobre a pessoa, num JSON só. O estoque das empresas sai pela exportação de
 * cada empresa (export.routes.ts), que depende de permissão na empresa.
 */
export async function registerPrivacyRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/me/export',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
      schema: {
        tags: ['usuário'],
        summary: 'Exporta os dados pessoais da conta (LGPD)',
        security: [{ bearerAuth: [] }],
        response: { 200: z.any(), 401: errorSchema, 429: errorSchema },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const db = app.services.db;
      const id = auth.userId;
      const q = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) => (await db.execute<T>(query)).rows;

      const [profile] = await q(sql`SELECT id, email, name, email_verified_at, status, created_at, updated_at FROM users WHERE id = ${id}`);
      const data = {
        exportedAt: new Date().toISOString(),
        notice: 'Dados pessoais da sua conta no Estoque Simples. O estoque de cada empresa sai pela exportação da própria empresa, no app ou na web.',
        profile,
        workspaces: await q(sql`
          SELECT w.id, w.name, m.role_key AS role, m.status, m.joined_at, m.removed_at, (w.owner_user_id = ${id}) AS owner
          FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.user_id = ${id} ORDER BY m.created_at`),
        sessions: await q(sql`
          SELECT id, user_agent, host(ip_address) AS ip_address, created_at, last_used_at, expires_at, revoked_at
          FROM sessions WHERE user_id = ${id} ORDER BY created_at DESC`),
        devices: await q(sql`
          SELECT id, platform, model, os_version, app_version_name, last_seen_at, created_at, revoked_at
          FROM devices WHERE user_id = ${id} ORDER BY created_at DESC`),
        pushSubscriptions: await q(sql`SELECT platform, created_at, last_seen_at, revoked_at FROM push_tokens WHERE user_id = ${id} ORDER BY created_at DESC`),
        notifications: await q(sql`SELECT type, title, body, read_at, created_at FROM notifications WHERE user_id = ${id} ORDER BY created_at DESC`),
        support: await q(sql`
          SELECT t.id, t.subject, t.status, t.created_at,
            COALESCE(json_agg(json_build_object('author', m.author, 'body', m.body, 'createdAt', m.created_at) ORDER BY m.created_at)
              FILTER (WHERE m.id IS NOT NULL AND NOT m.internal), '[]') AS messages
          FROM support_tickets t LEFT JOIN support_messages m ON m.ticket_id = t.id
          WHERE t.user_id = ${id} GROUP BY t.id ORDER BY t.created_at DESC`),
        activity: await q(sql`
          SELECT action, entity_type, entity_id, host(ip_address) AS ip_address, created_at
          FROM audit_log WHERE actor_user_id = ${id} ORDER BY created_at DESC LIMIT 5000`),
        usageEvents: await q(sql`
          SELECT name, occurred_at, platform, source, properties
          FROM analytics_events WHERE user_id = ${id} ORDER BY occurred_at DESC LIMIT 20000`),
      };

      await recordAudit(db, {
        actorUserId: id,
        action: AuditAction.USER_DATA_EXPORTED,
        entityType: 'user',
        entityId: id,
        ipAddress: requestMeta(request).ipAddress,
      });

      return reply
        .header('Cache-Control', 'no-store')
        .header('Content-Disposition', `attachment; filename="estoque-simples-meus-dados-${new Date().toISOString().slice(0, 10)}.json"`)
        .send(data);
    },
  );
}
