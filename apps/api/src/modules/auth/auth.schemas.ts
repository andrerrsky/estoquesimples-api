import { z } from 'zod';

/**
 * Todos os schemas usam `.strict()`: um campo desconhecido no corpo é erro,
 * não algo ignorado em silêncio. É a proteção contra mass assignment — nunca
 * aceitamos `permissionVersion`, `status` ou `workspaceId` vindos do cliente.
 */

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('E-mail inválido.')
  .transform((value) => value.toLowerCase());

export const passwordSchema = z.string().min(1).max(200);

export const deviceInfoSchema = z
  .object({
    installId: z.string().min(8).max(128),
    platform: z.enum(['android', 'ios', 'web']).default('android'),
    model: z.string().max(120).optional(),
    osVersion: z.string().max(60).optional(),
    appVersionCode: z.number().int().nonnegative().optional(),
    appVersionName: z.string().max(40).optional(),
    syncProtocolVersion: z.number().int().positive().optional(),
  })
  .strict();

export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

export const registerBodySchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    name: z.string().trim().min(1).max(120),
    device: deviceInfoSchema.optional(),
  })
  .strict();

export const loginBodySchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    device: deviceInfoSchema.optional(),
  })
  .strict();

export const refreshBodySchema = z
  .object({
    refreshToken: z.string().min(20).max(512),
  })
  .strict();

export const logoutBodySchema = z
  .object({
    refreshToken: z.string().min(20).max(512).optional(),
  })
  .strict();

export const forgotPasswordBodySchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export const resetPasswordBodySchema = z
  .object({
    token: z.string().min(20).max(512),
    newPassword: passwordSchema,
  })
  .strict();

export const changePasswordBodySchema = z
  .object({
    currentPassword: passwordSchema,
    newPassword: passwordSchema,
    // Por padrão desloga os outros aparelhos: se a troca foi motivada por
    // suspeita de acesso indevido, manter as outras sessões vivas anularia o efeito.
    revokeOtherSessions: z.boolean().default(true),
  })
  .strict();

export const verifyEmailBodySchema = z
  .object({
    token: z.string().min(20).max(512),
  })
  .strict();

export const userPublicSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  createdAt: z.string(),
});

export const authSuccessSchema = z.object({
  accessToken: z.string(),
  /** Segundos até o access token expirar. */
  expiresIn: z.number().int(),
  refreshToken: z.string(),
  refreshExpiresAt: z.string(),
  sessionId: z.string().uuid(),
  deviceId: z.string().uuid().nullable(),
  user: userPublicSchema,
});

export const messageSchema = z.object({ message: z.string() });

/**
 * `passthrough` é essencial aqui: alguns erros carregam campos próprios que o
 * cliente precisa ler (`retryAfterSeconds` num bloqueio, `serverCursor` num
 * pedido de ressincronização). Sem ele o serializador removeria exatamente a
 * informação que torna o erro acionável.
 */
export const errorSchema = z.object({
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.array(z.object({ field: z.string().optional(), message: z.string() })).optional(),
      correlationId: z.string().optional(),
    })
    .passthrough(),
});

export const sessionSummarySchema = z.object({
  id: z.string().uuid(),
  current: z.boolean(),
  deviceId: z.string().uuid().nullable(),
  deviceModel: z.string().nullable(),
  appVersionName: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  expiresAt: z.string(),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type AuthSuccess = z.infer<typeof authSuccessSchema>;
