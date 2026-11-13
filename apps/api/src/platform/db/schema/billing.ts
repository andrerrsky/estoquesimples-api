import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { users } from './auth.js';
import { workspaces } from './workspaces.js';

const tz = { withTimezone: true } as const;

export const plans = pgTable('plans', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  googleProductId: text('google_product_id'),
  googleBasePlanId: text('google_base_plan_id'),
  /** Preço da venda na web (Asaas), em centavos. Nulo = ciclo não vendido. */
  webPriceMonthlyCents: integer('web_price_monthly_cents'),
  /** Total cobrado a cada 6 meses. */
  webPriceSemiannualCents: integer('web_price_semiannual_cents'),
  /** Total cobrado uma vez por ano (não o equivalente mensal). */
  webPriceYearlyCents: integer('web_price_yearly_cents'),
  /**
   * Oferta de entrada do Google Play (preço por mês e quantos meses), só para
   * o relatório financeiro estimar o que cada assinatura do app paga: o
   * Google não informa o valor da oferta na assinatura.
   */
  googleOfferPriceCents: integer('google_offer_price_cents'),
  googleOfferCycles: integer('google_offer_cycles'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
});

export const planFeatures = pgTable(
  'plan_features',
  {
    planKey: text('plan_key')
      .notNull()
      .references(() => plans.key, { onDelete: 'cascade' }),
    featureKey: text('feature_key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** NULL significa ilimitado. */
    limitValue: integer('limit_value'),
  },
  (table) => [primaryKey({ columns: [table.planKey, table.featureKey] })],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    purchaserUserId: uuid('purchaser_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    planKey: text('plan_key')
      .notNull()
      .references(() => plans.key, { onDelete: 'restrict' }),
    /** `google_play` (app Android) ou `asaas` (web). */
    provider: text('provider').notNull().default('google_play'),
    providerSubscriptionId: text('provider_subscription_id'),
    providerCustomerId: text('provider_customer_id'),
    billingCycle: text('billing_cycle'),
    billingType: text('billing_type'),
    priceCents: integer('price_cents'),
    nextDueDate: date('next_due_date'),
    /** SHA-256 hex do purchase token (unicidade e lookup). Só Google. */
    purchaseTokenHash: text('purchase_token_hash').unique(),
    /** AES-256-GCM do purchase token (`v1:…`) ou legado `v0:…`. Só Google. */
    purchaseTokenEnc: text('purchase_token_enc'),
    googleProductId: text('google_product_id'),
    googleBasePlanId: text('google_base_plan_id'),
    googleOfferId: text('google_offer_id'),
    state: text('state').notNull(),
    autoRenewing: boolean('auto_renewing').notNull().default(false),
    acknowledged: boolean('acknowledged').notNull().default(false),
    startedAt: timestamp('started_at', tz),
    currentPeriodEnd: timestamp('current_period_end', tz),
    graceUntil: timestamp('grace_until', tz),
    canceledAt: timestamp('canceled_at', tz),
    cancelReason: text('cancel_reason'),
    linkedPurchaseTokenHash: text('linked_purchase_token_hash'),
    linkedPurchaseTokenEnc: text('linked_purchase_token_enc'),
    supersededBy: uuid('superseded_by').references((): AnyPgColumn => subscriptions.id, {
      onDelete: 'set null',
    }),
    latestNotificationType: integer('latest_notification_type'),
    /** Cupom aplicado na contratação pela web (migration 0036). */
    couponId: uuid('coupon_id').references((): AnyPgColumn => coupons.id, { onDelete: 'set null' }),
    /** Quando o valor no Asaas voltou ao preço cheio depois dos ciclos promocionais. */
    promoRestoredAt: timestamp('promo_restored_at', tz),
    lastVerifiedAt: timestamp('last_verified_at', tz).notNull().defaultNow(),
    raw: jsonb('raw').notNull().default({}),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (table) => [
    index('subscriptions_workspace_idx').on(table.workspaceId, table.createdAt.desc()),
    uniqueIndex('subscriptions_one_live_per_workspace')
      .on(table.workspaceId)
      .where(
        sql`${table.state} IN ('pendente', 'ativa', 'carencia', 'suspensa', 'cancelada_mas_ativa')`,
      ),
    index('subscriptions_linked_token_hash_idx')
      .on(table.linkedPurchaseTokenHash)
      .where(sql`${table.linkedPurchaseTokenHash} IS NOT NULL`),
    index('subscriptions_reconcile_idx')
      .on(table.lastVerifiedAt)
      .where(
        sql`${table.state} IN ('pendente', 'ativa', 'carencia', 'suspensa', 'cancelada_mas_ativa')`,
      ),
  ],
);

export const subscriptionEvents = pgTable(
  'subscription_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    notificationId: text('notification_id').notNull().unique(),
    provider: text('provider').notNull().default('google_play'),
    /** Nome do evento do provedor (Asaas: PAYMENT_RECEIVED…). */
    eventType: text('event_type'),
    providerSubscriptionId: text('provider_subscription_id'),
    attempts: integer('attempts').notNull().default(0),
    notificationType: integer('notification_type'),
    purchaseTokenHash: text('purchase_token_hash'),
    purchaseTokenEnc: text('purchase_token_enc'),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    payload: jsonb('payload').notNull().default({}),
    receivedAt: timestamp('received_at', tz).notNull().defaultNow(),
    processedAt: timestamp('processed_at', tz),
    processError: text('process_error'),
  },
  (table) => [
    index('subscription_events_token_hash_idx').on(
      table.purchaseTokenHash,
      table.receivedAt.desc(),
    ),
    index('subscription_events_pending_idx')
      .on(table.receivedAt)
      .where(sql`${table.processedAt} IS NULL`),
  ],
);

export const billingCustomers = pgTable('billing_customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('asaas'),
  providerCustomerId: text('provider_customer_id').notNull(),
  name: text('name').notNull(),
  email: text('email'),
  documentType: text('document_type').notNull(),
  /** Só o final do documento, para a pessoa reconhecer o cadastro. */
  documentHint: text('document_hint').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
});

