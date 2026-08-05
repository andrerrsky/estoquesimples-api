import {
  boolean,
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
    /** SHA-256 hex do purchase token (unicidade e lookup). */
    purchaseTokenHash: text('purchase_token_hash').notNull().unique(),
    /** AES-256-GCM do purchase token (`v1:…`) ou legado `v0:…`. */
    purchaseTokenEnc: text('purchase_token_enc').notNull(),
    googleProductId: text('google_product_id').notNull(),
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

export type Subscription = typeof subscriptions.$inferSelect;
export type Plan = typeof plans.$inferSelect;
