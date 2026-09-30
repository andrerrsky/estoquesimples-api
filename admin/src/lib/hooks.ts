import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Estado de listagem (filtros, página, ordenação) guardado na URL, para que
 * recarregar a página ou compartilhar o link preserve o que se estava vendo.
 */
export function useListParams(defaults: Record<string, string> = {}) {
  const [params, setParams] = useSearchParams();

  const values = useMemo(() => {
    const result: Record<string, string> = { ...defaults };
    params.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }, [params, defaults]);

  const set = useCallback(
    (patch: Record<string, string | number | null | undefined>, options: { resetPage?: boolean } = { resetPage: true }) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === null || value === '') next.delete(key);
            else next.set(key, String(value));
          }
          if (options.resetPage && !('page' in patch)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const page = Math.max(1, Number(values['page'] ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(values['pageSize'] ?? 25) || 25));

  return { values, set, page, pageSize };
}

export function useSort(defaultKey: string, defaultOrder: 'asc' | 'desc' = 'desc') {
  const { values, set } = useListParams();
  const key = values['sort'] ?? defaultKey;
  const order = (values['order'] as 'asc' | 'desc' | undefined) ?? defaultOrder;
  const toggle = (next: string) => {
    if (next === key) set({ order: order === 'asc' ? 'desc' : 'asc' }, { resetPage: false });
    else set({ sort: next, order: 'desc' }, { resetPage: false });
  };
  return { key, order, toggle };
}
