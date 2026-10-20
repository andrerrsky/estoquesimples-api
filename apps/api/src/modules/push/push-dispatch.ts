import { eq } from 'drizzle-orm';

import { pushTokens } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import type { FcmSendResult, PushMessage } from './fcm-client.js';

/** O que é preciso de uma linha de `push_tokens` para mandar um push. */
export interface PushTarget {
  token: string;
  platform: string;
  webPushKeys: { p256dh: string; auth: string } | null;
}

export type DispatchResult = FcmSendResult | { ok: false; reason: 'unconfigured'; message: string };

/**
 * Manda um push para um aparelho pelo canal certo: Web Push para inscrições
 * de navegador, FCM para os aparelhos Android. Quem emite (suporte,
 * notificações, campanhas) não precisa saber qual é qual.
 *
 * Inscrição que o serviço diz não existir mais é revogada aqui mesmo. Nunca
 * lança por erro do serviço de push; um erro de configuração do Firebase
 * (credencial errada) sobe, como antes, para quem chamou decidir.
 */
export async function dispatchPush(services: AppServices, target: PushTarget, message: PushMessage): Promise<DispatchResult> {
  let result: DispatchResult;
  if (target.platform === 'web') {
    if (!target.webPushKeys) return { ok: false, reason: 'invalid', message: 'inscrição web sem chaves' };
    try {
      result = await services.webPush.send({ endpoint: target.token, keys: target.webPushKeys }, message);
    } catch (error) {
      // Chaves VAPID indisponíveis (banco fora): conta como falha deste envio.
      return { ok: false, reason: 'unavailable', message: error instanceof Error ? error.message : String(error) };
    }
  } else {
    if (!services.fcm.configured) return { ok: false, reason: 'unconfigured', message: 'Firebase não configurado' };
    result = await services.fcm.send(target.token, message);
  }
  if (!result.ok && (result.reason === 'unregistered' || result.reason === 'invalid')) {
    await services.db.update(pushTokens).set({ revokedAt: new Date(), revokeReason: result.reason }).where(eq(pushTokens.token, target.token));
  }
  return result;
}

/** Colunas de `push_tokens` usadas por `dispatchPush`. */
export const pushTargetColumns = {
  token: pushTokens.token,
  platform: pushTokens.platform,
  webPushKeys: pushTokens.webPushKeys,
};
