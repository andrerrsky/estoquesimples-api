import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PublicPromo } from '../src/api/types';
import {
  barVisible,
  captureCouponFromUrl,
  countdown,
  couponErrorMessage,
  dayInBrazil,
  discountPct,
  landingCtaUrl,
  monthlyEquivalentCents,
  normalizeCoupon,
  promoPhase,
  promoTexts,
  readCoupon,
  saveCoupon,
  syncCouponWithPromo,
} from '../src/lib/promo';
import { installBrowser } from './fake-browser';

// Vigência da especificação: 20/11/2026 00:00 a 01/12/2026 23:59:59 (Brasília).
const STARTS = '2026-11-20T03:00:00.000Z';
const ENDS = '2026-12-02T02:59:59.000Z';
const at = (iso: string) => Date.parse(iso);

const PRICES = {
  yearly: { fullCents: 19990, promoCents: 11990, monthlyEquivalentCents: 999 },
  monthly: { fullCents: 2499, firstCents: 1249, promoCycles: 1 },
};
const ACTIVE: PublicPromo = { active: true, upcoming: false, code: 'BF26', label: 'Black Friday', startsAt: STARTS, endsAt: ENDS, ...PRICES };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cupom guardado', () => {
  it('normaliza como a API: sem espaços, maiúsculas, até 32 caracteres seguros', () => {
    expect(normalizeCoupon('  bf26 ')).toBe('BF26');
    expect(normalizeCoupon('')).toBeNull();
    expect(normalizeCoupon('BF 26')).toBeNull();
    expect(normalizeCoupon('<script>')).toBeNull();
    expect(normalizeCoupon('A'.repeat(33))).toBeNull();
  });

  it('guarda o ?cupom= da URL e sobrevive a outra página (cadastro, login)', () => {
    const browser = installBrowser('https://estoquesimples.com.br/black-friday?cupom=bf26&utm_source=google');
    const now = at('2026-11-21T12:00:00Z');
    expect(captureCouponFromUrl(browser.window.location.search, now)).toBe('BF26');
    browser.open('https://estoquesimples.com.br/criar-conta');
    expect(readCoupon(now + 3_600_000)).toBe('BF26');
  });

  it('com a campanha carregada vale até o endsAt real e depois some', () => {
    installBrowser('https://estoquesimples.com.br/?cupom=BF26');
    const now = at('2026-11-21T12:00:00Z');
    captureCouponFromUrl('?cupom=BF26', now);
    syncCouponWithPromo(ACTIVE, now);
    expect(readCoupon(at('2026-12-02T02:59:00Z'))).toBe('BF26');
    expect(readCoupon(at('2026-12-02T03:00:00Z'))).toBeNull();
    // O vencido é apagado, não só ignorado.
    expect(readCoupon(now)).toBeNull();
  });

  it('sem a campanha carregada, a validade provisória é de 30 dias', () => {
    installBrowser('https://estoquesimples.com.br/');
    const now = at('2026-11-21T12:00:00Z');
    saveCoupon('BF26', null, now);
    expect(readCoupon(now + 29 * 86_400_000)).toBe('BF26');
    expect(readCoupon(now + 31 * 86_400_000)).toBeNull();
  });

  it('campanha encerrada apaga o cupom dela; nova captura não encurta a validade', () => {
    installBrowser('https://estoquesimples.com.br/');
    const now = at('2026-11-30T12:00:00Z');
    saveCoupon('BF26', ENDS, now);
    captureCouponFromUrl('?cupom=BF26', now);
    expect(readCoupon(at('2026-12-01T23:00:00-03:00'))).toBe('BF26');
    syncCouponWithPromo({ ...ACTIVE, active: false }, at('2026-12-02T04:00:00Z'));
    expect(readCoupon(now)).toBeNull();
  });

  it('não guarda cupom com fim já passado e não quebra sem localStorage', () => {
    installBrowser('https://estoquesimples.com.br/');
    saveCoupon('BF26', ENDS, at('2026-12-03T00:00:00Z'));
    expect(readCoupon(at('2026-11-21T00:00:00Z'))).toBeNull();
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('bloqueado');
      },
    });
    expect(() => saveCoupon('BF26', ENDS)).not.toThrow();
    expect(readCoupon()).toBeNull();
  });

  it('explica cada recusa em pt-BR', () => {
    expect(couponErrorMessage('expirado')).toMatch(/expirou/);
    expect(couponErrorMessage('ainda_nao_comecou')).toMatch(/20\/11/);
    expect(couponErrorMessage('invalido')).toMatch(/não encontrado/);
    expect(couponErrorMessage(null)).toMatch(/não encontrado/);
  });
});

