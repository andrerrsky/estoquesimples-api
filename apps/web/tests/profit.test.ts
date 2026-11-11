import { describe, expect, it } from 'vitest';

import { parseCsv, sheetToRows } from '../src/lib/csv';
import { costInput, marginHint, unitMargin } from '../src/lib/profit';

describe('margem a partir do preço de custo', () => {
  it('calcula margem sobre a venda e lucro por unidade', () => {
    expect(unitMargin(20, 12)).toEqual({ margin: 0.4, profit: 8 });
    expect(marginHint(20, 12)).toBe('Margem: 40% · lucro de R$ 8,00 por unidade');
    expect(marginHint(29.9, 15)).toBe('Margem: 49,8% · lucro de R$ 14,90 por unidade');
  });

  it('custo acima da venda vira prejuízo; sem custo ou sem venda não há margem', () => {
    expect(marginHint(10, 12)).toBe('Margem: -20% · prejuízo de R$ 2,00 por unidade');
    expect(unitMargin(20, null)).toBeNull();
    expect(unitMargin(0, 5)).toBeNull();
    expect(marginHint(20, undefined)).toBeNull();
  });

  it('custo zero aparece no campo; nulo fica vazio', () => {
    expect(costInput(0)).toBe('0');
    expect(costInput(7.5)).toBe('7,5');
    expect(costInput(null)).toBe('');
  });
});

describe('planilha com coluna de custo', () => {
  it('reconhece "custo", "Preço de custo" e "Custo unitário", com ou sem acento', () => {
    for (const header of ['custo', 'Preço de custo', 'PRECO DE CUSTO', 'Custo unitário', 'custo_unitario']) {
      const sheet = sheetToRows(parseCsv(`nome;valor;${header}\nCafé;20;12,5\n`));
      expect(sheet.columns, header).toEqual(['name', 'unitValue', 'unitCost']);
      expect(sheet.rows[0], header).toEqual({ name: 'Café', unitValue: 20, unitCost: 12.5 });
    }
  });

  it('lê a exportação do servidor (custo logo depois do valor) e deixa custo vazio de fora', () => {
    const csv = '﻿nome,descricao,quantidade,valor,custo,categoria\nCafé,,10,20,12,Bebidas\nLeite,,5,6,,\n';
    const sheet = sheetToRows(parseCsv(csv));
    expect(sheet.rows).toEqual([
      { name: 'Café', quantity: 10, unitValue: 20, unitCost: 12, category: 'Bebidas' },
      { name: 'Leite', quantity: 5, unitValue: 6 },
    ]);
  });
});
