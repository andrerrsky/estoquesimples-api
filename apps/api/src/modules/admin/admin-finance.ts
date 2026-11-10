import { sql } from 'drizzle-orm';

import type { AppServices } from '../../platform/http/context.js';
import { isPaidStatus, toCycle, CYCLE_MONTHS } from '../billing/asaas/asaas-state.js';
import { REPORT_TIMEZONE } from './admin-series.js';

/**
 * Relatório financeiro das assinaturas (tela Assinaturas do painel).
 *
 * Dois provedores, duas fontes de verdade diferentes:
 * - **Web (Asaas):** a receita realizada vem das cobranças pagas
 *   (`billing_payments`), com o valor líquido que o próprio Asaas informa.
 * - **App (Google Play):** o Google não manda as cobranças, só a assinatura.
 *   As cobranças são reconstruídas a partir do início, do ciclo mensal e do
 *   preço recorrente que vem no comprovante (`lineItems[].autoRenewingPlan
 *   .recurringPrice`). A oferta de entrada não traz valor; ele vem do plano
 *   (`google_offer_price_cents`, `google_offer_cycles`). O líquido desconta a
 *   taxa de serviço de 15% do Google para assinaturas.
 *
 * Tudo antes de impostos. Valores em centavos.
 */

/** Taxa de serviço do Google Play para assinaturas (desde 2022: 15% desde o 1º mês). */
export const GOOGLE_PLAY_FEE = 0.15;

/** Estimativa da tarifa do Asaas quando a cobrança ainda não informou o líquido. */
export function estimateAsaasFeeCents(grossCents: number, billingType: string | null): number {
  if (billingType === 'CREDIT_CARD') return Math.round(grossCents * 0.0299 + 49);
  return 199; // Pix e boleto: tarifa fixa por cobrança recebida.
}

const TERMINAL_STATES = new Set(['expirada', 'reembolsada', 'substituida']);
const RECURRING_STATES = new Set(['ativa', 'carencia']);
const ENTITLED_STATES = new Set(['ativa', 'carencia', 'cancelada_mas_ativa']);

export interface FinanceSubscription {
  id: string;
  provider: string;
  state: string;
  billingCycle: string | null;
  billingType: string | null;
  priceCents: number | null;
  startedAt: Date | null;
  currentPeriodEnd: Date | null;
  canceledAt: Date | null;
  updatedAt: Date;
  googleOfferId: string | null;
  /** Preço recorrente do Google em centavos (do comprovante). */
  googleRecurringCents: number | null;
  /** O comprovante diz que a assinatura está numa fase de oferta. */
  googleInOfferPhase: boolean;
  offerPriceCents: number | null;
  offerCycles: number | null;
}

export interface FinancePayment {
  subscriptionId: string | null;
  status: string;
  billingType: string | null;
  valueCents: number;
  netValueCents: number | null;
  paidAt: Date | null;
  dueDate: string | null;
}

export interface FinanceMonth {
  /** `YYYY-MM` no fuso de Brasília. */
  month: string;
  grossCents: number;
  netCents: number;
  feesCents: number;
  appNetCents: number;
  webNetCents: number;
  newSubscriptions: number;
  churned: number;
  activeAtEnd: number;
  mrrNetAtEnd: number;
}

export interface FinanceReport {
  generatedAt: string;
  months: FinanceMonth[];
  now: {
    paying: number;
    payingApp: number;
    payingWeb: number;
    inOffer: number;
    mrrGrossCents: number;
    mrrNetCents: number;
    mrrNetAppCents: number;
    mrrNetWebCents: number;
    arrNetCents: number;
    arpuNetCents: number | null;
    cancelingAtPeriodEnd: number;
  };
  totals: {
    grossCents: number;
    netCents: number;
    feesCents: number;
  };
  assumptions: {
    googleFeePct: number;
    googleOfferPriceCents: number | null;
    googleOfferCycles: number | null;
  };
}

const monthFmt = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit' });

export function monthKey(date: Date): string {
  return monthFmt.format(date).slice(0, 7);
}

