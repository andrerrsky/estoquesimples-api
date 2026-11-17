import { registerJobHandler } from '../../platform/jobs/runner.js';
import type { AppServices } from '../../platform/http/context.js';
import { SUPPORT_AI_REPLY_JOB, SUPPORT_NOTIFY_NEEDS_HUMAN_JOB, SUPPORT_NOTIFY_TEAM_JOB, SupportService } from './support.service.js';

/**
 * Tarefas do atendimento: avisos por e-mail e a resposta automática por IA.
 *
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

  /**
   * Resposta automática por IA a uma mensagem do cliente.
   *
   * `maxAttempts: 1` de propósito: o serviço já decide entre responder e
   * passar para uma pessoa, inclusive quando a OpenAI falha. Repetir só
   * geraria uma segunda resposta ao mesmo texto.
   */
  registerJobHandler(SUPPORT_AI_REPLY_JOB, async (payload, context) => {
    const ticketId = typeof payload['ticketId'] === 'string' ? payload['ticketId'] : null;
    const messageId = typeof payload['messageId'] === 'string' ? payload['messageId'] : null;
    if (!ticketId || !messageId) {
      context.logger.error({ payload }, 'resposta automática sem id; tarefa ignorada');
      return;
    }
    const result = await new SupportService(context.services).autoReply(ticketId, messageId);
    await context.log(`Resposta automática: ${result.outcome}${result.reason ? ` — ${result.reason}` : ''}.`);
    context.logger.info({ ticketId, ...result }, 'resposta automática do atendimento');
  });

  /** Aviso ao dono de que uma solicitação precisa de uma pessoa (um por solicitação). */
  registerJobHandler(SUPPORT_NOTIFY_NEEDS_HUMAN_JOB, async (payload, context) => {
    const ticketId = typeof payload['ticketId'] === 'string' ? payload['ticketId'] : null;
    if (!ticketId) {
      context.logger.error({ payload }, 'aviso de solicitação que precisa de humano sem id; tarefa ignorada');
      return;
    }
    const result = await new SupportService(context.services).notifyNeedsHuman(ticketId);
    context.logger.info({ ticketId, ...result }, 'dono avisado de solicitação que precisa de humano');
  });
}
