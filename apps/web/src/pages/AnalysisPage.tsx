import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError, api } from '../api/client';
import type { Analysis, AnalysisItem } from '../api/types';
import { Icon, type IconName } from '../components/Icon';
import { Badge, Card, Chips, Empty, PageHeader, Pagination, QueryState, Tile } from '../components/ui';
import { track } from '../lib/analytics';
import { fmtDate, fmtInteger, fmtQuantity, fmtStock, plural } from '../lib/format';
import { inventoryKeys } from '../lib/inventory';
import type { Tone } from '../lib/labels';
import { useCurrentWorkspace } from '../workspace/WorkspaceProvider';

import '../styles/pages-stock.css';

const PAGE_SIZE = 50;
/** Recurso do plano que libera esta tela (mesma chave de `plan_features`). */
const FEATURE = 'analise.avancada';

type View = 'repor' | 'vendidos' | 'parados';

const PRIORITY: Record<NonNullable<AnalysisItem['priority']>, { label: string; tone: Tone }> = {
  urgente: { label: 'Urgente', tone: 'error' },
  breve: { label: 'Em breve', tone: 'warning' },
  atencao: { label: 'Atenção', tone: 'info' },
};

const SPEED: Record<AnalysisItem['speed'], string> = {
  rapido: 'Sai rápido',
  medio: 'Saída média',
  lento: 'Sai devagar',
  parado: 'Parado',
};

const BENEFITS: Array<{ icon: IconName; title: string; text: string }> = [
  { icon: 'trend', title: 'Consumo por dia', text: 'Quanto de cada produto sai, em média, por dia.' },
  { icon: 'calendar', title: 'Quando vai acabar', text: 'A data prevista para o estoque de cada produto zerar, no ritmo atual.' },
  { icon: 'refresh', title: 'Giro do estoque', text: 'O que sai rápido e o que está parado na prateleira, ocupando dinheiro.' },
  { icon: 'check', title: 'O que comprar primeiro', text: 'Uma lista em ordem de urgência, para a compra da semana.' },
];

/** Duas casas bastam para médias ("1,25 por dia"); a quantidade em si usa até quatro. */
const round2 = (value: number) => Math.round(value * 100) / 100;

function daysLeft(item: AnalysisItem): string {
  if (item.stock <= 0) return 'Sem estoque';
  if (item.daysUntilStockOut === null) return '—';
  if (item.daysUntilStockOut < 1) return 'Menos de 1 dia';
  return plural(Math.round(item.daysUntilStockOut), 'dia', 'dias');
}

