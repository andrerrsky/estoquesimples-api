import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type SeriesPoint } from '../api/client';
import { Funnel, HorizontalBars, LineChart, RetentionGrid, SERIES_COLORS } from '../charts/charts';
import { Card, Chips, Empty, Notice, PageHeader, PlatformBadge, Skeleton, StatTile } from '../components/ui';
import { deltaRatio, fmtNumber } from '../lib/format';
import { useListParams } from '../lib/hooks';
import { eventDomain, PLATFORM_FILTER, PLATFORM_LABEL } from '../lib/labels';

interface Summary {
  range: { from: string; to: string; granularity: 'day' | 'week' | 'month'; days: number };
  /** Recorte aplicado pela API (null = todas as plataformas). */
  platform: string | null;
  active: { dau: number; wau: number; mau: number };
  series: { activeUsers: SeriesPoint[]; events: SeriesPoint[] };
  topEvents: Array<{ name: string; source: string; description: string | null; events: number; users: number; installs: number }>;
  topScreens: Array<{ screen: string; views: number; users: number }>;
  /** Aparelhos (e navegadores) registrados por plataforma; nunca recortado. */
  platforms: Array<{ platform: string; count: number; active30d: number; users30d: number }>;
  /** Eventos do período por plataforma atribuída; `server` = API sem plataforma. Nunca recortado. */
  byPlatform: Array<{ platform: string; events: number; users: number; installs: number }>;
  appVersions: Array<{ version: string; count: number }>;
}

interface Metrics {
  range: { from: string; to: string; days: number };
  platform: string | null;
  /** `platformApplied`: o número já está recortado; falso = a métrica não tem essa dimensão. */
  items: Array<{ key: string; label: string; description: string; unit: string; value: number; previous: number; platformApplied: boolean; platformNote: string | null }>;
}

interface FunnelData {
  platform: string | null;
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
  // Recorte de plataforma na URL, como o período: o link compartilhado mostra a mesma coisa.
  const platform = values['platform'] === 'android' || values['platform'] === 'web' ? values['platform'] : '';
  const platformName = platform ? (PLATFORM_LABEL[platform] ?? platform) : null;
  const [seriesEvent, setSeriesEvent] = useState<string | null>(null);

  const summary = useQuery({ queryKey: ['analytics', 'summary', days, platform], queryFn: () => api.get<Summary>('/analytics/summary', { days, platform }), placeholderData: (previous) => previous });
  const metrics = useQuery({ queryKey: ['analytics', 'metrics', days, platform], queryFn: () => api.get<Metrics>('/analytics/metrics', { days, platform }), placeholderData: (previous) => previous });
  const funnel = useQuery({ queryKey: ['analytics', 'funnel', days, platform], queryFn: () => api.get<FunnelData>('/analytics/funnel', { days, platform }), placeholderData: (previous) => previous });
  const retention = useQuery({ queryKey: ['analytics', 'retention'], queryFn: () => api.get<Retention>('/analytics/retention', { weeks: 8 }) });
  const eventSeries = useQuery({
    queryKey: ['analytics', 'event-series', seriesEvent, days, platform],
    queryFn: () => api.get<{ points: SeriesPoint[] }>(`/analytics/events/${seriesEvent}/series`, { days, metric: 'users', platform }),
    enabled: seriesEvent !== null,
  });

  const granularity = summary.data?.range.granularity ?? 'day';
  const totalEvents = summary.data?.series.events.reduce((sum, point) => sum + point.v, 0) ?? 0;
  const appEvents = summary.data?.topEvents.filter((event) => event.source === 'app') ?? [];
  const scope = platformName ? ` · só ${platformName}` : '';

  // Quadro por plataforma: junta eventos do período e aparelhos registrados.
  const platformRows = (() => {
    const data = summary.data;
    if (!data) return [];
    const keys = [...new Set([...data.byPlatform.map((row) => row.platform), ...data.platforms.map((row) => row.platform)])];
    const order = ['android', 'web', 'ios', 'server'];
    return keys
      .sort((a, b) => (order.indexOf(a) === -1 ? 9 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 9 : order.indexOf(b)))
      .map((key) => ({
        platform: key,
        events: data.byPlatform.find((row) => row.platform === key),
        devices: data.platforms.find((row) => row.platform === key),
      }));
  })();

