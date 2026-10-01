import { enqueueJob, registerJobHandler } from '../../../platform/jobs/runner.js';
import type { AppServices } from '../../../platform/http/context.js';
import { AsaasBillingService } from './asaas-billing.service.js';

export const ASAAS_RECONCILE_JOB = 'billing.asaas_reconcile';

/**
 * Reconciliação das assinaturas da web: reprocessa webhooks que ficaram
 * pendentes, revalida as assinaturas vivas junto ao Asaas e aplica os prazos
 * (pendente nunca paga, suspensa há muito tempo). É o que cobre webhook
 * perdido e mudança de estado que acontece só por passagem de tempo.
 */
export function registerAsaasJobs(_services: AppServices): void {
  registerJobHandler(ASAAS_RECONCILE_JOB, async (_payload, context) => {
    // Agenda a próxima antes de trabalhar: uma falha aqui não pode quebrar a cadeia.
    await scheduleNext(context.services);

    if (!context.services.asaas.configured) return;

    const billing = new AsaasBillingService(context.services);
    const events = await billing.retryPendingEvents();
    const result = await billing.reconcile();
    context.logger.info({ ...result, eventos: events }, 'reconciliação do Asaas concluída');
  });
}

async function scheduleNext(services: AppServices): Promise<void> {
  const runAt = new Date(Date.now() + services.env.ASAAS_RECONCILE_INTERVAL_MINUTES * 60_000);
  await enqueueJob(services.db, {
    kind: ASAAS_RECONCILE_JOB,
    uniqueKey: `${ASAAS_RECONCILE_JOB}:${runAt.toISOString().slice(0, 16)}`,
    runAt,
    maxAttempts: 3,
  });
}

/** Enfileira a primeira execução na subida da API. */
export async function bootstrapAsaasJobs(services: AppServices): Promise<void> {
  await enqueueJob(services.db, {
    kind: ASAAS_RECONCILE_JOB,
    uniqueKey: `${ASAAS_RECONCILE_JOB}:bootstrap`,
    runAt: new Date(Date.now() + 120_000),
    maxAttempts: 3,
  });
}
