import { describe, expect, it } from 'vitest';

import { installBrowser } from './fake-browser';

describe('Continuar com o Google: regras do navegador', () => {
  it('reconhece navegadores embutidos de apps (o Google bloqueia login neles)', async () => {
    installBrowser('https://estoquesimples.com.br/comece');
    const { isInAppBrowser } = await import('../src/lib/google-signin');
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 14; SM-A145M Build/UP1A; wv) AppleWebKit/537.36 Instagram 312.0.0.0')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) [FBAN/FBIOS;FBAV/440.0]')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36')).toBe(false);
    expect(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe(false);
  });

  it('One Tap no máximo uma vez a cada 7 dias', async () => {
    installBrowser('https://estoquesimples.com.br/criar-conta');
    const { oneTapAllowed, markOneTapShown } = await import('../src/lib/google-signin');
    const now = Date.parse('2026-11-08T12:00:00Z');
    expect(oneTapAllowed(now)).toBe(true);
    markOneTapShown(now);
    expect(oneTapAllowed(now + 86_400_000)).toBe(false);
    expect(oneTapAllowed(now + 8 * 86_400_000)).toBe(true);
  });
});
