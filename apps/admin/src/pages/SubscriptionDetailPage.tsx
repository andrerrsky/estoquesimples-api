import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { Badge, Card, CopyId, Details, Empty, errorMessage, Json, KeyValue, Notice, PageHeader, Props, Skeleton, Time, useToast } from '../components/ui';
import { auditLabel, PLAN_LABEL, SUBSCRIPTION_STATE } from '../lib/labels';

interface SubscriptionDetail {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceDeletedAt: string | null;
  purchaserUserId: string | null;
  purchaserEmail: string | null;
  purchaserName: string | null;
  planKey: string;
  state: string;
  autoRenewing: boolean;
  acknowledged: boolean;
  startedAt: string | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  canceledAt: string | null;
  cancelReason: string | null;
  hasLinkedToken: boolean;
  supersededBy: string | null;
  supersedes: Array<{ id: string; state: string; createdAt: string }>;
  latestNotificationType: number | null;
  latestNotificationLabel: string | null;
  lastVerifiedAt: string;
  productId: string;
  basePlanId: string | null;
  offerId: string | null;
  raw: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  events: Array<{ id: string; notificationId: string; notificationType: number | null; notificationLabel: string | null; receivedAt: string; processedAt: string | null; processError: string | null }>;
  audit: Array<{ id: string; action: string; metadata: Record<string, unknown>; actorEmail: string | null; at: string }>;
}