export const billingPayments = pgTable(
  'billing_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull().default('asaas'),
    providerPaymentId: text('provider_payment_id').notNull(),
    status: text('status').notNull(),
    billingType: text('billing_type'),
    valueCents: integer('value_cents').notNull(),
    netValueCents: integer('net_value_cents'),
    description: text('description'),
    dueDate: date('due_date'),
    paidAt: timestamp('paid_at', tz),
    invoiceUrl: text('invoice_url'),
    receiptUrl: text('receipt_url'),
    deleted: boolean('deleted').notNull().default(false),
    raw: jsonb('raw').notNull().default({}),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (table) => [
    index('billing_payments_workspace_idx').on(table.workspaceId, table.dueDate.desc()),
    index('billing_payments_subscription_idx').on(table.subscriptionId, table.dueDate.desc()),
  ],
);

/** Cupom promocional da web (migration 0036). Preço cheio vem sempre de `plans`. */
export const coupons = pgTable(
  'coupons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    startsAt: timestamp('starts_at', tz).notNull(),
    /** Inclusivo (23:59:59 do último dia). */
    endsAt: timestamp('ends_at', tz).notNull(),
    active: boolean('active').notNull().default(true),
    yearlyPriceCents: integer('yearly_price_cents'),
    monthlyFirstCents: integer('monthly_first_cents'),
    monthlyPromoCycles: integer('monthly_promo_cycles').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('coupons_code_unique').on(table.code)],
);

/** Uso de um cupom: `reservado` no checkout, `resgatado` com a 1ª cobrança paga. */
export const couponRedemptions = pgTable(
  'coupon_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    couponId: uuid('coupon_id')
      .notNull()
      .references(() => coupons.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, { onDelete: 'set null' }),
    /** SHA-256 hex do CPF/CNPJ só com dígitos. */
    documentHash: text('document_hash').notNull(),
    state: text('state').notNull().default('reservado'),
    cycle: text('cycle').notNull(),
    valueCents: integer('value_cents').notNull(),
    redeemedAt: timestamp('redeemed_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('coupon_redemptions_one_per_workspace')
      .on(table.couponId, table.workspaceId)
      .where(sql`${table.state} = 'resgatado'`),
    uniqueIndex('coupon_redemptions_one_per_document')
      .on(table.couponId, table.documentHash)
      .where(sql`${table.state} = 'resgatado'`),
    uniqueIndex('coupon_redemptions_subscription_unique')
      .on(table.subscriptionId)
      .where(sql`${table.subscriptionId} IS NOT NULL`),
  ],
);

/**
 * Dias de cortesia dados pelo suporte (migration 0038).
 *
 * Cada concessão é uma linha com início e fim já calculados: a cortesia
 * começa onde o acesso garantido termina, então conceder duas vezes soma de
 * verdade. A assinatura não é tocada — ela é espelho do provedor.
 */
export const courtesyGrants = pgTable(
  'courtesy_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    planKey: text('plan_key')
      .notNull()
      .references(() => plans.key, { onDelete: 'restrict' }),
    days: integer('days').notNull(),
    startsAt: timestamp('starts_at', tz).notNull(),
    endsAt: timestamp('ends_at', tz).notNull(),
    reason: text('reason'),
    grantedBy: uuid('granted_by'),
    revokedAt: timestamp('revoked_at', tz),
    revokedBy: uuid('revoked_by'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (table) => [
    index('courtesy_grants_vigentes_idx')
      .on(table.workspaceId, table.endsAt.desc())
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export type CourtesyGrant = typeof courtesyGrants.$inferSelect;
export type Coupon = typeof coupons.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type BillingPayment = typeof billingPayments.$inferSelect;
export type Plan = typeof plans.$inferSelect;
