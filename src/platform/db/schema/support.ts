import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { platformAdmins } from './admin.js';
import { users } from './auth.js';
import { workspaces } from './workspaces.js';

const tz = { withTimezone: true } as const;

/** Solicitações de suporte abertas pelo app (com ou sem conta). */
export const supportTickets = pgTable(
  'support_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: integer('number').notNull().default(sql`nextval('support_tickets_number_seq')`),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    installId: text('install_id').notNull(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    contactEmail: text('contact_email'),
    contactName: text('contact_name'),
    category: text('category').notNull().default('question'),
    subject: text('subject').notNull(),
    status: text('status').notNull().default('open'),
    priority: text('priority').notNull().default('normal'),
    device: jsonb('device').notNull().default({}),
    diagnostics: jsonb('diagnostics').notNull().default({}),
    appVersionCode: integer('app_version_code'),
    assignedTo: uuid('assigned_to').references(() => platformAdmins.id, { onDelete: 'set null' }),
    assignedToEmail: text('assigned_to_email'),
    messageCount: integer('message_count').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', tz).notNull().defaultNow(),
    lastMessageBy: text('last_message_by').notNull().default('user'),
    firstResponseAt: timestamp('first_response_at', tz),
    resolvedAt: timestamp('resolved_at', tz),
    resolvedBy: text('resolved_by'),
    userSeenAt: timestamp('user_seen_at', tz),
    adminSeenAt: timestamp('admin_seen_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (table) => [
    index('support_tickets_queue_idx').on(table.status, table.lastMessageAt.desc()),
    index('support_tickets_user_idx').on(table.userId, table.lastMessageAt.desc()),
    index('support_tickets_install_idx').on(table.installId, table.lastMessageAt.desc()),
  ],
);

export const supportMessages = pgTable(
  'support_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    author: text('author').notNull(),
    adminId: uuid('admin_id').references(() => platformAdmins.id, { onDelete: 'set null' }),
    adminName: text('admin_name'),
    body: text('body').notNull(),
    internal: boolean('internal').notNull().default(false),
    notifyStatus: text('notify_status'),
    notifyDetail: text('notify_detail'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (table) => [index('support_messages_ticket_idx').on(table.ticketId, table.createdAt)],
);

export type SupportTicket = typeof supportTickets.$inferSelect;
export type SupportMessage = typeof supportMessages.$inferSelect;
