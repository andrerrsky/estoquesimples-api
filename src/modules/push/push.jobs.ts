import { registerJobHandler } from '../../platform/jobs/runner.js';
import type { AppServices } from '../../platform/http/context.js';
import { PushService } from './push.service.js';

export const PUSH_SEND_CAMPAIGN_JOB = 'push.send_campaign';

/**
 * Envio de uma campanha. Roda na fila para sobreviver a deploys e para não
 * segurar a requisição do painel enquanto milhares de tokens são enviados.
 * A retomada é segura: as linhas de entrega já aceitas não são reenviadas.
 */
export function registerPushJobs(services: AppServices): void {
  registerJobHandler(PUSH_SEND_CAMPAIGN_JOB, async (payload, context) => {
    const campaignId = typeof payload['campaignId'] === 'string' ? payload['campaignId'] : null;
    if (!campaignId) {
      context.logger.error({ payload }, 'campanha sem id; tarefa ignorada');
      return;
    }
    const service = new PushService(context.services);
    try {
      const result = await service.deliver(campaignId);
      context.logger.info({ campaignId, ...result }, 'campanha de push enviada');
    } catch (error) {
      const last = context.attempt >= 3;
      if (last) {
        await service.markFailed(campaignId, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  });
}
