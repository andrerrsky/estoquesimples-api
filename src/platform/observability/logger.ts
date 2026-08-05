import type { FastifyBaseLogger } from 'fastify';
import type { PinoLoggerOptions } from 'fastify/types/logger.js';

import type { Env } from '../config/env.js';

/**
 * Campos que jamais podem aparecer no log. A lista cobre tanto os nomes usados
 * pela nossa API quanto os que chegam de terceiros (Google Play, Pub/Sub).
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.purchaseToken',
  'req.body.inviteToken',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'refreshToken',
  'accessToken',
  'purchaseToken',
  'tokenHash',
  'authorization',
  '*.password',
  '*.refreshToken',
  '*.purchaseToken',
];

export function buildLoggerOptions(env: Env): PinoLoggerOptions {
  const base: PinoLoggerOptions = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    // O logger padrão do Fastify despeja o objeto inteiro de request/response.
    // Estes serializers mantêm só o que ajuda a investigar um incidente.
    serializers: {
      req(request: {
        method: string;
        url: string;
        id?: string;
        headers?: Record<string, unknown>;
        routeOptions?: { url?: string };
      }) {
        // Preferir o padrão da rota (`/invites/:token`) à URL concreta, que
        // carrega tokens de convite/reset em claro. Como rede de segurança,
        // também mascaramos segmentos esinv_* se o padrão não estiver disponível.
        const routePattern = request.routeOptions?.url;
        const rawUrl = request.url ?? '';
        const url =
          routePattern ??
          rawUrl.replace(/esinv_[A-Za-z0-9_-]+/g, 'esinv_[REDACTED]');
        return {
          method: request.method,
          url,
          requestId: request.id,
          appVersionCode: request.headers?.['x-app-version-code'],
          syncProtocol: request.headers?.['x-sync-protocol'],
        };
      },
      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode };
      },
    },
  };

  if (env.NODE_ENV === 'development') {
    return {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    };
  }

  if (env.NODE_ENV === 'test') {
    return { ...base, level: 'silent' };
  }

  return base;
}

export type Logger = FastifyBaseLogger;
