import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';

import type { Transaction } from '../../platform/db/client.js';
import {
  conflictLog,
  products,
  stockMovements,
  syncCursors,
  syncOperations,
  workspaces,
} from '../../platform/db/schema/index.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';
import {
  recordConflict,
  recordSyncOperation,
  recordSyncPull,
} from '../../platform/observability/metrics.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { nextChangeSeq } from './change-seq.js';
import {
  ENTITY_MOVIMENTACAO,
  ENTITY_PRODUTO,
  movementInputSchema,
  productInputSchema,
  productTombstoneSchema,
  type Change,
  type Operation,
  type OperationResult,
  type PullQuery,
  type PushBody,
} from './sync.schemas.js';

/**
 * Campos cujo conflito não tem resposta automática.
 *
 * Nome e preço são decisões de negócio. Escolher sozinho entre "Café" e "Café
 * torrado", ou entre R$ 18,00 e R$ 19,50, seria adivinhar — e o erro só
 * apareceria na hora de vender.
 */
const CAMPOS_DE_DECISAO = new Set(['name', 'unitValue']);

/** Campos descritivos, onde prevalecer o mais recente é aceitável. */
const CAMPOS_MESCLAVEIS = new Set([
  'description',
  'category',
  'supplier',
  'location',
  'unit',
  'minStock',
  'sku',
  'barcode',
]);

const CAMPOS_COMPARAVEIS = new Set([...CAMPOS_DE_DECISAO, ...CAMPOS_MESCLAVEIS]);

/**
 * Compara valores que atravessaram JSON e o banco.
 *
 * Uma quantidade sai do aparelho como número, volta do Postgres como texto
 * `"3.0000"` e um texto vazio é indistinguível de nulo para quem digitou.
 * Comparar sem normalizar acusaria conflito onde nada mudou.
 */
function iguais(a: unknown, b: unknown): boolean {
  const normalizar = (valor: unknown): string => {
    if (valor === null || valor === undefined || valor === '') return '';
    if (typeof valor === 'number') return String(valor);
    const texto = String(valor).trim();
    const numero = Number(texto);
    return texto !== '' && !Number.isNaN(numero) ? String(numero) : texto;
  };
  return normalizar(a) === normalizar(b);
}

/** Permissão exigida por tipo de operação. */
const PERMISSAO_POR_OPERACAO: Record<string, string> = {
  'produto:upsert': 'produtos.criar',
  'produto:delete': 'produtos.excluir',
  'movimentacao:movement': 'movimentacoes.entrada',
};

type ProdutoRow = typeof products.$inferSelect;
type MovimentoRow = typeof stockMovements.$inferSelect;

/**
 * Sincronização incremental: o que o aparelho alterou sobe, o que os outros
 * alteraram desce.
 *
 * As duas metades são independentes de propósito. O envio é uma lista de
 * operações identificadas, cada uma resolvida por conta própria; a leitura é
 * uma varredura ordenada a partir de um cursor. Nenhuma das duas precisa que a
 * outra tenha rodado antes, o que significa que uma conexão que cai no meio
 * nunca deixa o aparelho num estado que só um caminho específico consegue
 * desfazer.
 */
export class SyncService {
  // ---------------------------------------------------------------------------
  // Envio
  // ---------------------------------------------------------------------------

