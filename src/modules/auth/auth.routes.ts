import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAuth } from '../../platform/http/authenticate.js';
import { AuthService, type RequestMeta } from './auth.service.js';
import {
  authSuccessSchema,
  changePasswordBodySchema,
  errorSchema,
  forgotPasswordBodySchema,
  loginBodySchema,
  logoutBodySchema,
  messageSchema,
  refreshBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
  verifyEmailBodySchema,
} from './auth.schemas.js';

export function requestMeta(request: FastifyRequest): RequestMeta {
  return {
    ipAddress: request.ip || null,
    userAgent: request.headers['user-agent']?.slice(0, 500) ?? null,
  };
}

const commonErrors = {
  400: errorSchema,
  401: errorSchema,
  409: errorSchema,
  429: errorSchema,
};

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new AuthService(app.services);

  // Endpoints de credencial recebem um limite bem mais apertado que o global:
  // são o alvo natural de força bruta e de enumeração de contas.
  const strictLimit = {
    config: {
      rateLimit: {
        max: app.services.env.RATE_LIMIT_AUTH_MAX,
        timeWindow: app.services.env.RATE_LIMIT_WINDOW_MS,
      },
    },
  };

  routes.post(
    '/register',
    {
      ...strictLimit,
      schema: {
        tags: ['auth'],
        summary: 'Cria uma conta e já devolve uma sessão autenticada',
        body: registerBodySchema,
        response: { 201: authSuccessSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const result = await service.register(request.body, requestMeta(request));
      return reply.code(201).send(result);
    },
  );

  routes.post(
    '/login',
    {
      ...strictLimit,
      schema: {
        tags: ['auth'],
        summary: 'Autentica com e-mail e senha',
        body: loginBodySchema,
        response: { 200: authSuccessSchema, ...commonErrors },
      },
    },
    async (request) => service.login(request.body, requestMeta(request)),
  );

  routes.post(
    '/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Rotaciona o refresh token e emite um novo access token',
        description:
          'O refresh token apresentado é consumido. Reapresentá-lo indica roubo e encerra a sessão.',
        body: refreshBodySchema,
        response: { 200: authSuccessSchema, ...commonErrors },
      },
    },
    async (request) => service.refresh(request.body.refreshToken, requestMeta(request)),
  );

  routes.post(
    '/logout',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['auth'],
        summary: 'Encerra a sessão atual',
        security: [{ bearerAuth: [] }],
        body: logoutBodySchema,
        response: { 200: messageSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await service.logout(auth.sessionId, auth.userId, requestMeta(request));
      return { message: 'Sessão encerrada.' };
    },
  );

  routes.post(
    '/logout-all',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['auth'],
        summary: 'Encerra todas as sessões, inclusive a atual',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({ message: z.string(), revokedSessions: z.number().int() }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const revoked = await service.logoutAll(auth.userId, {}, requestMeta(request));
      return { message: 'Todas as sessões foram encerradas.', revokedSessions: revoked };
    },
  );

  routes.post(
    '/forgot-password',
    {
      ...strictLimit,
      schema: {
        tags: ['auth'],
        summary: 'Solicita um código de redefinição de senha',
        description:
          'Responde 202 mesmo quando o e-mail não existe, para não permitir descobrir quais contas estão cadastradas.',
        body: forgotPasswordBodySchema,
        response: { 202: messageSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      await service.requestPasswordReset(request.body.email, requestMeta(request));
      return reply
        .code(202)
        .send({ message: 'Se houver uma conta com este e-mail, enviaremos as instruções.' });
    },
  );

  routes.post(
    '/reset-password',
    {
      ...strictLimit,
      schema: {
        tags: ['auth'],
        summary: 'Redefine a senha com o código recebido por e-mail',
        description: 'Encerra todas as sessões do usuário.',
        body: resetPasswordBodySchema,
        response: { 200: messageSchema, ...commonErrors },
      },
    },
    async (request) => {
      await service.resetPassword(
        request.body.token,
        request.body.newPassword,
        requestMeta(request),
      );
      return { message: 'Senha redefinida. Faça login novamente.' };
    },
  );

  routes.post(
    '/change-password',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['auth'],
        summary: 'Altera a senha do usuário autenticado',
        security: [{ bearerAuth: [] }],
        body: changePasswordBodySchema,
        response: { 200: messageSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await service.changePassword(
        auth.userId,
        auth.sessionId,
        request.body,
        requestMeta(request),
      );
      return { message: 'Senha alterada.' };
    },
  );

  routes.post(
    '/verify-email',
    {
      schema: {
        tags: ['auth'],
        summary: 'Confirma o e-mail com o código enviado',
        body: verifyEmailBodySchema,
        response: { 200: messageSchema, ...commonErrors },
      },
    },
    async (request) => {
      await service.verifyEmail(request.body.token, requestMeta(request));
      return { message: 'E-mail confirmado.' };
    },
  );

  routes.post(
    '/resend-verification',
    {
      ...strictLimit,
      preHandler: app.authenticate,
      schema: {
        tags: ['auth'],
        summary: 'Reenvia o código de verificação de e-mail',
        security: [{ bearerAuth: [] }],
        response: { 202: messageSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await service.resendEmailVerification(auth.userId);
      return reply.code(202).send({ message: 'Código reenviado, se ainda houver pendência.' });
    },
  );
}
