import {
  bigserial,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
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

/**
 * Identidade de quem opera o painel administrativo.
 *
 * Tabela própria, e não uma flag em `users`: uma conta de cliente nunca deve
 * poder virar administrador por um bit trocado, e a sessão do painel tem
 * cookie, prazo e política de bloqueio próprios.
 */
export const platformAdmins = pgTable(
  'platform_admins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('support'),
    status: text('status').notNull().default('active'),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', tz),
    lastLoginAt: timestamp('last_login_at', tz),
    createdBy: uuid('created_by').references((): AnyPgColumn => platformAdmins.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('platform_admins_email_unique').on(sql`lower(${table.email})`)],
);

export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => platformAdmins.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', tz).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    revokedAt: timestamp('revoked_at', tz),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    index('admin_sessions_admin_idx').on(table.adminId).where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    adminId: uuid('admin_id').references(() => platformAdmins.id, { onDelete: 'set null' }),
    adminEmail: text('admin_email').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').notNull().default({}),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (table) => [
    index('admin_audit_log_time_idx').on(table.createdAt.desc()),
    index('admin_audit_log_admin_idx').on(table.adminId, table.createdAt.desc()),
    index('admin_audit_log_target_idx').on(table.targetType, table.targetId, table.createdAt.desc()),
    index('admin_audit_log_action_idx').on(table.action, table.createdAt.desc()),
  ],
);

export const adminAccountNotes = pgTable(
  'admin_account_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    adminId: uuid('admin_id').references(() => platformAdmins.id, { onDelete: 'set null' }),
    adminEmail: text('admin_email').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (table) => [
    index('admin_account_notes_user_idx').on(table.userId, table.createdAt.desc()),
    index('admin_account_notes_workspace_idx').on(table.workspaceId, table.createdAt.desc()),
  ],
);

export type PlatformAdmin = typeof platformAdmins.$inferSelect;
export type AdminSession = typeof adminSessions.$inferSelect;
export type AdminAuditEntry = typeof adminAuditLog.$inferSelect;
export type AdminAccountNote = typeof adminAccountNotes.$inferSelect;
