import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Proteção dos purchase tokens do Google Play em repouso.
 *
 * - `hash`: SHA-256 hex para unicidade e busca (não reversível).
 * - `encrypt`/`decrypt`: AES-256-GCM; o blob guarda versão + IV + ciphertext + tag.
 *
 * Prefixo `v0:` é legado da migration 0008 (texto ainda em claro durante a
 * transição local). Em qualquer escrita nova grava-se só `v1:`.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const VERSION_V1 = 'v1';
const VERSION_V0_PLAIN = 'v0';

export class PurchaseTokenCipher {
  private readonly key: Buffer;

  constructor(keyMaterial: Buffer) {
    if (keyMaterial.length !== KEY_LENGTH) {
      throw new Error(
        `PURCHASE_TOKEN_ENCRYPTION_KEY deve ter ${KEY_LENGTH} bytes (recebeu ${keyMaterial.length}). ` +
          'Gere com: openssl rand -base64 32',
      );
    }
    this.key = keyMaterial;
  }

  /** Identificador estável para UNIQUE e lookups. */
  hash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  encrypt(token: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const packed = Buffer.concat([iv, ciphertext, tag]);
    return `${VERSION_V1}:${packed.toString('base64url')}`;
  }

  decrypt(blob: string): string {
    if (blob.startsWith(`${VERSION_V0_PLAIN}:`)) {
      return blob.slice(VERSION_V0_PLAIN.length + 1);
    }

    if (!blob.startsWith(`${VERSION_V1}:`)) {
      throw new Error('Blob de purchase token com versão desconhecida.');
    }

    const packed = Buffer.from(blob.slice(VERSION_V1.length + 1), 'base64url');
    if (packed.length < IV_LENGTH + TAG_LENGTH + 1) {
      throw new Error('Blob de purchase token inválido.');
    }

    const iv = packed.subarray(0, IV_LENGTH);
    const tag = packed.subarray(packed.length - TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH, packed.length - TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** True quando o valor ainda está no envelope legado da migration. */
  needsReencrypt(blob: string): boolean {
    return blob.startsWith(`${VERSION_V0_PLAIN}:`);
  }
}

/** Remove campos que espelhariam o token em JSON persistido. */
export function scrubPurchasePayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const clone = structuredClone(value) as Record<string, unknown>;
  delete clone.purchaseToken;
  delete clone.linkedPurchaseToken;

  const notification = clone.subscriptionNotification;
  if (notification && typeof notification === 'object' && !Array.isArray(notification)) {
    const nested = notification as Record<string, unknown>;
    delete nested.purchaseToken;
  }

  const oneTime = clone.oneTimeProductNotification;
  if (oneTime && typeof oneTime === 'object' && !Array.isArray(oneTime)) {
    const nested = oneTime as Record<string, unknown>;
    delete nested.purchaseToken;
  }

  return clone;
}

export function decodePurchaseTokenKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `PURCHASE_TOKEN_ENCRYPTION_KEY inválida: esperado ${KEY_LENGTH} bytes em base64, ` +
        `obtido ${key.length}. Gere com: openssl rand -base64 32`,
    );
  }
  return key;
}

/** Chave determinística só para development/test quando a env não foi definida. */
export function ephemeralDevPurchaseTokenKey(): Buffer {
  return createHash('sha256').update('estoquesimples-dev-purchase-token-key', 'utf8').digest();
}
