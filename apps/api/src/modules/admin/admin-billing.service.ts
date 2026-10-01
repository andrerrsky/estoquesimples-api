import { and, desc, eq, sql } from 'drizzle-orm';

import {
  planFeatures,
  plans,
  subscriptionEvents,
  subscriptions,
  users,
  workspaces,
} from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../platform/http/errors.js';
import { BillingService, ENTITLED_STATES, RtdnType } from '../billing/billing.service.js';
import { AdminAction, recordAdminAudit, type AdminActor } from './admin-audit.service.js';
import { sqlList } from './admin-series.js';
import { iso, offsetOf, type Paginated, type PaginationQuery } from './admin.schemas.js';

export interface SubscriptionListFilters extends PaginationQuery {
  q?: string;
  state?: string;
  planKey?: string;
  sort?: 'createdAt' | 'currentPeriodEnd' | 'lastVerifiedAt';
  order?: 'asc' | 'desc';
}

const SORT_COLUMNS: Record<NonNullable<SubscriptionListFilters['sort']>, string> = {
  createdAt: 's.created_at',
  currentPeriodEnd: 's.current_period_end',
  lastVerifiedAt: 's.last_verified_at',
};

/** Nome legível dos tipos de notificação do Google, para o painel. */
export const RTDN_LABELS: Record<number, string> = Object.fromEntries(
  Object.entries(RtdnType).map(([name, code]) => [code, name.toLowerCase()]),
);

/**
 * Assinaturas, do ponto de vista de quem dá suporte.
 *
 * O purchase token nunca sai daqui — nem cifrado, nem o hash. O que o
 * suporte precisa é o estado, as datas e a trilha de notificações; para
 * "forçar" algo, o único caminho é pedir ao Google o estado atual, que é o
 * mesmo caminho que o app e a reconciliação usam.
 */
export class AdminBillingService {
  private readonly billing: BillingService;

  constructor(private readonly services: AppServices) {
    this.billing = new BillingService(services);
  }

  private get db() {
    return this.services.db;
  }

