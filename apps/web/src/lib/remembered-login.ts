/**
 * "Lembrar meus dados" na tela de entrada: guarda e-mail e senha no
 * localStorage deste navegador, só quando a caixa está marcada no momento em
 * que o login dá certo; desmarcada, apaga o que havia. É o mesmo comportamento
 * do app Android. O localStorage não é cifrado: qualquer pessoa com acesso a
 * este navegador consegue ler, por isso a caixa começa desmarcada.
 */

const KEY = 'es_web_remembered_login';

export interface RememberedLogin {
  email: string;
  password: string;
}

export function readRememberedLogin(): RememberedLogin | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<RememberedLogin> | null;
    if (typeof data?.email !== 'string' || typeof data.password !== 'string') return null;
    return { email: data.email, password: data.password };
  } catch {
    // armazenamento bloqueado ou conteúdo corrompido: como se não houvesse nada
    return null;
  }
}

/** Marcado: grava. Desmarcado: remove. Nunca lança (o login já deu certo). */
export function applyRememberedLogin(remember: boolean, login: RememberedLogin): void {
  try {
    if (remember) localStorage.setItem(KEY, JSON.stringify(login));
    else localStorage.removeItem(KEY);
  } catch {
    // sem armazenamento: a pessoa só não verá os campos preenchidos da próxima vez
  }
}
