import { sql } from 'drizzle-orm';

import { platformAdmins } from '../../platform/db/schema/index.js';
import { checkPasswordPolicy, hashPassword } from '../../platform/auth/password.js';
import type { AppServices } from '../../platform/http/context.js';

/**
 * Garante o primeiro administrador do painel.
 *
 * Roda na subida, depois das migrations. Cria a conta indicada por
 * `ADMIN_BOOTSTRAP_EMAIL`/`ADMIN_BOOTSTRAP_PASSWORD` se ela ainda não existir
 * e nunca altera uma conta existente (a senha de um admin já criado só muda
 * pelo painel). Idempotente: as variáveis podem ficar configuradas sem
 * efeito colateral, mas o recomendado é removê-las após o primeiro acesso.
 */
export async function ensureBootstrapAdmin(
  services: AppServices,
  log: (message: string) => void = () => undefined,
): Promise<void> {
  const { env, db } = services;
  if (!env.ADMIN_PANEL_ENABLED) return;
  if (!env.ADMIN_BOOTSTRAP_EMAIL || !env.ADMIN_BOOTSTRAP_PASSWORD) return;

  const email = env.ADMIN_BOOTSTRAP_EMAIL.toLowerCase();
  const existing = await db
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(sql`lower(${platformAdmins.email}) = ${email}`)
    .limit(1);
  if (existing.length > 0) return;

  const policy = checkPasswordPolicy(env.ADMIN_BOOTSTRAP_PASSWORD, email);
  if (!policy.valid) {
    throw new Error(`ADMIN_BOOTSTRAP_PASSWORD inválida: ${policy.problems.join(' ')}`);
  }

  await db.insert(platformAdmins).values({
    email,
    name: env.ADMIN_BOOTSTRAP_NAME,
    passwordHash: await hashPassword(env.ADMIN_BOOTSTRAP_PASSWORD),
    role: 'owner',
  });

  log(`administrador inicial criado: ${email}`);
}
