import { eq } from 'drizzle-orm';
import webpush from 'web-push';

import { adminSettings } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import type { FcmSendResult, PushMessage } from './fcm-client.js';

/**
 * Web Push padrão (RFC 8030/8291/8292) para o web app: Safari no iPhone e no
 * iPad (web app adicionado à tela inicial, iOS 16.4+), Chrome/Edge/Firefox no
 * Android e no computador. Não passa pelo Firebase: o navegador entrega um
 * endpoint do serviço de push dele (Apple, Google, Mozilla, Microsoft) e a
 * API manda a mensagem cifrada direto para lá, assinada com as chaves VAPID.
 *
 * As chaves vêm de `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` ou, sem elas, são
 * geradas uma vez e guardadas cifradas em `admin_settings` — assim funciona
 * sem configuração e todas as instâncias usam o mesmo par (trocar o par
 * invalida as inscrições existentes; por isso ele nunca é regenerado).
 */

const SETTING_KEY = 'web_push_vapid';
/** A mensagem fica no serviço de push por até um dia esperando o aparelho. */
const TTL_SECONDS = 86_400;

/**
 * Só estes serviços de push podem receber mensagens: o endpoint vem do
 * navegador, e sem esta lista a API faria POST para qualquer endereço que
 * alguém registrasse (SSRF).
 */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.port !== '') return false;
    const host = url.hostname.toLowerCase();
    return PUSH_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export class WebPushClient {
  private keys: Promise<VapidKeys> | null = null;

  constructor(private readonly services: AppServices) {}

  /** Chave pública que o navegador usa para se inscrever (`applicationServerKey`). */
  async publicKey(): Promise<string> {
    return (await this.loadKeys()).publicKey;
  }

  async send(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, message: PushMessage): Promise<FcmSendResult> {
    if (!isAllowedPushEndpoint(subscription.endpoint)) {
      return { ok: false, reason: 'invalid', message: 'endpoint fora dos serviços de push conhecidos' };
    }
    const keys = await this.loadKeys();
    // O serviço de push só aceita https: ou mailto: (em desenvolvimento WEB_APP_URL é http).
    const candidates = [this.services.env.VAPID_SUBJECT, this.services.env.WEB_APP_URL];
    const subject = candidates.find((value) => !!value && /^(https:|mailto:)/.test(value)) ?? 'mailto:suporte@estoquesimples.com.br';
    try {
      const response = await webpush.sendNotification(subscription, JSON.stringify({ title: message.title, body: message.body, data: message.data }), {
        TTL: TTL_SECONDS,
        urgency: 'normal',
        vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        timeout: 10_000,
      });
      return { ok: true, messageId: response.headers['location'] ?? String(response.statusCode) };
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      const text = error instanceof Error ? error.message : String(error);
      // 404/410: a inscrição não existe mais (permissão revogada, app removido da tela inicial).
      if (status === 404 || status === 410) return { ok: false, reason: 'unregistered', message: `inscrição expirada (${status})` };
      if (status === 400 || status === 403 || status === 413) return { ok: false, reason: 'invalid', message: `recusada pelo serviço de push (${status})` };
      if (status === 429) return { ok: false, reason: 'rate_limited', message: 'limite do serviço de push' };
      if (status !== undefined && status >= 500) return { ok: false, reason: 'unavailable', message: `serviço de push indisponível (${status})` };
      return { ok: false, reason: 'error', message: text.slice(0, 200) };
    }
  }

  private loadKeys(): Promise<VapidKeys> {
    if (!this.keys) {
      this.keys = this.resolveKeys().catch((error: unknown) => {
        // Falha transitória (banco fora): a próxima chamada tenta de novo.
        this.keys = null;
        throw error;
      });
    }
    return this.keys;
  }

  private async resolveKeys(): Promise<VapidKeys> {
    const { env, db, purchaseTokens } = this.services;
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };

    const read = async (): Promise<VapidKeys | null> => {
      const rows = await db.select({ valueEnc: adminSettings.valueEnc }).from(adminSettings).where(eq(adminSettings.key, SETTING_KEY)).limit(1);
      const row = rows[0];
      return row ? (JSON.parse(purchaseTokens.decrypt(row.valueEnc)) as VapidKeys) : null;
    };

    const existing = await read();
    if (existing) return existing;
    // Primeira vez: gera e grava; se outra instância gravou antes, vale a dela.
    const generated = webpush.generateVAPIDKeys();
    await db
      .insert(adminSettings)
      .values({ key: SETTING_KEY, valueEnc: purchaseTokens.encrypt(JSON.stringify(generated)) })
      .onConflictDoNothing();
    return (await read()) ?? generated;
  }
}
