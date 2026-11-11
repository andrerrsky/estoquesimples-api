import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '../api/client';
import { getPromo } from '../api/promo';
import type { BillingOverview, PromoPrices, PublicPromo, WorkspacePromo } from '../api/types';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { blocksPromo, hasPrices, promoPhase, syncCouponWithPromo, type PromoPhase } from './promo';

/** Campanha pública em destaque. A API guarda em cache por 60 s; aqui também. */
export function usePromo(): { promo: PublicPromo | null; phase: PromoPhase; loading: boolean } {
  const query = useQuery({ queryKey: ['promo'], queryFn: getPromo, staleTime: 60_000, retry: false, refetchOnWindowFocus: false });
  const promo = query.data ?? null;
  useEffect(() => {
    if (promo) syncCouponWithPromo(promo);
  }, [promo]);
  return { promo, phase: promoPhase(promo), loading: query.isLoading };
}

export interface WorkspaceOffer {
  promo: WorkspacePromo & PromoPrices;
  /** Código da campanha, que o CTA leva. */
  code: string;
}

/**
 * Oferta para a empresa aberta, ou `null`. Só aparece para quem pode assinar
 * (`assinatura.gerenciar`), sem assinatura viva e com a empresa elegível
 * segundo a API (`promo.eligible` do overview de billing). Na dúvida (API sem
 * a campanha, erro, ainda carregando), nada aparece.
 */
export function useWorkspaceOffer(): WorkspaceOffer | null {
  const { workspaceId, entitlement, can } = useWorkspace();
  const { promo, phase } = usePromo();
  const canManage = Boolean(workspaceId) && can('assinatura.gerenciar');
  const candidate = canManage && phase === 'active' && entitlement !== null && !blocksPromo(entitlement.state);
  // Mesma chave da página Plano: as duas leituras dividem o cache.
  const overview = useQuery({
    queryKey: ['billing', workspaceId],
    queryFn: () => api.get<BillingOverview>(`/v1/workspaces/${workspaceId}/billing/web`),
    enabled: candidate,
    staleTime: 60_000,
  });
  const workspacePromo = overview.data?.promo ?? null;
  if (!candidate || !overview.data?.checkoutAvailable || !workspacePromo?.active || !workspacePromo.eligible) return null;
  if (!hasPrices(workspacePromo) || promoPhase(workspacePromo) !== 'active') return null;
  const code = workspacePromo.code ?? promo?.code;
  if (!code) return null;
  return { promo: workspacePromo as WorkspacePromo & PromoPrices, code };
}
