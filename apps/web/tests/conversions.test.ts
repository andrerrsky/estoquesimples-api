import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { User } from '../src/api/types';
import { installBrowser, type FakeBrowser } from './fake-browser';

const USER = { id: 'u-teste', name: 'Conta de Teste', email: 'teste@exemplo.com.br', emailVerified: false } as unknown as User;

let browser: FakeBrowser;
let ga: typeof import('../src/lib/ga');
let createAuthActions: typeof import('../src/auth/actions').createAuthActions;

beforeEach(async () => {
  browser = installBrowser('https://estoquesimples.com.br/criar-conta?utm_source=google&utm_medium=cpc');
  vi.resetModules();
  ga = await import('../src/lib/ga');
  ({ createAuthActions } = await import('../src/auth/actions'));
  ga.setConsent('granted');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function actions(overrides: Partial<Parameters<typeof createAuthActions>[0]['sessionApi']> = {}) {
  const onAuthed = vi.fn();
  const built = createAuthActions({
    sessionApi: {
      login: vi.fn(async () => ({ user: USER })),
      register: vi.fn(async () => ({ user: USER })),
      handoff: vi.fn(async () => ({ user: USER })),
      ...overrides,
    },
    onAuthed,
    onAccountSwitch: vi.fn(),
    report: ga.gaEvent,
  });
  return { ...built, onAuthed };
}

describe('sign_up (conversão importada no Google Ads)', () => {
  it('cadastro confirmado pela API: exatamente um sign_up, sem dado pessoal', async () => {
    const { register, onAuthed } = actions();
    await register('Conta de Teste', 'teste@exemplo.com.br', 'senha-de-teste-123');
    expect(onAuthed).toHaveBeenCalledTimes(1);
    expect(browser.events('sign_up')).toEqual([{ method: 'email' }]);
    // O evento próprio espelhado continua, mas não é conversão no Ads.
    expect(browser.events('signup_completed')).toHaveLength(1);
    expect(JSON.stringify(browser.calls())).not.toContain('exemplo.com.br');
    expect(JSON.stringify(browser.calls())).not.toContain('Conta de Teste');
  });

  it('cadastro recusado (e-mail já usado, senha fraca, rede): nenhum sign_up', async () => {
    const { register, onAuthed } = actions({
      register: vi.fn(async () => {
        throw new Error('AUTH_EMAIL_IN_USE');
      }),
    });
    await expect(register('Conta', 'teste@exemplo.com.br', 'x')).rejects.toThrow();
    expect(onAuthed).not.toHaveBeenCalled();
    expect(browser.events('sign_up')).toHaveLength(0);
    expect(browser.events('signup_completed')).toHaveLength(0);
  });

  it('login e entrada pelo app não contam como cadastro', async () => {
    const { login, loginWithAppCode } = actions();
    await login('teste@exemplo.com.br', 'senha-de-teste-123');
    await loginWithAppCode('codigo-teste');
    expect(browser.events('sign_up')).toHaveLength(0);
    expect(browser.events('login')).toEqual([{ method: 'email' }, { method: 'app' }]);
  });

  it('login recusado: nenhum evento', async () => {
    const { login } = actions({
      login: vi.fn(async () => {
        throw new Error('AUTH_INVALID_CREDENTIALS');
      }),
    });
    await expect(login('teste@exemplo.com.br', 'errada')).rejects.toThrow();
    expect(browser.calls().filter((call) => call[0] === 'event')).toHaveLength(0);
  });

  it('dois cadastros bem-sucedidos são duas conversões; nada além disso', async () => {
    const { register } = actions();
    await register('A', 'a@exemplo.com.br', 'senha-de-teste-123');
    await register('B', 'b@exemplo.com.br', 'senha-de-teste-123');
    expect(browser.events('sign_up')).toHaveLength(2);
  });

  it('sem consentimento o cadastro funciona e nada vai ao Google', async () => {
    browser = installBrowser('https://estoquesimples.com.br/criar-conta');
    vi.resetModules();
    ga = await import('../src/lib/ga');
    ({ createAuthActions } = await import('../src/auth/actions'));
    ga.setConsent('denied');
    const { register, onAuthed } = actions();
    await register('Conta', 'teste@exemplo.com.br', 'senha-de-teste-123');
    expect(onAuthed).toHaveBeenCalledTimes(1);
    expect(browser.window.dataLayer).toBeUndefined();
  });
});

describe('primeiro produto (sinal de ativação)', () => {
  it('só o cadastro que a API marca como primeiro emite product_first_created', async () => {
    const { productSavedEvents } = await import('../src/lib/activation');
    const emit = (isNew: boolean, saved: { firstProduct?: boolean }) => {
      const events = productSavedEvents(isNew, saved);
      ga.gaEvent(events.track);
      if (events.ga) ga.gaEvent(events.ga);
    };
    emit(true, { firstProduct: true });
    emit(true, { firstProduct: false });
    emit(true, {});
    emit(false, { firstProduct: true });
    expect(browser.events('product_first_created')).toHaveLength(1);
    expect(browser.events('product_created')).toHaveLength(3);
    expect(browser.events('product_updated')).toHaveLength(1);
  });
});
