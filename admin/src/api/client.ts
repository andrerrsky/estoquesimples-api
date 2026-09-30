/**
 * Cliente HTTP do painel.
 *
 * A sessão vive num cookie httpOnly; o navegador o envia sozinho. O que o
 * código precisa garantir é o cabeçalho anti-CSRF em toda mutação e a
 * tradução do envelope de erro da API para uma exceção com código estável.
 */
export const API_BASE = '/admin/api';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'estoquesimples-admin';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Array<{ field?: string; message: string }>;
  readonly extra: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown> | null, fallback: string) {
    const error = (body?.['error'] ?? {}) as Record<string, unknown>;
    super(typeof error['message'] === 'string' ? (error['message'] as string) : fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = typeof error['code'] === 'string' ? (error['code'] as string) : 'UNKNOWN';
    this.details = Array.isArray(error['details']) ? (error['details'] as ApiError['details']) : [];
    this.extra = error;
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** O AuthProvider se inscreve aqui para derrubar a sessão local num 401. */
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
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

async function request<T>(method: string, path: string, options: { params?: QueryParams; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers[CSRF_HEADER] = CSRF_VALUE;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}${buildQuery(options.params)}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, null, 'Sem conexão com a API. Verifique a rede e tente de novo.');
  }

  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/login')) {
      for (const listener of unauthorizedListeners) listener();
    }
    throw new ApiError(response.status, body, `Erro ${response.status} ao chamar a API.`);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, params?: QueryParams) => request<T>('GET', path, { params }),
  post: <T>(path: string, body?: unknown, params?: QueryParams) => request<T>('POST', path, { body, params }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface SeriesPoint {
  t: string;
  v: number;
}
