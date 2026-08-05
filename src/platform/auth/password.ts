import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Parâmetros do perfil recomendado pelo OWASP para argon2id:
 * 19 MiB de memória, 2 iterações, paralelismo 1.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hash descartável usado quando o e-mail informado não existe.
 *
 * Sem isso, um login com e-mail inexistente responderia muito mais rápido que
 * um com senha errada, permitindo enumerar contas pelo tempo de resposta.
 * Gerado uma única vez, sob demanda, e reaproveitado.
 */
let dummyHashPromise: Promise<string> | null = null;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain, ARGON2_OPTIONS);
  } catch {
    // Hash corrompido ou em formato desconhecido: trata como senha inválida.
    return false;
  }
}

/** Queima o mesmo tempo de CPU de uma verificação real. */
export async function verifyPasswordDummy(plain: string): Promise<false> {
  dummyHashPromise ??= hashPassword('senha-inexistente-para-tempo-constante');
  const dummy = await dummyHashPromise;
  await verifyPassword(dummy, plain);
  return false;
}

export interface PasswordPolicyResult {
  valid: boolean;
  problems: string[];
}

/**
 * Política de senha deliberadamente simples: comprimento mínimo generoso e
 * bloqueio das senhas mais óbvias. Regras de composição (símbolo obrigatório,
 * maiúscula obrigatória) atrapalham mais do que ajudam, segundo o NIST.
 */
const COMMON_PASSWORDS = new Set([
  '12345678',
  '123456789',
  '1234567890',
  'senha123',
  'password',
  'password1',
  'qwertyui',
  'estoque123',
  'admin123',
  'abcd1234',
]);

export function checkPasswordPolicy(password: string, email?: string): PasswordPolicyResult {
  const problems: string[] = [];

  if (password.length < 10) {
    problems.push('A senha deve ter pelo menos 10 caracteres.');
  }
  if (password.length > 200) {
    problems.push('A senha deve ter no máximo 200 caracteres.');
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    problems.push('Esta senha é muito comum. Escolha outra.');
  }
  if (email) {
    const localPart = email.split('@')[0]?.toLowerCase();
    if (localPart && localPart.length >= 4 && password.toLowerCase().includes(localPart)) {
      problems.push('A senha não pode conter o seu e-mail.');
    }
  }
  if (/^(.)\1+$/.test(password)) {
    problems.push('A senha não pode ser um único caractere repetido.');
  }

  return { valid: problems.length === 0, problems };
}
