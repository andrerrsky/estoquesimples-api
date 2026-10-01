import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAuth } from '../../platform/http/authenticate.js';
import { inWorkspace, requireWorkspace, requireWorkspaceContext } from '../../platform/http/authorize.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';
import { errorSchema, messageSchema } from '../auth/auth.schemas.js';
import { assertCloudAccess } from '../billing/cloud-access.js';
import { Feature, featureEnabled } from '../billing/plan-limits.js';
import {
  bulkBodySchema,
  bulkCancelBodySchema,
  cancelMovementBodySchema,
  createMovementBodySchema,
  createProductBodySchema,
  importBodySchema,
  listMovementsQuerySchema,
  listProductsQuerySchema,
  movementParams,
  productParams,
  reportQuerySchema,
  updateProductBodySchema,
  workspaceParams,
} from './inventory.schemas.js';
import { InventoryService, type InventoryContext } from './inventory.service.js';
import { DEFAULT_UNITS } from './units.js';

const errors = {
  400: errorSchema,
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  429: errorSchema,
  503: errorSchema,
};

/**
 * API de estoque para a aplicação web: leitura paginada e escrita que passa
 * pelo motor de sincronização.
 *
 * Toda rota exige sessão, participação ativa na empresa, a permissão do
 * papel e o plano (a mesma guarda da sincronização do app: nuvem liberada
 * e, sem o recurso de equipe, só o proprietário).
 */
