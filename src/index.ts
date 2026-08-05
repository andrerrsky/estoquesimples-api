import { buildApp } from './app.js';
import { getEnv } from './platform/config/env.js';
import { migrateUp } from './platform/db/migrate.js';
import { startJobRunner } from './platform/jobs/runner.js';
import { bootstrapBillingJobs } from './modules/billing/billing.jobs.js';
import { bootstrapOpsJobs } from './modules/ops/ops.jobs.js';
import { bootstrapSyncJobs } from './modules/sync/sync.jobs.js';

/**
 * Ponto de entrada de produção.
 *
 * As migrations rodam antes de abrir a porta: o Railway só direciona tráfego
 * quando o readiness passa, e o readiness exige schema em dia. Migrar aqui,
 * com advisory lock, também torna seguro subir mais de uma instância ao mesmo
 * tempo — apenas uma aplica, as demais aguardam.
 */
async function main(): Promise<void> {
  const env = getEnv();
  const { app, services } = await buildApp({ env });

  try {
    await migrateUp(services.dbHandle.pool, (message) => app.log.info(message));
  } catch (error) {
    app.log.fatal({ err: error }, 'falha ao aplicar migrations');
    await services.dbHandle.close();
    process.exit(1);
  }

  if (env.JOBS_ENABLED) {
    await bootstrapBillingJobs(services);
    await bootstrapSyncJobs(services);
    await bootstrapOpsJobs(services);
  }
  const stopJobs = env.JOBS_ENABLED ? startJobRunner(services, app.log) : () => undefined;

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'encerrando');
    stopJobs();
    try {
      // Fecha o servidor primeiro para parar de aceitar requisições, depois o
      // pool, para não derrubar transações em andamento.
      await app.close();
      await services.dbHandle.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'falha no encerramento');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'promise rejeitada sem tratamento');
  });

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((error: unknown) => {
  console.error('falha ao iniciar a API:', error instanceof Error ? error.message : error);
  process.exit(1);
});