  /**
   * Aplica as operações vindas do aparelho.
   *
   * Cada operação roda no próprio savepoint. Sem isso, um único produto com
   * nome repetido derrubaria a transação inteira e o aparelho reenviaria o
   * lote completo para sempre, sem nunca conseguir passar — o dado que dá
   * problema precisa ser isolado do resto.
   */
  async push(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    deviceId: string | null,
    permissions: ReadonlySet<string>,
    body: PushBody,
  ): Promise<{ results: OperationResult[]; cursor: string; serverChangeSeq?: string }> {
    const results: OperationResult[] = [];

    for (const operation of body.operations) {
      const resultado = await this.applyOperation(
        tx,
        workspaceId,
        userId,
        deviceId,
        permissions,
        operation,
      );
      results.push(resultado);
      recordSyncOperation(resultado.status);
    }

    let deviceCursor = 0;
    if (deviceId) {
      await this.touchCursor(tx, workspaceId, deviceId, userId, { push: true });
      const [cursorRow] = await tx
        .select({ cursor: syncCursors.cursor })
        .from(syncCursors)
        .where(
          and(eq(syncCursors.workspaceId, workspaceId), eq(syncCursors.deviceId, deviceId)),
        );
      deviceCursor = cursorRow?.cursor ?? 0;
    }

    const [posicao] = await tx
      .select({ changeSeq: workspaces.changeSeq })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    // `cursor` é o ponto de leitura deste aparelho — nunca o high-water mark
    // da empresa. Devolver changeSeq faria o cliente pular alterações alheias.
    return {
      results,
      cursor: String(deviceCursor),
      serverChangeSeq: String(posicao?.changeSeq ?? 0),
    };
  }

  private async applyOperation(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    deviceId: string | null,
    permissions: ReadonlySet<string>,
    operation: Operation,
  ): Promise<OperationResult> {
    // A resposta pode ter se perdido no caminho e o aparelho reenviado a
    // mesma operação. Devolver o resultado guardado é o que impede uma saída
    // de estoque de ser cobrada duas vezes.
    const [anterior] = await tx
      .select({ result: syncOperations.result })
      .from(syncOperations)
      .where(
        and(eq(syncOperations.workspaceId, workspaceId), eq(syncOperations.opId, operation.opId)),
      );

    if (anterior) {
      // Devolve o resultado original intacto. Sobrescrever com 'duplicada'
      // fazia o cliente descartar rejeições e conflitos após um reenvio.
      const guardado = anterior.result as OperationResult;
      return {
        ...guardado,
        opId: operation.opId,
        entityId: operation.entityId,
        replayed: true,
      };
    }

    // Reserva o opId antes de aplicar. Duas requisições concorrentes com o
    // mesmo opId: só uma ganha o INSERT; a outra lê o resultado já gravado.
    const reivindicada = await tx
      .insert(syncOperations)
      .values({
        workspaceId,
        opId: operation.opId,
        entityType: operation.entity,
        entityId: operation.entityId,
        deviceId,
        status: 'pendente',
        result: { opId: operation.opId, entityId: operation.entityId, status: 'aplicada' },
      })
      .onConflictDoNothing()
      .returning({ opId: syncOperations.opId });

    if (reivindicada.length === 0) {
      const [duplicada] = await tx
        .select({ result: syncOperations.result, status: syncOperations.status })
        .from(syncOperations)
        .where(
          and(eq(syncOperations.workspaceId, workspaceId), eq(syncOperations.opId, operation.opId)),
        );
      // A outra requisição ainda está aplicando: pedir retry em vez de mentir
      // que a operação já foi gravada.
      if (!duplicada || duplicada.status === 'pendente') {
        return {
          opId: operation.opId,
          entityId: operation.entityId,
          status: 'rejeitada',
          code: ErrorCode.CONFLICT,
          message: 'Esta operação ainda está sendo processada. Tente novamente.',
        };
      }
      const guardado = duplicada.result as OperationResult;
      return { ...guardado, opId: operation.opId, entityId: operation.entityId, replayed: true };
    }

    const exigida = PERMISSAO_POR_OPERACAO[`${operation.entity}:${operation.op}`];
    if (exigida && !permissions.has(exigida)) {
      // Rejeitada, e não adiada: o papel do usuário não vai mudar por insistir,
      // e a operação precisa sair da fila com aviso em vez de repetir sozinha
      // até o fim dos tempos.
      return this.atualizarResultado(tx, workspaceId, operation, {
        opId: operation.opId,
        entityId: operation.entityId,
        status: 'rejeitada',
        code: ErrorCode.MISSING_PERMISSION,
        message: 'Seu perfil não permite esta alteração.',
      });
    }

    let resultado: OperationResult;
    try {
      resultado = await tx.transaction(async (savepoint) =>
        this.executar(savepoint, workspaceId, userId, deviceId, operation),
      );
    } catch (error) {
      const rejeicao = this.traduzirFalha(error, operation);
      if (!rejeicao) throw error;
      resultado = rejeicao;
    }

    return this.atualizarResultado(tx, workspaceId, operation, resultado);
  }

