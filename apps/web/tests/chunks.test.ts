import { describe, expect, it, vi } from 'vitest';

import { installBrowser } from './fake-browser';

describe('telas carregadas sob demanda', () => {
  it('pedaço sem a tela dentro recarrega a página em vez de quebrar o React', async () => {
    const browser = installBrowser('https://estoquesimples.com.br/entrar');
    const reload = vi.fn();
    (browser.window.location as unknown as { reload: () => void }).reload = reload;
    const { pageComponent } = await import('../src/lib/chunks');

    // A tela está lá: vem pronta para o `lazy`.
    const Tela = () => null;
    await expect(pageComponent({ LoginPage: Tela }, 'LoginPage')).resolves.toEqual({ default: Tela });

    // Não está: a página recarrega e a promessa fica pendente (sem erro na tela).
    const pending = pageComponent({} as { LoginPage?: () => null }, 'LoginPage');
    const settled = await Promise.race([pending.then(() => 'resolveu', () => 'falhou'), Promise.resolve('pendente')]);
    expect(settled).toBe('pendente');
    expect(reload).toHaveBeenCalledTimes(1);

    // Recarregou agora há pouco: em vez de entrar em laço, o erro sai com nome.
    await expect(pageComponent({} as { LoginPage?: () => null }, 'LoginPage')).rejects.toThrow('LoginPage');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
