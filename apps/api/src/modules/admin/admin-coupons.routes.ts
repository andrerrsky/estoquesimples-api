import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { adminActor, requireAdmin } from './admin-auth.plugin.js';
import { AdminCouponsService, COUPON_MIN_CENTS } from './admin-coupons.service.js';
import { commonAdminErrors, messageSchema, paginatedSchema, paginationQuerySchema, reasonBodySchema, uuidParam } from './admin.schemas.js';

const reason = z.string().trim().min(3).max(500);
/** Instante com fuso explícito (o painel manda o horário de Brasília com `-03:00`). */
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const promoPrice = z.number().int().min(COUPON_MIN_CENTS).max(1_000_000).nullable();

const couponSchema = z.object({
  id: z.string(),
  code: z.string(),
  label: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  active: z.boolean(),
  status: z.enum(['agendado', 'no_ar', 'encerrado', 'desativado']),
  yearlyPriceCents: z.number().int().nullable(),
  monthlyFirstCents: z.number().int().nullable(),
  monthlyPromoCycles: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  reserved: z.number().int(),
  redeemed: z.number().int(),
  redeemedRevenueCents: z.number().int(),
});

/** Lista fechada de campos: o hash do documento não sai nem por engano. */
const redemptionSchema = z.object({
  id: z.string(),
  state: z.string(),
  cycle: z.string(),
  valueCents: z.number().int(),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  workspaceDeleted: z.boolean(),
  subscriptionId: z.string().nullable(),
  subscriptionState: z.string().nullable(),
  createdAt: z.string(),
  redeemedAt: z.string().nullable(),
});

const fullPricingSchema = z.object({ monthlyCents: z.number().int().nullable(), yearlyCents: z.number().int().nullable() });

/**
 * Cupons promocionais (docs/black-friday-2026.md). Ler: viewer. Criar,
 * ligar/desligar e mudar a vigência: owner, com motivo e auditoria, como os
 * preços em Planos. Os preços de um cupom existente não são editáveis.
 */
export async function registerAdminCouponsRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new AdminCouponsService(app.services);

  routes.get(
    '/coupons',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Lista cupons com vigência, situação e números de resgate',
        hide: true,
        querystring: paginationQuerySchema,
        response: { 200: paginatedSchema(couponSchema).extend({ fullPricing: fullPricingSchema }), ...commonAdminErrors },
      },
    },
    async (request) => {
      const [page, fullPricing] = await Promise.all([service.list(request.query), service.fullPricing()]);
      return { ...page, fullPricing };
    },
  );

  routes.get(
    '/coupons/:couponId',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Detalhe do cupom',
        hide: true,
        params: uuidParam('couponId'),
        response: { 200: couponSchema.extend({ fullPricing: fullPricingSchema }), ...commonAdminErrors },
      },
    },
    async (request) => {
      const [coupon, fullPricing] = await Promise.all([service.detail(request.params.couponId), service.fullPricing()]);
      return { ...coupon, fullPricing };
    },
  );

  routes.get(
    '/coupons/:couponId/redemptions',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Resgates do cupom (sem documento)',
        hide: true,
        params: uuidParam('couponId'),
        querystring: paginationQuerySchema.extend({ state: z.enum(['reservado', 'resgatado']).optional() }),
        response: { 200: paginatedSchema(redemptionSchema), ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.detail(request.params.couponId);
      return service.redemptions(request.params.couponId, request.query);
    },
  );

  routes.post(
    '/coupons',
    {
      preHandler: requireAdmin('owner'),
      schema: {
        tags: ['admin'],
        summary: 'Cria um cupom',
        hide: true,
        body: z
          .object({
            code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4,32}$/, 'Código: só letras maiúsculas e números, de 4 a 32 caracteres.'),
            label: z.string().trim().min(1).max(80),
            startsAt: instant,
            endsAt: instant,
            yearlyPriceCents: promoPrice,
            monthlyFirstCents: promoPrice,
            monthlyPromoCycles: z.number().int().min(1).max(12),
            reason,
          })
          .strict(),
        response: { 201: couponSchema, ...commonAdminErrors },
      },
    },
    async (request, reply) => {
      const created = await service.create(adminActor(request), request.body);
      return reply.status(201).send(created);
    },
  );

  routes.post(
    '/coupons/:couponId/activate',
    {
      preHandler: requireAdmin('owner'),
      schema: { tags: ['admin'], summary: 'Ativa o cupom', hide: true, params: uuidParam('couponId'), body: reasonBodySchema, response: { 200: messageSchema, ...commonAdminErrors } },
    },
    async (request) => {
      await service.setActive(adminActor(request), request.params.couponId, true, request.body.reason);
      return { message: 'Cupom ativado.' };
    },
  );

  routes.post(
    '/coupons/:couponId/deactivate',
    {
      preHandler: requireAdmin('owner'),
      schema: { tags: ['admin'], summary: 'Desativa o cupom (freio de emergência)', hide: true, params: uuidParam('couponId'), body: reasonBodySchema, response: { 200: messageSchema, ...commonAdminErrors } },
    },
    async (request) => {
      await service.setActive(adminActor(request), request.params.couponId, false, request.body.reason);
      return { message: 'Cupom desativado.' };
    },
  );

  routes.patch(
    '/coupons/:couponId',
    {
      preHandler: requireAdmin('owner'),
      schema: {
        tags: ['admin'],
        summary: 'Muda a vigência do cupom (preços não são editáveis)',
        hide: true,
        params: uuidParam('couponId'),
        body: z.object({ startsAt: instant.optional(), endsAt: instant.optional(), reason }).strict(),
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.updatePeriod(adminActor(request), request.params.couponId, request.body);
      return { message: 'Vigência atualizada.' };
    },
  );
}
