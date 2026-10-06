import { useEffect, useState } from 'react';

import { fetchBlob } from '../api/client';
import { Icon } from '../components/Icon';

import '../styles/pages-stock.css';

/**
 * Imagens de produto vêm de uma rota autenticada (`<img src>` não envia o
 * token), então são baixadas com `fetch` e viram um endereço local (`blob:`).
 *
 * O conteúdo de um hash nunca muda, por isso: o navegador guarda a resposta
 * para sempre (a API manda `immutable`) e aqui há um cache em memória que
 * evita repetir a conversão ao rolar a lista. Trocar a foto troca o hash, e
 * com ele a "URL": nunca aparece versão velha.
 */

const MAX_ENTRIES = 300;
const urls = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

function remember(key: string, url: string): void {
  urls.set(key, url);
  // Descarta as mais antigas (a ordem de inserção do Map serve de fila).
  while (urls.size > MAX_ENTRIES) {
    const oldest = urls.keys().next().value;
    if (oldest === undefined) break;
    const old = urls.get(oldest);
    urls.delete(oldest);
    // Uma imagem ainda na tela e já descartada daqui só custa um novo
    // carregamento quando for pedida de novo (o navegador tem a resposta em
    // cache HTTP); com 300 entradas isso quase não acontece.
    if (old) URL.revokeObjectURL(old);
  }
}

export function loadProductImage(workspaceId: string, hash: string): Promise<string> {
  const key = `${workspaceId}/${hash}`;
  const known = urls.get(key);
  if (known) return Promise.resolve(known);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const request = fetchBlob(`/v1/workspaces/${workspaceId}/images/${hash}`)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      remember(key, url);
      return url;
    })
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

/** Ao sair da conta: nada de imagem de uma empresa ficando na memória da página. */
export function clearProductImages(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}

type State = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'error' };

export function useProductImage(workspaceId: string, hash: string | null | undefined): State | null {
  const [state, setState] = useState<State | null>(() => {
    if (!hash) return null;
    const cached = urls.get(`${workspaceId}/${hash}`);
    return cached ? { status: 'ready', url: cached } : { status: 'loading' };
  });

  useEffect(() => {
    if (!hash) {
      setState(null);
      return;
    }
    let cancelled = false;
    const cached = urls.get(`${workspaceId}/${hash}`);
    if (cached) {
      setState({ status: 'ready', url: cached });
      return;
    }
    setState({ status: 'loading' });
    loadProductImage(workspaceId, hash).then(
      (url) => !cancelled && setState({ status: 'ready', url }),
      () => !cancelled && setState({ status: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, hash]);

  return state;
}

/** Miniatura/foto do produto, com espaço reservado enquanto carrega e quando não há foto. */
export function ProductImage({ workspaceId, hash, name, size = 44, className = '' }: { workspaceId: string; hash: string | null | undefined; name: string; size?: number; className?: string }) {
  const state = useProductImage(workspaceId, hash);
  return (
    <span className={`pimg ${className}`} style={{ width: size, height: size }}>
      {state?.status === 'ready' ? (
        <img src={state.url} alt={`Foto de ${name}`} loading="lazy" decoding="async" draggable={false} />
      ) : state?.status === 'loading' ? (
        <span className="pimg__loading" aria-hidden="true" />
      ) : (
        <Icon name="box" size={Math.round(size * 0.45)} className="pimg__empty" />
      )}
    </span>
  );
}
