import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Badge, Card, DataTable, Empty, Notice, PageHeader, Pagination, ProviderBadge, StatTile, Tabs, Time, useToast, errorMessage, type Column } from '../components/ui';
import { useListParams, useSort } from '../lib/hooks';
import { fmtCents, fmtNumber } from '../lib/format';
import { ASAAS_EVENT, PLAN_LABEL, SUBSCRIPTION_PROVIDER, SUBSCRIPTION_STATE } from '../lib/labels';

interface SubscriptionRow {
  id: string;
  workspaceId: string;
  workspaceName: string;
  ownerEmail: string;
  purchaserEmail: string | null;
  planKey: string;
  /** `google_play` (app Android) ou `asaas` (web). */
  provider: string;
  state: string;
  autoRenewing: boolean;
  acknowledged: boolean;
  billingCycle: string | null;
  priceCents: number | null;
  startedAt: string | null;
  currentPeriodEnd: string | null;
  lastVerifiedAt: string;
  latestNotificationLabel: string | null;
  createdAt: string;
}

interface ProviderStats {
  provider: string;
  total: number;
  entitled: number;
  problem: number;
  eventsPending: number;
  /** Receita recorrente mensal em centavos; só existe para a web (Asaas). */
  mrrCents: number | null;
}

interface Stats {
  byState: Array<{ state: string; count: number }>;
  byProvider: ProviderStats[];
  expiring7d: number;
  unverified48h: number;
  eventsPending: number;
  playConfigured: boolean;
  asaasConfigured: boolean;
  asaasEnvironment: 'sandbox' | 'production';
}

interface BillingEvent {
  id: string;
  provider: string;
  /** Nome do evento do Asaas (PAYMENT_RECEIVED…); nulo no Google. */
  eventType: string | null;
  attempts: number;
  /** O reprocessamento tem o que consultar (comprovante no Google, assinatura no Asaas). */
  retryable: boolean;
  notificationId: string;
  notificationType: number | null;
  notificationLabel: string | null;
  subscriptionId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  receivedAt: string;
  processedAt: string | null;
  processError: string | null;
}

/** Unidade ao lado do número grande do cartão ("12 app · 3 web"). */
const UNIT_STYLE = { fontSize: 'var(--fs-supporting)', fontWeight: 500 } as const;

