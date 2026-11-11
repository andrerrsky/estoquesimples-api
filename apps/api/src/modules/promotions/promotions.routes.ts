import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { errorSchema } from '../auth/auth.schemas.js';
import { AsaasBillingService } from '../billing/asaas/asaas-billing.service.js';
import { PromotionsService } from './promotions.service.js';

const yearlySchema = z.object({ fullCents: z.number().int(), promoCents: z.number().int(), monthlyEquivalentCents: z.number().int() }).nullable();
const monthlySchema = z.object({ fullCents: z.number().int(), firstCents: z.number().int(), promoCycles: z.number().int() }).nullable();

/** Campanha sem os indicadores; ausente quando não há campanha ou o cupom não existe. */
const promoFields = z
  .object({ code: z.string(), label: z.string(), startsAt: z.string(), endsAt: z.string(), yearly: yearlySchema, monthly: monthlySchema })
  .partial();

/**
 * Campanhas promocionais (públicas): faixas, landing `/black-friday` e
 * conferência do cupom antes do checkout. Só o que está à venda, nada da
 * empresa ou de quem pede. A validação que vale é a do checkout.
 */
export async function registerPromotionRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const promotions = new PromotionsService(app.services);
  const billing = new AsaasBillingService(app.services);
  const { env } = app.services;

  routes.get(
    '/public/promo',
    {
      schema: {
        tags: ['assinatura'],
        summary: 'Campanha promocional em destaque (vigente ou a próxima)',
        response: {
          200: z.object({ active: z.boolean(), upcoming: z.boolean() }).merge(promoFields),
        },
      },
    },
    async (_request, reply) => {
      reply.header('cache-control', 'public, max-age=60');
      const now = new Date();
      const coupon = await promotions.featured(now);
      if (!coupon) return { active: false, upcoming: false };
      return promotions.view(coupon, await billing.pricing(), now);
    },
  );

  routes.get(
    '/public/coupons/:code',
    {
      // Público e sem login: teto como o das rotas de autenticação, contra varredura de códigos.
      config: { rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_WINDOW_MS } },
      schema: {
        tags: ['assinatura'],
        summary: 'Confere um cupom (vigência e preços da oferta)',
        params: z.object({ code: z.string().trim().min(1).max(32) }),
        response: {
          200: z
            .object({
              valid: z.boolean(),
              reason: z.enum(['invalido', 'expirado', 'ainda_nao_comecou']).nullable(),
              active: z.boolean().optional(),
              upcoming: z.boolean().optional(),
            })
            .merge(promoFields),
          429: errorSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'public, max-age=60');
      const now = new Date();
      const coupon = await promotions.findByCode(request.params.code);
      const reason = promotions.reasonFor(coupon, now);
      if (!coupon || reason === 'invalido') return { valid: false, reason: 'invalido' as const };
      return { valid: reason === null, reason, ...promotions.view(coupon, await billing.pricing(), now) };
    },
  );
}
