import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { Badge, Card, DataTable, Empty, PageHeader, Pagination, PlatformBadges, Time, type Column } from '../components/ui';
import { useListParams, useSort } from '../lib/hooks';
import { fmtNumber } from '../lib/format';
import { USER_STATUS } from '../lib/labels';

interface UserRow {
  id: string;
  email: string;
  name: string;
  status: string;
  emailVerified: boolean;
  createdAt: string;
  lastActivityAt: string | null;
  workspacesCount: number;
  hasActiveSubscription: boolean;
  lockedUntil: string | null;
  /** Plataformas em que a conta tem aparelho (ou navegador) ativo. */
  platforms: string[];
}

export function UsersPage() {
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
    queryKey: ['users', values, page, pageSize, sort.key, sort.order],
    queryFn: () =>
      api.get<Paginated<UserRow>>('/users', {
        q: values['q'],
        status: values['status'],
        emailVerified: values['emailVerified'],
        platform: values['platform'],
        sort: sort.key,
        order: sort.order,
        page,
        pageSize,
      }),
    placeholderData: (previous) => previous,
  });

  const columns: Array<Column<UserRow>> = [
    {
      key: 'user',
      header: 'Conta',
      sortKey: 'email',
      render: (row) => (
        <div>
          <div className="cell-main">{row.name}</div>
          <div className="cell-sub">{row.email}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Situação',
      render: (row) => (
        <div className="row" style={{ gap: 4 }}>
          <Badge tone={USER_STATUS[row.status]?.tone}>{USER_STATUS[row.status]?.label ?? row.status}</Badge>
          {!row.emailVerified && <Badge tone="warning">e-mail pendente</Badge>}
          {row.lockedUntil && new Date(row.lockedUntil) > new Date() && <Badge tone="error">bloqueada</Badge>}
        </div>
      ),
    },
    {
      key: 'platforms',
      header: 'Usa em',
      render: (row) => <PlatformBadges platforms={row.platforms} empty="sem aparelho" />,
    },
    {
      key: 'workspaces',
      header: 'Empresas',
      numeric: true,
      render: (row) => fmtNumber(row.workspacesCount),
    },
    {
      key: 'sub',
      header: 'Assinatura',
      render: (row) => (row.hasActiveSubscription ? <Badge tone="success">com acesso</Badge> : <span className="muted">—</span>),
    },
    { key: 'activity', header: 'Última atividade', sortKey: 'lastActivityAt', render: (row) => <Time value={row.lastActivityAt} /> },
    { key: 'created', header: 'Criada', sortKey: 'createdAt', render: (row) => <Time value={row.createdAt} /> },
  ];

  return (
    <div className="page">
      <PageHeader title="Usuários" subtitle={query.data ? `${fmtNumber(query.data.total)} conta(s) · app Android e web` : 'Contas do app Android e da web'} />
      <Card flush>
        <div className="filters" style={{ padding: '14px 18px' }}>
          <input
            className="input input--sm input--search"
            placeholder="E-mail, nome ou ID"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Buscar"
          />
          <select className="select select--sm" value={values['status'] ?? ''} onChange={(event) => set({ status: event.target.value })} aria-label="Situação">
            <option value="">Todas as situações</option>
            <option value="active">Ativas</option>
            <option value="suspended">Suspensas</option>
            <option value="pending_deletion">Exclusão pendente</option>
          </select>
          <select className="select select--sm" value={values['emailVerified'] ?? ''} onChange={(event) => set({ emailVerified: event.target.value })} aria-label="E-mail">
            <option value="">E-mail: todos</option>
            <option value="true">Confirmado</option>
            <option value="false">Não confirmado</option>
          </select>
          <select className="select select--sm" value={values['platform'] ?? ''} onChange={(event) => set({ platform: event.target.value })} aria-label="Plataforma" title="Contas com aparelho (ou navegador) ativo na plataforma. Quem usa as duas aparece nas duas.">
            <option value="">Plataforma: todas</option>
            <option value="android">Usa o app Android</option>
            <option value="web">Usa a web</option>
          </select>
        </div>
        <DataTable
          rows={query.data?.items ?? []}
          columns={columns}
          rowKey={(row) => row.id}
          onRowClick={(row) => navigate(`/usuarios/${row.id}`)}
          loading={query.isLoading}
          sort={{ key: sort.key, order: sort.order }}
          onSort={sort.toggle}
          empty={<Empty icon="users" title="Nenhuma conta encontrada">Ajuste a busca ou os filtros.</Empty>}
        />
        {query.data && (
          <Pagination
            page={query.data.page}
            pageSize={query.data.pageSize}
            total={query.data.total}
            onPage={(next) => set({ page: next }, { resetPage: false })}
            onPageSize={(size) => set({ pageSize: size })}
          />
        )}
      </Card>
    </div>
  );
}
