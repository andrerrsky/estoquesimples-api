import {
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { devices, users } from './auth.js';
import { workspaces } from './workspaces.js';

const tz = { withTimezone: true } as const;
/** Quatro casas cobrem unidades fracionárias sem sofrer arredondamento. */
const quantity = { precision: 14, scale: 4 } as const;

export const products = pgTable(
  'products',
  {
    /** Gerado no aparelho antes de existir conexão. */
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    description: text('description'),
    unitValue: numeric('unit_value', quantity).notNull().default('0'),
    /** Projeção do saldo; a verdade é a soma de `stockMovements`. */
    quantityCache: numeric('quantity_cache', quantity).notNull().default('0'),
    minStock: numeric('min_stock', quantity).notNull().default('0'),
    unit: text('unit'),
    category: text('category'),
    supplier: text('supplier'),
    location: text('location'),
    sku: text('sku'),
    barcode: text('barcode'),
    photoHash: text('photo_hash'),

    rev: integer('rev').notNull().default(0),
    changeSeq: bigint('change_seq', { mode: 'number' }).notNull(),

    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', tz),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    lastOpId: uuid('last_op_id'),
  },
  (table) => ({
    syncIdx: index('products_sync_idx').on(table.workspaceId, table.changeSeq),
    workspaceIdx: index('products_workspace_idx')
      .on(table.workspaceId)
      .where(sql`${table.deletedAt} IS NULL`),
    nomeUnicoIdx: uniqueIndex('products_nome_unico_idx')
      .on(table.workspaceId, sql`lower(${table.name})`)
      .where(sql`${table.deletedAt} IS NULL`),
    // Alvo das chaves estrangeiras compostas: é o que impede uma movimentação
    // de apontar para o produto de outra empresa.
    workspaceIdUnique: unique('products_workspace_id_unique').on(table.workspaceId, table.id),
  }),
);

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Nulo nas movimentações legadas cujo produto não existe mais. */
    productId: uuid('product_id'),
    productName: text('product_name'),

    type: text('type').notNull(),
    /** Com sinal: negativo reduz o saldo. */
    quantity: numeric('quantity', quantity).notNull(),
    note: text('note'),

    occurredAt: timestamp('occurred_at', tz).notNull(),
    recordedAt: timestamp('recorded_at', tz).notNull().defaultNow(),

    reversesMovementId: uuid('reverses_movement_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),

    changeSeq: bigint('change_seq', { mode: 'number' }).notNull(),
    opId: uuid('op_id'),
  },
  (table) => ({
    syncIdx: index('stock_movements_sync_idx').on(table.workspaceId, table.changeSeq),
    produtoIdx: index('stock_movements_produto_idx').on(
      table.workspaceId,
      table.productId,
      table.occurredAt.desc(),
    ),
    workspaceIdUnique: unique('stock_movements_workspace_id_unique').on(
      table.workspaceId,
      table.id,
    ),
    // Compostas por empresa: a checagem de integridade referencial ignora RLS,
    // então é a chave que precisa carregar o workspace.
    produtoFk: foreignKey({
      name: 'stock_movements_product_fk',
      columns: [table.workspaceId, table.productId],
      foreignColumns: [products.workspaceId, products.id],
    }).onDelete('set null'),
    reversesFk: foreignKey({
      name: 'stock_movements_reverses_fk',
      columns: [table.workspaceId, table.reversesMovementId],
      foreignColumns: [table.workspaceId, table.id],
    }).onDelete('set null'),
  }),
);

/**
 * Resultado de cada operação já processada.
 *
 * O que torna seguro o aparelho reenviar uma operação cuja resposta se perdeu:
 * a segunda chegada devolve o resultado guardado em vez de aplicar de novo.
 */
export const syncOperations = pgTable(
  'sync_operations',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    opId: uuid('op_id').notNull(),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    status: text('status').notNull(),
    result: jsonb('result').notNull().default({}),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.opId] }),
  }),
);

/**
 * O que não prevaleceu numa resolução de conflito.
 *
 * Guarda os três lados: o valor de partida, o que ficou e o que foi
 * descartado. Sem o valor de partida não dá para explicar por que a decisão
 * foi tomada; sem o descartado, o trabalho de alguém desaparece sem rastro.
 */
export const conflictLog = pgTable(
  'conflict_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    /** Nulo quando o conflito é do registro inteiro. */
    field: text('field'),

    kind: text('kind').notNull(),
    status: text('status').notNull(),

    baseValue: jsonb('base_value'),
    keptValue: jsonb('kept_value'),
    discardedValue: jsonb('discarded_value'),

    opId: uuid('op_id'),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),

    resolvedAt: timestamp('resolved_at', tz),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolution: text('resolution'),
  },
  (table) => ({
    pendentesIdx: index('conflict_log_pendentes_idx')
      .on(table.workspaceId, table.createdAt.desc())
      .where(sql`${table.status} = 'pendente'`),
    entidadeIdx: index('conflict_log_entidade_idx').on(
      table.workspaceId,
      table.entityType,
      table.entityId,
    ),
  }),
);

/**
 * Onde cada aparelho parou de ler.
 *
 * É a visão do servidor sobre um estado que pertence ao aparelho. Serve para
 * mostrar quem está atrasado e para limitar até onde a limpeza de lápides pode
 * avançar sem apagar exclusões que alguém ainda não leu.
 */
export const syncCursors = pgTable(
  'sync_cursors',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    cursor: bigint('cursor', { mode: 'number' }).notNull().default(0),
    lastPushAt: timestamp('last_push_at', tz),
    lastPullAt: timestamp('last_pull_at', tz),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.deviceId] }),
  }),
);

export const initialUploads = pgTable(
  'initial_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),

    declaredProducts: integer('declared_products').notNull(),
    declaredMovements: integer('declared_movements').notNull(),
    receivedProducts: integer('received_products').notNull().default(0),
    receivedMovements: integer('received_movements').notNull().default(0),

    status: text('status').notNull().default('em_andamento'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    completedAt: timestamp('completed_at', tz),
  },
  (table) => ({
    /** Uma sessão de envio aberta por empresa. */
    umaAbertaIdx: uniqueIndex('initial_uploads_uma_aberta_idx')
      .on(table.workspaceId)
      .where(sql`${table.status} = 'em_andamento'`),
    workspaceIdUnique: unique('initial_uploads_workspace_id_unique').on(
      table.workspaceId,
      table.id,
    ),
  }),
);

export const initialUploadBatches = pgTable(
  'initial_upload_batches',
  {
    uploadId: uuid('upload_id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    batchIndex: integer('batch_index').notNull(),
    products: integer('products').notNull().default(0),
    movements: integer('movements').notNull().default(0),
    processedAt: timestamp('processed_at', tz).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.uploadId, table.batchIndex] }),
    uploadFk: foreignKey({
      name: 'initial_upload_batches_upload_fk',
      columns: [table.workspaceId, table.uploadId],
      foreignColumns: [initialUploads.workspaceId, initialUploads.id],
    }).onDelete('cascade'),
  }),
);
