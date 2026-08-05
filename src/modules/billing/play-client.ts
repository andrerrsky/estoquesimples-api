import { SignJWT, importPKCS8 } from 'jose';

import type { Env } from '../../platform/config/env.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';

/**
 * Recorte de `purchases.subscriptionsv2.get` com os campos de que dependemos.
 *
 * Usamos a v2 porque a v1 está descontinuada e não expõe corretamente base
 * plans e ofertas — informação necessária para saber qual plano foi comprado.
 */
export interface SubscriptionPurchaseV2 {
  subscriptionState: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  startTime?: string;
  canceledStateContext?: {
    userInitiatedCancellation?: { cancelSurveyResult?: unknown; cancelTime?: string };
    systemInitiatedCancellation?: Record<string, unknown>;
    developerInitiatedCancellation?: Record<string, unknown>;
    replacementCancellation?: Record<string, unknown>;
  };
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
    prepaidPlan?: { allowExtendAfterTime?: string };
    offerDetails?: { basePlanId?: string; offerId?: string };
  }>;
}

export interface PlayStoreClient {
  getSubscription(purchaseToken: string): Promise<SubscriptionPurchaseV2>;
  acknowledge(purchaseToken: string, productId: string): Promise<void>;
  readonly configured: boolean;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

/**
 * Cliente da Play Developer API.
 *
 * Implementado direto sobre `fetch` e um JWT assinado, em vez da biblioteca
 * `googleapis`: usamos dois endpoints, e a dependência completa traria dezenas
 * de megabytes e uma superfície de atualização que não se paga.
 */
export class GooglePlayClient implements PlayStoreClient {
  private accessToken: { value: string; expiresAt: number } | null = null;
  private readonly account: ServiceAccount | null;

  constructor(private readonly env: Env) {
    this.account = env.GOOGLE_SERVICE_ACCOUNT_JSON
      ? (JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as ServiceAccount)
      : null;
  }

  get configured(): boolean {
    return this.account !== null;
  }

  private requireAccount(): ServiceAccount {
    if (!this.account) {
      throw new AppError(
        503,
        ErrorCode.BILLING_UNAVAILABLE,
        'Validação de assinatura indisponível no momento.',
      );
    }
    return this.account;
  }

  /**
   * Obtém e reaproveita o token OAuth. Renovado 60 segundos antes de vencer,
   * para não perder uma chamada por diferença de relógio com o Google.
   */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }

    const account = this.requireAccount();
    const key = await importPKCS8(account.private_key.replace(/\\n/g, '\n'), 'RS256');
    const now = Math.floor(Date.now() / 1000);

    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(account.client_email)
      .setAudience(account.token_uri ?? TOKEN_URI)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);

    const response = await fetch(account.token_uri ?? TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!response.ok) {
      throw new AppError(
        502,
        ErrorCode.BILLING_UNAVAILABLE,
        'Falha ao autenticar na API do Google Play.',
        { extra: { status: response.status } },
      );
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = {
      value: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    return body.access_token;
  }

  async getSubscription(purchaseToken: string): Promise<SubscriptionPurchaseV2> {
    const token = await this.getAccessToken();
    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
      `${encodeURIComponent(this.env.GOOGLE_PLAY_PACKAGE_NAME)}/purchases/subscriptionsv2/tokens/` +
      `${encodeURIComponent(purchaseToken)}`;

    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });

    // Token que o Google não reconhece é tentativa inválida, não indisponibilidade.
    if (response.status === 404 || response.status === 400) {
      throw new AppError(
        400,
        ErrorCode.PURCHASE_TOKEN_INVALID,
        'Comprovante de compra não reconhecido pelo Google Play.',
      );
    }

    if (!response.ok) {
      throw new AppError(
        502,
        ErrorCode.BILLING_UNAVAILABLE,
        'Não foi possível validar a assinatura agora. Tente novamente.',
        { extra: { status: response.status } },
      );
    }

    return (await response.json()) as SubscriptionPurchaseV2;
  }

  /**
   * Confirma o recebimento da compra. O Google reembolsa automaticamente
   * compras não confirmadas em três dias, então esta chamada não é opcional.
   */
  async acknowledge(purchaseToken: string, productId: string): Promise<void> {
    const token = await this.getAccessToken();
    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
      `${encodeURIComponent(this.env.GOOGLE_PLAY_PACKAGE_NAME)}/purchases/subscriptions/` +
      `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    // 400 aqui costuma ser "já confirmada", que é o estado desejado.
    if (!response.ok && response.status !== 400) {
      throw new AppError(
        502,
        ErrorCode.BILLING_UNAVAILABLE,
        'Falha ao confirmar a compra no Google Play.',
        { extra: { status: response.status } },
      );
    }
  }
}

/**
 * Implementação de teste, controlada pelo próprio teste.
 *
 * Existe porque validar assinatura contra o Google de verdade tornaria a
 * suíte dependente de rede e de uma compra real. O que precisamos exercitar é
 * a nossa máquina de estados diante de cada resposta possível.
 */
export class FakePlayStoreClient implements PlayStoreClient {
  readonly configured = true;
  readonly acknowledged: string[] = [];
  private readonly responses = new Map<string, SubscriptionPurchaseV2>();
  private failure: Error | null = null;

  setSubscription(purchaseToken: string, purchase: SubscriptionPurchaseV2): void {
    this.responses.set(purchaseToken, purchase);
  }

  failNext(error: Error): void {
    this.failure = error;
  }

  async getSubscription(purchaseToken: string): Promise<SubscriptionPurchaseV2> {
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }
    const purchase = this.responses.get(purchaseToken);
    if (!purchase) {
      throw new AppError(
        400,
        ErrorCode.PURCHASE_TOKEN_INVALID,
        'Comprovante de compra não reconhecido pelo Google Play.',
      );
    }
    return purchase;
  }

  async acknowledge(purchaseToken: string): Promise<void> {
    this.acknowledged.push(purchaseToken);
  }
}
