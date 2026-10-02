import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

/**
 * Chaves de consulta do estoque. Tudo o que depende de produtos ou
 * movimentações é invalidado junto depois de uma gravação: lista, facetas,
 * histórico, relatórios e o uso do plano ("12 de 50").
 */
export const inventoryKeys = {
  products: (workspaceId: string) => ['inventory', workspaceId, 'products'] as const,
  product: (workspaceId: string, productId: string) => ['inventory', workspaceId, 'product', productId] as const,
  facets: (workspaceId: string) => ['inventory', workspaceId, 'facets'] as const,
  movements: (workspaceId: string) => ['inventory', workspaceId, 'movements'] as const,
  reports: (workspaceId: string) => ['inventory', workspaceId, 'reports'] as const,
  conflicts: (workspaceId: string) => ['inventory', workspaceId, 'conflicts'] as const,
};

export function useInvalidateInventory(workspaceId: string) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['inventory', workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ['entitlement', workspaceId] });
  }, [queryClient, workspaceId]);
}

/** Valor que só muda depois de uma pausa na digitação (busca). */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Cabeçalho exigido pelas rotas do protocolo de sincronização (conflitos). */
export const SYNC_HEADERS = { 'x-sync-protocol': '1' };
