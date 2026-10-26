import { enqueueJob, registerJobHandler } from '../../platform/jobs/runner.js';
import type { AppServices } from '../../platform/http/context.js';
import { PrivacyService } from './privacy.service.js';

/** Expurgo de contas excluídas e retenção de dados pessoais, uma vez por dia. */
export const PRIVACY_DAILY_JOB = 'privacy.daily';

const INTERVAL_MINUTES = 24 * 60;

export function registerPrivacyJobs(_services: AppServices): void {
  registerJobHandler(PRIVACY_DAILY_JOB, async (_payload, context) => {
    // Agenda a próxima antes: uma falha aqui não pode encerrar a cadeia diária.
    await scheduleNext(context.services);
    const service = new PrivacyService(context.services);
    const accounts = await service.purgeDeletedAccounts();
    const workspaces = await service.purgeDeletedWorkspaces();
    const retention = await service.applyRetention();
    context.logger.info({ accounts, workspaces, retention }, 'expurgo de contas e empresas e retenção concluídos');
  });
}

async function scheduleNext(services: AppServices): Promise<void> {
  const runAt = new Date(Date.now() + INTERVAL_MINUTES * 60_000);
  await enqueueJob(services.db, {
    kind: PRIVACY_DAILY_JOB,
    uniqueKey: `${PRIVACY_DAILY_JOB}:${runAt.toISOString().slice(0, 10)}`,
    runAt,
    maxAttempts: 3,
  });
}

export async function bootstrapPrivacyJobs(services: AppServices): Promise<void> {
  await enqueueJob(services.db, {
    kind: PRIVACY_DAILY_JOB,
    uniqueKey: `${PRIVACY_DAILY_JOB}:bootstrap`,
    runAt: new Date(Date.now() + 240_000),
    maxAttempts: 3,
  });
}
