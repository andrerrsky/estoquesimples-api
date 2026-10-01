import { createHash, randomUUID } from 'node:crypto';

import { sql, type SQL } from 'drizzle-orm';

import type { Transaction } from '../../platform/db/client.js';
import { AppError, ErrorCode, conflict, notFound } from '../../platform/http/errors.js';
import { Feature, countLiveProducts, planLimitReached, productLimitMessage } from '../billing/plan-limits.js';
import { nextChangeSeq } from '../sync/change-seq.js';
import type { PlanContext } from '../sync/initial-upload.service.js';
import { SyncService } from '../sync/sync.service.js';
import type { OperationResult } from '../sync/sync.schemas.js';
import type {
  BulkBody,
  CreateMovementBody,
  CreateProductBody,
  ImportRow,
  ListMovementsQuery,
  ListProductsQuery,
  UpdateProductBody,
} from './inventory.schemas.js';
import { fractionMessage, hasFraction, isValidUnit, isWholeUnit } from './units.js';

/**
 * Quem está operando, já autorizado pela rota: empresa, usuário, permissões
 * do papel e o plano em vigor (teto de produtos).
 */
export interface InventoryContext {
  workspaceId: string;
  userId: string;
  permissions: ReadonlySet<string>;
  plan: PlanContext;
}

type Row = Record<string, unknown>;

interface Operation {
  opId: string;
  entity: 'produto' | 'movimentacao';
  op: 'upsert' | 'delete' | 'movement';
  entityId: string;
  baseRev?: number | null;
  payload: Record<string, unknown>;
}

const EDITABLE_FIELDS = ['name', 'description', 'unitValue', 'minStock', 'unit', 'category', 'supplier', 'location', 'sku', 'barcode'] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

const MOVEMENT_LABEL: Record<string, string> = {
  entrada: 'entrada',
  compra: 'entrada',
  saida: 'saída',
  venda: 'saída',
  ajuste: 'ajuste',
  edicao: 'ajuste',
  cadastro: 'cadastro',
  importacao: 'importação',
  cancelamento: 'estorno',
};

/** Estoque baixo: a mesma regra da lista e dos relatórios do app. */
const LOW_STOCK_SQL = sql`(p.quantity_cache <= 0 OR (p.min_stock > 0 AND p.quantity_cache <= p.min_stock))`;

/** Busca sem acento e sem caixa, como a do app. */
const FOLD_FROM = 'áàâãäåéèêëíìîïóòôõöúùûüçñ';
const FOLD_TO = 'aaaaaaeeeeiiiiooooouuuucn';
const fold = (column: SQL): SQL => sql`translate(lower(coalesce(${column}, '')), ${FOLD_FROM}, ${FOLD_TO})`;
const foldText = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const text = (value: unknown): string | null => (value === null || value === undefined || value === '' ? null : String(value));
const iso = (value: unknown): string | null => (value ? new Date(value as string).toISOString() : null);

/** UUID estável a partir de uma semente: repetir a requisição repete o id. */
function derivedUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function productView(row: Row) {
  const quantity = num(row['quantity_cache']);
  const minStock = num(row['min_stock']);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    description: text(row['description']),
    quantity,
    unitValue: num(row['unit_value']),
    minStock,
    unit: text(row['unit']),
    category: text(row['category']),
    supplier: text(row['supplier']),
    location: text(row['location']),
    sku: text(row['sku']),
    barcode: text(row['barcode']),
    rev: Number(row['rev']),
    lowStock: quantity <= 0 || (minStock > 0 && quantity <= minStock),
    outOfStock: quantity <= 0,
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  };
}

export type ProductView = ReturnType<typeof productView>;

function movementView(row: Row) {
  const quantity = num(row['quantity']);
  const type = String(row['type']);
  const occurredAt = new Date(row['occurred_at'] as string);
  const recordedAt = new Date(row['recorded_at'] as string);
  const reversed = row['reversed_by'] !== null && row['reversed_by'] !== undefined;
  return {
    id: row['id'] as string,
    productId: (row['product_id'] as string | null) ?? null,
    productName: text(row['current_name']) ?? text(row['product_name']) ?? '(produto removido)',
    productDeleted: row['product_id'] === null || row['product_deleted_at'] !== null,
    unit: text(row['unit']),
    type,
    quantity,
    note: text(row['note']),
    occurredAt: occurredAt.toISOString(),
    recordedAt: recordedAt.toISOString(),
    /** Lançada bem depois de acontecer (data retroativa). */
    lateEntry: recordedAt.getTime() - occurredAt.getTime() > 12 * 3_600_000,
    reversesMovementId: (row['reverses_movement_id'] as string | null) ?? null,
    reversedBy: (row['reversed_by'] as string | null) ?? null,
    balanceAfter: row['balance_after'] === null || row['balance_after'] === undefined ? null : num(row['balance_after']),
    createdByName: text(row['created_by_name']),
    canCancel: !reversed && type !== 'cancelamento' && row['product_id'] !== null && row['product_deleted_at'] === null,
  };
}

/**
 * Estoque para a aplicação web.
 *
 * Leitura: consultas diretas, paginadas, dentro do contexto da empresa (RLS).
 * Escrita: toda alteração vira uma operação do protocolo de sincronização e
 * passa por `SyncService.push` — as mesmas regras do app (mesclagem por
 * campo, conflitos, permissões por tipo de movimentação, teto do plano,
 * saldo derivado das movimentações) e a mesma sequência de alterações, de
 * modo que os aparelhos recebem pelo `pull` o que foi feito no navegador.
 * Não existe um segundo caminho de escrita para divergir do primeiro.
 */
export class InventoryService {
  private readonly sync = new SyncService();

  // -------------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------------

