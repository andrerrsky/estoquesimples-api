import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { appConfig } from '../../platform/db/schema/index.js';
import { safeEquals } from '../../platform/auth/tokens.js';
import { ErrorCode, notFound, unauthorized } from '../../platform/http/errors.js';
import { renderMetrics } from '../../platform/observability/metrics.js';
import { errorSchema } from '../auth/auth.schemas.js';
import { OpsService } from './ops.service.js';

/**
 * Endpoints de operação: coleta de métricas, retrato do sistema e o
 * interruptor de sincronização.
 *
 * Ficam atrás de um token próprio, não do login normal. São chamados por
 * coletor e por quem está de plantão, muitas vezes sem sessão de usuário — e
 * dar a alguém o poder de desligar a sincronização de todos os clientes é
 * outra decisão, que não deve vir de brinde com uma conta de administrador de
 * empresa.
 */

const syncConfigSchema = z.object({
  enabled: z.boolean(),
  minAppVersionCode: z.number().int().nonnegative(),
});

function requireOpsToken(request: FastifyRequest): void {
  const esperado = request.server.services.env.OPS_TOKEN;

  // Sem token configurado o recurso não existe, em vez de ficar aberto. Um
  // /metrics público entrega volume de clientes e ritmo de uso a qualquer um.
  if (!esperado) {
    throw notFound('Recurso não encontrado');
  }

  const header = request.headers.authorization;
  const recebido = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!safeEquals(recebido, esperado)) {
    throw unauthorized(ErrorCode.AUTH_REQUIRED, 'Token de operação inválido.');
  }
}

export async function registerOpsRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new OpsService(app.services);

  routes.get(
    '/metrics',
    {
      // Fora do rate limit global: o coletor chega a cada 15 segundos e não
      // pode ser barrado junto com o tráfego dos aplicativos.
      config: { rateLimit: false },
      schema: {
        tags: ['infra'],
        summary: 'Métricas no formato Prometheus',
        hide: true,
        response: { 200: z.string(), 401: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      requireOpsToken(request);

      // Uma falha de leitura no banco não pode derrubar a coleta inteira: os
      // contadores em memória são justamente o que ajuda a diagnosticar o
      // banco fora do ar.
      const gauges = await service.gauges().catch((error: unknown) => {
        request.log.warn({ err: error }, 'métricas do banco indisponíveis');
        return [];
      });

      return reply.type('text/plain; version=0.0.4; charset=utf-8').send(renderMetrics(gauges));
    },
  );

  routes.get(
    '/ops/status',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['infra'],
        summary: 'Retrato do sistema e alertas ativos',
        hide: true,
        response: {
          200: z.object({
            snapshot: z.record(z.number()),
            alertas: z.array(z.object({ nome: z.string(), detalhe: z.string() })),
          }),
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request) => {
      requireOpsToken(request);
      const snapshot = await service.snapshot();
      return { snapshot, alertas: service.alertas(snapshot) };
    },
  );

  /**
   * Interruptor de emergência e controle de lançamento.
   *
   * Gravado no banco porque precisa valer imediatamente, sem redeploy e sem
   * depender de uma variável de ambiente que só uma instância enxerga. É o
   * caminho para pausar a sincronização durante um incidente e para liberar
   * versões novas do app aos poucos.
   */
  routes.put(
    '/ops/config/sync',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['infra'],
        summary: 'Liga, desliga ou restringe a sincronização por versão do app',
        hide: true,
        body: syncConfigSchema,
        response: { 200: syncConfigSchema, 401: errorSchema, 404: errorSchema },
      },
    },
    async (request) => {
      requireOpsToken(request);

      await app.services.db
        .insert(appConfig)
        .values({ key: 'sync', value: request.body })
        .onConflictDoUpdate({
          target: appConfig.key,
          set: { value: request.body, updatedAt: new Date() },
        });

      request.log.warn(
        { config: request.body, alerta: true },
        'configuração de sincronização alterada',
      );
      return request.body;
    },
  );

  routes.get(
    '/ops/config/sync',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['infra'],
        summary: 'Configuração de sincronização em vigor',
        hide: true,
        response: {
          200: syncConfigSchema.partial().extend({ origem: z.enum(['banco', 'ambiente']) }),
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request) => {
      requireOpsToken(request);

      const linhas = await app.services.db
        .select({ value: appConfig.value })
        .from(appConfig)
        .where(eq(appConfig.key, 'sync'))
        .limit(1);

      const gravada = linhas[0]?.value as z.infer<typeof syncConfigSchema> | undefined;
      if (gravada) {
        return { ...gravada, origem: 'banco' as const };
      }
      return {
        enabled: app.services.env.FEATURE_SYNC_ENABLED,
        minAppVersionCode: app.services.env.FEATURE_SYNC_MIN_APP_VERSION_CODE,
        origem: 'ambiente' as const,
      };
    },
  );

  /**
   * Confirma que existe um backup recente e legível.
   *
   * Backup que nunca foi restaurado é hipótese, não garantia. Este endpoint
   * expõe o resultado do último exercício de restauração registrado pelo
   * script de verificação, para que a ausência dele apareça no plantão em vez
   * de ser descoberta no dia do incidente.
   */
  routes.get(
    '/ops/backup',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['infra'],
        summary: 'Última verificação de backup registrada',
        hide: true,
        response: {
          200: z.object({
            verificadoEm: z.string().nullable(),
            horasDesdeVerificacao: z.number().nullable(),
            detalhes: z.record(z.unknown()),
            dentroDoPrazo: z.boolean(),
          }),
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request) => {
      requireOpsToken(request);

      const linhas = await app.services.db
        .select({ value: appConfig.value, updatedAt: appConfig.updatedAt })
        .from(appConfig)
        .where(eq(appConfig.key, 'backup_verificado'))
        .limit(1);

      const registro = linhas[0];
      if (!registro) {
        return {
          verificadoEm: null,
          horasDesdeVerificacao: null,
          detalhes: {},
          dentroDoPrazo: false,
        };
      }

      const horas = (Date.now() - registro.updatedAt.getTime()) / 3_600_000;
      return {
        verificadoEm: registro.updatedAt.toISOString(),
        horasDesdeVerificacao: Math.round(horas),
        detalhes: (registro.value ?? {}) as Record<string, unknown>,
        dentroDoPrazo: horas <= app.services.env.BACKUP_MAX_AGE_HOURS,
      };
    },
  );

  /** Usado pelo script de verificação para registrar o resultado do exercício. */
  routes.post(
    '/ops/backup',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['infra'],
        summary: 'Registra o resultado de uma restauração de teste',
        hide: true,
        body: z.object({
          origem: z.string().max(200),
          tabelas: z.number().int().nonnegative(),
          registros: z.number().int().nonnegative(),
          duracaoSegundos: z.number().nonnegative(),
        }),
        response: { 200: z.object({ message: z.string() }), 401: errorSchema, 404: errorSchema },
      },
    },
    async (request) => {
      requireOpsToken(request);

      await app.services.db
        .insert(appConfig)
        .values({ key: 'backup_verificado', value: request.body })
        .onConflictDoUpdate({
          target: appConfig.key,
          set: { value: request.body, updatedAt: sql`now()` },
        });

      return { message: 'Verificação registrada.' };
    },
  );
}
