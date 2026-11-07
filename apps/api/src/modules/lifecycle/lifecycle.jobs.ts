import type { AppServices } from '../../platform/http/context.js';
import { enqueueJob, registerJobHandler } from '../../platform/jobs/runner.js';
import { LifecycleService } from './lifecycle.service.js';

export const LIFECYCLE_TICK_JOB = 'lifecycle.tick';
const INTERVAL_MS = 3_600_000;

function nextKey(date: Date): string {
  return `${LIFECYCLE_TICK_JOB}:${date.toISOString().slice(0, 13)}`;
}

/** Uma rodada por hora; a própria tarefa agenda a seguinte antes de trabalhar. */
export function registerLifecycleJobs(_services: AppServices): void {
  registerJobHandler(LIFECYCLE_TICK_JOB, async (_payload, context) => {
    const next = new Date(Date.now() + INTERVAL_MS);
    await enqueueJob(context.services.db, { kind: LIFECYCLE_TICK_JOB, uniqueKey: nextKey(next), runAt: next, maxAttempts: 2 });
    const result = await new LifecycleService(context.services).run();
    await context.log(
      result.skipped
        ? `nada a fazer (${result.skipped})`
        : `modo ${result.mode}: ${result.decided} decidido(s), ${result.sent} enviado(s), ${result.failed} falha(s)${result.stoppedByRateLimit ? ', parado por limite do provedor' : ''}`,
    );
  });
}

export async function bootstrapLifecycleJobs(services: AppServices): Promise<void> {
  const first = new Date(Date.now() + 5 * 60_000);
  await enqueueJob(services.db, { kind: LIFECYCLE_TICK_JOB, uniqueKey: nextKey(first), runAt: first, maxAttempts: 2 });
}
