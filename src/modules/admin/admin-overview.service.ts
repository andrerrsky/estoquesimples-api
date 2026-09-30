import { sql } from 'drizzle-orm';

import type { AppServices } from '../../platform/http/context.js';
import { ENTITLED_STATES } from '../billing/billing.service.js';
import { OpsService } from '../ops/ops.service.js';
import { ACTIVITY_SQL as ACTIVITY_UNION, bucketExpr, fillSeries, resolveRange, sqlList, type SeriesPoint } from './admin-series.js';

/**
 * Retrato da plataforma para a primeira tela do painel.
 *
 * Cada número aqui responde a uma pergunta que o dono do produto faz de
 * verdade ("quantas contas novas esta semana?", "quantas assinaturas estão
 * pagando?", "tem algo quebrado?"). Métricas sem pergunta ficam de fora.
 */
export type OverviewKpis = {
  usersTotal: number;
  usersNew7d: number;
  usersNew30d: number;
  usersNewPrev30d: number;
  usersSuspended: number;
  usersPendingDeletion: number;
  usersUnverified: number;
  workspacesActive: number;
  workspacesWithSubscription: number;
  workspacesSeeded: number;
  subscriptionsActive: number;
  subscriptionsGrace: number;
  subscriptionsCanceledButActive: number;
  subscriptionsOnHold: number;
  subscriptionsNew30d: number;
  subscriptionsEnded30d: number;
  dau: number;
  wau: number;
  mau: number;
  devicesActive7d: number;
  syncOps24h: number;
  conflictsPending: number;
  jobsFailed: number;
  billingEventsPending: number;
};

export interface OverviewResponse {
  generatedAt: string;
  kpis: OverviewKpis;
  series: {
    registrations: SeriesPoint[];
    activeUsers: SeriesPoint[];
    subscriptionsStarted: SeriesPoint[];
    subscriptionsEnded: SeriesPoint[];
    syncOperations: SeriesPoint[];
  };
  alerts: Array<{ nome: string; detalhe: string }>;
  recentUsers: Array<{ id: string; email: string; name: string; createdAt: string; emailVerified: boolean }>;
  recentSubscriptionChanges: Array<{
    subscriptionId: string | null;
    workspaceId: string | null;
    workspaceName: string | null;
    from: string | null;
    to: string | null;
    at: string;
  }>;
  recentAdminActions: Array<{ id: string; adminEmail: string; action: string; targetType: string | null; targetId: string | null; at: string }>;
}

export class AdminOverviewService {
  private readonly ops: OpsService;

  constructor(private readonly services: AppServices) {
    this.ops = new OpsService(services);
  }

