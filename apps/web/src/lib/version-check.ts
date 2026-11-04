import { useEffect, useState } from 'react';

/**
 * Versão nova no ar.
 *
 * O web app não guarda nada em cache (o service worker só recebe push), então
 * recarregar a página já traz a versão nova. O problema é que ninguém
 * recarrega: no iPhone, o web app da tela inicial fica aberto por dias e só
 * descobria o deploy quando uma tela ainda não baixada falhava
 * (`chunks.ts`). Aqui a página compara, de tempos em tempos, o arquivo
 * principal que ela carregou com o que o servidor entrega hoje no
 * `index.html`; se mudou, avisa e oferece atualizar.
 *
 * Quando confere: ao voltar para o app (visibilitychange, no máximo uma vez
 * por minuto) e a cada 10 minutos com o app aberto. Nunca recarrega sozinho:
 * a pessoa pode estar no meio de um cadastro.
 */

const CHECK_EVERY_MS = 10 * 60_000;
const MIN_GAP_MS = 60_000;

/** O arquivo principal desta versão, como o index.html o referencia. */
function currentEntry(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  if (!script) return null;
  try {
    return new URL(script.src, window.location.origin).pathname;
  } catch {
    return null;
  }
}

function entryFromHtml(html: string): string | null {
  const match = /<script[^>]+type="module"[^>]+src="([^"]+)"/i.exec(html) ?? /<script[^>]+src="([^"]+)"[^>]+type="module"/i.exec(html);
  if (!match?.[1]) return null;
  try {
    return new URL(match[1], window.location.origin).pathname;
  } catch {
    return null;
  }
}

let lastCheckAt = 0;
let known: boolean | null = null;

/** `true` quando o servidor já entrega outra versão; `null` quando não dá para saber. */
export async function newVersionAvailable(force = false): Promise<boolean | null> {
  if (import.meta.env.DEV) return false;
  if (known) return true;
  if (!force && Date.now() - lastCheckAt < MIN_GAP_MS) return known;
  lastCheckAt = Date.now();
  const mine = currentEntry();
  if (!mine) return null;
  try {
    const response = await fetch('/app/', { cache: 'no-store', headers: { accept: 'text/html' }, credentials: 'omit' });
    if (!response.ok) return null;
    const theirs = entryFromHtml(await response.text());
    if (!theirs) return null;
    known = theirs !== mine;
    return known;
  } catch {
    return null;
  }
}

/** Para a tela: `true` quando há versão nova e vale mostrar o aviso. */
export function useNewVersion(): boolean {
  const [available, setAvailable] = useState(known === true);
  useEffect(() => {
    let alive = true;
    const check = (force = false) => {
      void newVersionAvailable(force).then((value) => {
        if (alive && value) setAvailable(true);
      });
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    const timer = window.setInterval(() => check(), CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', onVisible);
    // Primeira conferência logo depois de abrir, para quem abriu o web app
    // guardado pelo sistema (iPhone) numa versão já antiga.
    const first = window.setTimeout(() => check(true), 5_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.clearTimeout(first);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return available;
}
