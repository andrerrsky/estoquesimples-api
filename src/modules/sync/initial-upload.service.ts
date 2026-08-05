import { and, eq, sql } from 'drizzle-orm';

import type { Transaction } from '../../platform/db/client.js';
import {
  initialUploadBatches,
  initialUploads,
  products,
  stockMovements,
  workspaces,
} from '../../platform/db/schema/index.js';
import { AppError, ErrorCode, conflict, notFound } from '../../platform/http/errors.js';
import type {
  CompleteUploadBody,
  MovementInput,
  ProductInput,
  StartUploadBody,
  UploadBatchBody,
} from './sync.schemas.js';

/**
 * Carga inicial do banco de um aparelho para a nuvem.
 *
 * O desafio não é o volume, é a interrupção. São milhares de registros saindo
 * de um celular por rede móvel, e o envio vai cair no meio — a tela apaga, o
 * app vai para segundo plano, o sinal some. Por isso todo o fluxo é construído
 * em torno de uma única propriedade: reenviar qualquer coisa precisa ser
 * inofensivo.
 *
 * Isso é possível porque os identificadores vêm prontos do aparelho. Um lote
 * repetido encontra as chaves já ocupadas e não faz nada. Não há contador que
 * possa ser incrementado duas vezes nem registro que possa ser duplicado.
 */
export class InitialUploadService {
  /**
   * Abre a sessão de envio, ou devolve a que já estava aberta.
   *
   * Devolver a existente em vez de recusar é o que permite retomar depois de o
   * app ser encerrado: o aparelho pede uma sessão, recebe a mesma de antes com
   * o índice do próximo lote, e continua de onde parou.
   */
  async start(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    body: StartUploadBody,
  ): Promise<{
    uploadId: string;
    nextBatchIndex: number;
    receivedProducts: number;
    receivedMovements: number;
  }> {
    const [workspace] = await tx
      .select({ seededAt: workspaces.seededAt })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    if (!workspace) {
      throw notFound('Empresa não encontrada.');
    }

    // Uma empresa já semeada não recebe outra carga inicial. O segundo
    // aparelho precisa baixar o que existe, não sobrescrever com o próprio
    // banco — que provavelmente é uma cópia velha dos mesmos dados.
    if (workspace.seededAt) {
      throw conflict(
        ErrorCode.SYNC_ALREADY_SEEDED,
        'Esta empresa já tem dados na nuvem. Este aparelho deve baixá-los em vez de enviar.',
      );
    }

    const [existing] = await tx
      .select()
      .from(initialUploads)
      .where(
        and(eq(initialUploads.workspaceId, workspaceId), eq(initialUploads.status, 'em_andamento')),
      );

    if (existing) {
      return {
        uploadId: existing.id,
        nextBatchIndex: await this.nextBatchIndex(tx, existing.id),
        receivedProducts: existing.receivedProducts,
        receivedMovements: existing.receivedMovements,
      };
    }

    const [created] = await tx
      .insert(initialUploads)
      .values({
        workspaceId,
        createdBy: userId,
        declaredProducts: body.declaredProducts,
        declaredMovements: body.declaredMovements,
      })
      .returning({ id: initialUploads.id });

    if (!created) {
      throw new AppError(500, ErrorCode.INTERNAL, 'Não foi possível abrir a sessão de envio.');
    }

    return {
      uploadId: created.id,
      nextBatchIndex: 0,
      receivedProducts: 0,
      receivedMovements: 0,
    };
  }