  async overview(): Promise<OverviewResponse> {
    const { db } = this.services;
    const range = resolveRange({ days: 30 });

    const [kpiRows, snapshot, registrations, activeUsers, subsStarted, subsEnded, syncOps, users, subChanges, adminActions] =
      await Promise.all([
        db.execute<Record<string, string>>(sql`
          SELECT
            (SELECT count(*) FROM users WHERE deleted_at IS NULL) AS users_total,
            (SELECT count(*) FROM users WHERE deleted_at IS NULL AND created_at > now() - interval '7 days') AS users_new_7d,
            (SELECT count(*) FROM users WHERE deleted_at IS NULL AND created_at > now() - interval '30 days') AS users_new_30d,
            (SELECT count(*) FROM users WHERE deleted_at IS NULL
               AND created_at > now() - interval '60 days' AND created_at <= now() - interval '30 days') AS users_new_prev_30d,
            (SELECT count(*) FROM users WHERE deleted_at IS NULL AND status = 'suspended') AS users_suspended,
            (SELECT count(*) FROM users WHERE deleted_at IS NULL AND status = 'pending_deletion') AS users_pending_deletion,
            (SELECT count(*) FROM users WHERE deleted_at IS NULL AND email_verified_at IS NULL AND status = 'active') AS users_unverified,
            (SELECT count(*) FROM workspaces WHERE deleted_at IS NULL) AS workspaces_active,
            (SELECT count(DISTINCT workspace_id) FROM subscriptions
               WHERE state IN ${sqlList(ENTITLED_STATES)}) AS workspaces_with_subscription,
            (SELECT count(*) FROM workspaces WHERE deleted_at IS NULL AND seeded_at IS NOT NULL) AS workspaces_seeded,
            (SELECT count(*) FROM subscriptions WHERE state = 'ativa') AS subs_active,
            (SELECT count(*) FROM subscriptions WHERE state = 'carencia') AS subs_grace,
            (SELECT count(*) FROM subscriptions WHERE state = 'cancelada_mas_ativa') AS subs_canceled_active,
            (SELECT count(*) FROM subscriptions WHERE state = 'suspensa') AS subs_on_hold,
            (SELECT count(*) FROM subscriptions WHERE created_at > now() - interval '30 days') AS subs_new_30d,
            (SELECT count(*) FROM subscriptions
               WHERE state IN ('expirada','reembolsada') AND updated_at > now() - interval '30 days') AS subs_ended_30d,
            (SELECT count(DISTINCT user_id) FROM (${ACTIVITY_UNION}) a WHERE at > now() - interval '1 day') AS dau,
            (SELECT count(DISTINCT user_id) FROM (${ACTIVITY_UNION}) a WHERE at > now() - interval '7 days') AS wau,
            (SELECT count(DISTINCT user_id) FROM (${ACTIVITY_UNION}) a WHERE at > now() - interval '30 days') AS mau,
            (SELECT count(*) FROM subscription_events WHERE processed_at IS NULL) AS billing_events_pending
        `),
        this.ops.snapshot(),
        this.series(sql`users`, sql`created_at`, sql`deleted_at IS NULL`, range),
        db.execute<{ bucket: string; value: string }>(sql`
          SELECT ${bucketExpr(sql`at`, range.granularity)} AS bucket, count(DISTINCT user_id)::int AS value
          FROM (${ACTIVITY_UNION}) a
          WHERE at >= ${range.from} AND at < ${range.to}
          GROUP BY 1 ORDER BY 1
        `),
        this.series(sql`subscriptions`, sql`created_at`, sql`true`, range),
        this.series(
          sql`subscriptions`,
          sql`updated_at`,
          sql`state IN ('expirada','reembolsada')`,
          range,
        ),
        this.series(sql`sync_operations`, sql`created_at`, sql`true`, range),
        db.execute<{ id: string; email: string; name: string; created_at: string; verified: boolean }>(sql`
          SELECT id, email, name, created_at, (email_verified_at IS NOT NULL) AS verified
          FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 8
        `),
        db.execute<{ entity_id: string | null; workspace_id: string | null; workspace_name: string | null; metadata: Record<string, unknown>; created_at: string }>(sql`
          SELECT a.entity_id, a.workspace_id, w.name AS workspace_name, a.metadata, a.created_at
          FROM audit_log a LEFT JOIN workspaces w ON w.id = a.workspace_id
          WHERE a.action IN ('subscription.state_changed', 'subscription.linked')
          ORDER BY a.created_at DESC LIMIT 8
        `),
        db.execute<{ id: string; admin_email: string; action: string; target_type: string | null; target_id: string | null; created_at: string }>(sql`
          SELECT id::text, admin_email, action, target_type, target_id, created_at
          FROM admin_audit_log
          WHERE action NOT IN ('admin.logged_in', 'admin.logged_out', 'admin.login_failed')
          ORDER BY created_at DESC LIMIT 8
        `),
      ]);

    const k = kpiRows.rows[0] ?? {};
    const n = (key: string): number => Number(k[key] ?? 0);

    return {
      generatedAt: new Date().toISOString(),
      kpis: {
        usersTotal: n('users_total'),
        usersNew7d: n('users_new_7d'),
        usersNew30d: n('users_new_30d'),
        usersNewPrev30d: n('users_new_prev_30d'),
        usersSuspended: n('users_suspended'),
        usersPendingDeletion: n('users_pending_deletion'),
        usersUnverified: n('users_unverified'),
        workspacesActive: n('workspaces_active'),
        workspacesWithSubscription: n('workspaces_with_subscription'),
        workspacesSeeded: n('workspaces_seeded'),
        subscriptionsActive: n('subs_active'),
        subscriptionsGrace: n('subs_grace'),
        subscriptionsCanceledButActive: n('subs_canceled_active'),
        subscriptionsOnHold: n('subs_on_hold'),
        subscriptionsNew30d: n('subs_new_30d'),
        subscriptionsEnded30d: n('subs_ended_30d'),
        dau: n('dau'),
        wau: n('wau'),
        mau: n('mau'),
        devicesActive7d: snapshot.dispositivosAtivos7d,
        syncOps24h: snapshot.operacoesSync24h,
        conflictsPending: snapshot.conflitosPendentes,
        jobsFailed: snapshot.jobsFalhos,
        billingEventsPending: n('billing_events_pending'),
      },
      series: {
        registrations,
        activeUsers: fillSeries(activeUsers.rows, range),
        subscriptionsStarted: subsStarted,
        subscriptionsEnded: subsEnded,
        syncOperations: syncOps,
      },
      alerts: this.ops.alertas(snapshot),
      recentUsers: users.rows.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        createdAt: new Date(row.created_at).toISOString(),
        emailVerified: row.verified,
      })),
      recentSubscriptionChanges: subChanges.rows.map((row) => ({
        subscriptionId: row.entity_id,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        from: typeof row.metadata['from'] === 'string' ? (row.metadata['from'] as string) : null,
        to:
          typeof row.metadata['to'] === 'string'
            ? (row.metadata['to'] as string)
            : typeof row.metadata['state'] === 'string'
              ? (row.metadata['state'] as string)
              : null,
        at: new Date(row.created_at).toISOString(),
      })),
      recentAdminActions: adminActions.rows.map((row) => ({
        id: row.id,
        adminEmail: row.admin_email,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        at: new Date(row.created_at).toISOString(),
      })),
    };
  }

  private async series(
    table: ReturnType<typeof sql>,
    column: ReturnType<typeof sql>,
    where: ReturnType<typeof sql>,
    range: ReturnType<typeof resolveRange>,
  ): Promise<SeriesPoint[]> {
    const rows = await this.services.db.execute<{ bucket: string; value: string }>(sql`
      SELECT ${bucketExpr(column, range.granularity)} AS bucket, count(*)::int AS value
      FROM ${table}
      WHERE ${where} AND ${column} >= ${range.from} AND ${column} < ${range.to}
      GROUP BY 1 ORDER BY 1
    `);
    return fillSeries(rows.rows, range);
  }
}
