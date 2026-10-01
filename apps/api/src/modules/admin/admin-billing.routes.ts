import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { adminActor, requireAdmin } from './admin-auth.plugin.js';
import { AdminBillingService } from './admin-billing.service.js';
import {
  commonAdminErrors,
  messageSchema,
  paginationQuerySchema,
  uuidParam,
} from './admin.schemas.js';

export async function registerAdminBillingRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new AdminBillingService(app.services);

  routes.get(
    '/billing/stats',
    {
      preHandler: requireAdmin('viewer'),
      schema: { tags: ['admin'], summary: 'Contagens de assinaturas por estado', hide: true, response: { 200: z.any(), ...commonAdminErrors } },
    },
    async () => service.stats(),
  );

  routes.get(
    '/billing/subscriptions',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Lista assinaturas',
        hide: true,
        querystring: paginationQuerySchema.extend({
          q: z.string().trim().max(200).optional(),
          state: z.string().max(40).optional(),
          planKey: z.string().max(40).optional(),
          sort: z.enum(['createdAt', 'currentPeriodEnd', 'lastVerifiedAt']).optional(),
          order: z.enum(['asc', 'desc']).optional(),
        }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.list(request.query),
  );

  routes.get(
    '/billing/subscriptions/:subscriptionId',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Detalhe de uma assinatura com notificações e auditoria',
        hide: true,
        params: uuidParam('subscriptionId'),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.get(request.params.subscriptionId),
  );

  routes.post(
    '/billing/subscriptions/:subscriptionId/refresh',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Reconsulta o Google Play e atualiza o estado',
        hide: true,
        params: uuidParam('subscriptionId'),
        response: { 200: z.any(), ...commonAdminErrors, 502: z.any(), 503: z.any() },
      },
    },
    async (request) => service.refresh(adminActor(request), request.params.subscriptionId),
  );

  routes.get(
    '/billing/events',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Notificações recebidas do Google Play',
        hide: true,
        querystring: paginationQuerySchema.extend({
          onlyPending: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
          onlyErrors: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
        }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.events(request.query),
  );

  routes.post(
    '/billing/events/:eventId/retry',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Reprocessa uma notificação pendente',
        hide: true,
        params: uuidParam('eventId'),
        response: { 200: z.object({ outcome: z.enum(['processed', 'failed']), error: z.string().nullable() }), ...commonAdminErrors },
      },
    },
    async (request) => service.retryEvent(adminActor(request), request.params.eventId),
  );

  routes.get(
    '/billing/plans',
    {
      preHandler: requireAdmin('viewer'),
      schema: { tags: ['admin'], summary: 'Planos e recursos', hide: true, response: { 200: z.object({ items: z.array(z.any()) }), ...commonAdminErrors } },
    },
    async () => ({ items: await service.plans() }),
  );

  routes.patch(
    '/billing/plans/:planKey',
    {
      preHandler: requireAdmin('owner'),
      schema: {
        tags: ['admin'],
        summary: 'Altera nome, descrição ou situação de um plano',
        hide: true,
        params: z.object({ planKey: z.string().min(1).max(40) }),
        body: z
          .object({
            name: z.string().trim().min(1).max(80).optional(),
            description: z.string().trim().max(500).optional(),
            isActive: z.boolean().optional(),
            reason: z.string().trim().min(3).max(500),
          })
          .strict(),
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.updatePlan(adminActor(request), request.params.planKey, request.body);
      return { message: 'Plano atualizado.' };
    },
  );

  routes.put(
    '/billing/plans/:planKey/features/:featureKey',
    {
      preHandler: requireAdmin('owner'),
      schema: {
        tags: ['admin'],
        summary: 'Define um recurso do plano',
        hide: true,
        params: z.object({ planKey: z.string().min(1).max(40), featureKey: z.string().regex(/^[a-z0-9_.]{1,60}$/) }),
        body: z
          .object({
            enabled: z.boolean(),
            limit: z.number().int().nonnegative().nullable(),
            reason: z.string().trim().min(3).max(500),
          })
          .strict(),
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.updatePlanFeature(adminActor(request), request.params.planKey, request.params.featureKey, request.body);
      return { message: 'Recurso atualizado.' };
    },
  );
}
