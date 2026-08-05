import { enqueueJob, registerJobHandler } from '../../platform/jobs/runner.js';
import type { AppServices } from '../../platform/http/context.js';
import { BillingService } from './billing.service.js';

export const BILLING_RECONCILE_JOB = 'billing.reconcile';

/**
 * Registra a reconciliação periódica de assinaturas.
 *
 * A tarefa se reagenda ao final de cada execução, em vez de depender de um
 * agendador externo. `uniqueKey` garante que só exista uma reconciliação na
 * fila por vez, mesmo com várias instâncias da API rodando.
 */
export function registerBillingJobs(services: AppServices): void {
  registerJobHandler(BILLING_RECONCILE_JOB, async (_payload, context) => {
    const billing = new BillingService(context.services);

    if (!context.services.playClient.configured) {
      context.logger.warn('reconciliação ignorada: Google Play não configurado');
      await scheduleNext(context.services);
      return;
    }

    const retried = await billing.retryFailedEvents();
    const result = await billing.reconcile();

    context.logger.info(
      { ...result, eventosReprocessados: retried },
      'reconciliação de assinaturas concluída',
    );

    await scheduleNext(context.services);
  });
}

async function scheduleNext(services: AppServices): Promise<void> {
  const intervalMinutes = services.env.BILLING_RECONCILE_INTERVAL_MINUTES;
  const runAt = new Date(Date.now() + intervalMinutes * 60_000);

  await enqueueJob(services.db, {
    kind: BILLING_RECONCILE_JOB,
    // A chave inclui o horário-alvo para que a próxima execução possa ser
    // enfileirada enquanto a atual ainda não foi marcada como concluída.
    uniqueKey: `${BILLING_RECONCILE_JOB}:${runAt.toISOString().slice(0, 13)}`,
    runAt,
    maxAttempts: 3,
  });
}

/** Enfileira a primeira execução na subida da API. */
export async function bootstrapBillingJobs(services: AppServices): Promise<void> {
  await enqueueJob(services.db, {
    kind: BILLING_RECONCILE_JOB,
    uniqueKey: `${BILLING_RECONCILE_JOB}:bootstrap`,
    runAt: new Date(Date.now() + 60_000),
    maxAttempts: 3,
  });
}
