import { describe, expect, it } from 'vitest';

import { installBrowser } from './fake-browser';

describe('/comece: link da Play com a origem do anúncio', () => {
  it('leva as UTMs no referrer e marca a página quando não há anúncio', async () => {
    installBrowser('https://estoquesimples.com.br/comece');
    const { playUrlWithReferrer } = await import('../src/pages/ComecePage');
    const url = new URL(playUrlWithReferrer('?utm_source=google&utm_medium=cpc&utm_campaign=pesquisa_app&utm_term=app%20de%20estoque&gclid=X'));
    expect(url.searchParams.get('id')).toBe('br.com.gameloop.estoquesimples');
    const ref = new URLSearchParams(url.searchParams.get('referrer') ?? '');
    expect(Object.fromEntries(ref)).toEqual({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'pesquisa_app', utm_term: 'app de estoque' });
    expect(new URLSearchParams(new URL(playUrlWithReferrer('')).searchParams.get('referrer') ?? '').get('utm_medium')).toBe('comece');
  });
});
