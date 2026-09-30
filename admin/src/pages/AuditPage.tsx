import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { Badge, Card, Details, Empty, PageHeader, Pagination, Props, Skeleton, Tabs, Time } from '../components/ui';
import { useListParams } from '../lib/hooks';
import { auditLabel } from '../lib/labels';

interface UserAudit {
  id: string;
  action: string;
  at: string;
  actorUserId: string | null;
  actorEmail: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  deviceModel: string | null;
}

interface AdminAudit {
  id: string;
  adminId: string | null;
  adminEmail: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  at: string;
}

const TARGET_PATH: Record<string, string> = { user: '/usuarios', workspace: '/empresas', subscription: '/assinaturas' };

export function AuditPage() {
  const { values, set, page, pageSize } = useListParams();
  const tab = (values['tab'] as 'users' | 'admins') ?? 'users';
  const [search, setSearch] = useState(values['q'] ?? '');

  useEffect(() => setSearch(values['q'] ?? ''), [values['q']]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if ((values['q'] ?? '') !== search) set({ q: search });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, values, set]);

  const actions = useQuery({ queryKey: ['audit', 'actions'], queryFn: () => api.get<{ user: string[]; admin: string[] }>('/audit/actions') });
  const users = useQuery({
    queryKey: ['audit', 'users', values, page, pageSize],
    queryFn: () => api.get<Paginated<UserAudit>>('/audit/users', { action: values['action'], q: values['q'], from: values['from'] ? new Date(values['from']) : undefined, to: values['to'] ? new Date(`${values['to']}T23:59:59`) : undefined, page, pageSize }),
    placeholderData: (previous) => previous,
    enabled: tab === 'users',
  });
  const admins = useQuery({
    queryKey: ['audit', 'admins', values, page, pageSize],
    queryFn: () => api.get<Paginated<AdminAudit>>('/audit/admins', { action: values['action'], includeLogins: values['includeLogins'], from: values['from'] ? new Date(values['from']) : undefined, to: values['to'] ? new Date(`${values['to']}T23:59:59`) : undefined, page, pageSize }),
    placeholderData: (previous) => previous,
    enabled: tab === 'admins',
  });

  const list = tab === 'users' ? actions.data?.user : actions.data?.admin;
  const groups = [...new Set((list ?? []).map((action) => action.split('.')[0] ?? ''))];

  return (
    <div className="page">
      <PageHeader title="Auditoria" subtitle="O que aconteceu, quando e quem fez. A trilha dos clientes e a dos administradores ficam separadas." />
      <Tabs value={tab} onChange={(next) => set({ tab: next, action: '', q: '' })} items={[{ key: 'users', label: 'Contas e empresas' }, { key: 'admins', label: 'Administradores' }]} />

      <Card flush>
        <div className="filters" style={{ padding: '14px 18px' }}>
          <select className="select select--sm" value={values['action'] ?? ''} onChange={(event) => set({ action: event.target.value })} aria-label="Ação">
            <option value="">Todas as ações</option>
            {groups.map((group) => (
              <optgroup key={group} label={group}>
                <option value={`${group}.`}>todas de {group}</option>
                {(list ?? []).filter((action) => action.startsWith(`${group}.`)).map((action) => (
                  <option key={action} value={action}>{auditLabel(action).label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <input className="input input--sm" type="date" value={values['from'] ?? ''} onChange={(event) => set({ from: event.target.value })} aria-label="De" />
          <input className="input input--sm" type="date" value={values['to'] ?? ''} onChange={(event) => set({ to: event.target.value })} aria-label="Até" />
          {tab === 'users' ? (
            <input className="input input--sm input--search" placeholder="E-mail, empresa ou ID de entidade" value={search} onChange={(event) => setSearch(event.target.value)} />
          ) : (
            <label className="checkbox"><input type="checkbox" checked={values['includeLogins'] === 'true'} onChange={(event) => set({ includeLogins: event.target.checked ? 'true' : '' })} /> incluir logins</label>
          )}
        </div>

        {tab === 'users' ? (
          <>
            <div className="table-wrap">
              <table className="table table--compact">
                <thead><tr><th>Quando</th><th>Ação</th><th>Quem</th><th>Empresa</th><th>Alvo</th><th>Detalhes</th></tr></thead>
                <tbody>
                  {users.isLoading ? (
                    <tr><td colSpan={6}><Skeleton /></td></tr>
                  ) : (users.data?.items.length ?? 0) === 0 ? (
                    <tr><td colSpan={6}><Empty icon="list" title="Nenhum registro com esses filtros" /></td></tr>
                  ) : (
                    users.data?.items.map((entry) => {
                      const info = auditLabel(entry.action);
                      return (
                        <tr key={entry.id}>
                          <td className="nowrap"><Time value={entry.at} relative={false} /></td>
                          <td><Badge tone={info.tone}>{info.label}</Badge><div className="cell-sub"><code>{entry.action}</code></div></td>
                          <td>{entry.actorEmail ? <Link to={`/usuarios/${entry.actorUserId}`}>{entry.actorEmail}</Link> : <span className="muted">sistema</span>}{entry.deviceModel && <div className="cell-sub">{entry.deviceModel}</div>}{entry.ip && <div className="cell-sub mono">{entry.ip}</div>}</td>
                          <td>{entry.workspaceName ? <Link to={`/empresas/${entry.workspaceId}`}>{entry.workspaceName}</Link> : <span className="muted">—</span>}</td>
                          <td className="muted small">{entry.entityType ? <>{entry.entityType} <span className="mono">{entry.entityId?.slice(0, 8)}</span></> : '—'}</td>
                          <td>{Object.keys(entry.metadata).length > 0 ? <Details summary="ver"><Props value={entry.metadata} /></Details> : <span className="muted">—</span>}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            {users.data && <Pagination page={users.data.page} pageSize={users.data.pageSize} total={users.data.total} onPage={(next) => set({ page: next }, { resetPage: false })} onPageSize={(size) => set({ pageSize: size })} />}
          </>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table table--compact">
                <thead><tr><th>Quando</th><th>Ação</th><th>Administrador</th><th>Alvo</th><th>Detalhes</th></tr></thead>
                <tbody>
                  {admins.isLoading ? (
                    <tr><td colSpan={5}><Skeleton /></td></tr>
                  ) : (admins.data?.items.length ?? 0) === 0 ? (
                    <tr><td colSpan={5}><Empty icon="shield" title="Nenhuma ação administrativa com esses filtros" /></td></tr>
                  ) : (
                    admins.data?.items.map((entry) => {
                      const info = auditLabel(entry.action);
                      const path = entry.targetType ? TARGET_PATH[entry.targetType] : undefined;
                      const { reason, ...rest } = entry.metadata;
                      return (
                        <tr key={entry.id}>
                          <td className="nowrap"><Time value={entry.at} relative={false} /></td>
                          <td><Badge tone={info.tone}>{info.label}</Badge><div className="cell-sub"><code>{entry.action}</code></div></td>
                          <td>{entry.adminEmail}{entry.ip && <div className="cell-sub mono">{entry.ip}</div>}</td>
                          <td>{path && entry.targetId ? <Link to={`${path}/${entry.targetId}`}>{entry.targetLabel ?? entry.targetId.slice(0, 8)}</Link> : <span className="muted small">{entry.targetType ?? '—'} {entry.targetLabel ?? entry.targetId?.slice(0, 8) ?? ''}</span>}</td>
                          <td>
                            {typeof reason === 'string' && <div className="small">“{reason}”</div>}
                            {Object.keys(rest).length > 0 && <Details summary="ver"><Props value={rest} /></Details>}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            {admins.data && <Pagination page={admins.data.page} pageSize={admins.data.pageSize} total={admins.data.total} onPage={(next) => set({ page: next }, { resetPage: false })} onPageSize={(size) => set({ pageSize: size })} />}
          </>
        )}
      </Card>
    </div>
  );
}
