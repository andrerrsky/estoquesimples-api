import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client';
import { Badge, Card, Details, Empty, PageHeader, Props, Skeleton, Tabs, Time } from '../components/ui';
import { fmtNumber } from '../lib/format';
import { useListParams } from '../lib/hooks';

interface ErrorGroup {
  fingerprint: string;
  count: number;
  users: number;
  firstSeen: string;
  lastSeen: string;
  source: 'api' | 'web' | 'android' | 'admin';
  kind: string;
  level: string;
  code: string | null;
  message: string;
  route: string | null;
  status: number | null;
  appVersion: string | null;
}

interface Occurrence {
  id: string;
  occurredAt: string;
  source: string;
  level: string;
  kind: string;
  code: string | null;
  message: string;
  stack: string | null;
  httpMethod: string | null;
  route: string | null;
  status: number | null;
  correlationId: string | null;
  userId: string | null;
  userEmail: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  appVersion: string | null;
  platform: string | null;
  userAgent: string | null;
  context: Record<string, unknown>;
}

const SOURCE_LABEL: Record<string, string> = { api: 'API', web: 'Web', android: 'App Android', admin: 'Painel' };
const KIND_LABEL: Record<string, string> = {
  api: 'resposta 5xx',
  job: 'tarefa',
  exception: 'exceção',
  unhandled_rejection: 'promessa sem tratamento',
  render: 'tela quebrou',
  crash: 'app fechou',
  sync: 'sincronização',
};

/**
 * Erros de produção de todas as pontas (API, web, web app e app Android),
 * agrupados. O código que aparece para o usuário ("código 1a2b3c4d") é o
 * começo do correlationId: buscar por ele leva direto à ocorrência.
 */
export function ErrorsPage() {
  const { values, set } = useListParams();
  const period = (values['period'] as '1h' | '24h' | '7d' | '30d') ?? '24h';
  const source = values['source'] ?? '';
  const [search, setSearch] = useState(values['q'] ?? '');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if ((values['q'] ?? '') !== search) set({ q: search });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, values, set]);

  const groups = useQuery({
    queryKey: ['errors', period, source, values['q']],
    queryFn: () => api.get<{ groups: ErrorGroup[]; totals: Array<{ source: string; count: number }> }>('/errors', { period, source: source || undefined, q: values['q'] || undefined }),
    placeholderData: (previous) => previous,
    refetchInterval: 30_000,
  });
  const total = groups.data?.totals.reduce((sum, item) => sum + item.count, 0) ?? 0;

  return (
    <div className="page">
      <PageHeader title="Erros" subtitle="O que deu errado em produção: API, web, web app e app Android. Guardados por 30 dias." />
      <Tabs
        value={period}
        onChange={(next) => set({ period: next })}
        items={[
          { key: '1h', label: 'Última hora' },
          { key: '24h', label: '24 horas' },
          { key: '7d', label: '7 dias' },
          { key: '30d', label: '30 dias' },
        ]}
      />
      <Card flush>
        <div className="filters" style={{ padding: '14px 18px' }}>
          <select className="select select--sm" value={source} onChange={(event) => set({ source: event.target.value })} aria-label="Origem">
            <option value="">Todas as origens ({fmtNumber(total)})</option>
            {['api', 'web', 'android', 'admin'].map((key) => (
              <option key={key} value={key}>
                {SOURCE_LABEL[key]} ({fmtNumber(groups.data?.totals.find((item) => item.source === key)?.count ?? 0)})
              </option>
            ))}
          </select>
          <input className="input input--sm input--search" placeholder="Mensagem, código, rota ou código do erro (1a2b3c4d)" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <div className="table-wrap">
          <table className="table table--compact">
            <thead>
              <tr><th>Erro</th><th>Origem</th><th className="num">Vezes</th><th className="num">Pessoas</th><th>Última</th><th>Primeira</th></tr>
            </thead>
            <tbody>
              {groups.isLoading ? (
                <tr><td colSpan={6}><Skeleton /></td></tr>
              ) : (groups.data?.groups.length ?? 0) === 0 ? (
                <tr><td colSpan={6}><Empty icon="check" title="Nenhum erro neste período" /></td></tr>
              ) : (
                groups.data?.groups.flatMap((group) => [
                  <tr key={group.fingerprint} className="row-click" onClick={() => setOpen(open === group.fingerprint ? null : group.fingerprint)} style={{ cursor: 'pointer' }}>
                    <td style={{ maxWidth: 520 }}>
                      <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{group.message}</div>
                      <div className="cell-sub">
                        {KIND_LABEL[group.kind] ?? group.kind}
                        {group.code ? ` · ${group.code}` : ''}
                        {group.route ? ` · ${group.route}` : ''}
                        {group.status ? ` · ${group.status}` : ''}
                        {group.appVersion ? ` · v${group.appVersion}` : ''}
                      </div>
                    </td>
                    <td><Badge tone={group.level === 'warning' ? 'warning' : 'error'}>{SOURCE_LABEL[group.source] ?? group.source}</Badge></td>
                    <td className="num">{fmtNumber(group.count)}</td>
                    <td className="num">{fmtNumber(group.users)}</td>
                    <td className="nowrap"><Time value={group.lastSeen} /></td>
                    <td className="nowrap"><Time value={group.firstSeen} /></td>
                  </tr>,
                  open === group.fingerprint ? (
                    <tr key={`${group.fingerprint}-detail`}>
                      <td colSpan={6} style={{ background: 'var(--surface)' }}>
                        <Occurrences fingerprint={group.fingerprint} />
                      </td>
                    </tr>
                  ) : null,
                ])
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Occurrences({ fingerprint }: { fingerprint: string }) {
  const query = useQuery({ queryKey: ['errors', 'occurrences', fingerprint], queryFn: () => api.get<{ occurrences: Occurrence[] }>(`/errors/${fingerprint}`) });
  if (query.isLoading) return <Skeleton />;
  const items = query.data?.occurrences ?? [];
  return (
    <div className="stack" style={{ gap: 10 }}>
      {items.map((item) => (
        <div key={item.id} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', fontSize: 13 }}>
            <strong><Time value={item.occurredAt} relative={false} /></strong>
            {item.correlationId && <code title="O cliente vê os 8 primeiros caracteres">{item.correlationId}</code>}
            {item.httpMethod && <span className="mono">{item.httpMethod} {item.route}</span>}
            {!item.httpMethod && item.route && <span className="mono">{item.route}</span>}
            {item.userEmail ? <Link to={`/usuarios/${item.userId}`}>{item.userEmail}</Link> : <span className="muted">sem login</span>}
            {item.workspaceName && <Link to={`/empresas/${item.workspaceId}`}>{item.workspaceName}</Link>}
            {item.appVersion && <span className="muted">v{item.appVersion}</span>}
            {item.platform && <span className="muted">{item.platform}</span>}
          </div>
          <div style={{ marginTop: 6, overflowWrap: 'anywhere' }}>{item.message}</div>
          <div className="row" style={{ gap: 12, marginTop: 6 }}>
            {item.stack && (
              <Details summary="pilha">
                <pre className="mono small" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', margin: 0 }}>{item.stack}</pre>
              </Details>
            )}
            {Object.keys(item.context ?? {}).length > 0 && (
              <Details summary="contexto">
                <Props value={item.context} />
              </Details>
            )}
            {item.userAgent && (
              <Details summary="navegador / aparelho">
                <span className="small muted">{item.userAgent}</span>
              </Details>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
