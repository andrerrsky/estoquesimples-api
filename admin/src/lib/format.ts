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