  async listProducts(tx: Transaction, workspaceId: string, query: ListProductsQuery) {
    const search: SQL[] = [sql`p.workspace_id = ${workspaceId}`, sql`p.deleted_at IS NULL`];
    if (query.q) {
      const term = `%${foldText(query.q)}%`;
      search.push(sql`(
        ${fold(sql`p.name`)} LIKE ${term} OR ${fold(sql`p.category`)} LIKE ${term} OR ${fold(sql`p.sku`)} LIKE ${term}
        OR ${fold(sql`p.barcode`)} LIKE ${term} OR ${fold(sql`p.location`)} LIKE ${term}
        OR ${fold(sql`p.description`)} LIKE ${term} OR ${fold(sql`p.supplier`)} LIKE ${term}
      )`);
    }
    if (query.category !== undefined) {
      search.push(query.category === '' ? sql`coalesce(p.category, '') = ''` : sql`p.category = ${query.category}`);
    }
    const base = sql.join(search, sql` AND `);
    const where = query.lowStock === 'true' ? sql`${base} AND ${LOW_STOCK_SQL}` : base;

    const direction = query.order === 'desc' ? sql`DESC` : sql`ASC`;
    const orderBy = {
      name: sql`${fold(sql`p.name`)} ${direction}`,
      quantity: sql`p.quantity_cache ${direction}, ${fold(sql`p.name`)} ASC`,
      value: sql`(p.quantity_cache * p.unit_value) ${direction}, ${fold(sql`p.name`)} ASC`,
      updated: sql`p.updated_at ${direction}`,
    }[query.sort];

    const [rows, counts] = await Promise.all([
      tx.execute<Row>(sql`
        SELECT p.* FROM products p WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}
      `),
      tx.execute<{ total: number; low: number }>(sql`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE ${LOW_STOCK_SQL})::int AS low
        FROM products p WHERE ${base}
      `),
    ]);
    const all = counts.rows[0]?.total ?? 0;
    const low = counts.rows[0]?.low ?? 0;
    return {
      items: rows.rows.map(productView),
      page: query.page,
      pageSize: query.pageSize,
      total: query.lowStock === 'true' ? low : all,
      counts: { all, lowStock: low },
    };
  }

  async getProduct(tx: Transaction, workspaceId: string, productId: string): Promise<ProductView> {
    const rows = await tx.execute<Row>(
      sql`SELECT p.* FROM products p WHERE p.workspace_id = ${workspaceId} AND p.id = ${productId} AND p.deleted_at IS NULL`,
    );
    const row = rows.rows[0];
    if (!row) throw notFound('Produto não encontrado.');
    return productView(row);
  }

