import { and, desc, eq, sql } from 'drizzle-orm';

import {
  billingCustomers,
  billingPayments,
  planFeatures,
  plans,
  subscriptionEvents,
  subscriptions,
  users,
  workspaces,
} from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../platform/http/errors.js';
import { AsaasBillingService, WEB_PLAN_KEY } from '../billing/asaas/asaas-billing.service.js';
import { BillingService, ENTITLED_STATES, LIVE_STATES, RtdnType } from '../billing/billing.service.js';
import { AdminAction, recordAdminAudit, type AdminActor } from './admin-audit.service.js';
import { sqlList } from './admin-series.js';
import { iso, offsetOf, type Paginated, type PaginationQuery } from './admin.schemas.js';

export const SUBSCRIPTION_PROVIDERS = ['google_play', 'asaas'] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

/** Teto do preço web: acima disso é erro de digitação, não preço de plano. */
export const WEB_PRICE_MIN_CENTS = 500;
export const WEB_PRICE_MAX_CENTS = 1_000_000;

export interface SubscriptionListFilters extends PaginationQuery {
  q?: string;
  state?: string;
  planKey?: string;
  provider?: SubscriptionProvider;
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
 * O JSON do Asaas é guardado como veio e, em assinatura no cartão, pode
 * trazer `creditCard` (final, bandeira e o token do cartão). O painel só
 * mostra uma lista fechada de campos: o que não está aqui não sai.
 */
const ASAAS_RAW_FIELDS = ['id', 'status', 'deleted', 'cycle', 'value', 'billingType', 'nextDueDate', 'endDate', 'description', 'dateCreated'] as const;

function asaasRawView(raw: unknown): Record<string, unknown> {
  const source = (raw ?? {}) as { subscription?: Record<string, unknown> | null; carryPaidUntil?: unknown };
  const subscription: Record<string, unknown> = {};
  for (const field of ASAAS_RAW_FIELDS) {
    const value = source.subscription?.[field];
    if (value !== undefined) subscription[field] = value;
  }
  return { subscription, carryPaidUntil: source.carryPaidUntil ?? null };
}

/**
 * Assinaturas, do ponto de vista de quem dá suporte.
 *
 * Os dois provedores vivem na mesma tabela e na mesma tela: Google Play (app
 * Android) e Asaas (web). O purchase token nunca sai daqui — nem cifrado,
 * nem o hash — e do pagador só o que `billing_customers` guarda (o documento
 * é só o final). O que o suporte precisa é o estado, as datas, as cobranças
 * e a trilha de notificações; para "forçar" algo, o único caminho é pedir ao
 * provedor o estado atual, que é o mesmo caminho que o app, o webhook e a
 * reconciliação usam.
 */
export class AdminBillingService {
  private readonly billing: BillingService;
  private readonly asaasBilling: AsaasBillingService;

  constructor(private readonly services: AppServices) {
    this.billing = new BillingService(services);
    this.asaasBilling = new AsaasBillingService(services);
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
    const eventsPending = await this.db.execute<{ provider: string; count: number }>(sql`
      SELECT provider, count(*)::int AS count FROM subscription_events WHERE processed_at IS NULL GROUP BY provider
    `);
    // Mesma tabela, dois provedores: o recorte mostra quanto da base paga
    // vem do app (Google Play) e quanto da web (Asaas). A receita recorrente
    // só existe para a web — no Google o preço fica na Play Console.
    const byProvider = await this.db.execute<{
      provider: string; total: number; entitled: number; problem: number; mrr_cents: string | null;
    }>(sql`
      SELECT provider,
             count(*)::int AS total,
             count(*) FILTER (WHERE state IN ${sqlList(ENTITLED_STATES)})::int AS entitled,
             count(*) FILTER (WHERE state IN ('pendente', 'suspensa'))::int AS problem,
             sum(CASE WHEN billing_cycle = 'YEARLY' THEN price_cents / 12.0 ELSE price_cents END)
               FILTER (WHERE state IN ('ativa', 'carencia') AND price_cents IS NOT NULL) AS mrr_cents
      FROM subscriptions GROUP BY provider
    `);
    const pendingBy = new Map(eventsPending.rows.map((row) => [row.provider, row.count]));
    const providerRow = new Map(byProvider.rows.map((row) => [row.provider, row]));
    return {
      byState: rows.rows,
      byProvider: SUBSCRIPTION_PROVIDERS.map((provider) => {
        const row = providerRow.get(provider);
        return {
          provider,
          total: row?.total ?? 0,
          entitled: row?.entitled ?? 0,
          problem: row?.problem ?? 0,
          eventsPending: pendingBy.get(provider) ?? 0,
          // Só assinaturas ativas ou em carência; anual entra como 1/12.
          mrrCents: row?.mrr_cents != null ? Math.round(Number(row.mrr_cents)) : null,
        };
      }),
      expiring7d: expiring.rows[0]?.count ?? 0,
      unverified48h: unverified.rows[0]?.count ?? 0,
      eventsPending: eventsPending.rows.reduce((sum, row) => sum + row.count, 0),
      playConfigured: this.services.playClient.configured,
      asaasConfigured: this.services.asaas.configured,
      asaasEnvironment: this.services.asaas.environment,
    };
  }

