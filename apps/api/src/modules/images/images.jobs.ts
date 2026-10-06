import type { AppServices } from '../../platform/http/context.js';
import { enqueueJob, registerJobHandler } from '../../platform/jobs/runner.js';
import { ImageService } from './images.service.js';

export const IMAGES_GC_JOB = 'images.gc';

/** Uma passada por dia; a própria tarefa agenda a seguinte antes de trabalhar. */
const INTERVAL_MS = 24 * 3_600_000;

export function registerImageJobs(_services: AppServices): void {
  registerJobHandler(IMAGES_GC_JOB, async (_payload, context) => {
    const next = new Date(Date.now() + INTERVAL_MS);
    await enqueueJob(context.services.db, { kind: IMAGES_GC_JOB, uniqueKey: `${IMAGES_GC_JOB}:${next.toISOString().slice(0, 13)}`, runAt: next, maxAttempts: 3 });

    const result = await new ImageService(context.services).collectGarbage();
    context.logger.info(result, 'coleta de imagens sem uso concluída');
  });
}

export async function bootstrapImageJobs(services: AppServices): Promise<void> {
  await enqueueJob(services.db, { kind: IMAGES_GC_JOB, uniqueKey: `${IMAGES_GC_JOB}:bootstrap`, runAt: new Date(Date.now() + 10 * 60_000), maxAttempts: 3 });
}
