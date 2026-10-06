import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAuth } from '../../platform/http/authenticate.js';
import { inWorkspace, requireWorkspace, requireWorkspaceContext } from '../../platform/http/authorize.js';
import { AppError, ErrorCode, notFound } from '../../platform/http/errors.js';
import { errorSchema } from '../auth/auth.schemas.js';
import { BillingService } from '../billing/billing.service.js';
import { colorProblems, deriveTheme, FONTS } from './brand-rules.js';
import { BrandingService } from './branding.service.js';

const LOGO_MAX_UPLOAD_BYTES = 1_048_576;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use o formato #RRGGBB.');

export const brandingViewSchema = z.object({
  eligible: z.boolean(),
  active: z.boolean(),
  slug: z.string().nullable(),
  version: z.number().int(),
  displayName: z.string().nullable(),
  loginPath: z.string().nullable(),
  theme: z
    .object({
      primary: z.string(),
      primaryDark: z.string(),
      primaryPressed: z.string(),
      primarySoft: z.string(),
      primaryTint: z.string(),
      onPrimary: z.string(),
      accent: z.string(),
      text: z.string(),
      textMuted: z.string(),
      font: z.enum(['default', 'serif']),
    })
    .nullable(),
  logo: z.object({ url: z.string(), hash: z.string(), width: z.number().int(), height: z.number().int() }).nullable(),
});

const configSchema = z.object({
  slug: z.string().nullable(),
  primaryColor: z.string().nullable(),
  accentColor: z.string().nullable(),
  textColor: z.string().nullable(),
  font: z.enum(['default', 'serif']),
  logo: z.object({ url: z.string(), hash: z.string(), width: z.number().int(), height: z.number().int() }).nullable(),
  blocked: z.boolean(),
  blockedReason: z.string().nullable(),
  version: z.number().int(),
  updatedAt: z.string().nullable(),
});

const params = z.object({ workspaceId: z.string().uuid() });
const publicParams = z.object({ slug: z.string().min(1).max(64) });
const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema, 413: errorSchema, 415: errorSchema, 422: errorSchema, 429: errorSchema, 503: errorSchema };

/**
 * Identidade visual por empresa (docs/branding.md).
 *
 * Duas superfícies:
 *  - edição, autenticada e restrita a quem tem `marca.gerenciar` (proprietário
 *    e administrador), sempre dentro do contexto da empresa;
 *  - leitura pública da marca *ativa* de um identificador, só para a tela de
 *    entrada `/<slug>/entrar` (que ainda não tem sessão). Quem já entrou
 *    recebe a marca no retrato de direitos (`entitlement.branding`).
 */
