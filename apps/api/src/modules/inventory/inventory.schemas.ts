import { z } from 'zod';

/**
 * Contratos da API de estoque usada pela aplicação web.
 *
 * A web é um cliente online: lê por aqui e grava por aqui, mas a gravação
 * passa pelo mesmo motor da sincronização do app (`SyncService.push`). Os
 * limites de tamanho são os mesmos de `sync.schemas.ts`.
 */

const quantity = z.number().finite();
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => value.trim())
    .nullish();

export const workspaceParams = z.object({ workspaceId: z.string().uuid() });
export const productParams = workspaceParams.extend({ productId: z.string().uuid() });
export const movementParams = workspaceParams.extend({ movementId: z.string().uuid() });

export const productFieldsSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome do produto.').max(200),
  description: optionalText(2000),
  unitValue: quantity.nonnegative().max(999_999_999).default(0),
  minStock: quantity.nonnegative().max(999_999_999).default(0),
  unit: optionalText(30),
  category: optionalText(120),
  supplier: optionalText(120),
  location: optionalText(120),
  sku: optionalText(80),
  barcode: optionalText(80),
});

export const createProductBodySchema = productFieldsSchema
  .extend({
    /** Gerado pelo cliente para que repetir o envio não duplique o produto. */
    id: z.string().uuid().optional(),
    /** Estoque inicial; vira a movimentação de `cadastro`. */
    quantity: quantity.nonnegative('A quantidade não pode ser negativa.').max(999_999_999).default(0),
  })
  .strict();

export const updateProductBodySchema = z
  .object({
    /** Versão que a tela carregou; é o que detecta edição concorrente. */
    rev: z.number().int().nonnegative(),
    /** Só os campos alterados. */
    changes: productFieldsSchema.partial().default({}),
    /** Valor que cada campo alterado tinha quando a tela abriu (para mesclar). */
    base: z.record(z.union([z.string(), z.number(), z.null()])).optional(),
    /** Correção de quantidade: vira movimentação de ajuste com o delta. */
    quantity: z
      .object({
        target: quantity.nonnegative('A quantidade não pode ser negativa.').max(999_999_999),
        note: z.string().trim().max(2000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const listProductsQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    category: z.string().max(120).optional(),
    lowStock: z.enum(['true', 'false']).optional(),
    sort: z.enum(['name', 'quantity', 'value', 'updated']).default('name'),
    order: z.enum(['asc', 'desc']).default('asc'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const listMovementsQuerySchema = z
  .object({
    productId: z.string().uuid().optional(),
    q: z.string().trim().max(200).optional(),
    /** in = aumentaram o estoque; out = diminuíram; adjust = ajustes e estornos. */
    direction: z.enum(['in', 'out', 'adjust']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const createMovementBodySchema = z
  .object({
    id: z.string().uuid().optional(),
    productId: z.string().uuid(),
    type: z.enum(['entrada', 'saida']),
    quantity: quantity.positive('A quantidade deve ser maior que zero.').max(999_999_999),
    note: z.string().trim().max(2000).optional(),
    /** Lançamento retroativo; datas futuras viram "agora". */
    occurredAt: z.coerce.date().optional(),
  })
  .strict();

export const cancelMovementBodySchema = z.object({ note: z.string().trim().max(2000).optional() }).strict();

export const bulkBodySchema = z
  .object({
    productIds: z.array(z.string().uuid()).min(1).max(500),
    action: z.discriminatedUnion('type', [
      z.object({ type: z.literal('adjust'), delta: quantity.refine((v) => v !== 0, 'Quantidade inválida.'), note: z.string().trim().max(200).optional() }).strict(),
      z.object({ type: z.literal('category'), value: z.string().trim().min(1).max(120) }).strict(),
      z.object({ type: z.literal('supplier'), value: z.string().trim().min(1).max(120) }).strict(),
    ]),
  })
  .strict();

export const bulkCancelBodySchema = z
  .object({ movementIds: z.array(z.string().uuid()).min(1).max(500), note: z.string().trim().max(2000).optional() })
  .strict();

export const importRowSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().max(200).optional(),
    description: z.string().max(2000).optional(),
    quantity: quantity.optional(),
    unitValue: quantity.nonnegative().optional(),
    minStock: quantity.nonnegative().optional(),
    unit: z.string().max(30).optional(),
    category: z.string().max(120).optional(),
    supplier: z.string().max(120).optional(),
    location: z.string().max(120).optional(),
    sku: z.string().max(80).optional(),
    barcode: z.string().max(80).optional(),
  })
  .strict();

export const importBodySchema = z.object({ rows: z.array(importRowSchema).min(1).max(1000) }).strict();

export const reportQuerySchema = z
  .object({ period: z.enum(['today', '7d', '30d', '90d', 'all']).default('all') })
  .strict();

export type CreateProductBody = z.infer<typeof createProductBodySchema>;
export type UpdateProductBody = z.infer<typeof updateProductBodySchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
export type ListMovementsQuery = z.infer<typeof listMovementsQuerySchema>;
export type CreateMovementBody = z.infer<typeof createMovementBodySchema>;
export type BulkBody = z.infer<typeof bulkBodySchema>;
export type ImportRow = z.infer<typeof importRowSchema>;