export function SubscriptionDetailPage() {
  const { subscriptionId = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const queryKey = ['subscription', subscriptionId];
  const query = useQuery({ queryKey, queryFn: () => api.get<SubscriptionDetail>(`/billing/subscriptions/${subscriptionId}`) });
  const sub = query.data;

  const refresh = useMutation({
    mutationFn: () => api.post<{ from: string; to: string }>(`/billing/subscriptions/${subscriptionId}/refresh`),
    onSuccess: (result) => {
      toast.push(result.from === result.to ? `Reconsultada: continua ${SUBSCRIPTION_STATE[result.to]?.label ?? result.to}.` : `Estado atualizado: ${SUBSCRIPTION_STATE[result.from]?.label} → ${SUBSCRIPTION_STATE[result.to]?.label}.`, 'success');
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ['billing'] });
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  if (query.isLoading) return <div className="page"><Skeleton lines={8} /></div>;
  if (!sub) return <div className="page"><Notice tone="error">Assinatura não encontrada.</Notice></div>;

  const state = SUBSCRIPTION_STATE[sub.state];
  const stale = Date.now() - new Date(sub.lastVerifiedAt).getTime() > 48 * 3_600_000 && ['ativa', 'carencia', 'cancelada_mas_ativa'].includes(sub.state);
  const unacknowledged = !sub.acknowledged && ['ativa', 'pendente'].includes(sub.state);

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: 'Assinaturas', to: '/assinaturas' }, { label: sub.workspaceName }]}
        title={<span className="row">{sub.workspaceName} <Badge tone={state?.tone}>{state?.label ?? sub.state}</Badge></span>}
        subtitle={<span className="row">{PLAN_LABEL[sub.planKey] ?? sub.planKey} · <CopyId id={sub.id} /></span>}
        actions={
          can('support') && (
            <button type="button" className="btn btn--secondary" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              <Icon name="refresh" /> {refresh.isPending ? 'Consultando…' : 'Reconsultar no Google'}
            </button>
          )
        }
      />

      {state?.hint && <Notice tone={state.tone === 'error' ? 'error' : state.tone === 'warning' ? 'warning' : 'info'}>{state.hint}</Notice>}
      {stale && <Notice tone="warning" title="Sem verificação há mais de 48 horas">O estado pode estar desatualizado se uma notificação se perdeu. Reconsultar no Google resolve.</Notice>}
      {unacknowledged && <Notice tone="error" title="Compra não confirmada (acknowledge)">O Google reembolsa automaticamente compras não confirmadas em três dias. A reconciliação tenta confirmar de novo; reconsultar agora força a tentativa.</Notice>}

      <div className="grid grid--2">
        <Card title="Assinatura">
          <KeyValue
            items={[
              { label: 'Estado', value: <Badge tone={state?.tone}>{state?.label ?? sub.state}</Badge> },
              { label: 'Plano', value: `${PLAN_LABEL[sub.planKey] ?? sub.planKey} (${sub.productId}${sub.basePlanId ? ` / ${sub.basePlanId}` : ''}${sub.offerId ? ` / oferta ${sub.offerId}` : ''})` },
              { label: 'Renovação automática', value: sub.autoRenewing ? 'ligada' : 'desligada' },
              { label: 'Confirmada (ack)', value: sub.acknowledged ? 'sim' : <Badge tone="error">não</Badge> },
              { label: 'Início', value: <Time value={sub.startedAt} relative={false} /> },
              { label: 'Fim do período', value: <Time value={sub.currentPeriodEnd} relative={false} /> },
              { label: 'Carência até', value: <Time value={sub.graceUntil} relative={false} /> },
              { label: 'Cancelada em', value: sub.canceledAt ? <><Time value={sub.canceledAt} relative={false} />{sub.cancelReason && ` · ${sub.cancelReason}`}</> : '—' },
              { label: 'Última verificação', value: <Time value={sub.lastVerifiedAt} relative={false} /> },
              { label: 'Última notificação', value: sub.latestNotificationLabel ?? '—' },
              { label: 'Vinculada em', value: <Time value={sub.createdAt} relative={false} /> },
            ]}
          />
        </Card>
        <Card title="Empresa e comprador">
          <KeyValue
            items={[
              { label: 'Empresa', value: <><Link to={`/empresas/${sub.workspaceId}`}>{sub.workspaceName}</Link>{sub.workspaceDeletedAt && <Badge tone="error"> excluída</Badge>}</> },
              { label: 'Comprador', value: sub.purchaserEmail ? <Link to={`/usuarios/${sub.purchaserUserId}`}>{sub.purchaserName} ({sub.purchaserEmail})</Link> : <span className="muted">conta removida</span> },
              { label: 'Cadeia de compras', value: sub.hasLinkedToken ? 'substituiu uma compra anterior' : 'compra original' },
              { label: 'Substituída por', value: sub.supersededBy ? <Link to={`/assinaturas/${sub.supersededBy}`}>ver assinatura seguinte</Link> : '—' },
              { label: 'Substitui', value: sub.supersedes.length > 0 ? sub.supersedes.map((item) => <div key={item.id}><Link to={`/assinaturas/${item.id}`}>{SUBSCRIPTION_STATE[item.state]?.label ?? item.state}</Link> · <Time value={item.createdAt} /></div>) : '—' },
            ]}
          />
          <div style={{ marginTop: 12 }}>
            <Details summary="Resposta do Google (sem tokens)">
              <Json value={sub.raw} />
            </Details>
          </div>
        </Card>
      </div>

      <div className="grid grid--2">
        <Card title="Notificações do Google" subtitle="RTDN recebidas para este comprovante">
          {sub.events.length === 0 ? (
            <Empty icon="mail" title="Nenhuma notificação recebida" />
          ) : (
            <div className="list">
              {sub.events.map((event) => (
                <div key={event.id} className="list__item">
                  <div className="list__main">
                    <div className="list__title"><code>{event.notificationLabel ?? event.notificationType ?? 'desconhecido'}</code></div>
                    <div className="list__sub">recebida <Time value={event.receivedAt} relative={false} />{event.processedAt ? <> · processada <Time value={event.processedAt} /></> : ' · pendente'}{event.processError && <span style={{ color: 'var(--error)' }}> · {event.processError}</span>}</div>
                  </div>
                  {!event.processedAt && <Badge tone="warning">pendente</Badge>}
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Auditoria" subtitle="Mudanças de estado e ações relacionadas">
          {sub.audit.length === 0 ? (
            <Empty icon="list" title="Nenhum registro" />
          ) : (
            <div className="list">
              {sub.audit.map((entry) => (
                <div key={entry.id} className="list__item" style={{ alignItems: 'flex-start' }}>
                  <div className="list__main">
                    <div className="list__title">{auditLabel(entry.action).label}</div>
                    <div className="list__sub"><Time value={entry.at} relative={false} />{entry.actorEmail && ` · ${entry.actorEmail}`}</div>
                    <Props value={entry.metadata} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
