import { enqueueJob, registerJobHandler } from '../../platform/jobs/runner.js';
import type { AppServices } from '../../platform/http/context.js';
import { AnalyticsService } from './analytics.service.js';

export const ANALYTICS_RETENTION_JOB = 'analytics.retention';

/** Uma vez por dia basta: o que importa é a tabela não crescer sem limite. */
const INTERVAL_MINUTES = 24 * 60;

export function registerAnalyticsJobs(services: AppServices): void {
  registerJobHandler(ANALYTICS_RETENTION_JOB, async (_payload, context) => {
    const service = new AnalyticsService(context.services);
    const removidos = await service.purgeExpired(context.services.env.ANALYTICS_RETENTION_DAYS);
    context.logger.info({ removidos }, 'retenção de eventos de analytics concluída');
    await scheduleNext(context.services);
  });
}

async function scheduleNext(services: AppServices): Promise<void> {
  const runAt = new Date(Date.now() + INTERVAL_MINUTES * 60_000);
  await enqueueJob(services.db, {
    kind: ANALYTICS_RETENTION_JOB,
    uniqueKey: `${ANALYTICS_RETENTION_JOB}:${runAt.toISOString().slice(0, 10)}`,
    runAt,
    maxAttempts: 3,
  });
}

export async function bootstrapAnalyticsJobs(services: AppServices): Promise<void> {
  await enqueueJob(services.db, {
    kind: ANALYTICS_RETENTION_JOB,
    uniqueKey: `${ANALYTICS_RETENTION_JOB}:bootstrap`,
    runAt: new Date(Date.now() + 180_000),
    maxAttempts: 3,
  });
}
