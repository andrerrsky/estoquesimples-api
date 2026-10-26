/**
 * "Lembrar meu e-mail" na tela de entrada: guarda só o e-mail neste
 * navegador, quando a caixa está marcada no momento em que o login dá certo;
 * desmarcada, apaga. A senha nunca vai para o localStorage (que não é
 * cifrado e fica ao alcance de qualquer script ou extensão): quem quer
 * guardar a senha usa o gerenciador de senhas do navegador, que o campo
 * oferece (`autocomplete="current-password"`), e a sessão já dura 60 dias.
 */

const KEY = 'es_web_remembered_login';

export interface RememberedLogin {
  email: string;
}

export function readRememberedLogin(): RememberedLogin | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as { email?: unknown; password?: unknown } | null;
    if (typeof data?.email !== 'string') return null;
    // Versões antigas guardavam a senha também: regrava só o e-mail.
    if ('password' in (data ?? {})) localStorage.setItem(KEY, JSON.stringify({ email: data.email }));
    return { email: data.email };
  } catch {
    // armazenamento bloqueado ou conteúdo corrompido: como se não houvesse nada
    return null;
  }
}

/** Marcado: grava o e-mail. Desmarcado: remove. Nunca lança (o login já deu certo). */
export function applyRememberedLogin(remember: boolean, login: RememberedLogin): void {
  try {
    if (remember) localStorage.setItem(KEY, JSON.stringify({ email: login.email }));
    else localStorage.removeItem(KEY);
  } catch {
    // sem armazenamento: a pessoa só não verá o e-mail preenchido da próxima vez
  }
}
