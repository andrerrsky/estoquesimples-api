import { describe, expect, it } from 'vitest';

import { buildFinanceReport, googleRecurringCents, type FinanceSubscription } from '../../src/modules/admin/admin-finance.js';

const google = (overrides: Partial<FinanceSubscription>): FinanceSubscription => ({
  id: 'g',
  provider: 'google_play',
  state: 'ativa',
  billingCycle: null,
  billingType: null,
  priceCents: null,
  startedAt: new Date('2026-11-08T21:14:11Z'),
  currentPeriodEnd: new Date('2026-12-08T21:11:51Z'),
  canceledAt: null,
  updatedAt: new Date('2026-11-09T00:00:00Z'),
  googleOfferId: 'oferta',
  googleRecurringCents: 2499,
  googleInOfferPhase: true,
  offerPriceCents: 1999,
  offerCycles: 2,
  ...overrides,
});

describe('relatório financeiro', () => {
  it('lê o preço recorrente e a fase de oferta do comprovante do Google', () => {
    expect(
      googleRecurringCents({
        lineItems: [{ offerPhase: { introductoryPrice: {} }, autoRenewingPlan: { recurringPrice: { units: '24', nanos: 990000000, currencyCode: 'BRL' } } }],
      }),
    ).toEqual({ cents: 2499, inOffer: true });
    expect(googleRecurringCents({})).toEqual({ cents: null, inOffer: false });
  });

  it('desconta 15% do Google, usa o preço da oferta nos primeiros meses e soma a web pelo líquido do Asaas', () => {
    const report = buildFinanceReport({
      now: new Date('2026-11-10T15:00:00Z'),
      months: 3,
      offer: { priceCents: 1999, cycles: 2 },
      subscriptions: [
        google({ id: 'g1' }),
        google({ id: 'g2', startedAt: new Date('2026-11-09T17:20:18Z') }),
        {
          ...google({ id: 'w1' }),
          provider: 'asaas',
          billingCycle: 'SEMIANNUALLY',
          billingType: 'PIX',
          priceCents: 12990,
          googleOfferId: null,
          googleRecurringCents: null,
          googleInOfferPhase: false,
          startedAt: new Date('2026-11-10T12:00:00Z'),
          currentPeriodEnd: new Date('2027-05-10T12:00:00Z'),
        },
        google({ id: 'old', state: 'expirada', startedAt: new Date('2026-09-01T12:00:00Z'), currentPeriodEnd: new Date('2026-10-01T12:00:00Z'), googleOfferId: null }),
      ],
      payments: [
        { subscriptionId: 'w1', status: 'RECEIVED', billingType: 'PIX', valueCents: 12990, netValueCents: 12791, paidAt: new Date('2026-11-10T12:05:00Z'), dueDate: '2026-11-10' },
        { subscriptionId: 'w1', status: 'PENDING', billingType: 'PIX', valueCents: 12990, netValueCents: null, paidAt: null, dueDate: '2027-05-10' },
      ],
    });

    expect(report.months.map((month) => month.month)).toEqual(['2026-09', '2026-10', '2026-11']);
    const nov = report.months[2]!;
    // 2 × 19,99 no app (líquido 16,99) + 129,90 na web (líquido 127,91).
    expect(nov.grossCents).toBe(1999 * 2 + 12990);
    expect(nov.appNetCents).toBe(1699 * 2);
    expect(nov.webNetCents).toBe(12791);
    expect(nov.newSubscriptions).toBe(3);
    expect(report.months[1]!.churned).toBe(1);
    expect(report.months[0]!.grossCents).toBe(2499);

    expect(report.now.paying).toBe(3);
    expect(report.now.inOffer).toBe(2);
    expect(report.now.mrrNetAppCents).toBe(1699 * 2);
    expect(report.now.mrrNetWebCents).toBe(Math.round((12990 - 199) / 6));
    expect(report.now.arrNetCents).toBe(report.now.mrrNetCents * 12);
    expect(nov.activeAtEnd).toBe(3);
  });

  it('depois da oferta o app passa a valer o preço cheio', () => {
    const report = buildFinanceReport({
      now: new Date('2027-02-10T15:00:00Z'),
      months: 4,
      offer: { priceCents: 1999, cycles: 2 },
      subscriptions: [google({ id: 'g1', currentPeriodEnd: new Date('2027-03-08T21:11:51Z'), googleInOfferPhase: false })],
      payments: [],
    });
    expect(report.months.map((month) => month.grossCents)).toEqual([1999, 1999, 2499, 2499]);
    expect(report.now.mrrGrossCents).toBe(2499);
    expect(report.now.mrrNetCents).toBe(Math.round(2499 * 0.85));
  });
});
