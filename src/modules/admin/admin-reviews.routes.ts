import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { REPLY_MAX_LENGTH, ReviewsService } from '../reviews/reviews.service.js';
import { AdminAction, recordAdminAudit } from './admin-audit.service.js';
import { adminActor, requireAdmin } from './admin-auth.plugin.js';
import { commonAdminErrors, messageSchema, paginationQuerySchema } from './admin.schemas.js';

/**
 * Avaliações da Play Store no painel: ler, responder (manual ou com rascunho
 * da IA) e configurar a chave da OpenAI. Responder é ação pública em nome do
 * produto, por isso exige papel `support`; a chave, `owner`.
 */
export async function registerAdminReviewsRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new ReviewsService(app.services);

  routes.get(
    '/reviews/stats',
    {
      preHandler: requireAdmin('viewer'),
      schema: { tags: ['admin'], summary: 'Contagens de avaliações respondidas e pendentes', hide: true, response: { 200: z.any(), ...commonAdminErrors } },
    },
    async () => service.stats(),
  );

  routes.get(
    '/reviews',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Lista avaliações da Play Store',
        hide: true,
        querystring: paginationQuerySchema.extend({
          status: z.enum(['unanswered', 'answered']).optional(),
          rating: z.coerce.number().int().min(1).max(5).optional(),
          q: z.string().trim().max(200).optional(),
        }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.list(request.query),
  );

  routes.post(
    '/reviews/sync',
    {
      preHandler: requireAdmin('support'),
      schema: { tags: ['admin'], summary: 'Busca as avaliações recentes no Google agora', hide: true, response: { 200: z.any(), ...commonAdminErrors, 502: z.any(), 503: z.any() } },
    },
    async (request) => {
      const result = await service.sync();
      await recordAdminAudit(app.services.db, {
        actor: adminActor(request),
        action: AdminAction.REVIEWS_SYNCED,
        targetType: 'reviews',
        metadata: result,
      });
      return result;
    },
  );

  routes.post(
    '/reviews/:reviewId/reply',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Publica a resposta do desenvolvedor na Play Store',
        hide: true,
        params: z.object({ reviewId: z.string().min(1).max(200) }),
        body: z.object({ text: z.string().trim().min(1).max(REPLY_MAX_LENGTH) }).strict(),
        response: { 200: messageSchema, ...commonAdminErrors, 502: z.any() },
      },
    },
    async (request) => {
      await service.reply(adminActor(request), request.params.reviewId, request.body.text);
      return { message: 'Resposta publicada na Play Store.' };
    },
  );

  routes.post(
    '/reviews/:reviewId/draft',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Gera um rascunho de resposta com a OpenAI (não publica)',
        hide: true,
        params: z.object({ reviewId: z.string().min(1).max(200) }),
        body: z.object({ instructions: z.string().trim().max(500).optional() }).strict(),
        response: { 200: z.object({ text: z.string(), model: z.string() }), ...commonAdminErrors, 502: z.any() },
      },
    },
    async (request) => service.draft(adminActor(request), request.params.reviewId, request.body.instructions),
  );

  routes.get(
    '/settings/openai',
    {
      preHandler: requireAdmin('viewer'),
      schema: { tags: ['admin'], summary: 'Situação da chave da OpenAI', hide: true, response: { 200: z.any(), ...commonAdminErrors } },
    },
    async () => service.openAiStatus(),
  );

  routes.put(
    '/settings/openai',
    {
      preHandler: requireAdmin('owner'),
      schema: {
        tags: ['admin'],
        summary: 'Define a chave da OpenAI (validada e guardada cifrada)',
        hide: true,
        body: z.object({ apiKey: z.string().trim().min(20).max(300) }).strict(),
        response: { 200: messageSchema, ...commonAdminErrors, 502: z.any() },
      },
    },
    async (request) => {
      await service.setOpenAiKey(adminActor(request), request.body.apiKey);
      return { message: 'Chave da OpenAI configurada.' };
    },
  );

  routes.delete(
    '/settings/openai',
    {
      preHandler: requireAdmin('owner'),
      schema: { tags: ['admin'], summary: 'Remove a chave da OpenAI', hide: true, response: { 200: messageSchema, ...commonAdminErrors } },
    },
    async (request) => {
      await service.removeOpenAiKey(adminActor(request));
      return { message: 'Chave removida.' };
    },
  );
}
