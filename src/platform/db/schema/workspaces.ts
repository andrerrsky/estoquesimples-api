import {
  bigint,
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
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { users } from './auth.js';

const tz = { withTimezone: true } as const;

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Contador monotônico por tenant. Base do cursor de sincronização. */
    changeSeq: bigint('change_seq', { mode: 'number' }).notNull().default(0),
    settings: jsonb('settings').notNull().default({}),
    /**
     * Momento em que a empresa recebeu a carga inicial de um aparelho.
     *
     * Preenchido, impede que um segundo aparelho envie o próprio banco por
     * cima — ele precisa baixar o que já existe.
     */
    seededAt: timestamp('seeded_at', tz),
    /**
     * Até onde a limpeza de lápides já passou. Cursor abaixo disso não pode
     * ser atendido de forma incremental sem esconder exclusões.
     */
    tombstoneHorizonSeq: bigint('tombstone_horizon_seq', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', tz),
  },
  (table) => [
    index('workspaces_owner_fk_idx').on(table.ownerUserId),
    // Uma empresa por nome para cada dono, ignorando as já excluídas. É este
    // índice — e não a checagem prévia do serviço — que impede dois toques
    // simultâneos criarem duas empresas iguais.
    uniqueIndex('workspaces_owner_nome_unico_idx')
      .on(table.ownerUserId, sql`lower(${table.name})`)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const roles = pgTable('roles', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  rank: integer('rank').notNull(),
  isSystem: boolean('is_system').notNull().default(true),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});

export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  category: text('category').notNull(),
  description: text('description').notNull().default(''),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleKey: text('role_key')
      .notNull()
      .references(() => roles.key, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.roleKey, table.permissionKey] })],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleKey: text('role_key')
      .notNull()
      .references(() => roles.key, { onDelete: 'restrict' }),
    status: text('status').notNull().default('active'),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    joinedAt: timestamp('joined_at', tz).notNull().defaultNow(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    removedAt: timestamp('removed_at', tz),
  },
  (table) => [
    uniqueIndex('workspace_members_unique').on(table.workspaceId, table.userId),
    index('workspace_members_user_idx')
      .on(table.userId)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    roleKey: text('role_key')
      .notNull()
      .references(() => roles.key, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', tz).notNull(),
    acceptedAt: timestamp('accepted_at', tz),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    cancelledAt: timestamp('cancelled_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (table) => [
    index('invites_workspace_idx').on(table.workspaceId, table.createdAt.desc()),
    // No máximo um convite aberto por e-mail em cada empresa: reenviar
    // substitui o anterior em vez de deixar dois links válidos.
    uniqueIndex('invites_pending_unique')
      .on(table.workspaceId, sql`lower(${table.email})`)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.cancelledAt} IS NULL`),
  ],
);

export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type Role = typeof roles.$inferSelect;
