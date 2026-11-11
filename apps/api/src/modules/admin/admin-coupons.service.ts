import { eq, sql } from 'drizzle-orm';

import { coupons, type Coupon } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../platform/http/errors.js';
import { AsaasBillingService } from '../billing/asaas/asaas-billing.service.js';
import { AdminAction, recordAdminAudit, type AdminActor } from './admin-audit.service.js';
import { iso, offsetOf, type Paginated, type PaginationQuery } from './admin.schemas.js';

/**
 * Cupons promocionais no painel (docs/black-friday-2026.md).
 *
 * O painel liga e desliga o cupom (freio de emergência), mexe na vigência e
 * cria cupons novos. Os preços de um cupom existente não mudam por aqui:
 * anúncios e e-mails já citam os valores. A regra de uso continua toda em
 * `modules/promotions` (o checkout lê o cupom do banco a cada pedido, então
 * desativar vale na hora; `/public/promo` tem só o cache HTTP de 60 s).
 *
 * Do resgate o painel mostra empresa, estado, ciclo, valor e datas, nunca o
 * hash do documento.
 */

export type CouponStatus = 'agendado' | 'no_ar' | 'encerrado' | 'desativado';

/** Código de cupom novo: mais estrito que o CHECK do banco (que aceita `_`, `-` e 2 caracteres, como os antigos). */
export const NEW_COUPON_CODE = /^[A-Z0-9]{4,32}$/;

/** O Asaas não cobra menos de R$ 5,00 (mesmo CHECK da migration 0036). */
export const COUPON_MIN_CENTS = 500;

/** Mesma regra de `promotions.service`: o fim é inclusivo até o último segundo. */
export function couponStatus(coupon: Pick<Coupon, 'active' | 'startsAt' | 'endsAt'>, now: Date = new Date()): CouponStatus {
  if (!coupon.active) return 'desativado';
  if (now.getTime() < coupon.startsAt.getTime()) return 'agendado';
  if (now.getTime() >= coupon.endsAt.getTime() + 1000) return 'encerrado';
  return 'no_ar';
}

export interface CouponStats {
  reserved: number;
  redeemed: number;
  /** Soma da 1ª cobrança (valor promocional) dos resgates pagos. */
  redeemedRevenueCents: number;
}

export interface AdminCouponView extends CouponStats {
  id: string;
  code: string;
  label: string;
  startsAt: string;
  endsAt: string;
  active: boolean;
  status: CouponStatus;
  yearlyPriceCents: number | null;
  monthlyFirstCents: number | null;
  monthlyPromoCycles: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminRedemptionView {
  id: string;
  state: string;
  cycle: string;
  valueCents: number;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceDeleted: boolean;
  subscriptionId: string | null;
  subscriptionState: string | null;
  createdAt: string;
  redeemedAt: string | null;
}

export interface CreateCouponInput {
  code: string;
  label: string;
  startsAt: Date;
  endsAt: Date;
  yearlyPriceCents: number | null;
  monthlyFirstCents: number | null;
  monthlyPromoCycles: number;
  reason: string;
}

const EMPTY_STATS: CouponStats = { reserved: 0, redeemed: 0, redeemedRevenueCents: 0 };

function toView(coupon: Coupon, stats: CouponStats, now: Date): AdminCouponView {
  return {
    id: coupon.id,
    code: coupon.code,
    label: coupon.label,
    startsAt: coupon.startsAt.toISOString(),
    endsAt: coupon.endsAt.toISOString(),
    active: coupon.active,
    status: couponStatus(coupon, now),
    yearlyPriceCents: coupon.yearlyPriceCents,
    monthlyFirstCents: coupon.monthlyFirstCents,
    monthlyPromoCycles: coupon.monthlyPromoCycles,
    createdAt: coupon.createdAt.toISOString(),
    updatedAt: coupon.updatedAt.toISOString(),
    ...stats,
  };
}

export class AdminCouponsService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  /** Preço cheio vigente da web (âncora do cupom e teto do preço promocional). */
  async fullPricing(): Promise<{ monthlyCents: number | null; yearlyCents: number | null }> {
    const pricing = await new AsaasBillingService(this.services).pricing();
    return { monthlyCents: pricing.monthlyCents, yearlyCents: pricing.yearlyCents };
  }

