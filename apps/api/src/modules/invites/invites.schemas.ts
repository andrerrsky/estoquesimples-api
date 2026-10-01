import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(254);

export const createInviteBodySchema = z
  .object({
    email,
    roleKey: z.enum(['administrador', 'gerente', 'operador', 'consulta']),
  })
  .strict();

export const inviteSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  roleKey: z.string(),
  status: z.enum(['pendente', 'aceito', 'cancelado', 'expirado']),
  invitedBy: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
  acceptedAt: z.string().nullable(),
});

export const invitesResponseSchema = z.object({
  invites: z.array(inviteSchema),
});

export const inviteTokenParamsSchema = z.object({
  /** Vem da URL do e-mail; o formato exato é assunto do servidor. */
  token: z.string().min(20).max(200),
});

/**
 * O que o convidado vê antes de decidir.
 *
 * Só o necessário para reconhecer o convite: nome da empresa, papel oferecido
 * e se ainda vale. Nada além disso, porque este endpoint é público e quem tem
 * o link pode não ser a pessoa convidada.
 */
export const invitePreviewSchema = z.object({
  workspaceName: z.string(),
  roleKey: z.string(),
  email: z.string(),
  expiresAt: z.string(),
  /** Verdadeiro quando já existe conta com este e-mail. */
  hasAccount: z.boolean(),
});

export const acceptInviteBodySchema = z
  .object({
    /**
     * Obrigatórios apenas para quem ainda não tem conta. Quem já tem aceita
     * autenticado, e a senha não é pedida de novo.
     */
    name: z.string().trim().min(1).max(120).optional(),
    password: z.string().min(8).max(200).optional(),
    device: z
      .object({
        installId: z.string().min(8).max(128),
        platform: z.enum(['android', 'ios', 'web']),
        model: z.string().max(120).optional(),
        osVersion: z.string().max(60).optional(),
        appVersionCode: z.number().int().nonnegative().optional(),
        appVersionName: z.string().max(40).optional(),
        syncProtocolVersion: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .strict();

export type CreateInviteBody = z.infer<typeof createInviteBodySchema>;
export type AcceptInviteBody = z.infer<typeof acceptInviteBodySchema>;
