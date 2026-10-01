import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { Badge, Card, Details, Empty, PageHeader, Pagination, Props, Skeleton, Tabs, Time } from '../components/ui';
import { fmtNumber } from '../lib/format';
import { useListParams } from '../lib/hooks';
import { eventDomain, PLATFORM_LABEL } from '../lib/labels';

interface EventRow {
  id: string;
  name: string;
  occurredAt: string;
  receivedAt: string;
  userId: string | null;
  userEmail: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  installId: string | null;
  platform: string;
  appVersionCode: number | null;
  sessionKey: string | null;
  source: string;
  properties: Record<string, unknown>;
}

interface EventName {
  name: string;
  source: string;
  total: number;
  firstSeen: string | null;
  lastSeen: string | null;
  inCatalog: boolean;
  description: string | null;
}

export function EventsPage() {
  const { values, set, page, pageSize } = useListParams();
  const tab = (values['tab'] as 'explorer' | 'catalog') ?? 'explorer';
  const [search, setSearch] = useState(values['q'] ?? '');

  useEffect(() => setSearch(values['q'] ?? ''), [values['q']]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if ((values['q'] ?? '') !== search) set({ q: search });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, values, set]);

  const names = useQuery({ queryKey: ['analytics', 'event-names'], queryFn: () => api.get<{ items: EventName[] }>('/analytics/event-names') });
  const events = useQuery({
    queryKey: ['analytics', 'events', values, page, pageSize],
    queryFn: () => api.get<Paginated<EventRow>>('/analytics/events', { name: values['name'], source: values['source'], platform: values['platform'], q: values['q'], from: values['from'] ? new Date(values['from']) : undefined, to: values['to'] ? new Date(`${values['to']}T23:59:59`) : undefined, page, pageSize }),
    placeholderData: (previous) => previous,
    enabled: tab === 'explorer',
  });

  return (
    <div className="page">
      <PageHeader title="Eventos" subtitle="Cada evento é um fato: quem, quando, em qual empresa, com quais propriedades." />
      <Tabs value={tab} onChange={(next) => set({ tab: next })} items={[{ key: 'explorer', label: 'Explorar' }, { key: 'catalog', label: 'Catálogo', count: names.data?.items.length }]} />

      {tab === 'explorer' ? (
        <Card flush>
          <div className="filters" style={{ padding: '14px 18px' }}>
            <select className="select select--sm" value={values['name'] ?? ''} onChange={(event) => set({ name: event.target.value })} aria-label="Evento">
              <option value="">Todos os eventos</option>
              {names.data?.items.filter((item) => item.total > 0).map((item) => (
                <option key={item.name} value={item.name}>{item.name} ({fmtNumber(item.total)})</option>
              ))}
            </select>
            <select className="select select--sm" value={values['source'] ?? ''} onChange={(event) => set({ source: event.target.value })} aria-label="Origem">
              <option value="">Origem: todas</option>
              <option value="app">Aplicativo</option>
              <option value="server">API</option>
            </select>
            <input className="input input--sm" type="date" value={values['from'] ?? ''} onChange={(event) => set({ from: event.target.value })} aria-label="De" />
            <input className="input input--sm" type="date" value={values['to'] ?? ''} onChange={(event) => set({ to: event.target.value })} aria-label="Até" />
            <input className="input input--sm input--search" placeholder="E-mail, empresa ou instalação" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <div className="table-wrap">
            <table className="table table--compact">
              <thead>
                <tr><th>Quando</th><th>Evento</th><th>Quem</th><th>Empresa</th><th>Origem</th><th>Propriedades</th></tr>
              </thead>
              <tbody>
                {events.isLoading ? (
                  <tr><td colSpan={6}><Skeleton /></td></tr>
                ) : (events.data?.items.length ?? 0) === 0 ? (
                  <tr><td colSpan={6}><Empty icon="activity" title="Nenhum evento com esses filtros" /></td></tr>
                ) : (
                  events.data?.items.map((event) => (
                    <tr key={event.id}>
                      <td className="nowrap"><Time value={event.occurredAt} relative={false} /></td>
                      <td><code>{event.name}</code><div className="cell-sub">{eventDomain(event.name)}</div></td>
                      <td>{event.userEmail ? <Link to={`/usuarios/${event.userId}`}>{event.userEmail}</Link> : event.installId ? <span className="muted mono small" title={event.installId}>instalação {event.installId.slice(0, 8)}</span> : <span className="muted">—</span>}</td>
                      <td>{event.workspaceName ? <Link to={`/empresas/${event.workspaceId}`}>{event.workspaceName}</Link> : <span className="muted">—</span>}</td>
                      <td className="muted">{event.source === 'server' ? 'API' : `${PLATFORM_LABEL[event.platform] ?? event.platform}${event.appVersionCode ? ` v${event.appVersionCode}` : ''}`}</td>
                      <td>{Object.keys(event.properties).length > 0 ? <Details summary="ver"><Props value={event.properties} /></Details> : <span className="muted">—</span>}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {events.data && <Pagination page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} onPage={(next) => set({ page: next }, { resetPage: false })} onPageSize={(size) => set({ pageSize: size })} />}
        </Card>
      ) : (
        <Card title="Catálogo de eventos" subtitle="O que o produto reconhece. Eventos fora do catálogo também são aceitos e aparecem marcados." flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Evento</th><th>Descrição</th><th>Origem</th><th className="num">Total</th><th>Primeiro</th><th>Último</th></tr>
              </thead>
              <tbody>
                {names.isLoading ? (
                  <tr><td colSpan={6}><Skeleton /></td></tr>
                ) : (
                  names.data?.items.map((item) => (
                    <tr key={item.name}>
                      <td><code>{item.name}</code>{!item.inCatalog && <Badge tone="warning"> fora do catálogo</Badge>}</td>
                      <td className="muted">{item.description ?? '—'}</td>
                      <td><Badge plain>{item.source === 'server' ? 'API' : item.source === 'both' ? 'app + API' : 'app'}</Badge></td>
                      <td className="num">{fmtNumber(item.total)}</td>
                      <td><Time value={item.firstSeen} /></td>
                      <td><Time value={item.lastSeen} /></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
