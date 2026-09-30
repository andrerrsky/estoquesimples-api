import { z } from 'zod';

import { EVENT_NAME_PATTERN } from './analytics.events.js';

/** Tamanho máximo do JSON de propriedades por evento. */
export const MAX_PROPERTIES_BYTES = 4096;

const propertyValue = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);

/**
 * Propriedades são planas (chave → escalar). Objetos aninhados abririam a
 * porta para o app despejar registros inteiros num evento.
 */
export const propertiesSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), propertyValue)
  .refine((value) => Object.keys(value).length <= 20, 'No máximo 20 propriedades por evento.')
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_PROPERTIES_BYTES,
    'Propriedades excedem o tamanho máximo.',
  );

export const clientEventSchema = z
  .object({
    /** UUID gerado no aparelho; reenvio do mesmo id é ignorado. */
    id: z.string().uuid(),
    name: z.string().regex(EVENT_NAME_PATTERN, 'Nome de evento inválido.').max(80),
    /** Epoch em milissegundos do relógio do aparelho. */
    occurredAt: z.number().int().positive(),
    workspaceId: z.string().uuid().optional(),
    sessionKey: z.string().max(64).optional(),
    properties: propertiesSchema.optional(),
  })
  .strict();

export const analyticsBatchBodySchema = z
  .object({
    device: z
      .object({
        installId: z.string().min(8).max(128),
        platform: z.enum(['android', 'ios', 'web']).default('android'),
        appVersionCode: z.number().int().nonnegative().optional(),
      })
      .strict(),
    events: z.array(clientEventSchema).min(1),
  })
  .strict();

export type AnalyticsBatchBody = z.infer<typeof analyticsBatchBodySchema>;
export type ClientEvent = z.infer<typeof clientEventSchema>;

export const analyticsBatchResponseSchema = z.object({
  accepted: z.number().int(),
  duplicated: z.number().int(),
  rejected: z.number().int(),
});
