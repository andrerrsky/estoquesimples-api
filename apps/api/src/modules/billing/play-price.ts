/**
 * O que o comprovante do Google diz sobre dinheiro.
 *
 * `purchases.subscriptionsv2.get` não devolve "plano mensal de R$ 24,99" em
 * campos prontos: devolve o preço recorrente em `units`/`nanos` e, quando a
 * compra está numa oferta de entrada, apenas a marca da fase — sem o valor
 * promocional. Por isso a coluna `price_cents` da assinatura fica nula nas
 * compras pela Play, e quem precisa do valor (relatório financeiro, conversão
 * offline, aviso aos administradores) lê daqui.
 */

/** Preço recorrente do comprovante do Google (`units` + `nanos`), em centavos. */
export function googleRecurringCents(raw: unknown): { cents: number | null; inOffer: boolean } {
  const item = (raw as { lineItems?: Array<Record<string, unknown>> } | null)?.lineItems?.[0];
  const price = (item?.['autoRenewingPlan'] as { recurringPrice?: { units?: string | number; nanos?: number } } | undefined)?.recurringPrice;
  const cents = price ? Math.round(Number(price.units ?? 0) * 100 + Number(price.nanos ?? 0) / 10_000_000) : null;
  const phase = item?.['offerPhase'] as Record<string, unknown> | undefined;
  const inOffer = Boolean(phase && ('introductoryPrice' in phase || 'freeTrial' in phase || 'prorationPeriod' in phase));
  return { cents: Number.isFinite(cents) ? cents : null, inOffer };
}

export type PlayCycle = 'MONTHLY' | 'SEMIANNUALLY' | 'YEARLY';

/**
 * Periodicidade da compra, deduzida de quanto falta até o vencimento.
 *
 * O comprovante não traz o ciclo, e `startTime` é o início da assinatura
 * inteira — não do período em curso —, então a diferença entre início e
 * vencimento cresce a cada renovação e não serve. O que falta até
 * `expiryTime` serve: isto é lido logo depois de um pagamento confirmado,
 * quando o período acabou de começar.
 */
export function playCycleFromRaw(raw: unknown, now = new Date()): PlayCycle | null {
  const expiry = (raw as { lineItems?: Array<{ expiryTime?: string }> } | null)?.lineItems?.[0]?.expiryTime;
  if (!expiry) return null;
  const dias = (Date.parse(expiry) - now.getTime()) / 86_400_000;
  if (!Number.isFinite(dias) || dias <= 0) return null;
  if (dias <= 45) return 'MONTHLY';
  if (dias <= 270) return 'SEMIANNUALLY';
  return 'YEARLY';
}

/** Número do pedido no Google, para conferir no Play Console. */
export function playOrderId(raw: unknown): string | null {
  const dados = raw as { latestOrderId?: string; lineItems?: Array<{ latestSuccessfulOrderId?: string }> } | null;
  return dados?.latestOrderId ?? dados?.lineItems?.[0]?.latestSuccessfulOrderId ?? null;
}
