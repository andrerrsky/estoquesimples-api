import { sql } from 'drizzle-orm';

import { getEnv } from '../src/platform/config/env.js';
import { createDb } from '../src/platform/db/client.js';
import { platformAdmins } from '../src/platform/db/schema/index.js';
import { checkPasswordPolicy, hashPassword } from '../src/platform/auth/password.js';

/**
 * Cria (ou redefine a senha de) um administrador do painel.
 *
 *   npm run admin:create -- --email voce@exemplo.com --name "Seu Nome" --role owner
 *   ADMIN_PASSWORD=... npm run admin:create -- --email ...
 *
 * A senha vem da variável ADMIN_PASSWORD para não ficar no histórico do
 * shell. Em produção, rode via `railway run` apontando para o serviço da API.
 */
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg('email')?.toLowerCase();
  const name = arg('name') ?? 'Administrador';
  const role = arg('role') ?? 'owner';
  const password = process.env['ADMIN_PASSWORD'];

  if (!email || !password) {
    console.error('Uso: ADMIN_PASSWORD=... npm run admin:create -- --email <e-mail> [--name <nome>] [--role owner|support|viewer]');
    process.exit(1);
  }
  if (!['owner', 'support', 'viewer'].includes(role)) {
    console.error('Papel inválido. Use owner, support ou viewer.');
    process.exit(1);
  }

  const policy = checkPasswordPolicy(password, email);
  if (!policy.valid) {
    console.error(`Senha rejeitada: ${policy.problems.join(' ')}`);
    process.exit(1);
  }

  const handle = createDb(getEnv());
  try {
    const passwordHash = await hashPassword(password);
    const existing = await handle.db
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .where(sql`lower(${platformAdmins.email}) = ${email}`)
      .limit(1);

    if (existing[0]) {
      await handle.db
        .update(platformAdmins)
        .set({ passwordHash, failedLoginAttempts: 0, lockedUntil: null, status: 'active' })
        .where(sql`${platformAdmins.id} = ${existing[0].id}`);
      console.log(`senha redefinida para ${email}`);
    } else {
      await handle.db.insert(platformAdmins).values({ email, name, passwordHash, role });
      console.log(`administrador criado: ${email} (${role})`);
    }
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