  private async executar(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    deviceId: string | null,
    operation: Operation,
  ): Promise<OperationResult> {
    if (operation.entity === ENTITY_PRODUTO && operation.op === 'upsert') {
      return this.upsertProduto(tx, workspaceId, userId, deviceId, operation);
    }
    if (operation.entity === ENTITY_PRODUTO && operation.op === 'delete') {
      return this.excluirProduto(tx, workspaceId, userId, operation);
    }
    if (operation.entity === ENTITY_MOVIMENTACAO && operation.op === 'movement') {
      return this.registrarMovimento(tx, workspaceId, userId, operation);
    }

    return {
      opId: operation.opId,
      entityId: operation.entityId,
      status: 'rejeitada',
      code: ErrorCode.VALIDATION_FAILED,
      message: `Operação não reconhecida: ${operation.entity}/${operation.op}.`,
    };
  }

  private async upsertProduto(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    deviceId: string | null,
    operation: Operation,
  ): Promise<OperationResult> {
    const entrada = productInputSchema.safeParse(operation.payload);
    if (!entrada.success) {
      return {
        opId: operation.opId,
        entityId: operation.entityId,
        status: 'rejeitada',
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Produto em formato não reconhecido.',
      };
    }
    const payload = entrada.data;

    const [atual] = await tx
      .select()
      .from(products)
      .where(and(eq(products.workspaceId, workspaceId), eq(products.id, payload.id)));

    if (!atual) {
      const seq = await nextChangeSeq(tx, workspaceId);
      await tx.insert(products).values({
        id: payload.id,
        workspaceId,
        ...this.camposEditaveis(payload),
        // O saldo de um produto novo vem do aparelho porque as movimentações
        // que o formaram podem ainda estar na fila. Daqui para frente quem
        // manda no saldo é o histórico.
        quantityCache: String(payload.quantity),
        rev: payload.rev,
        changeSeq: seq,
        lastOpId: operation.opId,
      });

      return {
        opId: operation.opId,
        entityId: payload.id,
        status: 'aplicada',
        rev: payload.rev,
        changeSeq: String(seq),
      };
    }

    // Editar um produto que já foi excluído por outra pessoa não é erro do
    // usuário, mas também não pode ressuscitar o registro em silêncio. A
    // exclusão prevalece e a edição fica guardada para quem quiser restaurar.
    if (atual.deletedAt) {
      await this.registrarConflito(tx, workspaceId, userId, deviceId, operation, {
        kind: 'exclusao_vs_edicao',
        status: 'pendente',
        field: null,
        baseValue: null,
        keptValue: { deletedAt: atual.deletedAt.getTime() },
        discardedValue: payload,
      });
      return this.conflito(operation, atual, 'Este produto foi excluído em outro aparelho.');
    }

    // Sem baseRev não há como saber de que versão a edição partiu. Aceitar
    // cegamente era last-write-wins silencioso — a coisa que a tabela de
    // conflitos existe para impedir. Recusar com código estável é acionável
    // pelo cliente (ele reenvia com baseRev após um pull).
    if (operation.baseRev === null || operation.baseRev === undefined) {
      return {
        opId: operation.opId,
        entityId: operation.entityId,
        status: 'rejeitada',
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Envie a revisão de origem (baseRev) para editar um produto existente.',
      };
    }

    if (operation.baseRev !== atual.rev) {
      return this.mesclarProduto(tx, workspaceId, userId, deviceId, operation, payload, atual);
    }

    const seq = await nextChangeSeq(tx, workspaceId);
    const novoRev = atual.rev + 1;

    // Compare-and-set atômico: se outro push ganhou a corrida entre a leitura
    // e este UPDATE, zero linhas voltam e a edição vira merge/conflito.
    const atualizados = await tx
      .update(products)
      .set({
        ...this.camposEditaveis(payload),
        rev: novoRev,
        changeSeq: seq,
        lastOpId: operation.opId,
      })
      .where(
        and(
          eq(products.workspaceId, workspaceId),
          eq(products.id, payload.id),
          eq(products.rev, atual.rev),
        ),
      )
      .returning({ rev: products.rev });

    if (atualizados.length === 0) {
      const [recente] = await tx
        .select()
        .from(products)
        .where(and(eq(products.workspaceId, workspaceId), eq(products.id, payload.id)));
      if (!recente) {
        return {
          opId: operation.opId,
          entityId: operation.entityId,
          status: 'rejeitada',
          code: ErrorCode.NOT_FOUND,
          message: 'Produto não encontrado.',
        };
      }
      return this.mesclarProduto(tx, workspaceId, userId, deviceId, operation, payload, recente);
    }

    return {
      opId: operation.opId,
      entityId: payload.id,
      status: 'aplicada',
      rev: novoRev,
      changeSeq: String(seq),
    };
  }

