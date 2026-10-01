import type { FastifyInstance } from 'fastify';

import { registerAdminAnalyticsRoutes } from './admin-analytics.routes.js';
import { registerAdminAuditRoutes } from './admin-audit.routes.js';
import { registerAdminAuthRoutes } from './admin-auth.routes.js';
import { registerAdminBillingRoutes } from './admin-billing.routes.js';
import { registerAdminOpsRoutes } from './admin-ops.routes.js';
import { registerAdminOverviewRoutes } from './admin-overview.routes.js';
import { registerAdminPushRoutes } from './admin-push.routes.js';
import { registerAdminReviewsRoutes } from './admin-reviews.routes.js';
import { registerAdminStatic } from './admin-static.js';
import { registerAdminUsersRoutes } from './admin-users.routes.js';
import { registerAdminWorkspacesRoutes } from './admin-workspaces.routes.js';

/**
 * Painel administrativo, montado em /admin.
 *
 *   /admin/api/...  API do painel (JSON, cookie de sessão, papéis)
 *   /admin/...      interface (SPA)
 *
 * Toda rota da API passa por `requireAdmin(papel)`; nenhuma reutiliza o
 * Bearer do app. O que muda dado de cliente exige papel `support`, o que
 * administra o próprio painel exige `owner`.
 */
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (api) => {
      await api.register(registerAdminAuthRoutes);
      await api.register(registerAdminOverviewRoutes);
      await api.register(registerAdminUsersRoutes);
      await api.register(registerAdminWorkspacesRoutes);
      await api.register(registerAdminBillingRoutes);
      await api.register(registerAdminAnalyticsRoutes);
      await api.register(registerAdminAuditRoutes);
      await api.register(registerAdminOpsRoutes);
      await api.register(registerAdminReviewsRoutes);
      await api.register(registerAdminPushRoutes);
    },
    { prefix: '/api' },
  );

  await app.register(registerAdminStatic);
}
