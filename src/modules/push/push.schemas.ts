import { z } from 'zod';

/** Telas que a notificação pode abrir; o app mapeia para a Activity. */
export const PUSH_SCREENS = ['main', 'history', 'reports', 'analysis', 'account', 'subscription', 'team', 'import'] as const;

export const pushActionSchema = z
  .object({
    screen: z.enum(PUSH_SCREENS).nullable().optional(),
    url: z.string().url().max(500).nullable().optional(),
  })
  .strict();

/**
 * Público de uma campanha. Resolvido na hora do envio, não na criação: uma
 * campanha agendada para amanhã deve atingir quem existe amanhã.
 */
export const audienceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }).strict(),
  z.object({ type: z.literal('signed_in') }).strict(),
  z.object({ type: z.literal('anonymous') }).strict(),
  z.object({ type: z.literal('subscription'), entitled: z.boolean() }).strict(),
  z.object({ type: z.literal('inactive'), days: z.number().int().min(3).max(365) }).strict(),
  z.object({ type: z.literal('app_version'), maxVersionCode: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('users'), emails: z.array(z.string().trim().email().max(254)).min(1).max(200) }).strict(),
  z.object({ type: z.literal('workspace'), workspaceId: z.string().uuid() }).strict(),
]);

export type Audience = z.infer<typeof audienceSchema>;

export const campaignBodySchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(500),
    action: pushActionSchema.default({}),
    audience: audienceSchema,
    /** Só aparelhos vistos nos últimos N dias (evita gastar cota com tokens mortos). */
    activeWithinDays: z.number().int().min(1).max(365).default(90),
  })
  .strict();

export type CampaignBody = z.infer<typeof campaignBodySchema>;

// ---------------------------------------------------------------------------
// Rotas públicas (app)
// ---------------------------------------------------------------------------

export const registerTokenBodySchema = z
  .object({
    token: z.string().min(20).max(4096),
    installId: z.string().min(8).max(128),
    platform: z.enum(['android', 'ios', 'web']).default('android'),
    appVersionCode: z.number().int().nonnegative().optional(),
    locale: z.string().max(16).optional(),
    notificationsEnabled: z.boolean().optional(),
  })
  .strict();

export const pushEventBodySchema = z
  .object({
    campaignId: z.string().uuid(),
    installId: z.string().min(8).max(128),
    event: z.enum(['delivered', 'opened']),
  })
  .strict();
