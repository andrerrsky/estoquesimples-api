import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';

import { api, type SeriesPoint } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { LineChart, Sparkline, SERIES_COLORS } from '../charts/charts';
import { Icon } from '../components/Icon';
import { Badge, Card, Empty, Notice, PageHeader, Skeleton, StatTile, Time } from '../components/ui';
import { deltaRatio, fmtNumber } from '../lib/format';
import { auditLabel, SUBSCRIPTION_STATE } from '../lib/labels';

interface Overview {
  generatedAt: string;
  kpis: Record<string, number>;
  series: Record<string, SeriesPoint[]>;
  alerts: Array<{ nome: string; detalhe: string }>;
  recentUsers: Array<{ id: string; email: string; name: string; createdAt: string; emailVerified: boolean }>;
  recentSubscriptionChanges: Array<{ subscriptionId: string | null; workspaceId: string | null; workspaceName: string | null; from: string | null; to: string | null; at: string }>;
  recentAdminActions: Array<{ id: string; adminEmail: string; action: string; targetType: string | null; targetId: string | null; at: string }>;
}

const ALERT_LABEL: Record<string, string> = {
  jobs_falhos: 'Tarefas falharam',
  fila_atrasada: 'Fila de tarefas atrasada',
  assinaturas_sem_verificacao: 'Assinaturas sem verificação',
  conflitos_esquecidos: 'Conflitos esquecidos',
};

