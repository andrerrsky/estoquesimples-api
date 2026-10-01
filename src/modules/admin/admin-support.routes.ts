import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  adminDraftBodySchema,
  adminReplyBodySchema,
  adminStatusBodySchema,
  adminTicketListQuerySchema,
  adminTicketPatchSchema,
  ticketParamsSchema,
} from '../support/support.schemas.js';
import { SupportService } from '../support/support.service.js';
import { adminActor, requireAdmin } from './admin-auth.plugin.js';
import { commonAdminErrors, paginationQuerySchema } from './admin.schemas.js';

/**
 * Atendimento de suporte no painel: fila, conversa, resposta (com push ao
 * usuário), notas internas, estado, prioridade e responsável. Responder em
 * nome do produto exige papel `support`.
 */
export async function registerAdminSupportRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new SupportService(app.services);

  routes.get(
    '/support/stats',
    {
      preHandler: requireAdmin('viewer'),
      schema: { tags: ['admin'], summary: 'Fila de suporte em números', hide: true, response: { 200: z.any(), ...commonAdminErrors } },
    },
    async () => service.stats(),
  );

  routes.get(
    '/support/tickets',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Lista solicitações de suporte',
        hide: true,
        querystring: paginationQuerySchema.merge(adminTicketListQuerySchema),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.list(adminActor(request), request.query),
  );

  routes.get(
    '/support/tickets/:ticketId',
    {
      preHandler: requireAdmin('viewer'),
      schema: { tags: ['admin'], summary: 'Solicitação com conversa, aparelho e diagnóstico', hide: true, params: ticketParamsSchema, response: { 200: z.any(), ...commonAdminErrors } },
    },
    async (request) => service.get(request.params.ticketId),
  );

  routes.post(
    '/support/tickets/:ticketId/messages',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Responde ao usuário (push) ou registra nota interna',
        hide: true,
        params: ticketParamsSchema,
        body: adminReplyBodySchema,
        response: { 201: z.any(), ...commonAdminErrors },
      },
    },
    async (request, reply) => {
      const result = await service.reply(adminActor(request), request.params.ticketId, request.body.body, request.body.internal);
      return reply.code(201).send(result);
    },
  );

  routes.post(
    '/support/tickets/:ticketId/status',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Resolve, reabre ou devolve à fila',
        hide: true,
        params: ticketParamsSchema,
        body: adminStatusBodySchema,
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.setStatus(adminActor(request), request.params.ticketId, request.body.status, request.body.note),
  );

  routes.patch(
    '/support/tickets/:ticketId',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Prioridade, categoria e responsável',
        hide: true,
        params: ticketParamsSchema,
        body: adminTicketPatchSchema,
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.update(adminActor(request), request.params.ticketId, request.body),
  );

  routes.post(
    '/support/tickets/:ticketId/draft',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Gera um rascunho de resposta com a OpenAI (não envia)',
        hide: true,
        params: ticketParamsSchema,
        body: adminDraftBodySchema,
        response: { 200: z.object({ text: z.string(), model: z.string() }), ...commonAdminErrors, 502: z.any() },
      },
    },
    async (request) => service.draft(adminActor(request), request.params.ticketId, request.body.instructions),
  );
}
