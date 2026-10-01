import { describe, expect, it } from 'vitest';

import {
  PurchaseTokenCipher,
  ephemeralDevPurchaseTokenKey,
  scrubPurchasePayload,
} from '../../src/platform/crypto/purchase-token.js';

describe('PurchaseTokenCipher', () => {
  const cipher = new PurchaseTokenCipher(ephemeralDevPurchaseTokenKey());

  it('cifra e recupera o token', () => {
    const token = 'purchase-token-secreto-do-google';
    const enc = cipher.encrypt(token);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain(token);
    expect(cipher.decrypt(enc)).toBe(token);
  });

  it('hash é estável e distinto do ciphertext', () => {
    const token = 'mesmo-token';
    expect(cipher.hash(token)).toBe(cipher.hash(token));
    expect(cipher.hash(token)).not.toBe(cipher.encrypt(token));
  });

  it('aceita envelope legado v0 da migration', () => {
    expect(cipher.decrypt('v0:token-legado')).toBe('token-legado');
    expect(cipher.needsReencrypt('v0:token-legado')).toBe(true);
    expect(cipher.needsReencrypt(cipher.encrypt('x'))).toBe(false);
  });

  it('remove tokens de payloads persistidos', () => {
    const scrubbed = scrubPurchasePayload({
      packageName: 'br.com.exemplo',
      purchaseToken: 'segredo',
      linkedPurchaseToken: 'outro',
      subscriptionNotification: { purchaseToken: 'segredo', notificationType: 2 },
      oneTimeProductNotification: { purchaseToken: 'segredo' },
    });

    expect(scrubbed).toEqual({
      packageName: 'br.com.exemplo',
      subscriptionNotification: { notificationType: 2 },
      oneTimeProductNotification: {},
    });
  });
});
