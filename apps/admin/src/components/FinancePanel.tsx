import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../api/client';
import { LineChart, SERIES_COLORS } from '../charts/charts';
import { fmtCents, fmtNumber } from '../lib/format';
import { Card, Chips, Notice, Skeleton, StatTile } from './ui';

interface FinanceMonth {
  month: string;
  grossCents: number;
  netCents: number;
  feesCents: number;
  appNetCents: number;
  webNetCents: number;
  newSubscriptions: number;
  churned: number;
  activeAtEnd: number;
  mrrNetAtEnd: number;
}

interface FinanceReport {
  generatedAt: string;
  months: FinanceMonth[];
  now: {
    paying: number;
    payingApp: number;
    payingWeb: number;
    inOffer: number;
    mrrGrossCents: number;
    mrrNetCents: number;
    mrrNetAppCents: number;
    mrrNetWebCents: number;
    arrNetCents: number;
    arpuNetCents: number | null;
    cancelingAtPeriodEnd: number;
  };
  totals: { grossCents: number; netCents: number; feesCents: number };
  assumptions: { googleFeePct: number; googleOfferPriceCents: number | null; googleOfferCycles: number | null };
}

type Period = '6' | '12' | '24';

const MONTH_NAMES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return `${MONTH_NAMES[m - 1]}/${String(y).slice(2)}`;
}

/** Variação relativa para o selo do cartão; `null` quando não havia base. */
function change(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / previous;
}

