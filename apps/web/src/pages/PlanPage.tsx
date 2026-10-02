import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { api, ApiError, errorMessage } from '../api/client';
import type { BillingOverview, CheckoutResult, PaymentView, SubscriptionState } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { Badge, Card, ConfirmDialog, Field, KeyValue, Meter, Modal, Notice, PageHeader, QueryState, useToast } from '../components/ui';
import { track } from '../lib/analytics';
import { fmtCents, fmtDate, fmtInteger } from '../lib/format';
import { BILLING_TYPE, PAYMENT_STATUS, SUBSCRIPTION_STATE, type Tone } from '../lib/labels';
import { useCurrentWorkspace } from '../workspace/WorkspaceProvider';

import '../styles/pages-company.css';

type Cycle = 'MONTHLY' | 'YEARLY';
type BillingMethod = 'UNDEFINED' | 'PIX' | 'BOLETO' | 'CREDIT_CARD';
type Subscription = NonNullable<BillingOverview['subscription']>;

const CYCLE_LABEL: Record<string, string> = { MONTHLY: 'Mensal', YEARLY: 'Anual' };
const CYCLE_UNIT: Record<string, string> = { MONTHLY: 'por mês', YEARLY: 'por ano' };
const PROVIDER_LABEL: Record<string, string> = { asaas: 'Pela web', google_play: 'Google Play' };

const METHODS: Array<{ key: BillingMethod; label: string; hint: string }> = [
  { key: 'PIX', label: 'Pix', hint: 'QR Code ou copia e cola na página da fatura.' },
  { key: 'BOLETO', label: 'Boleto', hint: 'A confirmação pode levar alguns dias úteis.' },
  { key: 'CREDIT_CARD', label: 'Cartão de crédito', hint: 'Digitado na página segura do Asaas.' },
  { key: 'UNDEFINED', label: 'Escolher na fatura', hint: 'Você decide na hora de pagar.' },
];

const onlyDigits = (value: string): string => value.replace(/\D+/g, '');

