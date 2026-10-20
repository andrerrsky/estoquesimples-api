import { useCallback, useEffect, useState } from 'react';

import { api } from '../api/client';
import { installId } from './device';

/**
 * Avisos do web app (Web Push padrão, sem Firebase): resposta do suporte,
 * pagamento e assinatura, equipe, novidades e estoque baixo — os mesmos
 * avisos que o app Android recebe.
 *
 * Onde funciona: Chrome/Edge/Firefox no computador e no Android, e Safari
 * no iPhone/iPad **só com o web app adicionado à tela inicial** (iOS 16.4+);
 * numa aba comum do Safari a Apple não oferece push. O estado `install`
 * existe para explicar isso em vez de esconder a opção.
 *
 * O pedido de permissão só pode sair de um toque da pessoa (o iPhone recusa
 * qualquer outro), por isso nada aqui pede sozinho: `enable()` é chamado por
 * um botão.
 */

export type PushState =
  /** Navegador sem suporte (ou contexto não seguro). */
  | 'unsupported'
  /** iPhone/iPad numa aba do Safari: precisa adicionar à tela inicial. */
  | 'install'
  /** Ainda não pediu (ou a pessoa desligou aqui). */
  | 'off'
  /** A pessoa bloqueou nas permissões do navegador. */
  | 'denied'
  | 'on';

const ENABLED_KEY = 'es_web_push';

function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function supported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // `updateViaCache: 'none'`: o navegador sempre confere se o sw.js mudou.
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  await navigator.serviceWorker.ready;
  return reg;
}

function remember(on: boolean): void {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, '1');
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    // sem armazenamento: só não religa sozinho depois
  }
}

function remembered(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Manda (ou atualiza) a inscrição para a API; com sessão, ela fica ligada à conta. */
async function register(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('inscrição sem chaves');
  await api.put(
    '/v1/push/tokens',
    {
      token: json.endpoint,
      installId: installId(),
      platform: 'web',
      locale: navigator.language?.slice(0, 16) || 'pt-BR',
      notificationsEnabled: true,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    },
    { optionalAuth: true },
  );
  // O service worker precisa do installId para medir as campanhas.
  navigator.serviceWorker.controller?.postMessage({ type: 'install-id', installId: installId() });
  (await navigator.serviceWorker.ready).active?.postMessage({ type: 'install-id', installId: installId() });
}

export async function currentPushState(): Promise<PushState> {
  if (!supported()) return isIos() && !isStandalone() ? 'install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted' || !remembered()) return 'off';
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const subscription = await reg?.pushManager.getSubscription();
    return subscription ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

/** Liga os avisos neste navegador. Chamar só a partir de um toque/clique. */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return currentPushState();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await registration();
  const { publicKey } = await api.get<{ publicKey: string }>('/v1/push/web-config', undefined, { auth: false });
  let subscription = await reg.pushManager.getSubscription();
  // Inscrição feita com outra chave (troca de servidor): refaz.
  const current = subscription?.options.applicationServerKey;
  if (subscription && current && btoa(String.fromCharCode(...new Uint8Array(current))).replace(/=+$/, '') !== btoa(String.fromCharCode(...base64UrlToBytes(publicKey))).replace(/=+$/, '')) {
    await subscription.unsubscribe().catch(() => undefined);
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) as BufferSource });
  await register(subscription);
  remember(true);
  return 'on';
}

/** Desliga os avisos neste navegador (os outros aparelhos da conta continuam). */
export async function disablePush(): Promise<PushState> {
  remember(false);
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const subscription = await reg?.pushManager.getSubscription();
    if (subscription) {
      await api.delete('/v1/push/tokens', { token: subscription.endpoint, installId: installId() }, { auth: false }).catch(() => undefined);
      await subscription.unsubscribe().catch(() => undefined);
    }
  } catch {
    // sem service worker: já não recebia nada
  }
  return currentPushState();
}

/**
 * Na abertura do app (com ou sem sessão): se os avisos estão ligados aqui,
 * reenvia a inscrição — liga à conta depois do login e cobre a troca de
 * inscrição que o navegador faz de tempos em tempos. Não pede nada.
 */
export async function refreshPushSubscription(): Promise<void> {
  if (!supported() || Notification.permission !== 'granted' || !remembered()) return;
  try {
    const reg = await registration();
    const subscription = await reg.pushManager.getSubscription();
    if (subscription) await register(subscription);
    else remember(false);
  } catch {
    // tenta de novo na próxima abertura
  }
}

/** O service worker pede (inscrição trocada) ou a notificação manda abrir uma tela. */
export function listenToServiceWorker(open: (url: string) => void): () => void {
  if (!supported()) return () => undefined;
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; url?: string } | null;
    if (data?.type === 'resubscribe') void refreshPushSubscription();
    if (data?.type === 'open' && typeof data.url === 'string') open(data.url);
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}

/** Estado + ações para a tela de configuração. */
export function useWebPush() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void currentPushState().then((value) => alive && setState(value));
    return () => {
      alive = false;
    };
  }, []);

  const run = useCallback(async (action: () => Promise<PushState>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await action());
    } catch {
      setError('Não foi possível ligar os avisos agora. Verifique a conexão e tente de novo.');
      setState(await currentPushState());
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    state,
    busy,
    error,
    enable: () => run(enablePush),
    disable: () => run(disablePush),
  };
}
