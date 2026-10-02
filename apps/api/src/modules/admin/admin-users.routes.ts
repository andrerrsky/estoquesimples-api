import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { emailSchema } from '../auth/auth.schemas.js';
import { adminActor, requireAdmin } from './admin-auth.plugin.js';
import { AdminUsersService } from './admin-users.service.js';
import {
  commonAdminErrors,
  messageSchema,
  paginatedSchema,
  paginationQuerySchema,
  reasonBodySchema,
  uuidParam,
} from './admin.schemas.js';

const userListItemSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  status: z.string(),
  emailVerified: z.boolean(),
  createdAt: z.string(),
  lastActivityAt: z.string().nullable(),
  workspacesCount: z.number().int(),
  hasActiveSubscription: z.boolean(),
  lockedUntil: z.string().nullable(),
  platforms: z.array(z.string()),
});

const noteSchema = z.object({
  id: z.string(),
  adminEmail: z.string(),
  body: z.string(),
  createdAt: z.string(),
});

export const timelineItemSchema = z.object({
  source: z.enum(['user', 'admin']),
  id: z.string(),
  action: z.string(),
  at: z.string(),
  actor: z.string().nullable(),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  metadata: z.record(z.unknown()),
  ip: z.string().nullable(),
});

export const eventItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  occurredAt: z.string(),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  platform: z.string(),
  appVersionCode: z.number().int().nullable(),
  source: z.string(),
  properties: z.record(z.unknown()),
  sessionKey: z.string().nullable(),
});

const userParams = uuidParam('userId');

