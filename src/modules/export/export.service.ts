import { and, asc, eq, isNull } from 'drizzle-orm';

import type { Transaction } from '../../platform/db/client.js';
import { products, stockMovements } from '../../platform/db/schema/index.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  type BackupFile,
  type ExportQuery,
} from './export.schemas.js';

const MAX_PRODUCTS = 20_000;
const MAX_MOVEMENTS = 100_000;

/**
 * Extrai o estoque da empresa no mesmo contrato da sincronização.
 *
 * Não é um dump interno: o JSON que sai daqui é o que o app importa, e o CSV
 * é o que uma planilha abre. Quantidade nas movimentações vai com sinal, iguais
 * ao `movementInput` do push — senão uma saída reimportada viraria entrada.
 */
export class ExportService {
  async backup(
    tx: Transaction,
    workspaceId: string,
    actorUserId: string,
    actorDeviceId: string | null,
    query: ExportQuery,
    includeMovements: boolean,
  ): Promise<BackupFile> {
    const productRows = await this.listProducts(tx, workspaceId, query.includeDeleted);
    if (productRows.length > MAX_PRODUCTS) {
      throw tooLarge('produtos');
    }

    const movementRows = includeMovements
      ? await this.listMovements(tx, workspaceId)
      : [];
    if (movementRows.length > MAX_MOVEMENTS) {
      throw tooLarge('movimentações');
    }

    await recordAudit(tx, {
      workspaceId,
      actorUserId,
      actorDeviceId,
      action: AuditAction.DATA_EXPORTED,
      entityType: 'workspace',
      entityId: workspaceId,
      metadata: {
        format: 'json',
        products: productRows.length,
        movements: movementRows.length,
        includeDeleted: query.includeDeleted,
      },
    });

    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: Date.now(),
      source: 'cloud',
      workspaceId,
      products: productRows,
      movements: movementRows,
    };
  }

  async productsCsv(
    tx: Transaction,
    workspaceId: string,
    actorUserId: string,
    actorDeviceId: string | null,
    query: ExportQuery,
  ): Promise<string> {
    const rows = await this.listProducts(tx, workspaceId, query.includeDeleted);
    if (rows.length > MAX_PRODUCTS) {
      throw tooLarge('produtos');
    }

    await recordAudit(tx, {
      workspaceId,
      actorUserId,
      actorDeviceId,
      action: AuditAction.DATA_EXPORTED,
      entityType: 'workspace',
      entityId: workspaceId,
      metadata: { format: 'csv-produtos', products: rows.length },
    });

    const header = [
      'nome',
      'descricao',
      'quantidade',
      'valor',
      'categoria',
      'sku',
      'codigo_barras',
      'fornecedor',
      'localizacao',
      'estoque_minimo',
      'unidade',
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.name,
          row.description ?? '',
          String(row.quantity),
          String(row.unitValue),
          row.category ?? '',
          row.sku ?? '',
          row.barcode ?? '',
          row.supplier ?? '',
          row.location ?? '',
          String(row.minStock),
          row.unit ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return `\uFEFF${lines.join('\n')}\n`;
  }

  async movementsCsv(
    tx: Transaction,
    workspaceId: string,
    actorUserId: string,
    actorDeviceId: string | null,
  ): Promise<string> {
    const rows = await this.listMovements(tx, workspaceId);
    if (rows.length > MAX_MOVEMENTS) {
      throw tooLarge('movimentações');
    }

    await recordAudit(tx, {
      workspaceId,
      actorUserId,
      actorDeviceId,
      action: AuditAction.DATA_EXPORTED,
      entityType: 'workspace',
      entityId: workspaceId,
      metadata: { format: 'csv-movimentacoes', movements: rows.length },
    });

    const header = [
      'id',
      'product_id',
      'product_name',
      'change_type',
      'quantity',
      'occurred_at',
      'note',
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.id,
          row.productId ?? '',
          row.productName ?? '',
          row.changeType,
          String(row.quantity),
          String(row.occurredAt),
          row.note ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return `\uFEFF${lines.join('\n')}\n`;
  }

  private async listProducts(
    tx: Transaction,
    workspaceId: string,
    includeDeleted: boolean,
  ): Promise<BackupFile['products']> {
    const filtro = includeDeleted
      ? eq(products.workspaceId, workspaceId)
      : and(eq(products.workspaceId, workspaceId), isNull(products.deletedAt));

    const rows = await tx
      .select()
      .from(products)
      .where(filtro)
      .orderBy(asc(products.name))
      .limit(MAX_PRODUCTS + 1);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      quantity: Number(row.quantityCache),
      unitValue: Number(row.unitValue),
      minStock: Number(row.minStock),
      unit: row.unit,
      category: row.category,
      supplier: row.supplier,
      location: row.location,
      sku: row.sku,
      barcode: row.barcode,
      rev: row.rev,
      updatedAt: row.updatedAt.getTime(),
      deletedAt: row.deletedAt ? row.deletedAt.getTime() : null,
    }));
  }

  private async listMovements(
    tx: Transaction,
    workspaceId: string,
  ): Promise<BackupFile['movements']> {
    const rows = await tx
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.workspaceId, workspaceId))
      .orderBy(asc(stockMovements.occurredAt), asc(stockMovements.recordedAt))
      .limit(MAX_MOVEMENTS + 1);

    return rows.map((row) => ({
      id: row.id,
      productId: row.productId,
      productName: row.productName,
      changeType: row.type,
      quantity: Number(row.quantity),
      occurredAt: row.occurredAt.getTime(),
      note: row.note,
      recordedAt: row.recordedAt.getTime(),
    }));
  }
}

function tooLarge(oque: string): AppError {
  return new AppError(
    413,
    ErrorCode.PAYLOAD_TOO_LARGE,
    `Esta empresa tem mais ${oque} do que a extração comporta de uma vez.`,
  );
}

/**
 * Célula CSV à prova de fórmula no Excel.
 *
 * Um nome de produto começando com `=` seria executado ao abrir o arquivo.
 * Números negativos são quantidade de verdade e passam.
 */
export function csvCell(value: string): string {
  const texto = value ?? '';
  const formula =
    /^[=+@\t\r]/.test(texto) || (/^-/.test(texto) && Number.isNaN(Number(texto.replace(',', '.'))));
  const seguro = formula ? `'${texto}` : texto;
  if (/[",;\n\r]/.test(seguro) || formula) {
    return `"${seguro.replace(/"/g, '""')}"`;
  }
  return seguro;
}
