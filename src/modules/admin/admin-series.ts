import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

/**
 * Séries temporais para o painel.
 *
 * Tudo é agrupado no fuso do produto (clientes brasileiros): "cadastros de
 * ontem" precisa significar o dia de ontem em Brasília, não em UTC. As
 * consultas devolvem só os buckets com dados; `fillSeries` completa os zeros
 * para o gráfico não esconder dias vazios.
 */
export const REPORT_TIMEZONE = 'America/Sao_Paulo';

export const granularitySchema = z.enum(['day', 'week', 'month']);
export type Granularity = z.infer<typeof granularitySchema>;

export interface SeriesPoint {
  /** Início do bucket, `YYYY-MM-DD`. */
  t: string;
  v: number;
}

export const rangeQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Atalho: últimos N dias, quando `from` não vem. */
  days: z.coerce.number().int().min(1).max(730).optional(),
  granularity: granularitySchema.optional(),
});

export interface ResolvedRange {
  from: Date;
  to: Date;
  granularity: Granularity;
  days: number;
}

/** Limite de pontos por série: acima disso o gráfico vira ruído e a consulta, custo. */
const MAX_POINTS = 400;

/**
 * Sem `to` explícito o intervalo vai até "agora" com uma folga de alguns
 * minutos: o relógio do banco pode estar à frente do da API, e um cadastro
 * feito há um segundo precisa aparecer na série de hoje.
 */
const OPEN_ENDED_SLACK_MS = 5 * 60_000;

export function resolveRange(query: z.infer<typeof rangeQuerySchema>, defaultDays = 30): ResolvedRange {
  const to = query.to ?? new Date(Date.now() + OPEN_ENDED_SLACK_MS);
  const from = query.from ?? new Date(to.getTime() - (query.days ?? defaultDays) * 86_400_000);
  if (from.getTime() >= to.getTime()) {
    return { from: new Date(to.getTime() - 86_400_000), to, granularity: 'day', days: 1 };
  }
  const days = Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
  const granularity =
    query.granularity ?? (days <= 92 ? 'day' : days <= MAX_POINTS * 7 ? 'week' : 'month');
  return { from, to, granularity, days };
}

/** Expressão SQL do bucket, já no fuso do produto. */
export function bucketExpr(column: SQL, granularity: Granularity): SQL {
  return sql`to_char(date_trunc(${granularity}, ${column} AT TIME ZONE ${REPORT_TIMEZONE}), 'YYYY-MM-DD')`;
}

function startOfBucket(date: Date, granularity: Granularity): Date {
  const local = new Date(date.toLocaleString('en-US', { timeZone: REPORT_TIMEZONE }));
  local.setHours(0, 0, 0, 0);
  if (granularity === 'week') {
    // date_trunc('week') começa na segunda-feira.
    const day = (local.getDay() + 6) % 7;
    local.setDate(local.getDate() - day);
  } else if (granularity === 'month') {
    local.setDate(1);
  }
  return local;
}

function formatLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function advance(date: Date, granularity: Granularity): Date {
  const next = new Date(date);
  if (granularity === 'day') next.setDate(next.getDate() + 1);
  else if (granularity === 'week') next.setDate(next.getDate() + 7);
  else next.setMonth(next.getMonth() + 1);
  return next;
}

/** Completa a série com zeros em todos os buckets do intervalo. */
export function fillSeries(
  rows: Array<{ bucket: string; value: number | string }>,
  range: ResolvedRange,
): SeriesPoint[] {
  const byBucket = new Map(rows.map((row) => [row.bucket, Number(row.value)]));
  const points: SeriesPoint[] = [];
  let cursor = startOfBucket(range.from, range.granularity);
  const end = startOfBucket(range.to, range.granularity);
  let guard = 0;
  while (cursor.getTime() <= end.getTime() && guard < MAX_POINTS) {
    const key = formatLocal(cursor);
    points.push({ t: key, v: byBucket.get(key) ?? 0 });
    cursor = advance(cursor, range.granularity);
    guard += 1;
  }
  return points;
}

export const seriesPointSchema = z.object({ t: z.string(), v: z.number() });
