import { fmtMoney } from './format';

/**
 * Margem e lucro por unidade a partir do preço de venda e do preço de custo.
 *
 * Margem é sobre a venda — (venda − custo) / venda —, a conta que o lojista
 * faz de cabeça ("de cada R$ 10 que entram, R$ 4 ficam"). Sem custo, ou com
 * venda zero (a margem não existe), devolve `null`: mostrar 0% ou 100% ali
 * seria inventar um número.
 */
export function unitMargin(unitValue: number | null | undefined, unitCost: number | null | undefined): { margin: number; profit: number } | null {
  if (unitCost === null || unitCost === undefined || Number.isNaN(unitCost)) return null;
  if (unitValue === null || unitValue === undefined || Number.isNaN(unitValue) || unitValue <= 0) return null;
  const profit = unitValue - unitCost;
  return { margin: profit / unitValue, profit };
}

const percentBR = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

/** "32,5%". */
export function fmtMargin(margin: number): string {
  return `${percentBR.format(margin * 100)}%`;
}

/** "Margem: 40% · lucro de R$ 8,00 por unidade" (ou prejuízo, se o custo passa da venda). */
export function marginHint(unitValue: number | null | undefined, unitCost: number | null | undefined, currency = 'R$'): string | null {
  const result = unitMargin(unitValue, unitCost);
  if (!result) return null;
  const kind = result.profit < 0 ? 'prejuízo' : 'lucro';
  return `Margem: ${fmtMargin(result.margin)} · ${kind} de ${fmtMoney(Math.abs(result.profit), currency)} por unidade`;
}

/** Custo de volta para um campo: diferente de `numberInput`, custo 0 aparece como "0". */
export function costInput(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value).replace('.', ',');
}