  /**
   * Resolve uma edição que partiu de uma versão que já não é a atual.
   *
   * A pergunta que importa não é "quem salvou por último", é "vocês mexeram na
   * mesma coisa?". Duas pessoas ajustando o mesmo produto quase nunca estão
   * discordando: uma corrigiu o fornecedor, a outra a categoria. Comparando o
   * valor de partida de cada campo com o que está no servidor, as edições que
   * não se cruzam são mescladas e ninguém perde trabalho.
   *
   * Sobra o caso em que os dois mexeram no mesmo campo. Aí não existe resposta
   * automática correta para nome e preço — são decisões de negócio — e o
   * aparelho recebe o estado atual para que uma pessoa escolha. Nos campos
   * descritivos, prevalece o que já está no servidor, e o valor descartado vai
   * para o registro de conflitos em vez de sumir.
   */
  private async mesclarProduto(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    deviceId: string | null,
    operation: Operation,
    payload: ReturnType<typeof productInputSchema.parse>,
    atual: ProdutoRow,
  ): Promise<OperationResult> {
    const partida = payload.previous ?? {};
    const alterados = Object.keys(partida).filter((campo) => CAMPOS_COMPARAVEIS.has(campo));

    // Aparelho de uma versão que ainda não informa o ponto de partida. Sem
    // isso, mesclar seria adivinhação: o estado do servidor volta e o app
    // refaz a edição por cima da versão nova.
    if (alterados.length === 0) {
      await this.registrarConflito(tx, workspaceId, userId, deviceId, operation, {
        kind: 'campo',
        status: 'pendente',
        field: null,
        baseValue: null,
        keptValue: this.produtoComoAlteracao(atual).data,
        discardedValue: payload,
      });
      return this.conflito(operation, atual, 'Este produto foi alterado em outro aparelho.');
    }

    const disputados = alterados.filter((campo) => {
      const noServidor = this.valorNoServidor(atual, campo);
      const doAparelho = this.valorEnviado(payload, campo);
      // O outro lado mexeu no campo, e não para o mesmo valor.
      return (
        !iguais(noServidor, partida[campo] ?? null) && !iguais(noServidor, doAparelho)
      );
    });

    const exigemDecisao = disputados.filter((campo) => CAMPOS_DE_DECISAO.has(campo));

    if (exigemDecisao.length > 0) {
      for (const campo of exigemDecisao) {
        await this.registrarConflito(tx, workspaceId, userId, deviceId, operation, {
          kind: 'campo',
          status: 'pendente',
          field: campo,
          baseValue: partida[campo] ?? null,
          keptValue: this.valorNoServidor(atual, campo),
          discardedValue: this.valorEnviado(payload, campo),
        });
      }
      return this.conflito(
        operation,
        atual,
        exigemDecisao.includes('name')
          ? 'O nome deste produto foi alterado em outro aparelho.'
          : 'O preço deste produto foi alterado em outro aparelho.',
      );
    }

    const mesclados: Record<string, unknown> = {};
    for (const campo of alterados) {
      if (disputados.includes(campo)) {
        // Campo descritivo alterado dos dois lados: prevalece o que já está no
        // servidor, que é a alteração mais recente na ordem dele.
        await this.registrarConflito(tx, workspaceId, userId, deviceId, operation, {
          kind: 'campo',
          status: 'automatico',
          field: campo,
          baseValue: partida[campo] ?? null,
          keptValue: this.valorNoServidor(atual, campo),
          discardedValue: this.valorEnviado(payload, campo),
        });
        continue;
      }
      Object.assign(mesclados, this.colunaDe(campo, payload));
    }

    const seq = await nextChangeSeq(tx, workspaceId);
    const novoRev = atual.rev + 1;

    await tx
      .update(products)
      .set({ ...mesclados, rev: novoRev, changeSeq: seq, lastOpId: operation.opId })
      .where(and(eq(products.workspaceId, workspaceId), eq(products.id, payload.id)));

    return {
      opId: operation.opId,
      entityId: payload.id,
      status: 'aplicada',
      rev: novoRev,
      changeSeq: String(seq),
    };
  }

