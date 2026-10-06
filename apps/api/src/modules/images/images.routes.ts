import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAuth } from '../../platform/http/authenticate.js';
import { inWorkspace, requireWorkspace, requireWorkspaceContext } from '../../platform/http/authorize.js';
import { AppError, ErrorCode, forbidden, notFound } from '../../platform/http/errors.js';
import { errorSchema } from '../auth/auth.schemas.js';
import { assertCloudAccess } from '../billing/cloud-access.js';
import { Feature, limitOf } from '../billing/plan-limits.js';
import { ImageService } from './images.service.js';

const params = z.object({ workspaceId: z.string().uuid() });
const hashParams = params.extend({ hash: z.string().regex(/^[0-9a-f]{64}$/, 'Identificador de imagem inválido.') });

const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 413: errorSchema, 415: errorSchema, 422: errorSchema, 429: errorSchema, 503: errorSchema };

/**
 * Imagens dos produtos (docs/images.md).
 *
 * O bucket é privado e só a API conversa com ele. Quem pode ver ou enviar
 * uma imagem é decidido pelas mesmas regras do estoque: participação ativa
 * na empresa, papel (`produtos.*`) e plano. O identificador na URL é o hash
 * do conteúdo, mas só vale *dentro* da empresa da URL: a consulta sempre
 * inclui o `workspaceId` autenticado, então um hash de outra empresa é
 * simplesmente "não encontrado".
 */
export async function registerImageRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new ImageService(app.services);
  const { env } = app.services;
  const security = [{ bearerAuth: [] }];

  // O corpo do envio é o arquivo em si (sem multipart): menos código para
  // atacar e nenhum nome de arquivo para confiar. O limite vale por rota.
  app.addContentTypeParser(['image/webp', 'image/jpeg', 'image/png'], { parseAs: 'buffer', bodyLimit: env.IMAGE_MAX_UPLOAD_BYTES }, (_request, body, done) => done(null, body));

  routes.put(
    '/workspaces/:workspaceId/images',
    {
      bodyLimit: env.IMAGE_MAX_UPLOAD_BYTES,
      config: { rateLimit: { max: 120, timeWindow: env.RATE_LIMIT_WINDOW_MS } },
      preHandler: [app.authenticate, requireWorkspace()],
      schema: {
        tags: ['imagens'],
        summary: 'Envia a imagem de um produto',
        description:
          'Corpo = os bytes do arquivo (`image/webp`, `image/jpeg` ou `image/png`, até IMAGE_MAX_UPLOAD_BYTES). ' +
          'A API valida pelo conteúdo, reduz e reescreve em WebP se precisar, e devolve o `hash` que o produto passa a referenciar (`photoHash`). ' +
          'Idempotente: o mesmo arquivo devolve a mesma imagem. Exige poder criar ou editar produtos.',
        security,
        params,
        response: { 200: z.any(), 201: z.any(), ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const workspace = requireWorkspaceContext(request);
      if (!workspace.permissions.has('produtos.criar') && !workspace.permissions.has('produtos.editar')) {
        throw forbidden(ErrorCode.MISSING_PERMISSION, 'Você não tem permissão para enviar imagens de produtos.', { requiredPermission: 'produtos.editar', role: workspace.roleKey });
      }
      service.assertAvailable();
      const access = await assertCloudAccess(app.services, request);
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new AppError(400, ErrorCode.IMAGE_INVALID, 'Envie o arquivo da imagem no corpo da requisição.');
      }
      const result = await inWorkspace(request, (tx) =>
        service.upload(tx, {
          workspaceId: workspace.workspaceId,
          userId: auth.userId,
          bytes: body,
          contentType: String(request.headers['content-type'] ?? ''),
          quotaMb: limitOf(access.entitlement, Feature.IMAGES_MB),
          planKey: access.planKey,
        }),
      );
      return reply.code(result.created ? 201 : 200).send({ ...result.image, created: result.created });
    },
  );

  routes.get(
    '/workspaces/:workspaceId/images/:hash',
    {
      config: { rateLimit: { max: 1200, timeWindow: env.RATE_LIMIT_WINDOW_MS } },
      preHandler: [app.authenticate, requireWorkspace('produtos.ver')],
      schema: {
        tags: ['imagens'],
        summary: 'Baixa a imagem de um produto',
        description:
          'Conteúdo imutável (o identificador é o hash): `Cache-Control: private, immutable` por um ano e `ETag`; ' +
          'com `If-None-Match` a resposta é 304 sem tocar no armazenamento.',
        security,
        params: hashParams,
        // O corpo da resposta é o binário (ou 304 vazio): não passa pelo serializador JSON.
        response: { 304: z.undefined(), 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 429: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      const workspace = requireWorkspaceContext(request);
      const { hash } = request.params;
      await assertCloudAccess(app.services, request);

      const row = await inWorkspace(request, (tx) => service.find(tx, workspace.workspaceId, hash));
      if (!row) throw notFound('Imagem não encontrada.');

      const etag = `"${hash}"`;
      reply
        .header('ETag', etag)
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('X-Content-Type-Options', 'nosniff')
        // Mesmo que algo estranho chegasse ao bucket, o navegador não executa nem embute nada daqui.
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cross-Origin-Resource-Policy', 'same-origin');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send(undefined);

      const bytes = await service.read(workspace.workspaceId, hash);
      if (!bytes) {
        request.log.error({ workspaceId: workspace.workspaceId, hash }, 'imagem registrada no banco não existe no armazenamento');
        throw notFound('Imagem não encontrada.');
      }
      return reply.header('Content-Type', row.contentType).header('Content-Length', bytes.length).send(bytes as never);
    },
  );
}
