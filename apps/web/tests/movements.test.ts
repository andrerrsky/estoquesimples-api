import { describe, expect, it } from 'vitest';

import { saldoAposEstorno } from '../src/lib/movements';

describe('saldoAposEstorno', () => {
  it('estornar uma entrada tira a quantidade do estoque', () => {
    expect(saldoAposEstorno(100, 10)).toBe(90);
  });

  it('estornar uma saída devolve a quantidade ao estoque', () => {
    expect(saldoAposEstorno(90, -10)).toBe(100);
  });

  it('não desce abaixo de zero', () => {
    // O caso da cliente que estornou as entradas uma a uma: o saldo para em 0.
    expect(saldoAposEstorno(5, 10)).toBe(0);
  });

  it('aceita fração (produtos vendidos por peso)', () => {
    expect(saldoAposEstorno(2.5, 0.5)).toBe(2);
  });

  it('estorno de movimentação sem efeito no saldo não muda nada', () => {
    expect(saldoAposEstorno(42, 0)).toBe(42);
  });
});
