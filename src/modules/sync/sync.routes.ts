import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAuth } from '../../platform/http/authenticate.js';
import {
  inWorkspace,
  requireWorkspace,
  requireWorkspaceContext,
} from '../../platform/http/authorize.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';
import { trackServerEvent } from '../analytics/analytics.service.js';
import { errorSchema } from '../auth/auth.schemas.js';
import { BillingService, type EntitlementSnapshot } from '../billing/billing.service.js';
import { Feature, featureEnabled, limitOf } from '../billing/plan-limits.js';
import { ConflictsService } from './conflicts.service.js';
import { InitialUploadService } from './initial-upload.service.js';
import { SyncService } from './sync.service.js';
import {
  completeUploadBodySchema,
  completeUploadResponseSchema,
  conflictsQuerySchema,
  conflictsResponseSchema,
  pullQuerySchema,
  pullResponseSchema,
  pushBodySchema,
  pushResponseSchema,
  resolveConflictBodySchema,
  resolveConflictResponseSchema,
  startUploadBodySchema,
  startUploadResponseSchema,
  uploadBatchBodySchema,
  uploadBatchResponseSchema,
} from './sync.schemas.js';

const commonErrors = {
  400: errorSchema,
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  426: errorSchema,
};

const workspaceParams = z.object({ workspaceId: z.string().uuid() });
const uploadParams = workspaceParams.extend({ uploadId: z.string().uuid() });
const conflictParams = workspaceParams.extend({ conflictId: z.string().uuid() });

