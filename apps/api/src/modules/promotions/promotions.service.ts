import { createHash } from 'node:crypto';

import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';

import { couponRedemptions, coupons, subscriptions, type Coupon } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';
import { trackServerEvent } from '../analytics/analytics.service.js';
import type { AsaasClient, AsaasPayment, AsaasSubscription } from '../billing/asaas/asaas-client.js';
import { isPaidStatus, type AsaasCycle } from '../billing/asaas/asaas-state.js';
import { onlyDigits } from '../billing/asaas/document.js';

/**
 * Cupons promocionais da assinatura pela web (Black Friday 2026:
 * docs/black-friday-2026.md).
 *
 * O cupom só muda o valor que o Asaas cobra nos primeiros ciclos; estado,
 * direitos e reconciliação continuam os da assinatura comum. Tudo é decidido
 * aqui, no servidor: a web só mostra o que estas regras devolvem.
 *
 * Ciclo de vida do uso:
 *   1. checkout com cupom → assinatura no Asaas com o valor promocional e um
 *      resgate `reservado` (abandonar a fatura não queima o cupom);
 *   2. 1ª cobrança paga → resgate `resgatado` + evento `coupon.redeemed`;
 *   3. últimos ciclos promocionais pagos → valor da assinatura no Asaas volta
 *      ao preço cheio (`updatePendingPayments`), uma vez (`promo_restored_at`).
 */

/** Ciclos vendidos com cupom. O semestral fica fora das campanhas. */
export const PROMO_CYCLES = ['MONTHLY', 'YEARLY'] as const;
export type PromoCycle = (typeof PROMO_CYCLES)[number];

export type CouponReason = 'invalido' | 'expirado' | 'ainda_nao_comecou';

export type IneligibleReason = 'assinatura_ativa' | 'google_play' | 'cupom_ja_usado';

/** Preços cheios (de `plans`) usados como âncora; mesmo formato de `WebPricing`. */
export interface FullPricing {
  monthlyCents: number | null;
  yearlyCents: number | null;
}

export interface PromoView {
  active: boolean;
  upcoming: boolean;
  code: string;
  label: string;
  startsAt: string;
  endsAt: string;
  yearly: { fullCents: number; promoCents: number; monthlyEquivalentCents: number } | null;
  monthly: { fullCents: number; firstCents: number; promoCycles: number } | null;
}

type SubscriptionRow = typeof subscriptions.$inferSelect;
type Tx = Parameters<Parameters<AppServices['db']['transaction']>[0]>[0];

