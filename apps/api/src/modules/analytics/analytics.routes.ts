import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { resolveAuth } from '../../platform/http/authenticate.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';
import { errorSchema } from '../auth/auth.schemas.js';
import { ANALYTICS_EVENT_CATALOG } from './analytics.events.js';
import { analyticsBatchBodySchema, analyticsBatchResponseSchema } from './analytics.schemas.js';
import { AnalyticsService } from './analytics.service.js';

/**
 * Entrada de eventos do app.
 *
 * Autenticação opcional de propósito: os primeiros eventos do funil
 * (abriu o app, viu o cadastro) acontecem antes de existir conta. Com o
 * Bearer, o evento é atribuído ao usuário; sem ele, fica só com o
 * `installId`. O que nunca acontece é aceitar um `userId` vindo do corpo.
 */
export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new AnalyticsService(app.services);
  const { env } = app.services;

  routes.post(
    '/analytics/events',
    {
      config: {
        rateLimit: {
          max: env.ANALYTICS_RATE_LIMIT_MAX,
          timeWindow: env.RATE_LIMIT_WINDOW_MS,
          // Esta rota não passa por `app.authenticate`, então o gerador de
          // chave global veria só o IP — atrás da borda do Railway, um único
          // IP para todo mundo. Verifica a assinatura do Bearer (sem ir ao
          // banco) para limitar por usuário; sem token, por IP.
          keyGenerator: async (request) => {
            const header = request.headers.authorization;
            if (header?.startsWith('Bearer ')) {
              try {
                const claims = await app.services.tokens.verifyAccessToken(header.slice('Bearer '.length).trim());
                return `user:${claims.sub}`;
              } catch {
                // Token inválido cai na cota anônima e é recusado logo abaixo.
              }
            }
            return `ip:${request.ip}`;
          },
        },
      },
      schema: {
        tags: ['analytics'],
        summary: 'Recebe um lote de eventos de uso do aplicativo',
        description:
          'Autenticação opcional: com Bearer o evento é atribuído ao usuário; sem ele, apenas à instalação. ' +
          'Reenviar um evento com o mesmo `id` é ignorado (idempotente).',
        body: analyticsBatchBodySchema,
        response: { 202: analyticsBatchResponseSchema, 400: errorSchema, 401: errorSchema, 429: errorSchema },
      },
    },
    async (request, reply) => {
      if (request.body.events.length > env.ANALYTICS_MAX_BATCH) {
        throw new AppError(
          400,
          ErrorCode.VALIDATION_FAILED,
          `Um lote pode ter no máximo ${env.ANALYTICS_MAX_BATCH} eventos.`,
          { extra: { maxBatch: env.ANALYTICS_MAX_BATCH } },
        );
      }

      // Token presente mas inválido é erro: silenciar faria o app achar que
      // os eventos foram atribuídos ao usuário quando não foram.
      const header = request.headers.authorization;
      const auth = header ? await resolveAuth(app.services, header) : null;

      const result = await service.ingestBatch(request.body, {
        userId: auth?.userId ?? null,
        deviceId: auth?.deviceId ?? null,
        ipAddress: request.ip || null,
      });
      return reply.code(202).send(result);
    },
  );

  routes.get(
    '/analytics/catalog',
    {
      schema: {
        tags: ['analytics'],
        summary: 'Catálogo de eventos reconhecidos pelo produto',
        response: {
          200: z.object({
            events: z.array(
              z.object({
                name: z.string(),
                source: z.enum(['app', 'server', 'both']),
                description: z.string(),
                properties: z.record(z.string()).optional(),
              }),
            ),
          }),
        },
      },
    },
    async () => ({ events: ANALYTICS_EVENT_CATALOG }),
  );
}
