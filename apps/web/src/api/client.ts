import { deviceInfo } from '../lib/device';
import type { WebAuth } from './types';

/**
 * Cliente HTTP da aplicação web.
 *
 * A API é a mesma do app Android, na mesma origem (`/v1`). O que muda é a
 * guarda da sessão: o refresh token mora num cookie `httpOnly` que o
 * JavaScript não enxerga, e o access token (15 min) fica só em memória —
 * nada de credencial em `localStorage`. Ao recarregar a página, a sessão é
 * retomada chamando `/v1/auth/web/refresh`.
 */

const CSRF = { 'x-requested-with': 'estoquesimples-web' };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Array<{ field?: string; message: string }>;
  /** Campos extras do erro (limite do plano, versão do servidor num conflito…). */
  readonly extra: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown> | null, fallback: string) {
    const error = (body?.['error'] ?? {}) as Record<string, unknown>;
    super(typeof error['message'] === 'string' ? (error['message'] as string) : fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = typeof error['code'] === 'string' ? (error['code'] as string) : status === 0 ? 'NETWORK' : 'UNKNOWN';
    this.details = Array.isArray(error['details']) ? (error['details'] as ApiError['details']) : [];
    this.extra = error;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }

  /** O plano não permite a ação (equipe, teto de produtos, análise). */
  get isPlanBlocked(): boolean {
    return this.code === 'SUBSCRIPTION_REQUIRED' || this.code === 'PLAN_LIMIT_REACHED';
  }

  fieldError(field: string): string | undefined {
    return this.details.find((detail) => detail.field === field)?.message;
  }
}

/** Mensagem pronta para a tela, qualquer que seja o erro. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isNetwork) return 'Sem conexão com o servidor. Confira a internet e tente de novo.';
    if (error.status === 429) return 'Muitas tentativas em pouco tempo. Aguarde um instante e tente de novo.';
    if (error.status >= 500 && error.code === 'UNKNOWN') return 'O servidor está indisponível no momento. Tente de novo em instantes.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'Algo deu errado. Tente de novo.';
}

export type QueryParams = Record<string, string | number | boolean | Date | null | undefined>;

function buildQuery(params?: QueryParams): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, value instanceof Date ? value.toISOString() : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------

let accessToken: string | null = null;
let accessExpiresAt = 0;
let refreshing: Promise<WebAuth | null> | null = null;

type SessionListener = (auth: WebAuth | null) => void;
const listeners = new Set<SessionListener>();

/** O AuthProvider se inscreve para saber quando a sessão nasce, renova ou cai. */
export function onSessionChange(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setSession(auth: WebAuth | null, notify = true): void {
  accessToken = auth?.accessToken ?? null;
  accessExpiresAt = auth ? Date.now() + auth.expiresIn * 1000 : 0;
  if (notify) for (const listener of listeners) listener(auth);
}

async function rawFetch(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  try {
    return await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, null, 'Sem conexão com o servidor.');
  }
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!response.ok) {
    throw new ApiError(response.status, json as Record<string, unknown> | null, `Erro ${response.status}`);
  }
  return json as T;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Renova a sessão a partir do cookie.
 *
 * Uma renovação por vez nesta aba (promessa compartilhada) e, entre abas,
 * uma por vez no navegador (Web Locks): o refresh token é de uso único e
 * duas abas apresentando o mesmo perderiam a sessão. Se ainda assim houver
 * corrida, a API responde 409 e a tentativa é refeita com o cookie novo.
 *
 * @returns a sessão renovada, ou `null` se não há sessão (cookie ausente,
 *   expirado ou revogado).
 */
