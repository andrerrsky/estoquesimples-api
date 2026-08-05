import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAuth, resolveAuth } from '../../platform/http/authenticate.js';
import { requireWorkspace, requireWorkspaceContext } from '../../platform/http/authorize.js';
import { authSuccessSchema, errorSchema, messageSchema } from '../auth/auth.schemas.js';
import { requestMeta } from '../auth/auth.routes.js';
import { InvitesService } from './invites.service.js';
import {
  acceptInviteBodySchema,
  createInviteBodySchema,
  inviteSchema,
  inviteTokenParamsSchema,
  invitePreviewSchema,
  invitesResponseSchema,
} from './invites.schemas.js';

const commonErrors = {
  400: errorSchema,
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  410: errorSchema,
};

const workspaceParams = z.object({ workspaceId: z.string().uuid() });

export async function registerInviteRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new InvitesService(app.services);

  // Os endereços públicos de convite recebem o mesmo limite dos de login: sem
  // ele, o aceite viraria um oráculo para adivinhar tokens.
  const limitePublico = {
    rateLimit: {
      max: app.services.env.RATE_LIMIT_AUTH_MAX,
      timeWindow: app.services.env.RATE_LIMIT_WINDOW_MS,
    },
  };

  routes.post(
    '/workspaces/:workspaceId/invites',
    {
      preHandler: [app.authenticate, requireWorkspace('membros.convidar')],
      schema: {
        tags: ['equipe'],
        summary: 'Convida alguém para a empresa',
        description:
          'Reenviar para o mesmo e-mail invalida o convite anterior: só existe um link válido por pessoa.',
        security: [{ bearerAuth: [] }],
        params: workspaceParams,
        body: createInviteBodySchema,
        response: { 201: inviteSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const context = requireWorkspaceContext(request);
      const convite = await service.create(
        context.workspaceId,
        { userId: auth.userId, roleKey: context.roleKey, emailVerified: auth.emailVerified },
        request.body,
        requestMeta(request),
      );
      return reply.code(201).send(convite);
    },
  );

  routes.get(
    '/workspaces/:workspaceId/invites',
    {
      preHandler: [app.authenticate, requireWorkspace('membros.ver')],
      schema: {
        tags: ['equipe'],
        summary: 'Lista os convites da empresa',
        security: [{ bearerAuth: [] }],
        params: workspaceParams,
        response: { 200: invitesResponseSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const context = requireWorkspaceContext(request);
      return { invites: await service.list(context.workspaceId, auth.userId) };
    },
  );

  routes.delete(
    '/workspaces/:workspaceId/invites/:inviteId',
    {
      preHandler: [app.authenticate, requireWorkspace('membros.convidar')],
      schema: {
        tags: ['equipe'],
        summary: 'Cancela um convite pendente',
        security: [{ bearerAuth: [] }],
        params: workspaceParams.extend({ inviteId: z.string().uuid() }),
        response: { 200: messageSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const context = requireWorkspaceContext(request);
      await service.cancel(
        context.workspaceId,
        auth.userId,
        request.params.inviteId,
        requestMeta(request),
      );
      return { message: 'Convite cancelado.' };
    },
  );

  // ---------------------------------------------------------------------------
  // Rotas públicas: quem foi convidado ainda pode não ter conta
  // ---------------------------------------------------------------------------

  routes.get(
    '/invites/:token',
    {
      config: limitePublico,
      schema: {
        tags: ['equipe'],
        summary: 'Mostra os dados de um convite',
        params: inviteTokenParamsSchema,
        response: { 200: invitePreviewSchema, ...commonErrors },
      },
    },
    async (request) => service.preview(request.params.token),
  );

  routes.post(
    '/invites/:token/accept',
    {
      config: limitePublico,
      schema: {
        tags: ['equipe'],
        summary: 'Aceita um convite',
        description:
          'Quem já tem conta precisa enviar o Bearer token dela. Quem não tem cria nome e senha aqui e recebe uma sessão na resposta.',
        params: inviteTokenParamsSchema,
        body: acceptInviteBodySchema,
        response: {
          200: z.object({
            workspaceId: z.string().uuid(),
            roleKey: z.string(),
            /** Presente apenas quando a conta foi criada agora. */
            auth: authSuccessSchema.nullable(),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const header = request.headers.authorization;
      const autenticado = header
        ? await resolveAuth(app.services, header).then((auth) => ({
            userId: auth.userId,
            email: auth.email,
          }))
        : null;

      return service.accept(
        request.params.token,
        request.body,
        autenticado,
        requestMeta(request),
      );
    },
  );
}