function downloadCsv(report: FinanceReport) {
  const reais = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
  const header = ['Mês', 'Novas', 'Saídas', 'Ativas no fim', 'Receita bruta', 'Taxas', 'Receita líquida', 'Líquido app', 'Líquido web', 'MRR líquido'];
  const lines = report.months.map((m) =>
    [m.month, m.newSubscriptions, m.churned, m.activeAtEnd, reais(m.grossCents), reais(m.feesCents), reais(m.netCents), reais(m.appNetCents), reais(m.webNetCents), reais(m.mrrNetAtEnd)].join(';'),
  );
  const blob = new Blob([`﻿${[header.join(';'), ...lines].join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `financeiro-assinaturas-${report.generatedAt.slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Relatório financeiro das assinaturas: quanto entra por mês (já sem a taxa
 * do Google Play e as tarifas do Asaas), como a base cresce e quem sai.
 */
export function FinancePanel() {
  const [period, setPeriod] = useState<Period>('12');
  const query = useQuery({
    queryKey: ['billing', 'finance', period],
    queryFn: () => api.get<FinanceReport>('/billing/finance', { months: Number(period) }),
  });
  const report = query.data;

  if (!report) {
    return <Card title="Financeiro">{query.isError ? <Notice tone="error">Não foi possível carregar o relatório financeiro.</Notice> : <Skeleton lines={6} />}</Card>;
  }

  const months = report.months;
  const current = months[months.length - 1]!;
  const previous = months[months.length - 2];
  const point = (pick: (m: FinanceMonth) => number) => months.map((m) => ({ t: `${m.month}-01`, v: pick(m) }));
  const offer = report.assumptions;
  const periodNet = months.reduce((sum, m) => sum + m.netCents, 0);
  const periodGross = months.reduce((sum, m) => sum + m.grossCents, 0);
  const periodNew = months.reduce((sum, m) => sum + m.newSubscriptions, 0);
  const periodChurn = months.reduce((sum, m) => sum + m.churned, 0);

  return (
    <Card
      title="Financeiro"
      subtitle="Receita das assinaturas já sem a taxa do Google Play e as tarifas do Asaas, antes de impostos"
      actions={
        <div className="row">
          <Chips value={period} onChange={setPeriod} items={[{ key: '6', label: '6 meses' }, { key: '12', label: '12 meses' }, { key: '24', label: '24 meses' }]} />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => downloadCsv(report)}>Exportar CSV</button>
        </div>
      }
    >
      <div className="grid grid--tiles">
        <StatTile
          label="Receita recorrente (MRR)"
          value={fmtCents(report.now.mrrNetCents)}
          foot={`líquido/mês · bruto ${fmtCents(report.now.mrrGrossCents)} · app ${fmtCents(report.now.mrrNetAppCents)} · web ${fmtCents(report.now.mrrNetWebCents)}`}
          hint="Quanto as assinaturas que renovam rendem por mês, já sem as taxas. Semestral e anual entram divididos por 6 e 12. Não inclui quem já desligou a renovação."
          tone="accent"
        />
        <StatTile
          label="Recebido no mês"
          value={fmtCents(current.netCents)}
          delta={previous ? change(current.netCents, previous.netCents) : undefined}
          foot={`líquido · bruto ${fmtCents(current.grossCents)} · taxas ${fmtCents(current.feesCents)}`}
          hint="Cobranças do mês corrente: no app, uma por mês desde o início de cada assinatura; na web, as cobranças pagas no Asaas."
        />
        <StatTile
          label="Assinantes pagantes"
          value={fmtNumber(report.now.paying)}
          foot={`${fmtNumber(report.now.payingApp)} app · ${fmtNumber(report.now.payingWeb)} web${report.now.inOffer > 0 ? ` · ${fmtNumber(report.now.inOffer)} em oferta de entrada` : ''}`}
          hint="Assinaturas ativas ou em carência, que renovam."
        />
        <StatTile
          label="Novas no mês"
          value={fmtNumber(current.newSubscriptions)}
          delta={previous ? change(current.newSubscriptions, previous.newSubscriptions) : undefined}
          foot={`${fmtNumber(current.churned)} saídas · ${fmtNumber(report.now.cancelingAtPeriodEnd)} vão sair no fim do período`}
          tone={current.churned > current.newSubscriptions ? 'alert' : undefined}
        />
        <StatTile label="Ticket médio" value={fmtCents(report.now.arpuNetCents)} foot="líquido por assinante por mês" />
        <StatTile label="Projeção anual (ARR)" value={fmtCents(report.now.arrNetCents)} foot={`MRR × 12 · no período: ${fmtCents(periodNet)} líquidos`} />
      </div>

      <div className="grid grid--2" style={{ marginTop: 16 }}>
        <div>
          <div className="caption" style={{ marginBottom: 6 }}>Receita líquida por mês</div>
          <LineChart
            granularity="month"
            formatValue={fmtCents}
            series={[
              { key: 'app', label: 'App (Google Play)', points: point((m) => m.appNetCents), color: SERIES_COLORS[0] },
              { key: 'web', label: 'Web (Asaas)', points: point((m) => m.webNetCents), color: SERIES_COLORS[1] },
            ]}
          />
        </div>
        <div>
          <div className="caption" style={{ marginBottom: 6 }}>Receita recorrente (MRR líquido) no fim do mês</div>
          <LineChart granularity="month" formatValue={fmtCents} series={[{ key: 'mrr', label: 'MRR líquido', points: point((m) => m.mrrNetAtEnd), color: SERIES_COLORS[2] }]} />
        </div>
        <div>
          <div className="caption" style={{ marginBottom: 6 }}>Assinantes com acesso no fim do mês</div>
          <LineChart granularity="month" series={[{ key: 'active', label: 'Com acesso', points: point((m) => m.activeAtEnd) }]} />
        </div>
        <div>
          <div className="caption" style={{ marginBottom: 6 }}>Novas × saídas</div>
          <LineChart
            granularity="month"
            area={false}
            series={[
              { key: 'new', label: 'Novas', points: point((m) => m.newSubscriptions), color: SERIES_COLORS[1] },
              { key: 'churn', label: 'Saídas', points: point((m) => m.churned), color: SERIES_COLORS[3] },
            ]}
          />
        </div>
      </div>

      <div className="caption" style={{ margin: '18px 0 6px' }}>Relatório mensal</div>
      <div className="table-wrap">
        <table className="table table--compact">
          <thead>
            <tr>
              <th>Mês</th>
              <th className="num">Novas</th>
              <th className="num">Saídas</th>
              <th className="num">Ativas</th>
              <th className="num">Bruto</th>
              <th className="num">Taxas</th>
              <th className="num">Líquido</th>
              <th className="num">MRR líquido</th>
            </tr>
          </thead>
          <tbody>
            {[...months].reverse().map((m) => (
              <tr key={m.month}>
                <td>{monthLabel(m.month)}{m === current && <span className="caption"> · até hoje</span>}</td>
                <td className="num">{fmtNumber(m.newSubscriptions)}</td>
                <td className="num">{fmtNumber(m.churned)}</td>
                <td className="num">{fmtNumber(m.activeAtEnd)}</td>
                <td className="num">{fmtCents(m.grossCents)}</td>
                <td className="num muted">{fmtCents(m.feesCents)}</td>
                <td className="num"><strong>{fmtCents(m.netCents)}</strong></td>
                <td className="num">{fmtCents(m.mrrNetAtEnd)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td><strong>Período</strong></td>
              <td className="num">{fmtNumber(periodNew)}</td>
              <td className="num">{fmtNumber(periodChurn)}</td>
              <td className="num">—</td>
              <td className="num">{fmtCents(periodGross)}</td>
              <td className="num muted">{fmtCents(periodGross - periodNet)}</td>
              <td className="num"><strong>{fmtCents(periodNet)}</strong></td>
              <td className="num">—</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="caption" style={{ marginTop: 10 }}>
        Como é calculado: no app, o Google não envia as cobranças, então cada assinatura conta uma cobrança por mês desde o início, pelo preço do comprovante
        {offer.googleOfferPriceCents !== null && offer.googleOfferCycles !== null
          ? ` (${fmtCents(offer.googleOfferPriceCents)} nos ${offer.googleOfferCycles} primeiros meses da oferta de entrada)`
          : ' (sem oferta de entrada informada em Planos: usa o preço cheio)'}
        , menos {fmtNumber(offer.googleFeePct)}% de taxa do Google. Na web valem as cobranças pagas no Asaas com o líquido informado por ele (estimado quando ainda não veio). Impostos não são descontados.
      </p>
    </Card>
  );
}
