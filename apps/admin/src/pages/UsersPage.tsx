import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Badge, Card, DataTable, Empty, PageHeader, Pagination, PlatformBadges, StatTile, Time, type Column } from '../components/ui';
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
  /** Origem do cadastro web quando veio de campanha (UTMs; nunca o identificador do clique). */
  origin: { source: string | null; medium: string | null; campaign: string | null; content: string | null; hasClickId: boolean; consent: string | null } | null;
  /** Já cadastrou produto (ativação). */
  activated: boolean;
  /** Como a conta foi criada. */
  signupMethod: 'email' | 'google';
}

interface SignupMethods {
  days: number;
  email: number;
  google: number;
  googleClicks: number;
  googleOneTap: number;
  googleLogins: number;
  linked: number;
  activatedEmail: number;
  activatedGoogle: number;
}

/**
 * Cadastros por método nos últimos 30 dias, uso do Google (botão e One Tap) e
 * ativação (1º produto) por método: é o que diz se o Google traz gente que
 * usa ou só cadastros.
 */
function SignupMethodTiles() {
  const query = useQuery({ queryKey: ['users', 'signup-methods'], queryFn: () => api.get<SignupMethods>('/users/signup-methods', { days: 30 }) });
  const data = query.data;
  const total = data ? data.email + data.google : 0;
  const share = (part: number) => (total > 0 ? `${Math.round((part / total) * 100)}% dos cadastros` : 'nenhum cadastro ainda');
  const rate = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');
  return (
    <div className="grid grid--tiles">
      <StatTile
        label="Cadastro normal (30 dias)"
        value={data ? fmtNumber(data.email) : '—'}
        foot={data ? `${share(data.email)} · ativação ${rate(data.activatedEmail, data.email)}` : undefined}
        hint="Contas criadas com e-mail e senha. Ativação = cadastrou o 1º produto."
      />
      <StatTile
        label="Cadastro com Google (30 dias)"
        value={data ? fmtNumber(data.google) : '—'}
        foot={data ? `${share(data.google)} · ativação ${rate(data.activatedGoogle, data.google)}` : undefined}
        hint="Contas criadas pelo botão ou pelo One Tap do Google. Ativação = cadastrou o 1º produto."
        tone="accent"
      />
      <StatTile
        label="Toques no Google (30 dias)"
        value={data ? fmtNumber(data.googleClicks + data.googleOneTap) : '—'}
        foot={data ? `botão ${fmtNumber(data.googleClicks)} · One Tap ${fmtNumber(data.googleOneTap)}` : undefined}
        hint="Botão: toques em Continuar com o Google (por aparelho e dia). One Tap: contas escolhidas no cartão do Google. Inclui quem já tinha conta e só entrou."
      />
      <StatTile
        label="Entradas com Google"
        value={data ? fmtNumber(data.googleLogins) : '—'}
        foot={data ? `${fmtNumber(data.linked)} conta(s) existente(s) vinculada(s)` : undefined}
        hint="Logins pelo Google de contas que já existiam; vinculada = conta criada com e-mail que passou a entrar também com o Google."
      />
    </div>
  );
}

function OriginCell({ origin }: { origin: UserRow['origin'] }) {
  if (!origin) return <span className="muted">direto</span>;
  const main = [origin.source, origin.medium].filter(Boolean).join(' / ') || 'campanha';
  const sub = [origin.campaign, origin.content].filter(Boolean).join(' · ');
  return (
    <div title={origin.hasClickId ? (origin.consent === 'v2_accepted' ? 'Clique em anúncio; entra na exportação para o Google Ads' : 'Clique em anúncio; não vai ao Google Ads (sem aceite do aviso atual)') : undefined}>
      <div className="cell-main">{main}</div>
      {sub && <div className="cell-sub">{sub}</div>}
    </div>
  );
}

export function UsersPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
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
        signupMethod: values['signupMethod'],
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
          {row.activated && <Badge tone="success">1º produto</Badge>}
          {row.signupMethod === 'google' && <Badge tone="info">Google</Badge>}
          {row.lockedUntil && new Date(row.lockedUntil) > new Date() && <Badge tone="error">bloqueada</Badge>}
        </div>
      ),
    },
    {
      key: 'origin',
      header: 'Origem',
      render: (row) => <OriginCell origin={row.origin} />,
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
      <PageHeader
        title="Usuários"
        subtitle={query.data ? `${fmtNumber(query.data.total)} conta(s) · app Android e web` : 'Contas do app Android e da web'}
        actions={
          can('owner') && (
            <a
              className="btn btn--secondary btn--sm"
              href="/admin/api/ads/offline-conversions.csv?days=7"
              download
              title="Ativações (1º produto) dos últimos 7 dias de quem veio por anúncio e aceitou os cookies. Importe em Google Ads › Ferramentas › Uploads. Veja docs/aquisicao-e-conversao.md."
            >
              Ativações para o Google Ads (CSV)
            </a>
          )
        }
      />
      <SignupMethodTiles />
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
          <select className="select select--sm" value={values['signupMethod'] ?? ''} onChange={(event) => set({ signupMethod: event.target.value })} aria-label="Cadastro via">
            <option value="">Cadastro: todos</option>
            <option value="email">Cadastro normal (e-mail)</option>
            <option value="google">Cadastro com Google</option>
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
