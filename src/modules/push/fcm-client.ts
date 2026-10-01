import { SignJWT, importPKCS8 } from 'jose';

import type { Env } from '../../platform/config/env.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';

/**
 * Cliente do Firebase Cloud Messaging (HTTP v1), sobre `fetch`.
 *
 * Mensagens são sempre só de dados (`data`), nunca `notification`: com
 * payload de notificação o sistema exibe sozinho e o app não fica sabendo,
 * então não haveria como medir entrega nem abertura. O app monta a
 * notificação a partir dos dados e reporta os dois eventos.
 */
export interface PushMessage {
  title: string;
  body: string;
  /**
   * Dados extras entregues ao app como strings. `type` diz como o app trata
   * a mensagem (`campaign` abre uma tela/URL e mede abertura; `support`
   * abre a solicitação de suporte). Nunca leva dado pessoal.
   */
  data: Record<string, string>;
}

export type FcmSendResult =
  | { ok: true; messageId: string }
  | { ok: false; reason: 'unregistered' | 'invalid' | 'rate_limited' | 'unavailable' | 'error'; message: string };

export interface FcmClient {
  readonly configured: boolean;
  readonly projectId: string | null;
  send(token: string, message: PushMessage): Promise<FcmSendResult>;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** Data messages ficam no FCM por até um dia esperando o aparelho aparecer. */
const TTL = '86400s';

export class FirebaseFcmClient implements FcmClient {
  private accessToken: { value: string; expiresAt: number } | null = null;
  private readonly account: ServiceAccount | null;
  readonly projectId: string | null;

  constructor(env: Env) {
    const json = env.FIREBASE_SERVICE_ACCOUNT_JSON ?? env.GOOGLE_SERVICE_ACCOUNT_JSON;
    this.account = json ? (JSON.parse(json) as ServiceAccount) : null;
    this.projectId = env.FIREBASE_PROJECT_ID ?? this.account?.project_id ?? null;
  }

  get configured(): boolean {
    return this.account !== null && this.projectId !== null;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }
    if (!this.account) {
      throw new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, 'Firebase não configurado.');
    }
    const key = await importPKCS8(this.account.private_key.replace(/\\n/g, '\n'), 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(this.account.client_email)
      .setAudience(this.account.token_uri ?? TOKEN_URI)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);

    const response = await fetch(this.account.token_uri ?? TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!response.ok) {
      throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, 'Falha ao autenticar no Firebase.', {
        extra: { status: response.status },
      });
    }
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async send(token: string, message: PushMessage): Promise<FcmSendResult> {
    const accessToken = await this.getAccessToken();
    const data: Record<string, string> = { ...message.data, title: message.title, body: message.body };

    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId ?? '')}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            data,
            android: { priority: 'high', ttl: TTL },
          },
        }),
      },
    );

    if (response.ok) {
      const body = (await response.json()) as { name?: string };
      return { ok: true, messageId: body.name ?? '' };
    }

    let detail = `HTTP ${response.status}`;
    let errorCode = '';
    try {
      const body = (await response.json()) as {
        error?: { message?: string; status?: string; details?: Array<{ errorCode?: string }> };
      };
      detail = body.error?.message ?? detail;
      errorCode = body.error?.details?.find((item) => item.errorCode)?.errorCode ?? body.error?.status ?? '';
    } catch {
      // corpo não é JSON
    }

    if (response.status === 404 || errorCode === 'UNREGISTERED') {
      return { ok: false, reason: 'unregistered', message: detail };
    }
    if (response.status === 400 || errorCode === 'INVALID_ARGUMENT') {
      return { ok: false, reason: 'invalid', message: detail };
    }
    if (response.status === 429 || errorCode === 'QUOTA_EXCEEDED') {
      return { ok: false, reason: 'rate_limited', message: detail };
    }
    if (response.status >= 500 || errorCode === 'UNAVAILABLE' || errorCode === 'INTERNAL') {
      return { ok: false, reason: 'unavailable', message: detail };
    }
    // 401/403: credencial sem o papel "Firebase Cloud Messaging API Admin"
    // ou API do FCM desativada no projeto — não adianta insistir por token.
    if (response.status === 401 || response.status === 403) {
      throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, `O Firebase recusou o envio (${detail}).`, {
        extra: { status: response.status },
      });
    }
    return { ok: false, reason: 'error', message: detail };
  }
}

/** Implementação de teste: registra o que seria enviado. */
export class FakeFcmClient implements FcmClient {
  readonly configured = true;
  readonly projectId = 'teste';
  readonly sent: Array<{ token: string; message: PushMessage }> = [];
  /** Tokens que o "FCM" deve tratar como cancelados. */
  readonly unregistered = new Set<string>();

  async send(token: string, message: PushMessage): Promise<FcmSendResult> {
    if (this.unregistered.has(token)) {
      return { ok: false, reason: 'unregistered', message: 'Requested entity was not found.' };
    }
    this.sent.push({ token, message });
    return { ok: true, messageId: `projects/teste/messages/${this.sent.length}` };
  }
}