export async function registerBrandingRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new BrandingService(app.services);
  const billing = new BillingService(app.services);
  const { env } = app.services;
  const security = [{ bearerAuth: [] }];

  app.addContentTypeParser(['image/webp', 'image/jpeg', 'image/png'], { parseAs: 'buffer', bodyLimit: LOGO_MAX_UPLOAD_BYTES }, (_request, body, done) => done(null, body));

  /** Direito ao recurso vem do plano em vigor, nunca do cliente. */
  const eligible = async (workspaceId: string): Promise<boolean> => (await billing.getEntitlement(workspaceId)).features['marca.personalizada']?.enabled ?? false;

  routes.get(
    '/workspaces/:workspaceId/branding',
    {
      preHandler: [app.authenticate, requireWorkspace('marca.gerenciar')],
      schema: {
        tags: ['marca'],
        summary: 'Configuração da identidade visual da empresa',
        description: 'Devolve o que está salvo (mesmo sem plano ativo), o que está sendo aplicado agora (`effective`) e uma sugestão de identificador.',
        security,
        params,
        response: { 200: z.object({ eligible: z.boolean(), config: configSchema, effective: brandingViewSchema, suggestedSlug: z.string() }), ...errors },
      },
    },
    async (request) => {
      const workspace = requireWorkspaceContext(request);
      const allowed = await eligible(workspace.workspaceId);
      return inWorkspace(request, (tx) => service.getForEditor(tx, workspace.workspaceId, allowed));
    },
  );

  routes.put(
    '/workspaces/:workspaceId/branding',
    {
      config: { rateLimit: { max: 60, timeWindow: env.RATE_LIMIT_WINDOW_MS } },
      preHandler: [app.authenticate, requireWorkspace('marca.gerenciar')],
      schema: {
        tags: ['marca'],
        summary: 'Salva a identidade visual (substitui a configuração)',
        description:
          'Cores `#RRGGBB` ou `null` (padrão do produto), fonte (`default` ou `serif`) e o identificador da URL de entrada. ' +
          'A API recusa cores sem contraste suficiente (422 `BRAND_INVALID`, com `extra.suggestions`) e identificadores reservados ou em uso (409 `BRAND_SLUG_TAKEN`). ' +
          'Exige plano com o recurso (403 `BRAND_NOT_IN_PLAN`).',
        security,
        params,
        body: z.object({ slug: z.string().trim().min(1).max(64), primaryColor: hex.nullable(), accentColor: hex.nullable(), textColor: hex.nullable(), font: z.enum(FONTS as [string, ...string[]]) as z.ZodType<'default' | 'serif'> }),
        response: { 200: configSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const workspace = requireWorkspaceContext(request);
      const allowed = await eligible(workspace.workspaceId);
      return inWorkspace(request, (tx) => service.update(tx, { workspaceId: workspace.workspaceId, userId: auth.userId, eligible: allowed, body: request.body }));
    },
  );

  routes.post(
    '/workspaces/:workspaceId/branding/preview',
    {
      config: { rateLimit: { max: 240, timeWindow: env.RATE_LIMIT_WINDOW_MS } },
      preHandler: [app.authenticate, requireWorkspace('marca.gerenciar')],
      schema: {
        tags: ['marca'],
        summary: 'Valida cores e devolve a paleta derivada, sem salvar',
        description: 'Fonte única das regras de contraste e da paleta: a tela de edição pré-visualiza com esta resposta em vez de reimplementar as regras no navegador.',
        security,
        params,
        body: z.object({ primaryColor: z.string().max(7).nullable(), accentColor: z.string().max(7).nullable(), textColor: z.string().max(7).nullable(), font: z.enum(FONTS as [string, ...string[]]) as z.ZodType<'default' | 'serif'> }),
        response: {
          200: z.object({
            valid: z.boolean(),
            problems: z.array(z.object({ field: z.enum(['primary', 'accent', 'text']), message: z.string(), suggestion: z.string().optional() })),
            theme: brandingViewSchema.shape.theme,
          }),
          ...errors,
        },
      },
    },
    async (request) => {
      const { primaryColor, accentColor, textColor, font } = request.body;
      const colors = { primary: primaryColor?.toLowerCase() ?? null, accent: accentColor?.toLowerCase() ?? null, text: textColor?.toLowerCase() ?? null };
      const problems = colorProblems(colors);
      return { valid: problems.length === 0, problems, theme: problems.length === 0 ? deriveTheme({ ...colors, font }) : null };
    },
  );

  routes.delete(
    '/workspaces/:workspaceId/branding',
    {
      preHandler: [app.authenticate, requireWorkspace('marca.gerenciar')],
      schema: {
        tags: ['marca'],
        summary: 'Volta ao visual padrão',
        description: 'Apaga cores, fonte e logotipo; mantém o identificador. Não exige plano ativo.',
        security,
        params,
        response: { 200: configSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const workspace = requireWorkspaceContext(request);
      return inWorkspace(request, (tx) => service.reset(tx, { workspaceId: workspace.workspaceId, userId: auth.userId }));
    },
  );

  routes.put(
    '/workspaces/:workspaceId/branding/logo',
    {
      bodyLimit: LOGO_MAX_UPLOAD_BYTES,
      config: { rateLimit: { max: 30, timeWindow: env.RATE_LIMIT_WINDOW_MS } },
      preHandler: [app.authenticate, requireWorkspace('marca.gerenciar')],
      schema: {
        tags: ['marca'],
        summary: 'Envia o logotipo da empresa',
        description:
          'Corpo = os bytes (`image/webp`, `image/jpeg` ou `image/png`, até 1 MiB). A API valida pelo conteúdo, reduz a no máximo 640 px e reescreve em WebP (com transparência) de até 256 KiB. ' +
          'Não consome a cota de fotos de produtos. Exige que o identificador já esteja definido.',
        security,
        params,
        response: { 200: configSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const workspace = requireWorkspaceContext(request);
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError(400, ErrorCode.IMAGE_INVALID, 'Envie o arquivo da imagem no corpo da requisição.');
      const allowed = await eligible(workspace.workspaceId);
      return inWorkspace(request, (tx) =>
        service.putLogo(tx, { workspaceId: workspace.workspaceId, userId: auth.userId, eligible: allowed, bytes: body, contentType: String(request.headers['content-type'] ?? '') }),
      );
    },
  );

  routes.delete(
    '/workspaces/:workspaceId/branding/logo',
    {
      preHandler: [app.authenticate, requireWorkspace('marca.gerenciar')],
      schema: { tags: ['marca'], summary: 'Remove o logotipo', security, params, response: { 200: configSchema, ...errors } },
    },
    async (request) => {
      const auth = requireAuth(request);
      const workspace = requireWorkspaceContext(request);
      return inWorkspace(request, (tx) => service.removeLogo(tx, { workspaceId: workspace.workspaceId, userId: auth.userId }));
    },
  );

  // -------------------------------------------------------------------------
  // Público
  // -------------------------------------------------------------------------

  routes.get(
    '/public/brand/:slug',
    {
      config: { rateLimit: { max: 120, timeWindow: env.RATE_LIMIT_WINDOW_MS } },
      schema: {
        tags: ['marca'],
        summary: 'Marca pública de um identificador (tela de entrada)',
        description:
          'Sem autenticação. `{ active: false }` para identificador inexistente, empresa sem plano, sem personalização ou bloqueada — indistinguíveis de propósito. ' +
          'Identificador antigo (trocado nos últimos 90 dias) responde com o atual em `slug`. Cache curto: perder o plano desliga a marca em até ~1 minuto.',
        params: publicParams,
        response: { 200: z.object({ active: z.boolean(), slug: z.string().nullable(), displayName: z.string().nullable(), version: z.number().int(), theme: brandingViewSchema.shape.theme, logo: brandingViewSchema.shape.logo }), 304: z.undefined(), 429: errorSchema },
      },
    },
    async (request, reply) => {
      const view = await service.resolvePublic(request.params.slug);
      const body = view
        ? { active: true, slug: view.slug, displayName: view.displayName, version: view.version, theme: view.theme, logo: view.logo }
        : { active: false, slug: null, displayName: null, version: 0, theme: null, logo: null };
      const etag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16)}"`;
      reply.header('ETag', etag).header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send(undefined);
      return body;
    },
  );

  routes.get(
    '/public/brand/:slug/logo',
    {
      config: { rateLimit: { max: 600, timeWindow: env.RATE_LIMIT_WINDOW_MS } },
      schema: {
        tags: ['marca'],
        summary: 'Logotipo público da empresa',
        description: 'WebP validado pela API. Com `?v=<hash>` igual ao atual o conteúdo é imutável (cache de um ano); sem ele, cache curto.',
        params: publicParams,
        querystring: z.object({ v: z.string().regex(/^[0-9a-f]{64}$/).optional() }),
        response: { 304: z.undefined(), 404: errorSchema, 429: errorSchema },
      },
    },
    async (request, reply) => {
      const logo = await service.readPublicLogo(request.params.slug);
      if (!logo) throw notFound('Logotipo não encontrado.');
      const etag = `"${logo.hash}"`;
      reply
        .header('ETag', etag)
        .header('Cache-Control', request.query.v === logo.hash ? 'public, max-age=31536000, immutable' : 'public, max-age=300')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cross-Origin-Resource-Policy', 'cross-origin');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send(undefined);
      return reply.header('Content-Type', logo.contentType).header('Content-Length', logo.bytes.length).send(logo.bytes as never);
    },
  );
}
