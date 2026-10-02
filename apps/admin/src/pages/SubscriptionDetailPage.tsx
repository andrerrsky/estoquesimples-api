import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { Badge, Card, CopyId, Details, Empty, errorMessage, ExternalLink, Json, KeyValue, Notice, PageHeader, Props, ProviderBadge, Skeleton, Time, useToast } from '../components/ui';
import { fmtCents, fmtDay } from '../lib/format';
import { ASAAS_EVENT, auditLabel, BILLING_CYCLE, BILLING_TYPE, PAYMENT_STATUS, PLAN_LABEL, SUBSCRIPTION_STATE, subscriptionHint } from '../lib/labels';

interface AsaasPayment {
  id: string;
  providerPaymentId: string;
  status: string;
  billingType: string | null;
  valueCents: number;
  netValueCents: number | null;
  description: string | null;
  dueDate: string | null;
  paidAt: string | null;
  invoiceUrl: string | null;
  receiptUrl: string | null;
  deleted: boolean;
}

/** Só existe quando o provedor é o Asaas (assinatura contratada na web). */
interface AsaasBlock {
  providerSubscriptionId: string | null;
  billingCycle: string | null;
  billingType: string | null;
  priceCents: number | null;
  nextDueDate: string | null;
  graceDays: number;
  environment: 'sandbox' | 'production';
  /** Do documento só o tipo e o final: é o que a API guarda. */
  customer: { providerCustomerId: string; name: string; email: string | null; documentType: string; documentHint: string; updatedAt: string } | null;
  payments: AsaasPayment[];
}

interface SubscriptionEvent {
  id: string;
  provider: string;
  eventType: string | null;
  attempts: number;
  notificationId: string;
  notificationType: number | null;
  notificationLabel: string | null;
  receivedAt: string;
  processedAt: string | null;
  processError: string | null;
  retryable: boolean;
}

interface SubscriptionDetail {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceDeletedAt: string | null;
  purchaserUserId: string | null;
  purchaserEmail: string | null;
  purchaserName: string | null;
  planKey: string;
  provider: string;
  state: string;
  autoRenewing: boolean;
  acknowledged: boolean;
  startedAt: string | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  canceledAt: string | null;
  cancelReason: string | null;
  /** Só a assinatura viva da empresa pode ser reconsultada no provedor. */
  refreshable: boolean;
  asaas: AsaasBlock | null;
  hasLinkedToken: boolean;
  supersededBy: string | null;
  supersedes: Array<{ id: string; state: string; createdAt: string }>;
  latestNotificationType: number | null;
  latestNotificationLabel: string | null;
  lastVerifiedAt: string;
  productId: string | null;
  basePlanId: string | null;
  offerId: string | null;
  raw: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  events: SubscriptionEvent[];
  audit: Array<{ id: string; action: string; metadata: Record<string, unknown>; actorEmail: string | null; at: string }>;
}

const CANCEL_REASON: Record<string, string> = {
  usuario: 'cancelada pelo proprietário na web',
  pendente_sem_pagamento: 'nunca foi paga; cancelada pela reconciliação',
  suspensa_sem_pagamento: 'suspensa por muito tempo; cancelada pela reconciliação',
};

