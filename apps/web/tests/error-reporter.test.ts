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

  it('não registra erro cuja pilha é só de script de outro domínio (Google Identity bloqueado)', async () => {
    installBrowser('https://estoquesimples.com.br/comece');
    const { isThirdPartyStack } = await import('../src/lib/error-reporter');
    const gapi = [
      'CustomError: Jsloader error (code #0): Error while loading script https://apis.google.com/js/client.js',
      '    at Oa (https://accounts.google.com/gsi/client:214:117)',
      '    at https://apis.google.com/js/client.js:1:200',
    ].join('\n');
    expect(isThirdPartyStack(gapi)).toBe(true);
    // Com um quadro nosso na pilha, o erro é nosso e tem de aparecer.
    expect(isThirdPartyStack('TypeError: x\n    at e (https://estoquesimples.com.br/assets/SupportChat.js:5:1)')).toBe(false);
    // Sem pilha (ou pilha sem endereço) nada se descarta.
    expect(isThirdPartyStack(null)).toBe(false);
    expect(isThirdPartyStack('Error: sem endereço nenhum')).toBe(false);
  });
});
