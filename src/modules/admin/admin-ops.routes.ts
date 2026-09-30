import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { appConfig, jobs } from '../../platform/db/schema/index.js';
import { migrationStatus } from '../../platform/db/migrate.js';
import { ErrorCode, conflict, notFound } from '../../platform/http/errors.js';
import { OpsService } from '../ops/ops.service.js';
import { AdminAction, recordAdminAudit } from './admin-audit.service.js';
import { adminActor, requireAdmin } from './admin-auth.plugin.js';
import { commonAdminErrors, messageSchema, offsetOf, paginationQuerySchema, reasonBodySchema, uuidParam } from './admin.schemas.js';

const startedAt = Date.now();

const syncConfigSchema = z.object({
  enabled: z.boolean(),
  minAppVersionCode: z.number().int().nonnegative(),
});

/**
 * Operação pelo painel.
 *
 * Reaproveita o `OpsService` (mesmo retrato e mesmos alertas de `/ops/status`)
 * e expõe, com sessão de administrador, o que antes só existia via
 * `OPS_TOKEN`: o interruptor de sincronização, a fila de tarefas e o estado
 * do backup. O `OPS_TOKEN` continua valendo para o coletor de métricas.
 */
export async function registerAdminOpsRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const { db, dbHandle, env } = app.services;
  const ops = new OpsService(app.services);

  routes.get(
    '/ops/status',
    {
      preHandler: requireAdmin('viewer'),
      schema: { tags: ['admin'], summary: 'Retrato operacional, alertas e ambiente', hide: true, response: { 200: z.any(), ...commonAdminErrors } },
    },
    async () => {
      const [snapshot, migrations, backup, syncConfig, jobKinds] = await Promise.all([
        ops.snapshot(),
        migrationStatus(dbHandle.pool).catch(() => []),
        db.select({ value: appConfig.value, updatedAt: appConfig.updatedAt }).from(appConfig).where(eq(appConfig.key, 'backup_verificado')).limit(1),
        db.select({ value: appConfig.value, updatedAt: appConfig.updatedAt }).from(appConfig).where(eq(appConfig.key, 'sync')).limit(1),
        db.execute<{ kind: string; pending: number; failed: number; completed_24h: number; last_completed: string | null; last_error: string | null }>(sql`
          SELECT kind,
                 count(*) FILTER (WHERE completed_at IS NULL AND failed_at IS NULL)::int AS pending,
                 count(*) FILTER (WHERE failed_at IS NOT NULL)::int AS failed,
                 count(*) FILTER (WHERE completed_at > now() - interval '24 hours')::int AS completed_24h,
                 max(completed_at) AS last_completed,
                 (SELECT last_error FROM jobs j2 WHERE j2.kind = jobs.kind AND j2.last_error IS NOT NULL ORDER BY j2.created_at DESC LIMIT 1) AS last_error
          FROM jobs GROUP BY kind ORDER BY kind
        `),
      ]);

      const backupRow = backup[0];
      const backupHours = backupRow ? (Date.now() - backupRow.updatedAt.getTime()) / 3_600_000 : null;
      const storedSync = syncConfig[0]?.value as { enabled?: boolean; minAppVersionCode?: number } | undefined;

      return {
        generatedAt: new Date().toISOString(),
        snapshot,
        alerts: ops.alertas(snapshot),
        environment: {
          nodeEnv: env.NODE_ENV,
          version: process.env['npm_package_version'] ?? '0.1.0',
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          jobsEnabled: env.JOBS_ENABLED,
          playConfigured: app.services.playClient.configured,
          emailProvider: env.EMAIL_PROVIDER,
          syncProtocolVersion: env.SYNC_PROTOCOL_VERSION,
          syncMinSupportedProtocol: env.SYNC_PROTOCOL_MIN_SUPPORTED,
          analyticsRetentionDays: env.ANALYTICS_RETENTION_DAYS,
          opsTokenConfigured: Boolean(env.OPS_TOKEN),
        },
        sync: {
          enabled: storedSync?.enabled ?? env.FEATURE_SYNC_ENABLED,
          minAppVersionCode: storedSync?.minAppVersionCode ?? env.FEATURE_SYNC_MIN_APP_VERSION_CODE,
          source: storedSync ? 'banco' : 'ambiente',
          updatedAt: syncConfig[0]?.updatedAt?.toISOString() ?? null,
        },
        backup: {
          verifiedAt: backupRow?.updatedAt.toISOString() ?? null,
          hoursSince: backupHours === null ? null : Math.round(backupHours),
          withinLimit: backupHours !== null && backupHours <= env.BACKUP_MAX_AGE_HOURS,
          maxAgeHours: env.BACKUP_MAX_AGE_HOURS,
          details: (backupRow?.value ?? {}) as Record<string, unknown>,
        },
        migrations,
        jobKinds: jobKinds.rows.map((row) => ({
          kind: row.kind,
          pending: row.pending,
          failed: row.failed,
          completed24h: row.completed_24h,
          lastCompletedAt: row.last_completed ? new Date(row.last_completed).toISOString() : null,
          lastError: row.last_error,
        })),
      };
    },
  );

  routes.put(
    '/ops/sync',
    {
      preHandler: requireAdmin('owner'),
      schema: {
        tags: ['admin'],
        summary: 'Liga, desliga ou restringe a sincronização por versão do app',
        hide: true,
        body: syncConfigSchema.extend({ reason: z.string().trim().min(3).max(500) }).strict(),
        response: { 200: syncConfigSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      const { reason, ...config } = request.body;
      const before = await db.select({ value: appConfig.value }).from(appConfig).where(eq(appConfig.key, 'sync')).limit(1);

      await db.transaction(async (tx) => {
        await tx
          .insert(appConfig)
          .values({ key: 'sync', value: config })
          .onConflictDoUpdate({ target: appConfig.key, set: { value: config, updatedAt: new Date() } });
        await recordAdminAudit(tx, {
          actor: adminActor(request),
          action: AdminAction.OPS_SYNC_CONFIG_CHANGED,
          targetType: 'config',
          targetId: 'sync',
          metadata: { from: before[0]?.value ?? null, to: config, reason },
        });
      });

      request.log.warn({ config, alerta: true, admin: request.admin?.email }, 'configuração de sincronização alterada pelo painel');
      return config;
    },
  );

  routes.get(
    '/ops/jobs',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Fila de tarefas',
        hide: true,
        querystring: paginationQuerySchema.extend({
          status: z.enum(['pending', 'failed', 'completed', 'running']).optional(),
          kind: z.string().max(80).optional(),
        }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => {
      const f = request.query;
      const conditions = [sql`true`];
      if (f.kind) conditions.push(sql`j.kind = ${f.kind}`);
      if (f.status === 'pending') conditions.push(sql`j.completed_at IS NULL AND j.failed_at IS NULL AND j.locked_at IS NULL`);
      if (f.status === 'running') conditions.push(sql`j.completed_at IS NULL AND j.failed_at IS NULL AND j.locked_at IS NOT NULL`);
      if (f.status === 'failed') conditions.push(sql`j.failed_at IS NOT NULL`);
      if (f.status === 'completed') conditions.push(sql`j.completed_at IS NOT NULL`);
      const where = sql.join(conditions, sql` AND `);

      const [rows, total] = await Promise.all([
        db.execute<{
          id: string; kind: string; payload: Record<string, unknown>; unique_key: string | null; run_at: string; attempts: number;
          max_attempts: number; locked_at: string | null; locked_by: string | null; completed_at: string | null;
          failed_at: string | null; last_error: string | null; created_at: string;
        }>(sql`
          SELECT j.* FROM jobs j WHERE ${where}
          ORDER BY coalesce(j.failed_at, j.completed_at, j.run_at) DESC LIMIT ${f.pageSize} OFFSET ${offsetOf(f)}
        `),
        db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM jobs j WHERE ${where}`),
      ]);

      return {
        items: rows.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          payload: row.payload ?? {},
          uniqueKey: row.unique_key,
          runAt: new Date(row.run_at).toISOString(),
          attempts: row.attempts,
          maxAttempts: row.max_attempts,
          lockedAt: row.locked_at ? new Date(row.locked_at).toISOString() : null,
          lockedBy: row.locked_by,
          completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
          failedAt: row.failed_at ? new Date(row.failed_at).toISOString() : null,
          lastError: row.last_error,
          createdAt: new Date(row.created_at).toISOString(),
          status: row.failed_at ? 'failed' : row.completed_at ? 'completed' : row.locked_at ? 'running' : 'pending',
        })),
        page: f.page,
        pageSize: f.pageSize,
        total: total.rows[0]?.total ?? 0,
      };
    },
  );

  routes.post(
    '/ops/jobs/:jobId/retry',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Recoloca uma tarefa falha na fila',
        hide: true,
        params: uuidParam('jobId'),
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await db.transaction(async (tx) => {
        const rows = await tx.select().from(jobs).where(eq(jobs.id, request.params.jobId)).limit(1).for('update');
        const job = rows[0];
        if (!job) throw notFound('Tarefa não encontrada.');
        if (!job.failedAt) throw conflict(ErrorCode.CONFLICT, 'Só tarefas falhas podem ser repetidas.');

        await tx
          .update(jobs)
          .set({ failedAt: null, attempts: 0, runAt: new Date(), lockedAt: null, lockedBy: null })
          .where(eq(jobs.id, job.id));
        await recordAdminAudit(tx, {
          actor: adminActor(request),
          action: AdminAction.OPS_JOB_RETRIED,
          targetType: 'job',
          targetId: job.id,
          metadata: { kind: job.kind, previousError: job.lastError },
        });
      });
      return { message: 'Tarefa recolocada na fila.' };
    },
  );

  routes.post(
    '/ops/jobs/:jobId/cancel',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Cancela uma tarefa pendente',
        hide: true,
        params: uuidParam('jobId'),
        body: reasonBodySchema,
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await db.transaction(async (tx) => {
        const rows = await tx.select().from(jobs).where(eq(jobs.id, request.params.jobId)).limit(1).for('update');
        const job = rows[0];
        if (!job) throw notFound('Tarefa não encontrada.');
        if (job.completedAt || job.failedAt) throw conflict(ErrorCode.CONFLICT, 'A tarefa já terminou.');

        await tx
          .update(jobs)
          .set({ failedAt: new Date(), lastError: `cancelada pelo painel: ${request.body.reason}`.slice(0, 1000) })
          .where(eq(jobs.id, job.id));
        await recordAdminAudit(tx, {
          actor: adminActor(request),
          action: AdminAction.OPS_JOB_CANCELLED,
          targetType: 'job',
          targetId: job.id,
          metadata: { kind: job.kind, reason: request.body.reason },
        });
      });
      return { message: 'Tarefa cancelada.' };
    },
  );
}