/** Código como a pessoa digitou → como fica gravado (sem espaços, maiúsculas). */
export function normalizeCouponCode(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * SHA-256 (hex) do CPF/CNPJ só com dígitos. O projeto não tem pepper para
 * hashes (tokens e purchase tokens também são SHA-256 puro); a tabela é de
 * sistema e o documento inteiro não é guardado em lugar nenhum.
 */
export function documentHash(cpfCnpj: string): string {
  return createHash('sha256').update(onlyDigits(cpfCnpj), 'utf8').digest('hex');
}

/** O fim é inclusivo até o último segundo (23:59:59.999). */
function hasEnded(coupon: Coupon, now: Date): boolean {
  return now.getTime() >= coupon.endsAt.getTime() + 1000;
}

function hasStarted(coupon: Coupon, now: Date): boolean {
  return now.getTime() >= coupon.startsAt.getTime();
}

export function isCouponCurrent(coupon: Coupon, now: Date): boolean {
  return coupon.active && hasStarted(coupon, now) && !hasEnded(coupon, now);
}

/** Valor da 1ª cobrança com o cupom no ciclo; nulo = ciclo fora da oferta. */
export function promoPriceFor(coupon: Coupon, cycle: AsaasCycle): number | null {
  if (cycle === 'YEARLY') return coupon.yearlyPriceCents;
  if (cycle === 'MONTHLY') return coupon.monthlyFirstCents;
  return null;
}

/** Quantas cobranças saem pelo valor promocional. */
export function promoCyclesFor(coupon: Pick<Coupon, 'monthlyPromoCycles'>, cycle: AsaasCycle): number {
  return cycle === 'MONTHLY' ? coupon.monthlyPromoCycles : 1;
}

/** Erro de cupom no checkout: sempre 409 com mensagem pronta e o motivo estável em `couponReason`. */
function couponError(reason: string, message: string): AppError {
  return new AppError(409, ErrorCode.CONFLICT, message, { extra: { couponReason: reason } });
}

export class PromotionsService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  async findByCode(code: string): Promise<Coupon | null> {
    const normalized = normalizeCouponCode(code);
    if (!/^[A-Z0-9_-]{2,32}$/.test(normalized)) return null;
    const rows = await this.db.select().from(coupons).where(eq(coupons.code, normalized)).limit(1);
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<Coupon | null> {
    const rows = await this.db.select().from(coupons).where(eq(coupons.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** Campanha em destaque: a vigente (a que termina primeiro) ou, sem nenhuma, a próxima a começar. */
  async featured(now: Date = new Date()): Promise<Coupon | null> {
    const current = await this.db
      .select()
      .from(coupons)
      .where(and(eq(coupons.active, true), lte(coupons.startsAt, now), gt(sql`${coupons.endsAt} + interval '1 second'`, now)))
      .orderBy(asc(coupons.endsAt))
      .limit(1);
    if (current[0]) return current[0];
    const next = await this.db
      .select()
      .from(coupons)
      .where(and(eq(coupons.active, true), gt(coupons.startsAt, now)))
      .orderBy(asc(coupons.startsAt))
      .limit(1);
    return next[0] ?? null;
  }

  /** Formato público da campanha (faixas, landing, checkout). */
  view(coupon: Coupon, pricing: FullPricing, now: Date = new Date()): PromoView {
    const yearlyFull = pricing.yearlyCents;
    const monthlyFull = pricing.monthlyCents;
    return {
      active: isCouponCurrent(coupon, now),
      upcoming: coupon.active && !hasStarted(coupon, now),
      code: coupon.code,
      label: coupon.label,
      startsAt: coupon.startsAt.toISOString(),
      endsAt: coupon.endsAt.toISOString(),
      yearly:
        coupon.yearlyPriceCents !== null && yearlyFull !== null
          ? { fullCents: yearlyFull, promoCents: coupon.yearlyPriceCents, monthlyEquivalentCents: Math.round(coupon.yearlyPriceCents / 12) }
          : null,
      monthly:
        coupon.monthlyFirstCents !== null && monthlyFull !== null
          ? { fullCents: monthlyFull, firstCents: coupon.monthlyFirstCents, promoCycles: coupon.monthlyPromoCycles }
          : null,
    };
  }

  /** Motivo de o cupom não valer agora (nulo = vale). */
  reasonFor(coupon: Coupon | null, now: Date = new Date()): CouponReason | null {
    if (!coupon || !coupon.active) return 'invalido';
    if (!hasStarted(coupon, now)) return 'ainda_nao_comecou';
    if (hasEnded(coupon, now)) return 'expirado';
    return null;
  }

  async usedByWorkspace(couponId: string, workspaceId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: couponRedemptions.id })
      .from(couponRedemptions)
      .where(and(eq(couponRedemptions.couponId, couponId), eq(couponRedemptions.workspaceId, workspaceId), eq(couponRedemptions.state, 'resgatado')))
      .limit(1);
    return rows.length > 0;
  }

  async usedByDocument(couponId: string, hash: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: couponRedemptions.id })
      .from(couponRedemptions)
      .where(and(eq(couponRedemptions.couponId, couponId), eq(couponRedemptions.documentHash, hash), eq(couponRedemptions.state, 'resgatado')))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Elegibilidade da empresa para a tela Plano (sem o documento, que só chega
   * no checkout). Pendente não é assinatura de verdade: retomar com o mesmo
   * cupom ou trocar de escolha é permitido.
   */
  async eligibility(coupon: Coupon, workspaceId: string, live: SubscriptionRow | null): Promise<{ eligible: boolean; ineligibleReason: IneligibleReason | null }> {
    if (live && live.provider === 'google_play') return { eligible: false, ineligibleReason: 'google_play' };
    if (live && live.state !== 'pendente') return { eligible: false, ineligibleReason: 'assinatura_ativa' };
    if (await this.usedByWorkspace(coupon.id, workspaceId)) return { eligible: false, ineligibleReason: 'cupom_ja_usado' };
    return { eligible: true, ineligibleReason: null };
  }

  /** Cupom do checkout: existe e o ciclo está na oferta (a vigência é conferida depois, ver `assertUsable`). */
  async requireForCycle(code: string, cycle: AsaasCycle): Promise<Coupon & { promoCents: number }> {
    const coupon = await this.findByCode(code);
    if (!coupon || !coupon.active) throw couponError('invalido', 'Cupom inválido. Confira o código e tente de novo.');
    const promoCents = promoPriceFor(coupon, cycle);
    if (promoCents === null) {
      throw couponError(
        'ciclo_fora_da_oferta',
        `O cupom ${coupon.code} vale só para ${coupon.yearlyPriceCents !== null && coupon.monthlyFirstCents !== null ? 'o plano anual ou o mensal' : coupon.yearlyPriceCents !== null ? 'o plano anual' : 'o plano mensal'}.`,
      );
    }
    return { ...coupon, promoCents };
  }

  /** Vigência, elegibilidade da empresa e uso por empresa e por documento. Lança 409 com a mensagem para a pessoa. */
  async assertUsable(coupon: Coupon, input: { workspaceId: string; cpfCnpj: string; live: SubscriptionRow | null; now?: Date }): Promise<void> {
    const reason = this.reasonFor(coupon, input.now ?? new Date());
    if (reason === 'ainda_nao_comecou') {
      const date = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }).format(coupon.startsAt);
      throw couponError(reason, `O cupom ${coupon.code} ainda não começou a valer. Ele vale a partir de ${date}.`);
    }
    if (reason === 'expirado') throw couponError(reason, `O cupom ${coupon.code} expirou.`);
    if (reason === 'invalido') throw couponError(reason, 'Cupom inválido. Confira o código e tente de novo.');

    const live = input.live;
    if (live && (live.provider === 'google_play' || live.state !== 'pendente')) {
      throw couponError('empresa_nao_elegivel', `O cupom ${coupon.code} vale só para empresas que ainda não têm o plano Equipe.`);
    }
    if (await this.usedByWorkspace(coupon.id, input.workspaceId)) {
      throw couponError('ja_usado', `Esta empresa já usou o cupom ${coupon.code}.`);
    }
    if (await this.usedByDocument(coupon.id, documentHash(input.cpfCnpj))) {
      throw couponError('ja_usado', `Este CPF/CNPJ já usou o cupom ${coupon.code}.`);
    }
  }

  /** Reserva o uso junto com a assinatura recém-criada (mesma transação). */
  async reserve(tx: Tx, input: { couponId: string; workspaceId: string; subscriptionId: string; cpfCnpj: string; cycle: PromoCycle; valueCents: number }): Promise<void> {
    await tx
      .insert(couponRedemptions)
      .values({
        couponId: input.couponId,
        workspaceId: input.workspaceId,
        subscriptionId: input.subscriptionId,
        documentHash: documentHash(input.cpfCnpj),
        state: 'reservado',
        cycle: input.cycle,
        valueCents: input.valueCents,
      })
      .onConflictDoNothing();
  }

  /**
   * Depois de cada reconsulta ao Asaas de uma assinatura com cupom: marca o
   * resgate na 1ª cobrança paga e, pagos os ciclos promocionais, devolve a
   * assinatura ao preço cheio. Idempotente e tolerante a falha: o que não der
   * certo agora é refeito na próxima reconsulta (webhook ou reconciliação).
   */
  async afterRefresh(input: {
    subscription: SubscriptionRow;
    cycle: AsaasCycle;
    remote: AsaasSubscription | null;
    payments: AsaasPayment[];
    fullPriceCents: number | null;
    asaas: AsaasClient;
  }): Promise<void> {
    const { subscription } = input;
    if (!subscription.couponId) return;
    const paid = input.payments.filter((payment) => !payment.deleted && isPaidStatus(payment.status));
    if (paid.length === 0) return;

    const coupon = await this.findById(subscription.couponId);
    if (!coupon) return;

    await this.markRedeemed(subscription, coupon, input.cycle, paid);

    if (subscription.promoRestoredAt) return;
    if (paid.length < promoCyclesFor(coupon, input.cycle)) return;
    // Assinatura cancelada não gera mais cobranças: nada a restaurar.
    if (!input.remote || input.remote.deleted || input.remote.status !== 'ACTIVE') return;
    const full = input.fullPriceCents;
    if (full === null) {
      this.services.logger?.error({ alerta: true, subscriptionId: subscription.id }, 'preço cheio indisponível: assinatura com cupom continua no valor promocional');
      return;
    }

    try {
      if (Math.round(input.remote.value * 100) !== full) {
        await input.asaas.updateSubscription(input.remote.id, { value: full / 100, updatePendingPayments: true });
      }
      await this.db
        .update(subscriptions)
        .set({ priceCents: full, promoRestoredAt: new Date() })
        .where(and(eq(subscriptions.id, subscription.id), sql`${subscriptions.promoRestoredAt} IS NULL`));
    } catch (error) {
      this.services.logger?.error(
        { err: error, alerta: true, subscriptionId: subscription.id },
        'falha ao voltar a assinatura com cupom ao preço cheio no Asaas; a reconciliação tenta de novo',
      );
    }
  }

  private async markRedeemed(subscription: SubscriptionRow, coupon: Coupon, cycle: AsaasCycle, paid: AsaasPayment[]): Promise<void> {
    let updated: Array<{ valueCents: number }>;
    try {
      updated = await this.db
        .update(couponRedemptions)
        .set({ state: 'resgatado', redeemedAt: new Date() })
        .where(and(eq(couponRedemptions.subscriptionId, subscription.id), eq(couponRedemptions.state, 'reservado')))
        .returning({ valueCents: couponRedemptions.valueCents });
    } catch (error) {
      // Único parcial: o mesmo documento pagou o cupom em outra empresa ao
      // mesmo tempo (duas faturas abertas). O pagamento vale; o resgate fica
      // reservado e o caso vai para o suporte.
      if ((error as { code?: string }).code === '23505' || (error as { cause?: { code?: string } }).cause?.code === '23505') {
        this.services.logger?.warn({ alerta: true, subscriptionId: subscription.id, coupon: coupon.code }, 'cupom pago duas vezes pelo mesmo documento ou empresa');
        return;
      }
      throw error;
    }
    if (updated.length === 0) return;

    const first = [...paid].sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];
    await trackServerEvent(this.services, {
      name: 'coupon.redeemed',
      userId: subscription.purchaserUserId,
      workspaceId: subscription.workspaceId,
      properties: { code: coupon.code, cycle, valueCents: first ? Math.round(first.value * 100) : (updated[0]?.valueCents ?? 0) },
    });
  }
}
