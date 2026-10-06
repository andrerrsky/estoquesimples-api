import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, onSessionChange, refreshSession, sessionApi } from '../api/client';
import type { User } from '../api/types';
import { track } from '../lib/analytics';
import { clearProductImages } from '../lib/product-image';

type Status = 'loading' | 'guest' | 'authed';

interface AuthContextValue {
  status: Status;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Relê o perfil (nome alterado, e-mail confirmado). */
  reloadUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Sessão do usuário. Ao abrir a página, tenta retomar pelo cookie
 * (`/v1/auth/web/refresh`); se não houver sessão, fica como visitante.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    refreshSession()
      .then((auth) => {
        if (cancelled) return;
        setUser(auth?.user ?? null);
        setStatus(auth ? 'authed' : 'guest');
        if (auth) track('app.opened', { coldStart: true });
      })
      .catch(() => {
        // Sem rede na abertura: não dá para afirmar que não há sessão, mas
        // também não há como usar o app. A tela de entrada explica.
        if (!cancelled) setStatus('guest');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A sessão pode cair fora daqui (refresh recusado no meio de uma chamada).
  useEffect(
    () =>
      onSessionChange((auth) => {
        if (!auth) {
          setUser(null);
          setStatus('guest');
          queryClient.clear();
          clearProductImages();
        }
      }),
    [queryClient],
  );

  const login = useCallback(async (email: string, password: string) => {
    const auth = await sessionApi.login(email, password);
    setUser(auth.user);
    setStatus('authed');
  }, []);

  const register = useCallback(async (name: string, email: string, password: string) => {
    const auth = await sessionApi.register(name, email, password);
    setUser(auth.user);
    setStatus('authed');
  }, []);

  const logout = useCallback(async () => {
    await sessionApi.logout();
    setUser(null);
    setStatus('guest');
    queryClient.clear();
    clearProductImages();
  }, [queryClient]);

  const reloadUser = useCallback(async () => {
    const profile = await api.get<User>('/v1/me');
    setUser(profile);
    setStatus('authed');
  }, []);

  const value = useMemo(() => ({ status, user, login, register, logout, reloadUser }), [status, user, login, register, logout, reloadUser]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth fora do AuthProvider');
  return context;
}
