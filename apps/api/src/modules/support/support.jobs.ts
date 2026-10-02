import { registerJobHandler } from '../../platform/jobs/runner.js';
import type { AppServices } from '../../platform/http/context.js';
import { SUPPORT_NOTIFY_TEAM_JOB, SupportService } from './support.service.js';

/**
 * Aviso por e-mail, para a equipe, de que chegou uma solicitação nova.
 *
 * Roda na fila (e não dentro da requisição) por dois motivos: quem abriu a
 * solicitação não espera o provedor de e-mail responder, e uma falha de
 * envio é repetida sozinha em vez de se perder.
 */
export function registerSupportJobs(_services: AppServices): void {
  registerJobHandler(SUPPORT_NOTIFY_TEAM_JOB, async (payload, context) => {
    const ticketId = typeof payload['ticketId'] === 'string' ? payload['ticketId'] : null;
    if (!ticketId) {
      context.logger.error({ payload }, 'aviso de solicitação sem id; tarefa ignorada');
      return;
    }
    const result = await new SupportService(context.services).notifyTeamOfNewTicket(ticketId);
    context.logger.info({ ticketId, ...result }, 'equipe avisada de solicitação nova');
  });
}
