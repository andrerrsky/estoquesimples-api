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
 *
 * Origem da visita (campanhas): o endereço enviado ao GA não leva a query
 * string inteira (links de e-mail carregam `?token=`), só os parâmetros de
 * campanha de uma lista fechada (`CAMPAIGN_PARAMS`: UTMs e os identificadores
 * de clique do Google Ads). Sem eles o GA4 não sabe que a visita veio de um
 * anúncio e o Google Ads não recebe o cadastro como conversão daquele clique.
 * Quem chega por um anúncio, entra na página inicial e só aceita os cookies
 * depois, já em /criar-conta, perderia a origem; por isso os parâmetros ficam
 * guardados na aba (`sessionStorage`, nunca enviados sem aceite) e entram na
 * primeira carga do GA daquela aba. Recusar apaga o que estava guardado.
 */

export const GA_MEASUREMENT_ID = (import.meta.env['VITE_GA_MEASUREMENT_ID'] as string | undefined) || 'G-V6S41QGPMS';

const CONSENT_KEY = 'es_cookie_consent';
export type Consent = 'granted' | 'denied';

/** Parâmetros de campanha que podem ir para o GA (e só eles). */
export const CAMPAIGN_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'gclid', 'gbraid', 'wbraid'] as const;
const CAMPAIGN_KEY = 'es_campanha';
/** `?es_interno=1` marca este navegador como da equipe (`?es_interno=0` desmarca). */
const INTERNAL_KEY = 'es_trafego_interno';
/** `?es_debug=1` manda os eventos desta aba ao DebugView do GA4 (e fora dos relatórios). */
const DEBUG_KEY = 'es_ga_debug';

type GtagParams = Record<string, string | number | boolean | null | undefined>;
type Gtag = (...args: unknown[]) => void;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

function storageGet(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}
function storageSet(storage: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    // sem armazenamento: segue sem lembrar
  }
}
const session = () => window.sessionStorage;
const local = () => window.localStorage;

/**
 * Só os parâmetros de campanha da lista, com valores curtos e sem nada que
 * pareça e-mail (um link montado à mão não pode levar dado pessoal ao Google).
 */
export function campaignParams(search: string): URLSearchParams {
  const from = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const key of CAMPAIGN_PARAMS) {
    const value = from.get(key)?.trim();
    if (!value || value.length > 150 || value.includes('@')) continue;
    out.set(key, value);
  }
  return out;
}

interface StoredCampaign {
  query: string;
  delivered: boolean;
}

function readStoredCampaign(): StoredCampaign | null {
  const raw = storageGet(session, CAMPAIGN_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCampaign>;
    return typeof parsed.query === 'string' ? { query: campaignParams(parsed.query).toString(), delivered: parsed.delivered === true } : null;
  } catch {
    return null;
  }
}

/**
 * Guarda na aba os parâmetros de campanha do endereço atual, se houver e se a
 * pessoa não recusou os cookies. Chamado na abertura de cada página.
 */
export function rememberCampaign(): void {
  if (typeof window === 'undefined' || readConsent() === 'denied') return;
  const query = campaignParams(window.location.search).toString();
  if (query) storageSet(session, CAMPAIGN_KEY, JSON.stringify({ query, delivered: false } satisfies StoredCampaign));
}

/**
 * Endereço para o GA: origem + caminho + parâmetros de campanha. Os do
 * endereço atual valem primeiro; sem eles, os guardados na aba que ainda não
 * chegaram ao GA (a pessoa aceitou os cookies depois de sair da página de
 * entrada). Nunca a query string inteira.
 */
export function pageLocation(): string {
  let query = campaignParams(window.location.search).toString();
  if (!query) {
    const stored = readStoredCampaign();
    if (stored && !stored.delivered) query = stored.query;
  }
  return `${window.location.origin}${window.location.pathname}${query ? `?${query}` : ''}`;
}

function markCampaignDelivered(): void {
  const stored = readStoredCampaign();
  if (stored && !stored.delivered) storageSet(session, CAMPAIGN_KEY, JSON.stringify({ ...stored, delivered: true }));
}

