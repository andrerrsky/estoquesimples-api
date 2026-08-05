import { z } from 'zod';

/**
 * Contratos da sincronização.
 *
 * Todos os identificadores são UUID gerados pelo aparelho. É isso que permite
 * reenviar um lote sem duplicar nada: a segunda inserção colide na chave
 * primária e não faz efeito.
 */

/** Quantidades aceitam fração porque o app tem unidades como kg e litro. */
const quantidade = z.number().finite();

export const productInputSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullish(),
    quantity: quantidade,
    unitValue: quantidade.nonnegative().default(0),
    minStock: quantidade.nonnegative().default(0),
    unit: z.string().max(30).nullish(),
    category: z.string().max(120).nullish(),
    supplier: z.string().max(120).nullish(),
    location: z.string().max(120).nullish(),
    sku: z.string().max(80).nullish(),
    barcode: z.string().max(80).nullish(),
    // Milissegundos do relógio do aparelho. Informativo apenas.
    updatedAt: z.number().int().nonnegative().optional(),
    deletedAt: z.number().int().nonnegative().nullish(),
    rev: z.number().int().nonnegative().default(0),
    /**
     * Valor que cada campo alterado tinha antes da edição.
     *
     * É o que permite mesclar em vez de escolher um vencedor. Comparando o
     * estado do servidor com este valor de partida, dá para saber se o outro
     * aparelho mexeu no mesmo campo ou em outro: no segundo caso as duas
     * edições convivem, e ninguém perde trabalho por ter salvado depois.
     */
    previous: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict();

export const movementInputSchema = z
  .object({
    id: z.string().uuid(),
    // Nulo é aceito: o histórico legado tem movimentações de produtos que
    // sumiram antes de existirem identificadores. Recusá-las faria o usuário
    // perder registros verdadeiros logo na primeira sincronização.
    productId: z.string().uuid().nullish(),
    productName: z.string().max(200).nullish(),
    changeType: z.string().trim().min(1).max(40),
    quantity: quantidade,
    occurredAt: z.number().int().nonnegative(),
    note: z.string().max(2000).nullish(),
  })
  .strict();

export const startUploadBodySchema = z
  .object({
    declaredProducts: z.number().int().nonnegative(),
    declaredMovements: z.number().int().nonnegative(),
    batchSize: z.number().int().positive().max(1000),
    deviceId: z.string().max(128).optional(),
  })
  .strict();

export const uploadBatchBodySchema = z
  .object({
    batchIndex: z.number().int().nonnegative(),
    products: z.array(productInputSchema).max(1000),
    movements: z.array(movementInputSchema).max(1000),
  })
  .strict();

export const completeUploadBodySchema = z
  .object({
    declaredProducts: z.number().int().nonnegative(),
    declaredMovements: z.number().int().nonnegative(),
  })
  .strict();

export const startUploadResponseSchema = z.object({
  uploadId: z.string().uuid(),
  /** Índice do próximo lote esperado; permite retomar de onde parou. */
  nextBatchIndex: z.number().int().nonnegative(),
  receivedProducts: z.number().int().nonnegative(),
  receivedMovements: z.number().int().nonnegative(),
});

export const uploadBatchResponseSchema = z.object({
  batchIndex: z.number().int().nonnegative(),
  /** Verdadeiro quando o lote já havia sido processado antes. */
  duplicate: z.boolean(),
  receivedProducts: z.number().int().nonnegative(),
  receivedMovements: z.number().int().nonnegative(),
});

export const completeUploadResponseSchema = z.object({
  cursor: z.string(),
  products: z.number().int().nonnegative(),
  movements: z.number().int().nonnegative(),
  /** Diferença entre o que o aparelho declarou e o que chegou. */
  missingProducts: z.number().int(),
  missingMovements: z.number().int(),
});

// ---------------------------------------------------------------------------
// Envio incremental
// ---------------------------------------------------------------------------

export const ENTITY_PRODUTO = 'produto';
export const ENTITY_MOVIMENTACAO = 'movimentacao';

/**
 * Lápide de produto. Só o essencial: quem foi excluído não tem mais atributos
 * que interessem, e insistir neles faria o aparelho enviar dados que já apagou.
 */
export const productTombstoneSchema = z
  .object({
    id: z.string().uuid(),
    deletedAt: z.number().int().nonnegative(),
    rev: z.number().int().nonnegative().default(0),
  })
  .strict();

/**
 * Uma alteração local esperando para subir.
 *
 * O `opId` é gerado no aparelho e é o que torna o reenvio inofensivo: a
 * segunda chegada da mesma operação encontra o resultado guardado e devolve
 * ele em vez de aplicar de novo.
 *
 * O `baseRev` é a versão de que a edição partiu. Sem ele não há como
 * distinguir uma edição sobre a versão atual de uma edição feita às cegas por
 * cima do trabalho de outra pessoa.
 */
