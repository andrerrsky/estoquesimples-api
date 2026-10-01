import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { resolveAuth } from '../../platform/http/authenticate.js';
import { errorSchema } from '../auth/auth.schemas.js';
import {
  createTicketBodySchema,
  identityBodySchema,
  identityQuerySchema,
  SUPPORT_CATEGORIES,
  ticketParamsSchema,
  userMessageBodySchema,
} from './support.schemas.js';
import { SupportService, type SupportIdentity } from './support.service.js';

/**
 * Suporte pelo app.
 *
 * Autenticação opcional, como no analytics e no push: quem não tem conta
 * também precisa de ajuda. Toda chamada leva o `installId`; com Bearer a
 * solicitação é da pessoa, sem ele é da instalação. Token presente mas
 * inválido é erro (401), nunca rebaixado para anônimo.
 */
export async function registerSupportRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new SupportService(app.services);
  const { env } = app.services;

  const limit = (max: number) => ({
    config: {
      rateLimit: {
        max,
        timeWindow: env.RATE_LIMIT_WINDOW_MS,
        keyGenerator: async (request: { headers: { authorization?: string }; ip: string }) => {
          const header = request.headers.authorization;
          if (header?.startsWith('Bearer ')) {
            try {
              const claims = await app.services.tokens.verifyAccessToken(header.slice('Bearer '.length).trim());
              return `user:${claims.sub}`;
            } catch {
              // token inválido cai na cota por IP e é recusado na rota
            }
          }
          return `ip:${request.ip}`;
        },
      },
    },
  });

  async function identity(request: { headers: { authorization?: string } }, installId: string): Promise<SupportIdentity> {
    const header = request.headers.authorization;
    const auth = header ? await resolveAuth(app.services, header) : null;
    return { userId: auth?.userId ?? null, installId, deviceId: auth?.deviceId ?? null };
  }

  routes.get(
    '/support/categories',
    {
      schema: {
        tags: ['support'],
        summary: 'Categorias de solicitação de suporte',
        response: { 200: z.object({ categories: z.array(z.object({ key: z.string(), label: z.string() })) }) },
      },
    },
    async () => ({
      categories: SUPPORT_CATEGORIES.map((key) => ({
        key,
        label: { question: 'Dúvida', problem: 'Problema', suggestion: 'Sugestão', billing: 'Assinatura e pagamento', account: 'Conta e sincronização', other: 'Outro' }[key],
      })),
    }),
  );

  routes.post(
    '/support/tickets',
    {
      ...limit(10),
      schema: {
        tags: ['support'],
        summary: 'Abre uma solicitação de suporte',
        description:
          'Com Bearer a solicitação pertence ao usuário; sem, à instalação (`installId`). ' +
          'Envie `device` (modelo, Android, versão do app) e `diagnostics` (estado local) para ajudar o atendimento.',
        body: createTicketBodySchema,
        response: { 201: z.any(), 400: errorSchema, 401: errorSchema, 409: errorSchema, 429: errorSchema },
      },
    },
    async (request, reply) => {
      const who = await identity(request, request.body.installId);
      const ticket = await service.createTicket(who, request.body);
      return reply.code(201).send(ticket);
    },
  );

  routes.get(
    '/support/tickets',
    {
      ...limit(env.ANALYTICS_RATE_LIMIT_MAX),
      schema: {
        tags: ['support'],
        summary: 'Lista as solicitações do usuário (ou da instalação)',
        querystring: identityQuerySchema,
        response: { 200: z.object({ tickets: z.array(z.any()) }), 401: errorSchema, 429: errorSchema },
      },
    },
    async (request) => service.listForUser(await identity(request, request.query.installId)),
  );

  routes.get(
    '/support/tickets/:ticketId',
    {
      ...limit(env.ANALYTICS_RATE_LIMIT_MAX),
      schema: {
        tags: ['support'],
        summary: 'Conversa de uma solicitação (marca como lida)',
        params: ticketParamsSchema,
        querystring: identityQuerySchema,
        response: { 200: z.object({ ticket: z.any(), messages: z.array(z.any()) }), 401: errorSchema, 404: errorSchema, 429: errorSchema },
      },
    },
    async (request) => service.getForUser(await identity(request, request.query.installId), request.params.ticketId),
  );

  routes.post(
    '/support/tickets/:ticketId/messages',
    {
      ...limit(30),
      schema: {
        tags: ['support'],
        summary: 'Escreve na solicitação (reabre se estava resolvida)',
        params: ticketParamsSchema,
        body: userMessageBodySchema,
        response: { 201: z.any(), 400: errorSchema, 401: errorSchema, 404: errorSchema, 429: errorSchema },
      },
    },
    async (request, reply) => {
      const result = await service.addUserMessage(await identity(request, request.body.installId), request.params.ticketId, request.body.message);
      return reply.code(201).send(result);
    },
  );

  routes.post(
    '/support/tickets/:ticketId/resolve',
    {
      ...limit(30),
      schema: {
        tags: ['support'],
        summary: 'Usuário marca a solicitação como resolvida',
        params: ticketParamsSchema,
        body: identityBodySchema,
        response: { 200: z.any(), 401: errorSchema, 404: errorSchema, 429: errorSchema },
      },
    },
    async (request) => service.resolveByUser(await identity(request, request.body.installId), request.params.ticketId),
  );
}
