import { and, desc, eq, sql } from 'drizzle-orm';

import type { Transaction } from '../../platform/db/client.js';
import { conflictLog, products } from '../../platform/db/schema/index.js';
import { AppError, ErrorCode, conflict, notFound } from '../../platform/http/errors.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { nextChangeSeq } from './change-seq.js';

export type Escolha = 'meu' | 'servidor' | 'restaurar';

/** Conflito como a tela de resolução o enxerga. */
export interface ConflictView {
  id: string;
  entityType: string;
  entityId: string;
  entityName: string | null;
  field: string | null;
  kind: 'campo' | 'exclusao_vs_edicao';
  status: 'pendente' | 'automatico' | 'resolvido';
  baseValue: unknown;
  keptValue: unknown;
  discardedValue: unknown;
  createdAt: string;
}

/** Colunas que uma resolução pode reescrever, por nome de campo do contrato. */
const COLUNA_POR_CAMPO: Record<string, string> = {
  name: 'name',
  description: 'description',
  unitValue: 'unit_value',
  minStock: 'min_stock',
  unit: 'unit',
  category: 'category',
  supplier: 'supplier',
  location: 'location',
  sku: 'sku',
  barcode: 'barcode',
};

/** Campos guardados como número no banco. */
const CAMPOS_NUMERICOS = new Set(['unitValue', 'minStock']);

/**
 * Conflitos que esperam decisão de uma pessoa.
 *
 * O servidor já resolveu tudo que dava para resolver sozinho. O que sobra são
 * escolhas de negócio — qual nome o produto tem, quanto ele custa, se um
 * produto excluído deve voltar. Nenhuma dessas tem resposta técnica, e chutar
 * significa que alguém vai vender pelo preço errado.
 */
export class ConflictsService {
  async list(
    tx: Transaction,
    workspaceId: string,
    filtro: { status?: string; limit: number },
  ): Promise<{ conflicts: ConflictView[] }> {
    const condicoes = [eq(conflictLog.workspaceId, workspaceId)];
    if (filtro.status) {
      condicoes.push(eq(conflictLog.status, filtro.status));
    }

    const linhas = await tx
      .select({
        id: conflictLog.id,
        entityType: conflictLog.entityType,
        entityId: conflictLog.entityId,
        // O nome vem junto porque um conflito identificado só por uuid é
        // ilegível: ninguém reconhece o produto pelo identificador.
        entityName: products.name,
        field: conflictLog.field,
        kind: conflictLog.kind,
        status: conflictLog.status,
        baseValue: conflictLog.baseValue,
        keptValue: conflictLog.keptValue,
        discardedValue: conflictLog.discardedValue,
        createdAt: conflictLog.createdAt,
      })
      .from(conflictLog)
      .leftJoin(products, eq(products.id, conflictLog.entityId))
      .where(and(...condicoes))
      .orderBy(desc(conflictLog.createdAt))
      .limit(filtro.limit);

    return {
      conflicts: linhas.map((linha) => ({
        ...linha,
        kind: linha.kind as ConflictView['kind'],
        status: linha.status as ConflictView['status'],
        createdAt: linha.createdAt.toISOString(),
      })),
    };
  }

  async pendingCount(tx: Transaction, workspaceId: string): Promise<number> {
    const [linha] = await tx
      .select({ total: sql<string>`count(*)` })
      .from(conflictLog)
      .where(and(eq(conflictLog.workspaceId, workspaceId), eq(conflictLog.status, 'pendente')));
    return Number(linha?.total ?? 0);
  }

