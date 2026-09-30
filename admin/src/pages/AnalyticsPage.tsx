import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type SeriesPoint } from '../api/client';
import { Funnel, HorizontalBars, LineChart, RetentionGrid, SERIES_COLORS } from '../charts/charts';
import { Card, Chips, Empty, Notice, PageHeader, Skeleton, StatTile } from '../components/ui';
import { deltaRatio, fmtNumber } from '../lib/format';
import { useListParams } from '../lib/hooks';
import { eventDomain, PLATFORM_LABEL } from '../lib/labels';

interface Summary {
  range: { from: string; to: string; granularity: 'day' | 'week' | 'month'; days: number };
  active: { dau: number; wau: number; mau: number };
  series: { activeUsers: SeriesPoint[]; events: SeriesPoint[] };
  topEvents: Array<{ name: string; source: string; description: string | null; events: number; users: number; installs: number }>;
  topScreens: Array<{ screen: string; views: number; users: number }>;
  platforms: Array<{ platform: string; count: number }>;
  appVersions: Array<{ version: string; count: number }>;
}

interface Metrics {
  range: { from: string; to: string; days: number };
  items: Array<{ key: string; label: string; description: string; unit: string; value: number; previous: number }>;
}

interface FunnelData {
  steps: Array<{ key: string; label: string; event: string; count: number; ofFirst: number | null; ofPrevious: number | null }>;
}

interface Retention {
  weeks: number;
  cohorts: Array<{ cohort: string; size: number; retention: Array<number | null> }>;
}

const RANGES = [
  { key: '7', label: '7 dias' },
  { key: '30', label: '30 dias' },
  { key: '90', label: '90 dias' },
  { key: '365', label: '12 meses' },
];