export function SubscriptionsPage() {
  const navigate = useNavigate();
  const { values, set, page, pageSize } = useListParams();
  const sort = useSort('createdAt');
  const [search, setSearch] = useState(values['q'] ?? '');
  const tab = (values['tab'] as 'subscriptions' | 'events') ?? 'subscriptions';

  useEffect(() => setSearch(values['q'] ?? ''), [values['q']]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if ((values['q'] ?? '') !== search) set({ q: search });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, values, set]);

  const stats = useQuery({ queryKey: ['billing', 'stats'], queryFn: () => api.get<Stats>('/billing/stats') });
  const query = useQuery({
    queryKey: ['billing', 'subscriptions', values, page, pageSize, sort.key, sort.order],
    queryFn: () => api.get<Paginated<SubscriptionRow>>('/billing/subscriptions', { q: values['q'], state: values['state'], planKey: values['planKey'], provider: values['provider'], sort: sort.key, order: sort.order, page, pageSize }),
    placeholderData: (previous) => previous,
    enabled: tab === 'subscriptions',
  });

  const entitled = stats.data?.byState.filter((row) => ['ativa', 'carencia', 'cancelada_mas_ativa'].includes(row.state)).reduce((sum, row) => sum + row.count, 0) ?? 0;
  const count = (state: string) => stats.data?.byState.find((row) => row.state === state)?.count ?? 0;
  const provider = (key: string) => stats.data?.byProvider.find((row) => row.provider === key);
  const play = provider('google_play');
  const web = provider('asaas');

  const columns: Array<Column<SubscriptionRow>> = [
    {
      key: 'workspace',
      header: 'Empresa',
      render: (row) => (
        <div>
          <div className="cell-main">{row.workspaceName}</div>
          <div className="cell-sub">{row.purchaserEmail ?? row.ownerEmail}</div>
        </div>
      ),
    },
    { key: 'provider', header: 'Origem', render: (row) => <ProviderBadge provider={row.provider} /> },
    { key: 'state', header: 'Estado', render: (row) => <Badge tone={SUBSCRIPTION_STATE[row.state]?.tone}>{SUBSCRIPTION_STATE[row.state]?.label ?? row.state}</Badge> },
    {
      key: 'plan',
      header: 'Plano',
      render: (row) => (
        <>
          {PLAN_LABEL[row.planKey] ?? row.planKey}
          {row.provider === 'asaas' && row.priceCents !== null && <span className="caption"> · {fmtCents(row.priceCents)}/{row.billingCycle === 'YEARLY' ? 'ano' : 'mês'}</span>}
          {!row.autoRenewing && ['ativa', 'carencia'].includes(row.state) && <span className="caption"> · renovação desligada</span>}
        </>
      ),
    },
    { key: 'end', header: 'Fim do período', sortKey: 'currentPeriodEnd', render: (row) => <Time value={row.currentPeriodEnd} /> },
    { key: 'verified', header: 'Verificada', sortKey: 'lastVerifiedAt', render: (row) => <Time value={row.lastVerifiedAt} /> },
    { key: 'notif', header: 'Última notificação', render: (row) => <span className="muted">{row.latestNotificationLabel ?? '—'}</span> },
    { key: 'created', header: 'Vinculada', sortKey: 'createdAt', render: (row) => <Time value={row.createdAt} /> },
  ];

  return (
    <div className="page">
      <PageHeader title="Assinaturas" subtitle="Assinaturas das empresas: compras do Google Play (app Android) e contratações pela web (Asaas)" actions={<Link to="/planos" className="btn btn--ghost">Planos e preços</Link>} />

      {stats.data && !stats.data.playConfigured && (
        <Notice tone="warning" title="Google Play não configurado neste ambiente">
          Sem a conta de serviço, a API não valida compras nem reconcilia assinaturas do app. Reconsultas dessas assinaturas pelo painel também ficam indisponíveis.
        </Notice>
      )}
      {stats.data && !stats.data.asaasConfigured && (
        <Notice tone="warning" title="Asaas não configurado neste ambiente">
          Sem a chave do Asaas a web não vende, e as assinaturas da web não são reconciliadas nem reconsultadas pelo painel.
        </Notice>
      )}
      {stats.data?.asaasConfigured && stats.data.asaasEnvironment === 'sandbox' && (
        <Notice tone="info">Asaas em modo sandbox: as cobranças da web neste ambiente são de teste.</Notice>
      )}

      <div className="grid grid--tiles">
        <StatTile label="Com acesso" value={fmtNumber(entitled)} foot={`${fmtNumber(count('ativa'))} ativas · ${fmtNumber(count('carencia'))} carência · ${fmtNumber(count('cancelada_mas_ativa'))} canceladas`} />
        <StatTile
          label="Por origem"
          value={<>{fmtNumber(play?.entitled)} <span className="muted" style={UNIT_STYLE}>app</span> · {fmtNumber(web?.entitled)} <span className="muted" style={UNIT_STYLE}>web</span></>}
          foot={web?.mrrCents != null ? `web: ${fmtCents(web.mrrCents)}/mês recorrente · preço do app fica na Play` : 'com acesso, por provedor'}
          hint="Google Play (app Android) × Asaas (web). A receita recorrente soma só as assinaturas da web ativas ou em carência; o plano anual entra como 1/12."
        />
        <StatTile label="Vencendo em 7 dias" value={fmtNumber(stats.data?.expiring7d)} foot="renovam ou expiram" />
        <StatTile label="Suspensas / pendentes" value={fmtNumber(count('suspensa') + count('pendente'))} foot="pagamento com problema" tone={count('suspensa') > 0 ? 'alert' : undefined} />
        <StatTile label="Sem verificação (48h)" value={fmtNumber(stats.data?.unverified48h)} foot="podem estar desatualizadas" tone={(stats.data?.unverified48h ?? 0) > 0 ? 'alert' : undefined} />
        <StatTile label="Notificações pendentes" value={fmtNumber(stats.data?.eventsPending)} foot={`${fmtNumber(play?.eventsPending ?? 0)} do Google · ${fmtNumber(web?.eventsPending ?? 0)} do Asaas, ainda não processadas`} tone={(stats.data?.eventsPending ?? 0) > 0 ? 'alert' : undefined} />
      </div>

      <Tabs value={tab} onChange={(next) => set({ tab: next })} items={[{ key: 'subscriptions', label: 'Assinaturas' }, { key: 'events', label: 'Notificações dos provedores', count: stats.data?.eventsPending }]} />

      {tab === 'subscriptions' ? (
        <Card flush>
          <div className="filters" style={{ padding: '14px 18px' }}>
            <input className="input input--sm input--search" placeholder="Empresa, e-mail ou ID" value={search} onChange={(event) => setSearch(event.target.value)} />
            <select className="select select--sm" value={values['state'] ?? ''} onChange={(event) => set({ state: event.target.value })}>
              <option value="">Todos os estados</option>
              {Object.entries(SUBSCRIPTION_STATE).filter(([key]) => key !== 'sem_assinatura').map(([key, info]) => (
                <option key={key} value={key}>{info.label}</option>
              ))}
            </select>
            <select className="select select--sm" value={values['provider'] ?? ''} onChange={(event) => set({ provider: event.target.value })} aria-label="Origem">
              <option value="">Todas as origens</option>
              {Object.entries(SUBSCRIPTION_PROVIDER).map(([key, info]) => (
                <option key={key} value={key}>{info.label}</option>
              ))}
            </select>
          </div>
          <DataTable rows={query.data?.items ?? []} columns={columns} rowKey={(row) => row.id} onRowClick={(row) => navigate(`/assinaturas/${row.id}`)} loading={query.isLoading} sort={{ key: sort.key, order: sort.order }} onSort={sort.toggle} empty={<Empty icon="card" title="Nenhuma assinatura encontrada" />} />
          {query.data && <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={(next) => set({ page: next }, { resetPage: false })} onPageSize={(size) => set({ pageSize: size })} />}
        </Card>
      ) : (
        <BillingEvents />
      )}
    </div>
  );
}

