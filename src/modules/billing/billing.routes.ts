import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAuth } from '../../platform/http/authenticate.js';
import { requireWorkspace, requireWorkspaceContext } from '../../platform/http/authorize.js';
import { unauthorized, ErrorCode } from '../../platform/http/errors.js';
import { errorSchema } from '../auth/auth.schemas.js';
import { requestMeta } from '../auth/auth.routes.js';
import { BillingService } from './billing.service.js';

const commonErrors = {
  400: errorSchema,
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  502: errorSchema,
  503: errorSchema,
};

const entitlementSchema = z.object({
  workspaceId: z.string().uuid(),
  active: z.boolean(),
  planKey: z.string(),
  state: z.string(),
  currentPeriodEnd: z.string().nullable(),
  graceUntil: z.string().nullable(),
  autoRenewing: z.boolean(),
  features: z.record(z.object({ enabled: z.boolean(), limit: z.number().int().nullable() })),
  offlineValidUntil: z.string(),
  checkedAt: z.string(),
});

/**
 * Envelope de uma mensagem push do Pub/Sub. O campo `data` traz a notificação
 * do Google em base64.
 */
const pubsubEnvelopeSchema = z.object({
  message: z.object({
    data: z.string().optional(),
    messageId: z.string().optional(),
    message_id: z.string().optional(),
    publishTime: z.string().optional(),
    attributes: z.record(z.string()).optional(),
  }),
  subscription: z.string().optional(),
});

interface DeveloperNotification {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: {
    version?: string;
    notificationType?: number;
    purchaseToken?: string;
    subscriptionId?: string;
  };
  oneTimeProductNotification?: { purchaseToken?: string; sku?: string; notificationType?: number };
  testNotification?: { version?: string };
}

