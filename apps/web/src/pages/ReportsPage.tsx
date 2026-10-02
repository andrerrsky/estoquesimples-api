import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { api, download } from '../api/client';
import type { ReportPeriod, ReportSummary } from '../api/types';
import { Icon } from '../components/Icon';
import { Card, Chips, Empty, PageHeader, QueryState, Tile, useToast } from '../components/ui';
import { track } from '../lib/analytics';
import { fmtDateTime, fmtDayMonth, fmtInteger, fmtMoney, fmtQuantity, fmtStock, plural } from '../lib/format';
import { inventoryKeys } from '../lib/inventory';
import { useCurrentWorkspace } from '../workspace/WorkspaceProvider';

import '../styles/pages-stock.css';

const PERIODS: Array<{ key: ReportPeriod; label: string; text: string }> = [
  { key: 'today', label: 'Hoje', text: 'hoje' },
  { key: '7d', label: '7 dias', text: 'nos últimos 7 dias' },
  { key: '30d', label: '30 dias', text: 'nos últimos 30 dias' },
  { key: '90d', label: '90 dias', text: 'nos últimos 90 dias' },
  { key: 'all', label: 'Tudo', text: 'desde o início' },
];

/** Quantos itens de reposição aparecem na tela; a impressão leva todos. */
const LOW_STOCK_ON_SCREEN = 12;
const CATEGORIES_ON_SCREEN = 10;

interface Bucket {
  key: string;
  /** Rótulo curto do eixo ("14/03"). */
  label: string;
  /** Rótulo por extenso da leitura ("14/03" ou "semana de 10/03 a 16/03"). */
  title: string;
  entries: number;
  exits: number;
}

/** Soma dias a uma data pura (YYYY-MM-DD) sem passar por fuso. */
function addDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

/**
 * Prepara as colunas do gráfico. A API só devolve os dias que tiveram
 * movimentação (e no máximo os últimos 90); aqui os dias vazios são
 * preenchidos com zero, para a linha do tempo não "pular", e períodos longos
 * são agrupados por semana para as colunas continuarem legíveis no celular.
 * É só apresentação: os números são os da API, somados.
 */
function buildBuckets(daily: ReportSummary['daily'], period: ReportPeriod): { buckets: Bucket[]; weekly: boolean } {
  const today = new Date().toLocaleDateString('en-CA');
  const first = daily[0]?.day;
  const last = daily[daily.length - 1]?.day;
  const span = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 1;
  // "Tudo" começa na primeira movimentação que a API devolveu.
  let start = period === 'all' ? (first ?? today) : addDays(today, -(span - 1));
  if (first && first < start) start = first;
  const end = last && last > today ? last : today;

  const byDay = new Map(daily.map((item) => [item.day, item]));
  const days: Array<{ day: string; entries: number; exits: number }> = [];
  for (let day = start; day <= end && days.length < 120; day = addDays(day, 1)) {
    days.push({ day, entries: byDay.get(day)?.entries ?? 0, exits: byDay.get(day)?.exits ?? 0 });
  }

  if (days.length <= 31) {
    return { weekly: false, buckets: days.map((item) => ({ key: item.day, label: fmtDayMonth(item.day), title: fmtDayMonth(item.day), entries: item.entries, exits: item.exits })) };
  }

  // Semanas contadas de trás para frente, para a mais recente ficar completa.
  const buckets: Bucket[] = [];
  for (let endIndex = days.length; endIndex > 0; endIndex -= 7) {
    const week = days.slice(Math.max(0, endIndex - 7), endIndex);
    const from = week[0];
    const to = week[week.length - 1];
    if (!from || !to) continue;
    buckets.unshift({
      key: from.day,
      label: fmtDayMonth(from.day),
      title: from.day === to.day ? fmtDayMonth(from.day) : `semana de ${fmtDayMonth(from.day)} a ${fmtDayMonth(to.day)}`,
      entries: week.reduce((sum, item) => sum + item.entries, 0),
      exits: week.reduce((sum, item) => sum + item.exits, 0),
    });
  }
  return { weekly: true, buckets };
}

/** Teto "redondo" do eixo (1, 2, 5 × potência de 10), para marcas limpas. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
}

/**
 * Colunas de entradas e saídas por dia (ou semana), em CSS puro.
 *
 * Uma escala só para as duas séries; cores da paleta de séries (validadas
 * para daltonismo), nunca verde/vermelho de estado. A leitura do valor
 * aparece acima do gráfico ao passar o mouse ou tocar — funciona no celular,
 * onde não existe "hover". Leitores de tela recebem a tabela equivalente.
 */
