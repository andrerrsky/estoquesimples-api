/**
 * Google Identity Services ("Continuar com o Google"), carregado sob demanda.
 *
 * O script do Google só é baixado nas telas de entrada e cadastro, e só se a
 * API disser que o login com Google está ligado (`/v1/auth/web/config`). O
 * botão é o oficial do Google (marca e acessibilidade dele); o One Tap
 * aparece só no cadastro, para quem já está conectado ao Google no navegador.
 */

interface CredentialResponse {
  credential: string;
  /** Como a pessoa escolheu: 'btn…' = botão; o resto (auto, user, fedcm…) = One Tap. */
  select_by?: string;
}

interface GoogleAccountsId {
  initialize(config: Record<string, unknown>): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  prompt(): void;
  cancel(): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
let scriptPromise: Promise<GoogleAccountsId> | null = null;

export function loadGoogleIdentity(): Promise<GoogleAccountsId> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  scriptPromise ??= new Promise<GoogleAccountsId>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => (window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error('Google indisponível')));
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Não foi possível carregar o Google'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

let initializedFor: string | null = null;
let currentHandler: ((credential: string, fromOneTap: boolean) => void) | null = null;

/**
 * Configura o Google uma vez por página; a resposta vai para o handler da
 * tela que está aberta (o One Tap e o botão usam o mesmo callback).
 */
export async function setupGoogle(clientId: string, onCredential: (credential: string, fromOneTap: boolean) => void): Promise<GoogleAccountsId> {
  const id = await loadGoogleIdentity();
  currentHandler = onCredential;
  if (initializedFor !== clientId) {
    id.initialize({
      client_id: clientId,
      callback: (response: CredentialResponse) => currentHandler?.(response.credential, !(response.select_by ?? 'btn').startsWith('btn')),
      ux_mode: 'popup',
      auto_select: false,
      cancel_on_tap_outside: true,
      itp_support: true,
      use_fedcm_for_prompt: true,
      context: 'signup',
    });
    initializedFor = clientId;
  }
  return id;
}

/**
 * Navegadores embutidos de apps (Instagram, Facebook, Messenger, TikTok, Line…):
 * o Google bloqueia o login neles (disallowed_useragent). Nesses casos o botão
 * não aparece e fica só o cadastro por e-mail.
 */
export function isInAppBrowser(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /FBAN|FBAV|FB_IAB|Instagram|Messenger|Line\/|TikTok|musical_ly|Bytedance|; wv\)/i.test(userAgent);
}

const ONE_TAP_KEY = 'es_onetap_visto';
const ONE_TAP_QUIET_MS = 7 * 86_400_000;

/** One Tap no máximo uma vez a cada 7 dias por navegador (quem fechou não vê de novo logo). */
export function oneTapAllowed(now = Date.now()): boolean {
  try {
    const last = Number(localStorage.getItem(ONE_TAP_KEY) ?? '0');
    return !last || now - last > ONE_TAP_QUIET_MS;
  } catch {
    return true;
  }
}

export function markOneTapShown(now = Date.now()): void {
  try {
    localStorage.setItem(ONE_TAP_KEY, String(now));
  } catch {
    // sem armazenamento: pode aparecer de novo na próxima visita
  }
}
