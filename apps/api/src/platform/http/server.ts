import cookie from '@fastify/cookie';
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
import { hkdfSync, randomUUID } from 'node:crypto';

import type { Env } from '../config/env.js';

import { registerAdminRoutes } from '../../modules/admin/admin.routes.js';
import { adminAuthPlugin } from '../../modules/admin/admin-auth.plugin.js';
import { registerAnalyticsRoutes } from '../../modules/analytics/analytics.routes.js';
import { registerAuthRoutes } from '../../modules/auth/auth.routes.js';
import { registerWebSessionRoutes } from '../../modules/auth/web-session.routes.js';
import { registerAsaasRoutes } from '../../modules/billing/asaas/asaas.routes.js';
import { registerBrandingRoutes } from '../../modules/branding/branding.routes.js';
import { registerImageRoutes } from '../../modules/images/images.routes.js';
import { registerInventoryRoutes } from '../../modules/inventory/inventory.routes.js';
import { registerNotificationRoutes } from '../../modules/notifications/notifications.routes.js';
import { registerPushRoutes } from '../../modules/push/push.routes.js';
import { registerErrorRoutes } from '../../modules/errors/errors.routes.js';
import { registerBlogRoutes } from '../../modules/blog/blog.routes.js';
import { registerSupportRoutes } from '../../modules/support/support.routes.js';
import { registerBillingRoutes } from '../../modules/billing/billing.routes.js';
import { registerInviteRoutes } from '../../modules/invites/invites.routes.js';
import { registerExportRoutes } from '../../modules/export/export.routes.js';
import { registerSyncRoutes } from '../../modules/sync/sync.routes.js';
import { registerOpsRoutes } from '../../modules/ops/ops.routes.js';
import { registerHealthRoutes } from '../../modules/platform-routes/health.routes.js';
import { registerUserRoutes } from '../../modules/users/users.routes.js';
import { registerPrivacyRoutes } from '../../modules/privacy/privacy.routes.js';
import { registerWorkspaceRoutes } from '../../modules/workspaces/workspaces.routes.js';
import { authenticatePlugin } from './authenticate.js';
import { registerErrorHandler } from './error-handler.js';
import { registerWebApp } from './web-app.js';
import { buildLoggerOptions } from '../observability/logger.js';
import { metricsPlugin } from '../observability/metrics-plugin.js';
import { AppError, ErrorCode } from './errors.js';
import type { AppServices } from './context.js';

