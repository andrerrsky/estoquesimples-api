import { afterEach, describe, expect, it, vi } from 'vitest';

import { installBrowser } from './fake-browser';

type AttributionModule = typeof import('../src/lib/attribution');

async function fresh(): Promise<{ attribution: AttributionModule; ga: typeof import('../src/lib/ga') }> {
  vi.resetModules();
  return { attribution: await import('../src/lib/attribution'), ga: await import('../src/lib/ga') };
}

const AD_URL =
  'https://estoquesimples.com.br/?utm_source=google&utm_medium=cpc&utm_campaign=pesquisa_estoque&utm_content=salao&gclid=Cj0_teste-1.a&token=segredo&email=fulano%40exemplo.com';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('origem do cadastro (primeiro toque)', () => {
  it('guarda só os parâmetros de campanha e o caminho, sem esperar o aceite dos cookies', async () => {
    const browser = installBrowser(AD_URL);
    const { attribution } = await fresh();
    attribution.captureFirstTouch();
    expect(attribution.readFirstTouch()).toEqual({
      params: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'pesquisa_estoque', utm_content: 'salao', gclid: 'Cj0_teste-1.a' },
      landing: '/',
    });
    expect(browser.session.getItem('es_origem')).not.toContain('segredo');
    expect(browser.session.getItem('es_origem')).not.toContain('fulano');
    expect(browser.local.getItem('es_origem')).toBeNull();
  });

  it('primeiro toque: outra página sem campanha, ou com outra campanha, não troca a origem', async () => {
    const browser = installBrowser(AD_URL);
    const { attribution } = await fresh();
    attribution.captureFirstTouch();
    browser.open('https://estoquesimples.com.br/criar-conta?utm_source=outra');
    attribution.captureFirstTouch();
    expect(attribution.readFirstTouch()?.params.utm_source).toBe('google');
    expect(attribution.originContent()).toBe('salao');
  });

  it('cadastro leva a origem com a escolha de cookies; visita direta não leva nada', async () => {
    installBrowser(AD_URL);
    const { attribution, ga } = await fresh();
    attribution.captureFirstTouch();
    expect(attribution.signupAttribution()).toMatchObject({ gclid: 'Cj0_teste-1.a', landing: '/', consent: 'none' });
    ga.setConsent('denied');
    expect(attribution.signupAttribution()?.consent).toBe('refused');
    ga.setConsent('granted');
    expect(attribution.signupAttribution()?.consent).toBe('v2_accepted');

    installBrowser('https://estoquesimples.com.br/criar-conta');
    const again = await fresh();
    again.attribution.captureFirstTouch();
    expect(again.attribution.signupAttribution()).toBeUndefined();
  });

  it('identificador de clique fora do formato é descartado', async () => {
    installBrowser('https://estoquesimples.com.br/?gclid=abc%20def%3Cscript%3E&utm_source=google');
    const { attribution } = await fresh();
    attribution.captureFirstTouch();
    expect(attribution.readFirstTouch()?.params).toEqual({ utm_source: 'google' });
  });

  it('landing.viewed sai para o analytics próprio com UTMs e has_click_id, nunca o gclid', async () => {
    installBrowser(AD_URL);
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    const { attribution } = await fresh();
    attribution.sendLandingViewed();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/v1/analytics/events');
    const body = String(init.body);
    expect(JSON.parse(body).events[0]).toMatchObject({
      name: 'landing.viewed',
      properties: { utm_source: 'google', utm_campaign: 'pesquisa_estoque', utm_content: 'salao', has_click_id: true },
    });
    expect(body).not.toContain('Cj0_teste');
  });
});

describe('textos por segmento', () => {
  it('título da página inicial e dica do estoque vazio só para segmentos conhecidos', async () => {
    const { landingTitleFor } = await import('../src/pages/LandingPage');
    expect(landingTitleFor('salao')).toContain('salão');
    expect(landingTitleFor('planilha')).toContain('planilha');
    expect(landingTitleFor('qualquer')).toBeNull();
    expect(landingTitleFor(null)).toBeNull();
  });
});

describe('primeiro contato', () => {
  it('o aviso de confirmar e-mail espera o primeiro produto ou 24 h de conta', async () => {
    const browser = installBrowser('https://estoquesimples.com.br/app/estoque');
    const { attribution } = await fresh();
    const now = Date.parse('2026-11-07T15:00:00Z');
    expect(attribution.emailReminderDue('2026-11-07T14:00:00Z', now)).toBe(false);
    expect(attribution.emailReminderDue('2026-11-06T14:00:00Z', now)).toBe(true);
    attribution.markFirstProduct();
    expect(browser.local.getItem('es_primeiro_produto')).toBe('1');
    expect(attribution.emailReminderDue('2026-11-07T14:00:00Z', now)).toBe(true);
  });

  it('segmento: o do anúncio vale primeiro; sem anúncio, o escolhido nas boas-vindas (lista fechada)', async () => {
    installBrowser('https://estoquesimples.com.br/app/estoque');
    const { attribution } = await fresh();
    expect(attribution.segmentContent()).toBeNull();
    attribution.setChosenSegment('roupas');
    expect(attribution.segmentContent()).toBe('roupas');
    attribution.setChosenSegment('<script>');
    expect(attribution.segmentContent()).toBeNull();

    installBrowser(AD_URL);
    const again = await fresh();
    again.attribution.captureFirstTouch();
    again.attribution.setChosenSegment('roupas');
    expect(again.attribution.segmentContent()).toBe('salao');
  });
});
