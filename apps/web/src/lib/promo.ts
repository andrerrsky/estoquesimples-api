import type { CouponReason, PromoPrices, PublicPromo, SubscriptionState } from '../api/types';
import { fmtCents } from './format';

/**
 * Lógica pura da campanha (Black Friday 2026): cupom guardado no navegador,
 * regra de reaparecer da faixa, fase da campanha e textos de preço. Sem
 * React, para testar sem navegador (tests/promo.test.ts). Quem decide preço,
 * vigência e elegibilidade é a API; aqui só se escolhe o que mostrar.
 */

const COUPON_KEY = 'es_cupom';
const BAR_KEY = 'es_promo_faixa';
/** Cupom guardado antes de a campanha carregar (sem `endsAt`) vale no máximo isto. */
const PROVISIONAL_MS = 30 * 86_400_000;
const TZ = 'America/Sao_Paulo';

/** Estados de assinatura viva que não podem usar o cupom (`pendente` pode retomar). */
const BLOCKING_STATES: ReadonlySet<SubscriptionState> = new Set(['ativa', 'carencia', 'suspensa', 'cancelada_mas_ativa']);

export function blocksPromo(state: SubscriptionState | null | undefined): boolean {
  return state ? BLOCKING_STATES.has(state) : false;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cupom
// ---------------------------------------------------------------------------

/** Como a API: sem espaços, maiúsculas, até 32; só letras, dígitos, `-` e `_`. */
export function normalizeCoupon(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim().toUpperCase();
  return /^[A-Z0-9_-]{1,32}$/.test(code) ? code : null;
}

interface StoredCoupon {
  code: string;
  /** ms; validade até o `endsAt` da campanha ou, sem ele, provisória. */
  expiresAt: number;
}

export function saveCoupon(code: string, endsAt: string | null | undefined, now = Date.now()): void {
  const clean = normalizeCoupon(code);
  const store = storage();
  if (!clean || !store) return;
  const end = endsAt ? Date.parse(endsAt) : Number.NaN;
  const expiresAt = Number.isFinite(end) ? end : now + PROVISIONAL_MS;
  if (expiresAt <= now) return;
  try {
    store.setItem(COUPON_KEY, JSON.stringify({ code: clean, expiresAt } satisfies StoredCoupon));
  } catch {
    // armazenamento cheio ou bloqueado: o cupom pode ser digitado
  }
}

/** Cupom guardado e ainda válido; o vencido é apagado. */
export function readCoupon(now = Date.now()): string | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(COUPON_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredCoupon>;
    const code = normalizeCoupon(parsed.code);
    if (!code || typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= now) {
      store.removeItem(COUPON_KEY);
      return null;
    }
    return code;
  } catch {
    return null;
  }
}

export function clearCoupon(): void {
  try {
    storage()?.removeItem(COUPON_KEY);
  } catch {
    // nada a limpar
  }
}

/** `?cupom=XXX` em qualquer página: guarda (sobrevive a cadastro e login). */
export function captureCouponFromUrl(search: string, now = Date.now()): string | null {
  const code = normalizeCoupon(new URLSearchParams(search).get('cupom'));
  if (!code) return null;
  // Mantém a validade exata se o mesmo cupom já estava guardado com a data da campanha.
  if (readCoupon(now) !== code) saveCoupon(code, null, now);
  return code;
}

/**
 * Com a campanha carregada: o cupom da campanha passa a valer até o `endsAt`
 * real; campanha encerrada apaga o cupom dela.
 */
export function syncCouponWithPromo(promo: PublicPromo, now = Date.now()): void {
  const code = readCoupon(now);
  if (!code || !promo.code || code !== promo.code) return;
  if (promoPhase(promo, now) === 'ended') clearCoupon();
  else if (promo.endsAt) saveCoupon(code, promo.endsAt, now);
}

export function couponErrorMessage(reason: CouponReason | null | undefined): string {
  switch (reason) {
    case 'expirado':
      return 'Este cupom já expirou. A oferta terminou.';
    case 'ainda_nao_comecou':
      return 'Este cupom ainda não está valendo. A oferta começa em 20/11.';
    default:
      return 'Cupom não encontrado. Confira o código e tente de novo.';
  }
}

// ---------------------------------------------------------------------------
// Fase da campanha
// ---------------------------------------------------------------------------

export type PromoPhase = 'none' | 'upcoming' | 'active' | 'ended';

/** O relógio do navegador só antecipa o fim (a contagem chega a zero); quem abre é a API. */
export function promoPhase(promo: PublicPromo | null | undefined, now = Date.now()): PromoPhase {
  if (!promo) return 'none';
  const end = promo.endsAt ? Date.parse(promo.endsAt) : Number.NaN;
  const ended = Number.isFinite(end) && now > end;
  if (promo.active) return ended ? 'ended' : 'active';
  if (promo.upcoming) return 'upcoming';
  return ended ? 'ended' : 'none';
}

