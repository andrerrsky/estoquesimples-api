import { enqueueJob, registerJobHandler } from '../../platform/jobs/runner.js';
import type { AppServices } from '../../platform/http/context.js';
import { ReviewsService } from './reviews.service.js';

export const PLAY_REVIEWS_SYNC_JOB = 'play.reviews_sync';

/**
 * Coleta periódica das avaliações. Como a API do Google só devolve os últimos
 * sete dias, rodar a cada seis horas garante que nada escapa entre coletas.
 */
export function registerReviewsJobs(services: AppServices): void {
  registerJobHandler(PLAY_REVIEWS_SYNC_JOB, async (_payload, context) => {
    await scheduleNext(context.services);
    if (!context.services.playClient.configured) {
      context.logger.info('coleta de avaliações ignorada: Google Play não configurado');
      return;
    }
    const result = await new ReviewsService(context.services).sync();
    context.logger.info(result, 'coleta de avaliações da Play Store concluída');
  });
}

async function scheduleNext(services: AppServices): Promise<void> {
  const minutos = services.env.PLAY_REVIEWS_SYNC_INTERVAL_MINUTES;
  const runAt = new Date(Date.now() + minutos * 60_000);
  await enqueueJob(services.db, {
    kind: PLAY_REVIEWS_SYNC_JOB,
    uniqueKey: `${PLAY_REVIEWS_SYNC_JOB}:${runAt.toISOString().slice(0, 13)}`,
    runAt,
    maxAttempts: 3,
  });
}

export async function bootstrapReviewsJobs(services: AppServices): Promise<void> {
  await enqueueJob(services.db, {
    kind: PLAY_REVIEWS_SYNC_JOB,
    uniqueKey: `${PLAY_REVIEWS_SYNC_JOB}:bootstrap`,
    runAt: new Date(Date.now() + 90_000),
    maxAttempts: 3,
  });
}