  /**
   * Grava um lote.
   *
   * O registro do lote é inserido primeiro, com `ON CONFLICT DO NOTHING`. Se
   * nada foi inserido, é porque este lote já passou por aqui, e a chamada
   * termina sem tocar em produto algum. Fazer essa checagem antes das
   * inserções — e não depois — é o que garante que os contadores não sejam
   * somados duas vezes.
   */
  async applyBatch(
    tx: Transaction,
    workspaceId: string,
    uploadId: string,
    userId: string,
    body: UploadBatchBody,
  ): Promise<{
    batchIndex: number;
    duplicate: boolean;
    receivedProducts: number;
    receivedMovements: number;
  }> {
    const upload = await this.requireOpenUpload(tx, workspaceId, uploadId);

    // Na carga inicial o saldo vem pronto do aparelho: o histórico legado é
    // incompleto e somá-lo daria um número menor que o estoque real. O gatilho
    // que projeta o saldo fica desligado até o fim desta transação.
    await tx.execute(sql`SELECT set_config('app.carga_inicial', 'on', true)`);

    const claimed = await tx
      .insert(initialUploadBatches)
      .values({
        uploadId,
        workspaceId,
        batchIndex: body.batchIndex,
        products: body.products.length,
        movements: body.movements.length,
      })
      .onConflictDoNothing()
      .returning({ batchIndex: initialUploadBatches.batchIndex });

    if (claimed.length === 0) {
      return {
        batchIndex: body.batchIndex,
        duplicate: true,
        receivedProducts: upload.receivedProducts,
        receivedMovements: upload.receivedMovements,
      };
    }

    const produtosGravados = await this.insertProducts(tx, workspaceId, userId, body.products);
    const movimentosGravados = await this.insertMovements(tx, workspaceId, userId, body.movements);

    const [atualizado] = await tx
      .update(initialUploads)
      .set({
        receivedProducts: sql`${initialUploads.receivedProducts} + ${produtosGravados}`,
        receivedMovements: sql`${initialUploads.receivedMovements} + ${movimentosGravados}`,
      })
      .where(eq(initialUploads.id, uploadId))
      .returning({
        receivedProducts: initialUploads.receivedProducts,
        receivedMovements: initialUploads.receivedMovements,
      });

    if (!atualizado) {
      throw new AppError(500, ErrorCode.INTERNAL, 'Não foi possível registrar o lote.');
    }

    return {
      batchIndex: body.batchIndex,
      duplicate: false,
      receivedProducts: atualizado.receivedProducts,
      receivedMovements: atualizado.receivedMovements,
    };
  }

