import type { FastifyRequest } from 'fastify';

import { requireWorkspaceContext } from '../../platform/http/authorize.js';
import type { AppServices } from '../../platform/http/context.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';
import { BillingService, type EntitlementSnapshot } from './billing.service.js';
import { Feature, featureEnabled, limitOf } from './plan-limits.js';

/** Plano em vigor, no formato que os serviços de estoque precisam. */
export interface CloudAccess {
  entitlement: EntitlementSnapshot;
  /** Teto de produtos vivos na nuvem; `null` = sem limite. */
  productLimit: number | null;
  planKey: string;
}

/**
 * Guarda de acesso aos dados da empresa na nuvem — sincronização do app e
 * API de estoque da web passam pela mesma regra:
 *
 *  - o interruptor geral (`FEATURE_SYNC_ENABLED`) está ligado;
 *  - o plano em vigor libera a nuvem (`sync.nuvem`);
 *  - sem o recurso de equipe, só o proprietário entra.
 *
 * O plano é conferido no servidor, nunca a partir do que o cliente diz. O
 * teto de produtos é aplicado adiante, na escrita, porque depende do que
 * está sendo gravado.
 */
export async function assertCloudAccess(
  services: AppServices,
  request: FastifyRequest,
  options: { allowWhenPaused?: boolean } = {},
): Promise<CloudAccess> {
  const { workspaceId, isOwner } = requireWorkspaceContext(request);

  // `allowWhenPaused`: leitura que continua valendo com a sincronização
  // pausada (exportar os próprios dados durante um incidente é desejável).
  if (!services.env.FEATURE_SYNC_ENABLED && !options.allowWhenPaused) {
    throw new AppError(
      503,
      ErrorCode.SYNC_DISABLED,
      'A sincronização está temporariamente desativada. Seus dados seguem no aparelho.',
    );
  }

  const entitlement = await new BillingService(services).getEntitlement(workspaceId);
  if (!entitlement.syncAllowed) {
    throw new AppError(
      403,
      ErrorCode.SUBSCRIPTION_REQUIRED,
      'A sincronização na nuvem não está disponível para esta empresa. Nada foi apagado do aparelho.',
      { extra: { state: entitlement.state, planKey: entitlement.planKey } },
    );
  }
  if (!isOwner && !featureEnabled(entitlement, Feature.MEMBERS)) {
    throw new AppError(
      403,
      ErrorCode.SUBSCRIPTION_REQUIRED,
      'Esta empresa está no plano gratuito, que sincroniza só para o proprietário. ' +
        'Peça a ele para assinar o plano Equipe. Nada foi apagado do aparelho.',
      { extra: { state: entitlement.state, planKey: entitlement.planKey, feature: Feature.MEMBERS } },
    );
  }

  return { entitlement, productLimit: limitOf(entitlement, Feature.PRODUCTS), planKey: entitlement.planKey };
}