export function AnalyticsPage() {
  const { values, set } = useListParams({ days: '30' });
  const days = values['days'] ?? '30';
  const [seriesEvent, setSeriesEvent] = useState<string | null>(null);

  const summary = useQuery({ queryKey: ['analytics', 'summary', days], queryFn: () => api.get<Summary>('/analytics/summary', { days }) });
  const metrics = useQuery({ queryKey: ['analytics', 'metrics', days], queryFn: () => api.get<Metrics>('/analytics/metrics', { days }) });
  const funnel = useQuery({ queryKey: ['analytics', 'funnel', days], queryFn: () => api.get<FunnelData>('/analytics/funnel', { days }) });
  const retention = useQuery({ queryKey: ['analytics', 'retention'], queryFn: () => api.get<Retention>('/analytics/retention', { weeks: 8 }) });
  const eventSeries = useQuery({
    queryKey: ['analytics', 'event-series', seriesEvent, days],
    queryFn: () => api.get<{ points: SeriesPoint[] }>(`/analytics/events/${seriesEvent}/series`, { days, metric: 'users' }),
    enabled: seriesEvent !== null,
  });

  const granularity = summary.data?.range.granularity ?? 'day';
  const totalEvents = summary.data?.series.events.reduce((sum, point) => sum + point.v, 0) ?? 0;
  const appEvents = summary.data?.topEvents.filter((event) => event.source === 'app') ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Uso do produto"
        subtitle="Quem usa, o que usa e como evolui. Combina eventos do aplicativo com os marcos que a API registra."
        actions={<Chips value={days} onChange={(next) => set({ days: next })} items={RANGES} />}
      />

      {summary.data && appEvents.length === 0 && (
        <Notice tone="info" title="O aplicativo ainda não envia eventos de uso">
          Os números abaixo vêm do que a API observa (cadastro, login, sincronização, assinatura). Quando o app passar a chamar <code>POST /v1/analytics/events</code>, telas e funcionalidades usadas aparecem aqui. O catálogo de eventos está em <Link to="/eventos">Eventos</Link>.
        </Notice>
      )}

      <div className="grid grid--tiles">
        <StatTile label="Ativos hoje" value={fmtNumber(summary.data?.active.dau)} foot="com atividade nas últimas 24h" />
        <StatTile label="Ativos na semana" value={fmtNumber(summary.data?.active.wau)} foot="últimos 7 dias" />
        <StatTile label="Ativos no mês" value={fmtNumber(summary.data?.active.mau)} foot="últimos 30 dias" />
        <StatTile label="Aderência" value={summary.data && summary.data.active.mau > 0 ? `${Math.round((summary.data.active.dau / summary.data.active.mau) * 100)}%` : '—'} foot="DAU ÷ MAU: quantos do mês voltam por dia" hint="Acima de 20% é um produto de uso diário." />
        <StatTile label="Eventos no período" value={fmtNumber(totalEvents)} foot={`${fmtNumber(appEvents.reduce((sum, event) => sum + event.events, 0))} vindos do app`} />
      </div>

      <div className="grid grid--2">
        <Card title="Usuários ativos" subtitle={`Por ${granularity === 'day' ? 'dia' : granularity === 'week' ? 'semana' : 'mês'}`}>
          {summary.data ? <LineChart series={[{ key: 'active', label: 'Ativos', points: summary.data.series.activeUsers }]} granularity={granularity} /> : <Skeleton lines={5} />}
        </Card>
        <Card title="Eventos registrados" subtitle="Volume total, app + API">
          {summary.data ? <LineChart series={[{ key: 'events', label: 'Eventos', points: summary.data.series.events, color: SERIES_COLORS[1] }]} granularity={granularity} /> : <Skeleton lines={5} />}
        </Card>
      </div>

      <Card title="Indicadores do período" subtitle={`Comparados com os ${days} dias anteriores`}>
        {metrics.data ? (
          <div className="grid grid--tiles">
            {metrics.data.items.map((metric) => (
              <StatTile key={metric.key} label={metric.label} value={fmtNumber(metric.value)} delta={deltaRatio(metric.value, metric.previous)} foot={`antes: ${fmtNumber(metric.previous)}`} hint={metric.description} />
            ))}
          </div>
        ) : (
          <Skeleton lines={4} />
        )}
      </Card>

      <div className="grid grid--2">
        <Card title="Funil" subtitle="Da abertura do app à assinatura, no período">
          {funnel.data ? <Funnel steps={funnel.data.steps} /> : <Skeleton lines={5} />}
          <p className="caption" style={{ marginTop: 12 }}>Etapas sem evento do app (ex.: “Abriu o app”) ficam em zero até o aplicativo enviar telemetria; as demais usam também as tabelas de cadastro, empresa, carga e assinatura.</p>
        </Card>
        <Card title="Retenção semanal" subtitle="Das contas criadas em cada semana, quantas voltaram nas semanas seguintes">
          {retention.data ? <RetentionGrid cohorts={retention.data.cohorts} weeks={retention.data.weeks} /> : <Skeleton lines={5} />}
        </Card>
      </div>

      <div className="grid grid--2">
        <Card title="Funcionalidades mais usadas" subtitle="Eventos por nome; clique para ver a série de usuários">
          {summary.data ? (
            summary.data.topEvents.length === 0 ? (
              <Empty icon="activity" title="Nenhum evento no período" />
            ) : (
              <HorizontalBars
                items={summary.data.topEvents.slice(0, 12).map((event) => ({
                  label: (
                    <button type="button" className="btn btn--link small" style={{ fontWeight: 500 }} onClick={() => setSeriesEvent(event.name)} title={event.description ?? event.name}>
                      <span className="muted">{eventDomain(event.name)} · </span>{event.name.split('.').slice(1).join('.') || event.name}
                    </button>
                  ),
                  value: event.events,
                  hint: `${fmtNumber(event.users)} usuário(s)`,
                }))}
              />
            )
          ) : (
            <Skeleton lines={6} />
          )}
          {seriesEvent && (
            <div style={{ marginTop: 16 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="strong small"><code>{seriesEvent}</code> · usuários distintos</span>
                <button type="button" className="btn btn--link small" onClick={() => setSeriesEvent(null)}>fechar</button>
              </div>
              {eventSeries.data ? <LineChart series={[{ key: seriesEvent, label: 'Usuários', points: eventSeries.data.points }]} height={160} granularity={granularity} /> : <Skeleton lines={3} />}
            </div>
          )}
        </Card>
        <div className="stack">
          <Card title="Telas mais vistas" subtitle="Evento screen.viewed">
            {summary.data ? (
              summary.data.topScreens.length === 0 ? (
                <Empty icon="eye" title="Sem eventos de tela">Aparece quando o app emitir <code>screen.viewed</code>.</Empty>
              ) : (
                <HorizontalBars items={summary.data.topScreens.map((screen) => ({ label: screen.screen, value: screen.views, hint: `${fmtNumber(screen.users)} pessoa(s)` }))} color={SERIES_COLORS[2]} />
              )
            ) : (
              <Skeleton />
            )}
          </Card>
          <Card title="Versões do app" subtitle="Aparelhos vistos nos últimos 30 dias">
            {summary.data ? (
              <>
                <HorizontalBars items={summary.data.appVersions.map((item) => ({ label: `v${item.version}`, value: item.count }))} color={SERIES_COLORS[3]} />
                <div className="row caption" style={{ marginTop: 10 }}>
                  {summary.data.platforms.map((platform) => (
                    <span key={platform.platform}>{PLATFORM_LABEL[platform.platform] ?? platform.platform}: {fmtNumber(platform.count)}</span>
                  ))}
                </div>
              </>
            ) : (
              <Skeleton />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
