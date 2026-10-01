import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAdmin } from './admin-auth.plugin.js';
import { AdminOverviewService } from './admin-overview.service.js';
import { seriesPointSchema } from './admin-series.js';
import { commonAdminErrors } from './admin.schemas.js';

const overviewSchema = z.object({
  generatedAt: z.string(),
  kpis: z.record(z.number()),
  series: z.record(z.array(seriesPointSchema)),
  alerts: z.array(z.object({ nome: z.string(), detalhe: z.string() })),
  recentUsers: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
      createdAt: z.string(),
      emailVerified: z.boolean(),
    }),
  ),
  recentSubscriptionChanges: z.array(
    z.object({
      subscriptionId: z.string().nullable(),
      workspaceId: z.string().nullable(),
      workspaceName: z.string().nullable(),
      from: z.string().nullable(),
      to: z.string().nullable(),
      at: z.string(),
    }),
  ),
  recentAdminActions: z.array(
    z.object({
      id: z.string(),
      adminEmail: z.string(),
      action: z.string(),
      targetType: z.string().nullable(),
      targetId: z.string().nullable(),
      at: z.string(),
    }),
  ),
});

export async function registerAdminOverviewRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new AdminOverviewService(app.services);

  routes.get(
    '/overview',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Retrato da plataforma: indicadores, séries e alertas',
        hide: true,
        response: { 200: overviewSchema, ...commonAdminErrors },
      },
    },
    async () => service.overview(),
  );
}