/** CPF (000.000.000-00) até 11 dígitos; a partir do 12º vira CNPJ (00.000.000/0000-00). */
function maskDocument(value: string): string {
  const d = onlyDigits(value).slice(0, 14);
  if (d.length <= 11) {
    const groups = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9)].filter(Boolean).join('.');
    return d.length > 9 ? `${groups}-${d.slice(9)}` : groups;
  }
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}${d.length > 12 ? `-${d.slice(12)}` : ''}`;
}

/** (11) 91234-5678 ou (11) 3456-7890. */
function maskPhone(value: string): string {
  const d = onlyDigits(value).slice(0, 11);
  if (d.length <= 2) return d;
  const rest = d.slice(2);
  const split = rest.length > 8 ? 5 : 4;
  return `(${d.slice(0, 2)}) ${rest.length > split ? `${rest.slice(0, split)}-${rest.slice(split)}` : rest}`;
}

/** A URL da fatura vem do provedor; só `http(s)` vira link ou destino de aba. */
function safeUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

const paymentStatus = (status: string): { label: string; tone: Tone } => PAYMENT_STATUS[status] ?? { label: status, tone: 'neutral' };
const subscriptionState = (state: string): { label: string; tone: Tone } =>
  (SUBSCRIPTION_STATE as Record<string, { label: string; tone: Tone }>)[state] ?? { label: state, tone: 'neutral' };

/**
 * Plano e assinatura da empresa. É a tela onde a pessoa decide pagar, então
 * tudo o que aparece vem da API: preço, limites, estado e cobranças. O
 * pagamento acontece na página do Asaas (fatura hospedada) — esta aplicação
 * nunca vê dados de cartão. Assinatura feita no Google Play aparece só para
 * consulta: quem gerencia é a Play Store.
 */
export function PlanPage() {
  const { workspace, workspaceId, base, can, entitlement, isPaid, refresh } = useCurrentWorkspace();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();

  const canView = can('assinatura.ver');
  const canManage = can('assinatura.gerenciar');

  const overview = useQuery({
    queryKey: ['billing', workspaceId],
    queryFn: () => api.get<BillingOverview>(`${base}/billing/web`),
    enabled: canView,
    // Enquanto a fatura não é paga, a tela confere sozinha a cada 10 s — só
    // com a aba visível. É a leitura comum (barata); reconsultar o provedor
    // fica para o botão "Já paguei", que a API limita por minuto.
    refetchInterval: (query) => (query.state.data?.subscription?.state === 'pendente' ? 10_000 : false),
    refetchIntervalInBackground: false,
  });

  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  /** Fatura recém-criada cuja aba o navegador não deixou abrir. */
  const [blockedInvoice, setBlockedInvoice] = useState<string | null>(null);

  const data = overview.data;
  const sub = data?.subscription ?? null;
  const byGoogle = sub !== null && (sub.managedBy === 'google_play' || sub.provider === 'google_play');
  const openPayment = data?.openPayment ?? null;
  const state: SubscriptionState = sub?.state ?? entitlement?.state ?? 'sem_assinatura';

  // Assinatura mudou de estado (pagamento confirmado, atraso, fim): o plano
  // em vigor mudou junto, e o resto da aplicação precisa saber.
  const seen = useRef<{ workspaceId: string; state: string | null } | null>(null);
  useEffect(() => {
    if (!data) return;
    const current = data.subscription?.state ?? null;
    const previous = seen.current;
    seen.current = { workspaceId, state: current };
    if (previous && previous.workspaceId === workspaceId && previous.state !== current) void refresh();
  }, [data, workspaceId, refresh]);

  const tracked = useRef(false);
  useEffect(() => {
    if (tracked.current || !entitlement) return;
    tracked.current = true;
    if (!entitlement.active) track('paywall.viewed', { trigger: 'web_plan' });
  }, [entitlement]);

  const afterChange = async (fresh?: BillingOverview) => {
    if (fresh) queryClient.setQueryData(['billing', workspaceId], fresh);
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['billing', workspaceId] }), refresh()]);
  };

  // Reconsulta o provedor. Vale para quem pagou e não quer esperar o aviso
  // automático, e para a volta da página de pagamento.
  const sync = useMutation({
    mutationFn: () => api.post<BillingOverview>(`${base}/billing/web/refresh`),
    onSuccess: async (fresh) => {
      await afterChange(fresh);
      const now = fresh.subscription?.state;
      if (now === 'ativa') {
        setBlockedInvoice(null);
        toast.success('Pagamento confirmado. O plano Equipe está ativo.');
      } else if (now === 'pendente') {
        toast.push('Ainda não recebemos a confirmação do pagamento. Esta página atualiza sozinha quando ela chegar.');
      } else {
        toast.push('Situação da assinatura atualizada.');
      }
    },
    onError: (error) => toast.error(error),
  });

  // Volta da página de pagamento (`?pagamento=concluido`): reconsulta uma vez
  // e limpa o endereço, para um recarregar não repetir a chamada.
  const returned = useRef(false);
  useEffect(() => {
    if (params.get('pagamento') !== 'concluido' || returned.current) return;
    returned.current = true;
    if (canView) sync.mutate();
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('pagamento');
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const cancel = async () => {
    const fresh = await api.post<BillingOverview>(`${base}/billing/web/cancel`);
    setBlockedInvoice(null);
    await afterChange(fresh);
    const now = fresh.subscription?.state;
    toast.push(
      now === 'cancelada_mas_ativa'
        ? `Renovação cancelada. O plano Equipe vale até ${fmtDate(fresh.subscription?.currentPeriodEnd)}.`
        : 'Assinatura cancelada. A empresa está no plano gratuito.',
    );
  };

  const onCheckoutDone = async (result: CheckoutResult, opened: boolean) => {
    setCheckoutOpen(false);
    const url = safeUrl(result.payment?.invoiceUrl);
    setBlockedInvoice(!opened && url ? url : null);
    await afterChange();
    if (!result.payment) toast.success('Assinatura registrada. A primeira cobrança aparece aqui quando for gerada.');
    else if (opened) toast.push('A fatura abriu em outra aba. Depois de pagar, volte para esta página.');
  };

  const checkoutAvailable = data?.checkoutAvailable ?? false;
  // A API aceita nova contratação sem assinatura viva ou com a renovação já
  // cancelada (a nova começa a cobrar quando o período pago acabar).
  const canSubscribe = canManage && checkoutAvailable && !byGoogle && (sub === null || sub.state === 'cancelada_mas_ativa');
  // Antes de pagar ainda dá para trocar ciclo ou forma de pagamento: a API cancela a pendente e cria outra.
  const canChangePending = canManage && checkoutAvailable && !byGoogle && sub?.state === 'pendente';
  const canCancel = canManage && sub !== null && !byGoogle && sub.state !== 'cancelada_mas_ativa';
  // Assinatura anterior que terminou, quando não há nenhuma viva.
  const lastEnded = data && !sub ? data.history[0] : undefined;

  const productLimit = entitlement?.limits.products ?? null;
  const memberLimit = entitlement?.limits.members ?? null;
  const onFreePlan = entitlement ? entitlement.planKey === 'gratuito' : !isPaid;

  const details: Array<{ label: string; value: ReactNode }> = [];
  if (sub) {
    details.push({ label: 'Assinatura', value: byGoogle ? 'Google Play' : (PROVIDER_LABEL[sub.provider] ?? sub.provider) });
    if (sub.priceCents !== null) {
      details.push({ label: 'Valor', value: `${fmtCents(sub.priceCents)}${sub.billingCycle ? ` ${CYCLE_UNIT[sub.billingCycle] ?? ''}` : ''}` });
    } else if (sub.billingCycle) {
      details.push({ label: 'Ciclo', value: CYCLE_LABEL[sub.billingCycle] ?? sub.billingCycle });
    }
    if (sub.billingType) details.push({ label: 'Forma de pagamento', value: BILLING_TYPE[sub.billingType] ?? sub.billingType });
    if (sub.startedAt) details.push({ label: 'Assinante desde', value: fmtDate(sub.startedAt) });
    if (sub.currentPeriodEnd) details.push({ label: sub.state === 'cancelada_mas_ativa' ? 'Plano ativo até' : 'Período pago até', value: fmtDate(sub.currentPeriodEnd) });
    if (sub.state === 'carencia' && sub.graceUntil) details.push({ label: 'Acesso da equipe mantido até', value: fmtDate(sub.graceUntil) });
    if (sub.autoRenewing && sub.nextDueDate && sub.state !== 'suspensa') details.push({ label: 'Próximo vencimento', value: fmtDate(sub.nextDueDate) });
    if (sub.canceledAt) details.push({ label: 'Renovação cancelada em', value: fmtDate(sub.canceledAt) });
    if (data?.customer && !byGoogle) {
      details.push({ label: 'Pagador', value: `${data.customer.name} · ${data.customer.documentType} ${data.customer.documentHint}` });
    }
  }

  const loadingOverview = canView && (overview.isLoading || (overview.error !== null && !data));

  return (
    <div className="page">
      <PageHeader title="Plano" subtitle={`Assinatura de ${workspace.name}. O plano é da empresa: vale para todas as pessoas da equipe.`} />

      {!canManage && (
        <Notice tone="info">
          {canView
            ? 'Só o proprietário da empresa gerencia o plano. Você pode acompanhar a situação por aqui.'
            : 'Só o proprietário da empresa gerencia o plano, e o seu papel não mostra os detalhes da assinatura.'}
        </Notice>
      )}

      {blockedInvoice && (
        <Notice
          tone="warning"
          title="O navegador bloqueou a abertura da fatura"
          action={
            <a className="btn btn--primary btn--sm" href={blockedInvoice} target="_blank" rel="noopener noreferrer" onClick={() => setBlockedInvoice(null)}>
              <Icon name="external" size={15} /> Abrir fatura
            </a>
          }
        >
          A assinatura foi registrada. Abra a fatura por este botão para pagar.
        </Notice>
      )}

      <Card>
        <div className="plan-current">
          <div className="stack">
            <div>
              <div className="caption">Plano atual</div>
              <div className="row row--wrap" style={{ marginTop: 4 }}>
                <span className="plan-current__name">{entitlement ? (isPaid ? 'Equipe' : 'Gratuito') : '—'}</span>
                {state !== 'sem_assinatura' && <Badge tone={subscriptionState(state).tone}>{subscriptionState(state).label}</Badge>}
              </div>
              {entitlement && (
                <p className="muted" style={{ marginTop: 6, fontSize: 'var(--fs-supporting)' }}>
                  {isPaid
                    ? 'Equipe liberada, com o mesmo estoque para todas as pessoas, no celular e no computador.'
                    : 'Estoque na nuvem para o proprietário, no celular e no computador.'}
                </p>
              )}
            </div>
            {details.length > 0 && <KeyValue items={details} />}
            {(canCancel || canChangePending) && (
              <div className="row row--wrap">
                {canChangePending && (
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => setCheckoutOpen(true)}>
                    Trocar ciclo ou forma de pagamento
                  </button>
                )}
                {canCancel && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCancelOpen(true)}>
                    {sub?.state === 'pendente' ? 'Cancelar pedido' : 'Cancelar assinatura'}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="plan-usage">
            <div>
              <div className="plan-usage__row">
                <span>Produtos na nuvem</span>
                <strong>{entitlement ? (productLimit !== null ? `${fmtInteger(entitlement.usage.products)} de ${fmtInteger(productLimit)}` : fmtInteger(entitlement.usage.products)) : '—'}</strong>
              </div>
              {entitlement && productLimit !== null ? <Meter value={entitlement.usage.products} max={productLimit} /> : <div className="caption" style={{ marginTop: 4 }}>{entitlement ? 'Sem limite neste plano' : ''}</div>}
            </div>
            <div>
              <div className="plan-usage__row">
                <span>Pessoas na empresa</span>
                <strong>{entitlement ? (memberLimit !== null && memberLimit > 0 ? `${fmtInteger(entitlement.usage.members)} de ${fmtInteger(memberLimit)}` : fmtInteger(entitlement.usage.members)) : '—'}</strong>
              </div>
              {entitlement && memberLimit !== null && memberLimit > 0 ? (
                <Meter value={entitlement.usage.members} max={memberLimit} />
              ) : (
                <div className="caption" style={{ marginTop: 4 }}>
                  {!entitlement ? '' : memberLimit === null ? 'Sem limite neste plano' : 'No plano gratuito, só o proprietário usa a nuvem'}
                </div>
              )}
            </div>
          </div>
        </div>
      </Card>

      {loadingOverview ? (
        <Card flush>
          <QueryState loading={overview.isLoading} error={overview.error} onRetry={() => void overview.refetch()} />
        </Card>
      ) : (
        <>
          {sub && (
            <StateNotice
              sub={sub}
              byGoogle={byGoogle}
              hasOpenPayment={openPayment !== null}
              canManage={canManage}
              refreshing={sync.isPending}
              onRefresh={() => sync.mutate()}
            />
          )}

          {lastEnded && (lastEnded.state === 'expirada' || lastEnded.state === 'reembolsada') && (
            <Notice tone="info" title={lastEnded.state === 'reembolsada' ? 'O último pagamento foi estornado' : 'A assinatura anterior terminou'}>
              {lastEnded.state === 'reembolsada'
                ? 'Com o estorno, a empresa voltou ao plano gratuito.'
                : `O plano Equipe ${lastEnded.currentPeriodEnd ? `valeu até ${fmtDate(lastEnded.currentPeriodEnd)}` : 'foi encerrado'} e a empresa voltou ao plano gratuito.`}{' '}
              Nada foi apagado: produtos, histórico e equipe continuam guardados.
              {canSubscribe ? ' Você pode assinar de novo quando quiser.' : ''}
            </Notice>
          )}

          {sub && !byGoogle && openPayment && (
            <PaymentPanel payment={openPayment} sub={sub} refreshing={sync.isPending} onRefresh={() => sync.mutate()} />
          )}

          {data && !data.checkoutAvailable && !sub && (
            <Notice tone="info" title="A assinatura pela web ainda não está disponível">
              Por enquanto, o plano Equipe é assinado no aplicativo Android, pelo Google Play. A assinatura é da empresa: depois de assinar
              no celular, o plano vale também aqui, no navegador e no web app.
            </Notice>
          )}

          <PlanComparison
            pricing={data && data.checkoutAvailable ? data.pricing : null}
            current={entitlement ? (isPaid ? 'paid' : 'free') : null}
            freeProductLimit={onFreePlan ? productLimit : undefined}
            freeAnalysis={onFreePlan ? (entitlement?.features['analise.avancada']?.enabled ?? false) : false}
            paidProductLimit={!onFreePlan ? productLimit : null}
            action={
              canSubscribe ? (
                <button type="button" className="btn btn--primary btn--lg btn--block" onClick={() => setCheckoutOpen(true)}>
                  {sub?.state === 'cancelada_mas_ativa' ? 'Assinar de novo' : 'Assinar o plano Equipe'}
                </button>
              ) : isPaid ? (
                <p className="caption">Este é o plano da empresa hoje.</p>
              ) : sub?.state === 'pendente' ? (
                <p className="caption">Seu pedido está aguardando o pagamento da fatura.</p>
              ) : !canManage ? (
                <p className="caption">Só o proprietário da empresa pode assinar.</p>
              ) : data && !data.checkoutAvailable ? (
                <p className="caption">Assine pelo aplicativo Android (Google Play).</p>
              ) : null
            }
          />

          {data && data.payments.length > 0 && <PaymentsCard payments={data.payments} />}
          {data && data.history.length > 0 && <HistoryCard history={data.history} />}
        </>
      )}

      {data && (
        <CheckoutDialog open={checkoutOpen} overview={data} onClose={() => setCheckoutOpen(false)} onDone={(result, opened) => void onCheckoutDone(result, opened)} />
      )}

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={sub?.state === 'pendente' ? 'Cancelar o pedido?' : 'Cancelar a assinatura?'}
        confirmLabel={sub?.state === 'pendente' ? 'Cancelar pedido' : 'Cancelar assinatura'}
        danger
        onConfirm={cancel}
      >
        {sub?.state === 'pendente' ? (
          <ul className="plain-list">
            <li>O pedido é cancelado e a fatura em aberto deixa de valer.</li>
            <li>A empresa continua no plano gratuito. Você pode assinar de novo quando quiser.</li>
          </ul>
        ) : (
          <ul className="plain-list">
            {sub?.state === 'ativa' && sub.currentPeriodEnd ? (
              <li>
                O plano Equipe continua valendo até <strong>{fmtDate(sub.currentPeriodEnd)}</strong>, fim do período já pago. Não são geradas novas cobranças.
              </li>
            ) : sub?.state === 'suspensa' ? (
              <li>A assinatura é encerrada agora e a fatura em aberto deixa de valer. A empresa já está no plano gratuito e continua nele.</li>
            ) : (
              <li>Não há período pago em vigor: a assinatura é encerrada agora, a fatura em aberto deixa de valer e a empresa volta ao plano gratuito.</li>
            )}
            <li>No plano gratuito, só o proprietário acessa o estoque na nuvem. As outras pessoas da equipe ficam sem acesso.</li>
            <li>Nada é apagado: produtos, histórico e equipe continuam guardados, e você pode assinar de novo quando quiser.</li>
          </ul>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** O que cada estado da assinatura significa para a pessoa e o que ela pode fazer. */
function StateNotice({
  sub,
  byGoogle,
  hasOpenPayment,
  canManage,
  refreshing,
  onRefresh,
}: {
  sub: Subscription;
  byGoogle: boolean;
  hasOpenPayment: boolean;
  canManage: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (byGoogle) {
    const trouble = sub.state === 'carencia' || sub.state === 'suspensa' || sub.state === 'pendente';
    return (
      <Notice tone={trouble ? 'warning' : 'info'} title="Assinatura feita pelo Google Play">
        {sub.state === 'carencia' && 'O Google não conseguiu cobrar a renovação. '}
        {sub.state === 'suspensa' && 'O pagamento não foi identificado e a empresa está no plano gratuito até ele ser regularizado. '}
        {sub.state === 'pendente' && 'A compra ainda não foi concluída no Google Play. '}
        {sub.state === 'cancelada_mas_ativa' && `A renovação foi cancelada; o plano vale até ${fmtDate(sub.currentPeriodEnd)}. `}
        Para trocar a forma de pagamento, renovar ou cancelar, abra a Play Store no celular, em Pagamentos e assinaturas, ou use o
        aplicativo Estoque Simples no Android. Por aqui a assinatura aparece só para consulta.
      </Notice>
    );
  }

  const refreshButton = (
    <button type="button" className="btn btn--secondary btn--sm" onClick={onRefresh} disabled={refreshing}>
      {refreshing ? 'Atualizando…' : 'Atualizar'}
    </button>
  );

  switch (sub.state) {
    case 'pendente':
      return (
        <Notice tone="warning" title="Falta só o pagamento" action={hasOpenPayment ? undefined : refreshButton}>
          {hasOpenPayment
            ? 'O plano Equipe é liberado assim que o pagamento da fatura for confirmado. Esta página atualiza sozinha.'
            : 'O pedido foi registrado, mas a fatura ainda não apareceu por aqui. Atualize em alguns instantes.'}
        </Notice>
      );
    case 'carencia':
      return (
        <Notice tone="warning" title="Pagamento em atraso" action={hasOpenPayment ? undefined : refreshButton}>
          A última cobrança não foi paga. {sub.graceUntil ? `A equipe continua com acesso até ${fmtDate(sub.graceUntil)}; ` : ''}
          depois disso a empresa volta ao plano gratuito até a fatura ser paga. Nada é apagado.
        </Notice>
      );
    case 'suspensa':
      return (
        <Notice
          tone="error"
          title="Plano Equipe suspenso"
          action={hasOpenPayment ? undefined : <Link to="/app/suporte" className="btn btn--secondary btn--sm">Falar com o suporte</Link>}
        >
          {hasOpenPayment
            ? 'O pagamento não foi identificado e a empresa voltou ao plano gratuito. Nada foi apagado: pague a fatura em aberto para reativar.'
            : 'O plano está suspenso e a empresa voltou ao plano gratuito. Nada foi apagado. Não há fatura em aberto para pagar; fale com o suporte para regularizar.'}
        </Notice>
      );
    case 'cancelada_mas_ativa':
      return (
        <Notice tone="info" title="Renovação cancelada">
          O plano Equipe continua ativo até {fmtDate(sub.currentPeriodEnd)}. Depois dessa data a empresa volta ao plano gratuito, sem
          apagar nada.{canManage ? ' Se mudar de ideia, dá para assinar de novo: a nova assinatura só começa a ser cobrada no fim do período já pago.' : ''}
        </Notice>
      );
    default:
      return null;
  }
}

/** Cobrança em aberto: valor, vencimento e o caminho para pagar. */
function PaymentPanel({ payment, sub, refreshing, onRefresh }: { payment: PaymentView; sub: Subscription; refreshing: boolean; onRefresh: () => void }) {
  const url = safeUrl(payment.invoiceUrl);
  const late = payment.status === 'OVERDUE' || sub.state === 'carencia' || sub.state === 'suspensa';
  const title = late ? 'Fatura vencida' : sub.state === 'pendente' ? 'Fatura da assinatura' : 'Próxima fatura';
  const status = paymentStatus(payment.status);
  return (
    <section className={`pay-panel ${late ? 'pay-panel--late' : ''}`} aria-label={title}>
      <div style={{ minWidth: 0 }}>
        <div className="row row--wrap" style={{ gap: 8 }}>
          <span className="strong">{title}</span>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <div className="pay-panel__value" style={{ marginTop: 6 }}>{fmtCents(payment.valueCents)}</div>
        <div className="caption" style={{ marginTop: 2 }}>
          {payment.dueDate ? `Vencimento em ${fmtDate(payment.dueDate)}` : 'Sem data de vencimento'}
          {payment.billingType ? ` · ${BILLING_TYPE[payment.billingType] ?? payment.billingType}` : ''}
        </div>
      </div>
      <div className="pay-panel__actions">
        {url ? (
          <a className="btn btn--primary" href={url} target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={16} /> Abrir fatura
          </a>
        ) : (
          <span className="caption">O link da fatura ainda não está disponível.</span>
        )}
        <button type="button" className="btn btn--secondary" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Atualizando…' : 'Já paguei, atualizar'}
        </button>
      </div>
    </section>
  );
}

/**
 * Os dois planos lado a lado. Números (teto de produtos, preços) só aparecem
 * quando a API os informa; sem preço cadastrado ou sem venda pela web, o
 * cartão não inventa valor.
 */
function PlanComparison({
  pricing,
  current,
  freeProductLimit,
  freeAnalysis,
  paidProductLimit,
  action,
}: {
  pricing: BillingOverview['pricing'] | null;
  /** Plano em vigor; `null` enquanto os direitos da empresa não carregaram. */
  current: 'free' | 'paid' | null;
  /** `undefined` = a empresa não está no gratuito, então o teto dele não é conhecido aqui. */
  freeProductLimit: number | null | undefined;
  freeAnalysis: boolean;
  paidProductLimit: number | null;
  action: ReactNode;
}) {
  const monthly = pricing?.monthlyCents ?? null;
  const yearly = pricing?.yearlyCents ?? null;
  const saving = monthly !== null && yearly !== null ? monthly * 12 - yearly : 0;

  return (
    <div className="grid grid--2">
      <section className="card plan-card" aria-label="Plano gratuito">
        <div className="plan-card__head">
          <span className="plan-card__name">Gratuito</span>
          {current === 'free' && <Badge>Plano atual</Badge>}
        </div>
        <div className="plan-card__price">Grátis</div>
        <ul className="check-list">
          <li><Icon name="check" /> Estoque na nuvem para 1 pessoa: quem criou a empresa</li>
          <li>
            <Icon name="check" />{' '}
            {freeProductLimit === undefined ? 'Quantidade limitada de produtos na nuvem' : freeProductLimit === null ? 'Produtos sem limite' : `Até ${fmtInteger(freeProductLimit)} produtos na nuvem`}
          </li>
          <li><Icon name="check" /> Aplicativo Android e navegador com os mesmos dados</li>
          <li className="off"><Icon name="minus" /> Sem equipe: não dá para convidar outras pessoas</li>
          {!freeAnalysis && <li className="off"><Icon name="minus" /> Sem análise avançada</li>}
        </ul>
      </section>

      <section className="card plan-card plan-card--featured" aria-label="Plano Equipe">
        <div className="plan-card__head">
          <span className="plan-card__name">Equipe</span>
          {current === 'paid' && <Badge tone="solid">Plano atual</Badge>}
        </div>
        {monthly !== null ? (
          <div>
            <div className="plan-card__price">
              {fmtCents(monthly)} <small>por mês</small>
            </div>
            {yearly !== null && (
              <div className="caption" style={{ marginTop: 2 }}>
                ou {fmtCents(yearly)} por ano{saving > 0 ? ` (${fmtCents(saving)} a menos que 12 mensalidades)` : ''}
              </div>
            )}
          </div>
        ) : yearly !== null ? (
          <div className="plan-card__price">
            {fmtCents(yearly)} <small>por ano</small>
          </div>
        ) : null}
        <ul className="check-list">
          <li><Icon name="check" /> {paidProductLimit !== null ? `Até ${fmtInteger(paidProductLimit)} produtos na nuvem` : 'Produtos sem limite'}</li>
          <li><Icon name="check" /> Equipe com papéis: administrador, gerente, operador e somente consulta</li>
          <li><Icon name="check" /> Todas as pessoas no mesmo estoque, no celular e no computador</li>
          <li><Icon name="check" /> Análise avançada: giro, previsão de falta e o que repor primeiro</li>
        </ul>
        <div className="plan-card__foot">
          {action}
          {pricing && (monthly !== null || yearly !== null) && current !== 'paid' && (
            <p className="caption">Pagamento por Pix, boleto ou cartão, na página do Asaas. Cancele quando quiser, por aqui mesmo.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function PaymentLinks({ payment }: { payment: PaymentView }) {
  const invoice = safeUrl(payment.invoiceUrl);
  const receipt = safeUrl(payment.receiptUrl);
  if (!invoice && !receipt) return <span className="faint">—</span>;
  return (
    <span className="link-row">
      {invoice && <a href={invoice} target="_blank" rel="noopener noreferrer">Fatura</a>}
      {receipt && <a href={receipt} target="_blank" rel="noopener noreferrer">Recibo</a>}
    </span>
  );
}

function PaymentsCard({ payments }: { payments: PaymentView[] }) {
  return (
    <Card flush title="Cobranças" subtitle="Faturas desta empresa, da mais recente para a mais antiga.">
      <div className="table-wrap hide-mobile">
        <table className="table">
          <thead>
            <tr>
              <th>Vencimento</th>
              <th>Situação</th>
              <th>Pago em</th>
              <th>Forma</th>
              <th className="num">Valor</th>
              <th>Documentos</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((payment) => {
              const status = paymentStatus(payment.status);
              return (
                <tr key={payment.id}>
                  <td className="nowrap">{fmtDate(payment.dueDate)}</td>
                  <td><Badge tone={status.tone}>{status.label}</Badge></td>
                  <td className="nowrap">{payment.paidAt ? fmtDate(payment.paidAt) : <span className="faint">—</span>}</td>
                  <td>{payment.billingType ? (BILLING_TYPE[payment.billingType] ?? payment.billingType) : <span className="faint">—</span>}</td>
                  <td className="num nowrap">{fmtCents(payment.valueCents)}</td>
                  <td><PaymentLinks payment={payment} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="list show-mobile">
        {payments.map((payment) => {
          const status = paymentStatus(payment.status);
          return (
            <div key={payment.id} className="list__item co-row">
              <div className="list__main">
                <div className="list__title num">{fmtCents(payment.valueCents)}</div>
                <div className="list__sub">
                  Vence em {fmtDate(payment.dueDate)}
                  {payment.billingType ? ` · ${BILLING_TYPE[payment.billingType] ?? payment.billingType}` : ''}
                  {payment.paidAt ? ` · pago em ${fmtDate(payment.paidAt)}` : ''}
                </div>
                <div style={{ marginTop: 6, fontSize: 'var(--fs-label)' }}><PaymentLinks payment={payment} /></div>
              </div>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function HistoryCard({ history }: { history: BillingOverview['history'] }) {
  return (
    <Card flush title="Histórico de assinaturas">
      <div className="list">
        {history.map((item) => {
          const status = subscriptionState(item.state);
          const period = [
            item.startedAt ? `início em ${fmtDate(item.startedAt)}` : `pedido em ${fmtDate(item.createdAt)}`,
            item.currentPeriodEnd ? `período pago até ${fmtDate(item.currentPeriodEnd)}` : null,
            item.canceledAt ? `cancelada em ${fmtDate(item.canceledAt)}` : null,
          ].filter(Boolean);
          return (
            <div key={item.id} className="list__item co-row">
              <div className="list__main">
                <div className="list__title">
                  {PROVIDER_LABEL[item.provider] ?? item.provider}
                  {item.billingCycle ? ` · ${CYCLE_LABEL[item.billingCycle] ?? item.billingCycle}` : ''}
                </div>
                <div className="list__sub">{period.join(' · ')}</div>
              </div>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * Contratação: ciclo, forma de pagamento e dados do pagador (o Asaas exige
 * CPF ou CNPJ). A API cria a assinatura e devolve a fatura hospedada, que
 * abre em outra aba.
 */
function CheckoutDialog({
  open,
  overview,
  onClose,
  onDone,
}: {
  open: boolean;
  overview: BillingOverview;
  onClose: () => void;
  onDone: (result: CheckoutResult, opened: boolean) => void;
}) {
  const { base } = useCurrentWorkspace();
  const { user } = useAuth();
  const groupId = useId();
  const { pricing, customer, subscription } = overview;
  const monthly = pricing.monthlyCents;
  const yearly = pricing.yearlyCents;
  const saving = monthly !== null && yearly !== null ? monthly * 12 - yearly : 0;

  const [cycle, setCycle] = useState<Cycle>('MONTHLY');
  const [method, setMethod] = useState<BillingMethod>('PIX');
  const [name, setName] = useState('');
  const [cpfCnpj, setCpfCnpj] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState<{ name?: string; document?: string; phone?: string }>({});

  useEffect(() => {
    if (!open) return;
    // Pedido ainda não pago: parte da escolha anterior, que é o que a pessoa quer trocar.
    const pending = subscription?.state === 'pendente' ? subscription : null;
    const wanted: Cycle = pending?.billingCycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
    setCycle(wanted === 'YEARLY' ? (yearly !== null ? 'YEARLY' : 'MONTHLY') : monthly !== null ? 'MONTHLY' : 'YEARLY');
    setMethod(METHODS.find((item) => item.key === pending?.billingType)?.key ?? 'PIX');
    setName(customer?.name ?? user?.name ?? '');
    setCpfCnpj('');
    setEmail(customer?.email ?? user?.email ?? '');
    setPhone('');
    setBusy(false);
    setError(null);
    setInvalid({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;

    // Conferência só de formato, para avisar na hora. Os dígitos verificadores
    // do documento são validados pela API.
    const digits = onlyDigits(cpfCnpj);
    const phoneDigits = onlyDigits(phone);
    const problems: typeof invalid = {};
    setError(null);
    if (name.trim().length < 3) problems.name = 'Informe o nome completo ou a razão social.';
    if (digits.length !== 11 && digits.length !== 14) problems.document = 'Informe os 11 dígitos do CPF ou os 14 do CNPJ.';
    if (phoneDigits.length > 0 && phoneDigits.length < 10) problems.phone = 'Informe o telefone com DDD.';
    setInvalid(problems);
    if (Object.keys(problems).length > 0) return;

    // A aba da fatura é aberta já no clique, antes da chamada: depois de uma
    // espera de rede o navegador trataria a abertura como pop-up e bloquearia
    // (e com `noopener` o `window.open` não devolve nada que permita saber).
    // Ela nasce em branco, sem vínculo com esta página (`opener = null`), e
    // recebe o endereço da fatura quando a API responde.
    const tab = window.open('', '_blank');
    if (tab) {
      try {
        tab.opener = null;
        tab.document.title = 'Estoque Simples';
        tab.document.body.textContent = 'Abrindo a página de pagamento…';
      } catch {
        // Sem acesso à aba nova: ela só fica em branco até receber o endereço.
      }
    }

    setBusy(true);
    track('purchase.started', { cycle, billingType: method });
    try {
      const result = await api.post<CheckoutResult>(`${base}/billing/web/checkout`, {
        name: name.trim(),
        cpfCnpj: digits,
        cycle,
        billingType: method,
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(phoneDigits ? { mobilePhone: phoneDigits } : {}),
      });
      const url = safeUrl(result.payment?.invoiceUrl);
      if (tab && url) tab.location.replace(url);
      else tab?.close();
      onDone(result, tab !== null && url !== null);
    } catch (caught) {
      tab?.close();
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const apiError = error instanceof ApiError ? error : null;
  const fieldErrors = {
    name: invalid.name ?? apiError?.fieldError('name'),
    document: invalid.document ?? apiError?.fieldError('cpfCnpj'),
    email: apiError?.fieldError('email'),
    phone: invalid.phone ?? apiError?.fieldError('mobilePhone'),
  };
  // Erro que a API atribuiu a um campo aparece no campo; os demais, no aviso do topo.
  const hasFieldError = apiError !== null && ['name', 'cpfCnpj', 'email', 'mobilePhone'].some((field) => apiError.fieldError(field) !== undefined);
  const price = cycle === 'YEARLY' ? yearly : monthly;
  const paidUntil = subscription?.state === 'cancelada_mas_ativa' ? subscription.currentPeriodEnd : null;

  return (
    <Modal open={open} onClose={onClose} title="Assinar o plano Equipe" description="Escolha como quer pagar. A fatura abre em outra aba, na página do Asaas." wide>
      <form className="stack" onSubmit={submit} noValidate>
        {error !== null && !hasFieldError && <Notice tone="error">{errorMessage(error)}</Notice>}
        {paidUntil && (
          <Notice tone="info">
            O período já pago vai até {fmtDate(paidUntil)}. A nova assinatura só começa a ser cobrada nessa data.
          </Notice>
        )}

        <fieldset className="option-list option-list--grid">
          <legend className="field__label">Ciclo de cobrança</legend>
          {monthly !== null && (
            <label className={`option ${cycle === 'MONTHLY' ? 'option--selected' : ''}`}>
              <input type="radio" name={`${groupId}-cycle`} checked={cycle === 'MONTHLY'} onChange={() => setCycle('MONTHLY')} />
              <span className="option__body">
                <span className="option__title">Mensal</span>
                <span className="option__sub">{fmtCents(monthly)} por mês</span>
              </span>
            </label>
          )}
          {yearly !== null && (
            <label className={`option ${cycle === 'YEARLY' ? 'option--selected' : ''}`}>
              <input type="radio" name={`${groupId}-cycle`} checked={cycle === 'YEARLY'} onChange={() => setCycle('YEARLY')} />
              <span className="option__body">
                <span className="option__title">Anual</span>
                <span className="option__sub">{fmtCents(yearly)} por ano</span>
                {saving > 0 && <span className="option__note">{fmtCents(saving)} a menos que 12 mensalidades</span>}
              </span>
            </label>
          )}
        </fieldset>

        <fieldset className="option-list option-list--grid">
          <legend className="field__label">Forma de pagamento</legend>
          {METHODS.map((item) => (
            <label key={item.key} className={`option ${method === item.key ? 'option--selected' : ''}`}>
              <input type="radio" name={`${groupId}-method`} checked={method === item.key} onChange={() => setMethod(item.key)} />
              <span className="option__body">
                <span className="option__title">{item.label}</span>
                <span className="option__sub">{item.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="form-grid">
          <Field label="Nome completo ou razão social" error={fieldErrors.name} full>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoComplete="name" aria-invalid={fieldErrors.name ? true : undefined} />
          </Field>
          <Field
            label="CPF ou CNPJ"
            error={fieldErrors.document}
            hint={customer ? `Da última vez: ${customer.documentType} ${customer.documentHint}. Por segurança, o número não fica guardado aqui; digite de novo.` : 'Exigido para emitir a cobrança.'}
            full
          >
            <input
              className="input num"
              value={cpfCnpj}
              onChange={(event) => setCpfCnpj(maskDocument(event.target.value))}
              inputMode="numeric"
              autoComplete="off"
              placeholder="000.000.000-00"
              aria-invalid={fieldErrors.document ? true : undefined}
            />
          </Field>
          <Field label="E-mail para a fatura" optional error={fieldErrors.email}>
            <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} autoComplete="email" aria-invalid={fieldErrors.email ? true : undefined} />
          </Field>
          <Field label="Celular" optional error={fieldErrors.phone}>
            <input className="input num" value={phone} onChange={(event) => setPhone(maskPhone(event.target.value))} inputMode="tel" autoComplete="tel-national" placeholder="(00) 00000-0000" aria-invalid={fieldErrors.phone ? true : undefined} />
          </Field>
        </div>

        <p className="caption">
          O pagamento é feito na página do Asaas, que processa a cobrança. Dados de cartão não passam pelo Estoque Simples. O plano é
          liberado quando o pagamento for confirmado.
        </p>

        <div className="row row--end" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={busy || price === null}>
            {busy ? 'Gerando fatura…' : price !== null ? `Ir para o pagamento · ${fmtCents(price)}` : 'Ir para o pagamento'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