  async list(filters: SubscriptionListFilters): Promise<Paginated<Record<string, unknown>>> {
    const conditions = [sql`true`];
    if (filters.state) conditions.push(sql`s.state = ${filters.state}`);
    if (filters.planKey) conditions.push(sql`s.plan_key = ${filters.planKey}`);
    if (filters.provider) conditions.push(sql`s.provider = ${filters.provider}`);
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
        plan_key: string; provider: string; state: string; auto_renewing: boolean; acknowledged: boolean; started_at: string | null;
        current_period_end: string | null; grace_until: string | null; canceled_at: string | null;
        last_verified_at: string; latest_notification_type: number | null; product_id: string | null; base_plan_id: string | null;
        billing_cycle: string | null; billing_type: string | null; price_cents: number | null; next_due_date: string | null;
        created_at: string; updated_at: string;
      }>(sql`
        SELECT s.id, s.workspace_id, w.name AS workspace_name, o.email AS owner_email, u.email AS purchaser_email,
               s.plan_key, s.provider, s.state, s.auto_renewing, s.acknowledged, s.started_at, s.current_period_end, s.grace_until,
               s.canceled_at, s.last_verified_at, s.latest_notification_type, s.google_product_id AS product_id,
               s.google_base_plan_id AS base_plan_id, s.billing_cycle, s.billing_type, s.price_cents,
               s.next_due_date::text AS next_due_date, s.created_at, s.updated_at
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
        provider: row.provider,
        state: row.state,
        autoRenewing: row.auto_renewing,
        acknowledged: row.acknowledged,
        billingCycle: row.billing_cycle,
        billingType: row.billing_type,
        priceCents: row.price_cents,
        nextDueDate: row.next_due_date,
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

    const isAsaas = s.provider === 'asaas';

    // Eventos da assinatura: os já casados (`subscription_id`) e os que ainda
    // estão pendentes mas apontam para ela — pelo hash do comprovante no
    // Google, pelo id da assinatura no Asaas.
    const eventsWhere = s.purchaseTokenHash
      ? sql`(${subscriptionEvents.subscriptionId} = ${subscriptionId} OR ${subscriptionEvents.purchaseTokenHash} = ${s.purchaseTokenHash})`
      : isAsaas && s.providerSubscriptionId
        ? sql`(${subscriptionEvents.subscriptionId} = ${subscriptionId}
               OR (${subscriptionEvents.provider} = 'asaas' AND ${subscriptionEvents.providerSubscriptionId} = ${s.providerSubscriptionId}))`
        : eq(subscriptionEvents.subscriptionId, subscriptionId);

    const [events, audit, superseded, customerRows, paymentRows] = await Promise.all([
      this.db
        .select({
          id: subscriptionEvents.id,
          provider: subscriptionEvents.provider,
          eventType: subscriptionEvents.eventType,
          attempts: subscriptionEvents.attempts,
          notificationId: subscriptionEvents.notificationId,
          notificationType: subscriptionEvents.notificationType,
          hasToken: sql<boolean>`${subscriptionEvents.purchaseTokenEnc} IS NOT NULL`,
          receivedAt: subscriptionEvents.receivedAt,
          processedAt: subscriptionEvents.processedAt,
          processError: subscriptionEvents.processError,
        })
        .from(subscriptionEvents)
        .where(eventsWhere)
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
      // Pagador e cobranças só existem no Asaas; no Google ficam na Play.
      isAsaas
        ? this.db
            .select()
            .from(billingCustomers)
            .where(and(eq(billingCustomers.workspaceId, s.workspaceId), eq(billingCustomers.provider, 'asaas')))
            .limit(1)
        : Promise.resolve([]),
      isAsaas
        ? this.db
            .select()
            .from(billingPayments)
            .where(eq(billingPayments.subscriptionId, subscriptionId))
            .orderBy(desc(billingPayments.dueDate), desc(billingPayments.createdAt))
            .limit(120)
        : Promise.resolve([]),
    ]);
    const customer = customerRows[0];

    // `raw` é o que o provedor diz, sem tradução nossa — ajuda a diagnosticar.
    // No Google já é gravado sem tokens (scrubPurchasePayload); no Asaas sai
    // só a lista fechada de campos (asaasRawView).
    return {
      id: s.id,
      workspaceId: s.workspaceId,
      workspaceName: row.workspaceName,
      workspaceDeletedAt: iso(row.workspaceDeletedAt),
      purchaserUserId: s.purchaserUserId,
      purchaserEmail: row.purchaserEmail,
      purchaserName: row.purchaserName,
      planKey: s.planKey,
      provider: s.provider,
      state: s.state,
      autoRenewing: s.autoRenewing,
      acknowledged: s.acknowledged,
      startedAt: iso(s.startedAt),
      currentPeriodEnd: iso(s.currentPeriodEnd),
      graceUntil: iso(s.graceUntil),
      canceledAt: iso(s.canceledAt),
      cancelReason: s.cancelReason,
      // Só a assinatura viva pode ser reconsultada (ver `refresh`).
      refreshable: (LIVE_STATES as readonly string[]).includes(s.state),
      asaas: isAsaas
        ? {
            providerSubscriptionId: s.providerSubscriptionId,
            billingCycle: s.billingCycle,
            billingType: s.billingType,
            priceCents: s.priceCents,
            nextDueDate: s.nextDueDate,
            graceDays: this.services.env.ASAAS_GRACE_DAYS,
            environment: this.services.asaas.environment,
            customer: customer
              ? {
                  providerCustomerId: customer.providerCustomerId,
                  name: customer.name,
                  email: customer.email,
                  // Nunca o documento inteiro: a tabela só guarda o tipo e o final.
                  documentType: customer.documentType,
                  documentHint: customer.documentHint,
                  updatedAt: customer.updatedAt.toISOString(),
                }
              : null,
            payments: paymentRows.map((payment) => ({
              id: payment.id,
              providerPaymentId: payment.providerPaymentId,
              status: payment.status,
              billingType: payment.billingType,
              valueCents: payment.valueCents,
              netValueCents: payment.netValueCents,
              description: payment.description,
              dueDate: payment.dueDate,
              paidAt: iso(payment.paidAt),
              invoiceUrl: payment.invoiceUrl,
              receiptUrl: payment.receiptUrl,
              deleted: payment.deleted,
            })),
          }
        : null,
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
      raw: isAsaas ? asaasRawView(s.raw) : s.raw,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      events: events.map((event) => ({
        id: event.id,
        provider: event.provider,
        eventType: event.eventType,
        attempts: event.attempts,
        notificationId: event.notificationId,
        notificationType: event.notificationType,
        notificationLabel: event.notificationType !== null ? (RTDN_LABELS[event.notificationType] ?? null) : null,
        receivedAt: event.receivedAt.toISOString(),
        processedAt: iso(event.processedAt),
        processError: event.processError,
        retryable: event.processedAt === null && (event.provider === 'asaas' || event.hasToken),
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

  /**
   * Reconsulta o provedor (Google Play ou Asaas) para a assinatura viva da
   * empresa.
   *
   * `refreshWorkspaceSubscription` só revalida a assinatura viva e despacha
   * pelo provedor dela. Uma assinatura encerrada não é reconsultada: sem
   * esta recusa, o botão numa assinatura antiga revalidaria outra (a viva,
   * talvez de outro provedor) e responderia "continua expirada".
   */
  async refresh(actor: AdminActor, subscriptionId: string) {
    const rows = await this.db
      .select({ workspaceId: subscriptions.workspaceId, state: subscriptions.state, provider: subscriptions.provider })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    const sub = rows[0];
    if (!sub) throw notFound('Assinatura não encontrada.');
    if (!(LIVE_STATES as readonly string[]).includes(sub.state)) {
      throw conflict(ErrorCode.CONFLICT, 'Esta assinatura já foi encerrada; só a assinatura viva da empresa é reconsultada no provedor.');
    }
    if (sub.provider === 'asaas') {
      if (!this.services.asaas.configured) {
        throw badRequest(ErrorCode.BILLING_UNAVAILABLE, 'Asaas não configurado neste ambiente.');
      }
    } else if (!this.services.playClient.configured) {
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
      metadata: { workspaceId: sub.workspaceId, provider: sub.provider, from: before, to: after[0]?.state ?? before },
    });

    return { entitlement, provider: sub.provider, from: before, to: after[0]?.state ?? before };
  }

  // -------------------------------------------------------------------------
  // Notificações dos provedores (RTDN do Google, webhooks do Asaas)
  // -------------------------------------------------------------------------

  async events(query: PaginationQuery & { onlyPending?: boolean; onlyErrors?: boolean; provider?: SubscriptionProvider }) {
    const conditions = [sql`true`];
    if (query.onlyPending) conditions.push(sql`e.processed_at IS NULL`);
    if (query.onlyErrors) conditions.push(sql`e.process_error IS NOT NULL`);
    if (query.provider) conditions.push(sql`e.provider = ${query.provider}`);
    const where = sql.join(conditions, sql` AND `);

    const [rows, total] = await Promise.all([
      this.db.execute<{
        id: string; provider: string; event_type: string | null; attempts: number; retryable: boolean;
        notification_id: string; notification_type: number | null; subscription_id: string | null; matched_subscription_id: string | null;
        workspace_id: string | null; workspace_name: string | null; received_at: string; processed_at: string | null; process_error: string | null;
      }>(sql`
        SELECT e.id, e.provider, e.event_type, e.attempts, e.notification_id, e.notification_type, e.subscription_id,
               s.id AS matched_subscription_id, s.workspace_id, w.name AS workspace_name,
               e.received_at, e.processed_at, e.process_error,
               (e.processed_at IS NULL AND (e.provider = 'asaas' OR e.purchase_token_enc IS NOT NULL)) AS retryable
        FROM subscription_events e
        LEFT JOIN subscriptions s ON s.id = e.subscription_id
          OR (e.subscription_id IS NULL AND s.purchase_token_hash = e.purchase_token_hash)
          OR (e.subscription_id IS NULL AND e.provider = 'asaas' AND s.provider = 'asaas'
              AND s.provider_subscription_id = e.provider_subscription_id)
        LEFT JOIN workspaces w ON w.id = s.workspace_id
        WHERE ${where}
        ORDER BY e.received_at DESC LIMIT ${query.pageSize} OFFSET ${offsetOf(query)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM subscription_events e WHERE ${where}`),
    ]);

    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        eventType: row.event_type,
        attempts: row.attempts,
        retryable: row.retryable,
        notificationId: row.notification_id,
        notificationType: row.notification_type,
        notificationLabel: row.notification_type !== null ? (RTDN_LABELS[row.notification_type] ?? null) : null,
        subscriptionId: row.subscription_id ?? row.matched_subscription_id,
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

    // Asaas: o evento não carrega comprovante — reprocessar é reconsultar a
    // assinatura no provedor, pelo mesmo caminho do webhook e da reconciliação.
    if (event.provider === 'asaas') {
      if (!this.services.asaas.configured) {
        throw badRequest(ErrorCode.BILLING_UNAVAILABLE, 'Asaas não configurado neste ambiente.');
      }
      const result = await this.asaasBilling.retryEvent(eventId);
      const outcome: 'processed' | 'failed' = result.processed ? 'processed' : 'failed';
      await recordAdminAudit(this.db, {
        actor,
        action: AdminAction.SUBSCRIPTION_EVENT_RETRIED,
        targetType: 'subscription_event',
        targetId: eventId,
        metadata: { provider: 'asaas', eventType: event.eventType, outcome, error: result.error },
      });
      return { outcome, error: result.error };
    }

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
      metadata: { provider: 'google_play', outcome, error },
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
      this.db.execute<{ plan_key: string; total: number; google_play: number; asaas: number }>(sql`
        SELECT plan_key, count(*)::int AS total,
               count(*) FILTER (WHERE provider = 'google_play')::int AS google_play,
               count(*) FILTER (WHERE provider = 'asaas')::int AS asaas
        FROM subscriptions
        WHERE state IN ${sqlList(ENTITLED_STATES)} GROUP BY plan_key
      `),
    ]);
    const countByPlan = new Map(counts.rows.map((row) => [row.plan_key, row]));
    return planRows.map((plan) => ({
      key: plan.key,
      name: plan.name,
      description: plan.description,
      googleProductId: plan.googleProductId,
      googleBasePlanId: plan.googleBasePlanId,
      // Preço cobrado pelo Asaas na web; nulo = ciclo não vendido na web.
      webPriceMonthlyCents: plan.webPriceMonthlyCents,
      webPriceYearlyCents: plan.webPriceYearlyCents,
      // O checkout da web vende um plano só (WEB_PLAN_KEY).
      soldOnWeb: plan.key === WEB_PLAN_KEY,
      isActive: plan.isActive,
      activeSubscriptions: countByPlan.get(plan.key)?.total ?? 0,
      activeSubscriptionsByProvider: {
        google_play: countByPlan.get(plan.key)?.google_play ?? 0,
        asaas: countByPlan.get(plan.key)?.asaas ?? 0,
      },
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
    input: {
      name?: string;
      description?: string;
      isActive?: boolean;
      /** Centavos; `null` tira o ciclo da venda na web. */
      webPriceMonthlyCents?: number | null;
      webPriceYearlyCents?: number | null;
      reason: string;
    },
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

      // Preço da web: o checkout (Asaas) lê só o plano WEB_PLAN_KEY. Gravar
      // preço em outro plano seria configuração morta que parece valer.
      const touchesWebPrice = input.webPriceMonthlyCents !== undefined || input.webPriceYearlyCents !== undefined;
      if (touchesWebPrice && planKey !== WEB_PLAN_KEY) {
        const wantsPrice = (input.webPriceMonthlyCents ?? null) !== null || (input.webPriceYearlyCents ?? null) !== null;
        if (wantsPrice) {
          throw badRequest(ErrorCode.VALIDATION_FAILED, `Só o plano "${WEB_PLAN_KEY}" é vendido pela web; os demais não têm preço web.`);
        }
      }
      if (input.webPriceMonthlyCents !== undefined && input.webPriceMonthlyCents !== plan.webPriceMonthlyCents) {
        patch.webPriceMonthlyCents = input.webPriceMonthlyCents;
        changes['webPriceMonthlyCents'] = { from: plan.webPriceMonthlyCents, to: input.webPriceMonthlyCents };
      }
      if (input.webPriceYearlyCents !== undefined && input.webPriceYearlyCents !== plan.webPriceYearlyCents) {
        patch.webPriceYearlyCents = input.webPriceYearlyCents;
        changes['webPriceYearlyCents'] = { from: plan.webPriceYearlyCents, to: input.webPriceYearlyCents };
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
