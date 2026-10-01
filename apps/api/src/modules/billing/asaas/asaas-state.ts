/**
 * Deriva o estado da assinatura a partir do que o Asaas informa.
 *
 * Função pura de propósito: recebe a assinatura e a lista de cobranças como
 * estão *agora* no provedor e devolve o estado. Como nada aqui depende do
 * evento que disparou a consulta, webhooks duplicados ou fora de ordem
 * convergem todos para o mesmo resultado.
 *
 * Os estados são os mesmos do Google Play (`subscriptions.state`), para que
 * direitos, painel e app não precisem saber de onde a assinatura veio.
 */

export type AsaasCycle = 'MONTHLY' | 'YEARLY';

export interface AsaasSubscriptionSnapshot {
  /** ACTIVE | INACTIVE | EXPIRED. `null` quando o provedor não a conhece mais. */
  status: string | null;
  deleted: boolean;
  cycle: AsaasCycle;
  nextDueDate: string | null;
}

export interface AsaasPaymentSnapshot {
  id: string;
  status: string;
  /** YYYY-MM-DD */
  dueDate: string | null;
  deleted: boolean;
}

export interface DerivedState {
  state: 'pendente' | 'ativa' | 'carencia' | 'suspensa' | 'cancelada_mas_ativa' | 'expirada' | 'reembolsada';
  /** Fim do período já pago. */
  currentPeriodEnd: Date | null;
  /** Até quando o acesso continua com pagamento em atraso. */
  graceUntil: Date | null;
  autoRenewing: boolean;
  /** Cobrança em aberto mais antiga (para o botão "pagar agora"). */
  openPaymentId: string | null;
}

/** Pagamento feito: confirmado (cartão/boleto compensando) ou já recebido. */
const PAID = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'DUNNING_RECEIVED']);
const REFUNDED = new Set(['REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS']);
const DISPUTED = new Set(['CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL']);
const OPEN = new Set(['PENDING', 'OVERDUE', 'AWAITING_RISK_ANALYSIS']);

export function isPaidStatus(status: string): boolean {
  return PAID.has(status);
}

export function isOpenStatus(status: string): boolean {
  return OPEN.has(status);
}

/** Soma um ciclo a uma data YYYY-MM-DD, sem estourar o mês (31/01 → 28/02). */
export function addCycle(date: string, cycle: AsaasCycle): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const months = cycle === 'YEARLY' ? 12 : 1;
  const targetMonthIndex = m - 1 + months;
  const year = y + Math.floor(targetMonthIndex / 12);
  const month = (targetMonthIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Fim do dia em Brasília: o vencimento vale até 23:59 do horário do cliente. */
export function endOfDayBrazil(date: string): Date {
  return new Date(`${date}T23:59:59-03:00`);
}

/** Data de hoje em Brasília, no formato do Asaas. */
export function todayBrazil(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
}

export function deriveAsaasState(input: {
  subscription: AsaasSubscriptionSnapshot;
  payments: AsaasPaymentSnapshot[];
  now: Date;
  graceDays: number;
  /** Período já pago numa assinatura anterior (reativação antes do fim). */
  carryPaidUntil?: Date | null;
}): DerivedState {
  const { subscription, now, graceDays } = input;
  const payments = input.payments.filter((payment) => !payment.deleted && payment.dueDate);
  const subActive = !subscription.deleted && subscription.status === 'ACTIVE';

  let paidUntil: Date | null = input.carryPaidUntil ?? null;
  for (const payment of payments) {
    if (!PAID.has(payment.status)) continue;
    const end = endOfDayBrazil(addCycle(payment.dueDate as string, subscription.cycle));
    if (!paidUntil || end.getTime() > paidUntil.getTime()) paidUntil = end;
  }

  const open = payments
    .filter((payment) => OPEN.has(payment.status))
    .sort((a, b) => (a.dueDate as string).localeCompare(b.dueDate as string));
  const openPaymentId = open[0]?.id ?? null;

  // A cobrança mais recente entre as que tiveram desfecho define estorno e
  // contestação: um reembolso da última mensalidade tira o acesso na hora.
  const settled = payments
    .filter((payment) => PAID.has(payment.status) || REFUNDED.has(payment.status) || DISPUTED.has(payment.status))
    .sort((a, b) => (b.dueDate as string).localeCompare(a.dueDate as string));
  const latest = settled[0];

  if (latest && REFUNDED.has(latest.status)) {
    return { state: 'reembolsada', currentPeriodEnd: null, graceUntil: null, autoRenewing: false, openPaymentId: null };
  }
  if (latest && DISPUTED.has(latest.status)) {
    // Contestação em andamento: sem acesso até o desfecho, mas a assinatura
    // segue viva (pode voltar a `ativa` se a contestação for revertida).
    return {
      state: subActive ? 'suspensa' : 'expirada',
      currentPeriodEnd: paidUntil,
      graceUntil: null,
      autoRenewing: false,
      openPaymentId,
    };
  }

  if (!paidUntil) {
    return {
      state: subActive ? 'pendente' : 'expirada',
      currentPeriodEnd: null,
      graceUntil: null,
      autoRenewing: subActive,
      openPaymentId,
    };
  }

  if (now.getTime() <= paidUntil.getTime()) {
    return {
      state: subActive ? 'ativa' : 'cancelada_mas_ativa',
      currentPeriodEnd: paidUntil,
      graceUntil: null,
      autoRenewing: subActive,
      openPaymentId,
    };
  }

  if (!subActive) {
    return { state: 'expirada', currentPeriodEnd: paidUntil, graceUntil: null, autoRenewing: false, openPaymentId: null };
  }

  const graceUntil = new Date(paidUntil.getTime() + graceDays * 86_400_000);
  return {
    state: now.getTime() <= graceUntil.getTime() ? 'carencia' : 'suspensa',
    currentPeriodEnd: paidUntil,
    graceUntil,
    autoRenewing: true,
    openPaymentId,
  };
}