/** Explicação do plano no lugar dos dados, para quem ainda não tem a Análise. */
function Upsell() {
  return (
    <div className="page page--narrow">
      <PageHeader title="Análise Avançada" />
      <Card>
        <div className="pitch">
          <div className="pitch__head">
            <div className="feature__icon">
              <Icon name="trend" size={22} />
            </div>
            <div>
              <Badge tone="brand">Plano Equipe</Badge>
              <h2 className="pitch__title" style={{ marginTop: 6 }}>Saiba o que comprar antes de faltar</h2>
              <p className="muted" style={{ marginTop: 6 }}>
                A Análise Avançada olha as entradas e saídas dos últimos meses e mostra o ritmo de cada produto. Ela faz parte do plano Equipe.
              </p>
            </div>
          </div>

          <div className="pitch__grid">
            {BENEFITS.map((benefit) => (
              <div key={benefit.title} className="pitch__item">
                <div className="feature__icon">
                  <Icon name={benefit.icon} />
                </div>
                <div>
                  <div className="strong">{benefit.title}</div>
                  <div className="muted">{benefit.text}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="row row--wrap">
            <Link to="/app/plano" className="btn btn--primary">
              Conhecer o plano Equipe
            </Link>
            <span className="caption">O plano também libera a equipe e produtos sem limite.</span>
          </div>
        </div>
      </Card>
    </div>
  );
}

/**
 * Análise Avançada (plano Equipe): consumo médio, previsão de quando cada
 * produto acaba e giro. As contas e as faixas (urgente, em breve, rápido…)
 * são da API — as mesmas do aplicativo; a tela só filtra e ordena o que
 * recebeu. Sem o recurso no plano, a consulta nem é feita: aparece a
 * explicação do que a análise entrega.
 */
export function AnalysisPage() {
  const { workspaceId, base, entitlement, loading } = useCurrentWorkspace();
  // Quem decide é o recurso do plano em vigor, como na API. Enquanto o plano
  // carrega, a consulta espera; se o plano não pôde ser lido, a consulta é
  // feita e a resposta da API decide (403 vira a explicação do plano).
  const locked = entitlement !== null && entitlement.features[FEATURE]?.enabled !== true;
  const waitingPlan = entitlement === null && loading;

  const analysis = useQuery({
    queryKey: [...inventoryKeys.reports(workspaceId), 'analysis'],
    queryFn: () => api.get<Analysis>(`${base}/reports/analysis`),
    enabled: !locked && !waitingPlan,
    staleTime: 60_000,
  });

  const [view, setView] = useState<View>('repor');
  const [page, setPage] = useState(1);

  const tracked = useRef(false);
  useEffect(() => {
    if (analysis.data && !tracked.current) {
      tracked.current = true;
      track('analysis.viewed');
    }
  }, [analysis.data]);

  const data = analysis.data;
  const lists = useMemo(() => {
    const items = data?.items ?? [];
    return {
      // A API já devolve na ordem de quem acaba primeiro.
      repor: items.filter((item) => item.priority !== null),
      vendidos: items.filter((item) => item.avgDaily > 0).sort((a, b) => b.avgDaily - a.avgDaily),
      parados: items.filter((item) => item.speed === 'parado'),
    };
  }, [data]);

  const blockedByPlan = analysis.error instanceof ApiError && analysis.error.code === 'SUBSCRIPTION_REQUIRED';
  if (locked || blockedByPlan) return <Upsell />;

  if (!data) {
    return (
      <div className="page">
        <PageHeader title="Análise Avançada" />
        <Card flush>
          <QueryState loading={analysis.isLoading || waitingPlan} error={analysis.error} onRetry={() => void analysis.refetch()} />
        </Card>
      </div>
    );
  }

  const { summary } = data;
  const rows = lists[view];
  const visible = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const untouched = Math.max(0, summary.analyzed - summary.withMovement);

  const changeView = (next: View) => {
    setView(next);
    setPage(1);
  };

  const badges = (item: AnalysisItem) => (
    <>
      {item.priority && <Badge tone={PRIORITY[item.priority].tone}>{PRIORITY[item.priority].label}</Badge>}
      <Badge>{SPEED[item.speed] ?? item.speed}</Badge>
    </>
  );

  const forecast = (item: AnalysisItem) => (item.stock > 0 && item.stockOutDate ? fmtDate(item.stockOutDate) : null);

  return (
    <div className="page">
      <PageHeader
        title="Análise Avançada"
        subtitle={`Com base nas movimentações dos últimos ${data.windowDays} dias · ${fmtInteger(summary.withMovement)} de ${plural(summary.analyzed, 'produto teve', 'produtos tiveram')} movimento`}
      />

      <div className="grid grid--tiles">
        <Tile label="Urgente" value={fmtInteger(summary.urgent)} foot="Acabam em até 7 dias" alert={summary.urgent > 0} />
        <Tile label="Em breve" value={fmtInteger(summary.soon)} foot="Acabam em 8 a 15 dias" />
        <Tile label="Atenção" value={fmtInteger(summary.attention)} foot="No estoque mínimo ou abaixo" />
        <Tile label="Saem rápido" value={fmtInteger(summary.fast)} foot="Maior saída por dia" />
        <Tile label="Devagar ou parados" value={fmtInteger(summary.slow)} foot="Pouca ou nenhuma saída" />
      </div>

      <Chips<View>
        label="Lista da análise"
        value={view}
        onChange={changeView}
        items={[
          { key: 'repor', label: 'Repor primeiro', count: lists.repor.length },
          { key: 'vendidos', label: 'Mais vendidos', count: lists.vendidos.length },
          { key: 'parados', label: 'Parados', count: lists.parados.length },
        ]}
      />

      <Card flush>
        {rows.length === 0 ? (
          view === 'repor' ? (
            <Empty icon="check" title="Nada para repor agora">
              No ritmo atual de saída, nenhum produto acaba nos próximos 15 dias nem está abaixo do estoque mínimo.
            </Empty>
          ) : view === 'vendidos' ? (
            <Empty icon="trend" title="Ainda sem saídas no período">
              Registre as saídas do dia a dia e a análise passa a mostrar o ritmo de cada produto.
            </Empty>
          ) : (
            <Empty icon="check" title="Nenhum produto parado">
              Todo produto que teve movimentação no período também teve saída.
            </Empty>
          )
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="table">
                <thead>
                  <tr>
                    <th>Produto</th>
                    <th className="num">Estoque</th>
                    <th className="num" title="Total que saiu dividido pelos dias desde a primeira movimentação do período">Saída média por dia</th>
                    <th className="num">Dias restantes</th>
                    <th>Previsão de fim</th>
                    <th className="num" title="Quantas vezes o estoque atual saiu no período">Giro</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => (
                    <tr key={item.id}>
                      <td style={{ maxWidth: 360 }}>
                        <div className="product-row__name">{item.name}</div>
                        <div className="product-row__meta">{badges(item)}</div>
                      </td>
                      <td className="num">
                        <span className={`qty ${item.minStock > 0 && item.stock <= item.minStock ? 'qty--low' : ''}`} title={item.minStock > 0 ? `Estoque mínimo: ${fmtQuantity(item.minStock)}` : undefined}>
                          {fmtStock(item.stock, item.unit)}
                        </span>
                      </td>
                      <td className="num nowrap">{item.avgDaily > 0 ? fmtQuantity(round2(item.avgDaily)) : <span className="faint">—</span>}</td>
                      <td className="num nowrap">{daysLeft(item)}</td>
                      <td className="nowrap">{forecast(item) ?? <span className="faint">—</span>}</td>
                      <td className="num nowrap">{item.turnover === null ? <span className="faint">—</span> : `${fmtQuantity(round2(item.turnover))}×`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="list show-mobile">
              {visible.map((item) => (
                <div key={item.id} className="list__item history-item">
                  <div className="list__main">
                    <div className="list__title">{item.name}</div>
                    <div className="product-row__meta">{badges(item)}</div>
                    <div className="list__sub" style={{ marginTop: 4 }}>
                      {item.avgDaily > 0 ? `Sai ${fmtQuantity(round2(item.avgDaily))} por dia` : 'Sem saída no período'}
                      {item.avgDaily > 0 && ` · ${item.stock > 0 ? `dura ${daysLeft(item).toLowerCase()}` : 'sem estoque'}`}
                      {forecast(item) && ` (até ${forecast(item)})`}
                      {item.turnover !== null && ` · giro ${fmtQuantity(round2(item.turnover))}×`}
                    </div>
                  </div>
                  <div className="list__meta">
                    <span className={`qty ${item.minStock > 0 && item.stock <= item.minStock ? 'qty--low' : ''}`}>{fmtStock(item.stock, item.unit)}</span>
                  </div>
                </div>
              ))}
            </div>

            <Pagination page={page} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} />
          </>
        )}
      </Card>

      {view === 'parados' && untouched > 0 && (
        <p className="caption">
          Além destes, {plural(untouched, 'produto não teve', 'produtos não tiveram')} nenhuma movimentação nos últimos {data.windowDays} dias e por isso {untouched === 1 ? 'não entra' : 'não entram'} na análise.
        </p>
      )}

      <p className="caption">
        A saída média considera o que saiu de cada produto desde a primeira movimentação dele nos últimos {data.windowDays} dias. A previsão de fim supõe que o ritmo continue o mesmo; o giro é
        quantas vezes o estoque atual saiu nesse tempo.
      </p>
    </div>
  );
}
