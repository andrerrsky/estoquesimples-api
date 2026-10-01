import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { resolveAuth } from '../../platform/http/authenticate.js';
import { AppError, ErrorCode, forbidden, unauthorized } from '../../platform/http/errors.js';
import { trackServerEvent } from '../analytics/analytics.service.js';
import { acceptInviteBodySchema, inviteTokenParamsSchema } from '../invites/invites.schemas.js';
import { InvitesService } from '../invites/invites.service.js';
import { requestMeta } from './auth.routes.js';
import { AuthService } from './auth.service.js';
import {
  authSuccessSchema,
  errorSchema,
  loginBodySchema,
  messageSchema,
  registerBodySchema,
  type AuthSuccess,
} from './auth.schemas.js';

export const WEB_CSRF_HEADER = 'x-requested-with';
export const WEB_CSRF_VALUE = 'estoquesimples-web';
/** Caminho do cookie: só as rotas de sessão o recebem. */
const COOKIE_PATH = '/v1/auth/web';

const webAuthSchema = authSuccessSchema.omit({ refreshToken: true });
const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 409: errorSchema, 429: errorSchema };

/**
 * Sessão da aplicação web.
 *
 * É a mesma sessão do app (mesmas tabelas, mesma rotação de refresh token,
 * mesma detecção de reuso) — só muda onde o refresh token mora. No navegador
 * ele fica num cookie `httpOnly` + `SameSite=Strict`, fora do alcance de
 * JavaScript: um XSS não consegue levá-lo embora. O access token (15 min) vai
 * no corpo e a página o guarda só em memória.
 *
 * Como o cookie é enviado sozinho pelo navegador, estas rotas exigem o
 * cabeçalho `x-requested-with` (que um formulário de outro site não consegue
 * mandar) e recusam requisições que o navegador marca como cross-site. As
 * demais rotas de `/v1` continuam autenticadas por Bearer e não usam cookie.
 */
