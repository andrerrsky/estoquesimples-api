import { isIP } from 'node:net';

/**
 * Freio de tentativas de login e de pedidos por e-mail, em memória.
 *
 * O bloqueio progressivo é por (conta, IP): quem erra a senha seguidas vezes
 * de um endereço espera cada vez mais, mas outra pessoa não consegue
 * trancar a conta de alguém só digitando o e-mail dela. Contra força bruta
 * espalhada por muitos IPs há um teto por conta (`accountCeiling`) bem mais
 * alto, que tranca a conta por pouco tempo.
 *
 * Vive na memória do processo (o serviço roda numa instância só): um deploy
 * zera os contadores, o que só devolve algumas tentativas a quem já estava
 * bloqueado. Entradas antigas saem sozinhas (LRU com teto).
 */

interface Entry {
  failures: number;
  firstAt: number;
  lockedUntil: number;
}

const MAX_ENTRIES = 50_000;
/** Endereços onde a conta entrou com sucesso: mapa separado (falhas não o esvaziam) e com validade. */
const MAX_KNOWN = 20_000;
const KNOWN_TTL_MS = 30 * 86_400_000;

/**
 * Chave de cliente para limites: IPv4 inteiro; IPv6 pelo prefixo /64 (um
 * único acesso residencial ou servidor recebe um /64 inteiro, então trocar o
 * endereço dentro dele não pode render tentativas novas).
 */
export function clientKey(ip: string | null | undefined): string {
  if (!ip) return 'desconhecido';
  const plain = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (isIP(plain) === 4) return plain;
  if (isIP(plain) !== 6) return plain;
  // Expande "::" contando os grupos dos dois lados, para que todo endereço do
  // mesmo /64 dê a mesma chave.
  const [left = '', right] = plain.toLowerCase().split('::');
  const head = left ? left.split(':') : [];
  const tail = right === undefined ? [] : right ? right.split(':') : [];
  const groups = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  return `${groups.slice(0, 4).map((part) => part.padStart(4, '0')).join(':')}::/64`;
}

export interface ThrottleConfig {
  /** Erros seguidos por (conta, IP) antes do primeiro bloqueio. */
  maxAttempts: number;
  baseLockSeconds: number;
  maxLockSeconds: number;
  /** Erros por conta, somando todos os IPs, dentro de `accountWindowSeconds`. */
  accountCeiling: number;
  accountWindowSeconds: number;
  accountLockSeconds: number;
}

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly known = new Map<string, number>();

  constructor(private readonly config: ThrottleConfig) {}

  private get(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      // Reinsere para manter a ordem de uso (o mais antigo sai primeiro).
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  private set(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /**
   * Segundos de espera, ou 0 se pode tentar. O teto por conta não vale para
   * um endereço de onde a conta já entrou com sucesso: quem ataca de fora não
   * consegue, com ele, trancar o dono no próprio aparelho ou rede.
   */
  retryAfter(scope: string, account: string, ip: string, now = Date.now()): number {
    const pair = this.get(`${scope}:p:${account}:${ip}`);
    const seenAt = this.known.get(`${scope}:${account}:${ip}`);
    const known = seenAt !== undefined && now - seenAt < KNOWN_TTL_MS;
    const whole = known ? undefined : this.get(`${scope}:a:${account}`);
    const until = Math.max(pair?.lockedUntil ?? 0, whole?.lockedUntil ?? 0);
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  }

  /** Registra um erro; devolve os segundos de bloqueio que ele causou (0 se nenhum). */
  fail(scope: string, account: string, ip: string, now = Date.now()): number {
    const { maxAttempts, baseLockSeconds, maxLockSeconds, accountCeiling, accountWindowSeconds, accountLockSeconds } = this.config;
    const pairKey = `${scope}:p:${account}:${ip}`;
    const pair = this.get(pairKey) ?? { failures: 0, firstAt: now, lockedUntil: 0 };
    pair.failures += 1;
    let lockSeconds = 0;
    if (pair.failures >= maxAttempts) {
      lockSeconds = Math.min(baseLockSeconds * 2 ** (pair.failures - maxAttempts), maxLockSeconds);
      pair.lockedUntil = now + lockSeconds * 1000;
    }
    this.set(pairKey, pair);

    const accountKey = `${scope}:a:${account}`;
    let whole = this.get(accountKey);
    if (!whole || now - whole.firstAt > accountWindowSeconds * 1000) whole = { failures: 0, firstAt: now, lockedUntil: whole?.lockedUntil ?? 0 };
    whole.failures += 1;
    if (whole.failures >= accountCeiling) {
      whole.lockedUntil = now + accountLockSeconds * 1000;
      lockSeconds = Math.max(lockSeconds, accountLockSeconds);
    }
    this.set(accountKey, whole);
    return lockSeconds;
  }

  /** Login certo: zera o par (conta, IP) e lembra o endereço como conhecido. O teto da conta segue a própria janela. */
  succeed(scope: string, account: string, ip: string, now = Date.now()): void {
    this.entries.delete(`${scope}:p:${account}:${ip}`);
    const key = `${scope}:${account}:${ip}`;
    this.known.delete(key);
    this.known.set(key, now);
    if (this.known.size > MAX_KNOWN) {
      const oldest = this.known.keys().next().value;
      if (oldest !== undefined) this.known.delete(oldest);
    }
  }

  /**
   * Limite simples por chave (ex.: e-mail no "esqueci a senha"): `max`
   * pedidos por janela. Devolve os segundos de espera, ou 0 se pode seguir.
   */
  hit(scope: string, key: string, max: number, windowSeconds: number, now = Date.now()): number {
    const fullKey = `${scope}:h:${key}`;
    let entry = this.get(fullKey);
    if (!entry || now - entry.firstAt > windowSeconds * 1000) entry = { failures: 0, firstAt: now, lockedUntil: 0 };
    entry.failures += 1;
    this.set(fullKey, entry);
    if (entry.failures > max) return Math.ceil((entry.firstAt + windowSeconds * 1000 - now) / 1000);
    return 0;
  }
}
