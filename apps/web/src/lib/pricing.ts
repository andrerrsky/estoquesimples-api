import type { BillingCycle, WebPricing } from '../api/types';
import { fmtCents } from './format';

/**
 * Preços do plano Equipe na web, por ciclo. O valor cadastrado é o total
 * cobrado no ciclo (o semestral a cada 6 meses, o anual uma vez por ano); a
 * tela mostra também o equivalente por mês, arredondado para baixo para
 * nunca anunciar um centavo a mais do que o cobrado.
 */

export interface CycleOption {
  cycle: BillingCycle;
  label: string;
  months: number;
  totalCents: number;
  perMonthCents: number;
  /** % a menos que pagar o mensal pelo mesmo tempo (0 no mensal). */
  savingPct: number;
  /** "a cada 6 meses", "uma vez por ano". */
  chargeUnit: string;
  badge: string | null;
}

const CYCLES: Array<{ cycle: BillingCycle; label: string; months: number; key: keyof WebPricing; chargeUnit: string }> = [
  { cycle: 'MONTHLY', label: 'Mensal', months: 1, key: 'monthlyCents', chargeUnit: 'todo mês' },
  { cycle: 'SEMIANNUALLY', label: 'Semestral', months: 6, key: 'semiannualCents', chargeUnit: 'a cada 6 meses' },
  { cycle: 'YEARLY', label: 'Anual', months: 12, key: 'yearlyCents', chargeUnit: 'uma vez por ano' },
];

export function cycleOptions(pricing: WebPricing | null | undefined): CycleOption[] {
  if (!pricing) return [];
  const monthly = pricing.monthlyCents;
  const options = CYCLES.flatMap((item) => {
    const total = pricing[item.key];
    if (total === null || total === undefined) return [];
    // Trava contra cadastro errado (ex.: o "anual" com o valor de um mês):
    // um ciclo longo que custe menos da metade do mensal pelo mesmo tempo
    // não é oferecido.
    if (item.months > 1 && monthly && total < monthly * item.months * 0.5) return [];
    const perMonth = Math.floor(total / item.months);
    const savingPct = monthly && item.months > 1 ? Math.max(0, Math.round((1 - total / (monthly * item.months)) * 100)) : 0;
    return [{ cycle: item.cycle, label: item.label, months: item.months, totalCents: total, perMonthCents: perMonth, savingPct, chargeUnit: item.chargeUnit, badge: null as string | null }];
  });
  // Selos: o semestral é o do meio (não assusta pelo valor); o mais barato por mês é o "melhor preço".
  const cheapest = options.reduce<CycleOption | null>((best, option) => (best === null || option.perMonthCents < best.perMonthCents ? option : best), null);
  for (const option of options) {
    if (option.cycle === 'SEMIANNUALLY' && options.length > 2) option.badge = 'Recomendado';
    else if (cheapest && option === cheapest && option.months > 1) option.badge = 'Melhor preço';
  }
  return options;
}

/** Ciclo que já vem marcado: o semestral; sem ele, o maior com desconto; senão o mensal. */
export function defaultCycle(options: CycleOption[]): BillingCycle {
  return (options.find((option) => option.cycle === 'SEMIANNUALLY') ?? options.find((option) => option.savingPct > 0) ?? options[0])?.cycle ?? 'MONTHLY';
}

/** Menor valor por mês entre os ciclos à venda ("a partir de R$ 16,65/mês"). */
export function lowestPerMonth(pricing: WebPricing | null | undefined): number | null {
  const options = cycleOptions(pricing);
  return options.length === 0 ? null : Math.min(...options.map((option) => option.perMonthCents));
}

export function maxSavingPct(pricing: WebPricing | null | undefined): number {
  return Math.max(0, ...cycleOptions(pricing).map((option) => option.savingPct));
}

/** "R$ 129,90 a cada 6 meses · economize 13%". */
export function chargeLine(option: CycleOption): string {
  const base = `${fmtCents(option.totalCents)} ${option.chargeUnit}`;
  return option.savingPct > 0 ? `${base} · economize ${option.savingPct}%` : `${base}. Cancele quando quiser.`;
}
