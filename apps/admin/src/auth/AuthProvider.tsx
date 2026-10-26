import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { api, ApiError, onUnauthorized } from '../api/client';
import { gaEvent } from '../lib/ga';

export type AdminRole = 'owner' | 'support' | 'viewer';

export interface AdminMe {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  /** Segundo fator (TOTP) ativo para este administrador. */
  mfaEnabled: boolean;
  /** O painel exige segundo fator: sem ele, só a tela de segurança abre. */
  mfaRequired: boolean;
}

const RANK: Record<AdminRole, number> = { viewer: 10, support: 50, owner: 100 };

interface AuthState {
  admin: AdminMe | null;
  loading: boolean;
  login: (email: string, password: string, code?: string) => Promise<void>;
  /** Relê o administrador (depois de ativar ou desativar o segundo fator). */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  can: (minimum: AdminRole) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<AdminMe | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    api
      .get<AdminMe>('/auth/me')
      .then((me) => {
        if (!cancelled) setAdmin(me);
      })
      .catch(() => {
        if (!cancelled) setAdmin(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      onUnauthorized(() => {
        setAdmin(null);
        queryClient.clear();
      }),
    [queryClient],
  );

  const login = useCallback(async (email: string, password: string, code?: string) => {
    await api.post('/auth/login', { email, password, ...(code ? { code } : {}) });
    const me = await api.get<AdminMe>('/auth/me');
    setAdmin(me);
    gaEvent('login', { method: 'painel', role: me.role });
  }, []);

  const refresh = useCallback(async () => {
    setAdmin(await api.get<AdminMe>('/auth/me'));
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
      gaEvent('logout', {});
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    } finally {
      setAdmin(null);
      queryClient.clear();
    }
  }, [queryClient]);

  const can = useCallback(
    (minimum: AdminRole) => (admin ? RANK[admin.role] >= RANK[minimum] : false),
    [admin],
  );

  const value = useMemo(() => ({ admin, loading, login, logout, can, refresh }), [admin, loading, login, logout, can, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth fora do AuthProvider');
  return context;
}
