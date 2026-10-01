import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { sessions, users } from '../db/schema/index.js';
import { ErrorCode, unauthorized } from './errors.js';
import type { AppServices, AuthContext } from './context.js';

/**
 * Autenticação por Bearer token.
 *
 * Além de validar a assinatura do JWT, cada requisição confirma no banco que
 * a sessão continua ativa e que a versão de permissão do usuário não mudou.
 * É uma consulta indexada por requisição, e é o que torna a revogação
 * imediata: sem ela, um token roubado continuaria valendo até expirar, e a
 * remoção de um membro só surtiria efeito 15 minutos depois.
 */
export async function resolveAuth(
  services: AppServices,
  authorizationHeader: string | undefined,
): Promise<AuthContext> {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    throw unauthorized(ErrorCode.AUTH_REQUIRED, 'Autenticação obrigatória.');
  }

  const token = authorizationHeader.slice('Bearer '.length).trim();
  if (!token) {
    throw unauthorized(ErrorCode.AUTH_REQUIRED, 'Autenticação obrigatória.');
  }

  const claims = await services.tokens.verifyAccessToken(token);

  const rows = await services.db
    .select({
      sessionId: sessions.id,
      sessionRevokedAt: sessions.revokedAt,
      sessionExpiresAt: sessions.expiresAt,
      deviceId: sessions.deviceId,
      userId: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      permissionVersion: users.permissionVersion,
      status: users.status,
      deletedAt: users.deletedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, claims.sid), eq(sessions.userId, claims.sub)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw unauthorized(ErrorCode.AUTH_SESSION_REVOKED, 'Sessão não encontrada.');
  }
  if (row.sessionRevokedAt) {
    throw unauthorized(ErrorCode.AUTH_SESSION_REVOKED, 'Sessão encerrada. Faça login novamente.');
  }
  if (row.sessionExpiresAt.getTime() <= Date.now()) {
    throw unauthorized(ErrorCode.AUTH_SESSION_REVOKED, 'Sessão expirada. Faça login novamente.');
  }
  if (row.deletedAt || row.status === 'pending_deletion') {
    throw unauthorized(ErrorCode.AUTH_SESSION_REVOKED, 'Conta indisponível.');
  }
  if (row.status === 'suspended') {
    throw unauthorized(ErrorCode.AUTH_ACCOUNT_SUSPENDED, 'Conta suspensa.');
  }

  // Trocar a senha ou o papel do usuário invalida os tokens já emitidos.
  if (row.permissionVersion !== claims.ver) {
    throw unauthorized(
      ErrorCode.AUTH_PERMISSION_STALE,
      'Suas permissões mudaram. Renove o token de acesso.',
    );
  }

  return {
    userId: row.userId,
    sessionId: row.sessionId,
    permissionVersion: row.permissionVersion,
    deviceId: row.deviceId,
    email: row.email,
    emailVerified: row.emailVerifiedAt !== null,
  };
}

export const authenticatePlugin = fp(async (app) => {
  app.decorate('authenticate', async function authenticate(
    request: FastifyRequest,
    _reply: FastifyReply,
  ) {
    request.auth = await resolveAuth(app.services, request.headers.authorization);
  });
});

/** Acesso à identidade autenticada com garantia de tipo dentro do handler. */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) {
    throw unauthorized(ErrorCode.AUTH_REQUIRED, 'Autenticação obrigatória.');
  }
  return request.auth;
}

/** Sessões ativas de um usuário, usado por /me/sessions e no logout global. */
export async function listActiveSessions(services: AppServices, userId: string) {
  return services.db
    .select({
      id: sessions.id,
      deviceId: sessions.deviceId,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .orderBy(sessions.lastUsedAt);
}
