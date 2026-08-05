import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';

import { registerAuthRoutes } from '../../modules/auth/auth.routes.js';
import { registerBillingRoutes } from '../../modules/billing/billing.routes.js';
import { registerInviteRoutes } from '../../modules/invites/invites.routes.js';
import { registerSyncRoutes } from '../../modules/sync/sync.routes.js';
import { registerOpsRoutes } from '../../modules/ops/ops.routes.js';
import { registerHealthRoutes } from '../../modules/platform-routes/health.routes.js';
import { registerUserRoutes } from '../../modules/users/users.routes.js';
import { registerWorkspaceRoutes } from '../../modules/workspaces/workspaces.routes.js';
import { authenticatePlugin } from './authenticate.js';
import { registerErrorHandler } from './error-handler.js';
import { buildLoggerOptions } from '../observability/logger.js';
import { metricsPlugin } from '../observability/metrics-plugin.js';
import { AppError, ErrorCode } from './errors.js';
import type { AppServices } from './context.js';

export async function buildServer(services: AppServices): Promise<FastifyInstance> {
  const { env } = services;

  const app = Fastify({
    logger: buildLoggerOptions(env),
    bodyLimit: env.BODY_LIMIT_BYTES,
    // Confia em exatamente um hop de proxy (a borda do Railway). `true`
    // aceitaria qualquer X-Forwarded-For enviado pelo cliente e anularia o
    // rate limit por IP — além de envenenar a auditoria.
    trustProxy: 1,
    genReqId: (request) => {
      const header = request.headers['x-request-id'];
      if (typeof header === 'string' && header.length > 0 && header.length <= 128) return header;
      return randomUUID();
    },
  });

  app.decorate('services', services);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    // A API serve JSON para um app nativo; a CSP padrão do helmet só
    // atrapalharia a página de documentação.
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
    credentials: true,
    maxAge: 86_400,
  });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    // preHandler roda depois do authenticate, então request.auth já existe.
    // No onRequest padrão o userId era sempre undefined e tudo virava por IP.
    hook: 'preHandler',
    // Usuário autenticado é limitado por conta; anônimo, por IP. Sem isso,
    // uma empresa inteira atrás de um NAT compartilharia a mesma cota.
    keyGenerator: (request) => request.auth?.userId ?? request.ip,
    // O plugin lança o retorno deste builder. Devolvendo um AppError, o
    // estouro de limite passa pelo mesmo formatador de erros de todo o resto
    // e o cliente recebe sempre o mesmo envelope.
    errorResponseBuilder: (_request, context) =>
      new AppError(429, ErrorCode.RATE_LIMITED, 'Muitas requisições. Tente novamente em instantes.', {
        extra: { retryAfterSeconds: Math.ceil(context.ttl / 1000) },
      }),
  });

  await app.register(authenticatePlugin);
  await app.register(metricsPlugin);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Estoque Simples API',
        version: '1.0.0',
        description:
          'API de sincronização em nuvem do Estoque Simples.\n\n' +
          'Todos os endpoints de negócio são isolados por workspace e exigem autenticação. ' +
          'O aplicativo continua funcionando integralmente offline: esta API é uma camada ' +
          'adicional para assinantes.',
      },
      servers: [{ url: '/', description: 'Servidor atual' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      tags: [
        { name: 'infra', description: 'Health checks e configuração remota' },
        { name: 'auth', description: 'Cadastro, login e gestão de credenciais' },
        { name: 'usuário', description: 'Perfil, sessões e dispositivos' },
        { name: 'workspace', description: 'Empresas, membros e permissões' },
        { name: 'convites', description: 'Convites de membros' },
        { name: 'assinatura', description: 'Google Play e direitos de acesso' },
        { name: 'sincronização', description: 'Upload inicial, push, pull e conflitos' },
        { name: 'estoque', description: 'Produtos e movimentações' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(scalar, {
    routePrefix: '/docs',
    configuration: { title: 'Estoque Simples API' },
  });

  registerErrorHandler(app);

  await app.register(registerHealthRoutes);
  await app.register(registerOpsRoutes);
  await app.register(registerAuthRoutes, { prefix: '/v1/auth' });
  await app.register(registerUserRoutes, { prefix: '/v1' });
  await app.register(registerWorkspaceRoutes, { prefix: '/v1' });
  await app.register(registerInviteRoutes, { prefix: '/v1' });
  await app.register(registerBillingRoutes, { prefix: '/v1' });
  await app.register(registerSyncRoutes, { prefix: '/v1' });

  return app;
}
