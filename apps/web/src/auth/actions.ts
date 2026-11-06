import type { User } from '../api/types';

/**
 * Entrar, criar conta e entrar pelo código do app, sem React: o
 * `AuthProvider` liga isto ao estado, e os testes conferem os eventos.
 *
 * Conversão: `signup.completed` (→ `sign_up` no GA, importado como conversão
 * no Google Ads) sai **uma vez**, só depois de a API confirmar o cadastro.
 * Erro de cadastro lança antes do evento; login e recarregar a página não
 * passam por aqui como cadastro.
 */
export interface AuthResult {
  user: User;
}

export interface AuthActionDeps {
  sessionApi: {
    login(email: string, password: string): Promise<AuthResult>;
    register(name: string, email: string, password: string): Promise<AuthResult>;
    handoff(code: string): Promise<AuthResult>;
  };
  /** Sessão aberta com esta pessoa. */
  onAuthed(user: User): void;
  /** Outra conta podia estar aberta neste navegador: limpa o que era dela. */
  onAccountSwitch(): void;
  /** Evento para o Google Analytics (só sai com consentimento). */
  report(name: string, params?: Record<string, string>): void;
}

export function createAuthActions(deps: AuthActionDeps) {
  return {
    async login(email: string, password: string): Promise<void> {
      const auth = await deps.sessionApi.login(email, password);
      deps.onAuthed(auth.user);
      deps.report('auth.login', { method: 'email' });
    },
    async register(name: string, email: string, password: string): Promise<void> {
      const auth = await deps.sessionApi.register(name, email, password);
      deps.onAuthed(auth.user);
      deps.report('signup.completed', { method: 'email' });
    },
    async loginWithAppCode(code: string): Promise<void> {
      const auth = await deps.sessionApi.handoff(code);
      deps.onAccountSwitch();
      deps.onAuthed(auth.user);
      deps.report('auth.login', { method: 'app' });
    },
  };
}
