import { describe, expect, it } from 'vitest';

import { byteRange } from '../../src/platform/http/web-app.js';

// O <video> do Safari só toca se o servidor responder às faixas que ele pede.
describe('byteRange: cabeçalho Range dos arquivos estáticos', () => {
  it('sem cabeçalho ou com formato que não entendemos, entrega o arquivo inteiro', () => {
    expect(byteRange(undefined, 1000)).toBeNull();
    expect(byteRange('', 1000)).toBeNull();
    expect(byteRange('bytes=-', 1000)).toBeNull();
    expect(byteRange('bytes=0-1,5-9', 1000)).toBeNull();
    expect(byteRange('items=0-10', 1000)).toBeNull();
  });

  it('faixa com início e fim, só com início e pelo final do arquivo', () => {
    expect(byteRange('bytes=0-1', 1000)).toEqual({ start: 0, end: 1 });
    expect(byteRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(byteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(byteRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(byteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('faixa fora do arquivo não é atendida (416)', () => {
    expect(byteRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(byteRange('bytes=10-5', 1000)).toBe('unsatisfiable');
    expect(byteRange('bytes=-0', 1000)).toBe('unsatisfiable');
  });
});
