import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, onSessionChange, refreshSession, sessionApi } from '../api/client';
import type { User } from '../api/types';
import { track } from '../lib/analytics';
import { gaEvent, onConsentChange } from '../lib/ga';
import { clearProductImages } from '../lib/product-image';
import { createAuthActions } from './actions';
import { AuthContext, type AuthContextValue, type Status } from './context';

// Os hooks continuam importáveis daqui (é o que o resto da aplicação usa).
export { useAuth, useAuthOptional } from './context';

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

  // Escolha de cookies mudada com a conta aberta: a origem do cadastro passa a
  // refletir a última escolha (decide se o clique vai para o Google Ads).
  useEffect(() => {
    if (status !== 'authed') return undefined;
    return onConsentChange((consent) => {
      if (consent === null) return;
      void api.put('/v1/me/cookie-consent', { consent: consent === 'granted' ? 'v2_accepted' : 'refused' }).catch(() => undefined);
    });
  }, [status]);

  const { login, register, loginWithAppCode, loginWithGoogle } = useMemo(
    () =>
      createAuthActions({
        sessionApi,
        onAuthed: (authed) => {
          setUser(authed);
          setStatus('authed');
        },
        onAccountSwitch: () => {
          queryClient.clear();
          clearProductImages();
        },
        report: gaEvent,
      }),
    [queryClient],
  );

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

  const value = useMemo(
    () => ({ status, user, login, register, logout, reloadUser, loginWithAppCode, loginWithGoogle }),
    [status, user, login, register, logout, reloadUser, loginWithAppCode, loginWithGoogle],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