/** Marcações de teste e de equipe pela URL (não são campanha e não vão no endereço). */
function readFlagsFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  const internal = params.get('es_interno');
  if (internal === '1') storageSet(local, INTERNAL_KEY, '1');
  else if (internal === '0') storageSet(local, INTERNAL_KEY, null);
  const debug = params.get('es_debug');
  if (debug === '1') storageSet(session, DEBUG_KEY, '1');
  else if (debug === '0') storageSet(session, DEBUG_KEY, null);
}

export function isInternalTraffic(): boolean {
  return storageGet(local, INTERNAL_KEY) === '1';
}

function disableFlag(): string {
  return `ga-disable-${GA_MEASUREMENT_ID}`;
}

let loaded = false;
const listeners = new Set<(consent: Consent | null) => void>();

/** Escolha desta página quando o navegador não deixa gravar (aba privada, armazenamento bloqueado). */
let memoryConsent: Consent | null = null;

export function readConsent(): Consent | null {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return value === 'granted' || value === 'denied' ? value : memoryConsent;
  } catch {
    return memoryConsent;
  }
}

export function setConsent(consent: Consent): void {
  memoryConsent = consent;
  try {
    localStorage.setItem(CONSENT_KEY, consent);
  } catch {
    // sem armazenamento: o aviso volta na próxima visita
  }
  if (consent === 'granted') {
    if (loaded) {
      // Aceitou de novo na mesma página: religa o que a recusa desligou.
      (window as unknown as Record<string, unknown>)[disableFlag()] = false;
      window.gtag?.('consent', 'update', { analytics_storage: 'granted' });
    } else loadGa();
  } else {
    // Recusa ou revogação: nada guardado para depois e, se o gtag já estava
    // na página, ele para de enviar (inclusive as visualizações automáticas).
    storageSet(session, CAMPAIGN_KEY, null);
    if (loaded) {
      window.gtag?.('consent', 'update', { analytics_storage: 'denied' });
      (window as unknown as Record<string, unknown>)[disableFlag()] = true;
    }
  }
  for (const listener of listeners) listener(consent);
}

export function onConsentChange(listener: (consent: Consent | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Injeta o gtag.js (uma vez). Chamado só com consentimento. */
export function loadGa(): void {
  if (loaded || typeof window === 'undefined' || !GA_MEASUREMENT_ID) return;
  if (readConsent() !== 'granted') return;
  loaded = true;
  (window as unknown as Record<string, unknown>)[disableFlag()] = false;
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
    // Sem a query string inteira (links de e-mail carregam ?token=): só os parâmetros de campanha.
    page_location: pageLocation(),
    platform: isStandalone() ? 'web_app' : 'navegador',
    // Equipe e testes: filtráveis no GA sem tirar ninguém de verdade dos relatórios.
    ...(isInternalTraffic() ? { traffic_type: 'internal' } : {}),
    ...(storageGet(session, DEBUG_KEY) === '1' ? { debug_mode: true } : {}),
  });
  markCampaignDelivered();
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_MEASUREMENT_ID)}`;
  document.head.appendChild(script);
}

/** Na abertura: quem já aceitou antes volta a ser medido sem ver o aviso de novo. */
export function bootGa(): void {
  if (typeof window === 'undefined') return;
  readFlagsFromUrl();
  rememberCampaign();
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
  // Sem aceite (ou depois de revogar) nada vai ao Google, nem sem cookies.
  if (!loaded || typeof window === 'undefined' || !window.gtag || readConsent() !== 'granted') return;
  const clean: GtagParams = {};
  for (const [key, value] of Object.entries(params).slice(0, 25)) {
    if (value === undefined) continue;
    clean[gaName(key)] = typeof value === 'string' ? value.slice(0, 100) : value;
  }
  if (isInternalTraffic()) clean['traffic_type'] = 'internal';
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
    const marked = element.closest('[data-ga-local]')?.getAttribute('data-ga-local');
    if (marked) return marked;
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
