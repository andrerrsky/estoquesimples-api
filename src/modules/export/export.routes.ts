import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAuth } from '../../platform/http/authenticate.js';
import {
  inWorkspace,
  requireWorkspace,
  requireWorkspaceContext,
} from '../../platform/http/authorize.js';
import { errorSchema } from '../auth/auth.schemas.js';
import { backupFileSchema, exportQuerySchema } from './export.schemas.js';
import { ExportService } from './export.service.js';

const commonErrors = {
  400: errorSchema,
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  413: errorSchema,
};

const workspaceParams = z.object({ workspaceId: z.string().uuid() });

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const exporter = new ExportService();

  routes.get(
    '/workspaces/:workspaceId/export',
    {
      preHandler: [app.authenticate, requireWorkspace('produtos.ver')],
      schema: {
        tags: ['estoque'],
        summary: 'Extrai produtos e movimentações no JSON portátil',
        description:
          'Mesmo contrato do arquivo JSON do aplicativo (produtos + histórico). ' +
          'Exige permissão de visualização; não altera dados. ' +
          'Quem não vê movimentações recebe só o cadastro de produtos.',
        security: [{ bearerAuth: [] }],
        params: workspaceParams,
        querystring: exportQuerySchema,
        response: { 200: backupFileSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { workspaceId } = requireWorkspaceContext(request);
      const podeVerMovimentos = request.workspace?.permissions.has('movimentacoes.ver') ?? false;

      return inWorkspace(request, (tx) =>
        exporter.backup(
          tx,
          workspaceId,
          auth.userId,
          auth.deviceId,
          request.query,
          podeVerMovimentos,
        ),
      );
    },
  );

  app.get(
    '/workspaces/:workspaceId/export/produtos.csv',
    {
      preHandler: [app.authenticate, requireWorkspace('produtos.ver')],
      schema: {
        tags: ['estoque'],
        summary: 'Extrai o cadastro de produtos em CSV',
        security: [{ bearerAuth: [] }],
        params: workspaceParams,
        querystring: exportQuerySchema,
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { workspaceId } = requireWorkspaceContext(request);

      const query = exportQuerySchema.parse(request.query);
      const csv = await inWorkspace(request, (tx) =>
        exporter.productsCsv(tx, workspaceId, auth.userId, auth.deviceId, query),
      );

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="estoquesimples-produtos.csv"')
        .send(csv);
    },
  );

  app.get(
    '/workspaces/:workspaceId/export/movimentacoes.csv',
    {
      preHandler: [app.authenticate, requireWorkspace('movimentacoes.ver')],
      schema: {
        tags: ['estoque'],
        summary: 'Extrai o histórico de movimentações em CSV',
        security: [{ bearerAuth: [] }],
        params: workspaceParams,
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { workspaceId } = requireWorkspaceContext(request);

      const csv = await inWorkspace(request, (tx) =>
        exporter.movementsCsv(tx, workspaceId, auth.userId, auth.deviceId),
      );

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="estoquesimples-movimentacoes.csv"')
        .send(csv);
    },
  );
}

