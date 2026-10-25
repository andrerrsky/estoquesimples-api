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

  /** Segundos de espera, ou 0 se pode tentar. */
  retryAfter(scope: string, account: string, ip: string, now = Date.now()): number {
    const pair = this.get(`${scope}:p:${account}:${ip}`);
    const whole = this.get(`${scope}:a:${account}`);
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

  /** Login certo: zera o par (conta, IP). O teto da conta segue a própria janela. */
  succeed(scope: string, account: string, ip: string): void {
    this.entries.delete(`${scope}:p:${account}:${ip}`);
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
