/**
 * Google Analytics 4 no painel administrativo (mesma propriedade do site).
 *
 * - Só carrega com consentimento (aviso de cookies do painel).
 * - Todo evento sai marcado como tráfego interno (`traffic_type: internal`):
 *   no GA, o filtro de dados "Tráfego interno" separa o uso da equipe do uso
 *   dos clientes. Ative o filtro como "Ativo" para tirar o painel dos
 *   relatórios do site, ou deixe "Em teste" para ver os dois.
 * - Nada de cliente vai para o Google: a busca por texto (e-mail, nome) não
 *   fica na URL (ver `useListParams`), os eventos de ação levam o caminho da
 *   API com os ids trocados por ":id" e nunca o corpo da requisição.
 */

export const GA_MEASUREMENT_ID = 'G-V6S41QGPMS';
const CONSENT_KEY = 'es_admin_cookie_consent';

type Gtag = (...args: unknown[]) => void;
declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

let loaded = false;

export function readConsent(): 'granted' | 'denied' | null {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    return null;
  }
}

export function setConsent(consent: 'granted' | 'denied'): void {
  try {
    localStorage.setItem(CONSENT_KEY, consent);
  } catch {
    // sem armazenamento: o aviso volta na próxima visita
  }
  if (consent === 'granted') loadGa();
  else if (loaded) window.gtag?.('consent', 'update', { analytics_storage: 'denied' });
}

export function loadGa(): void {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
  window.gtag('js', new Date());
  window.gtag('config', GA_MEASUREMENT_ID, {
    traffic_type: 'internal',
    app_area: 'painel',
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);
}

export function bootGa(): void {
  if (readConsent() === 'granted') loadGa();
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Caminho da API sem ids nem consulta: "/users/<uuid>/suspend" → "/users/:id/suspend". */
export function normalizePath(path: string): string {
  return path.split('?')[0]!.replace(UUID, ':id').replace(/\/\d+(?=\/|$)/g, '/:n').replace(/\/[0-9a-f]{20,}(?=\/|$)/gi, '/:hash').slice(0, 100);
}

export function gaEvent(name: string, params: Record<string, string | number | boolean | undefined> = {}): void {
  if (!loaded || !window.gtag) return;
  window.gtag('event', name, { ...params, traffic_type: 'internal', app_area: 'painel' });
}

export function openCookiePreferences(): void {
  window.dispatchEvent(new Event('es:cookie-preferences'));
}
