import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { resolveAuth } from '../../platform/http/authenticate.js';
import { errorSchema, messageSchema } from '../auth/auth.schemas.js';
import { pushEventBodySchema, registerTokenBodySchema } from './push.schemas.js';
import { PushService } from './push.service.js';

/**
 * Rotas do app para push: registrar o token do aparelho e reportar entrega
 * e abertura. Autenticação opcional, como no analytics: sem conta o token
 * fica só com a instalação e ainda recebe campanhas "para todos".
 */
export async function registerPushRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new PushService(app.services);
  const { env } = app.services;
  const limit = { config: { rateLimit: { max: env.ANALYTICS_RATE_LIMIT_MAX, timeWindow: env.RATE_LIMIT_WINDOW_MS } } };

  routes.put(
    '/push/tokens',
    {
      ...limit,
      schema: {
        tags: ['push'],
        summary: 'Registra ou atualiza o token FCM do aparelho',
        description: 'Com Bearer o token é vinculado ao usuário; sem, fica só com a instalação. Chame ao obter o token, ao abrir o app e após login.',
        body: registerTokenBodySchema,
        response: { 200: messageSchema, 400: errorSchema, 401: errorSchema, 429: errorSchema },
      },
    },
    async (request) => {
      const header = request.headers.authorization;
      const auth = header ? await resolveAuth(app.services, header) : null;
      await service.registerToken({
        ...request.body,
        userId: auth?.userId ?? null,
        deviceId: auth?.deviceId ?? null,
      });
      return { message: 'Token registrado.' };
    },
  );

  routes.post(
    '/push/events',
    {
      ...limit,
      schema: {
        tags: ['push'],
        summary: 'Reporta que uma notificação foi recebida ou aberta',
        body: pushEventBodySchema,
        response: { 200: z.object({ recorded: z.boolean() }), 400: errorSchema, 429: errorSchema },
      },
    },
    async (request) => ({ recorded: await service.recordEvent(request.body) }),
  );
}