export const operationSchema = z
  .object({
    opId: z.string().uuid(),
    entity: z.enum([ENTITY_PRODUTO, ENTITY_MOVIMENTACAO]),
    op: z.enum(['upsert', 'delete', 'movement']),
    entityId: z.string().uuid(),
    baseRev: z.number().int().nonnegative().nullish(),
    payload: z.union([productInputSchema, productTombstoneSchema, movementInputSchema]),
  })
  .strict();

export const pushBodySchema = z
  .object({
    operations: z.array(operationSchema).min(1).max(500),
  })
  .strict();

/**
 * Situação de cada operação enviada.
 *
 * - `aplicada`: gravada agora.
 * - `duplicada`: já havia sido gravada antes; o aparelho pode descartá-la.
 * - `conflito`: o registro mudou no servidor desde o `baseRev`; a versão atual
 *   volta junto para o aparelho reconciliar.
 * - `rejeitada`: não será aceita nunca (falta de permissão, dado inválido).
 *   Repetir não adianta e a operação precisa sair da fila com aviso.
 */
export const operationResultSchema = z.object({
  opId: z.string().uuid(),
  entityId: z.string().uuid(),
  status: z.enum(['aplicada', 'duplicada', 'conflito', 'rejeitada']),
  rev: z.number().int().nonnegative().optional(),
  changeSeq: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  /** Estado atual no servidor, presente apenas em conflito. */
  server: z.unknown().optional(),
  /**
   * True quando o aparelho reenviou uma operação já processada. O `status`
   * nesse caso é o resultado original (aplicada/rejeitada/conflito) — nunca
   * uma mentira de "duplicada" que faria o cliente descartar uma rejeição.
   */
  replayed: z.boolean().optional(),
});

export const pushResponseSchema = z.object({
  results: z.array(operationResultSchema),
  /**
   * Cursor de leitura deste aparelho (inalterado pelo push). Não é o
   * changeSeq da empresa — devolver o high-water mark da empresa faria o
   * cliente pular alterações de outros dispositivos.
   */
  cursor: z.string(),
  /** Maior changeSeq conhecido da empresa; só informativo. */
  serverChangeSeq: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Leitura incremental
// ---------------------------------------------------------------------------

export const pullQuerySchema = z
  .object({
    cursor: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().positive().max(1000).optional(),
  })
  .strict();

export const changeSchema = z.object({
  entity: z.enum([ENTITY_PRODUTO, ENTITY_MOVIMENTACAO]),
  changeSeq: z.string(),
  deleted: z.boolean(),
  data: z.record(z.unknown()),
});

export const pullResponseSchema = z.object({
  /**
   * Em ordem de `changeSeq`. Aplicar fora de ordem produziria um estado que
   * nunca existiu no servidor — por exemplo, ressuscitar um produto excluído.
   */
  changes: z.array(changeSchema),
  nextCursor: z.string(),
  hasMore: z.boolean(),
  serverTime: z.string(),
});

// ---------------------------------------------------------------------------
// Conflitos
// ---------------------------------------------------------------------------

export const conflictsQuerySchema = z
  .object({
    status: z.enum(['pendente', 'automatico', 'resolvido']).optional(),
    limit: z.coerce.number().int().positive().max(200).default(50),
  })
  .strict();

export const conflictSchema = z.object({
  id: z.string().uuid(),
  entityType: z.string(),
  entityId: z.string().uuid(),
  /** Nome atual do produto; um conflito identificado só por uuid é ilegível. */
  entityName: z.string().nullable(),
  field: z.string().nullable(),
  kind: z.enum(['campo', 'exclusao_vs_edicao']),
  status: z.enum(['pendente', 'automatico', 'resolvido']),
  baseValue: z.unknown(),
  keptValue: z.unknown(),
  discardedValue: z.unknown(),
  createdAt: z.string(),
});

export const conflictsResponseSchema = z.object({
  conflicts: z.array(conflictSchema),
  pending: z.number().int().nonnegative(),
});

export const resolveConflictBodySchema = z
  .object({
    /**
     * `meu` reaplica o valor descartado, `servidor` mantém o que está lá e
     * `restaurar` traz de volta um produto excluído durante a edição.
     */
    escolha: z.enum(['meu', 'servidor', 'restaurar']),
  })
  .strict();

export const resolveConflictResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  resolution: z.enum(['meu', 'servidor', 'restaurar']),
});

export type ConflictsQuery = z.infer<typeof conflictsQuerySchema>;
export type ResolveConflictBody = z.infer<typeof resolveConflictBodySchema>;

export type ProductTombstone = z.infer<typeof productTombstoneSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type PushBody = z.infer<typeof pushBodySchema>;
export type OperationResult = z.infer<typeof operationResultSchema>;
export type PullQuery = z.infer<typeof pullQuerySchema>;
export type Change = z.infer<typeof changeSchema>;

export type ProductInput = z.infer<typeof productInputSchema>;
export type MovementInput = z.infer<typeof movementInputSchema>;
export type StartUploadBody = z.infer<typeof startUploadBodySchema>;
export type UploadBatchBody = z.infer<typeof uploadBatchBodySchema>;
export type CompleteUploadBody = z.infer<typeof completeUploadBodySchema>;