  private valorNoServidor(atual: ProdutoRow, campo: string): string | number | null {
    switch (campo) {
      case 'name':
        return atual.name;
      case 'description':
        return atual.description;
      case 'unitValue':
        return Number(atual.unitValue);
      case 'minStock':
        return Number(atual.minStock);
      case 'unit':
        return atual.unit;
      case 'category':
        return atual.category;
      case 'supplier':
        return atual.supplier;
      case 'location':
        return atual.location;
      case 'sku':
        return atual.sku;
      case 'barcode':
        return atual.barcode;
      default:
        return null;
    }
  }

  private valorEnviado(
    payload: ReturnType<typeof productInputSchema.parse>,
    campo: string,
  ): string | number | null {
    const valor = (payload as unknown as Record<string, unknown>)[campo];
    if (valor === undefined || valor === null) return null;
    return typeof valor === 'number' ? valor : String(valor);
  }

  private colunaDe(
    campo: string,
    payload: ReturnType<typeof productInputSchema.parse>,
  ): Record<string, unknown> {
    switch (campo) {
      case 'name':
        return { name: payload.name };
      case 'description':
        return { description: payload.description ?? null };
      case 'unitValue':
        return { unitValue: String(payload.unitValue) };
      case 'minStock':
        return { minStock: String(payload.minStock) };
      case 'unit':
        return { unit: payload.unit ?? null };
      case 'category':
        return { category: payload.category ?? null };
      case 'supplier':
        return { supplier: payload.supplier ?? null };
      case 'location':
        return { location: payload.location ?? null };
      case 'sku':
        return { sku: payload.sku ?? null };
      case 'barcode':
        return { barcode: payload.barcode ?? null };
      default:
        return {};
    }
  }

  private async registrarConflito(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    deviceId: string | null,
    operation: Operation,
    dados: {
      kind: 'campo' | 'exclusao_vs_edicao';
      status: 'automatico' | 'pendente';
      field: string | null;
      baseValue: unknown;
      keptValue: unknown;
      discardedValue: unknown;
    },
  ): Promise<void> {
    recordConflict(dados.kind);

    await tx.insert(conflictLog).values({
      workspaceId,
      entityType: operation.entity,
      entityId: operation.entityId,
      field: dados.field,
      kind: dados.kind,
      status: dados.status,
      baseValue: dados.baseValue,
      keptValue: dados.keptValue,
      discardedValue: dados.discardedValue,
      opId: operation.opId,
      deviceId,
      createdBy: userId,
    });

    await recordAudit(tx, {
      workspaceId,
      actorUserId: userId,
      actorDeviceId: deviceId,
      action: AuditAction.SYNC_CONFLICT_RECORDED,
      entityType: operation.entity,
      entityId: operation.entityId,
      metadata: { field: dados.field, kind: dados.kind, status: dados.status },
    });
  }

