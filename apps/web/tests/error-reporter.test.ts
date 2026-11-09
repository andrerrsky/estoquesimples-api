import { describe, expect, it } from 'vitest';

import { installBrowser } from './fake-browser';

describe('relatório de erros da web', () => {
  it('não registra o "Script error." opaco de scripts de outro domínio (navegador do Facebook, extensões)', async () => {
    installBrowser('https://estoquesimples.com.br/criar-conta');
    const { isOpaqueCrossOriginError } = await import('../src/lib/error-reporter');
    expect(isOpaqueCrossOriginError('Script error.')).toBe(true);
    expect(isOpaqueCrossOriginError('Script error.', '')).toBe(true);
    expect(isOpaqueCrossOriginError('Script error.', 'https://connect.facebook.net/sdk.js')).toBe(true);
    // Do nosso próprio domínio continua sendo registrado.
    expect(isOpaqueCrossOriginError('Script error.', 'https://estoquesimples.com.br/assets/index.js')).toBe(false);
    expect(isOpaqueCrossOriginError("TypeError: Cannot read properties of undefined (reading 'id')")).toBe(false);
  });
});