export function refreshSession(): Promise<WebAuth | null> {
  if (refreshing) return refreshing;

  const attempt = async (): Promise<WebAuth | null> => {
    for (let tries = 0; tries < 4; tries += 1) {
      const response = await rawFetch('POST', '/v1/auth/web/refresh', undefined, CSRF);
      if (response.status === 409) {
        await sleep(350 * (tries + 1));
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        setSession(null);
        return null;
      }
      const auth = await parse<WebAuth>(response);
      setSession(auth);
      return auth;
    }
    throw new ApiError(409, null, 'Não foi possível renovar a sessão. Tente de novo.');
  };

  const locked = 'locks' in navigator ? navigator.locks.request('es-web-refresh', attempt) : attempt();
  refreshing = (locked as Promise<WebAuth | null>).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function ensureToken(): Promise<string> {
  // Renova um pouco antes de vencer, para a requisição não ir com token no limite.
  if (accessToken && Date.now() < accessExpiresAt - 30_000) return accessToken;
  const auth = await refreshSession();
  if (!auth) throw new ApiError(401, { error: { code: 'AUTH_REQUIRED', message: 'Sua sessão terminou. Entre novamente.' } }, 'Sessão encerrada.');
  return auth.accessToken;
}

interface RequestOptions {
  body?: unknown;
  query?: QueryParams;
  /** `false` para rotas públicas (login, convite, legal). */
  auth?: boolean;
  /** Mantém o Bearer se houver sessão, mas não exige (suporte, analytics). */
  optionalAuth?: boolean;
  headers?: Record<string, string>;
}

/**
 * 401 de senha conferida (trocar senha, excluir conta) não é sessão vencida:
 * renovar e repetir só mandaria a senha errada de novo.
 */
async function isWrongPassword(response: Response): Promise<boolean> {
  try {
    const body = (await response.clone().json()) as { error?: { code?: string } };
    return body.error?.code === 'AUTH_INVALID_CREDENTIALS';
  } catch {
    return false;
  }
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const url = `${path}${buildQuery(options.query)}`;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };

  if (options.auth !== false) {
    if (options.optionalAuth) {
      if (accessToken) headers['authorization'] = `Bearer ${await ensureToken().catch(() => '')}`.trim();
      if (headers['authorization'] === 'Bearer') delete headers['authorization'];
    } else {
      headers['authorization'] = `Bearer ${await ensureToken()}`;
    }
  }

  let response = await rawFetch(method, url, options.body, headers);

  // Token recusado no meio do caminho (expirou, papel mudou): renova uma vez
  // e repete. Se a renovação falhar, a sessão caiu de verdade.
  if (response.status === 401 && options.auth !== false && !options.optionalAuth && !(await isWrongPassword(response))) {
    accessToken = null;
    const auth = await refreshSession();
    if (auth) {
      headers['authorization'] = `Bearer ${auth.accessToken}`;
      response = await rawFetch(method, url, options.body, headers);
    }
  }
  return parse<T>(response);
}

export const api = {
  get: <T>(path: string, query?: QueryParams, options: Omit<RequestOptions, 'query' | 'body'> = {}) => request<T>('GET', path, { ...options, ...(query ? { query } : {}) }),
  post: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'body'> = {}) => request<T>('POST', path, { ...options, body: body ?? {} }),
  put: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'body'> = {}) => request<T>('PUT', path, { ...options, body: body ?? {} }),
  patch: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'body'> = {}) => request<T>('PATCH', path, { ...options, body: body ?? {} }),
  delete: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'body'> = {}) => request<T>('DELETE', path, { ...options, ...(body === undefined ? {} : { body }) }),
};

/** Baixa um arquivo autenticado (CSV, JSON) e entrega ao navegador. */
export async function download(path: string, filename: string, query?: QueryParams): Promise<void> {
  const token = await ensureToken();
  let response: Response;
  try {
    response = await fetch(`${path}${buildQuery(query)}`, { headers: { authorization: `Bearer ${token}` }, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, null, 'Sem conexão com o servidor.');
  }
  if (!response.ok) await parse(response);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------
// Entrada e saída da sessão
// ---------------------------------------------------------------------------

export const sessionApi = {
  async login(email: string, password: string): Promise<WebAuth> {
    const auth = await parse<WebAuth>(await rawFetch('POST', '/v1/auth/web/login', { email, password, device: deviceInfo() }, CSRF));
    setSession(auth);
    return auth;
  },
  async register(name: string, email: string, password: string): Promise<WebAuth> {
    const auth = await parse<WebAuth>(await rawFetch('POST', '/v1/auth/web/register', { name, email, password, device: deviceInfo() }, CSRF));
    setSession(auth);
    return auth;
  },
  /** Aceita um convite; quando a conta nasce agora, a sessão vem junto. */
  async acceptInvite(token: string, account?: { name: string; password: string }): Promise<{ workspaceId: string; roleKey: string; auth: WebAuth | null }> {
    const headers: Record<string, string> = { ...CSRF };
    if (accessToken) headers['authorization'] = `Bearer ${await ensureToken()}`;
    const result = await parse<{ workspaceId: string; roleKey: string; auth: WebAuth | null }>(
      await rawFetch('POST', `/v1/auth/web/invites/${encodeURIComponent(token)}/accept`, account ? { ...account, device: deviceInfo() } : {}, headers),
    );
    if (result.auth) setSession(result.auth);
    return result;
  },
  async logout(): Promise<void> {
    try {
      await rawFetch('POST', '/v1/auth/web/logout', {}, CSRF);
    } finally {
      setSession(null);
    }
  },
  /** Permissões mudaram no servidor (convite aceito, papel alterado): pega um token novo. */
  async renew(): Promise<void> {
    accessToken = null;
    await refreshSession();
  },
  hasToken(): boolean {
    return accessToken !== null;
  },
};