export async function registerInventoryRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new InventoryService();

  async function context(request: FastifyRequest): Promise<InventoryContext> {
    const auth = requireAuth(request);
    const workspace = requireWorkspaceContext(request);
    const access = await assertCloudAccess(app.services, request);
    return {
      workspaceId: workspace.workspaceId,
      userId: auth.userId,
      permissions: workspace.permissions,
      plan: { productLimit: access.productLimit, planKey: access.planKey },
    };
  }

  const read = (permission: string) => [app.authenticate, requireWorkspace(permission)];
  const security = [{ bearerAuth: [] }];

  // -------------------------------------------------------------------------
  // Produtos
  // -------------------------------------------------------------------------

  routes.get(
    '/workspaces/:workspaceId/products',
    {
      preHandler: read('produtos.ver'),
      schema: {
        tags: ['estoque'],
        summary: 'Lista produtos com busca, filtros e paginação',
        security,
        params: workspaceParams,
        querystring: listProductsQuerySchema,
        response: { 200: z.any(), ...errors },
      },
    },
    async (request) => {
      const ctx = await context(request);
      return inWorkspace(request, (tx) => service.listProducts(tx, ctx.workspaceId, request.query));
    },
  );

  routes.get(
    '/workspaces/:workspaceId/products/facets',
    {
      preHandler: read('produtos.ver'),
      schema: {
        tags: ['estoque'],
        summary: 'Categorias, fornecedores, unidades e locais já usados',
        security,
        params: workspaceParams,
        response: { 200: z.any(), ...errors },
      },
    },
    async (request) => {
      const ctx = await context(request);
      const facets = await inWorkspace(request, (tx) => service.facets(tx, ctx.workspaceId));
      return { ...facets, defaultUnits: DEFAULT_UNITS };
    },
  );

  routes.get(
    '/workspaces/:workspaceId/products/:productId',
    {
      preHandler: read('produtos.ver'),
      schema: { tags: ['estoque'], summary: 'Um produto', security, params: productParams, response: { 200: z.any(), ...errors } },
    },
    async (request) => {
      const ctx = await context(request);
      return inWorkspace(request, (tx) => service.getProduct(tx, ctx.workspaceId, request.params.productId));
    },
  );

  routes.post(
    '/workspaces/:workspaceId/products',
    {
      preHandler: read('produtos.criar'),
      schema: {
        tags: ['estoque'],
        summary: 'Cadastra um produto (e a movimentação de cadastro do estoque inicial)',
        description: 'Envie `id` (UUID gerado no cliente) para que repetir a requisição não duplique o produto.',
        security,
        params: workspaceParams,
        body: createProductBodySchema,
        response: { 201: z.any(), ...errors },
      },
    },
    async (request, reply) => {
      const ctx = await context(request);
      const product = await inWorkspace(request, (tx) => service.createProduct(tx, ctx, request.body));
      return reply.code(201).send(product);
    },
  );

  routes.route({
    method: ['PATCH', 'PUT'],
    url: '/workspaces/:workspaceId/products/:productId',
    preHandler: read('produtos.editar'),
    schema: {
      tags: ['estoque'],
      summary: 'Edita um produto',
      description:
        'Envie só os campos alterados e o `rev` que a tela carregou. Edição concorrente de campos diferentes é mesclada; ' +
        'do mesmo campo (nome ou preço) volta 409 `SYNC_CONFLICT` com a versão atual. Alterar `quantity.target` registra um ajuste.',
      security,
      params: productParams,
      body: updateProductBodySchema,
      response: { 200: z.any(), ...errors },
    },
    handler: async (request) => {
      const ctx = await context(request);
      return inWorkspace(request, (tx) => service.updateProduct(tx, ctx, request.params.productId, request.body));
    },
  });

  routes.delete(
    '/workspaces/:workspaceId/products/:productId',
    {
      preHandler: read('produtos.excluir'),
      schema: {
        tags: ['estoque'],
        summary: 'Exclui um produto (o histórico permanece)',
        security,
        params: productParams,
        response: { 200: messageSchema, ...errors },
      },
    },
    async (request) => {
      const ctx = await context(request);
      await inWorkspace(request, (tx) => service.deleteProduct(tx, ctx, request.params.productId));
      return { message: 'Produto excluído.' };
    },
  );

  routes.post(
    '/workspaces/:workspaceId/products/:productId/restore',
    {
      preHandler: read('produtos.excluir'),
      schema: {
        tags: ['estoque'],
        summary: 'Desfaz a exclusão de um produto',
        security,
        params: productParams,
        response: { 200: z.any(), ...errors },
      },
    },
    async (request) => {
      const ctx = await context(request);
      return inWorkspace(request, (tx) => service.restoreProduct(tx, ctx, request.params.productId));
    },
  );

  routes.post(
    '/workspaces/:workspaceId/products/bulk',
    {
      preHandler: read('produtos.editar'),
      schema: {
        tags: ['estoque'],
        summary: 'Edição em massa: ajuste de quantidade, categoria ou fornecedor',
        security,
        params: workspaceParams,
        body: bulkBodySchema,
        response: { 200: z.any(), ...errors },
      },
    },
    async (request) => {
      const ctx = await context(request);
      return inWorkspace(request, (tx) => service.bulk(tx, ctx, request.body));
    },
  );

  routes.post(
    '/workspaces/:workspaceId/products/import',
    {
      bodyLimit: app.services.env.SYNC_BODY_LIMIT_BYTES,
      preHandler: read('produtos.criar'),
      schema: {
        tags: ['estoque'],
        summary: 'Importa uma planilha de produtos já interpretada pelo cliente',
        description: 'Casa por id, SKU, código de barras e nome, nessa ordem. Até 1000 linhas por chamada.',
        security,
        params: workspaceParams,
        body: importBodySchema,
        response: { 200: z.any(), ...errors },
      },
    },
    async (request) => {
      const ctx = await context(request);
      return inWorkspace(request, (tx) => service.importRows(tx, ctx, request.body.rows));
    },
  );

  // -------------------------------------------------------------------------
  // Movimentações
  // -------------------------------------------------------------------------

  routes.get(
    '/workspaces/:workspaceId/movements',
    {
      preHandler: read('movimentacoes.ver'),
      schema: {
        tags: ['estoque'],
        summary: 'Histórico de movimentações, mais recentes primeiro',
        security,
        params: workspaceParams,
        querystring: listMovementsQuerySchema,
        response: { 200: z.any(), ...errors },
      },
    },
    async (request) => {
      const ctx = await context(request);
      return inWorkspace(request, (tx) => service.listMovements(tx, ctx.workspaceId, request.query));
    },
  );

  routes.post(
    '/workspaces/:workspaceId/movements',
    {
      // A permissão fina (entrada ou saída) é conferida pelo motor de
      // sincronização a partir do tipo; aqui basta poder ver movimentações.
      preHandler: read('movimentacoes.ver'),
      schema: {
        tags: ['estoque'],
        summary: 'Registra uma entrada ou saída',
        description: 'A saída é recusada (409) se deixaria o estoque negativo.',
        security,
        params: workspaceParams,
        body: createMovementBodySchema,
        response: { 201: z.any(), ...errors },
      },
    },
    async (request, reply) => {
      const ctx = await context(request);
      const result = await inWorkspace(request, (tx) => service.createMovement(tx, ctx, request.body));
      return reply.code(201).send(result);
    },
  );

  routes.post(
    '/workspaces/:workspaceId/movements/:movementId/cancel',
    {
      preHandler: read('movimentacoes.cancelar'),
      schema: {
        tags: ['estoque'],
        summary: 'Estorna uma movimentação com um evento compensatório',
        security,
        params: movementParams,
        body: cancelMovementBodySchema,
        response: { 201: z.any(), ...errors },
      },
    },
    async (request, reply) => {
      const ctx = await context(request);
      const result = await inWorkspace(request, (tx) => service.cancelMovement(tx, ctx, request.params.movementId, request.body.note));
      return reply.code(201).send(result);
    },
  );

  routes.post(
    '/workspaces/:workspaceId/movements/bulk-cancel',
    {
      preHandler: read('movimentacoes.cancelar'),
      schema: {
        tags: ['estoque'],
        summary: 'Estorna várias movimentações (desfazer um ajuste em massa)',
        security,
        params: workspaceParams,
        body: bulkCancelBodySchema,
        response: { 200: z.any(), ...errors },
      },
    },
    async (request) => {
      const ctx = await context(request);
      return inWorkspace(request, (tx) => service.bulkCancel(tx, ctx, request.body.movementIds, request.body.note));
    },
  );

  // -------------------------------------------------------------------------
  // Relatórios e análise
  // -------------------------------------------------------------------------

  routes.get(
    '/workspaces/:workspaceId/reports/summary',
    {
      preHandler: read('produtos.ver'),
      schema: {
        tags: ['estoque'],
        summary: 'Resumo do estoque e das movimentações do período',
        security,
        params: workspaceParams,
        querystring: reportQuerySchema,
        response: { 200: z.any(), ...errors },
      },
    },
    async (request) => {
      const ctx = await context(request);
      return inWorkspace(request, (tx) => service.reportSummary(tx, ctx.workspaceId, request.query.period));
    },
  );

  routes.get(
    '/workspaces/:workspaceId/reports/analysis',
    {
      preHandler: read('produtos.ver'),
      schema: {
        tags: ['estoque'],
        summary: 'Análise Avançada: consumo, previsão de esgotamento e giro (plano Equipe)',
        security,
        params: workspaceParams,
        response: { 200: z.any(), ...errors },
      },
    },
    async (request) => {
      const ctx = await context(request);
      const access = await assertCloudAccess(app.services, request);
      if (!featureEnabled(access.entitlement, Feature.ANALYSIS)) {
        throw new AppError(403, ErrorCode.SUBSCRIPTION_REQUIRED, 'A Análise Avançada faz parte do plano Equipe.', {
          extra: { feature: Feature.ANALYSIS, planKey: access.planKey },
        });
      }
      return inWorkspace(request, (tx) => service.analysis(tx, ctx.workspaceId));
    },
  );
}