describe('faixa do topo: fechada, volta só no último dia, uma vez', () => {
  it('nunca fechada aparece', () => {
    expect(barVisible(null, ENDS, at('2026-11-22T12:00:00Z'))).toBe(true);
  });

  it('fechada antes do último dia não volta até 01/12', () => {
    const dismissed = at('2026-11-22T12:00:00Z');
    expect(barVisible(dismissed, ENDS, at('2026-11-30T23:00:00Z'))).toBe(false);
    // 30/11 às 23h30 em Brasília ainda não é o último dia (já é 01/12 em UTC).
    expect(barVisible(dismissed, ENDS, at('2026-12-01T02:30:00Z'))).toBe(false);
    expect(barVisible(dismissed, ENDS, at('2026-12-01T03:00:00Z'))).toBe(true);
    expect(barVisible(dismissed, ENDS, at('2026-12-01T23:00:00-03:00'))).toBe(true);
  });

  it('fechada de novo no último dia não volta mais', () => {
    const lastDay = at('2026-12-01T09:00:00-03:00');
    expect(barVisible(lastDay, ENDS, at('2026-12-01T18:00:00-03:00'))).toBe(false);
  });

  it('sem data de fim, fechada fica fechada', () => {
    expect(barVisible(at('2026-11-22T12:00:00Z'), undefined, at('2026-12-01T12:00:00Z'))).toBe(false);
  });

  it('o dia é o de Brasília', () => {
    expect(dayInBrazil(at(ENDS))).toBe('2026-12-01');
  });
});

describe('fase da campanha', () => {
  it('segue a API e só antecipa o fim pelo relógio', () => {
    expect(promoPhase(null)).toBe('none');
    expect(promoPhase({ active: false, upcoming: false })).toBe('none');
    expect(promoPhase({ ...ACTIVE, active: false, upcoming: true }, at('2026-11-15T00:00:00Z'))).toBe('upcoming');
    expect(promoPhase(ACTIVE, at('2026-11-25T00:00:00Z'))).toBe('active');
    expect(promoPhase(ACTIVE, at('2026-12-02T03:00:00Z'))).toBe('ended');
    expect(promoPhase({ ...ACTIVE, active: false }, at('2026-12-05T00:00:00Z'))).toBe('ended');
  });
});

describe('preços', () => {
  it('formata em BRL e mostra o anual com o equivalente mensal', () => {
    const t = promoTexts(PRICES);
    expect(t.yearlyFull).toBe('R$ 199,90');
    expect(t.yearlyPromo).toBe('R$ 119,90');
    expect(t.yearlyPerMonth).toBe('R$ 9,99');
    expect(t.yearlyPct).toBe(40);
    expect(t.monthlyFirst).toBe('R$ 12,49');
    expect(t.monthlyFull).toBe('R$ 24,99');
    expect(t.monthlyFirstLabel).toBe('1º mês');
    expect(t.yearlyRenewal).toBe('Renova por R$ 199,90/ano, com aviso antes.');
    expect(t.monthlyRenewal).toBe('A partir da 2ª cobrança, R$ 24,99/mês, com aviso antes.');
  });

  it('equivalente por mês arredonda para baixo, nunca anuncia a mais', () => {
    expect(monthlyEquivalentCents(11990)).toBe(999);
    expect(monthlyEquivalentCents(12000)).toBe(1000);
    expect(monthlyEquivalentCents(11999)).toBe(999);
    const t = promoTexts({ ...PRICES, yearly: { ...PRICES.yearly, monthlyEquivalentCents: 0 } });
    expect(t.yearlyPerMonth).toBe('R$ 9,99');
  });

  it('desconto em %', () => {
    expect(discountPct(19990, 11990)).toBe(40);
    expect(discountPct(2499, 1249)).toBe(50);
    expect(discountPct(0, 100)).toBe(0);
  });

  it('mais de um ciclo promocional no mensal', () => {
    const t = promoTexts({ ...PRICES, monthly: { ...PRICES.monthly, promoCycles: 2 } });
    expect(t.monthlyFirstLabel).toBe('2 primeiros meses');
    expect(t.monthlyRenewal).toMatch(/^A partir da 3ª cobrança/);
  });
});

describe('contagem regressiva e CTA da landing', () => {
  it('conta até o endsAt e para no zero', () => {
    expect(countdown(ENDS, at('2026-11-30T02:59:59.000Z'))).toEqual({ days: 2, hours: 0, minutes: 0, seconds: 0, done: false });
    expect(countdown(ENDS, at('2026-12-02T02:58:58.000Z'))).toEqual({ days: 0, hours: 0, minutes: 1, seconds: 1, done: false });
    expect(countdown(ENDS, at('2026-12-03T00:00:00Z')).done).toBe(true);
    expect(countdown(undefined).done).toBe(true);
  });

  it('leva cupom e UTMs; sem sessão vai ao cadastro e depois ao Plano', () => {
    const search = '?utm_source=google&utm_campaign=bf&email=x%40y.com&cupom=BF26';
    const guest = new URL(landingCtaUrl(search, false, 'BF26'), 'https://x');
    expect(guest.pathname).toBe('/criar-conta');
    expect(guest.searchParams.get('cupom')).toBe('BF26');
    expect(guest.searchParams.get('depois')).toBe('/app/plano?origem=black_friday');
    expect(guest.searchParams.get('utm_source')).toBe('google');
    expect(guest.searchParams.get('utm_campaign')).toBe('bf');
    expect(guest.searchParams.has('email')).toBe(false);
    const authed = new URL(landingCtaUrl(search, true, 'BF26'), 'https://x');
    expect(authed.pathname).toBe('/app/plano');
    expect(authed.searchParams.get('cupom')).toBe('BF26');
  });
});
