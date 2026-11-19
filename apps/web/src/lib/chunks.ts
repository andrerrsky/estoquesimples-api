/**
 * Telas carregadas sob demanda e versões novas.
 *
 * Cada tela é um arquivo com o nome da versão (`SupportPage-<hash>.js`).
 * Depois de um deploy, uma aba que já estava aberta ainda conhece os nomes
 * antigos, que não existem mais no servidor: ao abrir uma tela que ela ainda
 * não tinha baixado, a importação falha. O remédio é recarregar a página — o
 * `index.html` nunca é guardado em cache, então ela volta na versão nova.
 */

const RELOAD_KEY = 'es_web_reloaded_at';

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|module script failed|Unable to preload CSS|ChunkLoadError/i.test(message);
}

/**
 * Recarrega a página, no máximo uma vez a cada meio minuto: se a falha não
 * for de versão (rede fora do ar, por exemplo), recarregar de novo só criaria
 * um laço. Sem `sessionStorage` não há como contar, então não recarrega.
 *
 * @returns `true` se a página está sendo recarregada.
 */
export function reloadForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** Importação de tela que se recupera sozinha de uma versão nova no ar. */
export function importPage<T>(loader: () => Promise<T>): Promise<T> {
  return loader().catch((error: unknown) => {
    // Enquanto a página recarrega, a promessa fica pendente (a tela segue no
    // "carregando") em vez de mostrar um erro por um instante.
    if (isChunkLoadError(error) && reloadForNewVersion()) return new Promise<T>(() => undefined);
    throw error;
  });
}

/**
 * A tela que veio no arquivo, pronta para o `lazy` do React.
 *
 * Quando o pedaço chega sem a tela dentro (restou de uma versão antiga, ou
 * uma extensão do navegador mexeu no arquivo), o React quebra com um erro
 * sem nome — "Minified React error #306" — que em Admin › Erros não diz
 * nem qual tela era. Aqui a página se recupera recarregando, como faz com
 * um pedaço que não existe mais; se não puder recarregar, o erro ao menos
 * tem nome.
 */
export function pageComponent<T, N extends keyof T>(module: T, name: N): Promise<{ default: T[N] }> {
  const component = module[name] as unknown;
  if (typeof component !== 'function') {
    if (reloadForNewVersion()) return new Promise<{ default: T[N] }>(() => undefined);
    return Promise.reject(new Error(`Tela ${String(name)} não veio no pacote do app`));
  }
  return Promise.resolve({ default: component as T[N] });
}
