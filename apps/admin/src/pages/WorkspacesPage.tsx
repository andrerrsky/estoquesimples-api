import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { Badge, Card, DataTable, Empty, PageHeader, Pagination, Time, type Column } from '../components/ui';
import { useListParams, useSort } from '../lib/hooks';
import { fmtNumber } from '../lib/format';
import { PLAN_LABEL, SUBSCRIPTION_STATE } from '../lib/labels';

interface WorkspaceRow {
  id: string;
  name: string;
  ownerId: string;
  ownerEmail: string;
  ownerName: string;
  membersCount: number;
  productsCount: number;
  subscriptionState: string | null;
  planKey: string | null;
  seededAt: string | null;
  lastSyncAt: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export function WorkspacesPage() {
  const navigate = useNavigate();
  const { values, set, page, pageSize } = useListParams();
  const sort = useSort('createdAt');
  const [search, setSearch] = useState(values['q'] ?? '');

  useEffect(() => setSearch(values['q'] ?? ''), [values['q']]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if ((values['q'] ?? '') !== search) set({ q: search });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, values, set]);

  const query = useQuery({
    queryKey: ['workspaces', values, page, pageSize, sort.key, sort.order],
    queryFn: () =>
      api.get<Paginated<WorkspaceRow>>('/workspaces', {
        q: values['q'],
        subscription: values['subscription'],
        deleted: values['deleted'],
        sort: sort.key,
        order: sort.order,
        page,
        pageSize,
      }),
    placeholderData: (previous) => previous,
  });

  const columns: Array<Column<WorkspaceRow>> = [
    {
      key: 'name',
      header: 'Empresa',
      sortKey: 'name',
      render: (row) => (
        <div>
          <div className="cell-main">
            {row.name}
            {row.deletedAt && <Badge tone="error"> excluída</Badge>}
          </div>
          <div className="cell-sub">{row.ownerEmail}</div>
        </div>
      ),
    },
    {
      key: 'sub',
      header: 'Assinatura',
      render: (row) =>
        row.subscriptionState ? (
          <span className="row" style={{ gap: 6 }}>
            <Badge tone={SUBSCRIPTION_STATE[row.subscriptionState]?.tone}>{SUBSCRIPTION_STATE[row.subscriptionState]?.label ?? row.subscriptionState}</Badge>
            <span className="muted small">{PLAN_LABEL[row.planKey ?? ''] ?? row.planKey}</span>
          </span>
        ) : (
          <span className="muted">sem assinatura</span>
        ),
    },
    { key: 'members', header: 'Membros', numeric: true, render: (row) => fmtNumber(row.membersCount) },
    { key: 'products', header: 'Produtos', numeric: true, sortKey: 'products', render: (row) => fmtNumber(row.productsCount) },
    {
      key: 'sync',
      header: 'Nuvem',
      sortKey: 'lastSyncAt',
      render: (row) =>
        row.seededAt ? (
          <span>
            sync <Time value={row.lastSyncAt} />
          </span>
        ) : (
          <span className="muted">sem carga inicial</span>
        ),
    },
    { key: 'created', header: 'Criada', sortKey: 'createdAt', render: (row) => <Time value={row.createdAt} /> },
  ];

  return (
    <div className="page">
      <PageHeader title="Empresas" subtitle={query.data ? `${fmtNumber(query.data.total)} empresa(s)` : 'Workspaces do aplicativo'} />
      <Card flush>
        <div className="filters" style={{ padding: '14px 18px' }}>
          <input className="input input--sm input--search" placeholder="Nome, e-mail do dono ou ID" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Buscar" />
          <select className="select select--sm" value={values['subscription'] ?? ''} onChange={(event) => set({ subscription: event.target.value })} aria-label="Assinatura">
            <option value="">Assinatura: todas</option>
            <option value="entitled">Com acesso</option>
            <option value="problem">Com problema (pendente/suspensa)</option>
            <option value="none">Sem assinatura</option>
          </select>
          <label className="checkbox">
            <input type="checkbox" checked={values['deleted'] === 'true'} onChange={(event) => set({ deleted: event.target.checked ? 'true' : '' })} />
            mostrar excluídas
          </label>
        </div>
        <DataTable
          rows={query.data?.items ?? []}
          columns={columns}
          rowKey={(row) => row.id}
          onRowClick={(row) => navigate(`/empresas/${row.id}`)}
          loading={query.isLoading}
          sort={{ key: sort.key, order: sort.order }}
          onSort={sort.toggle}
          empty={<Empty icon="building" title="Nenhuma empresa encontrada" />}
        />
        {query.data && (
          <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={(next) => set({ page: next }, { resetPage: false })} onPageSize={(size) => set({ pageSize: size })} />
        )}
      </Card>
    </div>
  );
}