  /**
   * Campos que uma edição pode alterar.
   *
   * `quantityCache` fica de fora: o saldo é consequência das movimentações, e
   * aceitá-lo de um formulário de edição permitiria corrigir o estoque sem
   * deixar rastro de quem mudou e por quê.
   */
  private camposEditaveis(payload: ReturnType<typeof productInputSchema.parse>) {
    return {
      name: payload.name,
      description: payload.description ?? null,
      unitValue: String(payload.unitValue),
      minStock: String(payload.minStock),
      unit: payload.unit ?? null,
      category: payload.category ?? null,
      supplier: payload.supplier ?? null,
      location: payload.location ?? null,
      sku: payload.sku ?? null,
      barcode: payload.barcode ?? null,
    };
  }

  private async excluirProduto(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    operation: Operation,
  ): Promise<OperationResult> {
    const entrada = productTombstoneSchema.safeParse(operation.payload);
    if (!entrada.success) {
      return {
        opId: operation.opId,
        entityId: operation.entityId,
        status: 'rejeitada',
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Exclusão em formato não reconhecido.',
      };
    }

    const [atual] = await tx
      .select()
      .from(products)
      .where(and(eq(products.workspaceId, workspaceId), eq(products.id, operation.entityId)));

    // Excluir o que não existe é o resultado que se queria. Recusar faria a
    // operação ficar presa na fila do aparelho sem nada a corrigir.
    if (!atual) {
      return { opId: operation.opId, entityId: operation.entityId, status: 'aplicada' };
    }
    if (atual.deletedAt) {
      return {
        opId: operation.opId,
        entityId: operation.entityId,
        status: 'aplicada',
        rev: atual.rev,
        changeSeq: String(atual.changeSeq),
      };
    }

    const seq = await nextChangeSeq(tx, workspaceId);
    const novoRev = atual.rev + 1;

    await tx
      .update(products)
      .set({
        deletedAt: new Date(entrada.data.deletedAt),
        deletedBy: userId,
        rev: novoRev,
        changeSeq: seq,
        lastOpId: operation.opId,
      })
      .where(and(eq(products.workspaceId, workspaceId), eq(products.id, operation.entityId)));

    return {
      opId: operation.opId,
      entityId: operation.entityId,
      status: 'aplicada',
      rev: novoRev,
      changeSeq: String(seq),
    };
  }

  /**
   * Grava uma movimentação.
   *
   * Movimentação é fato consumado: não tem versão, não tem edição e não entra
   * em conflito. Duas pessoas registrando saídas do mesmo produto ao mesmo
   * tempo não estão discordando — as duas saídas aconteceram, e o saldo é a
   * soma delas.
   */
  private async registrarMovimento(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    operation: Operation,
  ): Promise<OperationResult> {
    const entrada = movementInputSchema.safeParse(operation.payload);
    if (!entrada.success) {
      return {
        opId: operation.opId,
        entityId: operation.entityId,
        status: 'rejeitada',
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Movimentação em formato não reconhecido.',
      };
    }
    const payload = entrada.data;

    const [existente] = await tx
      .select({ changeSeq: stockMovements.changeSeq })
      .from(stockMovements)
      .where(and(eq(stockMovements.workspaceId, workspaceId), eq(stockMovements.id, payload.id)));

    if (existente) {
      return {
        opId: operation.opId,
        entityId: payload.id,
        status: 'duplicada',
        changeSeq: String(existente.changeSeq),
      };
    }

    const [produto] = payload.productId
      ? await tx
          .select({ id: products.id, name: products.name })
          .from(products)
          .where(and(eq(products.workspaceId, workspaceId), eq(products.id, payload.productId)))
      : [];

    const seq = await nextChangeSeq(tx, workspaceId);

    await tx.insert(stockMovements).values({
      id: payload.id,
      workspaceId,
      // Produto ausente vira vínculo nulo em vez de recusa: o histórico é
      // verdadeiro mesmo quando o produto foi apagado, e perdê-lo seria pior.
      productId: produto ? produto.id : null,
      productName: payload.productName ?? produto?.name ?? null,
      type: payload.changeType.toLowerCase(),
      quantity: String(payload.quantity),
      note: payload.note ?? null,
      occurredAt: new Date(payload.occurredAt),
      createdBy: userId,
      changeSeq: seq,
      opId: operation.opId,
    });

    return {
      opId: operation.opId,
      entityId: payload.id,
      status: 'aplicada',
      changeSeq: String(seq),
    };
  }

