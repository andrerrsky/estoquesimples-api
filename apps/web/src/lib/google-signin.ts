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
let currentHandler: ((credential: string) => void) | null = null;

/**
 * Configura o Google uma vez por página; a resposta vai para o handler da
 * tela que está aberta (o One Tap e o botão usam o mesmo callback).
 */
export async function setupGoogle(clientId: string, onCredential: (credential: string) => void): Promise<GoogleAccountsId> {
  const id = await loadGoogleIdentity();
  currentHandler = onCredential;
  if (initializedFor !== clientId) {
    id.initialize({
      client_id: clientId,
      callback: (response: CredentialResponse) => currentHandler?.(response.credential),
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
