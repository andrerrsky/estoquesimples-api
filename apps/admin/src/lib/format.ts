const LOCALE = 'pt-BR';
const TIMEZONE = 'America/Sao_Paulo';

const dateTime = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIMEZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const dateOnly = new Intl.DateTimeFormat(LOCALE, { timeZone: TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric' });
const dayMonth = new Intl.DateTimeFormat(LOCALE, { timeZone: TIMEZONE, day: '2-digit', month: 'short' });
const number = new Intl.NumberFormat(LOCALE);
const decimal = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });
const currency = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'BRL' });
const percent = new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 1 });

export function fmtDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dateTime.format(new Date(value));
}

export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dateOnly.format(new Date(value));
}

/** `YYYY-MM-DD` de uma série vira "05 set" sem passar por fuso. */
export function fmtBucket(bucket: string, granularity: 'day' | 'week' | 'month' = 'day'): string {
  const [y, m, d] = bucket.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
  if (granularity === 'month') {
    return new Intl.DateTimeFormat(LOCALE, { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(date);
  }
  return new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(date);
}

export function fmtDayMonth(value: string | Date): string {
  return dayMonth.format(new Date(value));
}

export function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return number.format(value);
}

export function fmtDecimal(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return decimal.format(value);
}

export function fmtCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return currency.format(value);
}

/** Valor guardado em centavos (preço de plano, cobrança) → "R$ 29,90". */
export function fmtCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  return currency.format(cents / 100);
}

/** Centavos → texto de campo de formulário ("29,90"), sem símbolo. */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return `${Math.trunc(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

/**
 * Texto em reais → centavos inteiros. `null` para campo vazio; `undefined`
 * quando o texto não é um valor em reais.
 *
 * A conta é feita com os dígitos, sem passar por float: `19.99 * 100` dá
 * 1998.9999… e viraria um centavo a menos. Aceita o que se digita no Brasil
 * ("29,90", "1.234,56", "R$ 29,9", "30") e também ponto decimal ("29.90").
 * "2.990" é ambíguo (milhar ou três casas?) e é recusado em vez de adivinhado.
 */
export function parseReaisToCents(text: string): number | null | undefined {
  const clean = text.replace(/\s|R\$/gi, '');
  if (clean === '') return null;
  let integer: string;
  let fraction: string;
  if (clean.includes(',')) {
    const match = /^(\d{1,3}(?:\.\d{3})+|\d+),(\d{1,2})$/.exec(clean);
    if (!match) return undefined;
    integer = (match[1] as string).replace(/\./g, '');
    fraction = match[2] as string;
  } else {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(clean);
    if (!match) return undefined;
    integer = match[1] as string;
    fraction = match[2] ?? '';
  }
  if (integer.length > 9) return undefined;
  return Number(integer) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Data sem hora (`YYYY-MM-DD`, vencimento de cobrança) sem passar por fuso. */
export function fmtDay(value: string | null | undefined): string {
  if (!value) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

export function fmtPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return percent.format(value);
}

export function fmtCompact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${decimal.format(value / 1_000_000)} mi`;
  if (Math.abs(value) >= 10_000) return `${decimal.format(value / 1_000)} mil`;
  return number.format(value);
}

const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [7, 'day'],
  [4.35, 'week'],
  [12, 'month'],
  [Number.POSITIVE_INFINITY, 'year'],
];
const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

export function fmtRelative(value: string | Date | null | undefined): string {
  if (!value) return '—';
  let delta = (new Date(value).getTime() - Date.now()) / 1000;
  for (const [step, unit] of units) {
    if (Math.abs(delta) < step) return relative.format(Math.round(delta), unit);
    delta /= step;
  }
  return fmtDate(value);
}

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}min`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`;
}

/** Variação relativa entre dois períodos, ou null quando não há base. */
export function deltaRatio(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / previous;
}

export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function pluralize(count: number, singular: string, plural: string): string {
  return `${fmtNumber(count)} ${count === 1 ? singular : plural}`;
}
