import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { AuditAction } from '../audit/audit.service.js';
import { AdminAction } from './admin-audit.service.js';
import { requireAdmin } from './admin-auth.plugin.js';
import { commonAdminErrors, offsetOf, paginationQuerySchema } from './admin.schemas.js';

/**
 * Exploradores de auditoria: a trilha dos clientes (`audit_log`) e a dos
 * administradores (`admin_audit_log`). Só leitura; a escrita acontece nos
 * serviços que executam cada ação.
 */
export async function registerAdminAuditRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.services;

  routes.get(
    '/audit/actions',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Catálogo de ações auditáveis (clientes e administradores)',
        hide: true,
        response: { 200: z.object({ user: z.array(z.string()), admin: z.array(z.string()) }), ...commonAdminErrors },
      },
    },
    async () => ({ user: Object.values(AuditAction), admin: Object.values(AdminAction) }),
  );

  routes.get(
    '/audit/users',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Auditoria das contas e empresas',
        hide: true,
        querystring: paginationQuerySchema.extend({
          action: z.string().max(80).optional(),
          actorUserId: z.string().uuid().optional(),
          workspaceId: z.string().uuid().optional(),
          entityType: z.string().max(40).optional(),
          entityId: z.string().max(120).optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          q: z.string().trim().max(200).optional(),
        }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => {
      const f = request.query;
      const conditions = [sql`true`];
      if (f.action) conditions.push(f.action.endsWith('.') ? sql`a.action LIKE ${f.action + '%'}` : sql`a.action = ${f.action}`);
      if (f.actorUserId) conditions.push(sql`a.actor_user_id = ${f.actorUserId}`);
      if (f.workspaceId) conditions.push(sql`a.workspace_id = ${f.workspaceId}`);
      if (f.entityType) conditions.push(sql`a.entity_type = ${f.entityType}`);
      if (f.entityId) conditions.push(sql`a.entity_id = ${f.entityId}`);
      if (f.from) conditions.push(sql`a.created_at >= ${f.from}`);
      if (f.to) conditions.push(sql`a.created_at < ${f.to}`);
      if (f.q) {
        const term = `%${f.q.toLowerCase()}%`;
        conditions.push(sql`(lower(coalesce(u.email,'')) LIKE ${term} OR lower(coalesce(w.name,'')) LIKE ${term} OR a.entity_id = ${f.q})`);
      }
      const where = sql.join(conditions, sql` AND `);
      const base = sql`
        FROM audit_log a
        LEFT JOIN users u ON u.id = a.actor_user_id
        LEFT JOIN workspaces w ON w.id = a.workspace_id
        LEFT JOIN devices d ON d.id = a.actor_device_id
        WHERE ${where}
      `;

      const [rows, total] = await Promise.all([
        db.execute<{
          id: string; action: string; created_at: string; actor_user_id: string | null; actor_email: string | null;
          workspace_id: string | null; workspace_name: string | null; entity_type: string | null; entity_id: string | null;
          metadata: Record<string, unknown>; ip: string | null; device_model: string | null;
        }>(sql`
          SELECT a.id::text, a.action, a.created_at, a.actor_user_id, u.email AS actor_email,
                 a.workspace_id, w.name AS workspace_name, a.entity_type, a.entity_id, a.metadata,
                 host(a.ip_address) AS ip, d.model AS device_model
          ${base}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${f.pageSize} OFFSET ${offsetOf(f)}
        `),
        db.execute<{ total: number }>(sql`SELECT count(*)::int AS total ${base}`),
      ]);

      return {
        items: rows.rows.map((row) => ({
          id: row.id,
          action: row.action,
          at: new Date(row.created_at).toISOString(),
          actorUserId: row.actor_user_id,
          actorEmail: row.actor_email,
          workspaceId: row.workspace_id,
          workspaceName: row.workspace_name,
          entityType: row.entity_type,
          entityId: row.entity_id,
          metadata: row.metadata ?? {},
          ip: row.ip,
          deviceModel: row.device_model,
        })),
        page: f.page,
        pageSize: f.pageSize,
        total: total.rows[0]?.total ?? 0,
      };
    },
  );

  routes.get(
    '/audit/admins',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Ações realizadas pelos administradores no painel',
        hide: true,
        querystring: paginationQuerySchema.extend({
          action: z.string().max(80).optional(),
          adminId: z.string().uuid().optional(),
          targetType: z.string().max(40).optional(),
          targetId: z.string().max(120).optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          includeLogins: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
        }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => {
      const f = request.query;
      const conditions = [sql`true`];
      if (f.action) conditions.push(f.action.endsWith('.') ? sql`l.action LIKE ${f.action + '%'}` : sql`l.action = ${f.action}`);
      if (f.adminId) conditions.push(sql`l.admin_id = ${f.adminId}`);
      if (f.targetType) conditions.push(sql`l.target_type = ${f.targetType}`);
      if (f.targetId) conditions.push(sql`l.target_id = ${f.targetId}`);
      if (f.from) conditions.push(sql`l.created_at >= ${f.from}`);
      if (f.to) conditions.push(sql`l.created_at < ${f.to}`);
      if (!f.includeLogins) {
        conditions.push(sql`l.action NOT IN ('admin.logged_in','admin.logged_out','admin.login_failed')`);
      }
      const where = sql.join(conditions, sql` AND `);

      const [rows, total] = await Promise.all([
        db.execute<{
          id: string; admin_id: string | null; admin_email: string; action: string; target_type: string | null;
          target_id: string | null; target_label: string | null; metadata: Record<string, unknown>; ip: string | null; created_at: string;
        }>(sql`
          SELECT l.id::text, l.admin_id, l.admin_email, l.action, l.target_type, l.target_id, l.metadata,
                 host(l.ip_address) AS ip, l.created_at,
                 CASE l.target_type
                   WHEN 'user' THEN (SELECT email FROM users WHERE id::text = l.target_id)
                   WHEN 'workspace' THEN (SELECT name FROM workspaces WHERE id::text = l.target_id)
                   WHEN 'admin' THEN (SELECT email FROM platform_admins WHERE id::text = l.target_id)
                   ELSE NULL
                 END AS target_label
          FROM admin_audit_log l
          WHERE ${where}
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT ${f.pageSize} OFFSET ${offsetOf(f)}
        `),
        db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM admin_audit_log l WHERE ${where}`),
      ]);

      return {
        items: rows.rows.map((row) => ({
          id: row.id,
          adminId: row.admin_id,
          adminEmail: row.admin_email,
          action: row.action,
          targetType: row.target_type,
          targetId: row.target_id,
          targetLabel: row.target_label,
          metadata: row.metadata ?? {},
          ip: row.ip,
          at: new Date(row.created_at).toISOString(),
        })),
        page: f.page,
        pageSize: f.pageSize,
        total: total.rows[0]?.total ?? 0,
      };
    },
  );
}
