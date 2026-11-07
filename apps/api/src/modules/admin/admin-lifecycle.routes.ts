import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { emailsSentToday } from '../../platform/email/counting-mailer.js';
import { LIFECYCLE_KINDS, LIFECYCLE_LABELS, renderLifecycleEmail } from '../lifecycle/lifecycle.templates.js';
import { requireAdmin } from './admin-auth.plugin.js';
import { offsetOf, paginationQuerySchema } from './admin.schemas.js';

/**
 * Painel do funil de e-mails do ciclo de vida: o que foi decidido/enviado,
 * entregas, aberturas, cliques, descadastros, bounces e spam por tipo, e o
 * que aconteceu depois (ativou ou voltou a usar em até 3 dias: indicador
 * otimista, sem grupo de controle). Somente leitura.
 */
export async function registerAdminLifecycleRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const { db, env } = app.services;

  routes.get(
    '/lifecycle/summary',
    { preHandler: requireAdmin('viewer'), schema: { tags: ['admin'], summary: 'Funil de e-mails: resumo por tipo', hide: true, response: { 200: z.any() } } },
    async () => {
      const [rows, today] = await Promise.all([
        db.execute<Record<string, number | string>>(sql`
          SELECT le.kind,
                 count(*)::int AS total,
                 count(*) FILTER (WHERE le.status = 'sent')::int AS sent,
                 count(*) FILTER (WHERE le.status = 'dry_run')::int AS dry_run,
                 count(*) FILTER (WHERE le.status = 'failed')::int AS failed,
                 count(le.delivered_at)::int AS delivered,
                 count(le.opened_at)::int AS opened,
                 count(le.clicked_at)::int AS clicked,
                 count(le.unsubscribed_at)::int AS unsubscribed,
                 count(le.bounced_at)::int AS bounced,
                 count(le.complained_at)::int AS complained,
                 count(*) FILTER (WHERE EXISTS (
                   SELECT 1 FROM products p JOIN workspaces w ON w.id = p.workspace_id
                   WHERE w.owner_user_id = le.user_id AND p.created_at > le.created_at AND p.created_at <= le.created_at + interval '3 days'
                 ))::int AS activated_3d,
                 count(*) FILTER (WHERE EXISTS (
                   SELECT 1 FROM analytics_events e
                   WHERE e.user_id = le.user_id AND e.source = 'app' AND e.occurred_at > le.created_at AND e.occurred_at <= le.created_at + interval '3 days'
                 ))::int AS returned_3d
          FROM lifecycle_emails le
          GROUP BY le.kind
        `),
        emailsSentToday(db),
      ]);
      const byKind = new Map(rows.rows.map((row) => [row.kind as string, row]));
      return {
        mode: env.LIFECYCLE_EMAILS_MODE,
        webhookConfigured: Boolean(env.RESEND_WEBHOOK_SECRET),
        limits: { lifecycleDaily: env.LIFECYCLE_DAILY_LIMIT, totalDaily: env.EMAIL_DAILY_TOTAL_LIMIT },
        today,
        kinds: LIFECYCLE_KINDS.map((kind) => ({
          kind,
          label: LIFECYCLE_LABELS[kind],
          ...{ total: 0, sent: 0, dry_run: 0, failed: 0, delivered: 0, opened: 0, clicked: 0, unsubscribed: 0, bounced: 0, complained: 0, activated_3d: 0, returned_3d: 0 },
          ...(byKind.get(kind) ?? {}),
        })),
      };
    },
  );

  routes.get(
    '/lifecycle/emails',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Funil de e-mails: envios recentes',
        hide: true,
        querystring: paginationQuerySchema.extend({ kind: z.enum(LIFECYCLE_KINDS).optional() }),
        response: { 200: z.any() },
      },
    },
    async (request) => {
      const { kind } = request.query;
      const where = kind ? sql`WHERE le.kind = ${kind}` : sql``;
      const [rows, total] = await Promise.all([
        db.execute<{
          id: string;
          user_id: string;
          name: string;
          email: string;
          kind: string;
          status: string;
          error: string | null;
          created_at: string;
          delivered_at: string | null;
          opened_at: string | null;
          clicked_at: string | null;
          unsubscribed_at: string | null;
          bounced_at: string | null;
          complained_at: string | null;
        }>(sql`
          SELECT le.id, le.user_id, u.name, u.email, le.kind, le.status, le.error, le.created_at, le.delivered_at, le.opened_at,
                 le.clicked_at, le.unsubscribed_at, le.bounced_at, le.complained_at
          FROM lifecycle_emails le JOIN users u ON u.id = le.user_id
          ${where}
          ORDER BY le.created_at DESC
          LIMIT ${request.query.pageSize} OFFSET ${offsetOf(request.query)}
        `),
        db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM lifecycle_emails le ${where}`),
      ]);
      const iso = (value: string | null) => (value ? new Date(value).toISOString() : null);
      return {
        items: rows.rows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          name: row.name,
          email: row.email,
          kind: row.kind,
          label: LIFECYCLE_LABELS[row.kind as keyof typeof LIFECYCLE_LABELS] ?? row.kind,
          status: row.status,
          error: row.error,
          createdAt: iso(row.created_at),
          deliveredAt: iso(row.delivered_at),
          openedAt: iso(row.opened_at),
          clickedAt: iso(row.clicked_at),
          unsubscribedAt: iso(row.unsubscribed_at),
          bouncedAt: iso(row.bounced_at),
          complainedAt: iso(row.complained_at),
        })),
        page: request.query.page,
        pageSize: request.query.pageSize,
        total: total.rows[0]?.n ?? 0,
      };
    },
  );

  routes.get(
    '/lifecycle/templates',
    { preHandler: requireAdmin('viewer'), schema: { tags: ['admin'], summary: 'Funil de e-mails: textos de exemplo', hide: true, response: { 200: z.any() } } },
    async () => {
      const base = env.WEB_APP_URL ?? 'https://estoquesimples.com.br';
      return {
        items: LIFECYCLE_KINDS.map((kind) => ({
          kind,
          label: LIFECYCLE_LABELS[kind],
          ...renderLifecycleEmail(kind, {
            firstName: 'Ana',
            workspaceName: 'Salão da Ana',
            emailVerified: false,
            productCount: kind === 'limit_50' ? 50 : 42,
            lowStockCount: 3,
            link: (path) => `${base}${path}`,
            unsubscribeUrl: `${base}/v1/email/descadastrar?t=…`,
          }),
        })),
      };
    },
  );
}
