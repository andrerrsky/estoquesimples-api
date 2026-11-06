import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installBrowser, type FakeBrowser } from './fake-browser';

type GaModule = typeof import('../src/lib/ga');

/** Cada carga de página tem o módulo (e o estado "já carregou") do zero. */
async function freshGa(): Promise<GaModule> {
  vi.resetModules();
  return import('../src/lib/ga');
}

const ID = 'G-V6S41QGPMS';
const AD_URL = 'https://estoquesimples.com.br/?utm_source=google&utm_medium=cpc&utm_campaign=teste_campanha&utm_content=anuncio_3&gclid=TeStGcLiD123&token=segredo&email=fulano%40exemplo.com';

function configOf(browser: FakeBrowser): Record<string, unknown> | undefined {
  const call = browser.calls().find((entry) => entry[0] === 'config');
  return call?.[2] as Record<string, unknown> | undefined;
}

let browser: FakeBrowser;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('consentimento', () => {
  beforeEach(() => {
    browser = installBrowser(AD_URL);
  });

  it('sem escolha ainda: não baixa o gtag.js nem envia nada', async () => {
    const ga = await freshGa();
    ga.bootGa();
    ga.gaEvent('cta.criar_conta', { location: 'hero' });
    expect(browser.scripts).toHaveLength(0);
    expect(browser.window.dataLayer).toBeUndefined();
  });

  it('recusado: não baixa nada, não envia nada e não guarda a campanha', async () => {
    const ga = await freshGa();
    ga.setConsent('denied');
    ga.bootGa();
    ga.loadGa();
    ga.gaEvent('signup.completed', { method: 'email' });
    expect(browser.scripts).toHaveLength(0);
    expect(browser.window.dataLayer).toBeUndefined();
    expect(browser.session.getItem('es_campanha')).toBeNull();
  });

  it('aceito: carrega uma vez, sem sinais de publicidade', async () => {
    const ga = await freshGa();
    ga.bootGa();
    ga.setConsent('granted');
    ga.setConsent('granted');
    expect(browser.scripts).toHaveLength(1);
    expect(browser.scripts[0]?.src).toContain(`id=${ID}`);
    const consent = browser.calls().find((call) => call[0] === 'consent');
    expect(consent?.[2]).toMatchObject({ analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    expect(configOf(browser)).toMatchObject({ allow_google_signals: false, allow_ad_personalization_signals: false });
  });

  it('revogado depois de aceitar: o gtag é desligado e nenhum evento sai mais', async () => {
    const ga = await freshGa();
    ga.setConsent('granted');
    ga.gaEvent('cta.criar_conta', { location: 'hero' });
    expect(browser.events('cta_criar_conta')).toHaveLength(1);

    ga.setConsent('denied');
    const before = browser.calls().length;
    ga.gaEvent('signup.completed', { method: 'email' });
    ga.gaEvent('cta.criar_conta', { location: 'hero' });
    expect(browser.window[`ga-disable-${ID}`]).toBe(true);
    expect(browser.calls().slice(before)).toHaveLength(0);
    expect(browser.calls().some((call) => call[0] === 'consent' && (call[2] as Record<string, unknown>)['analytics_storage'] === 'denied')).toBe(true);
    expect(browser.session.getItem('es_campanha')).toBeNull();

    // Na próxima página, com a recusa gravada, o gtag nem é baixado.
    browser.open('https://estoquesimples.com.br/criar-conta');
    const next = await freshGa();
    next.bootGa();
    expect(browser.scripts).toHaveLength(0);
  });

  it('aceitar de novo na mesma página religa o envio', async () => {
    const ga = await freshGa();
    ga.setConsent('granted');
    ga.setConsent('denied');
    ga.setConsent('granted');
    expect(browser.window[`ga-disable-${ID}`]).toBe(false);
    ga.gaEvent('cta.entrar');
    expect(browser.events('cta_entrar')).toHaveLength(1);
  });
});

describe('parâmetros de campanha', () => {
  it('só UTMs e identificadores de clique vão no endereço; token e e-mail ficam de fora', async () => {
    browser = installBrowser(AD_URL);
    const ga = await freshGa();
    ga.setConsent('granted');
    const location = String(configOf(browser)?.['page_location']);
    const url = new URL(location);
    expect(url.pathname).toBe('/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'teste_campanha',
      utm_content: 'anuncio_3',
      gclid: 'TeStGcLiD123',
    });
    expect(location).not.toContain('token');
    expect(location).not.toContain('exemplo');
  });

  it('descarta valores que parecem e-mail ou longos demais', async () => {
    browser = installBrowser('https://estoquesimples.com.br/?utm_source=google&utm_content=fulano@exemplo.com&utm_term=' + 'x'.repeat(200));
    const ga = await freshGa();
    expect(ga.campaignParams(browser.window.location.search).toString()).toBe('utm_source=google');
  });

  it('aceite só em /criar-conta: a campanha da página de entrada chega ao GA uma única vez', async () => {
    browser = installBrowser(AD_URL);
    const landing = await freshGa();
    landing.bootGa(); // sem escolha ainda: guarda na aba, não envia
    expect(browser.window.dataLayer).toBeUndefined();
    expect(browser.session.getItem('es_campanha')).toContain('utm_campaign=teste_campanha');
    expect(browser.session.getItem('es_campanha')).not.toContain('token');

    browser.open('https://estoquesimples.com.br/criar-conta');
    const signup = await freshGa();
    signup.bootGa();
    signup.setConsent('granted');
    const location = new URL(String(configOf(browser)?.['page_location']));
    expect(location.pathname).toBe('/criar-conta');
    expect(location.searchParams.get('gclid')).toBe('TeStGcLiD123');
    expect(location.searchParams.get('utm_content')).toBe('anuncio_3');

    // Páginas seguintes não repetem a campanha (o GA já tem a origem da sessão).
    browser.open('https://estoquesimples.com.br/app');
    const app = await freshGa();
    app.bootGa();
    expect(String(configOf(browser)?.['page_location'])).toBe('https://estoquesimples.com.br/app');
  });

  it('sem campanha, o endereço vai sem query string (como antes)', async () => {
    browser = installBrowser('https://estoquesimples.com.br/redefinir-senha?token=segredo');
    const ga = await freshGa();
    ga.setConsent('granted');
    expect(configOf(browser)?.['page_location']).toBe('https://estoquesimples.com.br/redefinir-senha');
  });
});

describe('tráfego interno e de teste', () => {
  it('?es_interno=1 marca o navegador como da equipe; ?es_interno=0 desmarca', async () => {
    browser = installBrowser('https://estoquesimples.com.br/?es_interno=1');
    let ga = await freshGa();
    ga.setConsent('granted');
    ga.bootGa();
    browser.open('https://estoquesimples.com.br/criar-conta');
    ga = await freshGa();
    ga.bootGa();
    expect(configOf(browser)).toMatchObject({ traffic_type: 'internal' });
    ga.gaEvent('cta.entrar');
    expect(browser.events('cta_entrar')[0]).toMatchObject({ traffic_type: 'internal' });
    expect(String(configOf(browser)?.['page_location'])).not.toContain('es_interno');

    browser.open('https://estoquesimples.com.br/?es_interno=0');
    ga = await freshGa();
    ga.bootGa();
    expect(configOf(browser)?.['traffic_type']).toBeUndefined();
  });

  it('?es_debug=1 liga o DebugView só nesta aba', async () => {
    browser = installBrowser('https://estoquesimples.com.br/?es_debug=1');
    const ga = await freshGa();
    ga.bootGa();
    ga.setConsent('granted');
    expect(configOf(browser)).toMatchObject({ debug_mode: true });
  });
});
