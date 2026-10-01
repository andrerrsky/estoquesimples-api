import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { audienceSchema, campaignBodySchema, PUSH_SCREENS } from '../push/push.schemas.js';
import { PushService } from '../push/push.service.js';
import { adminActor, requireAdmin } from './admin-auth.plugin.js';
import { commonAdminErrors, messageSchema, paginationQuerySchema, uuidParam } from './admin.schemas.js';

/**
 * Push pelo painel: público, campanhas, teste e funil de entrega.
 * Enviar para clientes é ação pública em nome do produto: papel `support`.
 */
export async function registerAdminPushRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new PushService(app.services);
  const campaignParams = uuidParam('campaignId');

  routes.get(
    '/push/stats',
    {
      preHandler: requireAdmin('viewer'),
      schema: { tags: ['admin'], summary: 'Aparelhos alcançáveis e funil agregado', hide: true, response: { 200: z.any(), ...commonAdminErrors } },
    },
    async () => service.stats(),
  );

  routes.get(
    '/push/screens',
    {
      preHandler: requireAdmin('viewer'),
      schema: { tags: ['admin'], summary: 'Telas que uma notificação pode abrir', hide: true, response: { 200: z.object({ screens: z.array(z.string()) }), ...commonAdminErrors } },
    },
    async () => ({ screens: [...PUSH_SCREENS] }),
  );

  routes.post(
    '/push/audience/preview',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Quantos aparelhos um público atinge agora',
        hide: true,
        body: z.object({ audience: audienceSchema, activeWithinDays: z.number().int().min(1).max(365).default(90) }).strict(),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.previewAudience(request.body.audience, request.body.activeWithinDays),
  );

  routes.get(
    '/push/campaigns',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Campanhas',
        hide: true,
        querystring: paginationQuerySchema.extend({
          status: z.enum(['draft', 'queued', 'sending', 'sent', 'failed', 'cancelled']).optional(),
          includeTests: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
        }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.listCampaigns(request.query),
  );

  routes.get(
    '/push/campaigns/:campaignId',
    {
      preHandler: requireAdmin('viewer'),
      schema: { tags: ['admin'], summary: 'Detalhe de uma campanha com funil e falhas', hide: true, params: campaignParams, response: { 200: z.any(), ...commonAdminErrors } },
    },
    async (request) => service.getCampaign(request.params.campaignId),
  );

  routes.get(
    '/push/campaigns/:campaignId/deliveries',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Entregas de uma campanha, por aparelho',
        hide: true,
        params: campaignParams,
        querystring: paginationQuerySchema.extend({ status: z.enum(['pending', 'accepted', 'failed', 'delivered', 'opened']).optional() }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.listDeliveries(request.params.campaignId, request.query),
  );

  routes.post(
    '/push/campaigns',
    {
      preHandler: requireAdmin('support'),
      schema: { tags: ['admin'], summary: 'Cria uma campanha (rascunho)', hide: true, body: campaignBodySchema, response: { 201: z.any(), ...commonAdminErrors } },
    },
    async (request, reply) => reply.code(201).send(await service.createCampaign(adminActor(request), request.body)),
  );

  routes.put(
    '/push/campaigns/:campaignId',
    {
      preHandler: requireAdmin('support'),
      schema: { tags: ['admin'], summary: 'Edita um rascunho', hide: true, params: campaignParams, body: campaignBodySchema, response: { 200: z.any(), ...commonAdminErrors } },
    },
    async (request) => service.updateCampaign(adminActor(request), request.params.campaignId, request.body),
  );

  routes.post(
    '/push/campaigns/:campaignId/send',
    {
      preHandler: requireAdmin('support'),
      schema: { tags: ['admin'], summary: 'Coloca a campanha na fila de envio', hide: true, params: campaignParams, response: { 200: messageSchema, ...commonAdminErrors, 503: z.any() } },
    },
    async (request) => {
      await service.send(adminActor(request), request.params.campaignId);
      return { message: 'Campanha na fila. O envio começa em instantes.' };
    },
  );

  routes.post(
    '/push/campaigns/:campaignId/cancel',
    {
      preHandler: requireAdmin('support'),
      schema: { tags: ['admin'], summary: 'Cancela uma campanha na fila ou em envio', hide: true, params: campaignParams, response: { 200: messageSchema, ...commonAdminErrors } },
    },
    async (request) => {
      await service.cancel(adminActor(request), request.params.campaignId);
      return { message: 'Campanha cancelada. O que já foi aceito pelo FCM não pode ser retirado.' };
    },
  );

  routes.delete(
    '/push/campaigns/:campaignId',
    {
      preHandler: requireAdmin('support'),
      schema: { tags: ['admin'], summary: 'Apaga um rascunho ou um teste', hide: true, params: campaignParams, response: { 200: messageSchema, ...commonAdminErrors } },
    },
    async (request) => {
      await service.deleteCampaign(adminActor(request), request.params.campaignId);
      return { message: 'Campanha apagada.' };
    },
  );

  routes.post(
    '/push/test',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Envia a mensagem agora para os aparelhos de um e-mail',
        hide: true,
        body: campaignBodySchema.extend({ email: z.string().trim().email() }).strict(),
        response: { 200: z.any(), ...commonAdminErrors, 503: z.any() },
      },
    },
    async (request) => {
      const { email, ...body } = request.body;
      return service.sendTest(adminActor(request), body, email);
    },
  );
}
