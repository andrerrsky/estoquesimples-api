import { describe, expect, it } from 'vitest';

import { changelog, formatReleaseDate, latestRelease, releases } from '@estoquesimples/changelog';

describe('novidades do app', () => {
  it('vem da mais nova para a mais antiga, sem versão repetida', () => {
    const numeros = releases.map((release) => release.version);
    expect(numeros).toEqual([...numeros].sort((a, b) => b - a));
    expect(new Set(numeros).size).toBe(numeros.length);
    expect(latestRelease()?.version).toBe(numeros[0]);
  });

  it('nenhuma versão entra vazia: a tela nunca mostra um título sozinho', () => {
    for (const release of changelog.releases) {
      expect(release.title.trim().length).toBeGreaterThan(0);
      expect(release.highlights.length + release.fixes.length).toBeGreaterThan(0);
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('a data sai no formato que o Brasil lê', () => {
    expect(formatReleaseDate('2026-11-25')).toBe('25/11/2026');
    // Dia de calendário não vira Date: em fuso negativo, 25 viraria 24.
    expect(formatReleaseDate('2026-01-01')).toBe('01/01/2026');
    expect(formatReleaseDate('qualquer coisa')).toBe('qualquer coisa');
  });
});
