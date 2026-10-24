import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

/**
 * Campos de texto livre: costumam ter e-mail ou nome de cliente. Ficam fora
 * da URL (que vai para o histórico do navegador e para o Google Analytics a
 * cada troca de tela) e moram na sessão deste navegador, por página.
 */
const PRIVATE_KEYS = new Set(['q']);

function privateKey(pathname: string, key: string): string {
  return `es_admin_${key}:${pathname}`;
}

export function readPrivateParam(pathname: string, key: string): string {
  try {
    return sessionStorage.getItem(privateKey(pathname, key)) ?? '';
  } catch {
    return '';
  }
}

export function writePrivateParam(pathname: string, key: string, value: string): void {
  try {
    if (value) sessionStorage.setItem(privateKey(pathname, key), value);
    else sessionStorage.removeItem(privateKey(pathname, key));
  } catch {
    // sem sessionStorage: a busca só não sobrevive a recarregar a página
  }
}

/**
 * Estado de listagem (filtros, página, ordenação) guardado na URL, para que
 * recarregar a página ou compartilhar o link preserve o que se estava vendo.
 * A busca por texto (`q`) é a exceção: fica na sessão (ver PRIVATE_KEYS).
 */
export function useListParams(defaults: Record<string, string> = {}) {
  const [params, setParams] = useSearchParams();
  const { pathname, key: locationKey } = useLocation();
  const [privateValues, setPrivateValues] = useState<Record<string, string>>(() => {
    const result: Record<string, string> = {};
    for (const key of PRIVATE_KEYS) {
      // Link antigo com ?q= ainda funciona: o valor é aproveitado e sai da URL.
      const fromUrl = params.get(key);
      if (fromUrl) writePrivateParam(pathname, key, fromUrl);
      const value = fromUrl ?? readPrivateParam(pathname, key);
      if (value) result[key] = value;
    }
    return result;
  });

  // Navegação nova (ex.: a busca do topo com a tela de usuários já aberta): relê a sessão.
  useEffect(() => {
    const result: Record<string, string> = {};
    for (const key of PRIVATE_KEYS) {
      const value = readPrivateParam(pathname, key);
      if (value) result[key] = value;
    }
    setPrivateValues((current) => (JSON.stringify(current) === JSON.stringify(result) ? current : result));
  }, [locationKey, pathname]);

  // Tira da URL o que veio por um link antigo.
  useEffect(() => {
    if ([...PRIVATE_KEYS].some((key) => params.has(key))) {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const key of PRIVATE_KEYS) next.delete(key);
          return next;
        },
        { replace: true },
      );
    }
  }, [params, setParams]);

  const values = useMemo(() => {
    const result: Record<string, string> = { ...defaults };
    params.forEach((value, key) => {
      if (!PRIVATE_KEYS.has(key)) result[key] = value;
    });
    return { ...result, ...privateValues };
  }, [params, defaults, privateValues]);

  const set = useCallback(
    (patch: Record<string, string | number | null | undefined>, options: { resetPage?: boolean } = { resetPage: true }) => {
      const privatePatch: Record<string, string> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (!PRIVATE_KEYS.has(key)) continue;
        const text = value === undefined || value === null ? '' : String(value);
        writePrivateParam(pathname, key, text);
        privatePatch[key] = text;
      }
      if (Object.keys(privatePatch).length > 0) {
        setPrivateValues((current) => {
          const next = { ...current };
          for (const [key, value] of Object.entries(privatePatch)) {
            if (value) next[key] = value;
            else delete next[key];
          }
          return next;
        });
      }
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (PRIVATE_KEYS.has(key)) continue;
            if (value === undefined || value === null || value === '') next.delete(key);
            else next.set(key, String(value));
          }
          if (options.resetPage && !('page' in patch)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setParams, pathname],
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
