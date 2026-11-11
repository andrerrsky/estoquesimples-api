import { api } from './client';
import type { BillingCycle, CheckoutResult, CouponCheck, PixCharge, PublicPromo } from './types';

/**
 * Campanha (Black Friday), cupom, checkout e Pix. Contrato em
 * docs/black-friday-2026.md. A campanha é só divulgação: preço, vigência e
 * elegibilidade são decididos no servidor, e qualquer falha aqui vira "sem
 * campanha" (nada aparece) em vez de erro na tela.
 */

const NO_PROMO: PublicPromo = { active: false, upcoming: false };

/** `GET /v1/public/promo`. Erro, 404 ou resposta estranha = sem campanha. */
export async function getPromo(): Promise<PublicPromo> {
  try {
    const promo = await api.get<PublicPromo | null>('/v1/public/promo', undefined, { auth: false });
    return promo && typeof promo.active === 'boolean' ? promo : NO_PROMO;
  } catch {
    return NO_PROMO;
  }
}

/** `GET /v1/public/coupons/:code`. Lança `ApiError` (a tela explica rede/servidor). */
export function getCoupon(code: string): Promise<CouponCheck> {
  return api.get<CouponCheck>(`/v1/public/coupons/${encodeURIComponent(code)}`, undefined, { auth: false });
}

export interface CheckoutInput {
  name: string;
  cpfCnpj: string;
  cycle: BillingCycle;
  billingType: 'UNDEFINED' | 'PIX' | 'BOLETO' | 'CREDIT_CARD';
  email?: string;
  mobilePhone?: string;
  /** Só com `MONTHLY` ou `YEARLY`; a API normaliza e valida. */
  coupon?: string;
}

export function checkout(workspaceId: string, input: CheckoutInput): Promise<CheckoutResult> {
  return api.post<CheckoutResult>(`/v1/workspaces/${workspaceId}/billing/web/checkout`, input);
}

/** Cobrança Pix em aberto (QR e copia e cola); 404 se não houver. */
export function getPix(workspaceId: string): Promise<PixCharge> {
  return api.get<PixCharge>(`/v1/workspaces/${workspaceId}/billing/web/pix`);
}
