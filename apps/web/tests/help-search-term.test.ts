import { describe, expect, it } from 'vitest';

import { termoDeBusca } from '../src/lib/help-search-term';

describe('termoDeBusca', () => {
  it('normaliza espaços e caixa', () => {
    expect(termoDeBusca('  Como fazer   BACKUP ')).toBe('como fazer backup');
  });

  it('guarda a dúvida real de quem procura', () => {
    expect(termoDeBusca('como convidar funcionário')).toBe('como convidar funcionário');
  });

  it('descarta e-mail', () => {
    expect(termoDeBusca('maria@exemplo.com.br')).toBeNull();
  });

  it('descarta telefone e documento', () => {
    expect(termoDeBusca('11 98765-4321')).toBeNull();
    expect(termoDeBusca('123.456.789-00')).toBeNull();
  });

  it('descarta endereço web', () => {
    expect(termoDeBusca('https://exemplo.com')).toBeNull();
  });

  it('deixa passar número curto, que é parte da dúvida', () => {
    expect(termoDeBusca('limite de 50 produtos')).toBe('limite de 50 produtos');
  });

  it('descarta texto colado, longo demais para ser busca', () => {
    expect(termoDeBusca('a'.repeat(61))).toBeNull();
  });

  it('descarta vazio e letra solta', () => {
    expect(termoDeBusca('   ')).toBeNull();
    expect(termoDeBusca('a')).toBeNull();
  });
});
