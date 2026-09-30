import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';

import { ErrorCode, forbidden, notFound, unauthorized } from '../../platform/http/errors.js';
import { AdminAuthService, hasAdminRole, type AdminContext } from './admin-auth.service.js';
import type { AdminActor } from './admin-audit.service.js';
import type { AdminRole } from './admin.schemas.js';

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminContext;
  }
  interface FastifyInstance {
    adminAuth: AdminAuthService;
  }
}

/**
 * Autenticação do painel administrativo.
 *
 * Cookie httpOnly + SameSite=Strict, assinado, com token opaco cujo hash fica
 * no banco. Diferente da API do app (Bearer/JWT), aqui o cliente é um
 * navegador: cookie httpOnly impede que um XSS roube a sessão, e SameSite
 * Strict impede que outro site a use. Como camada extra contra CSRF, toda
 * requisição que altera estado precisa do cabeçalho `x-requested-with`, que
 * um formulário cross-site não consegue enviar sem preflight.
 */
export const adminAuthPlugin = fp(async (app) => {
  const service = new AdminAuthService(app.services);
  app.decorate('adminAuth', service);
});

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const ADMIN_CSRF_HEADER = 'x-requested-with';
export const ADMIN_CSRF_VALUE = 'estoquesimples-admin';

function assertSameOrigin(request: FastifyRequest): void {
  if (!MUTATING_METHODS.has(request.method)) return;

  if (request.headers[ADMIN_CSRF_HEADER] !== ADMIN_CSRF_VALUE) {
    throw forbidden(ErrorCode.FORBIDDEN, 'Requisição sem cabeçalho de proteção.');
  }

  // `Sec-Fetch-Site` é enviado por todos os navegadores modernos e não pode
  // ser forjado por scripts. `none` cobre a navegação direta (digitar a URL).
  const fetchSite = request.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw forbidden(ErrorCode.FORBIDDEN, 'Requisição de outra origem.');
  }
}

/**
 * preHandler que exige um administrador autenticado com, no mínimo, o papel
 * informado. `viewer` lê; `support` opera contas; `owner` administra o painel.
 */
export function requireAdmin(minimum: AdminRole = 'viewer'): preHandlerHookHandler {
  return async function adminGuard(request: FastifyRequest, _reply: FastifyReply) {
    const { env } = request.server.services;
    if (!env.ADMIN_PANEL_ENABLED) throw notFound('Recurso não encontrado');

    assertSameOrigin(request);

    const raw = request.cookies[env.ADMIN_COOKIE_NAME];
    if (!raw) throw unauthorized(ErrorCode.AUTH_REQUIRED, 'Autenticação obrigatória.');

    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) {
      throw unauthorized(ErrorCode.AUTH_TOKEN_INVALID, 'Sessão inválida.');
    }

    const context = await request.server.adminAuth.resolveSession(unsigned.value);
    if (!hasAdminRole(context, minimum)) {
      throw forbidden(ErrorCode.MISSING_PERMISSION, 'Seu papel não permite esta ação.', {
        requiredRole: minimum,
        role: context.role,
      });
    }

    request.admin = context;
  };
}

export function requireAdminContext(request: FastifyRequest): AdminContext {
  if (!request.admin) throw unauthorized(ErrorCode.AUTH_REQUIRED, 'Autenticação obrigatória.');
  return request.admin;
}

export function adminActor(request: FastifyRequest): AdminActor {
  const context = requireAdminContext(request);
  return { adminId: context.adminId, email: context.email, ipAddress: request.ip || null };
}

export function adminCookieOptions(env: { NODE_ENV: string; ADMIN_SESSION_MAX_DAYS: number }) {
  const secure = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
  return {
    path: '/admin',
    httpOnly: true,
    secure,
    sameSite: 'strict' as const,
    signed: true,
    maxAge: env.ADMIN_SESSION_MAX_DAYS * 86_400,
  };
}
