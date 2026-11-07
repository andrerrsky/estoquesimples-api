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

  it('aceito (aviso atual): carrega uma vez, mede anúncios e nunca personaliza', async () => {
    const ga = await freshGa();
    ga.bootGa();
    ga.setConsent('granted');
    ga.setConsent('granted');
    expect(browser.scripts).toHaveLength(1);
    expect(browser.scripts[0]?.src).toContain(`id=${ID}`);
    expect(browser.local.getItem('es_cookie_consent')).toBe('granted_v2');
    const consent = browser.calls().find((call) => call[0] === 'consent');
    expect(consent?.[2]).toMatchObject({ analytics_storage: 'granted', ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'denied' });
    expect(configOf(browser)).toMatchObject({ allow_google_signals: false, allow_ad_personalization_signals: false });
    expect(ga.consentNeedsPrompt()).toBe(false);
    expect(ga.attributionConsent()).toBe('v2_accepted');
  });

  it('aceite do aviso antigo: continua só análise e o aviso novo aparece de novo', async () => {
    browser.local.setItem('es_cookie_consent', 'granted');
    const ga = await freshGa();
    ga.bootGa();
    expect(browser.scripts).toHaveLength(1);
    const consent = browser.calls().find((call) => call[0] === 'consent');
    expect(consent?.[2]).toMatchObject({ analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    expect(ga.consentNeedsPrompt()).toBe(true);
    expect(ga.adsMeasurementAllowed()).toBe(false);
    expect(ga.attributionConsent()).toBe('v1_accepted');

    // Aceitou o texto novo na mesma página: a medição de anúncios liga na hora.
    ga.setConsent('granted');
    const update = browser.calls().filter((call) => call[0] === 'consent' && call[1] === 'update').at(-1);
    expect(update?.[2]).toMatchObject({ ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'denied' });
    expect(ga.consentNeedsPrompt()).toBe(false);
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

describe('evento antes do boot da página', () => {
  it('tela que emite ao montar (signup.started) antes do bootGa do App: o evento sai e a campanha não é reenviada depois', async () => {
    browser = installBrowser(AD_URL);
    let ga = await freshGa();
    ga.setConsent('granted');

    browser.open('https://estoquesimples.com.br/criar-conta?utm_source=google&utm_medium=cpc&utm_campaign=teste_campanha&es_debug=1');
    ga = await freshGa();
    ga.gaEvent('signup.started'); // efeito do filho (RegisterPage)
    ga.bootGa(); // efeito do pai (App)
    expect(browser.scripts).toHaveLength(1);
    expect(browser.events('signup_started')).toHaveLength(1);
    expect(configOf(browser)).toMatchObject({ debug_mode: true });
    expect(browser.calls().filter((call) => call[0] === 'config')).toHaveLength(1);

    // Página seguinte sem UTMs: a campanha já foi entregue e não volta.
    browser.open('https://estoquesimples.com.br/app');
    ga = await freshGa();
    ga.bootGa();
    expect(String(configOf(browser)?.['page_location'])).toBe('https://estoquesimples.com.br/app');
    expect(configOf(browser)).toMatchObject({ debug_mode: true });
  });

  it('sem consentimento, o evento antecipado continua sem carregar nada', async () => {
    browser = installBrowser('https://estoquesimples.com.br/criar-conta');
    const ga = await freshGa();
    ga.gaEvent('signup.started');
    ga.bootGa();
    expect(browser.scripts).toHaveLength(0);
    expect(browser.window.dataLayer).toBeUndefined();
  });
});

describe('referenciador', () => {
  it('a página anterior vai sem query string: nem token, nem marcações de teste', async () => {
    browser = installBrowser('https://estoquesimples.com.br/redefinir-senha?token=segredo&es_debug=1');
    browser.open('https://estoquesimples.com.br/entrar');
    const ga = await freshGa();
    ga.setConsent('granted');
    expect(configOf(browser)?.['page_referrer']).toBe('https://estoquesimples.com.br/redefinir-senha');
  });

  it('de fora (anúncio, busca): só origem e caminho; sem referenciador, vazio', async () => {
    browser = installBrowser('https://estoquesimples.com.br/?gclid=abc', 'https://www.googleadservices.com/pagead/aclk?sa=L&ai=xyz');
    let ga = await freshGa();
    ga.setConsent('granted');
    expect(configOf(browser)?.['page_referrer']).toBe('https://www.googleadservices.com/pagead/aclk');

    browser = installBrowser('https://estoquesimples.com.br/');
    ga = await freshGa();
    ga.setConsent('granted');
    expect(configOf(browser)?.['page_referrer']).toBe('');
  });
});