export function hasPrices(promo: Partial<PromoPrices> | null | undefined): promo is PromoPrices {
  return Boolean(promo?.yearly && promo.monthly && promo.yearly.promoCents > 0 && promo.monthly.firstCents > 0);
}

// ---------------------------------------------------------------------------
// Faixa do topo: fechada, só volta no último dia, uma vez
// ---------------------------------------------------------------------------

/** "2026-12-01", no fuso de Brasília. */
export function dayInBrazil(ms: number): string {
  return new Date(ms).toLocaleDateString('sv-SE', { timeZone: TZ });
}

/**
 * Nunca fechada: aparece. Fechada: só volta no último dia da campanha (dia do
 * `endsAt` em Brasília), se tiver sido fechada antes dele; fechada de novo
 * nesse dia, não volta mais.
 */
export function barVisible(dismissedAt: number | null, endsAt: string | null | undefined, now = Date.now()): boolean {
  if (dismissedAt === null) return true;
  const end = endsAt ? Date.parse(endsAt) : Number.NaN;
  if (!Number.isFinite(end)) return false;
  const lastDay = dayInBrazil(end);
  return dayInBrazil(now) === lastDay && dayInBrazil(dismissedAt) < lastDay;
}

export function readBarDismissed(code: string): number | null {
  try {
    const raw = storage()?.getItem(`${BAR_KEY}_${code}`);
    const value = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function dismissBar(code: string, now = Date.now()): void {
  try {
    storage()?.setItem(`${BAR_KEY}_${code}`, String(now));
  } catch {
    // sem armazenamento: some só nesta visita
  }
}

// ---------------------------------------------------------------------------
// Preços
// ---------------------------------------------------------------------------

/** Equivalente por mês, arredondado para baixo (nunca anuncia um centavo a mais). */
export function monthlyEquivalentCents(totalCents: number, months = 12): number {
  return Math.floor(totalCents / months);
}

export function discountPct(fullCents: number, promoCents: number): number {
  return fullCents > 0 ? Math.max(0, Math.round((1 - promoCents / fullCents) * 100)) : 0;
}

export interface PromoTexts {
  yearlyFull: string;
  yearlyPromo: string;
  yearlyPerMonth: string;
  yearlyPct: number;
  monthlyFull: string;
  monthlyFirst: string;
  /** "1º mês" ou "2 primeiros meses". */
  monthlyFirstLabel: string;
  yearlyRenewal: string;
  monthlyRenewal: string;
}

export function promoTexts(prices: PromoPrices): PromoTexts {
  const { yearly, monthly } = prices;
  const perMonth = yearly.monthlyEquivalentCents > 0 ? yearly.monthlyEquivalentCents : monthlyEquivalentCents(yearly.promoCents);
  const cycles = Math.max(1, monthly.promoCycles || 1);
  return {
    yearlyFull: fmtCents(yearly.fullCents),
    yearlyPromo: fmtCents(yearly.promoCents),
    yearlyPerMonth: fmtCents(perMonth),
    yearlyPct: discountPct(yearly.fullCents, yearly.promoCents),
    monthlyFull: fmtCents(monthly.fullCents),
    monthlyFirst: fmtCents(monthly.firstCents),
    monthlyFirstLabel: cycles === 1 ? '1º mês' : `${cycles} primeiros meses`,
    yearlyRenewal: `Renova por ${fmtCents(yearly.fullCents)}/ano, com aviso antes.`,
    monthlyRenewal: `A partir da ${cycles + 1}ª cobrança, ${fmtCents(monthly.fullCents)}/mês, com aviso antes.`,
  };
}

/** Data curta do fim, em Brasília ("01/12"). */
export function endDayLabel(endsAt: string | null | undefined): string {
  const end = endsAt ? Date.parse(endsAt) : Number.NaN;
  if (!Number.isFinite(end)) return '';
  return new Date(end).toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' });
}

export interface Countdown {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  done: boolean;
}

export function countdown(endsAt: string | null | undefined, now = Date.now()): Countdown {
  const end = endsAt ? Date.parse(endsAt) : Number.NaN;
  const left = Number.isFinite(end) ? Math.max(0, Math.floor((end - now) / 1000)) : 0;
  return {
    days: Math.floor(left / 86_400),
    hours: Math.floor((left % 86_400) / 3600),
    minutes: Math.floor((left % 3600) / 60),
    seconds: left % 60,
    done: left === 0,
  };
}

/**
 * Destino do CTA da landing: cadastro (que leva ao Plano depois das
 * boas-vindas) ou, com sessão, o próprio Plano; sempre com o cupom e as UTMs
 * da visita.
 */
export function landingCtaUrl(search: string, authed: boolean, code: string): string {
  const from = new URLSearchParams(search);
  const out = new URLSearchParams();
  if (!authed) out.set('depois', '/app/plano?origem=black_friday');
  else out.set('origem', 'black_friday');
  out.set('cupom', code);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'gbraid', 'wbraid']) {
    const value = from.get(key);
    if (value) out.set(key, value.slice(0, 150));
  }
  return `${authed ? '/app/plano' : '/criar-conta'}?${out.toString()}`;
}