  // ---------------------------------------------------------------------------
  // Leitura
  // ---------------------------------------------------------------------------

  /**
   * Entrega as alterações posteriores ao cursor, em ordem.
   *
   * Produtos e movimentações são lidos em consultas separadas sob READ
   * COMMITTED (cada instrução tem snapshot próprio). Sem um teto comum, uma
   * alteração que commitasse entre as duas consultas entraria numa e não na
   * outra, e o nextCursor avançaria por cima dela para sempre. O teto é o
   * `changeSeq` já lido da empresa: como `next_change_seq` segura o lock da
   * linha até o commit, tudo ≤ esse valor está garantidamente visível.
   */
  async pull(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    deviceId: string | null,
    query: PullQuery,
    limitePadrao: number,
  ): Promise<{ changes: Change[]; nextCursor: string; hasMore: boolean; serverTime: string }> {
    const limite = query.limit ?? limitePadrao;

    const [empresa] = await tx
      .select({
        changeSeq: workspaces.changeSeq,
        horizonte: workspaces.tombstoneHorizonSeq,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    if (!empresa) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Empresa não encontrada.');
    }

    // Cursor anterior à limpeza de lápides não pode ser atendido: as exclusões
    // que ele ainda não viu já não estão mais lá para serem entregues.
    if (query.cursor > 0 && query.cursor < empresa.horizonte) {
      throw this.pedirRecarga(
        'Este aparelho ficou muito tempo sem sincronizar e precisa recarregar os dados.',
      );
    }

    // Cursor à frente do servidor significa que ele veio de outro banco — uma
    // empresa restaurada de backup, um aparelho trocado de conta. Continuar
    // daí faria o aparelho ignorar em silêncio tudo que existe hoje.
    if (query.cursor > empresa.changeSeq) {
      throw this.pedirRecarga('O ponto de leitura deste aparelho não confere com o do servidor.');
    }

    const teto = empresa.changeSeq;

    const produtos = await tx
      .select()
      .from(products)
      .where(
        and(
          eq(products.workspaceId, workspaceId),
          gt(products.changeSeq, query.cursor),
          lte(products.changeSeq, teto),
        ),
      )
      .orderBy(asc(products.changeSeq))
      .limit(limite + 1);

    const movimentos = await tx
      .select()
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.workspaceId, workspaceId),
          gt(stockMovements.changeSeq, query.cursor),
          lte(stockMovements.changeSeq, teto),
        ),
      )
      .orderBy(asc(stockMovements.changeSeq))
      .limit(limite + 1);

    const todas: Change[] = [
      ...produtos.map((row) => this.produtoComoAlteracao(row)),
      ...movimentos.map((row) => this.movimentoComoAlteracao(row)),
    ].sort((a, b) => Number(a.changeSeq) - Number(b.changeSeq));

    const pagina = todas.slice(0, limite);
    const hasMore = todas.length > limite;
    const ultima = pagina[pagina.length - 1];
    const nextCursor = ultima ? ultima.changeSeq : String(query.cursor);

    if (deviceId) {
      await this.touchCursor(tx, workspaceId, deviceId, userId, {
        pull: true,
        cursor: Number(nextCursor),
      });
    }

    recordSyncPull(pagina.length);
    return { changes: pagina, nextCursor, hasMore, serverTime: new Date().toISOString() };
  }

  private produtoComoAlteracao(row: ProdutoRow): Change {
    return {
      entity: ENTITY_PRODUTO,
      changeSeq: String(row.changeSeq),
      deleted: row.deletedAt !== null,
      data: {
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
      },
    };
  }

  private movimentoComoAlteracao(row: MovimentoRow): Change {
    return {
      entity: ENTITY_MOVIMENTACAO,
      changeSeq: String(row.changeSeq),
      deleted: false,
      data: {
        id: row.id,
        productId: row.productId,
        productName: row.productName,
        changeType: row.type,
        quantity: Number(row.quantity),
        note: row.note,
        occurredAt: row.occurredAt.getTime(),
        recordedAt: row.recordedAt.getTime(),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Apoio
  // ---------------------------------------------------------------------------

  private conflito(operation: Operation, atual: ProdutoRow, mensagem: string): OperationResult {
    return {
      opId: operation.opId,
      entityId: operation.entityId,
      status: 'conflito',
      rev: atual.rev,
      changeSeq: String(atual.changeSeq),
      code: ErrorCode.SYNC_CONFLICT,
      message: mensagem,
      server: this.produtoComoAlteracao(atual).data,
    };
  }

  private pedirRecarga(mensagem: string): AppError {
    return new AppError(409, ErrorCode.SYNC_RESYNC_REQUIRED, mensagem, {
      extra: { resyncRequired: true },
    });
  }

  /**
   * Converte falhas previsíveis do banco em rejeição da operação.
   *
   * Nome repetido é o caso real: dois aparelhos offline cadastraram "Café" e o
   * segundo esbarra no índice único. Isso não é falha do servidor nem motivo
   * para repetir — é uma decisão que só o usuário pode tomar.
   */
  private traduzirFalha(error: unknown, operation: Operation): OperationResult | null {
    const codigo =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;

    if (codigo === '23505') {
      return {
        opId: operation.opId,
        entityId: operation.entityId,
        status: 'rejeitada',
        code: ErrorCode.DUPLICATE_NAME,
        message: 'Já existe um produto com este nome nesta empresa.',
      };
    }

    return null;
  }

  /** Atualiza o resultado da operação já reivindicada por opId. */
  private async atualizarResultado(
    tx: Transaction,
    workspaceId: string,
    operation: Operation,
    resultado: OperationResult,
  ): Promise<OperationResult> {
    await tx
      .update(syncOperations)
      .set({
        status: resultado.status,
        result: resultado,
        entityId: operation.entityId,
      })
      .where(
        and(eq(syncOperations.workspaceId, workspaceId), eq(syncOperations.opId, operation.opId)),
      );

    return resultado;
  }

  private async touchCursor(
    tx: Transaction,
    workspaceId: string,
    deviceId: string,
    userId: string,
    evento: { push?: boolean; pull?: boolean; cursor?: number },
  ): Promise<void> {
    const agora = new Date();
    const valores = {
      workspaceId,
      deviceId,
      userId,
      cursor: evento.cursor ?? 0,
      lastPushAt: evento.push ? agora : null,
      lastPullAt: evento.pull ? agora : null,
      updatedAt: agora,
    };

    await tx
      .insert(syncCursors)
      .values(valores)
      .onConflictDoUpdate({
        target: [syncCursors.workspaceId, syncCursors.deviceId],
        set: {
          userId,
          // O cursor só avança. Um pull antigo chegando atrasado não pode
          // fazer o servidor achar que o aparelho leu menos do que já leu.
          ...(evento.cursor !== undefined
            ? { cursor: sql`GREATEST(${syncCursors.cursor}, ${evento.cursor})` }
            : {}),
          ...(evento.push ? { lastPushAt: agora } : {}),
          ...(evento.pull ? { lastPullAt: agora } : {}),
          updatedAt: agora,
        },
      });
  }
}
