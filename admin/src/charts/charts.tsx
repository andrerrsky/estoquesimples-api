import { useId, useMemo, useRef, useState, type ReactNode } from 'react';

import type { SeriesPoint } from '../api/client';
import { fmtBucket, fmtNumber, fmtPercent } from '../lib/format';

/**
 * Gráficos em SVG puro, sem biblioteca.
 *
 * Regras seguidas (as mesmas do produto): uma série é a cor da marca, várias
 * séries usam a ordem fixa validada para daltonismo, uma escala por eixo,
 * traços finos, grade discreta, tooltip em toda superfície com dados e legenda
 * sempre que houver mais de uma série.
 */
export const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

export interface Series {
  key: string;
  label: string;
  points: SeriesPoint[];
  color?: string;
}

interface TooltipState {
  index: number;
  x: number;
  y: number;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Marcas do eixo Y: sempre inteiras quando o máximo é pequeno (contagens). */
function ticks(max: number, count = 4): number[] {
  const steps = max < count ? Math.max(1, Math.round(max)) : count;
  const result: number[] = [];
  for (let i = 0; i <= steps; i += 1) result.push((max / steps) * i);
  return result;
}

/** Rótulos do eixo X ancorados no último ponto, para a data mais recente aparecer sem colidir. */
function isXTick(index: number, length: number, every: number): boolean {
  return (length - 1 - index) % every === 0;
}

export function LineChart({
  series,
  height = 220,
  granularity = 'day',
  area = true,
  formatValue = fmtNumber,
}: {
  series: Series[];
  height?: number;
  granularity?: 'day' | 'week' | 'month';
  area?: boolean;
  formatValue?: (value: number) => string;
}) {
  const id = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const width = 720;
  const pad = { top: 12, right: 12, bottom: 28, left: 40 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const labels = series[0]?.points.map((point) => point.t) ?? [];
  const max = niceMax(Math.max(1, ...series.flatMap((item) => item.points.map((point) => point.v))));
  const xOf = (index: number) => pad.left + (labels.length <= 1 ? innerW / 2 : (index / (labels.length - 1)) * innerW);
  const yOf = (value: number) => pad.top + innerH - (value / max) * innerH;

  const paths = useMemo(
    () =>
      series.map((item) => {
        const line = item.points.map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)},${yOf(point.v).toFixed(1)}`).join(' ');
        const areaPath = `${line} L${xOf(item.points.length - 1).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${xOf(0).toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;
        return { line, area: areaPath };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, max, labels.length],
  );

  if (labels.length === 0) return <div className="empty small">Sem dados no período.</div>;

  const xTickEvery = Math.max(1, Math.ceil(labels.length / 8));

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = width / rect.width;
    const x = (event.clientX - rect.left) * scale;
    const ratio = labels.length <= 1 ? 0 : (x - pad.left) / innerW;
    const index = Math.min(labels.length - 1, Math.max(0, Math.round(ratio * (labels.length - 1))));
    setTooltip({ index, x: xOf(index) / scale, y: (event.clientY - rect.top) });
  };

  return (
    <div className="chart" ref={wrapRef}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Gráfico de linhas" onMouseMove={onMove} onMouseLeave={() => setTooltip(null)}>
        {ticks(max).map((tick) => (
          <g key={tick}>
            <line className="chart__grid" x1={pad.left} x2={width - pad.right} y1={yOf(tick)} y2={yOf(tick)} />
            <text className="chart__axis" x={pad.left - 6} y={yOf(tick) + 4} textAnchor="end">
              {formatValue(tick)}
            </text>
          </g>
        ))}
        {labels.map((label, index) =>
          isXTick(index, labels.length, xTickEvery) ? (
            <text key={label} className="chart__axis" x={xOf(index)} y={height - 8} textAnchor="middle">
              {fmtBucket(label, granularity)}
            </text>
          ) : null,
        )}
        {series.map((item, sIndex) => {
          const color = item.color ?? SERIES_COLORS[sIndex % SERIES_COLORS.length];
          return (
            <g key={item.key}>
              {area && series.length === 1 && <path className="chart__area" d={paths[sIndex]?.area} fill={color} />}
              <path className="chart__line" d={paths[sIndex]?.line} stroke={color} />
            </g>
          );
        })}
        {tooltip && (
          <g>
            <line className="chart__crosshair" x1={xOf(tooltip.index)} x2={xOf(tooltip.index)} y1={pad.top} y2={pad.top + innerH} />
            {series.map((item, sIndex) => {
              const point = item.points[tooltip.index];
              if (!point) return null;
              return (
                <circle
                  key={item.key}
                  className="chart__marker"
                  cx={xOf(tooltip.index)}
                  cy={yOf(point.v)}
                  r={4.5}
                  fill={item.color ?? SERIES_COLORS[sIndex % SERIES_COLORS.length]}
                />
              );
            })}
          </g>
        )}
        <title id={id}>Gráfico</title>
      </svg>
      {tooltip && (
        <div className="chart__tooltip" style={{ left: tooltip.x, top: Math.max(40, tooltip.y) }}>
          <div className="chart__tooltip-title">{fmtBucket(labels[tooltip.index] ?? '', granularity)}</div>
          {series.map((item, sIndex) => (
            <div key={item.key} className="chart__tooltip-row">
              <span>
                <span className="chart__tooltip-swatch" style={{ background: item.color ?? SERIES_COLORS[sIndex % SERIES_COLORS.length] }} />
                {item.label}
              </span>
              <strong>{formatValue(item.points[tooltip.index]?.v ?? 0)}</strong>
            </div>
          ))}
        </div>
      )}
      {series.length > 1 && <Legend series={series} />}
    </div>
  );
}

export function Legend({ series }: { series: Series[] }) {
  return (
    <div className="legend" style={{ marginTop: 8 }}>
      {series.map((item, index) => (
        <span key={item.key} className="legend__item">
          <span className="legend__swatch" style={{ background: item.color ?? SERIES_COLORS[index % SERIES_COLORS.length] }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function BarChart({
  points,
  height = 200,
  granularity = 'day',
  color = SERIES_COLORS[0],
  formatValue = fmtNumber,
  label = 'Total',
}: {
  points: SeriesPoint[];
  height?: number;
  granularity?: 'day' | 'week' | 'month';
  color?: string;
  formatValue?: (value: number) => string;
  label?: string;
}) {
  const [hover, setHover] = useState<TooltipState | null>(null);
  const width = 720;
  const pad = { top: 12, right: 12, bottom: 28, left: 40 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(1, ...points.map((point) => point.v)));
  const slot = points.length > 0 ? innerW / points.length : innerW;
  const barW = Math.max(2, Math.min(28, slot - 2));
  const yOf = (value: number) => pad.top + innerH - (value / max) * innerH;
  const xTickEvery = Math.max(1, Math.ceil(points.length / 8));

  if (points.length === 0) return <div className="empty small">Sem dados no período.</div>;

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Gráfico de barras" onMouseLeave={() => setHover(null)}>
        {ticks(max).map((tick) => (
          <g key={tick}>
            <line className="chart__grid" x1={pad.left} x2={width - pad.right} y1={yOf(tick)} y2={yOf(tick)} />
            <text className="chart__axis" x={pad.left - 6} y={yOf(tick) + 4} textAnchor="end">
              {formatValue(tick)}
            </text>
          </g>
        ))}
        {points.map((point, index) => {
          const x = pad.left + index * slot + (slot - barW) / 2;
          const y = yOf(point.v);
          const h = Math.max(0, pad.top + innerH - y);
          return (
            <g key={point.t}>
              <rect
                x={pad.left + index * slot}
                y={pad.top}
                width={slot}
                height={innerH}
                fill="transparent"
                onMouseMove={(event) => {
                  const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                  if (!rect) return;
                  setHover({ index, x: ((x + barW / 2) / width) * rect.width, y: event.clientY - rect.top });
                }}
              />
              <rect className="chart__bar" x={x} y={y} width={barW} height={h} fill={color} opacity={hover && hover.index !== index ? 0.55 : 1} />
              {isXTick(index, points.length, xTickEvery) && (
                <text className="chart__axis" x={x + barW / 2} y={height - 8} textAnchor="middle">
                  {fmtBucket(point.t, granularity)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="chart__tooltip" style={{ left: hover.x, top: Math.max(40, hover.y) }}>
          <div className="chart__tooltip-title">{fmtBucket(points[hover.index]?.t ?? '', granularity)}</div>
          <div className="chart__tooltip-row">
            <span>{label}</span>
            <strong>{formatValue(points[hover.index]?.v ?? 0)}</strong>
          </div>
        </div>
      )}
    </div>
  );
}

export function Sparkline({ points, color = SERIES_COLORS[0], height = 34 }: { points: SeriesPoint[]; color?: string; height?: number }) {
  const width = 160;
  if (points.length < 2) return null;
  const max = Math.max(1, ...points.map((point) => point.v));
  const xOf = (index: number) => (index / (points.length - 1)) * width;
  const yOf = (value: number) => height - 3 - (value / max) * (height - 6);
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)},${yOf(point.v).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${line} L${width},${height} L0,${height} Z`} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />
    </svg>
  );
}

export function HorizontalBars({
  items,
  formatValue = fmtNumber,
  color = SERIES_COLORS[0],
}: {
  items: Array<{ label: ReactNode; value: number; hint?: string }>;
  formatValue?: (value: number) => string;
  color?: string;
}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  if (items.length === 0) return <div className="empty small">Sem dados.</div>;
  return (
    <div className="bars">
      {items.map((item, index) => (
        <div key={index} className="bars__row" title={item.hint}>
          <span className="bars__label">{item.label}</span>
          <div className="bars__track">
            <div className="bars__fill" style={{ width: `${(item.value / max) * 100}%`, background: color }} />
          </div>
          <span className="bars__value">{formatValue(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function Funnel({ steps }: { steps: Array<{ key: string; label: string; count: number; ofFirst: number | null; ofPrevious: number | null }> }) {
  const max = Math.max(1, ...steps.map((step) => step.count));
  return (
    <div className="funnel">
      {steps.map((step) => (
        <div key={step.key} className="funnel__step">
          <span className="strong">{step.label}</span>
          <div className="funnel__bar">
            <div className="funnel__fill" style={{ width: `${(step.count / max) * 100}%` }} />
          </div>
          <span className="num strong" style={{ textAlign: 'right' }}>
            {fmtNumber(step.count)}
          </span>
          <span className="muted small" style={{ textAlign: 'right' }}>
            {step.ofPrevious === null ? (step.ofFirst === null ? '' : '100%') : fmtPercent(step.ofPrevious)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function RetentionGrid({ cohorts, weeks }: { cohorts: Array<{ cohort: string; size: number; retention: Array<number | null> }>; weeks: number }) {
  if (cohorts.length === 0) return <div className="empty small">Sem coortes no período.</div>;
  return (
    <div className="table-wrap">
      <table className="heat">
        <thead>
          <tr>
            <th>Coorte</th>
            <th>Contas</th>
            {Array.from({ length: weeks + 1 }, (_, week) => (
              <th key={week}>S{week}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((cohort) => (
            <tr key={cohort.cohort}>
              <th>{fmtBucket(cohort.cohort, 'day')}</th>
              <th>{fmtNumber(cohort.size)}</th>
              {cohort.retention.map((value, week) => {
                const alpha = value === null ? 0 : 0.12 + value * 0.75;
                return (
                  <td
                    key={week}
                    style={{
                      background: value === null ? 'var(--chip)' : `rgba(28, 103, 157, ${alpha.toFixed(2)})`,
                      color: value !== null && value > 0.5 ? '#fff' : 'var(--text)',
                    }}
                    title={value === null ? 'Semana ainda não chegou' : fmtPercent(value)}
                  >
                    {value === null ? '' : `${Math.round(value * 100)}%`}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