export function SubscriptionDetailPage() {
  const { subscriptionId = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const queryKey = ['subscription', subscriptionId];
  const query = useQuery({ queryKey, queryFn: () => api.get<SubscriptionDetail>(`/billing/subscriptions/${subscriptionId}`) });
  const sub = query.data;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: ['billing'] });
  };

  const refresh = useMutation({
    mutationFn: () => api.post<{ from: string; to: string }>(`/billing/subscriptions/${subscriptionId}/refresh`),
    onSuccess: (result) => {
      toast.push(result.from === result.to ? `Reconsultada: continua ${SUBSCRIPTION_STATE[result.to]?.label ?? result.to}.` : `Estado atualizado: ${SUBSCRIPTION_STATE[result.from]?.label} → ${SUBSCRIPTION_STATE[result.to]?.label}.`, 'success');
      invalidate();
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const retry = useMutation({
    mutationFn: (eventId: string) => api.post<{ outcome: string; error: string | null }>(`/billing/events/${eventId}/retry`),
    onSuccess: (result) => {
      toast.push(result.outcome === 'processed' ? 'Notificação processada.' : `Continua pendente: ${result.error}`, result.outcome === 'processed' ? 'success' : 'error');
      invalidate();
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  if (query.isLoading) return <div className="page"><Skeleton lines={8} /></div>;
  if (!sub) return <div className="page"><Notice tone="error">Assinatura não encontrada.</Notice></div>;

  const state = SUBSCRIPTION_STATE[sub.state];
  const isAsaas = sub.provider === 'asaas';
  const asaas = sub.asaas;
  // Nome do provedor nos textos: o botão e os avisos nunca dizem "Google" numa assinatura da web.
  const providerName = isAsaas ? 'Asaas' : 'Google';
  const hint = subscriptionHint(sub.state, sub.provider);
  const stale = Date.now() - new Date(sub.lastVerifiedAt).getTime() > 48 * 3_600_000 && ['ativa', 'carencia', 'cancelada_mas_ativa'].includes(sub.state);
  // Confirmação (acknowledge) é regra do Google Play; no Asaas não existe.
  const unacknowledged = !isAsaas && !sub.acknowledged && ['ativa', 'pendente'].includes(sub.state);
  const planDetail = isAsaas
    ? [asaas?.billingCycle ? BILLING_CYCLE[asaas.billingCycle] ?? asaas.billingCycle : null, 'web'].filter(Boolean).join(' · ')
    : `${sub.productId ?? '—'}${sub.basePlanId ? ` / ${sub.basePlanId}` : ''}${sub.offerId ? ` / oferta ${sub.offerId}` : ''}`;

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: 'Assinaturas', to: '/assinaturas' }, { label: sub.workspaceName }]}
        title={<span className="row">{sub.workspaceName} <Badge tone={state?.tone}>{state?.label ?? sub.state}</Badge> <ProviderBadge provider={sub.provider} /></span>}
        subtitle={<span className="row">{PLAN_LABEL[sub.planKey] ?? sub.planKey} · <CopyId id={sub.id} /></span>}
        actions={
          can('support') && sub.refreshable && (
            <button type="button" className="btn btn--secondary" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              <Icon name="refresh" /> {refresh.isPending ? 'Consultando…' : `Reconsultar no ${providerName}`}
            </button>
          )
        }
      />

      {hint && <Notice tone={state?.tone === 'error' ? 'error' : state?.tone === 'warning' ? 'warning' : 'info'}>{hint}</Notice>}
      {stale && <Notice tone="warning" title="Sem verificação há mais de 48 horas">O estado pode estar desatualizado se uma notificação se perdeu. Reconsultar no {providerName} resolve.</Notice>}
      {unacknowledged && <Notice tone="error" title="Compra não confirmada (acknowledge)">O Google reembolsa automaticamente compras não confirmadas em três dias. A reconciliação tenta confirmar de novo; reconsultar agora força a tentativa.</Notice>}
      {!sub.refreshable && can('support') && (
        <Notice tone="info">Assinatura encerrada: não há o que reconsultar no provedor. Se a empresa tem uma assinatura viva, ela aparece em <Link to={`/empresas/${sub.workspaceId}`}>empresa</Link>.</Notice>
      )}

      <div className="grid grid--2">
        <Card title="Assinatura">
          <KeyValue
            items={[
              { label: 'Estado', value: <Badge tone={state?.tone}>{state?.label ?? sub.state}</Badge> },
              { label: 'Origem', value: <ProviderBadge provider={sub.provider} /> },
              { label: 'Plano', value: `${PLAN_LABEL[sub.planKey] ?? sub.planKey} (${planDetail})` },
              { label: 'Renovação automática', value: sub.autoRenewing ? 'ligada' : 'desligada' },
              ...(isAsaas ? [] : [{ label: 'Confirmada (ack)', value: sub.acknowledged ? 'sim' : <Badge tone="error">não</Badge> }]),
              { label: 'Início', value: <Time value={sub.startedAt} relative={false} /> },
              { label: 'Fim do período', value: <Time value={sub.currentPeriodEnd} relative={false} /> },
              { label: 'Carência até', value: <Time value={sub.graceUntil} relative={false} /> },
              { label: 'Cancelada em', value: sub.canceledAt ? <><Time value={sub.canceledAt} relative={false} />{sub.cancelReason && ` · ${CANCEL_REASON[sub.cancelReason] ?? sub.cancelReason}`}</> : '—' },
              { label: 'Última verificação', value: <Time value={sub.lastVerifiedAt} relative={false} /> },
              ...(isAsaas ? [] : [{ label: 'Última notificação', value: sub.latestNotificationLabel ?? '—' }]),
              { label: isAsaas ? 'Contratada em' : 'Vinculada em', value: <Time value={sub.createdAt} relative={false} /> },
            ]}
          />
        </Card>
        <Card title={isAsaas ? 'Empresa e contratante' : 'Empresa e comprador'}>
          <KeyValue
            items={[
              { label: 'Empresa', value: <><Link to={`/empresas/${sub.workspaceId}`}>{sub.workspaceName}</Link>{sub.workspaceDeletedAt && <Badge tone="error"> excluída</Badge>}</> },
              { label: isAsaas ? 'Contratada por' : 'Comprador', value: sub.purchaserEmail ? <Link to={`/usuarios/${sub.purchaserUserId}`}>{sub.purchaserName} ({sub.purchaserEmail})</Link> : <span className="muted">conta removida</span> },
              ...(isAsaas ? [] : [{ label: 'Cadeia de compras', value: sub.hasLinkedToken ? 'substituiu uma compra anterior' : 'compra original' }]),
              { label: 'Substituída por', value: sub.supersededBy ? <Link to={`/assinaturas/${sub.supersededBy}`}>ver assinatura seguinte</Link> : '—' },
              { label: 'Substitui', value: sub.supersedes.length > 0 ? sub.supersedes.map((item) => <div key={item.id}><Link to={`/assinaturas/${item.id}`}>{SUBSCRIPTION_STATE[item.state]?.label ?? item.state}</Link> · <Time value={item.createdAt} /></div>) : '—' },
            ]}
          />
          <div style={{ marginTop: 12 }}>
            <Details summary={isAsaas ? 'Resposta do Asaas (campos da assinatura, sem dados de pagamento)' : 'Resposta do Google (sem tokens)'}>
              <Json value={sub.raw} />
            </Details>
          </div>
        </Card>
      </div>

      {asaas && (
        <>
          <div className="grid grid--2">
            <Card title="Cobrança pela web" subtitle={`Asaas${asaas.environment === 'sandbox' ? ' · sandbox (cobranças de teste)' : ''}`}>
              <KeyValue
                items={[
                  { label: 'Ciclo', value: asaas.billingCycle ? BILLING_CYCLE[asaas.billingCycle] ?? asaas.billingCycle : '—' },
                  { label: 'Forma de pagamento', value: asaas.billingType ? BILLING_TYPE[asaas.billingType] ?? asaas.billingType : '—' },
                  { label: 'Valor contratado', value: asaas.priceCents !== null ? `${fmtCents(asaas.priceCents)} / ${asaas.billingCycle === 'YEARLY' ? 'ano' : 'mês'}` : '—' },
                  { label: 'Próximo vencimento', value: fmtDay(asaas.nextDueDate) },
                  { label: 'Carência', value: sub.graceUntil ? <>até <Time value={sub.graceUntil} relative={false} /> ({asaas.graceDays} dias após o vencimento)</> : `${asaas.graceDays} dias após o vencimento, se atrasar` },
                  { label: 'Assinatura no Asaas', value: asaas.providerSubscriptionId ? <CopyId id={asaas.providerSubscriptionId} /> : '—' },
                ]}
              />
              <p className="caption" style={{ marginTop: 12 }}>O valor contratado não muda quando o preço do plano é alterado; o preço novo vale para contratações seguintes.</p>
            </Card>
            <Card title="Pagador" subtitle="Cadastro no Asaas, um por empresa">
              {asaas.customer ? (
                <KeyValue
                  items={[
                    { label: 'Nome', value: asaas.customer.name },
                    { label: 'E-mail', value: asaas.customer.email ?? <span className="muted">não informado</span> },
                    { label: 'Documento', value: <span title="A API guarda só o tipo e o final do documento; o número inteiro fica no Asaas.">{asaas.customer.documentType} {asaas.customer.documentHint}</span> },
                    { label: 'Cliente no Asaas', value: <CopyId id={asaas.customer.providerCustomerId} /> },
                    { label: 'Atualizado', value: <Time value={asaas.customer.updatedAt} /> },
                  ]}
                />
              ) : (
                <Empty icon="users" title="Pagador não registrado" />
              )}
            </Card>
          </div>

          <Card title="Cobranças" subtitle="Espelho do que o Asaas informa, atualizado a cada consulta; a fonte da verdade é o provedor" flush>
            {asaas.payments.length === 0 ? (
              <Empty icon="card" title="Nenhuma cobrança registrada" />
            ) : (
              <div className="table-wrap">
                <table className="table table--compact">
                  <thead>
                    <tr><th>Vencimento</th><th>Situação</th><th className="num">Valor</th><th className="num">Líquido</th><th>Forma</th><th>Pago em</th><th>Fatura</th><th>Comprovante</th></tr>
                  </thead>
                  <tbody>
                    {asaas.payments.map((payment) => (
                      <tr key={payment.id}>
                        <td className="nowrap">{fmtDay(payment.dueDate)}</td>
                        <td>
                          <Badge tone={PAYMENT_STATUS[payment.status]?.tone ?? 'neutral'}>{PAYMENT_STATUS[payment.status]?.label ?? payment.status}</Badge>
                          {payment.deleted && <Badge tone="neutral" plain> removida</Badge>}
                          <div className="cell-sub mono">{payment.providerPaymentId}</div>
                        </td>
                        <td className="num money">{fmtCents(payment.valueCents)}</td>
                        <td className="num money muted">{fmtCents(payment.netValueCents)}</td>
                        <td>{payment.billingType ? BILLING_TYPE[payment.billingType] ?? payment.billingType : '—'}</td>
                        <td><Time value={payment.paidAt} relative={false} /></td>
                        <td><ExternalLink href={payment.invoiceUrl}>abrir fatura</ExternalLink></td>
                        <td><ExternalLink href={payment.receiptUrl}>comprovante</ExternalLink></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <div className="grid grid--2">
        <Card title={isAsaas ? 'Eventos do Asaas' : 'Notificações do Google'} subtitle={isAsaas ? 'Webhooks recebidos para esta assinatura' : 'RTDN recebidas para este comprovante'}>
          {sub.events.length === 0 ? (
            <Empty icon="mail" title="Nenhuma notificação recebida" />
          ) : (
            <div className="list">
              {sub.events.map((event) => (
                <div key={event.id} className="list__item">
                  <div className="list__main">
                    <div className="list__title">
                      {event.provider === 'asaas' ? (
                        <>{ASAAS_EVENT[event.eventType ?? ''] ?? event.eventType ?? 'desconhecido'} <code className="small">{event.eventType}</code></>
                      ) : (
                        <code>{event.notificationLabel ?? event.notificationType ?? 'desconhecido'}</code>
                      )}
                    </div>
                    <div className="list__sub">
                      recebida <Time value={event.receivedAt} relative={false} />
                      {event.processedAt ? <> · processada <Time value={event.processedAt} /></> : ' · pendente'}
                      {event.attempts > 0 && ` · ${event.attempts} tentativa(s)`}
                      {event.processError && <span style={{ color: 'var(--error)' }}> · {event.processError}</span>}
                    </div>
                  </div>
                  {!event.processedAt && <Badge tone="warning">pendente</Badge>}
                  {can('support') && event.retryable && (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => retry.mutate(event.id)} disabled={retry.isPending}>Reprocessar</button>
                  )}
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
