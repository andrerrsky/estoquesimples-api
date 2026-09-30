import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { ErrorCode, forbidden } from '../../platform/http/errors.js';
import { requestMeta } from '../auth/auth.routes.js';
import {
  ADMIN_CSRF_HEADER,
  ADMIN_CSRF_VALUE,
  adminActor,
  adminCookieOptions,
  requireAdmin,
  requireAdminContext,
} from './admin-auth.plugin.js';
import {
  ADMIN_ROLES,
  adminLoginBodySchema,
  adminPublicSchema,
  commonAdminErrors,
  messageSchema,
  uuidParam,
} from './admin.schemas.js';

/**
 * Sessão do painel e gestão dos próprios administradores.
 *
 * O login tem o mesmo limite apertado das rotas de credencial do app: é o
 * alvo mais valioso do serviço inteiro.
 */
export async function registerAdminAuthRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const { env } = app.services;
  const service = app.adminAuth;

  const strictLimit = {
    config: {
      rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_WINDOW_MS },
    },
  };

  routes.post(
    '/auth/login',
    {
      ...strictLimit,
      schema: {
        tags: ['admin'],
        summary: 'Autentica um administrador e grava o cookie de sessão',
        hide: true,
        body: adminLoginBodySchema,
        response: { 200: z.object({ admin: adminPublicSchema, expiresAt: z.string() }), ...commonAdminErrors },
      },
    },
    async (request, reply) => {
      // O login não exige cookie, mas exige o cabeçalho anti-CSRF como toda
      // mutação: login forjado por outro site (login CSRF) também é ataque.
      requireCsrfHeader(request.headers);
      const result = await service.login(request.body, requestMeta(request));
      reply.setCookie(env.ADMIN_COOKIE_NAME, result.token, adminCookieOptions(env));
      return { admin: result.admin, expiresAt: result.expiresAt.toISOString() };
    },
  );

  routes.post(
    '/auth/logout',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Encerra a sessão do painel',
        hide: true,
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request, reply) => {
      await service.logout(requireAdminContext(request), requestMeta(request));
      reply.clearCookie(env.ADMIN_COOKIE_NAME, { path: '/admin' });
      return { message: 'Sessão encerrada.' };
    },
  );

  routes.get(
    '/auth/me',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Administrador autenticado',
        hide: true,
        response: {
          200: z.object({
            id: z.string().uuid(),
            email: z.string(),
            name: z.string(),
            role: z.enum(ADMIN_ROLES),
          }),
          ...commonAdminErrors,
        },
      },
    },
    async (request) => {
      const context = requireAdminContext(request);
      return { id: context.adminId, email: context.email, name: context.name, role: context.role };
    },
  );

  // -------------------------------------------------------------------------
  // Administradores (somente owner)
  // -------------------------------------------------------------------------

  routes.get(
    '/admins',
    {
      preHandler: requireAdmin('owner'),
      schema: {
        tags: ['admin'],
        summary: 'Lista os administradores do painel',
        hide: true,
        response: { 200: z.object({ items: z.array(adminPublicSchema) }), ...commonAdminErrors },
      },
    },
    async () => ({ items: await service.list() }),
  );

  routes.post(
    '/admins',
    {
      preHandler: requireAdmin('owner'),
      schema: {
        tags: ['admin'],
        summary: 'Cria um administrador',
        hide: true,
        body: z
          .object({
            email: z.string().trim().email().max(254),
            name: z.string().trim().min(1).max(120),
            password: z.string().min(10).max(200),
            role: z.enum(ADMIN_ROLES),
          })
          .strict(),
        response: { 201: adminPublicSchema, ...commonAdminErrors },
      },
    },
    async (request, reply) => {
      const created = await service.create(adminActor(request), request.body);
      return reply.code(201).send(created);
    },
  );

  routes.patch(
    '/admins/:adminId',
    {
      preHandler: requireAdmin('owner'),
      schema: {
        tags: ['admin'],
        summary: 'Altera nome, papel ou situação de um administrador',
        hide: true,
        params: uuidParam('adminId'),
        body: z
          .object({
            name: z.string().trim().min(1).max(120).optional(),
            role: z.enum(ADMIN_ROLES).optional(),
            status: z.enum(['active', 'disabled']).optional(),
          })
          .strict(),
        response: { 200: adminPublicSchema, ...commonAdminErrors },
      },
    },
    async (request) => service.update(adminActor(request), request.params.adminId, request.body),
  );

  routes.post(
    '/admins/:adminId/reset-password',
    {
      preHandler: requireAdmin('owner'),
      schema: {
        tags: ['admin'],
        summary: 'Define uma nova senha e encerra as sessões do administrador',
        hide: true,
        params: uuidParam('adminId'),
        body: z.object({ password: z.string().min(10).max(200) }).strict(),
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.resetPassword(adminActor(request), request.params.adminId, request.body.password);
      return { message: 'Senha redefinida.' };
    },
  );

  routes.post(
    '/admins/:adminId/revoke-sessions',
    {
      preHandler: requireAdmin('owner'),
      schema: {
        tags: ['admin'],
        summary: 'Encerra todas as sessões de um administrador',
        hide: true,
        params: uuidParam('adminId'),
        response: { 200: z.object({ message: z.string(), revokedSessions: z.number().int() }), ...commonAdminErrors },
      },
    },
    async (request) => {
      const revoked = await service.revokeAllSessions(adminActor(request), request.params.adminId);
      return { message: 'Sessões encerradas.', revokedSessions: revoked };
    },
  );
}

function requireCsrfHeader(headers: Record<string, unknown>): void {
  if (headers[ADMIN_CSRF_HEADER] !== ADMIN_CSRF_VALUE) {
    throw forbidden(ErrorCode.FORBIDDEN, 'Requisição sem cabeçalho de proteção.');
  }
}
