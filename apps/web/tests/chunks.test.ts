import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryStorage } from './fake-browser';

/**
 * Monta o mínimo de que `lib/chunks` precisa: `sessionStorage` (ele conta ali
 * a última recarga) e um `window.location.reload` que só anota a chamada.
 */
function instalar() {
  const session = new MemoryStorage();
  const reloads: number[] = [];
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('window', { location: { reload: () => reloads.push(Date.now()) }, sessionStorage: session });
  return { session, reloads };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('telas carregadas sob demanda', () => {
  it('reconhece a falha de importação de uma versão que saiu do ar', async () => {
    instalar();
    const { isChunkLoadError } = await import('../src/lib/chunks');
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: /assets/StockPage-abc.js'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('NetworkError ao buscar o produto'))).toBe(false);
  });

  it('recarrega uma vez quando o arquivo da tela não traz o componente, e fica carregando', async () => {
    const { reloads } = instalar();
    const { pageFromNewVersion } = await import('../src/lib/chunks');

    const pendente = pageFromNewVersion<{ default: unknown }>();
    expect(reloads).toHaveLength(1);
    // Fica pendente de propósito: a pessoa continua vendo "carregando".
    const corrida = await Promise.race([pendente.then(() => 'resolveu'), Promise.resolve('pendente')]);
    expect(corrida).toBe('pendente');
  });

  it('não entra em laço: recarga recente lança em vez de recarregar de novo', async () => {
    const { reloads } = instalar();
    const { pageFromNewVersion } = await import('../src/lib/chunks');

    void pageFromNewVersion<{ default: unknown }>();
    expect(() => pageFromNewVersion<{ default: unknown }>()).toThrow(/não pôde ser carregada/);
    expect(reloads).toHaveLength(1);
  });

  it('importPage recarrega na falha de versão e repassa os outros erros', async () => {
    const { reloads } = instalar();
    const { importPage } = await import('../src/lib/chunks');

    const pendente = importPage(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
    expect(await Promise.race([pendente.then(() => 'resolveu'), Promise.resolve('pendente')])).toBe('pendente');
    expect(reloads).toHaveLength(1);

    await expect(importPage(() => Promise.reject(new Error('500 do servidor')))).rejects.toThrow('500 do servidor');
  });
});
