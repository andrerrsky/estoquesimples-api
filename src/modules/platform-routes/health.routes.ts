import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { appConfig } from '../../platform/db/schema/index.js';
import { hasPendingMigrations } from '../../platform/db/migrate.js';

const startedAt = Date.now();

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const { db, dbHandle, env } = app.services;

  /**
   * Identificação mínima: quem abre a URL no navegador não deveria ver um 404
   * e achar que o serviço está fora do ar.
   */
  routes.get(
    '/',
    {
      schema: {
        tags: ['infra'],
        summary: 'Identificação do serviço',
        response: {
          200: z.object({
            service: z.string(),
            docs: z.string(),
            health: z.string(),
            ready: z.string(),
          }),
        },
      },
    },
    async () => ({
      service: 'estoquesimples-api',
      docs: '/docs',
      health: '/health',
      ready: '/ready',
    }),
  );

  /**
   * Liveness: responde sem tocar no banco.
   *
   * Se dependesse do Postgres, uma indisponibilidade momentânea do banco faria
   * o orquestrador reiniciar a API — que é exatamente o que não se quer, já
   * que reiniciar não conserta um banco fora do ar.
   */
  routes.get(
    '/health',
    {
      schema: {
        tags: ['infra'],
        summary: 'Liveness check',
        response: {
          200: z.object({
            status: z.literal('ok'),
            uptimeSeconds: z.number(),
            version: z.string(),
          }),
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      version: process.env['npm_package_version'] ?? '0.1.0',
    }),
  );

  /**
   * Readiness: só reporta pronto se o banco responde e o schema está em dia.
   * Serve migration pendente é a receita para erros de coluna inexistente.
   */
  routes.get(
    '/ready',
    {
      schema: {
        tags: ['infra'],
        summary: 'Readiness check',
        response: {
          200: z.object({
            status: z.literal('ready'),
            checks: z.object({ database: z.boolean(), migrations: z.boolean() }),
          }),
          503: z.object({
            status: z.literal('not_ready'),
            checks: z.object({ database: z.boolean(), migrations: z.boolean() }),
          }),
        },
      },
    },
    async (_request, reply) => {
      let database = false;
      let migrations = false;

      try {
        await db.execute(sql`SELECT 1`);
        database = true;
        migrations = !(await hasPendingMigrations(dbHandle.pool));
      } catch {
        database = false;
      }

      const checks = { database, migrations };
      if (database && migrations) {
        return { status: 'ready' as const, checks };
      }
      return reply.code(503).send({ status: 'not_ready' as const, checks });
    },
  );

  /**
   * Configuração remota consumida pelo app na inicialização.
   *
   * É o botão de emergência do plano: desligar a sincronização aqui pausa o
   * envio em todos os aparelhos sem publicar uma nova versão na loja. O
   * aplicativo continua funcionando normalmente em modo local — a flag nunca
   * afeta a leitura ou escrita no SQLite do dispositivo.
   */
  routes.get(
    '/v1/config',
    {
      schema: {
        tags: ['infra'],
        summary: 'Configuração remota do cliente',
        response: {
          200: z.object({
            sync: z.object({
              enabled: z.boolean(),
              protocolVersion: z.number().int(),
              minSupportedProtocolVersion: z.number().int(),
              minAppVersionCode: z.number().int(),
              maxBatchItems: z.number().int(),
              defaultPageSize: z.number().int(),
            }),
            entitlements: z.object({ offlineGraceDays: z.number().int() }),
          }),
        },
      },
    },
    async () => {
      // O valor gravado no banco tem prioridade sobre a variável de ambiente:
      // permite desligar a sincronização sem redeploy.
      const overrides = await db
        .select({ value: appConfig.value })
        .from(appConfig)
        .where(eq(appConfig.key, 'sync'))
        .limit(1)
        .catch(() => []);

      const override = (overrides[0]?.value ?? {}) as {
        enabled?: boolean;
        minAppVersionCode?: number;
      };

      return {
        sync: {
          enabled: override.enabled ?? env.FEATURE_SYNC_ENABLED,
          protocolVersion: env.SYNC_PROTOCOL_VERSION,
          minSupportedProtocolVersion: env.SYNC_PROTOCOL_MIN_SUPPORTED,
          minAppVersionCode: override.minAppVersionCode ?? env.FEATURE_SYNC_MIN_APP_VERSION_CODE,
          maxBatchItems: env.SYNC_MAX_BATCH_ITEMS,
          defaultPageSize: env.SYNC_DEFAULT_PAGE_SIZE,
        },
        entitlements: { offlineGraceDays: env.ENTITLEMENT_OFFLINE_MAX_DAYS },
      };
    },
  );
}