export async function registerWebSessionRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new AuthService(app.services);
  const invites = new InvitesService(app.services);
  const { env } = app.services;

  const strictLimit = { config: { rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_WINDOW_MS } } };
  // A renovação acontece a cada 15 minutos por aba aberta: precisa de folga.
  const refreshLimit = { config: { rateLimit: { max: env.RATE_LIMIT_AUTH_MAX * 6, timeWindow: env.RATE_LIMIT_WINDOW_MS } } };

  const secure = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
  const cookieOptions = {
    path: COOKIE_PATH,
    httpOnly: true,
    secure,
    sameSite: 'strict' as const,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400,
  };

  function assertSameSite(request: FastifyRequest): void {
    if (request.headers[WEB_CSRF_HEADER] !== WEB_CSRF_VALUE) {
      throw forbidden(ErrorCode.FORBIDDEN, 'Requisição não reconhecida.');
    }
    // `Sec-Fetch-Site` é preenchido pelo navegador e não pode ser forjado por
    // scripts de outra origem.
    const fetchSite = request.headers['sec-fetch-site'];
    if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      throw forbidden(ErrorCode.FORBIDDEN, 'Requisição de outra origem.');
    }
  }

  function startSession(reply: FastifyReply, auth: AuthSuccess) {
    reply.setCookie(env.WEB_SESSION_COOKIE_NAME, auth.refreshToken, cookieOptions);
    const { refreshToken: _omitted, ...body } = auth;
    return body;
  }

  function readCookie(request: FastifyRequest): string | null {
    const value = request.cookies[env.WEB_SESSION_COOKIE_NAME];
    return typeof value === 'string' && value.length >= 20 ? value : null;
  }

  routes.post(
    '/web/login',
    {
      ...strictLimit,
      schema: { tags: ['auth'], summary: 'Login da aplicação web (refresh token em cookie httpOnly)', body: loginBodySchema, response: { 200: webAuthSchema, ...errors } },
    },
    async (request, reply) => {
      assertSameSite(request);
      const auth = await service.login({ ...request.body, device: webDevice(request.body.device) }, requestMeta(request));
      return startSession(reply, auth);
    },
  );

  routes.post(
    '/web/register',
    {
      ...strictLimit,
      schema: { tags: ['auth'], summary: 'Cadastro pela aplicação web', body: registerBodySchema, response: { 201: webAuthSchema, ...errors } },
    },
    async (request, reply) => {
      assertSameSite(request);
      const auth = await service.register({ ...request.body, device: webDevice(request.body.device) }, requestMeta(request));
      return reply.code(201).send(startSession(reply, auth));
    },
  );

  routes.post(
    '/web/refresh',
    {
      ...refreshLimit,
      schema: {
        tags: ['auth'],
        summary: 'Renova a sessão web a partir do cookie',
        description: 'Rotaciona o refresh token do cookie e devolve um novo access token. 401 = sem sessão; 409 `AUTH_REFRESH_IN_PROGRESS` = outra aba acabou de renovar, repita.',
        response: { 200: webAuthSchema, ...errors },
      },
    },
    async (request, reply) => {
      assertSameSite(request);
      const token = readCookie(request);
      if (!token) throw unauthorized(ErrorCode.AUTH_REQUIRED, 'Sem sessão.');
      try {
        const auth = await service.refresh(token, requestMeta(request), { reuseGraceSeconds: 20 });
        return startSession(reply, auth);
      } catch (error) {
        // Sessão encerrada, expirada ou token reutilizado: o cookie não serve
        // mais e sai junto. Na corrida entre abas ele já foi trocado e fica.
        if (error instanceof AppError && error.statusCode === 401) {
          reply.clearCookie(env.WEB_SESSION_COOKIE_NAME, { path: COOKIE_PATH });
        }
        throw error;
      }
    },
  );

  routes.post(
    '/web/logout',
    {
      schema: { tags: ['auth'], summary: 'Encerra a sessão web e apaga o cookie', response: { 200: messageSchema, ...errors } },
    },
    async (request, reply) => {
      assertSameSite(request);
      const token = readCookie(request);
      if (token) await service.logoutByRefreshToken(token, requestMeta(request));
      reply.clearCookie(env.WEB_SESSION_COOKIE_NAME, { path: COOKIE_PATH });
      return { message: 'Sessão encerrada.' };
    },
  );

  routes.post(
    '/web/invites/:token/accept',
    {
      ...strictLimit,
      schema: {
        tags: ['equipe'],
        summary: 'Aceita um convite pela web',
        description: 'Como `POST /v1/invites/:token/accept`; quando a conta é criada agora, a sessão nasce em cookie.',
        params: inviteTokenParamsSchema,
        body: acceptInviteBodySchema,
        response: {
          200: z.object({ workspaceId: z.string().uuid(), roleKey: z.string(), auth: webAuthSchema.nullable() }),
          ...errors,
        },
      },
    },
    async (request, reply) => {
      assertSameSite(request);
      const header = request.headers.authorization;
      const autenticado = header
        ? await resolveAuth(app.services, header).then((auth) => ({ userId: auth.userId, email: auth.email }))
        : null;
      const body = { ...request.body, ...(request.body.device ? { device: webDevice(request.body.device) } : {}) };
      const result = await invites.accept(request.params.token, body as typeof request.body, autenticado, requestMeta(request));

      const userId = result.auth?.user.id ?? autenticado?.userId ?? null;
      if (result.auth) {
        await trackServerEvent(app.services, {
          name: 'user.registered',
          userId,
          deviceId: result.auth.deviceId,
          properties: { origin: 'convite', platform: 'web' },
        });
      }
      await trackServerEvent(app.services, {
        name: 'invite.accepted',
        userId,
        workspaceId: result.workspaceId,
        properties: { roleKey: result.roleKey, newAccount: result.auth !== null, platform: 'web' },
      });
      return { workspaceId: result.workspaceId, roleKey: result.roleKey, auth: result.auth ? startSession(reply, result.auth) : null };
    },
  );
}

/** A sessão que nasce por estas rotas é sempre de navegador. */
function webDevice<T extends { platform?: string } | undefined>(device: T): T {
  return device ? ({ ...device, platform: 'web' } as T) : device;
}
