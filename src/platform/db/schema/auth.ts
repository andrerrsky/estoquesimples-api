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

const tz = { withTimezone: true } as const;

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', tz),
    permissionVersion: integer('permission_version').notNull().default(1),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', tz),
    status: text('status').notNull().default('active'),
    deletionRequestedAt: timestamp('deletion_requested_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', tz),
  },
  (table) => [
    // Unicidade case-insensitive e apenas entre contas vivas. Declarar o índice
    // como se fosse sobre `email` faria qualquer ON CONFLICT (email) apontar
    // para um índice que não existe no banco.
    uniqueIndex('users_email_unique')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    installId: text('install_id').notNull(),
    platform: text('platform').notNull().default('android'),
    model: text('model'),
    osVersion: text('os_version'),
    appVersionCode: integer('app_version_code'),
    appVersionName: text('app_version_name'),
    syncProtocolVersion: integer('sync_protocol_version'),
    lastSeenAt: timestamp('last_seen_at', tz).notNull().defaultNow(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', tz),
  },
  (table) => [uniqueIndex('devices_user_install_unique').on(table.userId, table.installId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    userAgent: text('user_agent'),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', tz).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    revokedAt: timestamp('revoked_at', tz),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId).where(sql`${table.revokedAt} IS NULL`),
    index('sessions_expires_idx').on(table.expiresAt).where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    usedAt: timestamp('used_at', tz),
    replacedBy: uuid('replaced_by').references((): AnyPgColumn => refreshTokens.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('refresh_tokens_session_idx').on(table.sessionId),
    index('refresh_tokens_expires_idx').on(table.expiresAt),
  ],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    usedAt: timestamp('used_at', tz),
    requestedIp: inet('requested_ip'),
  },
  (table) => [index('password_reset_tokens_user_idx').on(table.userId)],
);

export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    usedAt: timestamp('used_at', tz),
  },
  (table) => [index('email_verification_tokens_user_idx').on(table.userId)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: uuid('workspace_id'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorDeviceId: uuid('actor_device_id').references(() => devices.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    metadata: jsonb('metadata').notNull().default({}),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_workspace_idx').on(table.workspaceId, table.createdAt.desc()),
    index('audit_log_actor_idx').on(table.actorUserId, table.createdAt.desc()),
    index('audit_log_action_idx').on(table.action, table.createdAt.desc()),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    uniqueKey: text('unique_key'),
    runAt: timestamp('run_at', tz).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lockedAt: timestamp('locked_at', tz),
    lockedBy: text('locked_by'),
    completedAt: timestamp('completed_at', tz),
    failedAt: timestamp('failed_at', tz),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (table) => [
    // Parcial e único: é ele que faz `enqueueJob` com `uniqueKey` virar um
    // no-op quando a mesma tarefa já está na fila.
    uniqueIndex('jobs_unique_key_idx')
      .on(table.uniqueKey)
      .where(sql`${table.uniqueKey} IS NOT NULL AND ${table.completedAt} IS NULL`),
    index('jobs_pending_idx')
      .on(table.runAt)
      .where(sql`${table.completedAt} IS NULL AND ${table.failedAt} IS NULL`),
  ],
);

export const appConfig = pgTable('app_config', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type Job = typeof jobs.$inferSelect;
