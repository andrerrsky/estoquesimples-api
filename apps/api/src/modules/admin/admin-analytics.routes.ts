import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { ANALYTICS_EVENT_CATALOG, EVENT_NAME_PATTERN } from '../analytics/analytics.events.js';
import { AdminAnalyticsService } from './admin-analytics.service.js';
import { requireAdmin } from './admin-auth.plugin.js';
import { platformQuerySchema, rangeQuerySchema, resolveRange, seriesPointSchema } from './admin-series.js';
import { commonAdminErrors, paginationQuerySchema } from './admin.schemas.js';

export async function registerAdminAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new AdminAnalyticsService(app.services);
  // Recorte opcional de plataforma (Android × web), comum às consultas de uso.
  const rangeAndPlatformSchema = rangeQuerySchema.merge(platformQuerySchema);

  routes.get(
    '/analytics/summary',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Usuários ativos, séries, eventos mais usados e recorte por plataforma',
        hide: true,
        querystring: rangeAndPlatformSchema,
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.summary(resolveRange(request.query), request.query.platform),
  );

  routes.get(
    '/analytics/metrics',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Todas as métricas do registro, com o período anterior',
        hide: true,
        querystring: rangeAndPlatformSchema,
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.metrics(resolveRange(request.query), request.query.platform),
  );

  routes.get(
    '/analytics/events',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Explorador de eventos',
        hide: true,
        querystring: paginationQuerySchema.extend({
          name: z.string().regex(EVENT_NAME_PATTERN).max(80).optional(),
          userId: z.string().uuid().optional(),
          workspaceId: z.string().uuid().optional(),
          source: z.enum(['app', 'server']).optional(),
          platform: z.enum(['android', 'ios', 'web', 'server']).optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          q: z.string().trim().max(200).optional(),
        }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.events(request.query),
  );

  routes.get(
    '/analytics/event-names',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Eventos já recebidos e catálogo',
        hide: true,
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async () => service.eventNames(),
  );

  routes.get(
    '/analytics/events/:name/series',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Série temporal de um evento',
        hide: true,
        params: z.object({ name: z.string().regex(EVENT_NAME_PATTERN).max(80) }),
        querystring: rangeAndPlatformSchema.extend({ metric: z.enum(['events', 'users']).default('events') }),
        response: { 200: z.object({ name: z.string(), metric: z.string(), points: z.array(seriesPointSchema) }), ...commonAdminErrors },
      },
    },
    async (request) => ({
      name: request.params.name,
      metric: request.query.metric,
      points: await service.eventSeries(request.params.name, resolveRange(request.query), request.query.metric, request.query.platform),
    }),
  );

  routes.get(
    '/analytics/funnel',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Funil da instalação à assinatura',
        hide: true,
        querystring: rangeAndPlatformSchema,
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.funnel(resolveRange(request.query, 90), request.query.platform),
  );

  routes.get(
    '/analytics/retention',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Retenção por coorte semanal de cadastro',
        hide: true,
        querystring: z.object({ weeks: z.coerce.number().int().min(2).max(26).default(8) }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.retention(request.query.weeks),
  );

  routes.get(
    '/analytics/catalog',
    {
      preHandler: requireAdmin('viewer'),
      schema: { tags: ['admin'], summary: 'Catálogo de eventos', hide: true, response: { 200: z.any(), ...commonAdminErrors } },
    },
    async () => ({ events: ANALYTICS_EVENT_CATALOG }),
  );
}
