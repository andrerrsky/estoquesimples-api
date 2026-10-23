import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { resolveAuth } from '../../platform/http/authenticate.js';
import { errorSchema } from '../auth/auth.schemas.js';
import { recordError } from './error-log.js';

const clientErrorSchema = z.object({
  source: z.enum(['web', 'android', 'admin']),
  level: z.enum(['error', 'warning', 'fatal']).default('error'),
  /** exception, unhandled_rejection, crash, api (resposta 5xx), render, sync… */
  kind: z.string().trim().min(1).max(40),
  code: z.string().max(80).nullish(),
  message: z.string().max(2000),
  stack: z.string().max(16000).nullish(),
  route: z.string().max(300).nullish(),
  httpMethod: z.string().max(10).nullish(),
  status: z.number().int().min(0).max(999).nullish(),
  correlationId: z.string().max(80).nullish(),
  workspaceId: z.string().uuid().nullish(),
  appVersion: z.string().max(40).nullish(),
  platform: z.string().max(80).nullish(),
  occurredAt: z.number().int().positive().nullish(),
  context: z.record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional(),
});

/**
 * `POST /v1/client-errors`: a web, o web app, o painel e o app Android mandam
 * aqui os erros que acontecem do lado deles. Com ou sem login (um erro na
 * tela de entrada também importa); token vencido não impede o registro.
 */
export async function registerErrorRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    '/client-errors',
    {
      // Um cliente com defeito em laço não pode encher a tabela.
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
      bodyLimit: 64 * 1024,
      schema: {
        tags: ['observabilidade'],
        summary: 'Registra erros do app, da web ou do painel',
        body: z.object({ errors: z.array(clientErrorSchema).min(1).max(20) }),
        response: { 202: z.object({ accepted: z.number().int() }), 400: errorSchema, 429: errorSchema },
      },
    },
    async (request, reply) => {
      let userId: string | null = null;
      let deviceId: string | null = null;
      const header = request.headers.authorization;
      if (header) {
        try {
          const auth = await resolveAuth(app.services, header);
          userId = auth.userId;
          deviceId = auth.deviceId ?? null;
        } catch {
          // token vencido ou inválido: o erro entra sem a pessoa
        }
      }
      const userAgent = request.headers['user-agent'] ?? null;
      const now = Date.now();
      for (const item of request.body.errors) {
        // Relógio do aparelho muito errado: vale a hora de chegada.
        const occurred = item.occurredAt && Math.abs(now - item.occurredAt) < 7 * 86_400_000 ? new Date(item.occurredAt) : new Date();
        await recordError(app.services, {
          source: item.source,
          level: item.level,
          kind: item.kind,
          code: item.code ?? null,
          message: item.message,
          stack: item.stack ?? null,
          route: item.route ?? null,
          httpMethod: item.httpMethod ?? null,
          status: item.status ?? null,
          correlationId: item.correlationId ?? null,
          userId,
          deviceId,
          workspaceId: item.workspaceId ?? null,
          appVersion: item.appVersion ?? null,
          platform: item.platform ?? null,
          userAgent,
          occurredAt: occurred,
          context: { ...(item.context ?? {}), ip: request.ip || null },
        });
      }
      return reply.code(202).send({ accepted: request.body.errors.length });
    },
  );
}