/** Fim do mês (início do mês seguinte, 00:00 em Brasília). */
function monthEnd(key: string): Date {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return new Date(`${nextY}-${String(nextM).padStart(2, '0')}-01T00:00:00-03:00`);
}

function lastMonths(now: Date, count: number): string[] {
  const keys: string[] = [];
  const [y, m] = monthKey(now).split('-').map(Number) as [number, number];
  for (let i = count - 1; i >= 0; i--) {
    const index = y * 12 + (m - 1) - i;
    keys.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`);
  }
  return keys;
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/** Até quando a assinatura dá acesso (para "ativas no fim do mês"). */
function entitledUntil(sub: FinanceSubscription, now: Date): Date | null {
  if (sub.state === 'pendente' || sub.state === 'suspensa') return null;
  if (ENTITLED_STATES.has(sub.state)) {
    return sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
  }
  // Terminal: acabou no fim do período (ou quando foi atualizada pela última vez).
  return sub.currentPeriodEnd ?? sub.canceledAt ?? sub.updatedAt;
}

function googleChargeCents(sub: FinanceSubscription, index: number): number {
  const recurring = sub.googleRecurringCents ?? 0;
  const hasOffer = Boolean(sub.googleOfferId) && sub.offerPriceCents !== null && sub.offerCycles !== null;
  if (hasOffer && index < (sub.offerCycles as number)) return sub.offerPriceCents as number;
  return recurring;
}

/** Valor mensal equivalente, bruto e líquido, de uma assinatura que renova. */
function monthlyValue(sub: FinanceSubscription, at: Date): { gross: number; net: number } {
  if (sub.provider === 'google_play') {
    const index = sub.startedAt ? Math.max(0, monthsBetween(sub.startedAt, at)) : 0;
    const gross = googleChargeCents(sub, index);
    return { gross, net: Math.round(gross * (1 - GOOGLE_PLAY_FEE)) };
  }
  if (sub.priceCents === null) return { gross: 0, net: 0 };
  const months = CYCLE_MONTHS[toCycle(sub.billingCycle)];
  const net = sub.priceCents - estimateAsaasFeeCents(sub.priceCents, sub.billingType);
  return { gross: Math.round(sub.priceCents / months), net: Math.round(net / months) };
}

function monthsBetween(from: Date, to: Date): number {
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return months;
}

interface Charge {
  at: Date;
  gross: number;
  net: number;
  provider: string;
}

/** Cobranças do Google reconstruídas: uma por mês desde o início, até o fim do acesso ou hoje. */
function googleCharges(sub: FinanceSubscription, now: Date): Charge[] {
  if (!sub.startedAt || sub.state === 'reembolsada' || sub.state === 'pendente') return [];
  const until = TERMINAL_STATES.has(sub.state) ? (sub.currentPeriodEnd ?? sub.updatedAt) : now;
  const charges: Charge[] = [];
  for (let index = 0; index < 600; index++) {
    const at = addMonths(sub.startedAt, index);
    if (at > now || (TERMINAL_STATES.has(sub.state) && at >= until)) break;
    // Cancelada mas ativa: a próxima renovação não acontece.
    if (sub.state === 'cancelada_mas_ativa' && sub.currentPeriodEnd && at >= sub.currentPeriodEnd) break;
    const gross = googleChargeCents(sub, index);
    charges.push({ at, gross, net: Math.round(gross * (1 - GOOGLE_PLAY_FEE)), provider: 'google_play' });
  }
  return charges;
}

export function buildFinanceReport(input: {
  subscriptions: FinanceSubscription[];
  payments: FinancePayment[];
  now: Date;
  months: number;
  offer: { priceCents: number | null; cycles: number | null };
}): FinanceReport {
  const { now } = input;
  const keys = lastMonths(now, input.months);
  const byMonth = new Map<string, FinanceMonth>(
    keys.map((month) => [
      month,
      { month, grossCents: 0, netCents: 0, feesCents: 0, appNetCents: 0, webNetCents: 0, newSubscriptions: 0, churned: 0, activeAtEnd: 0, mrrNetAtEnd: 0 },
    ]),
  );
  const totals = { grossCents: 0, netCents: 0, feesCents: 0 };

  const addCharge = (charge: Charge) => {
    totals.grossCents += charge.gross;
    totals.netCents += charge.net;
    totals.feesCents += charge.gross - charge.net;
    const bucket = byMonth.get(monthKey(charge.at));
    if (!bucket) return;
    bucket.grossCents += charge.gross;
    bucket.netCents += charge.net;
    bucket.feesCents += charge.gross - charge.net;
    if (charge.provider === 'google_play') bucket.appNetCents += charge.net;
    else bucket.webNetCents += charge.net;
  };

  for (const sub of input.subscriptions) {
    if (sub.provider === 'google_play') googleCharges(sub, now).forEach(addCharge);
  }
  for (const payment of input.payments) {
    if (!isPaidStatus(payment.status)) continue;
    const at = payment.paidAt ?? (payment.dueDate ? new Date(`${payment.dueDate}T12:00:00-03:00`) : null);
    if (!at) continue;
    const net = payment.netValueCents ?? payment.valueCents - estimateAsaasFeeCents(payment.valueCents, payment.billingType);
    addCharge({ at, gross: payment.valueCents, net, provider: 'asaas' });
  }

  for (const sub of input.subscriptions) {
    if (sub.state === 'substituida' && !sub.startedAt) continue;
    if (sub.startedAt) {
      const bucket = byMonth.get(monthKey(sub.startedAt));
      if (bucket && sub.state !== 'pendente') bucket.newSubscriptions += 1;
    }
    const until = entitledUntil(sub, now);
    // Saída: acesso terminou de vez (substituída não conta: virou outra assinatura).
    if (until && (sub.state === 'expirada' || sub.state === 'reembolsada')) {
      const bucket = byMonth.get(monthKey(until));
      if (bucket) bucket.churned += 1;
    }
    if (!sub.startedAt || !until) continue;
    for (const month of keys) {
      const end = monthEnd(month);
      const pointInTime = end > now ? now : new Date(end.getTime() - 1);
      if (sub.startedAt <= pointInTime && until > pointInTime) {
        const bucket = byMonth.get(month)!;
        bucket.activeAtEnd += 1;
        // Receita recorrente no fim do mês: quem tinha acesso e renovava. No
        // mês corrente, quem já desligou a renovação não entra (igual ao "agora").
        const isNow = pointInTime === now;
        const counts = sub.state !== 'reembolsada' && !(isNow && sub.state === 'cancelada_mas_ativa');
        if (counts) bucket.mrrNetAtEnd += monthlyValue(sub, pointInTime).net;
      }
    }
  }

  const recurring = input.subscriptions.filter((sub) => RECURRING_STATES.has(sub.state));
  let mrrGross = 0;
  let mrrNet = 0;
  let mrrNetApp = 0;
  let mrrNetWeb = 0;
  let inOffer = 0;
  for (const sub of recurring) {
    const value = monthlyValue(sub, now);
    mrrGross += value.gross;
    mrrNet += value.net;
    if (sub.provider === 'google_play') {
      mrrNetApp += value.net;
      if (sub.googleInOfferPhase) inOffer += 1;
    } else {
      mrrNetWeb += value.net;
    }
  }
  const paying = recurring.length;
  return {
    generatedAt: now.toISOString(),
    months: keys.map((key) => byMonth.get(key)!),
    now: {
      paying,
      payingApp: recurring.filter((sub) => sub.provider === 'google_play').length,
      payingWeb: recurring.filter((sub) => sub.provider !== 'google_play').length,
      inOffer,
      mrrGrossCents: mrrGross,
      mrrNetCents: mrrNet,
      mrrNetAppCents: mrrNetApp,
      mrrNetWebCents: mrrNetWeb,
      arrNetCents: mrrNet * 12,
      arpuNetCents: paying > 0 ? Math.round(mrrNet / paying) : null,
      cancelingAtPeriodEnd: input.subscriptions.filter((sub) => sub.state === 'cancelada_mas_ativa').length,
    },
    totals,
    assumptions: {
      googleFeePct: GOOGLE_PLAY_FEE * 100,
      googleOfferPriceCents: input.offer.priceCents,
      googleOfferCycles: input.offer.cycles,
    },
  };
}

/** Preço recorrente do comprovante do Google (`units` + `nanos`), em centavos. */
export function googleRecurringCents(raw: unknown): { cents: number | null; inOffer: boolean } {
  const item = (raw as { lineItems?: Array<Record<string, unknown>> } | null)?.lineItems?.[0];
  const price = (item?.['autoRenewingPlan'] as { recurringPrice?: { units?: string | number; nanos?: number } } | undefined)?.recurringPrice;
  const cents = price ? Math.round(Number(price.units ?? 0) * 100 + Number(price.nanos ?? 0) / 10_000_000) : null;
  const phase = item?.['offerPhase'] as Record<string, unknown> | undefined;
  const inOffer = Boolean(phase && ('introductoryPrice' in phase || 'freeTrial' in phase || 'prorationPeriod' in phase));
  return { cents: Number.isFinite(cents) ? cents : null, inOffer };
}

export async function loadFinanceReport(services: AppServices, months: number, now = new Date()): Promise<FinanceReport> {
  const { db } = services;
  const subs = await db.execute<{
    id: string; provider: string; state: string; billing_cycle: string | null; billing_type: string | null;
    price_cents: number | null; started_at: Date | string | null; current_period_end: Date | string | null;
    canceled_at: Date | string | null; updated_at: Date | string; google_offer_id: string | null; raw: unknown;
    offer_price: number | null; offer_cycles: number | null;
  }>(sql`
    SELECT s.id, s.provider, s.state, s.billing_cycle, s.billing_type, s.price_cents, s.started_at,
           s.current_period_end, s.canceled_at, s.updated_at, s.google_offer_id,
           CASE WHEN s.provider = 'google_play' THEN s.raw ELSE NULL END AS raw,
           p.google_offer_price_cents AS offer_price, p.google_offer_cycles AS offer_cycles
    FROM subscriptions s
    LEFT JOIN plans p ON p.key = s.plan_key
  `);
  const payments = await db.execute<{
    subscription_id: string | null; status: string; billing_type: string | null; value_cents: number;
    net_value_cents: number | null; paid_at: Date | string | null; due_date: string | null;
  }>(sql`
    SELECT subscription_id, status, billing_type, value_cents, net_value_cents, paid_at, due_date::text AS due_date
    FROM billing_payments WHERE deleted = false
  `);
  const offerRow = await db.execute<{ price: number | null; cycles: number | null }>(sql`
    SELECT google_offer_price_cents AS price, google_offer_cycles AS cycles FROM plans WHERE key = 'basico'
  `);
  const date = (value: Date | string | null) => (value === null ? null : value instanceof Date ? value : new Date(value));
  return buildFinanceReport({
    now,
    months,
    offer: { priceCents: offerRow.rows[0]?.price ?? null, cycles: offerRow.rows[0]?.cycles ?? null },
    subscriptions: subs.rows.map((row) => {
      const google = row.provider === 'google_play' ? googleRecurringCents(row.raw) : { cents: null, inOffer: false };
      return {
        id: row.id,
        provider: row.provider,
        state: row.state,
        billingCycle: row.billing_cycle,
        billingType: row.billing_type,
        priceCents: row.price_cents,
        startedAt: date(row.started_at),
        currentPeriodEnd: date(row.current_period_end),
        canceledAt: date(row.canceled_at),
        updatedAt: date(row.updated_at) as Date,
        googleOfferId: row.google_offer_id,
        googleRecurringCents: google.cents,
        googleInOfferPhase: google.inOffer,
        offerPriceCents: row.offer_price,
        offerCycles: row.offer_cycles,
      };
    }),
    payments: payments.rows.map((row) => ({
      subscriptionId: row.subscription_id,
      status: row.status,
      billingType: row.billing_type,
      valueCents: row.value_cents,
      netValueCents: row.net_value_cents,
      paidAt: date(row.paid_at),
      dueDate: row.due_date,
    })),
  });
}
