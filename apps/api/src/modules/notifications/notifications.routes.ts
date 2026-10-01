import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAuth } from '../../platform/http/authenticate.js';
import { errorSchema, messageSchema } from '../auth/auth.schemas.js';
import { NotificationService } from './notifications.service.js';

const notificationSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  data: z.record(z.unknown()),
  workspaceId: z.string().uuid().nullable(),
  read: z.boolean(),
  createdAt: z.string(),
});

/**
 * Caixa de notificações do usuário autenticado. Sempre filtrada pelo
 * `userId` do token: não há identificador de outra pessoa que funcione aqui.
 */
export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new NotificationService(app.services);
  const errors = { 401: errorSchema, 404: errorSchema, 429: errorSchema };

  routes.get(
    '/notifications',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['notificações'],
        summary: 'Lista as notificações do usuário, mais recentes primeiro',
        security: [{ bearerAuth: [] }],
        querystring: z
          .object({
            unread: z.enum(['true', 'false']).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(30),
            before: z.string().datetime().optional(),
          })
          .strict(),
        response: {
          200: z.object({ items: z.array(notificationSchema), hasMore: z.boolean(), unread: z.number().int() }),
          ...errors,
        },
      },
    },
    async (request) =>
      service.list(requireAuth(request).userId, {
        unreadOnly: request.query.unread === 'true',
        limit: request.query.limit,
        before: request.query.before,
      }),
  );

  routes.get(
    '/notifications/unread-count',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['notificações'],
        summary: 'Quantas notificações não lidas',
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ unread: z.number().int() }), ...errors },
      },
    },
    async (request) => ({ unread: await service.unreadCount(requireAuth(request).userId) }),
  );

  routes.post(
    '/notifications/:notificationId/read',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['notificações'],
        summary: 'Marca uma notificação como lida',
        security: [{ bearerAuth: [] }],
        params: z.object({ notificationId: z.string().uuid() }),
        response: { 200: messageSchema, ...errors },
      },
    },
    async (request) => {
      await service.markRead(requireAuth(request).userId, request.params.notificationId);
      return { message: 'Notificação lida.' };
    },
  );

  routes.post(
    '/notifications/read-all',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['notificações'],
        summary: 'Marca todas as notificações como lidas',
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ updated: z.number().int() }), ...errors },
      },
    },
    async (request) => ({ updated: await service.markAllRead(requireAuth(request).userId) }),
  );
}