  /**
   * Fecha a sessão e devolve o ponto de partida da sincronização incremental.
   *
   * A contagem recebida é comparada com a declarada, mas a diferença não
   * impede a conclusão: nomes repetidos são recusados pelo índice único e
   * geram falta legítima. Travar aqui deixaria o usuário preso sem ter como
   * resolver pelo aplicativo. A diferença volta na resposta para ser mostrada.
   */
  async complete(
    tx: Transaction,
    workspaceId: string,
    uploadId: string,
    body: CompleteUploadBody,
  ): Promise<{
    cursor: string;
    products: number;
    movements: number;
    missingProducts: number;
    missingMovements: number;
  }> {
    const upload = await this.requireOpenUpload(tx, workspaceId, uploadId);

    const missingProducts = body.declaredProducts - upload.receivedProducts;
    const missingMovements = body.declaredMovements - upload.receivedMovements;

    // Sellar com lotes faltando tornaria os registros perdidos irrecuperáveis:
    // start() recusa novo upload depois de seededAt.
    if (missingProducts > 0 || missingMovements > 0) {
      throw new AppError(
        409,
        ErrorCode.SYNC_UPLOAD_COUNT_MISMATCH,
        'Ainda faltam registros neste envio. Reenvie os lotes pendentes antes de concluir.',
        {
          extra: {
            missingProducts,
            missingMovements,
            receivedProducts: upload.receivedProducts,
            receivedMovements: upload.receivedMovements,
          },
        },
      );
    }

    await tx
      .update(initialUploads)
      .set({ status: 'concluida', completedAt: new Date() })
      .where(eq(initialUploads.id, uploadId));

    await tx
      .update(workspaces)
      .set({ seededAt: new Date() })
      .where(eq(workspaces.id, workspaceId));

    const [posicao] = await tx
      .select({ cursor: workspaces.changeSeq })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    return {
      cursor: String(posicao?.cursor ?? 0),
      products: upload.receivedProducts,
      movements: upload.receivedMovements,
      missingProducts: 0,
      missingMovements: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Escrita
  // -------------------------------------------------------------------------

  private async insertProducts(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    entries: ProductInput[],
  ): Promise<number> {
    let gravados = 0;

    for (const entry of entries) {
      try {
        // Savepoint por produto: um nome duplicado (índice parcial) não pode
        // derrubar o lote inteiro — bancos legados estão cheios deles.
        await tx.transaction(async (savepoint) => {
          const seq = await this.nextChangeSeq(savepoint, workspaceId);

          const inserted = await savepoint
            .insert(products)
            .values({
              id: entry.id,
              workspaceId,
              name: entry.name,
              description: entry.description ?? null,
              unitValue: String(entry.unitValue),
              quantityCache: String(entry.quantity),
              minStock: String(entry.minStock),
              unit: entry.unit ?? null,
              category: entry.category ?? null,
              supplier: entry.supplier ?? null,
              location: entry.location ?? null,
              sku: entry.sku ?? null,
              barcode: entry.barcode ?? null,
              rev: entry.rev,
              changeSeq: seq,
              deletedAt: entry.deletedAt ? new Date(entry.deletedAt) : null,
              deletedBy: entry.deletedAt ? userId : null,
            })
            // Reenvio do mesmo id não é erro. Conflito de nome cai no catch.
            .onConflictDoNothing({ target: products.id })
            .returning({ id: products.id });

          if (inserted.length > 0) {
            gravados += 1;
          }
        });
      } catch (error) {
        const codigo =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (codigo === '23505') {
          // Nome duplicado ou outra unicidade: conta como não gravado e segue.
          continue;
        }
        throw error;
      }
    }

    return gravados;
  }

  private async insertMovements(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    entries: MovementInput[],
  ): Promise<number> {
    let gravados = 0;

    for (const entry of entries) {
      const seq = await this.nextChangeSeq(tx, workspaceId);

      // O produto pode não ter chegado ainda, ou nem existir. A chave
      // estrangeira recusaria a movimentação inteira; guardar o vínculo como
      // nulo preserva o registro histórico, que é o que o usuário consulta.
      const productExists = entry.productId
        ? await this.productExists(tx, workspaceId, entry.productId)
        : false;

      const inserted = await tx
        .insert(stockMovements)
        .values({
          id: entry.id,
          workspaceId,
          productId: productExists ? entry.productId : null,
          productName: entry.productName ?? null,
          type: entry.changeType.toLowerCase(),
          quantity: String(entry.quantity),
          note: entry.note ?? null,
          occurredAt: new Date(entry.occurredAt),
          createdBy: userId,
          changeSeq: seq,
        })
        .onConflictDoNothing({ target: stockMovements.id })
        .returning({ id: stockMovements.id });

      if (inserted.length > 0) {
        gravados += 1;
      }
    }

    return gravados;
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  /**
   * Aloca a próxima posição na sequência da empresa.
   *
   * Um `UPDATE ... RETURNING` na linha da empresa, e não uma sequência do
   * Postgres. A diferença importa: sequências entregam números fora de ordem
   * quando transações concorrentes terminam em ordem diferente da que
   * começaram, e um aparelho lendo por cursor pularia silenciosamente os
   * registros que ficaram para trás.
   */
  private async nextChangeSeq(tx: Transaction, workspaceId: string): Promise<number> {
    const result = await tx.execute<{ next_change_seq: string }>(
      sql`SELECT next_change_seq(${workspaceId}::uuid) AS next_change_seq`,
    );
    const raw = result.rows[0]?.next_change_seq;
    if (raw === undefined) {
      throw new AppError(500, ErrorCode.INTERNAL, 'Não foi possível ordenar a alteração.');
    }
    return Number(raw);
  }

  private async productExists(
    tx: Transaction,
    workspaceId: string,
    productId: string,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.workspaceId, workspaceId), eq(products.id, productId)));
    return row !== undefined;
  }

  private async nextBatchIndex(tx: Transaction, uploadId: string): Promise<number> {
    // Menor índice faltante, não MAX+1: um lote que falhou no meio precisa
    // ser reenviado, não pulado.
    const result = await tx.execute<{ proximo: string | null }>(
      sql`SELECT COALESCE(
            (
              SELECT MIN(gs.i)
              FROM generate_series(
                0,
                COALESCE((SELECT MAX(batch_index) FROM initial_upload_batches WHERE upload_id = ${uploadId}::uuid), -1) + 1
              ) AS gs(i)
              WHERE NOT EXISTS (
                SELECT 1 FROM initial_upload_batches b
                WHERE b.upload_id = ${uploadId}::uuid AND b.batch_index = gs.i
              )
            ),
            0
          ) AS proximo`,
    );
    const raw = result.rows[0]?.proximo;
    return raw === null || raw === undefined ? 0 : Number(raw);
  }

  private async requireOpenUpload(tx: Transaction, workspaceId: string, uploadId: string) {
    const [upload] = await tx
      .select()
      .from(initialUploads)
      .where(and(eq(initialUploads.id, uploadId), eq(initialUploads.workspaceId, workspaceId)));

    if (!upload) {
      throw notFound('Sessão de envio não encontrada.');
    }
    if (upload.status !== 'em_andamento') {
      throw conflict(
        ErrorCode.SYNC_UPLOAD_ALREADY_COMPLETED,
        'Esta sessão de envio já foi concluída.',
      );
    }
    return upload;
  }
}
