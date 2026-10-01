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
  webPriceYearlyCents: integer('web_price_yearly_cents'),
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

export type Subscription = typeof subscriptions.$inferSelect;
export type BillingPayment = typeof billingPayments.$inferSelect;
export type Plan = typeof plans.$inferSelect;