function BillingEvents() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<'all' | 'pending' | 'errors'>('pending');
  const [provider, setProvider] = useState('');
  const query = useQuery({
    queryKey: ['billing', 'events', page, filter, provider],
    queryFn: () => api.get<Paginated<BillingEvent>>('/billing/events', { page, pageSize: 50, onlyPending: filter === 'pending', onlyErrors: filter === 'errors', provider: provider || undefined }),
    placeholderData: (previous) => previous,
  });

  const retry = async (id: string) => {
    try {
      const result = await api.post<{ outcome: string; error: string | null }>(`/billing/events/${id}/retry`);
      toast.push(result.outcome === 'processed' ? 'Notificação processada.' : `Continua pendente: ${result.error}`, result.outcome === 'processed' ? 'success' : 'error');
      void query.refetch();
      void queryClient.invalidateQueries({ queryKey: ['billing', 'stats'] });
    } catch (error) {
      toast.push(errorMessage(error), 'error');
    }
  };

  return (
    <Card flush>
      <div className="filters" style={{ padding: '14px 18px' }}>
        <div className="chips">
          {([['pending', 'Pendentes'], ['errors', 'Com erro'], ['all', 'Todas']] as const).map(([key, label]) => (
            <button key={key} type="button" className={`chip ${filter === key ? 'active' : ''}`} onClick={() => { setFilter(key); setPage(1); }}>{label}</button>
          ))}
        </div>
        <select className="select select--sm" value={provider} onChange={(event) => { setProvider(event.target.value); setPage(1); }} aria-label="Provedor">
          <option value="">Todos os provedores</option>
          {Object.entries(SUBSCRIPTION_PROVIDER).map(([key, info]) => (
            <option key={key} value={key}>{info.label}</option>
          ))}
        </select>
        <div className="filters__spacer" />
        <span className="caption">A notificação nunca é fonte de verdade: ela só dispara uma consulta ao provedor (Google ou Asaas).</span>
      </div>
      <div className="table-wrap">
        <table className="table table--compact">
          <thead>
            <tr><th>Recebida</th><th>Provedor</th><th>Tipo</th><th>Empresa</th><th>Processada</th><th>Erro</th><th></th></tr>
          </thead>
          <tbody>
            {query.isLoading ? (
              <tr><td colSpan={7}><div className="skeleton" /></td></tr>
            ) : (query.data?.items.length ?? 0) === 0 ? (
              <tr><td colSpan={7}><Empty icon="check" title="Nenhuma notificação nesta lista" /></td></tr>
            ) : (
              query.data?.items.map((event) => (
                <tr key={event.id}>
                  <td className="nowrap"><Time value={event.receivedAt} relative={false} /></td>
                  <td><ProviderBadge provider={event.provider} short /></td>
                  <td>
                    {event.provider === 'asaas' ? (
                      <>{ASAAS_EVENT[event.eventType ?? ''] ?? event.eventType ?? '—'}<div className="cell-sub"><code>{event.eventType}</code></div></>
                    ) : (
                      <code>{event.notificationLabel ?? event.notificationType ?? '—'}</code>
                    )}
                  </td>
                  <td>
                    {event.workspaceName ? (
                      <Link to={event.subscriptionId ? `/assinaturas/${event.subscriptionId}` : `/empresas/${event.workspaceId}`}>{event.workspaceName}</Link>
                    ) : (
                      <span className="muted">{event.provider === 'asaas' ? 'assinatura ainda não registrada' : 'comprovante não vinculado'}</span>
                    )}
                  </td>
                  <td>{event.processedAt ? <Time value={event.processedAt} /> : <Badge tone="warning">pendente{event.attempts > 0 ? ` · ${event.attempts} tentativa(s)` : ''}</Badge>}</td>
                  <td className="muted small" style={{ maxWidth: 320 }}>{event.processError ?? '—'}</td>
                  <td>
                    {can('support') && event.retryable && <button type="button" className="btn btn--ghost btn--sm" onClick={() => void retry(event.id)}>Reprocessar</button>}
                    {!event.processedAt && !event.retryable && <span className="caption" title="Notificação do Google sem comprovante: não há o que consultar.">sem o que reprocessar</span>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {query.data && <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={setPage} />}
    </Card>
  );
}
