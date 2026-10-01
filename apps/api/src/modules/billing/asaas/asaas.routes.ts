import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAuth } from '../../../platform/http/authenticate.js';
import { requireWorkspace, requireWorkspaceContext } from '../../../platform/http/authorize.js';
import { AppError, ErrorCode } from '../../../platform/http/errors.js';
import { errorSchema } from '../../auth/auth.schemas.js';
import { requestMeta } from '../../auth/auth.routes.js';
import { AsaasBillingService } from './asaas-billing.service.js';

const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema, 429: errorSchema, 503: errorSchema };

const checkoutBodySchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    cpfCnpj: z.string().trim().min(11).max(20),
    email: z.string().trim().max(254).email().optional(),
    mobilePhone: z
      .string()
      .trim()
      .max(20)
      .regex(/^[\d\s()+-]{10,20}$/u, 'Telefone inválido.')
      .optional(),
    cycle: z.enum(['MONTHLY', 'YEARLY']),
    billingType: z.enum(['UNDEFINED', 'PIX', 'BOLETO', 'CREDIT_CARD']).default('UNDEFINED'),
  })
  .strict();

/**
 * Assinatura pela web (Asaas).
 *
 * As rotas da empresa exigem `assinatura.gerenciar` (proprietário) para
 * contratar e cancelar; a consulta aceita `assinatura.ver`. O webhook é
 * público por natureza e autenticado pelo token que o próprio Asaas envia.
 */
export async function registerAsaasRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new AsaasBillingService(app.services);
  const { env } = app.services;

  const strict = { config: { rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_WINDOW_MS } } };

  routes.get(
    '/workspaces/:workspaceId/billing/web',
    {
      preHandler: [app.authenticate, requireWorkspace('assinatura.ver')],
      schema: {
        tags: ['assinatura'],
        summary: 'Plano, assinatura e cobranças da empresa (visão da web)',
        security: [{ bearerAuth: [] }],
        params: z.object({ workspaceId: z.string().uuid() }),
        response: { 200: z.any(), ...errors },
      },
    },
    async (request) => service.overview(requireWorkspaceContext(request).workspaceId),
  );

  routes.post(
    '/workspaces/:workspaceId/billing/web/checkout',
    {
      ...strict,
      preHandler: [app.authenticate, requireWorkspace('assinatura.gerenciar')],
      schema: {
        tags: ['assinatura'],
        summary: 'Contrata o plano pela web e devolve a fatura a pagar',
        description:
          'Cria o pagador e a assinatura no Asaas e devolve a URL da fatura hospedada. ' +
          'Repetir a chamada com a assinatura ainda pendente devolve a mesma cobrança.',
        security: [{ bearerAuth: [] }],
        params: z.object({ workspaceId: z.string().uuid() }),
        body: checkoutBodySchema,
        response: { 200: z.any(), ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const context = requireWorkspaceContext(request);
      return service.startCheckout(context.workspaceId, auth.userId, request.body, requestMeta(request));
    },
  );

  routes.post(
    '/workspaces/:workspaceId/billing/web/refresh',
    {
      ...strict,
      preHandler: [app.authenticate, requireWorkspace('assinatura.ver')],
      schema: {
        tags: ['assinatura'],
        summary: 'Reconsulta o provedor (após voltar da página de pagamento)',
        security: [{ bearerAuth: [] }],
        params: z.object({ workspaceId: z.string().uuid() }),
        response: { 200: z.any(), ...errors },
      },
    },
    async (request) => {
      const { workspaceId } = requireWorkspaceContext(request);
      const overview = await service.overview(workspaceId);
      if (overview.subscription?.provider === 'asaas') {
        await service.refreshSubscription(overview.subscription.id);
        return service.overview(workspaceId);
      }
      return overview;
    },
  );

  routes.post(
    '/workspaces/:workspaceId/billing/web/cancel',
    {
      ...strict,
      preHandler: [app.authenticate, requireWorkspace('assinatura.gerenciar')],
      schema: {
        tags: ['assinatura'],
        summary: 'Cancela a renovação; o acesso vale até o fim do período pago',
        security: [{ bearerAuth: [] }],
        params: z.object({ workspaceId: z.string().uuid() }),
        response: { 200: z.any(), ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const context = requireWorkspaceContext(request);
      return service.cancel(context.workspaceId, auth.userId, requestMeta(request));
    },
  );

  routes.post(
    '/billing/webhooks/asaas',
    {
      config: { rateLimit: { max: 600, timeWindow: env.RATE_LIMIT_WINDOW_MS } },
      schema: {
        tags: ['assinatura'],
        summary: 'Webhook do Asaas (cobranças e assinaturas)',
        description: 'Autenticado pelo cabeçalho `asaas-access-token`. Idempotente pelo id do evento.',
        body: z.record(z.unknown()),
        response: { 200: z.object({ received: z.boolean() }), 401: errorSchema, 503: errorSchema },
      },
    },
    async (request) => {
      if (!env.ASAAS_WEBHOOK_TOKEN) {
        // Sem token configurado não há como confiar em nada que chegue aqui.
        throw new AppError(503, ErrorCode.BILLING_UNAVAILABLE, 'Webhook do Asaas não configurado.');
      }
      const header = request.headers['asaas-access-token'];
      if (!service.isWebhookTokenValid(typeof header === 'string' ? header : undefined)) {
        throw new AppError(401, ErrorCode.AUTH_REQUIRED, 'Token do webhook inválido.');
      }
      // Sempre 200 depois de autenticado: o evento ficou gravado e, se o
      // processamento falhou, a reconciliação retoma. Qualquer outra resposta
      // faria o Asaas reenviar e, após 15 falhas, pausar a fila inteira.
      await service.handleWebhook(request.body);
      return { received: true };
    },
  );
}
