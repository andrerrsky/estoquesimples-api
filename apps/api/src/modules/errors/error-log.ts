import { createHash } from 'node:crypto';

import { lt, sql } from 'drizzle-orm';

import { errorEvents } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';

/**
 * Registro de erros de produção, guardado no próprio banco e lido no painel
 * (Admin › Erros). Sem serviço de terceiros: a CSP da web só fala com a
 * própria origem, e os dados de uso ficam onde os demais já estão.
 *
 * Nada aqui pode derrubar quem chamou: gravar o erro é melhor esforço. O que
 * entra é limitado e higienizado (sem corpo de requisição, sem tokens, sem
 * e-mail nas mensagens).
 */

export type ErrorSource = 'api' | 'web' | 'android' | 'admin';
export type ErrorLevel = 'error' | 'warning' | 'fatal';

export interface ErrorEventInput {
  source: ErrorSource;
  level?: ErrorLevel;
  kind: string;
  code?: string | null;
  message: string;
  stack?: string | null;
  httpMethod?: string | null;
  route?: string | null;
  status?: number | null;
  correlationId?: string | null;
  userId?: string | null;
  workspaceId?: string | null;
  deviceId?: string | null;
  appVersion?: string | null;
  platform?: string | null;
  userAgent?: string | null;
  occurredAt?: Date;
  context?: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tira dados pessoais e segredos que costumam aparecer em mensagens de erro. */
export function scrub(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b(Bearer|token|senha|password|secret|key)([=:\s"']+)[^\s"'&,)]+/gi, '$1$2<oculto>')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt>');
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const clean = scrub(String(value));
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Agrupa ocorrências do mesmo erro: origem, código, mensagem sem números e
 * ids, e a primeira linha útil da pilha. Assim "produto 123" e "produto 456"
 * caem no mesmo grupo.
 */
export function fingerprintOf(input: Pick<ErrorEventInput, 'source' | 'kind' | 'code' | 'message' | 'stack' | 'route'>): string {
  const message = input.message
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .slice(0, 200);
  const frame = (input.stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('at ') || /^\w.*\(.*:\d+/.test(line) || /@.*:\d+/.test(line))
    ?.replace(/:\d+(:\d+)?/g, '')
    .replace(/[?#].*$/, '') ?? '';
  const route = (input.route ?? '').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id').replace(/\/\d+/g, '/:n');
  return createHash('sha1').update([input.source, input.kind, input.code ?? '', message, frame, input.kind === 'api' ? route : ''].join('|')).digest('hex').slice(0, 20);
}

function safeContext(context: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!context) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context).slice(0, 20)) {
    if (/senha|password|token|secret|authorization|cookie/i.test(key)) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') out[key.slice(0, 40)] = value;
    else out[key.slice(0, 40)] = clip(String(value), 300);
  }
  return out;
}

export async function recordError(services: AppServices, input: ErrorEventInput): Promise<void> {
  try {
    const message = clip(input.message, 1000) || '(sem mensagem)';
    const stack = clip(input.stack, 8000);
    await services.db.insert(errorEvents).values({
      source: input.source,
      level: input.level ?? 'error',
      kind: input.kind.slice(0, 40),
      fingerprint: fingerprintOf({ ...input, message, stack }),
      code: clip(input.code, 80),
      message,
      stack,
      httpMethod: clip(input.httpMethod, 10),
      route: clip(input.route, 300),
      status: input.status ?? null,
      correlationId: clip(input.correlationId, 80),
      userId: input.userId && UUID.test(input.userId) ? input.userId : null,
      workspaceId: input.workspaceId && UUID.test(input.workspaceId) ? input.workspaceId : null,
      deviceId: input.deviceId && UUID.test(input.deviceId) ? input.deviceId : null,
      appVersion: clip(input.appVersion, 40),
      platform: clip(input.platform, 80),
      userAgent: clip(input.userAgent, 300),
      occurredAt: input.occurredAt && !Number.isNaN(input.occurredAt.getTime()) ? input.occurredAt : new Date(),
      context: safeContext(input.context),
    });
  } catch (error) {
    // Sem banco não há onde guardar: fica o log do Railway, que sempre existe.
    services.logger?.error({ err: error, original: input.message }, 'não foi possível registrar o erro');
  }
}

/** Retenção: o painel serve para investigar o que está acontecendo agora. */
export async function purgeOldErrors(services: AppServices, days = 30): Promise<number> {
  const result = await services.db
    .delete(errorEvents)
    .where(lt(errorEvents.occurredAt, sql`now() - make_interval(days => ${days})`))
    .returning({ id: errorEvents.id });
  return result.length;
}
