import { APP_VERSION } from './device';

/**
 * Envia para a API (`POST /v1/client-errors`) os erros que acontecem na web e
 * no web app: exceções de JavaScript, promessas rejeitadas sem tratamento,
 * telas que quebram e respostas 5xx da API. Aparecem no painel em
 * Admin › Erros, com a versão, a tela e o código que a pessoa viu.
 *
 * Melhor esforço e barato: fila curta, envio agrupado, no máximo 20 erros
 * por carregamento da página e o mesmo erro uma vez só. Nunca manda o que foi
 * digitado em formulários; a API ainda limpa e-mails e tokens das mensagens.
 */

type Kind = 'exception' | 'unhandled_rejection' | 'render' | 'api';

interface ClientError {
  source: 'web';
  level: 'error' | 'warning';
  kind: Kind;
  code?: string | null;
  message: string;
  stack?: string | null;
  route: string;
  httpMethod?: string | null;
  status?: number | null;
  correlationId?: string | null;
  workspaceId?: string | null;
  appVersion: string;
  platform: string;
  occurredAt: number;
  context?: Record<string, string | number | boolean | null>;
}

const MAX_PER_PAGE = 20;
let sent = 0;
const seen = new Set<string>();
let queue: ClientError[] = [];
let timer: number | null = null;
let tokenOf: () => string | null = () => null;
let workspaceOf: () => string | null = () => null;

/** O cliente HTTP informa o token atual (o erro fica ligado à pessoa, quando há sessão). */
export function setErrorReporterAuth(getToken: () => string | null): void {
  tokenOf = getToken;
}

export function setErrorReporterWorkspace(getWorkspace: () => string | null): void {
  workspaceOf = getWorkspace;
}

function platform(): string {
  if (typeof window === 'undefined') return 'web';
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone ? 'web app' : 'navegador';
}

function flush(): void {
  timer = null;
  if (queue.length === 0) return;
  const errors = queue.splice(0, 20);
  const token = tokenOf();
  try {
    void fetch('/v1/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ errors }),
      credentials: 'omit',
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // sem rede: o erro se perde, a página continua
  }
}

export function reportError(input: Omit<ClientError, 'source' | 'level' | 'route' | 'appVersion' | 'platform' | 'occurredAt' | 'workspaceId'> & { level?: 'error' | 'warning' }): void {
  if (typeof window === 'undefined' || sent >= MAX_PER_PAGE) return;
  const key = `${input.kind}|${input.code ?? ''}|${input.message}|${input.status ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  sent += 1;
  queue.push({
    source: 'web',
    level: input.level ?? 'error',
    ...input,
    message: input.message.slice(0, 2000),
    stack: input.stack?.slice(0, 16000) ?? null,
    route: window.location.pathname,
    workspaceId: workspaceOf(),
    appVersion: APP_VERSION,
    platform: platform(),
    occurredAt: Date.now(),
  });
  if (timer === null) timer = window.setTimeout(flush, 1500);
}

export function reportException(error: unknown, kind: Kind = 'exception'): void {
  const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error ?? null));
  reportError({ kind, code: err.name, message: `${err.name}: ${err.message}`, stack: err.stack ?? null });
}

/** Resposta 5xx (ou corpo ilegível) da API: guarda o código que o servidor deu. */
export function reportApiFailure(input: { method?: string; path: string; status: number; code: string; message: string; correlationId?: string | null }): void {
  reportError({
    kind: 'api',
    code: input.code,
    message: `${input.status} ${input.code}: ${input.message}`,
    httpMethod: input.method ?? null,
    status: input.status,
    correlationId: input.correlationId ?? null,
    context: { endpoint: input.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id').slice(0, 200) },
  });
}

/** Erros de carregamento de pedaço do app depois de um deploy não são defeito: a tela já pede para recarregar. */
function ignorable(message: string): boolean {
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ResizeObserver loop|Load failed$/i.test(message);
}

export function installGlobalErrorReporting(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    // Erro de recurso (imagem, script de terceiro) não tem `error`; só exceções.
    if (!event.error && !event.message) return;
    const message = event.error instanceof Error ? event.error.message : String(event.message);
    if (ignorable(message)) return;
    reportException(event.error ?? new Error(message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as unknown;
    const message = reason instanceof Error ? reason.message : String(reason);
    // Falhas da API já foram registradas na resposta (as 5xx); as demais são esperadas.
    if (reason && typeof reason === 'object' && (reason as { name?: string }).name === 'ApiError') return;
    if (ignorable(message)) return;
    reportException(reason, 'unhandled_rejection');
  });
  window.addEventListener('pagehide', flush);
}
