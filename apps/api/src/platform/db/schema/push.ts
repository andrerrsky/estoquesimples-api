import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { platformAdmins } from './admin.js';
import { devices, users } from './auth.js';

const tz = { withTimezone: true } as const;

export const pushTokens = pgTable(
  'push_tokens',
  {
    token: text('token').primaryKey(),
    installId: text('install_id').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    platform: text('platform').notNull().default('android'),
    appVersionCode: integer('app_version_code'),
    locale: text('locale'),
    notificationsEnabled: boolean('notifications_enabled'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', tz).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', tz),
    revokeReason: text('revoke_reason'),
  },
  (table) => [
    index('push_tokens_install_idx').on(table.installId),
    index('push_tokens_user_idx').on(table.userId).where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const pushCampaigns = pgTable('push_campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  action: jsonb('action').notNull().default({}),
  audience: jsonb('audience').notNull(),
  audienceLabel: text('audience_label').notNull().default(''),
  status: text('status').notNull().default('draft'),
  isTest: boolean('is_test').notNull().default(false),
  targeted: integer('targeted').notNull().default(0),
  accepted: integer('accepted').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  delivered: integer('delivered').notNull().default(0),
  opened: integer('opened').notNull().default(0),
  /** Usuários que receberam a campanha na caixa de notificações. */
  inboxCount: integer('inbox_count').notNull().default(0),
  error: text('error'),
  createdBy: uuid('created_by').references(() => platformAdmins.id, { onDelete: 'set null' }),
  createdByEmail: text('created_by_email').notNull(),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  startedAt: timestamp('started_at', tz),
  completedAt: timestamp('completed_at', tz),
});

export const pushDeliveries = pgTable(
  'push_deliveries',
  {
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => pushCampaigns.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    installId: text('install_id').notNull(),
    userId: uuid('user_id'),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    acceptedAt: timestamp('accepted_at', tz),
    deliveredAt: timestamp('delivered_at', tz),
    openedAt: timestamp('opened_at', tz),
  },
  (table) => [primaryKey({ columns: [table.campaignId, table.token] })],
);

export type PushCampaign = typeof pushCampaigns.$inferSelect;
export type PushToken = typeof pushTokens.$inferSelect;
