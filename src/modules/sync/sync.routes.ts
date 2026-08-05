import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAuth } from '../../platform/http/authenticate.js';
import {
  inWorkspace,
  requireWorkspace,
  requireWorkspaceContext,
} from '../../platform/http/authorize.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';
import { errorSchema } from '../auth/auth.schemas.js';
import { BillingService } from '../billing/billing.service.js';
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
   */
  async function assertCanSync(workspaceId: string, protocolHeader: unknown): Promise<void> {
    if (!env.FEATURE_SYNC_ENABLED) {
      throw new AppError(
        503,
        ErrorCode.SYNC_DISABLED,
        'A sincronização está temporariamente desativada. Seus dados seguem no aparelho.',
      );
    }

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
    if (!entitlement.active) {
      throw new AppError(
        403,
        ErrorCode.SUBSCRIPTION_REQUIRED,
        'A assinatura da empresa não está ativa. Nada foi apagado do aparelho.',
        { extra: { state: entitlement.state } },
      );
    }
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
      await assertCanSync(workspaceId, request.headers['x-sync-protocol']);

      const result = await inWorkspace(request, (tx) =>
        uploads.start(tx, workspaceId, auth.userId, request.body),
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
      await assertCanSync(workspaceId, request.headers['x-sync-protocol']);

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
        uploads.applyBatch(tx, workspaceId, uploadId, auth.userId, request.body),
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
      await assertCanSync(workspaceId, request.headers['x-sync-protocol']);

      return inWorkspace(request, (tx) =>
        uploads.complete(tx, workspaceId, uploadId, request.body),
      );
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
      await assertCanSync(workspaceId, request.headers['x-sync-protocol']);

      const contexto = requireWorkspaceContext(request);

      return inWorkspace(request, (tx) =>
        sync.push(tx, workspaceId, auth.userId, auth.deviceId, contexto.permissions, request.body),
      );
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
      await assertCanSync(workspaceId, request.headers['x-sync-protocol']);

      return inWorkspace(request, (tx) =>
        sync.pull(
          tx,
          workspaceId,
          auth.userId,
          auth.deviceId,
          request.query,
          env.SYNC_DEFAULT_PAGE_SIZE,
        ),
      );
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
      await assertCanSync(workspaceId, request.headers['x-sync-protocol']);

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
      await assertCanSync(workspaceId, request.headers['x-sync-protocol']);

      return inWorkspace(request, (tx) =>
        conflicts.resolve(tx, workspaceId, auth.userId, conflictId, request.body.escolha),
      );
    },
  );
}
