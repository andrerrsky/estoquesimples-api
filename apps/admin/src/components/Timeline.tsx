import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { describeUserAgent } from '../lib/format';
import { auditLabel, PLATFORM_LABEL } from '../lib/labels';
import { Icon, type IconName } from './Icon';
import { Details, Empty, Pagination, Props, Skeleton, Time } from './ui';

export interface TimelineItem {
  source: 'user' | 'admin';
  id: string;
  action: string;
  at: string;
  actor: string | null;
  actorUserId?: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent?: string | null;
}

const TONE_CLASS: Record<string, string> = {
  warning: 'timeline__dot--warn',
  error: 'timeline__dot--error',
  success: 'timeline__dot--ok',
};

const ICON_BY_PREFIX: Record<string, IconName> = {
  user: 'user',
  device: 'phone',
  workspace: 'building',
  member: 'users',
  invite: 'mail',
  subscription: 'card',
  sync: 'sync',
  data: 'download',
  product: 'package',
  stock: 'package',
  admin: 'shield',
  note: 'note',
  ops: 'zap',
  plan: 'tag',
};

/**
 * `selfUserId`: na ficha de uma conta, quem fez é a própria pessoa na maioria
 * das linhas; aí o nome é omitido e só aparece quando foi outra pessoa (o
 * dono da empresa, por exemplo) ou o suporte.
 */
export function TimelineList({ items, selfUserId }: { items: TimelineItem[]; selfUserId?: string }) {
  if (items.length === 0) return <Empty icon="list" title="Nenhum registro" />;
  return (
    <div className="timeline">
      {items.map((item) => {
        const info = auditLabel(item.action);
        const prefix = item.action.split('.')[0] ?? '';
        const toneClass = item.source === 'admin' ? 'timeline__dot--admin' : (TONE_CLASS[info.tone] ?? '');
        const { reason, ...rest } = item.metadata;
        return (
          <div key={`${item.source}-${item.id}`} className="timeline__item">
            <div className={`timeline__dot ${toneClass}`}>
              <Icon name={ICON_BY_PREFIX[prefix] ?? 'activity'} />
            </div>
            <div className="timeline__body">
              <div className="timeline__title">
                {info.label}
                {item.source === 'admin' && <span className="badge badge--brand" style={{ marginLeft: 8 }}>suporte</span>}
              </div>
              <div className="timeline__meta">
                <Time value={item.at} relative={false} />
                {item.source === 'admin' && item.actor && <> · suporte: {item.actor}</>}
                {item.source === 'user' && item.actorUserId && item.actorUserId !== selfUserId && (
                  <> · por <Link to={`/usuarios/${item.actorUserId}`}>{item.actor ?? item.actorUserId.slice(0, 8)}</Link></>
                )}
                {item.source === 'user' && !item.actorUserId && <> · sistema</>}
                {item.workspaceName && (
                  <>
                    {' '}· <Link to={`/empresas/${item.workspaceId}`}>{item.workspaceName}</Link>
                  </>
                )}
                {item.ip && <> · <span className="mono">{item.ip}</span></>}
                {item.userAgent && <> · <span title={item.userAgent}>{describeUserAgent(item.userAgent)}</span></>}
              </div>
              {typeof reason === 'string' && <div className="timeline__detail small">“{reason}”</div>}
              {Object.keys(rest).length > 0 && (
                <div className="timeline__detail">
                  <Props value={rest} />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TimelinePanel({ path, queryKey, selfUserId, securityFilter = false }: { path: string; queryKey: unknown[]; selfUserId?: string; securityFilter?: boolean }) {
  const [page, setPage] = useState(1);
  const [security, setSecurity] = useState(false);
  const query = useQuery({
    queryKey: [...queryKey, 'timeline', page, security],
    queryFn: () => api.get<Paginated<TimelineItem>>(path, { page, pageSize: 50, security: security ? 'true' : undefined }),
    placeholderData: (previous) => previous,
  });
  return (
    <div>
      {securityFilter && (
        <div className="filters" style={{ marginBottom: 12 }}>
          <label className="checkbox">
            <input type="checkbox" checked={security} onChange={(event) => { setSecurity(event.target.checked); setPage(1); }} /> só segurança (acessos, senha, sessões, aparelhos, exclusão)
          </label>
        </div>
      )}
      {query.isLoading ? <Skeleton lines={6} /> : <TimelineList items={query.data?.items ?? []} selfUserId={selfUserId} />}
      {query.data && query.data.total > 50 && (
        <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={setPage} />
      )}
    </div>
  );
}

export interface EventItem {
  id: string;
  name: string;
  occurredAt: string;
  workspaceId: string | null;
  workspaceName: string | null;
  platform: string;
  appVersionCode: number | null;
  source: string;
  properties: Record<string, unknown>;
  sessionKey: string | null;
}

export function EventsPanel({ path, queryKey }: { path: string; queryKey: unknown[] }) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: [...queryKey, 'events', page],
    queryFn: () => api.get<Paginated<EventItem>>(path, { page, pageSize: 50 }),
    placeholderData: (previous) => previous,
  });
  if (query.isLoading) return <Skeleton lines={6} />;
  const items = query.data?.items ?? [];
  if (items.length === 0) {
    return (
      <Empty icon="activity" title="Nenhum evento de uso">
        Eventos aparecem quando o app ou a web enviam telemetria, ou quando a API registra marcos (login, sincronização, assinatura).
      </Empty>
    );
  }
  return (
    <div>
      <div className="table-wrap">
        <table className="table table--compact">
          <thead>
            <tr>
              <th>Quando</th>
              <th>Evento</th>
              <th>Origem</th>
              <th>Empresa</th>
              <th>Detalhes</th>
            </tr>
          </thead>
          <tbody>
            {items.map((event) => (
              <tr key={event.id}>
                <td className="nowrap">
                  <Time value={event.occurredAt} relative={false} />
                </td>
                <td>
                  <code>{event.name}</code>
                </td>
                <td className="muted">
                  {event.source === 'server' ? 'API' : `${PLATFORM_LABEL[event.platform] ?? event.platform}${event.appVersionCode ? ` v${event.appVersionCode}` : ''}`}
                </td>
                <td>{event.workspaceName ? <Link to={`/empresas/${event.workspaceId}`}>{event.workspaceName}</Link> : <span className="muted">—</span>}</td>
                <td>
                  {Object.keys(event.properties).length > 0 ? (
                    <Details summary="propriedades">
                      <Props value={event.properties} />
                    </Details>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {query.data && query.data.total > 50 && (
        <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={setPage} />
      )}
    </div>
  );
}