  async stats() {
    const rows = await this.db.execute<{ state: string; count: number }>(sql`
      SELECT state, count(*)::int AS count FROM subscriptions GROUP BY state ORDER BY count DESC
    `);
    const expiring = await this.db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM subscriptions
      WHERE state IN ${sqlList(ENTITLED_STATES)}
        AND current_period_end < now() + interval '7 days'
    `);
    const unverified = await this.db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM subscriptions
      WHERE state IN ${sqlList(ENTITLED_STATES)} AND last_verified_at < now() - interval '48 hours'
    `);
    const eventsPending = await this.db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM subscription_events WHERE processed_at IS NULL
    `);
    return {
      byState: rows.rows,
      expiring7d: expiring.rows[0]?.count ?? 0,
      unverified48h: unverified.rows[0]?.count ?? 0,
      eventsPending: eventsPending.rows[0]?.count ?? 0,
      playConfigured: this.services.playClient.configured,
    };
  }

  async list(filters: SubscriptionListFilters): Promise<Paginated<Record<string, unknown>>> {
    const conditions = [sql`true`];
    if (filters.state) conditions.push(sql`s.state = ${filters.state}`);
    if (filters.planKey) conditions.push(sql`s.plan_key = ${filters.planKey}`);
    if (filters.q) {
      const term = `%${filters.q.toLowerCase()}%`;
      const maybeUuid = /^[0-9a-f-]{36}$/i.test(filters.q);
      conditions.push(
        maybeUuid
          ? sql`(s.id = ${filters.q}::uuid OR s.workspace_id = ${filters.q}::uuid OR lower(w.name) LIKE ${term})`
          : sql`(lower(w.name) LIKE ${term} OR lower(coalesce(u.email,'')) LIKE ${term} OR lower(coalesce(o.email,'')) LIKE ${term})`,
      );
    }
    const where = sql.join(conditions, sql` AND `);
    const sortColumn = SORT_COLUMNS[filters.sort ?? 'createdAt'];
    const order = filters.order === 'asc' ? sql`ASC NULLS FIRST` : sql`DESC NULLS LAST`;

    const base = sql`
      FROM subscriptions s
      JOIN workspaces w ON w.id = s.workspace_id
      JOIN users o ON o.id = w.owner_user_id
      LEFT JOIN users u ON u.id = s.purchaser_user_id
      WHERE ${where}
    `;

    const [rows, total] = await Promise.all([
      this.db.execute<{
        id: string; workspace_id: string; workspace_name: string; owner_email: string; purchaser_email: string | null;
        plan_key: string; state: string; auto_renewing: boolean; acknowledged: boolean; started_at: string | null;
        current_period_end: string | null; grace_until: string | null; canceled_at: string | null;
        last_verified_at: string; latest_notification_type: number | null; product_id: string; base_plan_id: string | null;
        created_at: string; updated_at: string;
      }>(sql`
        SELECT s.id, s.workspace_id, w.name AS workspace_name, o.email AS owner_email, u.email AS purchaser_email,
               s.plan_key, s.state, s.auto_renewing, s.acknowledged, s.started_at, s.current_period_end, s.grace_until,
               s.canceled_at, s.last_verified_at, s.latest_notification_type, s.google_product_id AS product_id,
               s.google_base_plan_id AS base_plan_id, s.created_at, s.updated_at
        ${base}
        ORDER BY ${sql.raw(sortColumn)} ${order}, s.id
        LIMIT ${filters.pageSize} OFFSET ${offsetOf(filters)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total ${base}`),
    ]);

    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        ownerEmail: row.owner_email,
        purchaserEmail: row.purchaser_email,
        planKey: row.plan_key,
        state: row.state,
        autoRenewing: row.auto_renewing,
        acknowledged: row.acknowledged,
        startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
        currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end).toISOString() : null,
        graceUntil: row.grace_until ? new Date(row.grace_until).toISOString() : null,
        canceledAt: row.canceled_at ? new Date(row.canceled_at).toISOString() : null,
        lastVerifiedAt: new Date(row.last_verified_at).toISOString(),
        latestNotificationType: row.latest_notification_type,
        latestNotificationLabel:
          row.latest_notification_type !== null ? (RTDN_LABELS[row.latest_notification_type] ?? null) : null,
        productId: row.product_id,
        basePlanId: row.base_plan_id,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      })),
      page: filters.page,
      pageSize: filters.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  async get(subscriptionId: string) {
    const rows = await this.db
      .select({
        sub: subscriptions,
        workspaceName: workspaces.name,
        workspaceDeletedAt: workspaces.deletedAt,
        purchaserEmail: users.email,
        purchaserName: users.name,
      })
      .from(subscriptions)
      .innerJoin(workspaces, eq(workspaces.id, subscriptions.workspaceId))
      .leftJoin(users, eq(users.id, subscriptions.purchaserUserId))
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Assinatura não encontrada.');
    const s = row.sub;

    const [events, audit, superseded] = await Promise.all([
      this.db
        .select({
          id: subscriptionEvents.id,
          notificationId: subscriptionEvents.notificationId,
          notificationType: subscriptionEvents.notificationType,
          receivedAt: subscriptionEvents.receivedAt,
          processedAt: subscriptionEvents.processedAt,
          processError: subscriptionEvents.processError,
        })
        .from(subscriptionEvents)
        .where(
          s.purchaseTokenHash
            ? sql`(${subscriptionEvents.subscriptionId} = ${subscriptionId} OR ${subscriptionEvents.purchaseTokenHash} = ${s.purchaseTokenHash})`
            : eq(subscriptionEvents.subscriptionId, subscriptionId),
        )
        .orderBy(desc(subscriptionEvents.receivedAt))
        .limit(100),
      this.db.execute<{ id: string; action: string; metadata: Record<string, unknown>; created_at: string; actor_email: string | null }>(sql`
        SELECT a.id::text, a.action, a.metadata, a.created_at, u.email AS actor_email
        FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.entity_type = 'subscription' AND a.entity_id = ${subscriptionId}
        ORDER BY a.created_at DESC LIMIT 100
      `),
      this.db
        .select({ id: subscriptions.id, state: subscriptions.state, createdAt: subscriptions.createdAt })
        .from(subscriptions)
        .where(eq(subscriptions.supersededBy, subscriptionId)),
    ]);

    // `raw` é o JSON do Google já sem tokens (scrubPurchasePayload). Expor
    // aqui ajuda a diagnosticar: é o que o Google diz, sem tradução nossa.
    return {
      id: s.id,
      workspaceId: s.workspaceId,
      workspaceName: row.workspaceName,
      workspaceDeletedAt: iso(row.workspaceDeletedAt),
      purchaserUserId: s.purchaserUserId,
      purchaserEmail: row.purchaserEmail,
      purchaserName: row.purchaserName,
      planKey: s.planKey,
      state: s.state,
      autoRenewing: s.autoRenewing,
      acknowledged: s.acknowledged,
      startedAt: iso(s.startedAt),
      currentPeriodEnd: iso(s.currentPeriodEnd),
      graceUntil: iso(s.graceUntil),
      canceledAt: iso(s.canceledAt),
      cancelReason: s.cancelReason,
      hasLinkedToken: s.linkedPurchaseTokenHash !== null,
      supersededBy: s.supersededBy,
      supersedes: superseded.map((item) => ({ id: item.id, state: item.state, createdAt: item.createdAt.toISOString() })),
      latestNotificationType: s.latestNotificationType,
      latestNotificationLabel:
        s.latestNotificationType !== null ? (RTDN_LABELS[s.latestNotificationType] ?? null) : null,
      lastVerifiedAt: s.lastVerifiedAt.toISOString(),
      productId: s.googleProductId,
      basePlanId: s.googleBasePlanId,
      offerId: s.googleOfferId,
      raw: s.raw,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      events: events.map((event) => ({
        id: event.id,
        notificationId: event.notificationId,
        notificationType: event.notificationType,
        notificationLabel: event.notificationType !== null ? (RTDN_LABELS[event.notificationType] ?? null) : null,
        receivedAt: event.receivedAt.toISOString(),
        processedAt: iso(event.processedAt),
        processError: event.processError,
      })),
      audit: audit.rows.map((entry) => ({
        id: entry.id,
        action: entry.action,
        metadata: entry.metadata ?? {},
        actorEmail: entry.actor_email,
        at: new Date(entry.created_at).toISOString(),
      })),
    };
  }

  /** Reconsulta o Google para a assinatura viva da empresa. */
  async refresh(actor: AdminActor, subscriptionId: string) {
    const rows = await this.db
      .select({ workspaceId: subscriptions.workspaceId, state: subscriptions.state })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    const sub = rows[0];
    if (!sub) throw notFound('Assinatura não encontrada.');
    if (!this.services.playClient.configured) {
      throw badRequest(ErrorCode.BILLING_UNAVAILABLE, 'Google Play não configurado neste ambiente.');
    }

    const before = sub.state;
    const entitlement = await this.billing.refreshWorkspaceSubscription(sub.workspaceId);
    const after = await this.db
      .select({ state: subscriptions.state })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);

    await recordAdminAudit(this.db, {
      actor,
      action: AdminAction.SUBSCRIPTION_REFRESHED,
      targetType: 'subscription',
      targetId: subscriptionId,
      metadata: { workspaceId: sub.workspaceId, from: before, to: after[0]?.state ?? before },
    });

    return { entitlement, from: before, to: after[0]?.state ?? before };
  }

  // -------------------------------------------------------------------------
  // Notificações do Google
  // -------------------------------------------------------------------------

  async events(query: PaginationQuery & { onlyPending?: boolean; onlyErrors?: boolean }) {
    const conditions = [sql`true`];
    if (query.onlyPending) conditions.push(sql`e.processed_at IS NULL`);
    if (query.onlyErrors) conditions.push(sql`e.process_error IS NOT NULL`);
    const where = sql.join(conditions, sql` AND `);

    const [rows, total] = await Promise.all([
      this.db.execute<{
        id: string; notification_id: string; notification_type: number | null; subscription_id: string | null;
        workspace_id: string | null; workspace_name: string | null; received_at: string; processed_at: string | null; process_error: string | null;
      }>(sql`
        SELECT e.id, e.notification_id, e.notification_type, e.subscription_id, s.workspace_id, w.name AS workspace_name,
               e.received_at, e.processed_at, e.process_error
        FROM subscription_events e
        LEFT JOIN subscriptions s ON s.id = e.subscription_id OR (e.subscription_id IS NULL AND s.purchase_token_hash = e.purchase_token_hash)
        LEFT JOIN workspaces w ON w.id = s.workspace_id
        WHERE ${where}
        ORDER BY e.received_at DESC LIMIT ${query.pageSize} OFFSET ${offsetOf(query)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM subscription_events e WHERE ${where}`),
    ]);

    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        notificationId: row.notification_id,
        notificationType: row.notification_type,
        notificationLabel: row.notification_type !== null ? (RTDN_LABELS[row.notification_type] ?? null) : null,
        subscriptionId: row.subscription_id,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        receivedAt: new Date(row.received_at).toISOString(),
        processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : null,
        processError: row.process_error,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  async retryEvent(actor: AdminActor, eventId: string) {
    const rows = await this.db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.id, eventId))
      .limit(1);
    const event = rows[0];
    if (!event) throw notFound('Notificação não encontrada.');
    if (event.processedAt) throw conflict(ErrorCode.CONFLICT, 'Esta notificação já foi processada.');
    if (!event.purchaseTokenEnc) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Notificação sem comprovante; nada a reprocessar.');
    if (!this.services.playClient.configured) {
      throw badRequest(ErrorCode.BILLING_UNAVAILABLE, 'Google Play não configurado neste ambiente.');
    }

    let outcome: 'processed' | 'failed' = 'processed';
    let error: string | null = null;
    try {
      const plaintext = this.services.purchaseTokens.decrypt(event.purchaseTokenEnc);
      const subscriptionId = await this.billing.refreshFromGoogle(plaintext, event.notificationType);
      await this.db
        .update(subscriptionEvents)
        .set({ processedAt: new Date(), subscriptionId, processError: null })
        .where(eq(subscriptionEvents.id, eventId));
    } catch (caught) {
      outcome = 'failed';
      error = caught instanceof Error ? caught.message : String(caught);
      await this.db
        .update(subscriptionEvents)
        .set({ processError: error.slice(0, 1000) })
        .where(eq(subscriptionEvents.id, eventId));
    }

    await recordAdminAudit(this.db, {
      actor,
      action: AdminAction.SUBSCRIPTION_EVENT_RETRIED,
      targetType: 'subscription_event',
      targetId: eventId,
      metadata: { outcome, error },
    });

    return { outcome, error };
  }

  // -------------------------------------------------------------------------
  // Planos
  // -------------------------------------------------------------------------

  async plans() {
    const [planRows, featureRows, counts] = await Promise.all([
      this.db.select().from(plans).orderBy(plans.createdAt),
      this.db.select().from(planFeatures),
      this.db.execute<{ plan_key: string; count: number }>(sql`
        SELECT plan_key, count(*)::int AS count FROM subscriptions
        WHERE state IN ${sqlList(ENTITLED_STATES)} GROUP BY plan_key
      `),
    ]);
    const countByPlan = new Map(counts.rows.map((row) => [row.plan_key, row.count]));
    return planRows.map((plan) => ({
      key: plan.key,
      name: plan.name,
      description: plan.description,
      googleProductId: plan.googleProductId,
      googleBasePlanId: plan.googleBasePlanId,
      isActive: plan.isActive,
      activeSubscriptions: countByPlan.get(plan.key) ?? 0,
      features: featureRows
        .filter((feature) => feature.planKey === plan.key)
        .map((feature) => ({ key: feature.featureKey, enabled: feature.enabled, limit: feature.limitValue })),
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    }));
  }

  async updatePlan(
    actor: AdminActor,
    planKey: string,
    input: { name?: string; description?: string; isActive?: boolean; reason: string },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx.select().from(plans).where(eq(plans.key, planKey)).limit(1).for('update');
      const plan = rows[0];
      if (!plan) throw notFound('Plano não encontrado.');

      const patch: Partial<typeof plans.$inferInsert> = {};
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (input.name !== undefined && input.name !== plan.name) {
        patch.name = input.name;
        changes['name'] = { from: plan.name, to: input.name };
      }
      if (input.description !== undefined && input.description !== plan.description) {
        patch.description = input.description;
        changes['description'] = { from: plan.description, to: input.description };
      }
      if (input.isActive !== undefined && input.isActive !== plan.isActive) {
        patch.isActive = input.isActive;
        changes['isActive'] = { from: plan.isActive, to: input.isActive };
      }
      if (Object.keys(patch).length === 0) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Nada para alterar.');

      await tx.update(plans).set(patch).where(eq(plans.key, planKey));
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.PLAN_UPDATED,
        targetType: 'plan',
        targetId: planKey,
        metadata: { changes, reason: input.reason },
      });
    });
  }

  async updatePlanFeature(
    actor: AdminActor,
    planKey: string,
    featureKey: string,
    input: { enabled: boolean; limit: number | null; reason: string },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const planRows = await tx.select({ key: plans.key }).from(plans).where(eq(plans.key, planKey)).limit(1);
      if (planRows.length === 0) throw notFound('Plano não encontrado.');

      const current = await tx
        .select()
        .from(planFeatures)
        .where(and(eq(planFeatures.planKey, planKey), eq(planFeatures.featureKey, featureKey)))
        .limit(1);

      await tx
        .insert(planFeatures)
        .values({ planKey, featureKey, enabled: input.enabled, limitValue: input.limit })
        .onConflictDoUpdate({
          target: [planFeatures.planKey, planFeatures.featureKey],
          set: { enabled: input.enabled, limitValue: input.limit },
        });

      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.PLAN_FEATURE_UPDATED,
        targetType: 'plan',
        targetId: planKey,
        metadata: {
          featureKey,
          from: current[0] ? { enabled: current[0].enabled, limit: current[0].limitValue } : null,
          to: { enabled: input.enabled, limit: input.limit },
          reason: input.reason,
        },
      });
    });
  }
}
