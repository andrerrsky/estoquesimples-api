import { createContext, useContext } from 'react';

import type { User } from '../api/types';

export type Status = 'loading' | 'guest' | 'authed';

export interface AuthContextValue {
  status: Status;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Relê o perfil (nome alterado, e-mail confirmado). */
  reloadUser: () => Promise<void>;
}

/**
 * Só o contexto e os hooks, sem o provedor: a página inicial (que tem uma
 * entrada própria, sem cliente HTTP) importa daqui e não arrasta o
 * `AuthProvider` e o `api/client` para o seu pacote.
 */
export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth fora do AuthProvider');
  return context;
}

/**
 * Como `useAuth`, mas devolve `null` fora do provider. É para a página
 * inicial, que também é renderizada no build (sem navegador e sem sessão):
 * lá ela se comporta como visitante.
 */
export function useAuthOptional(): AuthContextValue | null {
  return useContext(AuthContext);
}