  /** Valores já usados, para sugerir no formulário (categoria, fornecedor…). */
  async facets(tx: Transaction, workspaceId: string) {
    const distinct = async (column: SQL) =>
      (
        await tx.execute<{ value: string; count: number }>(sql`
          SELECT ${column} AS value, count(*)::int AS count FROM products p
          WHERE p.workspace_id = ${workspaceId} AND p.deleted_at IS NULL AND coalesce(${column}, '') <> ''
          GROUP BY 1 ORDER BY lower(${column}) LIMIT 300
        `)
      ).rows;
    const [categories, suppliers, units, locations, uncategorized] = await Promise.all([
      distinct(sql`p.category`),
      distinct(sql`p.supplier`),
      distinct(sql`p.unit`),
      distinct(sql`p.location`),
      tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM products p
        WHERE p.workspace_id = ${workspaceId} AND p.deleted_at IS NULL AND coalesce(p.category, '') = ''
      `),
    ]);
    return { categories, suppliers, units, locations, uncategorized: uncategorized.rows[0]?.count ?? 0 };
  }

  async listMovements(tx: Transaction, workspaceId: string, query: ListMovementsQuery) {
    const filters: SQL[] = [sql`true`];
    if (query.productId) filters.push(sql`m.product_id = ${query.productId}`);
    if (query.direction === 'in') filters.push(sql`m.quantity > 0`);
    if (query.direction === 'out') filters.push(sql`m.quantity < 0`);
    if (query.direction === 'adjust') filters.push(sql`m.type IN ('ajuste', 'edicao', 'cancelamento')`);
    if (query.from) filters.push(sql`m.occurred_at >= ${query.from}`);
    if (query.to) filters.push(sql`m.occurred_at <= ${query.to}`);
    if (query.q) {
      const term = `%${foldText(query.q)}%`;
      filters.push(sql`${fold(sql`coalesce(m.current_name, m.product_name)`)} LIKE ${term}`);
    }
    const where = sql.join(filters, sql` AND `);
    // "Estoque depois" é reconstruído de trás para frente a partir do saldo
    // atual, como no app: saldo − soma do que veio depois. A janela precisa
    // ver todas as movimentações do produto, por isso o filtro vem depois.
    const scope = query.productId
      ? sql`sm.workspace_id = ${workspaceId} AND sm.product_id = ${query.productId}`
      : sql`sm.workspace_id = ${workspaceId}`;
    const cte = sql`
      WITH m AS (
        SELECT sm.id, sm.product_id, sm.product_name, sm.type, sm.quantity, sm.note, sm.occurred_at, sm.recorded_at,
               sm.reverses_movement_id, sm.change_seq,
               p.name AS current_name, p.unit, p.deleted_at AS product_deleted_at,
               CASE WHEN sm.product_id IS NULL OR p.id IS NULL THEN NULL ELSE
                 p.quantity_cache - coalesce(sum(sm.quantity) OVER (
                   PARTITION BY sm.product_id ORDER BY sm.occurred_at DESC, sm.change_seq DESC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
               END AS balance_after,
               (SELECT r.id FROM stock_movements r
                 WHERE r.workspace_id = sm.workspace_id AND r.reverses_movement_id = sm.id LIMIT 1) AS reversed_by,
               u.name AS created_by_name
        FROM stock_movements sm
        LEFT JOIN products p ON p.workspace_id = sm.workspace_id AND p.id = sm.product_id
        LEFT JOIN users u ON u.id = sm.created_by
        WHERE ${scope}
      )`;
    const [rows, total] = await Promise.all([
      tx.execute<Row>(sql`
        ${cte} SELECT * FROM m WHERE ${where}
        ORDER BY m.occurred_at DESC, m.change_seq DESC
        LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}
      `),
      tx.execute<{ total: number }>(sql`${cte} SELECT count(*)::int AS total FROM m WHERE ${where}`),
    ]);
    return {
      items: rows.rows.map(movementView),
      page: query.page,
      pageSize: query.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  /** Números da tela inicial e dos relatórios. */
  async reportSummary(tx: Transaction, workspaceId: string, period: 'today' | '7d' | '30d' | '90d' | 'all') {
    const cutoff: SQL =
      period === 'today'
        ? sql`(date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`
        : period === 'all'
          ? sql`'-infinity'::timestamptz`
          : sql`now() - ${`${period === '7d' ? 7 : period === '30d' ? 30 : 90} days`}::interval`;
    const active = sql`p.workspace_id = ${workspaceId} AND p.deleted_at IS NULL`;

    const [totals, byUnit, topValue, lowStock, byCategory, movementTotals, daily] = await Promise.all([
      tx.execute<Row>(sql`
        SELECT count(*)::int AS products,
               coalesce(sum(p.quantity_cache * p.unit_value), 0) AS stock_value,
               count(*) FILTER (WHERE ${LOW_STOCK_SQL})::int AS to_restock,
               count(*) FILTER (WHERE p.quantity_cache <= 0)::int AS out_of_stock
        FROM products p WHERE ${active}
      `),
      tx.execute<Row>(sql`
        SELECT coalesce(nullif(p.unit, ''), 'un') AS unit, sum(p.quantity_cache) AS quantity
        FROM products p WHERE ${active} GROUP BY 1 ORDER BY 2 DESC LIMIT 12
      `),
      tx.execute<Row>(sql`
        SELECT p.id, p.name, p.quantity_cache, p.unit_value, p.unit, (p.quantity_cache * p.unit_value) AS total
        FROM products p WHERE ${active} AND p.quantity_cache * p.unit_value > 0
        ORDER BY total DESC LIMIT 10
      `),
      tx.execute<Row>(sql`
        SELECT p.id, p.name, p.quantity_cache, p.min_stock, p.unit, p.supplier, p.location
        FROM products p WHERE ${active} AND ${LOW_STOCK_SQL}
        ORDER BY CASE WHEN p.min_stock > 0 THEN p.quantity_cache / p.min_stock ELSE 0 END ASC, p.name
        LIMIT 200
      `),
      tx.execute<Row>(sql`
        SELECT coalesce(nullif(p.category, ''), '') AS category, count(*)::int AS products,
               sum(p.quantity_cache) AS quantity, sum(p.quantity_cache * p.unit_value) AS value
        FROM products p WHERE ${active} GROUP BY 1 ORDER BY products DESC, category LIMIT 200
      `),
      // Entradas e saídas "de verdade" (lançadas como tal); cadastros, ajustes
      // e estornos ficam à parte, como nos relatórios do app. O valor usa o
      // preço unitário atual do produto: é estimativa, não faturamento.
      tx.execute<Row>(sql`
        SELECT
          count(*) FILTER (WHERE m.type IN ('entrada','compra','saida','venda') AND m.quantity > 0)::int AS entries,
          coalesce(sum(m.quantity) FILTER (WHERE m.type IN ('entrada','compra','saida','venda') AND m.quantity > 0), 0) AS entries_quantity,
          coalesce(sum(m.quantity * coalesce(p.unit_value, 0)) FILTER (WHERE m.type IN ('entrada','compra','saida','venda') AND m.quantity > 0), 0) AS entries_value,
          count(*) FILTER (WHERE m.type IN ('entrada','compra','saida','venda') AND m.quantity < 0)::int AS exits,
          coalesce(sum(-m.quantity) FILTER (WHERE m.type IN ('entrada','compra','saida','venda') AND m.quantity < 0), 0) AS exits_quantity,
          coalesce(sum(-m.quantity * coalesce(p.unit_value, 0)) FILTER (WHERE m.type IN ('entrada','compra','saida','venda') AND m.quantity < 0), 0) AS exits_value,
          count(*) FILTER (WHERE m.type NOT IN ('entrada','compra','saida','venda'))::int AS others,
          coalesce(sum(m.quantity * coalesce(p.unit_value, 0)) FILTER (WHERE m.type NOT IN ('entrada','compra','saida','venda')), 0) AS others_value
        FROM stock_movements m
        LEFT JOIN products p ON p.workspace_id = m.workspace_id AND p.id = m.product_id
        WHERE m.workspace_id = ${workspaceId} AND m.occurred_at >= ${cutoff}
      `),
      tx.execute<Row>(sql`
        SELECT to_char(date_trunc('day', m.occurred_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS day,
               coalesce(sum(m.quantity) FILTER (WHERE m.quantity > 0), 0) AS entries,
               coalesce(sum(-m.quantity) FILTER (WHERE m.quantity < 0), 0) AS exits
        FROM stock_movements m
        WHERE m.workspace_id = ${workspaceId}
          AND m.occurred_at >= greatest(${cutoff}, now() - interval '90 days')
        GROUP BY 1 ORDER BY 1
      `),
    ]);

    const t = totals.rows[0] ?? {};
    const mv = movementTotals.rows[0] ?? {};
    return {
      period,
      products: num(t['products']),
      stockValue: num(t['stock_value']),
      toRestock: num(t['to_restock']),
      outOfStock: num(t['out_of_stock']),
      itemsByUnit: byUnit.rows.map((row) => ({ unit: String(row['unit']), quantity: num(row['quantity']) })),
      topValue: topValue.rows.map((row) => ({
        id: row['id'] as string,
        name: row['name'] as string,
        quantity: num(row['quantity_cache']),
        unitValue: num(row['unit_value']),
        unit: text(row['unit']),
        total: num(row['total']),
      })),
      lowStock: lowStock.rows.map((row) => ({
        id: row['id'] as string,
        name: row['name'] as string,
        quantity: num(row['quantity_cache']),
        minStock: num(row['min_stock']),
        unit: text(row['unit']),
        supplier: text(row['supplier']),
        location: text(row['location']),
      })),
      byCategory: byCategory.rows.map((row) => ({
        category: String(row['category'] ?? ''),
        products: num(row['products']),
        quantity: num(row['quantity']),
        value: num(row['value']),
      })),
      movements: {
        entries: { count: num(mv['entries']), quantity: num(mv['entries_quantity']), value: num(mv['entries_value']) },
        exits: { count: num(mv['exits']), quantity: num(mv['exits_quantity']), value: num(mv['exits_value']) },
        others: { count: num(mv['others']), value: num(mv['others_value']) },
      },
      daily: daily.rows.map((row) => ({ day: String(row['day']), entries: num(row['entries']), exits: num(row['exits']) })),
    };
  }

  /**
   * Análise Avançada: consumo médio, previsão de esgotamento e giro, nos
   * últimos 90 dias. Mesmas fórmulas do app (`AnalyticsActivity`).
   */
  async analysis(tx: Transaction, workspaceId: string) {
    const rows = await tx.execute<Row>(sql`
      SELECT p.id, p.name, p.quantity_cache, p.min_stock, p.unit,
             coalesce(sum(-m.quantity) FILTER (WHERE m.quantity < 0), 0) AS outflow,
             coalesce(sum(m.quantity) FILTER (WHERE m.quantity >= 0), 0) AS inflow,
             min(m.occurred_at) AS first_movement
      FROM products p
      JOIN stock_movements m ON m.workspace_id = p.workspace_id AND m.product_id = p.id
       AND m.occurred_at > now() - interval '90 days'
      WHERE p.workspace_id = ${workspaceId} AND p.deleted_at IS NULL
      GROUP BY p.id
    `);
    const analyzed = await countLiveProducts(tx, workspaceId);
    const now = Date.now();

    const items = rows.rows.map((row) => {
      const stock = num(row['quantity_cache']);
      const minStock = num(row['min_stock']);
      const outflow = num(row['outflow']);
      const days = Math.max(1, Math.floor((now - new Date(row['first_movement'] as string).getTime()) / 86_400_000));
      const avgDaily = outflow > 0 ? outflow / days : 0;
      const daysUntilStockOut = avgDaily > 0 ? stock / avgDaily : null;
      const turnover = stock > 0 ? outflow / stock : null;
      const speed = avgDaily >= 5 ? 'rapido' : avgDaily >= 1 ? 'medio' : avgDaily > 0 ? 'lento' : 'parado';
      const priority =
        daysUntilStockOut !== null && daysUntilStockOut > 0 && daysUntilStockOut <= 7
          ? 'urgente'
          : daysUntilStockOut !== null && daysUntilStockOut > 7 && daysUntilStockOut <= 15
            ? 'breve'
            : minStock > 0 && stock <= minStock
              ? 'atencao'
              : null;
      return {
        id: row['id'] as string,
        name: row['name'] as string,
        unit: text(row['unit']),
        stock,
        minStock,
        outflow,
        inflow: num(row['inflow']),
        days,
        avgDaily,
        daysUntilStockOut,
        stockOutDate: daysUntilStockOut !== null ? new Date(now + daysUntilStockOut * 86_400_000).toISOString() : null,
        turnover,
        speed,
        priority,
      };
    });

    return {
      windowDays: 90,
      summary: {
        analyzed,
        withMovement: items.length,
        urgent: items.filter((item) => item.priority === 'urgente').length,
        soon: items.filter((item) => item.priority === 'breve').length,
        attention: items.filter((item) => item.priority === 'atencao').length,
        fast: items.filter((item) => item.speed === 'rapido').length,
        slow: items.filter((item) => item.speed === 'lento' || item.speed === 'parado').length,
      },
      items: items.sort((a, b) => (a.daysUntilStockOut ?? Infinity) - (b.daysUntilStockOut ?? Infinity)),
    };
  }

  // -------------------------------------------------------------------------
  // Escrita
  // -------------------------------------------------------------------------

  /**
   * Antes da primeira gravação pela web, marca a empresa como semeada.
   *
   * Um aparelho que entrar depois precisa baixar o que existe (o app faz
   * isso quando recebe `SYNC_ALREADY_SEEDED`) em vez de fazer a carga inicial
   * dele por cima. Se há uma carga inicial em andamento, a web espera: gravar
   * no meio dela misturaria as duas origens.
   */
  private async ensureWritable(tx: Transaction, workspaceId: string): Promise<void> {
    const rows = await tx.execute<{ seeded_at: string | null }>(
      sql`SELECT seeded_at FROM workspaces WHERE id = ${workspaceId}`,
    );
    const workspace = rows.rows[0];
    if (!workspace) throw notFound('Empresa não encontrada.');
    if (workspace.seeded_at) return;

    const upload = await tx.execute(
      sql`SELECT 1 FROM initial_uploads WHERE workspace_id = ${workspaceId} AND status = 'em_andamento' LIMIT 1`,
    );
    if (upload.rows.length > 0) {
      throw conflict(
        ErrorCode.CONFLICT,
        'Um aparelho está enviando o estoque desta empresa para a nuvem. Tente de novo em instantes.',
      );
    }
    await tx.execute(sql`UPDATE workspaces SET seeded_at = now() WHERE id = ${workspaceId} AND seeded_at IS NULL`);
  }

  private async push(tx: Transaction, ctx: InventoryContext, operations: Operation[]): Promise<Map<string, OperationResult>> {
    await this.ensureWritable(tx, ctx.workspaceId);
    // Sem `deviceId`: o navegador não tem cursor de leitura, e um cursor
    // parado em zero impediria a limpeza de lápides da empresa.
    const { results } = await this.sync.push(tx, ctx.workspaceId, ctx.userId, null, ctx.permissions, { operations } as never, ctx.plan);
    return new Map(results.map((result) => [result.opId, result]));
  }

  /**
   * Transforma o resultado de uma operação em erro HTTP quando não foi
   * aplicada. O erro desfaz a transação da requisição inteira: na web, quem
   * edita está diante da tela e resolve o conflito na hora, então nada fica
   * gravado pela metade nem pendente em `conflict_log` (diferente do app, que
   * envia a fila depois e precisa guardar o conflito para decidir mais tarde).
   */
  private assertApplied(result: OperationResult | undefined): OperationResult {
    if (!result) throw new AppError(500, ErrorCode.INTERNAL, 'A alteração não foi processada.');
    if (result.status === 'aplicada' || result.status === 'duplicada') return result;
    if (result.status === 'conflito') {
      throw new AppError(409, ErrorCode.SYNC_CONFLICT, result.message ?? 'Este produto foi alterado por outra pessoa.', {
        extra: { server: result.server ?? null },
      });
    }
    const status =
      result.code === ErrorCode.MISSING_PERMISSION ? 403 : result.code === ErrorCode.NOT_FOUND ? 404 : result.code === ErrorCode.VALIDATION_FAILED ? 400 : 409;
    throw new AppError(status, (result.code as never) ?? ErrorCode.CONFLICT, result.message ?? 'A alteração não foi aceita.');
  }

  private async lockProduct(tx: Transaction, workspaceId: string, productId: string): Promise<Row> {
    const rows = await tx.execute<Row>(
      sql`SELECT * FROM products WHERE workspace_id = ${workspaceId} AND id = ${productId} FOR UPDATE`,
    );
    const row = rows.rows[0];
    if (!row || row['deleted_at'] !== null) throw notFound('Produto não encontrado.');
    return row;
  }

  private validateUnit(unit: string | null | undefined, quantity: number | null): void {
    if (!isValidUnit(unit)) {
      throw new AppError(400, ErrorCode.VALIDATION_FAILED, 'Escolha uma unidade da lista (un, kg, g, L, ml, caixa, pacote…).', {
        details: [{ field: 'unit', message: 'Unidade não reconhecida.' }],
      });
    }
    if (quantity !== null && isWholeUnit(unit) && hasFraction(quantity)) {
      throw new AppError(400, ErrorCode.VALIDATION_FAILED, fractionMessage(unit), {
        details: [{ field: 'quantity', message: fractionMessage(unit) }],
      });
    }
  }

  private productPayload(row: Row, overrides: Partial<Record<EditableField, unknown>> = {}): Record<string, unknown> {
    return {
      id: row['id'],
      name: overrides.name ?? row['name'],
      description: 'description' in overrides ? overrides.description : row['description'],
      quantity: num(row['quantity_cache']),
      unitValue: 'unitValue' in overrides ? overrides.unitValue : num(row['unit_value']),
      minStock: 'minStock' in overrides ? overrides.minStock : num(row['min_stock']),
      unit: 'unit' in overrides ? overrides.unit : row['unit'],
      category: 'category' in overrides ? overrides.category : row['category'],
      supplier: 'supplier' in overrides ? overrides.supplier : row['supplier'],
      location: 'location' in overrides ? overrides.location : row['location'],
      sku: 'sku' in overrides ? overrides.sku : row['sku'],
      barcode: 'barcode' in overrides ? overrides.barcode : row['barcode'],
      rev: Number(row['rev']),
      updatedAt: Date.now(),
    };
  }

  private currentValue(row: Row, field: EditableField): string | number | null {
    switch (field) {
      case 'unitValue':
        return num(row['unit_value']);
      case 'minStock':
        return num(row['min_stock']);
      default:
        return (row[field] as string | null) ?? null;
    }
  }

  async createProduct(tx: Transaction, ctx: InventoryContext, body: CreateProductBody): Promise<ProductView> {
    this.validateUnit(body.unit, body.quantity);
    const id = body.id ?? randomUUID();
    const unit = body.unit && body.unit !== '' ? body.unit : 'un';

    const upsert: Operation = {
      opId: derivedUuid(`web:create:${id}`),
      entity: 'produto',
      op: 'upsert',
      entityId: id,
      payload: {
        id,
        name: body.name,
        description: body.description || null,
        quantity: body.quantity,
        unitValue: body.unitValue,
        minStock: body.minStock,
        unit,
        category: body.category || null,
        supplier: body.supplier || null,
        location: body.location || null,
        sku: body.sku || null,
        barcode: body.barcode || null,
        rev: 0,
        updatedAt: Date.now(),
      },
    };
    const operations: Operation[] = [upsert];
    if (body.quantity !== 0) {
      const movementId = derivedUuid(`web:create:${id}:cadastro`);
      operations.push({
        opId: derivedUuid(`web:create:${id}:cadastro:op`),
        entity: 'movimentacao',
        op: 'movement',
        entityId: movementId,
        payload: { id: movementId, productId: id, productName: body.name, changeType: 'cadastro', quantity: body.quantity, occurredAt: Date.now() },
      });
    }

    const results = await this.push(tx, ctx, operations);
    for (const operation of operations) this.assertApplied(results.get(operation.opId));
    return this.getProduct(tx, ctx.workspaceId, id);
  }

  async updateProduct(tx: Transaction, ctx: InventoryContext, productId: string, body: UpdateProductBody): Promise<ProductView> {
    const current = await this.lockProduct(tx, ctx.workspaceId, productId);

    const changes: Partial<Record<EditableField, unknown>> = {};
    const previous: Record<string, string | number | null> = {};
    for (const field of EDITABLE_FIELDS) {
      if (!(field in body.changes)) continue;
      const raw = (body.changes as Record<string, unknown>)[field];
      const value = typeof raw === 'string' && raw.trim() === '' && field !== 'name' ? null : raw ?? null;
      changes[field] = value;
      // Ponto de partida informado pela tela; sem ele, o valor atual (o que
      // equivale a dizer "parti do que está no servidor").
      previous[field] = body.base && field in body.base ? (body.base[field] ?? null) : this.currentValue(current, field);
    }

    const unit = ('unit' in changes ? (changes.unit as string | null) : (current['unit'] as string | null)) ?? null;
    const targetQuantity = body.quantity ? body.quantity.target : null;
    this.validateUnit(unit, targetQuantity);

    const operations: Operation[] = [];
    if (Object.keys(changes).length > 0) {
      operations.push({
        opId: randomUUID(),
        entity: 'produto',
        op: 'upsert',
        entityId: productId,
        baseRev: body.rev,
        payload: { ...this.productPayload(current, changes), previous },
      });
    }
    if (targetQuantity !== null) {
      const delta = Math.round((targetQuantity - num(current['quantity_cache'])) * 10_000) / 10_000;
      if (delta !== 0) {
        const movementId = randomUUID();
        operations.push({
          opId: randomUUID(),
          entity: 'movimentacao',
          op: 'movement',
          entityId: movementId,
          payload: {
            id: movementId,
            productId,
            productName: (changes.name as string | undefined) ?? current['name'],
            changeType: 'edicao',
            quantity: delta,
            occurredAt: Date.now(),
            note: body.quantity?.note || null,
          },
        });
      }
    }
    if (operations.length === 0) return productView(current);

    const results = await this.push(tx, ctx, operations);
    for (const operation of operations) this.assertApplied(results.get(operation.opId));
    return this.getProduct(tx, ctx.workspaceId, productId);
  }

  async deleteProduct(tx: Transaction, ctx: InventoryContext, productId: string): Promise<void> {
    const current = await this.lockProduct(tx, ctx.workspaceId, productId);
    const operation: Operation = {
      opId: randomUUID(),
      entity: 'produto',
      op: 'delete',
      entityId: productId,
      payload: { id: productId, deletedAt: Date.now(), rev: Number(current['rev']) },
    };
    const results = await this.push(tx, ctx, [operation]);
    this.assertApplied(results.get(operation.opId));
  }

  /** Desfaz uma exclusão ("Desfazer" logo depois de excluir). */
  async restoreProduct(tx: Transaction, ctx: InventoryContext, productId: string): Promise<ProductView> {
    const rows = await tx.execute<Row>(
      sql`SELECT * FROM products WHERE workspace_id = ${ctx.workspaceId} AND id = ${productId} FOR UPDATE`,
    );
    const current = rows.rows[0];
    if (!current) throw notFound('Produto não encontrado.');
    if (current['deleted_at'] === null) return productView(current);

    if (ctx.plan.productLimit !== null) {
      const live = await countLiveProducts(tx, ctx.workspaceId);
      if (live + 1 > ctx.plan.productLimit) {
        throw planLimitReached({
          feature: Feature.PRODUCTS,
          limit: ctx.plan.productLimit,
          current: live + 1,
          planKey: ctx.plan.planKey,
          message: productLimitMessage(ctx.plan.productLimit, live + 1),
        });
      }
    }
    const taken = await tx.execute(sql`
      SELECT 1 FROM products WHERE workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL
        AND lower(name) = lower(${current['name'] as string}) LIMIT 1
    `);
    if (taken.rows.length > 0) {
      throw conflict(ErrorCode.DUPLICATE_NAME, 'Já existe um produto com este nome nesta empresa.');
    }
    await this.ensureWritable(tx, ctx.workspaceId);
    const seq = await nextChangeSeq(tx, ctx.workspaceId);
    await tx.execute(sql`
      UPDATE products SET deleted_at = NULL, deleted_by = NULL, rev = rev + 1, change_seq = ${seq}
      WHERE workspace_id = ${ctx.workspaceId} AND id = ${productId}
    `);
    return this.getProduct(tx, ctx.workspaceId, productId);
  }

  async createMovement(tx: Transaction, ctx: InventoryContext, body: CreateMovementBody) {
    const product = await this.lockProduct(tx, ctx.workspaceId, body.productId);
    const unit = (product['unit'] as string | null) ?? null;
    const balance = num(product['quantity_cache']);

    if (isWholeUnit(unit) && hasFraction(balance)) {
      throw new AppError(409, ErrorCode.CONFLICT, 'Este produto está com quantidade quebrada. Corrija a quantidade antes de movimentar.');
    }
    this.validateUnit(unit, body.quantity);

    const signed = body.type === 'saida' ? -body.quantity : body.quantity;
    if (balance + signed < 0) {
      throw new AppError(409, ErrorCode.CONFLICT, 'Quantidade insuficiente em estoque.', {
        extra: { available: balance },
      });
    }

    const now = Date.now();
    const occurredAt = body.occurredAt ? Math.min(body.occurredAt.getTime(), now) : now;
    const movementId = body.id ?? randomUUID();
    const operation: Operation = {
      opId: body.id ? derivedUuid(`web:movement:${body.id}`) : randomUUID(),
      entity: 'movimentacao',
      op: 'movement',
      entityId: movementId,
      payload: {
        id: movementId,
        productId: body.productId,
        productName: product['name'],
        changeType: body.type,
        quantity: signed,
        occurredAt,
        note: body.note || null,
      },
    };
    const results = await this.push(tx, ctx, [operation]);
    this.assertApplied(results.get(operation.opId));
    return { movementId, product: await this.getProduct(tx, ctx.workspaceId, body.productId) };
  }

  /**
   * Estorno: grava a movimentação oposta, ligada à original. A original
   * permanece no histórico — apagá-la faria o saldo deixar de ser explicável.
   */
  async cancelMovement(tx: Transaction, ctx: InventoryContext, movementId: string, note?: string) {
    const rows = await tx.execute<Row>(
      sql`SELECT * FROM stock_movements WHERE workspace_id = ${ctx.workspaceId} AND id = ${movementId}`,
    );
    const original = rows.rows[0];
    if (!original) throw notFound('Movimentação não encontrada.');
    if (original['type'] === 'cancelamento') {
      throw new AppError(409, ErrorCode.CONFLICT, 'Um estorno não pode ser estornado.');
    }
    if (!original['product_id']) {
      throw new AppError(409, ErrorCode.CONFLICT, 'Movimentação sem produto vinculado.');
    }
    const product = await this.lockProduct(tx, ctx.workspaceId, original['product_id'] as string);
    // Depois do lock do produto: dois estornos simultâneos da mesma
    // movimentação ficam em fila aqui e o segundo vê o primeiro.
    const already = await tx.execute(
      sql`SELECT 1 FROM stock_movements WHERE workspace_id = ${ctx.workspaceId} AND reverses_movement_id = ${movementId} LIMIT 1`,
    );
    if (already.rows.length > 0) {
      throw new AppError(409, ErrorCode.CONFLICT, 'Esta movimentação já foi cancelada.');
    }

    const reversal = -num(original['quantity']);
    if (num(product['quantity_cache']) + reversal < 0) {
      throw new AppError(409, ErrorCode.CONFLICT, 'O cancelamento deixaria o estoque negativo.');
    }

    const id = derivedUuid(`web:cancel:${movementId}`);
    const operation: Operation = {
      opId: derivedUuid(`web:cancel:${movementId}:op`),
      entity: 'movimentacao',
      op: 'movement',
      entityId: id,
      payload: {
        id,
        productId: original['product_id'],
        productName: product['name'],
        changeType: 'cancelamento',
        quantity: reversal,
        occurredAt: Date.now(),
        note: note || `Estorno de ${MOVEMENT_LABEL[String(original['type'])] ?? 'movimentação'}`,
        reversesMovementId: movementId,
      },
    };
    const results = await this.push(tx, ctx, [operation]);
    this.assertApplied(results.get(operation.opId));
    return { movementId: id, product: await this.getProduct(tx, ctx.workspaceId, original['product_id'] as string) };
  }

  /** Edição em massa: ajuste de quantidade, categoria ou fornecedor. */
  async bulk(tx: Transaction, ctx: InventoryContext, body: BulkBody) {
    const ids = [...new Set(body.productIds)];
    const operations: Operation[] = [];
    const movementIds: string[] = [];
    const stamp = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .format(new Date())
      .replace(',', '');

    for (const productId of ids) {
      const product = await this.lockProduct(tx, ctx.workspaceId, productId);
      if (body.action.type === 'adjust') {
        const current = num(product['quantity_cache']);
        // Não deixa o saldo negativo: subtrair mais do que há zera o produto.
        const target = Math.max(0, current + body.action.delta);
        const delta = Math.round((target - current) * 10_000) / 10_000;
        if (delta === 0) continue;
        const movementId = randomUUID();
        movementIds.push(movementId);
        const sign = body.action.delta > 0 ? '+' : '';
        operations.push({
          opId: randomUUID(),
          entity: 'movimentacao',
          op: 'movement',
          entityId: movementId,
          payload: {
            id: movementId,
            productId,
            productName: product['name'],
            changeType: 'ajuste',
            quantity: delta,
            occurredAt: Date.now(),
            note: body.action.note || `Ajuste em massa ${stamp} (${sign}${body.action.delta})`,
          },
        });
      } else {
        const field: EditableField = body.action.type === 'category' ? 'category' : 'supplier';
        if (((product[field] as string | null) ?? '') === body.action.value) continue;
        operations.push({
          opId: randomUUID(),
          entity: 'produto',
          op: 'upsert',
          entityId: productId,
          baseRev: Number(product['rev']),
          payload: {
            ...this.productPayload(product, { [field]: body.action.value }),
            previous: { [field]: (product[field] as string | null) ?? null },
          },
        });
      }
    }

    if (operations.length === 0) return { affected: 0, movementIds: [] as string[], failed: [] as Array<{ id: string; message: string }> };
    const results = await this.push(tx, ctx, operations);
    const failed: Array<{ id: string; message: string }> = [];
    let affected = 0;
    for (const operation of operations) {
      const result = results.get(operation.opId);
      if (result && (result.status === 'aplicada' || result.status === 'duplicada')) affected += 1;
      else failed.push({ id: operation.entityId, message: result?.message ?? 'Alteração não aceita.' });
    }
    return { affected, movementIds, failed };
  }

  async bulkCancel(tx: Transaction, ctx: InventoryContext, movementIds: string[], note?: string) {
    let cancelled = 0;
    const failed: Array<{ id: string; message: string }> = [];
    for (const movementId of [...new Set(movementIds)]) {
      try {
        // Savepoint por estorno: um que não pode ser desfeito não derruba os demais.
        await tx.transaction(async (savepoint) => this.cancelMovement(savepoint, ctx, movementId, note));
        cancelled += 1;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        failed.push({ id: movementId, message: error.message });
      }
    }
    return { cancelled, failed };
  }

  /**
   * Importação de planilha (linhas já interpretadas pelo navegador).
   *
   * Mesmas regras do app: casa por id, depois SKU, depois código de barras,
   * depois nome; produto existente só tem os campos diferentes atualizados e
   * a diferença de quantidade vira um ajuste; produto novo nasce com a
   * movimentação de `importacao`.
   */
  async importRows(tx: Transaction, ctx: InventoryContext, rows: ImportRow[]) {
    const existing = await tx.execute<Row>(
      sql`SELECT * FROM products WHERE workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL FOR UPDATE`,
    );
    const byId = new Map<string, Row>();
    const bySku = new Map<string, Row>();
    const byBarcode = new Map<string, Row>();
    const byName = new Map<string, Row>();
    for (const row of existing.rows) {
      byId.set(row['id'] as string, row);
      if (row['sku']) bySku.set(String(row['sku']), row);
      if (row['barcode']) byBarcode.set(String(row['barcode']), row);
      byName.set(String(row['name']).toLowerCase(), row);
    }

    interface Line {
      index: number;
      name: string;
      outcome: 'created' | 'updated' | 'unchanged' | 'error';
      message?: string;
      opIds: string[];
    }
    const lines: Line[] = [];
    const operations: Operation[] = [];
    const clean = (value: string | undefined): string | null => (value === undefined || value.trim() === '' ? null : value.trim());

    rows.forEach((row, index) => {
      const name = row.name?.trim() ?? '';
      const match =
        (row.id && byId.get(row.id)) ||
        (clean(row.sku) && bySku.get(clean(row.sku) as string)) ||
        (clean(row.barcode) && byBarcode.get(clean(row.barcode) as string)) ||
        (name && byName.get(name.toLowerCase())) ||
        null;

      if (!match && !name) {
        lines.push({ index, name: '', outcome: 'error', message: 'Linha sem nome, ignorada.', opIds: [] });
        return;
      }

      if (match) {
        const changes: Partial<Record<EditableField, unknown>> = {};
        const previous: Record<string, string | number | null> = {};
        const consider = (field: EditableField, incoming: string | number | null | undefined) => {
          if (incoming === undefined || incoming === null) return;
          const current = this.currentValue(match, field);
          const same = typeof incoming === 'number' ? Number(current ?? 0) === incoming : (current ?? '') === incoming;
          if (same) return;
          changes[field] = incoming;
          previous[field] = current;
        };
        // O nome só muda se não colidir com outro produto.
        if (name && name !== match['name'] && !byName.has(name.toLowerCase())) consider('name', name);
        consider('description', clean(row.description));
        consider('unitValue', row.unitValue);
        consider('minStock', row.minStock);
        consider('unit', clean(row.unit));
        consider('category', clean(row.category));
        consider('supplier', clean(row.supplier));
        consider('location', clean(row.location));
        consider('sku', clean(row.sku));
        consider('barcode', clean(row.barcode));

        const line: Line = { index, name: String(match['name']), outcome: 'unchanged', opIds: [] };
        if (Object.keys(changes).length > 0) {
          const opId = randomUUID();
          operations.push({
            opId,
            entity: 'produto',
            op: 'upsert',
            entityId: match['id'] as string,
            baseRev: Number(match['rev']),
            payload: { ...this.productPayload(match, changes), previous },
          });
          line.opIds.push(opId);
          line.outcome = 'updated';
        }
        if (row.quantity !== undefined) {
          const delta = Math.round((row.quantity - num(match['quantity_cache'])) * 10_000) / 10_000;
          if (delta !== 0) {
            const opId = randomUUID();
            const movementId = randomUUID();
            operations.push({
              opId,
              entity: 'movimentacao',
              op: 'movement',
              entityId: movementId,
              payload: { id: movementId, productId: match['id'], productName: match['name'], changeType: 'ajuste', quantity: delta, occurredAt: Date.now(), note: 'Importação' },
            });
            line.opIds.push(opId);
            line.outcome = 'updated';
          }
        }
        lines.push(line);
        return;
      }

      const id = randomUUID();
      const quantity = row.quantity ?? 0;
      const opId = randomUUID();
      const line: Line = { index, name, outcome: 'created', opIds: [opId] };
      operations.push({
        opId,
        entity: 'produto',
        op: 'upsert',
        entityId: id,
        payload: {
          id,
          name,
          description: clean(row.description),
          quantity,
          unitValue: row.unitValue ?? 0,
          minStock: row.minStock ?? 0,
          unit: clean(row.unit) ?? 'un',
          category: clean(row.category),
          supplier: clean(row.supplier),
          location: clean(row.location),
          sku: clean(row.sku),
          barcode: clean(row.barcode),
          rev: 0,
          updatedAt: Date.now(),
        },
      });
      if (quantity !== 0) {
        const movementOp = randomUUID();
        const movementId = randomUUID();
        operations.push({
          opId: movementOp,
          entity: 'movimentacao',
          op: 'movement',
          entityId: movementId,
          payload: { id: movementId, productId: id, productName: name, changeType: 'importacao', quantity, occurredAt: Date.now() },
        });
        line.opIds.push(movementOp);
      }
      // Linhas repetidas no mesmo arquivo caem no produto recém-criado.
      byName.set(name.toLowerCase(), { id, name, rev: 0, quantity_cache: quantity, unit_value: row.unitValue ?? 0, min_stock: row.minStock ?? 0 });
      lines.push(line);
    });

    const results = operations.length > 0 ? await this.push(tx, ctx, operations) : new Map<string, OperationResult>();
    for (const line of lines) {
      for (const opId of line.opIds) {
        const result = results.get(opId);
        if (!result || (result.status !== 'aplicada' && result.status !== 'duplicada')) {
          line.outcome = 'error';
          line.message = result?.message ?? 'Linha não aceita.';
          break;
        }
      }
    }

    return {
      created: lines.filter((line) => line.outcome === 'created').length,
      updated: lines.filter((line) => line.outcome === 'updated').length,
      unchanged: lines.filter((line) => line.outcome === 'unchanged').length,
      errors: lines.filter((line) => line.outcome === 'error').length,
      lines: lines.map(({ index, name, outcome, message }) => ({ index, name, outcome, message: message ?? null })),
    };
  }
}
