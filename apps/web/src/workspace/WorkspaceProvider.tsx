import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api } from '../api/client';
import type { Entitlement, WorkspaceDetail, WorkspaceSummary } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { setAnalyticsWorkspace } from '../lib/analytics';

const STORAGE_KEY = 'es_web_workspace';

interface WorkspaceContextValue {
  /** Empresas das quais o usuário participa. */
  workspaces: WorkspaceSummary[];
  loading: boolean;
  error: unknown;
  /** Empresa em uso; `null` enquanto carrega ou se o usuário não tem nenhuma. */
  workspace: WorkspaceDetail | null;
  workspaceId: string | null;
  entitlement: Entitlement | null;
  /** O papel do usuário permite a ação? (conveniência de tela; a API confere de novo) */
  can: (permission: string) => boolean;
  /** Assinatura paga valendo. */
  isPaid: boolean;
  /** A empresa pode ter equipe (plano Equipe). */
  teamEnabled: boolean;
  /**
   * Este usuário pode usar o estoque na nuvem desta empresa? No plano
   * gratuito, só o proprietário.
   */
  cloudAllowed: boolean;
  currency: string;
  select: (workspaceId: string) => void;
  refresh: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function stored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Empresa em uso, permissões do papel e plano. Tudo o que a interface mostra
 * ou esconde por permissão ou plano é só conveniência: quem decide é a API.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(stored);
  const enabled = status === 'authed';

  const list = useQuery({
    queryKey: ['workspaces', user?.id],
    queryFn: () => api.get<{ workspaces: WorkspaceSummary[] }>('/v1/workspaces').then((response) => response.workspaces),
    enabled,
  });

  const workspaces = useMemo(() => list.data ?? [], [list.data]);
  // A escolha guardada só vale se a pessoa ainda participa daquela empresa.
  const workspaceId = useMemo(() => {
    // Empresas em que a participação está suspensa aparecem na lista, mas
    // não podem ser abertas (a API recusa).
    const usable = workspaces.filter((item) => item.status !== 'suspended');
    if (usable.length === 0) return null;
    if (selected && usable.some((item) => item.id === selected)) return selected;
    return usable[0]?.id ?? null;
  }, [workspaces, selected]);

  useEffect(() => {
    setAnalyticsWorkspace(workspaceId);
  }, [workspaceId]);

  const detail = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => api.get<WorkspaceDetail>(`/v1/workspaces/${workspaceId}`),
    enabled: enabled && workspaceId !== null,
  });

  const entitlement = useQuery({
    queryKey: ['entitlement', workspaceId],
    queryFn: () => api.get<Entitlement>(`/v1/workspaces/${workspaceId}/entitlement`),
    enabled: enabled && workspaceId !== null,
    staleTime: 60_000,
  });

  const select = useCallback((id: string) => {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // segue só em memória
    }
    setSelected(id);
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
      queryClient.invalidateQueries({ queryKey: ['workspace'] }),
      queryClient.invalidateQueries({ queryKey: ['entitlement'] }),
    ]);
  }, [queryClient]);

  const value = useMemo<WorkspaceContextValue>(() => {
    const workspace = detail.data ?? null;
    const plan = entitlement.data ?? null;
    const permissions = new Set(workspace?.permissions ?? []);
    const teamEnabled = plan?.features['equipe.membros']?.enabled ?? false;
    return {
      workspaces,
      loading: list.isLoading || (workspaceId !== null && (detail.isLoading || entitlement.isLoading)),
      error: list.error ?? detail.error ?? null,
      workspace,
      workspaceId,
      entitlement: plan,
      can: (permission) => permissions.has(permission),
      isPaid: plan?.active ?? false,
      teamEnabled,
      cloudAllowed: plan ? plan.syncAllowed && (workspace?.isOwner === true || teamEnabled) : true,
      currency: typeof workspace?.settings?.currencySymbol === 'string' ? workspace.settings.currencySymbol : 'R$',
      select,
      refresh,
    };
  }, [workspaces, list.isLoading, list.error, detail.data, detail.isLoading, detail.error, entitlement.data, entitlement.isLoading, workspaceId, select, refresh]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace fora do WorkspaceProvider');
  return context;
}

/** Empresa garantida: para páginas renderizadas dentro do `AppShell`. */
export function useCurrentWorkspace() {
  const context = useWorkspace();
  if (!context.workspace || !context.workspaceId) throw new Error('Página aberta sem empresa selecionada');
  return { ...context, workspace: context.workspace, workspaceId: context.workspaceId, base: `/v1/workspaces/${context.workspaceId}` };
}
