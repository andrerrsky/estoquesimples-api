import { APP_VERSION, installId, newId } from './device';
import { attributionConsent, CAMPAIGN_PARAMS } from './ga';

/**
 * Origem da visita, para o próprio cadastro.
 *
 * Diferente do que vai ao Google Analytics (só com aceite), isto fica no
 * nosso sistema: na primeira página da aba guardamos os parâmetros de
 * campanha (UTMs e o identificador do clique no anúncio) e o caminho de
 * entrada, em `sessionStorage` (some ao fechar a aba, não é cookie). No
 * cadastro eles vão junto com a escolha de cookies e a API grava na conta.
 * O painel usa para saber de onde veio cada conta; o Google Ads só fica
 * sabendo da ativação de quem aceitou o aviso atual (ver
 * `apps/api/src/modules/auth/signup-attribution.ts`).
 *
 * Primeiro toque: a primeira campanha da aba vale até o cadastro; uma
 * navegação interna sem parâmetros não apaga.
 */
const FIRST_TOUCH_KEY = 'es_origem';
const CLICK_ID = /^[A-Za-z0-9_\-.]{1,300}$/;
const CLICK_KEYS = new Set(['gclid', 'gbraid', 'wbraid']);

export interface FirstTouch {
  params: Record<string, string>;
  landing: string;
}

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Só a lista fechada, valores curtos, sem `@`; identificadores de clique só com caracteres seguros. */
export function firstTouchParams(search: string): Record<string, string> {
  const from = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const key of CAMPAIGN_PARAMS) {
    const value = from.get(key)?.trim();
    if (!value || value.length > 150 || value.includes('@')) continue;
    if (CLICK_KEYS.has(key) && !CLICK_ID.test(value)) continue;
    out[key] = value;
  }
  return out;
}

function safeLanding(pathname: string): string {
  return /^\/[A-Za-z0-9_\-./]{0,199}$/.test(pathname) ? pathname : '/';
}

/** Na abertura de cada página: guarda a origem se ainda não houver uma nesta aba. */
export function captureFirstTouch(): void {
  if (typeof window === 'undefined') return;
  const storage = session();
  if (!storage || readFirstTouch()) return;
  const params = firstTouchParams(window.location.search);
  if (Object.keys(params).length === 0) return;
  try {
    storage.setItem(FIRST_TOUCH_KEY, JSON.stringify({ params, landing: safeLanding(window.location.pathname) } satisfies FirstTouch));
  } catch {
    // sem armazenamento: o cadastro sai sem origem
  }
}

export function readFirstTouch(): FirstTouch | null {
  const raw = session()?.getItem(FIRST_TOUCH_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FirstTouch>;
    if (!parsed.params || typeof parsed.params !== 'object') return null;
    const params = firstTouchParams(new URLSearchParams(parsed.params as Record<string, string>).toString());
    return Object.keys(params).length > 0 ? { params, landing: safeLanding(String(parsed.landing ?? '/')) } : null;
  } catch {
    return null;
  }
}

/** O que vai no POST de cadastro (ou nada, se a visita não veio de campanha). */
export function signupAttribution(): Record<string, string> | undefined {
  const touch = readFirstTouch();
  if (!touch) return undefined;
  return { ...touch.params, landing: touch.landing, consent: attributionConsent() };
}

/** `utm_content` da origem: decide a dica por segmento (salão, roupas...). */
export function originContent(): string | null {
  return readFirstTouch()?.params.utm_content ?? null;
}

/**
 * `landing.viewed` no analytics próprio, sem cookie e sem esperar o aceite:
 * é o primeiro degrau do funil (clique no anúncio → página aberta) e conta só
 * as UTMs e se houve clique, nunca o identificador.
 */
export function sendLandingViewed(): void {
  if (typeof window === 'undefined') return;
  const params = firstTouchParams(window.location.search);
  const properties: Record<string, string | boolean> = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const) {
    if (params[key]) properties[key] = params[key];
  }
  properties.has_click_id = Boolean(params.gclid || params.gbraid || params.wbraid);
  const versionCode = Number(APP_VERSION.split('.').map((part) => part.padStart(2, '0')).join('')) || 0;
  const body = JSON.stringify({
    device: { installId: installId(), platform: 'web', appVersionCode: versionCode },
    events: [{ id: newId(), name: 'landing.viewed', occurredAt: Date.now(), properties }],
  });
  void fetch('/v1/analytics/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => undefined);
}

/**
 * Segmento escolhido na tela de boas-vindas (quando a visita não veio de
 * anúncio por segmento). Fica só neste navegador: personaliza a dica do
 * estoque vazio e vai como propriedade de `onboarding.name_set`.
 */
const SEGMENT_KEY = 'es_segmento';
export const SEGMENTS = ['salao', 'roupas', 'mercearia', 'cosmeticos', 'outro'] as const;

export function setChosenSegment(segment: string | null): void {
  try {
    if (segment) localStorage.setItem(SEGMENT_KEY, segment);
    else localStorage.removeItem(SEGMENT_KEY);
  } catch {
    // sem armazenamento: segue sem a dica do segmento
  }
}

/** Segmento para personalizar textos: o do anúncio de origem ou o escolhido nas boas-vindas. */
export function segmentContent(): string | null {
  const fromAd = originContent();
  if (fromAd) return fromAd;
  try {
    const chosen = localStorage.getItem(SEGMENT_KEY);
    return chosen && (SEGMENTS as readonly string[]).includes(chosen) ? chosen : null;
  } catch {
    return null;
  }
}

/** Marcas deste navegador para a hora certa de pedir a confirmação do e-mail. */
const FIRST_PRODUCT_KEY = 'es_primeiro_produto';
export function markFirstProduct(): void {
  try {
    localStorage.setItem(FIRST_PRODUCT_KEY, '1');
  } catch {
    // sem armazenamento
  }
}

/**
 * O aviso "confirme seu e-mail" não aparece no primeiro contato: só depois do
 * primeiro produto ou a partir de 24 h de conta (a confirmação não é
 * necessária para usar; o passo que importa no começo é cadastrar produtos).
 */
export function emailReminderDue(createdAt: string, now = Date.now()): boolean {
  try {
    if (localStorage.getItem(FIRST_PRODUCT_KEY) === '1') return true;
  } catch {
    // sem armazenamento: vale só a idade da conta
  }
  const created = Date.parse(createdAt);
  return Number.isFinite(created) ? now - created >= 24 * 3_600_000 : true;
}
