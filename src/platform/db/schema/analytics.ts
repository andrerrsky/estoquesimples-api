import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { devices, users } from './auth.js';
import { workspaces } from './workspaces.js';

const tz = { withTimezone: true } as const;

/**
 * Eventos de uso do produto, uma linha por evento.
 *
 * Sem pré-agregação: as métricas do painel são calculadas na leitura, o que
 * permite criar uma métrica nova amanhã e vê-la aplicada a todo o histórico.
 * A retenção é cuidada por um job (ANALYTICS_RETENTION_DAYS).
 */
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    /** Idempotência do lote enviado pelo app. */
    clientEventId: uuid('client_event_id').unique(),
    name: text('name').notNull(),
    occurredAt: timestamp('occurred_at', tz).notNull(),
    receivedAt: timestamp('received_at', tz).notNull().defaultNow(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    installId: text('install_id'),
    platform: text('platform').notNull().default('android'),
    appVersionCode: integer('app_version_code'),
    sessionKey: text('session_key'),
    source: text('source').notNull().default('app'),
    properties: jsonb('properties').notNull().default({}),
  },
  (table) => [
    index('analytics_events_time_idx').on(table.occurredAt.desc()),
    index('analytics_events_name_time_idx').on(table.name, table.occurredAt.desc()),
    index('analytics_events_user_idx')
      .on(table.userId, table.occurredAt.desc())
      .where(sql`${table.userId} IS NOT NULL`),
    index('analytics_events_workspace_idx')
      .on(table.workspaceId, table.occurredAt.desc())
      .where(sql`${table.workspaceId} IS NOT NULL`),
    index('analytics_events_install_idx')
      .on(table.installId, table.occurredAt.desc())
      .where(sql`${table.installId} IS NOT NULL`),
  ],
);

export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;
export type NewAnalyticsEvent = typeof analyticsEvents.$inferInsert;
