import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Tokens opacos (refresh, convite, reset de senha, verificação de e-mail).
 *
 * Guardamos apenas o SHA-256 do token. O valor em claro existe uma única vez,
 * na resposta HTTP ou no e-mail. SHA-256 sem sal é adequado aqui — ao
 * contrário de senhas, estes são valores aleatórios de 256 bits, então não há
 * espaço de busca a proteger e queremos uma busca indexada barata.
 */

const TOKEN_BYTES = 32;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Token de convite com prefixo legível.
 *
 * O prefixo ajuda o suporte a reconhecer o valor num print de tela e permite
 * detectar em varreduras de segredo que um convite vazou em algum lugar.
 */
export function generateInviteToken(): string {
  return `esinv_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function addDays(date: Date, days: number): Date {
  return addSeconds(date, days * 86_400);
}

export function addMinutes(date: Date, minutes: number): Date {
  return addSeconds(date, minutes * 60);
}

export function addHours(date: Date, hours: number): Date {
  return addSeconds(date, hours * 3600);
}
