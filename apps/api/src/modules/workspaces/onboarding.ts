import { and, eq, isNull, sql } from 'drizzle-orm';

import { users } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { enqueueJob, registerJobHandler } from '../../platform/jobs/runner.js';
import { trackServerEvent } from '../analytics/analytics.service.js';
import type { AuthSuccess } from '../auth/auth.schemas.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { webLink } from '../auth/auth.service.js';
import { WorkspaceService } from './workspaces.service.js';

/**
 * Primeiros passos de quem cria a conta pela web.
 *
 * 1. **Empresa automática.** Antes, depois do cadastro a pessoa caía em
 *    "dê um nome à sua empresa" — e boa parte saía ali. Agora a empresa
 *    nasce com um nome provisório e a pessoa vai direto para o estoque; o
 *    nome se troca em Empresas. Só na web: o app Android cria a empresa
 *    dele no aparelho e sincroniza, e uma empresa no servidor duplicaria.
 * 2. **Um lembrete.** Se em 24 horas a empresa ainda não tiver nenhum
 *    produto, sai **um** e-mail explicando como cadastrar o primeiro.
 *    Não se repete.
 *
 * Nada aqui pode derrubar o cadastro: a conta já existe; falhas viram log.
 */
export const DEFAULT_WORKSPACE_NAME = 'Minha empresa';
export const ONBOARDING_NUDGE_JOB = 'onboarding.first_product_nudge';
export const ONBOARDING_NUDGE_DELAY_MS = 24 * 3_600_000;

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
  try {
    await enqueueJob(services.db, {
      kind: ONBOARDING_NUDGE_JOB,
      payload: { userId },
      uniqueKey: `${ONBOARDING_NUDGE_JOB}:${userId}`,
      runAt: new Date(Date.now() + ONBOARDING_NUDGE_DELAY_MS),
      maxAttempts: 3,
    });
  } catch (error) {
    services.logger?.error({ err: error, userId }, 'não foi possível agendar o lembrete do primeiro produto');
  }
}

/** Conta viva, ainda sem nenhum produto em empresa nenhuma de que é proprietária. */
export async function needsFirstProductNudge(services: AppServices, userId: string): Promise<{ email: string; name: string } | null> {
  const rows = await services.db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        eq(users.status, 'active'),
        isNull(users.deletedAt),
        sql`NOT EXISTS (
          SELECT 1 FROM products p JOIN workspaces w ON w.id = p.workspace_id
          WHERE w.owner_user_id = ${userId}
        )`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export function firstProductNudgeText(name: string, webAppUrl: string | undefined): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return (
    `Olá${first ? `, ${first}` : ''}!\n\n` +
    'Sua conta no Estoque Simples está pronta, mas o estoque ainda está vazio. ' +
    'Cadastrar o primeiro produto leva menos de um minuto: nome, quantidade e, se quiser, o estoque mínimo para ser avisado quando acabar.\n\n' +
    webLink(webAppUrl, '/app/estoque', 'Cadastre o primeiro produto') +
    'Já controla em planilha? Em Importar dá para trazer a lista inteira de uma vez.\n\n' +
    'Este é o único lembrete que enviamos. Se tiver dúvida, é só responder este e-mail.\n\n' +
    'Equipe Estoque Simples'
  );
}

export function registerOnboardingJobs(_services: AppServices): void {
  registerJobHandler(ONBOARDING_NUDGE_JOB, async (payload, context) => {
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    if (!userId) return;
    const target = await needsFirstProductNudge(context.services, userId);
    if (!target) {
      await context.log('já tem produto (ou a conta não está ativa): nada a enviar');
      return;
    }
    await context.services.mailer.send({
      to: target.email,
      kind: 'onboarding_nudge',
      subject: 'Seu estoque está pronto: cadastre o primeiro produto',
      text: firstProductNudgeText(target.name, context.services.env.WEB_APP_URL),
    });
    await trackServerEvent(context.services, { name: 'onboarding.nudge_sent', userId });
  });
}
