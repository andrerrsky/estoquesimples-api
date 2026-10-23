import { bigserial, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const tz = { withTimezone: true } as const;

/** Erros de produção de todas as pontas (ver migration 0020). */
export const errorEvents = pgTable(
  'error_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: timestamp('occurred_at', tz).notNull().defaultNow(),
    receivedAt: timestamp('received_at', tz).notNull().defaultNow(),
    source: text('source').$type<'api' | 'web' | 'android' | 'admin'>().notNull(),
    level: text('level').$type<'error' | 'warning' | 'fatal'>().notNull().default('error'),
    kind: text('kind').notNull(),
    fingerprint: text('fingerprint').notNull(),
    code: text('code'),
    message: text('message').notNull(),
    stack: text('stack'),
    httpMethod: text('http_method'),
    route: text('route'),
    status: integer('status'),
    correlationId: text('correlation_id'),
    userId: uuid('user_id'),
    workspaceId: uuid('workspace_id'),
    deviceId: uuid('device_id'),
    appVersion: text('app_version'),
    platform: text('platform'),
    userAgent: text('user_agent'),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    index('error_events_fingerprint_idx').on(table.fingerprint, table.occurredAt),
    index('error_events_occurred_idx').on(table.occurredAt),
  ],
);