  /**
   * Aplica a decisão do usuário.
   *
   * `servidor` apenas encerra o conflito: o valor que já está lá continua. As
   * outras duas escrevem, e por isso passam por uma nova posição na sequência
   * — os outros aparelhos precisam receber a decisão como qualquer alteração.
   */
  async resolve(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    conflictId: string,
    escolha: Escolha,
  ): Promise<{ id: string; status: string; resolution: Escolha }> {
    const [registro] = await tx
      .select()
      .from(conflictLog)
      .where(and(eq(conflictLog.workspaceId, workspaceId), eq(conflictLog.id, conflictId)));

    if (!registro) {
      throw notFound('Conflito não encontrado.');
    }
    if (registro.status === 'resolvido') {
      throw conflict(ErrorCode.CONFLICT, 'Este conflito já foi resolvido.');
    }

    if (escolha === 'restaurar') {
      await this.restaurar(tx, workspaceId, registro);
    } else if (escolha === 'meu') {
      await this.aplicarValorDescartado(tx, workspaceId, registro);
    }

    await tx
      .update(conflictLog)
      .set({
        status: 'resolvido',
        resolution: escolha,
        resolvedAt: new Date(),
        resolvedBy: userId,
      })
      .where(eq(conflictLog.id, conflictId));

    await recordAudit(tx, {
      workspaceId,
      actorUserId: userId,
      action: AuditAction.SYNC_CONFLICT_RESOLVED,
      entityType: registro.entityType,
      entityId: registro.entityId,
      metadata: { conflictId, field: registro.field, resolution: escolha },
    });

    return { id: conflictId, status: 'resolvido', resolution: escolha };
  }

  /**
   * Traz de volta um produto excluído enquanto alguém o editava.
   *
   * Restaurar aplica junto a edição que ficou guardada: quem pediu para
   * restaurar quer o produto como estava trabalhando nele, não a versão de
   * antes das alterações.
   */
  private async restaurar(
    tx: Transaction,
    workspaceId: string,
    registro: typeof conflictLog.$inferSelect,
  ): Promise<void> {
    if (registro.kind !== 'exclusao_vs_edicao') {
      throw new AppError(
        400,
        ErrorCode.VALIDATION_FAILED,
        'Restaurar só se aplica a produto excluído durante uma edição.',
      );
    }

    const edicao = (registro.discardedValue ?? {}) as Record<string, unknown>;
    const seq = await nextChangeSeq(tx, workspaceId);

    const [atual] = await tx
      .select({ rev: products.rev })
      .from(products)
      .where(and(eq(products.workspaceId, workspaceId), eq(products.id, registro.entityId)));

    if (!atual) {
      throw notFound('Produto não encontrado.');
    }

    await tx
      .update(products)
      .set({
        deletedAt: null,
        deletedBy: null,
        name: typeof edicao['name'] === 'string' ? edicao['name'] : undefined,
        description: (edicao['description'] as string | null) ?? null,
        unitValue: edicao['unitValue'] !== undefined ? String(edicao['unitValue']) : undefined,
        minStock: edicao['minStock'] !== undefined ? String(edicao['minStock']) : undefined,
        unit: (edicao['unit'] as string | null) ?? null,
        category: (edicao['category'] as string | null) ?? null,
        supplier: (edicao['supplier'] as string | null) ?? null,
        location: (edicao['location'] as string | null) ?? null,
        rev: atual.rev + 1,
        changeSeq: seq,
      })
      .where(and(eq(products.workspaceId, workspaceId), eq(products.id, registro.entityId)));
  }

  private async aplicarValorDescartado(
    tx: Transaction,
    workspaceId: string,
    registro: typeof conflictLog.$inferSelect,
  ): Promise<void> {
    if (registro.kind === 'exclusao_vs_edicao') {
      throw new AppError(
        400,
        ErrorCode.VALIDATION_FAILED,
        'Para um produto excluído, a opção é restaurar ou manter excluído.',
      );
    }
    if (!registro.field) {
      throw new AppError(
        400,
        ErrorCode.VALIDATION_FAILED,
        'Este conflito não guarda um campo específico para reaplicar.',
      );
    }

    const coluna = COLUNA_POR_CAMPO[registro.field];
    if (!coluna) {
      throw new AppError(400, ErrorCode.VALIDATION_FAILED, 'Campo desconhecido neste conflito.');
    }

    const valor = registro.discardedValue;
    const seq = await nextChangeSeq(tx, workspaceId);

    // SQL direto porque a coluna é escolhida em tempo de execução; o nome vem
    // de uma lista fechada, nunca do corpo da requisição.
    await tx.execute(sql`
      UPDATE products
         SET ${sql.raw(coluna)} = ${CAMPOS_NUMERICOS.has(registro.field) ? Number(valor) : valor},
             rev = rev + 1,
             change_seq = ${seq}
       WHERE workspace_id = ${workspaceId}::uuid
         AND id = ${registro.entityId}::uuid
    `);
  }
}