function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export async function registerBillingRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new BillingService(app.services);
  const { env } = app.services;

  routes.get(
    '/workspaces/:workspaceId/entitlement',
    {
      preHandler: [app.authenticate, requireWorkspace()],
      schema: {
        tags: ['assinatura'],
        summary: 'Direitos atuais da empresa',
        description:
          'O aplicativo guarda este retrato e continua sincronizando sem rede até `offlineValidUntil`.',
        security: [{ bearerAuth: [] }],
        params: z.object({ workspaceId: z.string().uuid() }),
        response: { 200: entitlementSchema, ...commonErrors },
      },
    },
    async (request) => {
      const context = requireWorkspaceContext(request);
      return service.getEntitlement(context.workspaceId);
    },
  );

  routes.post(
    '/workspaces/:workspaceId/billing/subscriptions',
    {
      preHandler: [app.authenticate, requireWorkspace('assinatura.gerenciar')],
      schema: {
        tags: ['assinatura'],
        summary: 'Vincula um comprovante de compra do Google Play à empresa',
        description:
          'O comprovante é validado na Play Developer API; o conteúdo enviado pelo aplicativo nunca é aceito como verdade. ' +
          'Um comprovante já vinculado a outra empresa é recusado com 409.',
        security: [{ bearerAuth: [] }],
        params: z.object({ workspaceId: z.string().uuid() }),
        body: z.object({ purchaseToken: z.string().min(10).max(4096) }).strict(),
        response: { 200: entitlementSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const context = requireWorkspaceContext(request);
      return service.linkPurchase(
        context.workspaceId,
        auth.userId,
        request.body.purchaseToken,
        requestMeta(request),
      );
    },
  );

  routes.get(
    '/workspaces/:workspaceId/billing/subscriptions',
    {
      preHandler: [app.authenticate, requireWorkspace('assinatura.ver')],
      schema: {
        tags: ['assinatura'],
        summary: 'Histórico de assinaturas da empresa',
        security: [{ bearerAuth: [] }],
        params: z.object({ workspaceId: z.string().uuid() }),
        response: {
          200: z.object({
            subscriptions: z.array(
              z.object({
                id: z.string().uuid(),
                planKey: z.string(),
                state: z.string(),
                autoRenewing: z.boolean(),
                startedAt: z.string().nullable(),
                currentPeriodEnd: z.string().nullable(),
                lastVerifiedAt: z.string(),
                productId: z.string(),
              }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const context = requireWorkspaceContext(request);
      return { subscriptions: await service.listSubscriptions(context.workspaceId) };
    },
  );

  routes.post(
    '/workspaces/:workspaceId/billing/refresh',
    {
      preHandler: [app.authenticate, requireWorkspace('assinatura.gerenciar')],
      schema: {
        tags: ['assinatura'],
        summary: 'Força uma revalidação da assinatura junto ao Google',
        description: 'Atalho de suporte para quando uma notificação se perdeu.',
        security: [{ bearerAuth: [] }],
        params: z.object({ workspaceId: z.string().uuid() }),
        response: { 200: entitlementSchema, ...commonErrors },
      },
    },
    async (request) => {
      const context = requireWorkspaceContext(request);
      return service.refreshWorkspaceSubscription(context.workspaceId);
    },
  );

  /**
   * Webhook das notificações em tempo real do Google (RTDN via Pub/Sub push).
   *
   * Sem autenticação de usuário — quem chama é a infraestrutura do Google.
   * A proteção é um token compartilhado na query string, conforme configurado
   * no Pub/Sub, comparado em tempo constante.
   *
   * Responde 200 mesmo em caso de erro de processamento já registrado, porque
   * um erro repetido faria o Pub/Sub reentregar a mesma mensagem
   * indefinidamente. O que falha fica marcado e é retomado pela reconciliação.
   */
  routes.post(
    '/billing/webhooks/google',
    {
      config: {
        rateLimit: {
          max: 1000,
          timeWindow: env.RATE_LIMIT_WINDOW_MS,
        },
      },
      schema: {
        tags: ['assinatura'],
        summary: 'Recebe notificações de assinatura do Google Play',
        description:
          'Endpoint destinado ao Pub/Sub. O conteúdo da notificação nunca é usado como fonte de verdade: ela apenas dispara uma revalidação na Play Developer API.',
        querystring: z.object({ token: z.string().optional() }),
        body: pubsubEnvelopeSchema,
        response: {
          200: z.object({ received: z.boolean(), duplicated: z.boolean() }),
          401: errorSchema,
        },
      },
    },
    async (request) => {
      const expected = env.GOOGLE_PUBSUB_VERIFICATION_TOKEN;
      // Sem token configurado o endpoint não existe — aberto seria pior.
      // Em staging/produção o env exige o valor; aqui cobre development/test.
      if (!expected) {
        throw unauthorized(ErrorCode.AUTH_REQUIRED, 'Origem não autorizada.');
      }
      const provided = request.query.token ?? '';
      if (!safeCompare(provided, expected)) {
        throw unauthorized(ErrorCode.AUTH_REQUIRED, 'Origem não autorizada.');
      }

      const message = request.body.message;
      const messageId = message.messageId ?? message.message_id;
      if (!messageId) {
        request.log.warn('notificação do Pub/Sub sem messageId; descartada');
        return { received: true, duplicated: false };
      }

      let notification: DeveloperNotification = {};
      if (message.data) {
        try {
          notification = JSON.parse(
            Buffer.from(message.data, 'base64').toString('utf8'),
          ) as DeveloperNotification;
        } catch (error) {
          request.log.error({ err: error, messageId }, 'payload do Pub/Sub ilegível');
          return { received: true, duplicated: false };
        }
      }

      // O Google envia uma notificação de teste ao configurar o tópico.
      if (notification.testNotification) {
        request.log.info({ messageId }, 'notificação de teste do Google Play recebida');
        return { received: true, duplicated: false };
      }

      const subscriptionNotification = notification.subscriptionNotification;

      try {
        const result = await service.handleNotification({
          notificationId: messageId,
          notificationType: subscriptionNotification?.notificationType ?? null,
          purchaseToken: subscriptionNotification?.purchaseToken ?? null,
          payload: notification as unknown as Record<string, unknown>,
        });
        return { received: true, duplicated: result.duplicated };
      } catch (error) {
        // Confirmamos o recebimento para o Pub/Sub parar de reentregar; o
        // evento fica pendente e a reconciliação retoma.
        request.log.error({ err: error, messageId }, 'falha ao processar notificação de assinatura');
        return { received: true, duplicated: false };
      }
    },
  );
}
