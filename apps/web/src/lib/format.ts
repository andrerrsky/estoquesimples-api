/**
 * Formatação pt-BR. Datas chegam em ISO (UTC) e são exibidas no fuso do
 * navegador; números seguem as mesmas regras do app (quantidade com até
 * quatro casas, dinheiro com duas).
 */

const numberBR = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 });
const moneyBR = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integerBR = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dateOnly = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dayMonth = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const relative = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

export function fmtQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return numberBR.format(value);
}

/** "12 un", "3,5 kg". Unidade vazia vira "un", como no app. */
export function fmtStock(value: number | null | undefined, unit: string | null | undefined): string {
  return `${fmtQuantity(value)} ${unit && unit.trim() !== '' ? unit : 'un'}`;
}

export function fmtInteger(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : integerBR.format(value);
}

export function fmtMoney(value: number | null | undefined, symbol = 'R$'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${symbol} ${moneyBR.format(value)}`;
}

export function fmtCents(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '—' : fmtMoney(cents / 100);
}

export function fmtDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dateTime.format(new Date(value)).replace(',', '');
}

export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  // Datas puras (YYYY-MM-DD) não têm fuso: interpretar como UTC mudaria o dia.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-');
    return `${d}/${m}/${y}`;
  }
  return dateOnly.format(new Date(value));
}

export function fmtDayMonth(value: string | Date): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [, m, d] = value.split('-');
    return `${d}/${m}`;
  }
  return dayMonth.format(new Date(value));
}

export function fmtRelative(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'agora';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), 'day');
  return fmtDate(value);
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${fmtInteger(count)} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Interpreta o que a pessoa digitou num campo numérico: aceita vírgula ou
 * ponto como decimal ("1,5", "1.5", "1.234,56") e ignora símbolo de moeda.
 * Devolve `null` para texto vazio e `NaN` para texto inválido.
 */
export function parseNumber(input: string): number | null {
  const text = input.replace(/[R$€£¥\s ]/g, '');
  if (text === '') return null;
  let normalized = text;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Os dois aparecem: o último é o decimal, o outro é separador de milhar.
    normalized = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalized = text.replace(',', '.');
  }
  if (!/^-?\d*\.?\d+$/.test(normalized) && !/^-?\d+\.?$/.test(normalized)) return Number.NaN;
  return Number(normalized);
}

/** Valor de um número para pôr de volta num campo ("49,9"). */
export function numberInput(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return '';
  return String(value).replace('.', ',');
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Busca sem acento e sem caixa, como a do app. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}
