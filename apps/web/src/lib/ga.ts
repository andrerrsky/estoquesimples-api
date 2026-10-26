/**
 * Google Analytics 4 (gtag.js) no site, no web app e na página inicial.
 *
 * Só carrega com o consentimento da pessoa (aviso de cookies,
 * `CookieConsent`): a Política de Privacidade promete isso e a LGPD exige
 * consentimento para cookies de análise. Sem aceite, nenhum script do Google
 * é baixado e nenhum dado sai do navegador.
 *
 * Nunca vai para o GA: e-mail, nome, id de pessoa ou empresa, nome de
 * produto, valores digitados. Só nomes de tela, de evento e contagens — as
 * mesmas propriedades do analytics próprio (`lib/analytics.ts`).
 *
 * Páginas: a "medição otimizada" do GA4 registra a visualização a cada troca
 * de rota (eventos de histórico do navegador), como o React Router faz.
 */

export const GA_MEASUREMENT_ID = (import.meta.env['VITE_GA_MEASUREMENT_ID'] as string | undefined) || 'G-V6S41QGPMS';

const CONSENT_KEY = 'es_cookie_consent';
export type Consent = 'granted' | 'denied';

type GtagParams = Record<string, string | number | boolean | null | undefined>;
type Gtag = (...args: unknown[]) => void;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

let loaded = false;
const listeners = new Set<(consent: Consent | null) => void>();

export function readConsent(): Consent | null {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    return null;
  }
}

export function setConsent(consent: Consent): void {
  try {
    localStorage.setItem(CONSENT_KEY, consent);
  } catch {
    // sem armazenamento: o aviso volta na próxima visita
  }
  if (consent === 'granted') loadGa();
  else if (loaded) window.gtag?.('consent', 'update', { analytics_storage: 'denied' });
  for (const listener of listeners) listener(consent);
}

export function onConsentChange(listener: (consent: Consent | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Injeta o gtag.js (uma vez). Chamado só com consentimento. */
export function loadGa(): void {
  if (loaded || typeof window === 'undefined' || !GA_MEASUREMENT_ID) return;
  loaded = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
  window.gtag('js', new Date());
  window.gtag('config', GA_MEASUREMENT_ID, {
    // Sem sinais de publicidade e sem personalização: o site não tem anúncios.
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    app_version: __APP_VERSION__,
    // Endereço sem query string: links de e-mail carregam tokens (?token=) que não podem ir para o Google.
    page_location: `${window.location.origin}${window.location.pathname}`,
    platform: isStandalone() ? 'web_app' : 'navegador',
  });
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_MEASUREMENT_ID)}`;
  document.head.appendChild(script);
}

/** Na abertura: quem já aceitou antes volta a ser medido sem ver o aviso de novo. */
export function bootGa(): void {
  if (readConsent() === 'granted') loadGa();
}

function isStandalone(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true)
  );
}

/**
 * Nossos eventos têm ponto ("product.created"); o GA4 aceita letras,
 * números e "_", até 40 caracteres. Alguns também viram o evento
 * recomendado do GA, que já aparece nos relatórios prontos.
 */
const RECOMMENDED: Record<string, string> = {
  'signup.completed': 'sign_up',
  'auth.login': 'login',
  'purchase.started': 'begin_checkout',
  'help.searched': 'search',
  'platform.web_app_installed': 'app_install',
};

export function gaName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, 'e_$1').slice(0, 40);
}

export function gaEvent(name: string, params: GtagParams = {}): void {
  if (!loaded || typeof window === 'undefined' || !window.gtag) return;
  const clean: GtagParams = {};
  for (const [key, value] of Object.entries(params).slice(0, 25)) {
    if (value === undefined) continue;
    clean[gaName(key)] = typeof value === 'string' ? value.slice(0, 100) : value;
  }
  window.gtag('event', gaName(name), clean);
  const recommended = RECOMMENDED[name];
  if (recommended) window.gtag('event', recommended, clean);
}

/**
 * Cliques que importam na página inicial e nas públicas, sem espalhar código
 * pelos botões: um ouvinte só, que olha o destino do link.
 */
export function installGaClickTracking(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const where = (element: Element): string => {
    const section = element.closest('section[id], header, footer, nav');
    return section?.id || section?.tagName.toLowerCase() || 'pagina';
  };
  const onClick = (event: MouseEvent) => {
    const link = (event.target as Element | null)?.closest?.('a[href]');
    if (!(link instanceof HTMLAnchorElement)) return;
    const href = link.getAttribute('href') ?? '';
    const local = { location: where(link), page: window.location.pathname };
    if (href.startsWith('https://play.google.com')) gaEvent('cta.play_store', local);
    else if (href.startsWith('/criar-conta')) gaEvent('cta.criar_conta', local);
    else if (href === '/entrar') gaEvent('cta.entrar', local);
    else if (href.startsWith('/plataformas')) gaEvent('cta.plataformas', local);
    else if (href.startsWith('/app/plano') || href.includes('depois=/app/plano')) gaEvent('cta.plano', local);
    else if (href === '/app') gaEvent('cta.abrir_estoque', local);
  };
  // Vídeo de apresentação: início e fim.
  const onMedia = (event: Event) => {
    if (!(event.target instanceof HTMLVideoElement)) return;
    gaEvent(event.type === 'play' ? 'video.started' : 'video.completed', { page: window.location.pathname });
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('play', onMedia, true);
  document.addEventListener('ended', onMedia, true);
  return () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('play', onMedia, true);
    document.removeEventListener('ended', onMedia, true);
  };
}

/** Reabre o aviso de cookies (link "Preferências de cookies" no rodapé e na política). */
export function openCookiePreferences(): void {
  window.dispatchEvent(new Event('es:cookie-preferences'));
}