export async function registerAdminUsersRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new AdminUsersService(app.services);

  routes.get(
    '/users',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Lista contas com busca e filtros',
        hide: true,
        querystring: paginationQuerySchema.extend({
          q: z.string().trim().max(200).optional(),
          status: z.enum(['active', 'suspended', 'pending_deletion']).optional(),
          emailVerified: z
            .enum(['true', 'false'])
            .optional()
            .transform((value) => (value === undefined ? undefined : value === 'true')),
          platform: z.enum(['android', 'ios', 'web']).optional(),
          sort: z.enum(['createdAt', 'lastActivityAt', 'name', 'email']).optional(),
          order: z.enum(['asc', 'desc']).optional(),
        }),
        response: { 200: paginatedSchema(userListItemSchema), ...commonAdminErrors },
      },
    },
    async (request) => service.list(request.query),
  );

  routes.get(
    '/users/:userId',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Detalhe completo de uma conta',
        hide: true,
        params: userParams,
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.get(request.params.userId),
  );

  routes.get(
    '/users/:userId/timeline',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Linha do tempo: auditoria da conta e ações do suporte sobre ela',
        hide: true,
        params: userParams,
        querystring: paginationQuerySchema,
        response: { 200: paginatedSchema(timelineItemSchema), ...commonAdminErrors },
      },
    },
    async (request) => service.timeline(request.params.userId, request.query),
  );

  routes.get(
    '/users/:userId/events',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Eventos de uso da conta',
        hide: true,
        params: userParams,
        querystring: paginationQuerySchema,
        response: { 200: paginatedSchema(eventItemSchema), ...commonAdminErrors },
      },
    },
    async (request) => service.events(request.params.userId, request.query),
  );

  routes.get(
    '/users/:userId/notifications',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Caixa de notificações da conta (app e web), somente leitura',
        hide: true,
        params: userParams,
        querystring: paginationQuerySchema,
        response: {
          200: paginatedSchema(
            z.object({
              id: z.string(),
              type: z.string(),
              title: z.string(),
              body: z.string(),
              workspaceId: z.string().nullable(),
              workspaceName: z.string().nullable(),
              readAt: z.string().nullable(),
              createdAt: z.string(),
            }),
          ).extend({ unread: z.number().int() }),
          ...commonAdminErrors,
        },
      },
    },
    async (request) => service.notifications(request.params.userId, request.query),
  );

  routes.patch(
    '/users/:userId',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Altera nome ou e-mail da conta',
        hide: true,
        params: userParams,
        body: z
          .object({
            name: z.string().trim().min(1).max(120).optional(),
            email: emailSchema.optional(),
            reason: z.string().trim().min(3).max(500),
          })
          .strict(),
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.update(adminActor(request), request.params.userId, request.body);
      return { message: 'Conta atualizada.' };
    },
  );

  // Ações com motivo obrigatório: o motivo vai para a auditoria.
  const reasonActions: Array<{
    path: string;
    summary: string;
    run: (actor: ReturnType<typeof adminActor>, userId: string, reason: string) => Promise<string>;
  }> = [
    {
      path: 'suspend',
      summary: 'Suspende a conta e encerra as sessões',
      run: async (actor, userId, reason) => {
        await service.suspend(actor, userId, reason);
        return 'Conta suspensa.';
      },
    },
    {
      path: 'reactivate',
      summary: 'Reativa uma conta suspensa',
      run: async (actor, userId, reason) => {
        await service.reactivate(actor, userId, reason);
        return 'Conta reativada.';
      },
    },
    {
      path: 'verify-email',
      summary: 'Marca o e-mail como confirmado',
      run: async (actor, userId, reason) => {
        await service.verifyEmail(actor, userId, reason);
        return 'E-mail confirmado.';
      },
    },
    {
      path: 'revoke-sessions',
      summary: 'Encerra todas as sessões da conta',
      run: async (actor, userId, reason) => {
        const revoked = await service.revokeSessions(actor, userId, reason);
        return `${revoked} sessão(ões) encerrada(s).`;
      },
    },
    {
      path: 'cancel-deletion',
      summary: 'Cancela a exclusão pendente da conta',
      run: async (actor, userId, reason) => {
        await service.cancelDeletion(actor, userId, reason);
        return 'Exclusão cancelada.';
      },
    },
  ];

  for (const item of reasonActions) {
    routes.post(
      `/users/:userId/${item.path}`,
      {
        preHandler: requireAdmin('support'),
        schema: {
          tags: ['admin'],
          summary: item.summary,
          hide: true,
          params: userParams,
          body: reasonBodySchema,
          response: { 200: messageSchema, ...commonAdminErrors },
        },
      },
      async (request) => ({
        message: await item.run(adminActor(request), request.params.userId, request.body.reason),
      }),
    );
  }

  routes.post(
    '/users/:userId/unlock',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Remove o bloqueio por tentativas de login',
        hide: true,
        params: userParams,
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.unlock(adminActor(request), request.params.userId);
      return { message: 'Bloqueio removido.' };
    },
  );

  routes.post(
    '/users/:userId/send-password-reset',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Envia o e-mail de redefinição de senha',
        hide: true,
        params: userParams,
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.sendPasswordReset(adminActor(request), request.params.userId);
      return { message: 'E-mail de redefinição enviado.' };
    },
  );

  routes.post(
    '/users/:userId/devices/:deviceId/revoke',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Revoga um dispositivo e encerra as sessões dele',
        hide: true,
        params: userParams.extend({ deviceId: z.string().uuid() }),
        body: reasonBodySchema,
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.revokeDevice(
        adminActor(request),
        request.params.userId,
        request.params.deviceId,
        request.body.reason,
      );
      return { message: 'Dispositivo revogado.' };
    },
  );

  // Notas de suporte ------------------------------------------------------

  routes.get(
    '/users/:userId/notes',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Notas de suporte da conta',
        hide: true,
        params: userParams,
        response: { 200: z.object({ items: z.array(noteSchema) }), ...commonAdminErrors },
      },
    },
    async (request) => ({ items: await service.listNotes({ userId: request.params.userId }) }),
  );

  routes.post(
    '/users/:userId/notes',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Adiciona uma nota de suporte',
        hide: true,
        params: userParams,
        body: z.object({ body: z.string().trim().min(1).max(4000) }).strict(),
        response: { 201: noteSchema, ...commonAdminErrors },
      },
    },
    async (request, reply) => {
      const note = await service.addNote(adminActor(request), { userId: request.params.userId }, request.body.body);
      return reply.code(201).send(note);
    },
  );

  routes.delete(
    '/notes/:noteId',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Remove uma nota de suporte',
        hide: true,
        params: uuidParam('noteId'),
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.deleteNote(adminActor(request), request.params.noteId);
      return { message: 'Nota removida.' };
    },
  );
}
