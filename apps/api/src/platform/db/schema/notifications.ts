import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from './auth.js';
import { workspaces } from './workspaces.js';

const tz = { withTimezone: true } as const;

/** Caixa de notificações do usuário (canal comum a Android e web). */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    data: jsonb('data').notNull().default({}),
    dedupeKey: text('dedupe_key'),
    readAt: timestamp('read_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (table) => [index('notifications_user_idx').on(table.userId, table.createdAt.desc())],
);

export type NotificationRow = typeof notifications.$inferSelect;
