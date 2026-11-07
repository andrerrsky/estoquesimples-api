import type { AppServices } from '../../platform/http/context.js';
import { registerJobHandler } from '../../platform/jobs/runner.js';
import { trackServerEvent } from '../analytics/analytics.service.js';
import type { AuthSuccess } from '../auth/auth.schemas.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { WorkspaceService } from './workspaces.service.js';

/**
 * Primeiros passos de quem cria a conta pela web.
 *
 * 1. **Empresa automática.** Antes, depois do cadastro a pessoa caía em
 *    "dê um nome à sua empresa" — e boa parte saía ali. Agora a empresa
 *    nasce com um nome provisório e a pessoa vai direto para o estoque; o
 *    nome se troca em Empresas. Só na web: o app Android cria a empresa
 *    dele no aparelho e sincroniza, e uma empresa no servidor duplicaria.
 * 2. Os lembretes por e-mail (24 h, 4 e 8 dias sem produto) são do funil do
 *    ciclo de vida (modules/lifecycle).
 *
 * Nada aqui pode derrubar o cadastro: a conta já existe; falhas viram log.
 */
export const DEFAULT_WORKSPACE_NAME = 'Minha empresa';
export const ONBOARDING_NUDGE_JOB = 'onboarding.first_product_nudge';

export async function startWebOnboarding(services: AppServices, auth: AuthSuccess, meta: RequestMeta): Promise<void> {
  const userId = auth.user.id;
  try {
    const created = await new WorkspaceService(services).create(userId, { name: DEFAULT_WORKSPACE_NAME }, meta);
    await trackServerEvent(services, {
      name: 'workspace.created',
      userId,
      workspaceId: created.id,
      deviceId: auth.deviceId,
      properties: { automatic: true },
    });
  } catch (error) {
    services.logger?.error({ err: error, userId }, 'cadastro concluído, mas a empresa automática não foi criada');
  }
}

/**
 * O lembrete de 24 h passou para o funil de e-mails do ciclo de vida
 * (`activation_d1` em modules/lifecycle), que respeita descadastro, bounce,
 * o intervalo mínimo entre e-mails e a cota diária. Tarefas já enfileiradas
 * por versões anteriores terminam sem enviar nada.
 */
export function registerOnboardingJobs(_services: AppServices): void {
  registerJobHandler(ONBOARDING_NUDGE_JOB, async (_payload, context) => {
    await context.log('substituído pelo funil do ciclo de vida (activation_d1): nada a enviar');
  });
}
