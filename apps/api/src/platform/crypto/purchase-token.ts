import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Cifra de segredos em repouso (purchase tokens do Google Play, chave da
 * OpenAI, chaves VAPID, segredo TOTP do painel, configurações do blog).
 *
 * - `hash`: SHA-256 hex para unicidade e busca (não reversível).
 * - `encrypt`/`decrypt`: AES-256-GCM com chaveiro. O blob é
 *   `v2:<kid>:<iv|ciphertext|tag>`; `kid` diz qual chave cifrou, então dá
 *   para trocar a chave ativa sem perder o que já estava gravado (ver
 *   scripts/reencrypt-secrets.ts e docs/seguranca.md). `aad` (dados
 *   associados) amarra o valor ao lugar onde ele mora: um blob copiado de
 *   outra linha ou configuração não decifra.
 * - `v1:` é o formato anterior (sem kid, sem AAD), decifrado com a chave
 *   `k1`; `v0:` é legado da migration 0008 (texto em claro).
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const VERSION_V2 = 'v2';
const VERSION_V1 = 'v1';
const VERSION_V0_PLAIN = 'v0';
/** Kid da chave do formato v1 (PURCHASE_TOKEN_ENCRYPTION_KEY). */
export const LEGACY_KID = 'k1';

export interface Keyring {
  keys: Map<string, Buffer>;
  activeKid: string;
}

/** AAD de uma linha de `admin_settings`. */
export function settingAad(key: string): string {
  return `admin_settings:${key}`;
}

export class PurchaseTokenCipher {
  private readonly keys: Map<string, Buffer>;
  private readonly activeKid: string;

  constructor(material: Buffer | Keyring) {
    const ring: Keyring = Buffer.isBuffer(material) ? { keys: new Map([[LEGACY_KID, material]]), activeKid: LEGACY_KID } : material;
    for (const [kid, key] of ring.keys) {
      if (key.length !== KEY_LENGTH) {
        throw new Error(`Chave de cifra "${kid}" deve ter ${KEY_LENGTH} bytes (recebeu ${key.length}). Gere com: openssl rand -base64 32`);
      }
      if (!/^[a-z0-9]{1,16}$/i.test(kid)) throw new Error(`Identificador de chave inválido: "${kid}".`);
    }
    if (!ring.keys.has(ring.activeKid)) throw new Error(`A chave ativa "${ring.activeKid}" não está no chaveiro.`);
    this.keys = ring.keys;
    this.activeKid = ring.activeKid;
  }

  /** Identificador estável para UNIQUE e lookups. */
  hash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  encrypt(plaintext: string, aad?: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.keys.get(this.activeKid)!, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const packed = Buffer.concat([iv, ciphertext, tag]);
    return `${VERSION_V2}:${this.activeKid}:${packed.toString('base64url')}`;
  }

  decrypt(blob: string, aad?: string): string {
    if (blob.startsWith(`${VERSION_V0_PLAIN}:`)) {
      return blob.slice(VERSION_V0_PLAIN.length + 1);
    }
    let kid: string;
    let payload: string;
    let useAad = false;
    if (blob.startsWith(`${VERSION_V2}:`)) {
      const rest = blob.slice(VERSION_V2.length + 1);
      const sep = rest.indexOf(':');
      if (sep <= 0) throw new Error('Blob cifrado inválido.');
      kid = rest.slice(0, sep);
      payload = rest.slice(sep + 1);
      useAad = true;
    } else if (blob.startsWith(`${VERSION_V1}:`)) {
      kid = LEGACY_KID;
      payload = blob.slice(VERSION_V1.length + 1);
    } else {
      throw new Error('Blob cifrado com versão desconhecida.');
    }
    const key = this.keys.get(kid);
    if (!key) throw new Error(`Chave "${kid}" ausente do chaveiro: não dá para decifrar.`);

    const packed = Buffer.from(payload, 'base64url');
    if (packed.length < IV_LENGTH + TAG_LENGTH + 1) {
      throw new Error('Blob cifrado inválido.');
    }
    const iv = packed.subarray(0, IV_LENGTH);
    const tag = packed.subarray(packed.length - TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH, packed.length - TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    if (useAad && aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** True quando o valor não está no formato atual com a chave ativa (texto legado, v1 ou outra chave). */
  needsReencrypt(blob: string): boolean {
    return !blob.startsWith(`${VERSION_V2}:${this.activeKid}:`);
  }
}

/**
 * Chaveiro a partir do ambiente: SECRETS_ENCRYPTION_KEYS ("k1:base64,k2:base64")
 * com SECRETS_ACTIVE_KID; sem ele, só PURCHASE_TOKEN_ENCRYPTION_KEY como `k1`.
 * A chave do formato v1 é sempre a `k1`.
 */
export function keyringFromEnv(env: { SECRETS_ENCRYPTION_KEYS?: string | undefined; SECRETS_ACTIVE_KID?: string | undefined; PURCHASE_TOKEN_ENCRYPTION_KEY?: string | undefined }, fallback: Buffer): Keyring {
  const keys = new Map<string, Buffer>();
  if (env.PURCHASE_TOKEN_ENCRYPTION_KEY) keys.set(LEGACY_KID, decodePurchaseTokenKey(env.PURCHASE_TOKEN_ENCRYPTION_KEY));
  for (const entry of (env.SECRETS_ENCRYPTION_KEYS ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const sep = entry.indexOf(':');
    if (sep <= 0) throw new Error('SECRETS_ENCRYPTION_KEYS: use o formato kid:base64,kid:base64');
    keys.set(entry.slice(0, sep), decodePurchaseTokenKey(entry.slice(sep + 1)));
  }
  if (keys.size === 0) keys.set(LEGACY_KID, fallback);
  const activeKid = env.SECRETS_ACTIVE_KID ?? (env.SECRETS_ENCRYPTION_KEYS ? [...keys.keys()].at(-1)! : LEGACY_KID);
  return { keys, activeKid };
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
