import { describe, expect, it } from 'vitest';

import { chargeLine, cycleOptions, defaultCycle, lowestPerMonth, maxSavingPct } from '../src/lib/pricing';

const pricing = { monthlyCents: 2499, semiannualCents: 12990, yearlyCents: 19990 };

describe('preços do plano Equipe na web', () => {
  it('mostra o valor por mês para baixo, a economia e os selos', () => {
    const options = cycleOptions(pricing);
    expect(options.map((o) => [o.cycle, o.perMonthCents, o.savingPct, o.badge])).toEqual([
      ['MONTHLY', 2499, 0, null],
      ['SEMIANNUALLY', 2165, 13, 'Mais escolhido'],
      ['YEARLY', 1665, 33, 'Melhor preço'],
    ]);
    expect(defaultCycle(options)).toBe('SEMIANNUALLY');
    expect(lowestPerMonth(pricing)).toBe(1665);
    expect(maxSavingPct(pricing)).toBe(33);
    expect(chargeLine(options[1]!)).toBe('R$ 129,90 a cada 6 meses · economize 13%');
  });

  it('sem semestral marca o anual; só o mensal fica no mensal', () => {
    expect(defaultCycle(cycleOptions({ monthlyCents: 2499, semiannualCents: null, yearlyCents: 19990 }))).toBe('YEARLY');
    expect(defaultCycle(cycleOptions({ monthlyCents: 2499, semiannualCents: null, yearlyCents: null }))).toBe('MONTHLY');
    expect(cycleOptions(null)).toEqual([]);
  });
});