export function OverviewPage() {
  const { admin } = useAuth();
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ['overview'], queryFn: () => api.get<Overview>('/overview'), refetchInterval: 60_000 });
  const data = query.data;
  const k = data?.kpis ?? {};
  const s = data?.series ?? {};

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const entitled = (k['subscriptionsActive'] ?? 0) + (k['subscriptionsGrace'] ?? 0) + (k['subscriptionsCanceledButActive'] ?? 0);

  return (
    <div className="page">
      <PageHeader
        title="Visão geral"
        subtitle={data ? <>Atualizado <Time value={data.generatedAt} /></> : 'Carregando o retrato da plataforma…'}
        actions={
          <button type="button" className="btn btn--ghost" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <Icon name="refresh" /> Atualizar
          </button>
        }
      />

      {query.isError && <Notice tone="error" title="Não foi possível carregar a visão geral">{String((query.error as Error).message)}</Notice>}

      <section className="hero">
        <div className="hero__intro">
          <h1>
            {greeting}, {admin?.name.split(' ')[0]}.
          </h1>
          <p>
            {data
              ? data.alerts.length === 0
                ? 'Nenhum alerta operacional. A API, a fila de tarefas e as assinaturas estão em ordem.'
                : `${data.alerts.length} alerta(s) precisam de atenção. Veja a seção de operação.`
              : 'Reunindo contas, assinaturas e uso do aplicativo.'}
          </p>
        </div>
        <div className="hero__stat">
          <div className="hero__stat-label">Contas ativas</div>
          <div className="hero__stat-value">{data ? fmtNumber(k['usersTotal']) : '—'}</div>
          <div className="hero__stat-delta">+{fmtNumber(k['usersNew7d'] ?? 0)} nos últimos 7 dias</div>
        </div>
        <div className="hero__stat">
          <div className="hero__stat-label">Empresas com assinatura</div>
          <div className="hero__stat-value">{data ? fmtNumber(k['workspacesWithSubscription']) : '—'}</div>
          <div className="hero__stat-delta">de {fmtNumber(k['workspacesActive'] ?? 0)} empresas</div>
        </div>
        <div className="hero__stat">
          <div className="hero__stat-label">Ativos hoje</div>
          <div className="hero__stat-value">{data ? fmtNumber(k['dau']) : '—'}</div>
          <div className="hero__stat-delta">
            {fmtNumber(k['wau'] ?? 0)} na semana · {fmtNumber(k['mau'] ?? 0)} no mês
          </div>
        </div>
      </section>

      {data && data.alerts.length > 0 && (
        <div className="stack stack--tight">
          {data.alerts.map((alert) => (
            <Notice key={alert.nome} tone="warning" title={ALERT_LABEL[alert.nome] ?? alert.nome}>
              {alert.detalhe} <Link to="/operacao">Ver operação</Link>
            </Notice>
          ))}
        </div>
      )}

      <div className="grid grid--tiles">
        <StatTile
          label="Novas contas (30d)"
          value={fmtNumber(k['usersNew30d'])}
          delta={data ? deltaRatio(k['usersNew30d'] ?? 0, k['usersNewPrev30d'] ?? 0) : undefined}
          foot="vs. 30 dias anteriores"
          spark={s['registrations'] && <Sparkline points={s['registrations']} />}
        />
        <StatTile
          label="Assinaturas com acesso"
          value={fmtNumber(entitled)}
          foot={`${fmtNumber(k['subscriptionsActive'] ?? 0)} ativas · ${fmtNumber(k['subscriptionsGrace'] ?? 0)} em carência · ${fmtNumber(k['subscriptionsCanceledButActive'] ?? 0)} canceladas`}
          hint="Estados que concedem sincronização: ativa, carência e cancelada mas ativa."
        />
        <StatTile
          label="Assinaturas novas (30d)"
          value={fmtNumber(k['subscriptionsNew30d'])}
          foot={`${fmtNumber(k['subscriptionsEnded30d'] ?? 0)} encerradas no período`}
          spark={s['subscriptionsStarted'] && <Sparkline points={s['subscriptionsStarted']} color={SERIES_COLORS[1]} />}
        />
        <StatTile
          label="Em atenção"
          value={fmtNumber((k['subscriptionsOnHold'] ?? 0) + (k['usersPendingDeletion'] ?? 0) + (k['usersSuspended'] ?? 0))}
          foot={`${fmtNumber(k['subscriptionsOnHold'] ?? 0)} suspensas · ${fmtNumber(k['usersPendingDeletion'] ?? 0)} exclusões · ${fmtNumber(k['usersSuspended'] ?? 0)} contas suspensas`}
          tone={((k['subscriptionsOnHold'] ?? 0) + (k['usersPendingDeletion'] ?? 0)) > 0 ? 'alert' : undefined}
        />
        <StatTile label="Aparelhos ativos (7d)" value={fmtNumber(k['devicesActive7d'])} foot={`${fmtNumber(k['syncOps24h'] ?? 0)} operações de sync em 24h`} />
        <StatTile
          label="Pendências técnicas"
          value={fmtNumber((k['conflictsPending'] ?? 0) + (k['jobsFailed'] ?? 0) + (k['billingEventsPending'] ?? 0))}
          foot={`${fmtNumber(k['conflictsPending'] ?? 0)} conflitos · ${fmtNumber(k['jobsFailed'] ?? 0)} tarefas falhas · ${fmtNumber(k['billingEventsPending'] ?? 0)} notificações`}
          tone={(k['jobsFailed'] ?? 0) > 0 ? 'alert' : undefined}
        />
      </div>

      <div className="grid grid--2">
        <Card title="Contas criadas" subtitle="Últimos 30 dias, por dia">
          {data ? <LineChart series={[{ key: 'reg', label: 'Contas', points: s['registrations'] ?? [] }]} /> : <Skeleton lines={5} />}
        </Card>
        <Card title="Usuários ativos" subtitle="Pessoas com alguma atividade no dia">
          {data ? <LineChart series={[{ key: 'act', label: 'Ativos', points: s['activeUsers'] ?? [] }]} /> : <Skeleton lines={5} />}
        </Card>
        <Card title="Assinaturas" subtitle="Vinculadas e encerradas por dia">
          {data ? (
            <LineChart
              series={[
                { key: 'started', label: 'Vinculadas', points: s['subscriptionsStarted'] ?? [] },
                { key: 'ended', label: 'Encerradas', points: s['subscriptionsEnded'] ?? [], color: SERIES_COLORS[1] },
              ]}
              area={false}
            />
          ) : (
            <Skeleton lines={5} />
          )}
        </Card>
        <Card title="Sincronização" subtitle="Operações recebidas dos aparelhos por dia">
          {data ? <LineChart series={[{ key: 'sync', label: 'Operações', points: s['syncOperations'] ?? [] }]} /> : <Skeleton lines={5} />}
        </Card>
      </div>

      <div className="grid grid--3">
        <Card title="Contas recentes" actions={<Link to="/usuarios" className="small">Ver todas</Link>}>
          {!data ? (
            <Skeleton />
          ) : data.recentUsers.length === 0 ? (
            <Empty icon="users" title="Nenhuma conta ainda" />
          ) : (
            <div className="list">
              {data.recentUsers.map((user) => (
                <div key={user.id} className="list__item" style={{ cursor: 'pointer' }} onClick={() => navigate(`/usuarios/${user.id}`)}>
                  <div className="list__main">
                    <div className="list__title">{user.name}</div>
                    <div className="list__sub">{user.email}</div>
                  </div>
                  {!user.emailVerified && <Badge tone="warning">não confirmado</Badge>}
                  <span className="list__meta">
                    <Time value={user.createdAt} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Assinaturas: últimas mudanças" actions={<Link to="/assinaturas" className="small">Ver todas</Link>}>
          {!data ? (
            <Skeleton />
          ) : data.recentSubscriptionChanges.length === 0 ? (
            <Empty icon="card" title="Nenhuma mudança registrada" />
          ) : (
            <div className="list">
              {data.recentSubscriptionChanges.map((change, index) => (
                <div
                  key={`${change.subscriptionId}-${index}`}
                  className="list__item"
                  style={{ cursor: change.subscriptionId ? 'pointer' : undefined }}
                  onClick={() => change.subscriptionId && navigate(`/assinaturas/${change.subscriptionId}`)}
                >
                  <div className="list__main">
                    <div className="list__title">{change.workspaceName ?? 'Empresa'}</div>
                    <div className="list__sub row" style={{ gap: 6 }}>
                      {change.from && <Badge tone={SUBSCRIPTION_STATE[change.from]?.tone}>{SUBSCRIPTION_STATE[change.from]?.label ?? change.from}</Badge>}
                      {change.from && <Icon name="chevronRight" size={12} />}
                      {change.to && <Badge tone={SUBSCRIPTION_STATE[change.to]?.tone}>{SUBSCRIPTION_STATE[change.to]?.label ?? change.to}</Badge>}
                    </div>
                  </div>
                  <span className="list__meta">
                    <Time value={change.at} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Ações do painel" actions={<Link to="/auditoria?tab=admins" className="small">Ver auditoria</Link>}>
          {!data ? (
            <Skeleton />
          ) : data.recentAdminActions.length === 0 ? (
            <Empty icon="shield" title="Nenhuma ação administrativa" />
          ) : (
            <div className="list">
              {data.recentAdminActions.map((action) => (
                <div key={action.id} className="list__item">
                  <div className="list__main">
                    <div className="list__title">{auditLabel(action.action).label}</div>
                    <div className="list__sub">{action.adminEmail}</div>
                  </div>
                  <span className="list__meta">
                    <Time value={action.at} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
