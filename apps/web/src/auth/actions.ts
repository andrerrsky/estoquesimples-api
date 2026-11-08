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
    google(credential: string): Promise<AuthResult & { isNew: boolean }>;
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
    /**
     * "Continuar com o Google". Conta criada agora → `signup.completed` (vira
     * `sign_up` no GA, com `method: google`); conta existente → login.
     * `onNew` roda antes de a sessão valer na tela (marca as boas-vindas).
     */
    async loginWithGoogle(credential: string, onNew?: () => void): Promise<{ isNew: boolean }> {
      const auth = await deps.sessionApi.google(credential);
      deps.onAccountSwitch();
      if (auth.isNew) onNew?.();
      deps.onAuthed(auth.user);
      deps.report(auth.isNew ? 'signup.completed' : 'auth.login', { method: 'google' });
      return { isNew: auth.isNew };
    },
    async loginWithAppCode(code: string): Promise<void> {
      const auth = await deps.sessionApi.handoff(code);
      deps.onAccountSwitch();
      deps.onAuthed(auth.user);
      deps.report('auth.login', { method: 'app' });
    },
  };
}