export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const uploads = new InitialUploadService();
  const sync = new SyncService();
  const conflicts = new ConflictsService();
  const billing = new BillingService(app.services);
  const { env } = app.services;
  // Lotes de sync passam do bodyLimit global (1 MB). Sem isto, um push
  // legítimo de 500 operações com descrições recebe 413.
  const syncBodyLimit = { bodyLimit: env.SYNC_BODY_LIMIT_BYTES };

  /**
   * Guardas comuns a toda rota de sincronização.
   *
   * A versão do protocolo é conferida antes de qualquer coisa. Sem essa
   * checagem, um app antigo enviaria dados num formato que o servidor
   * interpretaria pela metade — e o resultado seria corrupção silenciosa em
   * vez de um erro que o usuário entende.
   *
   * O plano é conferido no servidor, nunca a partir do que o app diz. A nuvem
   * é grátis para quem tem conta (plano gratuito), mas só para o proprietário:
   * a equipe faz parte da assinatura. O teto de produtos é aplicado adiante,
   * no envio, porque depende do conteúdo do lote.
   *
   * O workspaceId vem do contexto já autorizado, não do parâmetro cru da URL.
   */
  async function assertCanSync(request: FastifyRequest): Promise<EntitlementSnapshot> {
    const { workspaceId, isOwner } = requireWorkspaceContext(request);

    if (!env.FEATURE_SYNC_ENABLED) {
      throw new AppError(
        503,
        ErrorCode.SYNC_DISABLED,
        'A sincronização está temporariamente desativada. Seus dados seguem no aparelho.',
      );
    }

    const protocolHeader = request.headers['x-sync-protocol'];
    const clientProtocol = Number(protocolHeader ?? 0);
    if (
      !Number.isInteger(clientProtocol) ||
      clientProtocol < env.SYNC_PROTOCOL_MIN_SUPPORTED ||
      clientProtocol > env.SYNC_PROTOCOL_VERSION
    ) {
      throw new AppError(
        426,
        ErrorCode.SYNC_PROTOCOL_UNSUPPORTED,
        'Atualize o aplicativo para continuar sincronizando.',
        {
          extra: {
            serverProtocolVersion: env.SYNC_PROTOCOL_VERSION,
            minSupportedProtocolVersion: env.SYNC_PROTOCOL_MIN_SUPPORTED,
          },
        },
      );
    }

    const entitlement = await billing.getEntitlement(workspaceId);
    if (!entitlement.syncAllowed) {
      throw new AppError(
        403,
        ErrorCode.SUBSCRIPTION_REQUIRED,
        'A sincronização na nuvem não está disponível para esta empresa. Nada foi apagado do aparelho.',
        { extra: { state: entitlement.state, planKey: entitlement.planKey } },
      );
    }
    if (!isOwner && !featureEnabled(entitlement, Feature.MEMBERS)) {
      throw new AppError(
        403,
        ErrorCode.SUBSCRIPTION_REQUIRED,
        'Esta empresa está no plano gratuito, que sincroniza só para o proprietário. ' +
          'Peça a ele para assinar o plano Equipe. Nada foi apagado do aparelho.',
        { extra: { state: entitlement.state, planKey: entitlement.planKey, feature: Feature.MEMBERS } },
      );
    }
    return entitlement;
  }

  routes.post(
    '/workspaces/:workspaceId/sync/initial-upload',
    {
      ...syncBodyLimit,
      preHandler: [app.authenticate, requireWorkspace('produtos.criar')],
      schema: {
        tags: ['sincronizacao'],
        summary: 'Abre (ou retoma) o envio inicial do banco do aparelho',
        description:
          'Chamar de novo com uma sessão aberta devolve a mesma sessão e o índice do próximo lote, ' +
          'permitindo retomar um envio interrompido.',
        security: [{ bearerAuth: [] }],
        params: workspaceParams,
        body: startUploadBodySchema,
        response: { 201: startUploadResponseSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { workspaceId } = request.params;
      const entitlement = await assertCanSync(request);
      const productLimit = limitOf(entitlement, Feature.PRODUCTS);

      const result = await inWorkspace(request, (tx) =>
        uploads.start(tx, workspaceId, auth.userId, request.body, { productLimit, planKey: entitlement.planKey }),
      );
      return reply.code(201).send(result);
    },
  );

  routes.post(
    '/workspaces/:workspaceId/sync/initial-upload/:uploadId/batch',
    {
      ...syncBodyLimit,
      preHandler: [app.authenticate, requireWorkspace('produtos.criar')],
      schema: {
        tags: ['sincronizacao'],
        summary: 'Envia um lote de registros',
        description:
          'Reenviar um lote é um no-op: a resposta traz `duplicate: true` e nada é aplicado de novo.',
        security: [{ bearerAuth: [] }],
        params: uploadParams,
        body: uploadBatchBodySchema,
        response: { 200: uploadBatchResponseSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { workspaceId, uploadId } = request.params;
      const entitlement = await assertCanSync(request);
      const productLimit = limitOf(entitlement, Feature.PRODUCTS);

      const itens = request.body.products.length + request.body.movements.length;
      if (itens > env.SYNC_MAX_BATCH_ITEMS) {
        throw new AppError(
          400,
          ErrorCode.SYNC_BATCH_TOO_LARGE,
          `Um lote pode ter no máximo ${env.SYNC_MAX_BATCH_ITEMS} registros.`,
          { extra: { maxBatchItems: env.SYNC_MAX_BATCH_ITEMS, received: itens } },
        );
      }

      return inWorkspace(request, (tx) =>
        uploads.applyBatch(tx, workspaceId, uploadId, auth.userId, request.body, { productLimit, planKey: entitlement.planKey }),
      );
    },
  );

  routes.post(
    '/workspaces/:workspaceId/sync/initial-upload/:uploadId/complete',
    {
      ...syncBodyLimit,
      preHandler: [app.authenticate, requireWorkspace('produtos.criar')],
      schema: {
        tags: ['sincronizacao'],
        summary: 'Conclui o envio inicial e devolve o cursor',
        description:
          'Recusa concluir se ainda faltarem registros (nomes duplicados, lotes perdidos). ' +
          'Reenvie os lotes pendentes antes de selar o workspace.',
        security: [{ bearerAuth: [] }],
        params: uploadParams,
        body: completeUploadBodySchema,
        response: { 200: completeUploadResponseSchema, ...commonErrors },
      },
    },
    async (request) => {
      const { workspaceId, uploadId } = request.params;
      await assertCanSync(request);

      const auth = requireAuth(request);
      const result = await inWorkspace(request, (tx) =>
        uploads.complete(tx, workspaceId, uploadId, request.body),
      );
      await trackServerEvent(app.services, {
        name: 'sync.initial_upload_completed',
        userId: auth.userId,
        workspaceId,
        deviceId: auth.deviceId,
        properties: { products: result.products, movements: result.movements },
      });
      return result;
    },
  );

  routes.post(
    '/workspaces/:workspaceId/sync/push',
    {
      ...syncBodyLimit,
      preHandler: [app.authenticate, requireWorkspace('sync.executar')],
      schema: {
        tags: ['sincronizacao'],
        summary: 'Envia as alterações feitas no aparelho',
        description:
          'Cada operação é resolvida por conta própria e volta com a própria situação. Uma ' +
          'rejeitada não impede as outras. Reenviar uma já processada devolve o status original com `replayed: true`.',
        security: [{ bearerAuth: [] }],
        params: workspaceParams,
        body: pushBodySchema,
        response: { 200: pushResponseSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { workspaceId } = request.params;
      const entitlement = await assertCanSync(request);

      const contexto = requireWorkspaceContext(request);

      const result = await inWorkspace(request, (tx) =>
        sync.push(tx, workspaceId, auth.userId, auth.deviceId, contexto.permissions, request.body, {
          productLimit: limitOf(entitlement, Feature.PRODUCTS),
          planKey: entitlement.planKey,
        }),
      );
      const contagem = { aplicada: 0, duplicada: 0, conflito: 0, rejeitada: 0 };
      for (const item of result.results) contagem[item.status] += 1;
      await trackServerEvent(app.services, {
        name: 'sync.pushed',
        userId: auth.userId,
        workspaceId,
        deviceId: auth.deviceId,
        properties: {
          operations: result.results.length,
          applied: contagem.aplicada,
          duplicated: contagem.duplicada,
          conflicts: contagem.conflito,
          rejected: contagem.rejeitada,
        },
      });
      return result;
    },
  );

  routes.get(
    '/workspaces/:workspaceId/sync/pull',
    {
      preHandler: [app.authenticate, requireWorkspace('sync.executar')],
      schema: {
        tags: ['sincronizacao'],
        summary: 'Baixa o que mudou desde o cursor informado',
        description:
          'As alterações vêm em ordem de `changeSeq` e devem ser aplicadas nessa ordem. ' +
          'Um cursor velho demais recebe SYNC_RESYNC_REQUIRED e exige recarga completa.',
        security: [{ bearerAuth: [] }],
        params: workspaceParams,
        querystring: pullQuerySchema,
        response: { 200: pullResponseSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { workspaceId } = request.params;
      await assertCanSync(request);

      const result = await inWorkspace(request, (tx) =>
        sync.pull(
          tx,
          workspaceId,
          auth.userId,
          auth.deviceId,
          request.query,
          env.SYNC_DEFAULT_PAGE_SIZE,
        ),
      );
      // Um evento por sequência de leitura: só a última página conta, e só
      // quando trouxe algo (ou é a primeira leitura do aparelho). Polls vazios
      // de rotina e páginas intermediárias inflariam o número sem dizer nada.
      if (!result.hasMore && (result.changes.length > 0 || request.query.cursor === 0)) {
        await trackServerEvent(app.services, {
          name: 'sync.pulled',
          userId: auth.userId,
          workspaceId,
          deviceId: auth.deviceId,
          properties: { changes: result.changes.length, hasMore: result.hasMore },
        });
      }
      return result;
    },
  );

  routes.get(
    '/workspaces/:workspaceId/conflicts',
    {
      preHandler: [app.authenticate, requireWorkspace('conflitos.ver')],
      schema: {
        tags: ['sincronizacao'],
        summary: 'Lista os conflitos registrados',
        description:
          'Os de situação `automatico` já foram resolvidos pelo servidor e ficam apenas para ' +
          'consulta; `pendente` são os que esperam uma decisão.',
        security: [{ bearerAuth: [] }],
        params: workspaceParams,
        querystring: conflictsQuerySchema,
        response: { 200: conflictsResponseSchema, ...commonErrors },
      },
    },
    async (request) => {
      const { workspaceId } = request.params;
      await assertCanSync(request);

      return inWorkspace(request, async (tx) => {
        const lista = await conflicts.list(tx, workspaceId, request.query);
        return { ...lista, pending: await conflicts.pendingCount(tx, workspaceId) };
      });
    },
  );

  routes.post(
    '/workspaces/:workspaceId/conflicts/:conflictId/resolve',
    {
      preHandler: [app.authenticate, requireWorkspace('conflitos.resolver')],
      schema: {
        tags: ['sincronizacao'],
        summary: 'Registra a decisão sobre um conflito',
        security: [{ bearerAuth: [] }],
        params: conflictParams,
        body: resolveConflictBodySchema,
        response: { 200: resolveConflictResponseSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { workspaceId, conflictId } = request.params;
      await assertCanSync(request);

      const result = await inWorkspace(request, (tx) =>
        conflicts.resolve(tx, workspaceId, auth.userId, conflictId, request.body.escolha),
      );
      await trackServerEvent(app.services, {
        name: 'sync.conflict_resolved',
        userId: auth.userId,
        workspaceId,
        deviceId: auth.deviceId,
        properties: { choice: request.body.escolha },
      });
      return result;
    },
  );
}
