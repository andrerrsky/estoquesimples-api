import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAdmin } from './admin-auth.plugin.js';
import { commonAdminErrors } from './admin.schemas.js';

const PERIODOS = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days' } as const;

/**
 * Admin › Erros: o que deu errado em produção, na API, na web, no web app,
 * no painel e no app Android. Agrupado pela impressão digital, com as
 * ocorrências e a busca pelo código que o cliente vê na tela.
 */
export async function registerAdminErrorsRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.services;

  routes.get(
    '/errors',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Erros agrupados',
        hide: true,
        querystring: z.object({
          source: z.enum(['api', 'web', 'android', 'admin']).optional(),
          period: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
          q: z.string().trim().max(200).optional(),
        }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => {
      const { source, period, q } = request.query;
      const conditions = [sql`e.occurred_at > now() - ${sql.raw(`interval '${PERIODOS[period]}'`)}`];
      if (source) conditions.push(sql`e.source = ${source}`);
      if (q) {
        const like = `%${q}%`;
        conditions.push(sql`(e.message ILIKE ${like} OR e.code ILIKE ${like} OR e.route ILIKE ${like} OR e.correlation_id LIKE ${q + '%'})`);
      }
      const where = sql.join(conditions, sql` AND `);
      const groups = await db.execute(sql`
        SELECT e.fingerprint,
               count(*)::int AS count,
               count(DISTINCT e.user_id)::int AS users,
               min(e.occurred_at) AS "firstSeen",
               max(e.occurred_at) AS "lastSeen",
               (array_agg(e.source ORDER BY e.occurred_at DESC))[1] AS source,
               (array_agg(e.kind ORDER BY e.occurred_at DESC))[1] AS kind,
               (array_agg(e.level ORDER BY e.occurred_at DESC))[1] AS level,
               (array_agg(e.code ORDER BY e.occurred_at DESC))[1] AS code,
               (array_agg(e.message ORDER BY e.occurred_at DESC))[1] AS message,
               (array_agg(e.route ORDER BY e.occurred_at DESC))[1] AS route,
               (array_agg(e.status ORDER BY e.occurred_at DESC))[1] AS status,
               (array_agg(e.app_version ORDER BY e.occurred_at DESC))[1] AS "appVersion"
        FROM error_events e
        WHERE ${where}
        GROUP BY e.fingerprint
        ORDER BY max(e.occurred_at) DESC
        LIMIT 200
      `);
      const totals = await db.execute(sql`
        SELECT e.source, count(*)::int AS count FROM error_events e WHERE ${where} GROUP BY e.source
      `);
      return { groups: groups.rows, totals: totals.rows };
    },
  );

  routes.get(
    '/errors/:fingerprint',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Ocorrências de um erro',
        hide: true,
        params: z.object({ fingerprint: z.string().regex(/^[0-9a-f]{20}$/) }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => {
      const rows = await db.execute(sql`
        SELECT e.id::text AS id, e.occurred_at AS "occurredAt", e.source, e.level, e.kind, e.code, e.message, e.stack,
               e.http_method AS "httpMethod", e.route, e.status, e.correlation_id AS "correlationId",
               e.user_id AS "userId", u.email AS "userEmail", e.workspace_id AS "workspaceId", w.name AS "workspaceName",
               e.device_id AS "deviceId", e.app_version AS "appVersion", e.platform, e.user_agent AS "userAgent", e.context
        FROM error_events e
        LEFT JOIN users u ON u.id = e.user_id
        LEFT JOIN workspaces w ON w.id = e.workspace_id
        WHERE e.fingerprint = ${request.params.fingerprint}
        ORDER BY e.occurred_at DESC
        LIMIT 50
      `);
      return { occurrences: rows.rows };
    },
  );
}