  private async statsFor(ids: string[]): Promise<Map<string, CouponStats>> {
    const map = new Map<string, CouponStats>();
    if (ids.length === 0) return map;
    const rows = await this.db.execute<{ coupon_id: string; reserved: number; redeemed: number; revenue: number }>(sql`
      SELECT coupon_id,
             count(*) FILTER (WHERE state = 'reservado')::int AS reserved,
             count(*) FILTER (WHERE state = 'resgatado')::int AS redeemed,
             coalesce(sum(value_cents) FILTER (WHERE state = 'resgatado'), 0)::int AS revenue
        FROM coupon_redemptions
       WHERE coupon_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
       GROUP BY coupon_id
    `);
    for (const row of rows.rows) {
      map.set(row.coupon_id, { reserved: row.reserved, redeemed: row.redeemed, redeemedRevenueCents: row.revenue });
    }
    return map;
  }

  /** Mais recentes primeiro (pela data de início). */
  async list(query: PaginationQuery, now: Date = new Date()): Promise<Paginated<AdminCouponView>> {
    const [rows, total] = await Promise.all([
      this.db.select().from(coupons).orderBy(sql`${coupons.startsAt} DESC`, coupons.code).limit(query.pageSize).offset(offsetOf(query)),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM coupons`),
    ]);
    const stats = await this.statsFor(rows.map((row) => row.id));
    return {
      items: rows.map((row) => toView(row, stats.get(row.id) ?? EMPTY_STATS, now)),
      page: query.page,
      pageSize: query.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  async detail(id: string, now: Date = new Date()): Promise<AdminCouponView> {
    const rows = await this.db.select().from(coupons).where(eq(coupons.id, id)).limit(1);
    const coupon = rows[0];
    if (!coupon) throw notFound('Cupom não encontrado.');
    const stats = await this.statsFor([coupon.id]);
    return toView(coupon, stats.get(coupon.id) ?? EMPTY_STATS, now);
  }

  /** Resgates do cupom: sem documento nem hash. */
  async redemptions(id: string, query: PaginationQuery & { state?: 'reservado' | 'resgatado' }): Promise<Paginated<AdminRedemptionView>> {
    const stateFilter = query.state ? sql`AND r.state = ${query.state}` : sql``;
    const [rows, total] = await Promise.all([
      this.db.execute<{
        id: string;
        state: string;
        cycle: string;
        value_cents: number;
        workspace_id: string | null;
        workspace_name: string | null;
        workspace_deleted_at: Date | null;
        subscription_id: string | null;
        subscription_state: string | null;
        created_at: Date;
        redeemed_at: Date | null;
      }>(sql`
        SELECT r.id, r.state, r.cycle, r.value_cents, r.workspace_id, w.name AS workspace_name,
               w.deleted_at AS workspace_deleted_at, r.subscription_id, s.state AS subscription_state,
               r.created_at, r.redeemed_at
          FROM coupon_redemptions r
          LEFT JOIN workspaces w ON w.id = r.workspace_id
          LEFT JOIN subscriptions s ON s.id = r.subscription_id
         WHERE r.coupon_id = ${id} ${stateFilter}
         ORDER BY coalesce(r.redeemed_at, r.created_at) DESC, r.id
         LIMIT ${query.pageSize} OFFSET ${offsetOf(query)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM coupon_redemptions r WHERE r.coupon_id = ${id} ${stateFilter}`),
    ]);
    const date = (value: Date | string | null) => (value === null ? null : new Date(value));
    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        state: row.state,
        cycle: row.cycle,
        valueCents: row.value_cents,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        workspaceDeleted: row.workspace_deleted_at !== null,
        subscriptionId: row.subscription_id,
        subscriptionState: row.subscription_state,
        createdAt: new Date(row.created_at).toISOString(),
        redeemedAt: iso(date(row.redeemed_at)),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  /** Liga ou desliga o cupom. Desligado, some de `/public/promo` e o checkout recusa (`invalido`). */
  async setActive(actor: AdminActor, id: string, active: boolean, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx.select().from(coupons).where(eq(coupons.id, id)).limit(1).for('update');
      const coupon = rows[0];
      if (!coupon) throw notFound('Cupom não encontrado.');
      if (coupon.active === active) {
        throw conflict(ErrorCode.CONFLICT, active ? 'O cupom já está ativo.' : 'O cupom já está desativado.');
      }
      await tx.update(coupons).set({ active }).where(eq(coupons.id, id));
      await recordAdminAudit(tx, {
        actor,
        action: active ? AdminAction.COUPON_ACTIVATED : AdminAction.COUPON_DEACTIVATED,
        targetType: 'coupon',
        targetId: coupon.id,
        metadata: { code: coupon.code, reason },
      });
    });
  }

  /**
   * Muda a vigência. O fim pode ir para a frente (prorrogar) ou para trás
   * (encerrar antes), mas nunca antes do início; o início só muda enquanto o
   * cupom ainda não começou, porque depois disso já houve quem o visse valer.
   */
  async updatePeriod(
    actor: AdminActor,
    id: string,
    input: { startsAt?: Date; endsAt?: Date; reason: string },
    now: Date = new Date(),
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx.select().from(coupons).where(eq(coupons.id, id)).limit(1).for('update');
      const coupon = rows[0];
      if (!coupon) throw notFound('Cupom não encontrado.');

      const changes: Record<string, { from: string; to: string }> = {};
      const patch: Partial<typeof coupons.$inferInsert> = {};
      if (input.startsAt && input.startsAt.getTime() !== coupon.startsAt.getTime()) {
        if (now.getTime() >= coupon.startsAt.getTime()) {
          throw badRequest(ErrorCode.VALIDATION_FAILED, 'O início só pode mudar enquanto o cupom não começou.');
        }
        patch.startsAt = input.startsAt;
        changes['startsAt'] = { from: coupon.startsAt.toISOString(), to: input.startsAt.toISOString() };
      }
      if (input.endsAt && input.endsAt.getTime() !== coupon.endsAt.getTime()) {
        patch.endsAt = input.endsAt;
        changes['endsAt'] = { from: coupon.endsAt.toISOString(), to: input.endsAt.toISOString() };
      }
      if (Object.keys(patch).length === 0) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Nada para alterar.');

      const startsAt = patch.startsAt ?? coupon.startsAt;
      const endsAt = patch.endsAt ?? coupon.endsAt;
      if (endsAt.getTime() <= startsAt.getTime()) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'O fim precisa ficar depois do início.');
      }

      await tx.update(coupons).set(patch).where(eq(coupons.id, id));
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.COUPON_PERIOD_CHANGED,
        targetType: 'coupon',
        targetId: coupon.id,
        metadata: { code: coupon.code, changes, reason: input.reason },
      });
    });
  }

  /** Cupom novo. Preço promocional abaixo do cheio vigente do ciclo e nunca abaixo de R$ 5,00. */
  async create(actor: AdminActor, input: CreateCouponInput): Promise<AdminCouponView> {
    if (!NEW_COUPON_CODE.test(input.code)) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Código: só letras maiúsculas e números, de 4 a 32 caracteres.');
    }
    if (input.endsAt.getTime() <= input.startsAt.getTime()) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'O fim precisa ficar depois do início.');
    }
    if (input.yearlyPriceCents === null && input.monthlyFirstCents === null) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Informe o preço anual, o do 1º mês ou os dois.');
    }
    const full = await this.fullPricing();
    const checkPrice = (value: number | null, fullCents: number | null, label: string) => {
      if (value === null) return;
      if (fullCents === null) throw badRequest(ErrorCode.VALIDATION_FAILED, `${label}: o plano não é vendido neste ciclo pela web.`);
      if (value < COUPON_MIN_CENTS) throw badRequest(ErrorCode.VALIDATION_FAILED, `${label}: no mínimo R$ 5,00 (mínimo de cobrança do Asaas).`);
      if (value >= fullCents) throw badRequest(ErrorCode.VALIDATION_FAILED, `${label}: precisa ser menor que o preço cheio.`);
    };
    checkPrice(input.yearlyPriceCents, full.yearlyCents, 'Preço anual promocional');
    checkPrice(input.monthlyFirstCents, full.monthlyCents, 'Preço do 1º mês');

    const created = await this.db.transaction(async (tx) => {
      const existing = await tx.select({ id: coupons.id }).from(coupons).where(eq(coupons.code, input.code)).limit(1);
      if (existing.length > 0) throw conflict(ErrorCode.CONFLICT, `Já existe um cupom ${input.code}.`);
      const rows = await tx
        .insert(coupons)
        .values({
          code: input.code,
          label: input.label,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          yearlyPriceCents: input.yearlyPriceCents,
          monthlyFirstCents: input.monthlyFirstCents,
          monthlyPromoCycles: input.monthlyPromoCycles,
        })
        .onConflictDoNothing()
        .returning();
      const row = rows[0];
      // Dois owners criando o mesmo código ao mesmo tempo: o único do banco decide.
      if (!row) throw conflict(ErrorCode.CONFLICT, `Já existe um cupom ${input.code}.`);
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.COUPON_CREATED,
        targetType: 'coupon',
        targetId: row.id,
        metadata: {
          code: row.code,
          label: row.label,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          yearlyPriceCents: row.yearlyPriceCents,
          monthlyFirstCents: row.monthlyFirstCents,
          monthlyPromoCycles: row.monthlyPromoCycles,
          reason: input.reason,
        },
      });
      return row;
    });
    return toView(created, EMPTY_STATS, new Date());
  }
}