function DailyChart({ buckets, weekly }: { buckets: Bucket[]; weekly: boolean }) {
  const [active, setActive] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const max = niceMax(Math.max(0, ...buckets.map((bucket) => Math.max(bucket.entries, bucket.exits))));
  const every = Math.max(1, Math.ceil(buckets.length / 7));
  const current = active !== null ? buckets[active] : undefined;

  // No celular o gráfico rola de lado: começa mostrando os dias mais recentes.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [buckets.length]);

  const height = (value: number) => (value <= 0 ? '0' : `max(2px, ${(value / max) * 100}%)`);

  return (
    <div className="stack stack--tight">
      <div className="row row--between row--wrap" style={{ gap: '4px 14px' }}>
        <div className="legend">
          <span>
            <span className="legend__dot" style={{ background: 'var(--series-1)' }} />
            Entrou
          </span>
          <span>
            <span className="legend__dot" style={{ background: 'var(--series-2)' }} />
            Saiu
          </span>
        </div>
        <div className="daychart__readout" aria-hidden="true">
          {current ? (
            <>
              <strong>{current.title}</strong>: entrou {fmtQuantity(current.entries)} · saiu {fmtQuantity(current.exits)}
            </>
          ) : (
            <span className="muted no-print">Passe o mouse ou toque numa coluna para ver os números.</span>
          )}
        </div>
      </div>

      <div className="daychart" role="img" aria-label={`Quantidade que entrou e saiu por ${weekly ? 'semana' : 'dia'}. Os números estão na tabela a seguir.`}>
        <div className="daychart__y" aria-hidden="true">
          {[0, 0.5, 1].map((ratio) => (
            <span key={ratio} style={{ bottom: `${ratio * 100}%` }}>
              {fmtQuantity(max * ratio)}
            </span>
          ))}
        </div>
        <div className="daychart__scroll" ref={scroller}>
          <div className="daychart__plot" style={{ minWidth: buckets.length * 16 }} onMouseLeave={() => setActive(null)} aria-hidden="true">
            <span className="daychart__grid" style={{ bottom: '50%' }} />
            <span className="daychart__grid" style={{ top: 0 }} />
            {buckets.map((bucket, index) => (
              <div
                key={bucket.key}
                className={`daychart__group ${index === active ? 'active' : ''}`}
                title={`${bucket.title}: entrou ${fmtQuantity(bucket.entries)}, saiu ${fmtQuantity(bucket.exits)}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => setActive(index)}
              >
                <span className="daychart__bar" style={{ height: height(bucket.entries) }} />
                <span className="daychart__bar daychart__bar--2" style={{ height: height(bucket.exits) }} />
                {(buckets.length - 1 - index) % every === 0 && <span className="daychart__tick">{bucket.label}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>

      <table className="sr-only">
        <caption>Quantidade que entrou e saiu por {weekly ? 'semana' : 'dia'}</caption>
        <thead>
          <tr>
            <th scope="col">{weekly ? 'Semana' : 'Dia'}</th>
            <th scope="col">Entrou</th>
            <th scope="col">Saiu</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.key}>
              <th scope="row">{bucket.title}</th>
              <td>{fmtQuantity(bucket.entries)}</td>
              <td>{fmtQuantity(bucket.exits)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Relatórios: o retrato do estoque agora (valor, o que repor) e o movimento
 * do período escolhido. Todos os números vêm prontos da API; a tela só
 * organiza. "Imprimir / salvar PDF" usa a impressão do navegador — a folha
 * de estilo esconde a navegação e os botões.
 */
export function ReportsPage() {
  const { workspaceId, workspace, base, can, currency } = useCurrentWorkspace();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const [exporting, setExporting] = useState(false);

  const period = PERIODS.find((item) => item.key === params.get('periodo')) ?? PERIODS[2]!;

  const summary = useQuery({
    queryKey: [...inventoryKeys.reports(workspaceId), 'summary', period.key],
    queryFn: () => api.get<ReportSummary>(`${base}/reports/summary`, { period: period.key }),
    placeholderData: keepPreviousData,
  });

  const data = summary.data;
  const { buckets, weekly } = useMemo(() => (data ? buildBuckets(data.daily, data.period) : { buckets: [], weekly: false }), [data]);

  const setPeriod = (key: ReportPeriod) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (key === '30d') next.delete('periodo');
        else next.set('periodo', key);
        return next;
      },
      { replace: true },
    );
  };

  const print = () => {
    track('report.generated', { format: 'pdf' });
    window.print();
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      await download(`${base}/export/produtos.csv`, 'produtos.csv');
      track('export.completed', { format: 'csv' });
    } catch (error) {
      toast.error(error);
    } finally {
      setExporting(false);
    }
  };

  const header = (
    <PageHeader
      title="Relatórios"
      subtitle={`${workspace.name} · movimento ${period.text}`}
      actions={
        <>
          {can('produtos.ver') && (
            <button type="button" className="btn btn--secondary" onClick={() => void exportCsv()} disabled={exporting}>
              <Icon name="download" size={17} /> {exporting ? 'Preparando…' : 'Exportar produtos (CSV)'}
            </button>
          )}
          <button type="button" className="btn btn--primary" onClick={print} disabled={!data}>
            <Icon name="print" size={17} /> Imprimir / salvar PDF
          </button>
        </>
      }
    />
  );

  if (!data) {
    return (
      <div className="page">
        {header}
        <Card flush>
          <QueryState loading={summary.isLoading} error={summary.error} onRetry={() => void summary.refetch()} />
        </Card>
      </div>
    );
  }

  const { movements } = data;
  const hasDaily = buckets.some((bucket) => bucket.entries > 0 || bucket.exits > 0);
  const topMax = Math.max(1, ...data.topValue.map((item) => item.total));

  // Categorias: por valor quando há preço cadastrado; senão, por quantidade de produtos.
  const byValue = data.byCategory.some((item) => item.value > 0);
  const categories = [...data.byCategory].sort((a, b) => (byValue ? b.value - a.value : b.products - a.products));
  const categoryMax = Math.max(1, ...categories.map((item) => (byValue ? item.value : item.products)));

  return (
    <div className="page" style={{ opacity: summary.isPlaceholderData ? 0.6 : 1 }}>
      {header}
      <p className="caption print-only">Gerado em {fmtDateTime(new Date())}</p>

      <div className="no-print">
        <Chips<ReportPeriod> label="Período das movimentações" value={period.key} onChange={setPeriod} items={PERIODS.map(({ key, label }) => ({ key, label }))} />
      </div>

      <div className="grid grid--tiles">
        <Tile
          label="Produtos"
          value={fmtInteger(data.products)}
          foot={data.itemsByUnit.length > 0 ? data.itemsByUnit.slice(0, 3).map((item) => fmtStock(item.quantity, item.unit)).join(' · ') : undefined}
        />
        <Tile label="Valor em estoque" value={fmtMoney(data.stockValue, currency)} foot="Quantidade × valor unitário" />
        <Tile label="Para repor" value={fmtInteger(data.toRestock)} foot="No mínimo, abaixo dele ou zerados" alert={data.toRestock > 0} to="/app/estoque?filtro=baixo" />
        <Tile label="Sem estoque" value={fmtInteger(data.outOfStock)} foot="Quantidade zerada" alert={data.outOfStock > 0} />
      </div>

      <Card title="Entradas e saídas" subtitle={`Lançamentos ${period.text}. Valores estimados pelo valor unitário atual de cada produto.`}>
        <div className="stack">
          <div className="stat-trio">
            <div className="stat">
              <div className="stat__label">Entradas</div>
              <div className="stat__value num">{fmtMoney(movements.entries.value, currency)}</div>
              <div className="stat__foot">
                {plural(movements.entries.count, 'lançamento', 'lançamentos')} · quantidade somada: {fmtQuantity(movements.entries.quantity)}
              </div>
            </div>
            <div className="stat">
              <div className="stat__label">Saídas</div>
              <div className="stat__value num">{fmtMoney(movements.exits.value, currency)}</div>
              <div className="stat__foot">
                {plural(movements.exits.count, 'lançamento', 'lançamentos')} · quantidade somada: {fmtQuantity(movements.exits.quantity)}
              </div>
            </div>
            <div className="stat">
              <div className="stat__label">Cadastros, ajustes e estornos</div>
              <div className="stat__value num">{fmtMoney(movements.others.value, currency)}</div>
              <div className="stat__foot">{plural(movements.others.count, 'lançamento', 'lançamentos')} · efeito no valor do estoque</div>
            </div>
          </div>

          {data.period !== 'today' && (
            <div className="stack stack--tight">
              <div>
                <div className="strong">Quantidade que entrou e saiu por {weekly ? 'semana' : 'dia'}</div>
                <div className="caption">
                  {data.period === 'all' ? 'Últimos 90 dias. ' : ''}
                  Só entradas e saídas lançadas como tal; cadastros, ajustes e estornos ficam de fora.
                </div>
              </div>
              {hasDaily ? <DailyChart buckets={buckets} weekly={weekly} /> : <p className="muted">Nenhuma movimentação neste período.</p>}
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid--2">
        <Card title="Maiores valores em estoque" subtitle="Produtos que concentram mais dinheiro parado">
          {data.topValue.length === 0 ? (
            <p className="muted">Cadastre o valor unitário dos produtos para ver onde está o dinheiro do estoque.</p>
          ) : (
            <div className="hbars">
              {data.topValue.map((item) => (
                <div key={item.id} className="hbar" title={`${item.name}: ${fmtStock(item.quantity, item.unit)} × ${fmtMoney(item.unitValue, currency)} = ${fmtMoney(item.total, currency)}`}>
                  <span className="truncate">{item.name}</span>
                  <span className="num nowrap strong">{fmtMoney(item.total, currency)}</span>
                  <div className="hbar__track">
                    <div className="hbar__fill" style={{ width: `${(item.total / topMax) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Por categoria" subtitle={byValue ? 'Valor em estoque de cada categoria' : 'Quantidade de produtos em cada categoria'}>
          {categories.length === 0 ? (
            <p className="muted">Nenhum produto cadastrado.</p>
          ) : (
            <div className="hbars">
              {categories.map((item, index) => {
                const measure = byValue ? item.value : item.products;
                const name = item.category === '' ? 'Sem categoria' : item.category;
                return (
                  <div
                    key={item.category}
                    className={`hbar ${index >= CATEGORIES_ON_SCREEN ? 'print-only' : ''}`}
                    title={`${name}: ${plural(item.products, 'produto', 'produtos')}, ${fmtMoney(item.value, currency)}`}
                  >
                    <span className="truncate">
                      {name} <span className="caption">· {plural(item.products, 'produto', 'produtos')}</span>
                    </span>
                    <span className="num nowrap strong">{byValue ? fmtMoney(item.value, currency) : fmtInteger(item.products)}</span>
                    <div className="hbar__track">
                      <div className="hbar__fill" style={{ width: `${(measure / categoryMax) * 100}%` }} />
                    </div>
                  </div>
                );
              })}
              {categories.length > CATEGORIES_ON_SCREEN && (
                <p className="caption no-print">E mais {plural(categories.length - CATEGORIES_ON_SCREEN, 'categoria', 'categorias')}. A versão impressa traz todas.</p>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card
        flush
        title="Para repor"
        subtitle={data.toRestock > 0 ? `${plural(data.toRestock, 'produto', 'produtos')} no estoque mínimo, abaixo dele ou zerado` : undefined}
        actions={
          data.toRestock > 0 && (
            <Link to="/app/estoque?filtro=baixo" className="btn btn--secondary btn--sm no-print">
              Ver no estoque
            </Link>
          )
        }
      >
        {data.lowStock.length === 0 ? (
          <Empty icon="check" title="Nada para repor">
            Nenhum produto está no estoque mínimo ou abaixo dele.
          </Empty>
        ) : (
          <div className="list">
            {data.lowStock.map((item, index) => (
              <div key={item.id} className={`list__item ${index >= LOW_STOCK_ON_SCREEN ? 'print-only' : ''}`}>
                <div className="list__main">
                  <div className="list__title">{item.name}</div>
                  {(item.supplier || item.location) && <div className="list__sub">{[item.supplier, item.location].filter(Boolean).join(' · ')}</div>}
                </div>
                <div className="list__meta">
                  <div className="qty qty--low">{fmtStock(item.quantity, item.unit)}</div>
                  {item.minStock > 0 && <div>mínimo {fmtQuantity(item.minStock)}</div>}
                </div>
              </div>
            ))}
            {data.toRestock > LOW_STOCK_ON_SCREEN && (
              <div className="list__item no-print">
                <Link to="/app/estoque?filtro=baixo">Ver todos os {fmtInteger(data.toRestock)} no estoque</Link>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