/** Faixas de rede privada de onde vêm os proxies da hospedagem. */
const PRIVATE_PROXY_RANGES = ['loopback', 'linklocal', 'uniquelocal', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'];

/**
 * Proxies confiáveis (ver TRUST_PROXY em env.ts). Padrão: as faixas privadas
 * em produção; nenhum fora dela. Sem isso, atrás da borda todo pedido
 * anônimo pareceria vir do mesmo IP e o limite por IP viraria global.
 */
function resolveTrustProxy(env: Env): boolean | string[] {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) return env.NODE_ENV === 'production' ? PRIVATE_PROXY_RANGES : false;
  if (raw === 'false') return false;
  if (raw === 'private') return PRIVATE_PROXY_RANGES;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * Segredo que assina o cookie do painel. Sem ADMIN_COOKIE_SECRET, em
 * produção ele é derivado (HKDF) da chave privada do JWT, que é obrigatória
 * ali: nunca é aleatório, então as sessões sobrevivem a um restart e o
 * valor muda junto com a rotação da chave. Fora de produção, aleatório.
 */
function adminCookieSecret(env: Env): string {
  if (env.ADMIN_COOKIE_SECRET) return env.ADMIN_COOKIE_SECRET;
  if (env.JWT_PRIVATE_KEY) {
    return Buffer.from(hkdfSync('sha256', env.JWT_PRIVATE_KEY, 'estoquesimples', 'admin-cookie-secret', 48)).toString('base64url');
  }
  return randomUUID() + randomUUID();
}

export async function buildServer(services: AppServices): Promise<FastifyInstance> {
  const { env } = services;
  const production = env.NODE_ENV === 'production';

  const app = Fastify({
    logger: buildLoggerOptions(env),
    bodyLimit: env.BODY_LIMIT_BYTES,
    // Quem pode informar o IP do cliente em X-Forwarded-For: só os pares de
    // rede privada (a borda do Railway; o contêiner não recebe conexão direta
    // da internet). O IP do pedido é o último endereço público da cadeia; o
    // que o cliente escreve antes dele no cabeçalho é ignorado. `trustProxy`
    // numérico não serve: o Fastify o neutraliza (GHSA-3m5p-2c4r-xxw2).
    trustProxy: resolveTrustProxy(env),
    genReqId: (request) => {
      const header = request.headers['x-request-id'];
      if (typeof header === 'string' && header.length > 0 && header.length <= 128) return header;
      return randomUUID();
    },
  });

  app.decorate('services', services);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Aplicação web nos hosts públicos do produto. É um gancho por `Host` e
  // precisa vir antes de qualquer plugin ou rota: ganchos só valem para o
  // que é registrado depois deles, e nesses hosts nem a documentação nem o
  // painel podem responder. Sem `WEB_APP_HOSTS`, nada muda nesta instância.
  await registerWebApp(app);

  await app.register(helmet, {
    // Em produção a API só responde JSON (a documentação fica desligada):
    // nada ali deve carregar recurso nem ser embutido. O painel e a web têm
    // a própria CSP, que substitui esta. Fora de produção fica sem CSP para a
    // página de documentação funcionar.
    contentSecurityPolicy: production
      ? { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } }
      : false,
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

  // Cookies: sessão do painel administrativo (assinado com o segredo abaixo,
  // um valor adulterado é descartado antes de ir ao banco) e refresh token da
  // sessão web (opaco, não assinado, só nas rotas /v1/auth/web).
  if (!env.ADMIN_COOKIE_SECRET && env.ADMIN_PANEL_ENABLED && env.NODE_ENV !== 'test') {
    app.log.warn(
      'ADMIN_COOKIE_SECRET ausente: usando segredo efêmero; as sessões do painel não sobrevivem a um restart',
    );
  }
  await app.register(cookie, {
    secret: adminCookieSecret(env),
    hook: 'onRequest',
  });
  await app.register(adminAuthPlugin);

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
        { name: 'analytics', description: 'Eventos de uso do produto' },
        { name: 'push', description: 'Notificações push (token e entrega)' },
        { name: 'notificações', description: 'Caixa de notificações do usuário' },
        { name: 'support', description: 'Solicitações de suporte' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  // Documentação interativa: fora de produção, ou em produção só com DOCS_PUBLIC=true.
  if (!production || env.DOCS_PUBLIC) {
    await app.register(scalar, {
      routePrefix: '/docs',
      configuration: { title: 'Estoque Simples API' },
    });
  }

  registerErrorHandler(app);

  await app.register(registerHealthRoutes);
  await app.register(registerOpsRoutes);
  await app.register(registerAuthRoutes, { prefix: '/v1/auth' });
  await app.register(registerUserRoutes, { prefix: '/v1' });
  await app.register(registerPrivacyRoutes, { prefix: '/v1' });
  await app.register(registerWorkspaceRoutes, { prefix: '/v1' });
  await app.register(registerInviteRoutes, { prefix: '/v1' });
  await app.register(registerBillingRoutes, { prefix: '/v1' });
  await app.register(registerSyncRoutes, { prefix: '/v1' });
  await app.register(registerExportRoutes, { prefix: '/v1' });
  await app.register(registerAnalyticsRoutes, { prefix: '/v1' });
  await app.register(registerPushRoutes, { prefix: '/v1' });
  await app.register(registerErrorRoutes, { prefix: '/v1' });
  await app.register(registerBlogRoutes, { prefix: '/v1' });
  await app.register(registerSupportRoutes, { prefix: '/v1' });
  await app.register(registerWebSessionRoutes, { prefix: '/v1/auth' });
  await app.register(registerInventoryRoutes, { prefix: '/v1' });
  await app.register(registerNotificationRoutes, { prefix: '/v1' });
  await app.register(registerAsaasRoutes, { prefix: '/v1' });
  await app.register(registerImageRoutes, { prefix: '/v1' });
  await app.register(registerBrandingRoutes, { prefix: '/v1' });

  // Painel administrativo: API em /admin/api e a interface estática em /admin.
  if (env.ADMIN_PANEL_ENABLED) {
    await app.register(registerAdminRoutes, { prefix: '/admin' });
  }

  return app;
}
