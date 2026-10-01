import { z } from 'zod';

export const SUPPORT_CATEGORIES = ['question', 'problem', 'suggestion', 'billing', 'account', 'other'] as const;
export const SUPPORT_STATUSES = ['open', 'answered', 'resolved'] as const;
export const SUPPORT_PRIORITIES = ['low', 'normal', 'high'] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const SUBJECT_MAX_LENGTH = 120;
export const MESSAGE_MAX_LENGTH = 4000;
/** Quantas solicitações não resolvidas uma mesma identidade pode ter. */
export const MAX_OPEN_TICKETS = 10;

const installIdSchema = z.string().min(8).max(128);

/** O que o app sabe de si mesmo: modelo, Android, versão. Sem dado pessoal. */
export const deviceInfoSchema = z
  .object({
    /** De onde a solicitação foi aberta. Ausente = app Android (versões antigas). */
    platform: z.enum(['android', 'ios', 'web']).optional(),
    model: z.string().trim().max(120).optional(),
    manufacturer: z.string().trim().max(80).optional(),
    osVersion: z.string().trim().max(40).optional(),
    sdkInt: z.number().int().nonnegative().optional(),
    appVersionCode: z.number().int().nonnegative().optional(),
    appVersionName: z.string().trim().max(40).optional(),
    locale: z.string().trim().max(16).optional(),
    timezone: z.string().trim().max(64).optional(),
  })
  .strict();

export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

/**
 * Diagnóstico livre (chave → valor simples), limitado em tamanho. O app
 * manda o estado local que ajuda a entender o problema: sessão, empresa,
 * assinatura, última sincronização, operações pendentes.
 */
export const diagnosticsSchema = z
  .record(z.string().max(60), z.union([z.string().max(300), z.number(), z.boolean(), z.null()]))
  .refine((value) => Object.keys(value).length <= 40, { message: 'Diagnóstico com campos demais.' });

export const createTicketBodySchema = z
  .object({
    installId: installIdSchema,
    subject: z.string().trim().min(1).max(SUBJECT_MAX_LENGTH),
    message: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
    category: z.enum(SUPPORT_CATEGORIES).default('question'),
    contactEmail: z.string().trim().max(254).email().transform((v) => v.toLowerCase()).nullable().optional(),
    contactName: z.string().trim().max(80).nullable().optional(),
    device: deviceInfoSchema.default({}),
    diagnostics: diagnosticsSchema.default({}),
  })
  .strict();

export type CreateTicketBody = z.infer<typeof createTicketBodySchema>;

export const identityQuerySchema = z.object({ installId: installIdSchema });
export const identityBodySchema = z.object({ installId: installIdSchema }).strict();

export const userMessageBodySchema = z
  .object({
    installId: installIdSchema,
    message: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
  })
  .strict();

export const ticketParamsSchema = z.object({ ticketId: z.string().uuid() });

// ---------------------------------------------------------------------------
// Painel
// ---------------------------------------------------------------------------

export const adminReplyBodySchema = z
  .object({
    body: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
    /** Nota interna: fica só no painel e não notifica o usuário. */
    internal: z.boolean().default(false),
  })
  .strict();

export const adminStatusBodySchema = z
  .object({
    status: z.enum(SUPPORT_STATUSES),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const adminTicketPatchSchema = z
  .object({
    priority: z.enum(SUPPORT_PRIORITIES).optional(),
    category: z.enum(SUPPORT_CATEGORIES).optional(),
    /** `me` assume o atendimento; `none` libera. */
    assign: z.enum(['me', 'none']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nada para alterar.' });

export const adminDraftBodySchema = z
  .object({
    instructions: z.string().trim().max(500).optional(),
  })
  .strict();

export const adminTicketListQuerySchema = z.object({
  status: z.enum([...SUPPORT_STATUSES, 'unresolved']).optional(),
  category: z.enum(SUPPORT_CATEGORIES).optional(),
  priority: z.enum(SUPPORT_PRIORITIES).optional(),
  assigned: z.enum(['me', 'none', 'any']).optional(),
  platform: z.enum(['android', 'web']).optional(),
  q: z.string().trim().max(200).optional(),
});