  return (
    <div className="page">
      <PageHeader
        title="Uso do produto"
        subtitle="Quem usa, o que usa e como evolui. Combina eventos do app Android e da web com os marcos que a API registra."
        actions={
          <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Chips value={platform} onChange={(next) => set({ platform: next })} items={PLATFORM_FILTER} />
            <Chips value={days} onChange={(next) => set({ days: next })} items={RANGES} />
          </div>
        }
      />

      {summary.data && !platform && appEvents.length === 0 && (
        <Notice tone="info" title="O app e a web ainda não enviaram eventos de uso neste período">
          Os números abaixo vêm do que a API observa (cadastro, login, sincronização, assinatura). Quando os clientes chamam <code>POST /v1/analytics/events</code>, telas e funcionalidades usadas aparecem aqui. O catálogo de eventos está em <Link to="/eventos">Eventos</Link>.
        </Notice>
      )}
      {platformName && (
        <Notice tone="info" title={`Recorte: ${platformName}`}>
          Entram os eventos enviados por {platform === 'web' ? 'a web' : 'o app Android'} e os da API que registram de onde vieram (cadastro, login, convite{platform === 'web' ? ', contratação pela web' : ''}). Marcos da API sem plataforma ficam de fora. Usuários ativos contam só eventos de uso — a auditoria não guarda a plataforma — e por isso podem ser menores que no total. Indicadores que não têm essa dimensão continuam com o número geral e aparecem marcados como “todas as plataformas”.
        </Notice>
      )}

      <div className="grid grid--tiles">
        <StatTile label="Ativos hoje" value={fmtNumber(summary.data?.active.dau)} foot={`com atividade nas últimas 24h${scope}`} />
        <StatTile label="Ativos na semana" value={fmtNumber(summary.data?.active.wau)} foot={`últimos 7 dias${scope}`} />
        <StatTile label="Ativos no mês" value={fmtNumber(summary.data?.active.mau)} foot={`últimos 30 dias${scope}`} />
        <StatTile label="Aderência" value={summary.data && summary.data.active.mau > 0 ? `${Math.round((summary.data.active.dau / summary.data.active.mau) * 100)}%` : '—'} foot="DAU ÷ MAU: quantos do mês voltam por dia" hint="Acima de 20% é um produto de uso diário." />
        <StatTile label="Eventos no período" value={fmtNumber(totalEvents)} foot={`${fmtNumber(appEvents.reduce((sum, event) => sum + event.events, 0))} enviados pelos clientes${scope}`} />
      </div>

      <div className="grid grid--2">
        <Card title="Usuários ativos" subtitle={`Por ${granularity === 'day' ? 'dia' : granularity === 'week' ? 'semana' : 'mês'}${scope}`}>
          {summary.data ? <LineChart series={[{ key: 'active', label: 'Ativos', points: summary.data.series.activeUsers }]} granularity={granularity} /> : <Skeleton lines={5} />}
        </Card>
        <Card title="Eventos registrados" subtitle={platformName ? `Eventos atribuídos a ${platformName}` : 'Volume total: app, web e API'}>
          {summary.data ? <LineChart series={[{ key: 'events', label: 'Eventos', points: summary.data.series.events, color: SERIES_COLORS[1] }]} granularity={granularity} /> : <Skeleton lines={5} />}
        </Card>
      </div>

      <Card title="Por plataforma" subtitle="App Android × web no período selecionado. Este quadro é a própria comparação e não muda com o recorte.">
        {summary.data ? (
          platformRows.length === 0 ? (
            <Empty icon="activity" title="Nenhum evento nem aparelho registrado" />
          ) : (
            <div className="table-wrap">
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th>Plataforma</th>
                    <th className="num">Eventos</th>
                    <th className="num">Usuários com evento</th>
                    <th className="num">Instalações com evento</th>
                    <th className="num" title="Aparelhos e navegadores vistos nos últimos 30 dias (independe do período).">Aparelhos ativos (30d)</th>
                    <th className="num" title="Contas com aparelho visto nos últimos 30 dias (independe do período).">Contas com aparelho (30d)</th>
                  </tr>
                </thead>
                <tbody>
                  {platformRows.map((row) => (
                    <tr key={row.platform}>
                      <td>{row.platform === 'server' ? <span className="muted" title="Marcos observados pela API que não registram de onde vieram (empresa criada, sincronização, assinatura do Google Play).">API, sem plataforma</span> : <PlatformBadge platform={row.platform} />}</td>
                      <td className="num">{fmtNumber(row.events?.events ?? 0)}</td>
                      <td className="num">{fmtNumber(row.events?.users ?? 0)}</td>
                      <td className="num">{row.platform === 'server' ? '—' : fmtNumber(row.events?.installs ?? 0)}</td>
                      <td className="num">{row.platform === 'server' ? '—' : fmtNumber(row.devices?.active30d ?? 0)}</td>
                      <td className="num">{row.platform === 'server' ? '—' : fmtNumber(row.devices?.users30d ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <Skeleton lines={3} />
        )}
        <p className="caption" style={{ marginTop: 10 }}>Quem usa o app e a web conta nas duas linhas. Eventos da API entram na plataforma quando registram de onde vieram (cadastro, login, convite, contratação pela web).</p>
      </Card>

      <Card title="Indicadores do período" subtitle={`Comparados com os ${days} dias anteriores${scope}`}>
        {metrics.data ? (
          <div className="grid grid--tiles">
            {metrics.data.items.map((metric) => {
              // Com recorte ativo, quem não tem a dimensão mostra o total e diz isso.
              const unscoped = Boolean(platformName) && !metric.platformApplied;
              return (
                <StatTile
                  key={metric.key}
                  label={metric.label}
                  value={fmtNumber(metric.value)}
                  delta={deltaRatio(metric.value, metric.previous)}
                  foot={unscoped ? `todas as plataformas · antes: ${fmtNumber(metric.previous)}` : `antes: ${fmtNumber(metric.previous)}`}
                  hint={platformName && metric.platformApplied && metric.platformNote ? `${metric.description} Recorte: ${metric.platformNote}` : unscoped ? `${metric.description} Este indicador não tem plataforma; o número é o total.` : metric.description}
                />
              );
            })}
          </div>
        ) : (
          <Skeleton lines={4} />
        )}
      </Card>

      <div className="grid grid--2">
        <Card title="Funil" subtitle={platformName ? `Pessoas que usam ${platformName}, da abertura à assinatura` : 'Da abertura do app à assinatura, no período'}>
          {funnel.data ? <Funnel steps={funnel.data.steps} /> : <Skeleton lines={5} />}
          <p className="caption" style={{ marginTop: 12 }}>
            “Abriu o app” depende do evento enviado pelo cliente; as demais etapas usam também as tabelas de cadastro, empresa, carga e assinatura. “Assinou” conta compras do Google Play e contratações da web já pagas.
            {platformName && <> Com recorte, o funil é o das contas que têm aparelho (ou navegador) registrado em {platformName}: quem usa as duas plataformas aparece nos dois funis, e conta sem aparelho registrado, em nenhum.</>}
            {platform === 'web' && <> “Enviou o estoque” é a carga inicial do app Android; na web o estoque já nasce na nuvem e a etapa tende a zero.</>}
          </p>
        </Card>
        <Card title="Retenção semanal" subtitle={`Das contas criadas em cada semana, quantas voltaram nas semanas seguintes${platformName ? ' (todas as plataformas: não recortada)' : ''}`}>
          {retention.data ? <RetentionGrid cohorts={retention.data.cohorts} weeks={retention.data.weeks} /> : <Skeleton lines={5} />}
        </Card>
      </div>

      <div className="grid grid--2">
        <Card title="Funcionalidades mais usadas" subtitle={`Eventos por nome; clique para ver a série de usuários${scope}`}>
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
          <Card title="Telas mais vistas" subtitle={`Evento screen.viewed${scope}`}>
            {summary.data ? (
              summary.data.topScreens.length === 0 ? (
                <Empty icon="eye" title="Sem eventos de tela">Aparece quando o app ou a web emitirem <code>screen.viewed</code>.</Empty>
              ) : (
                <HorizontalBars items={summary.data.topScreens.map((screen) => ({ label: screen.screen, value: screen.views, hint: `${fmtNumber(screen.users)} pessoa(s)` }))} color={SERIES_COLORS[2]} />
              )
            ) : (
              <Skeleton />
            )}
          </Card>
          <Card title="Versões em uso" subtitle={`Aparelhos e navegadores vistos nos últimos 30 dias${scope}`}>
            {summary.data ? (
              <>
                <HorizontalBars items={summary.data.appVersions.map((item) => ({ label: `v${item.version}`, value: item.count }))} color={SERIES_COLORS[3]} />
                <div className="row caption" style={{ marginTop: 10 }}>
                  {summary.data.platforms.map((item) => (
                    <span key={item.platform}>{PLATFORM_LABEL[item.platform] ?? item.platform}: {fmtNumber(item.count)} registrado(s)</span>
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
