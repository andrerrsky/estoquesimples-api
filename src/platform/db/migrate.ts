import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';

import { getEnv } from '../config/env.js';

/**
 * Migrator próprio, em SQL puro.
 *
 * Optamos por não usar o gerador do drizzle-kit porque boa parte do schema
 * depende de recursos que ele não expressa bem: políticas de RLS, índices
 * únicos parciais, funções e triggers. Escrever o SQL à mão mantém tudo
 * explícito e revisável, que é o que importa num banco multi-tenant.
 *
 * Convenção de arquivos em migrations/:
 *   NNNN_nome.up.sql   (obrigatório)
 *   NNNN_nome.down.sql (opcional; sem ele a migration é irreversível)
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const ADVISORY_LOCK_KEY = 8_273_641_002;

/**
 * Uma migration que precise de ACCESS EXCLUSIVE fica na fila atrás de qualquer
 * transação longa — e, enquanto espera, todo o resto fica na fila atrás dela.
 * Falhar em cinco segundos transforma essa parada geral num deploy que não
 * passou, que é um problema muito menor. O teto por instrução é generoso
 * porque criar índice em tabela grande demora mesmo.
 */
const LOCK_TIMEOUT = '5s';
const STATEMENT_TIMEOUT = '15min';

export interface MigrationFile {
  version: number;
  name: string;
  up: string;
  down: string | null;
  /** Cobre o par up+down: editar o down também precisa ser detectado. */
  checksum: string;
  /**
   * Checksum apenas do .up.sql, como era gravado antes.
   *
   * Bancos que já rodaram este migrator têm o valor antigo registrado. Sem
   * aceitá-lo, o primeiro deploy depois desta mudança acusaria todas as
   * migrations como alteradas e não subiria.
   */
  legacyChecksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const upFiles = entries.filter((file) => file.endsWith('.up.sql')).sort();

  const migrations: MigrationFile[] = [];
  for (const file of upFiles) {
    const match = /^(\d{4})_(.+)\.up\.sql$/.exec(file);
    if (!match) {
      throw new Error(`Nome de migration inválido: ${file}. Use NNNN_nome.up.sql`);
    }
    const version = Number(match[1]);
    const name = match[2] as string;
    const up = await readFile(join(dir, file), 'utf8');
    const downPath = join(dir, `${match[1]}_${name}.down.sql`);
    const down = await readFile(downPath, 'utf8').catch(() => null);

    if (migrations.some((m) => m.version === version)) {
      throw new Error(`Versão de migration duplicada: ${version}`);
    }
    migrations.push({
      version,
      name,
      up,
      down,
      checksum: createHash('sha256')
        .update(up)
        .update('\u0000--down--\u0000')
        .update(down ?? '')
        .digest('hex'),
      legacyChecksum: createHash('sha256').update(up).digest('hex'),
    });
  }
  return migrations.sort((a, b) => a.version - b.version);
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     integer      PRIMARY KEY,
      name        text         NOT NULL,
      checksum    text         NOT NULL,
      applied_at  timestamptz  NOT NULL DEFAULT now()
    )
  `);
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

async function getApplied(client: PoolClient): Promise<AppliedRow[]> {
  const result = await client.query<AppliedRow>(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  );
  return result.rows;
}

export interface MigrationRunResult {
  applied: number[];
  reverted: number[];
}

/**
 * Aplica todas as migrations pendentes. Cada uma roda na própria transação:
 * se a de número N falhar, as anteriores permanecem aplicadas e o banco fica
 * num estado consistente e conhecido.
 */
export async function migrateUp(
  pool: Pool,
  log: (message: string) => void = console.log,
): Promise<MigrationRunResult> {
  const migrations = await loadMigrations();
  const client = await pool.connect();
  const applied: number[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await ensureMigrationsTable(client);
    const already = await getApplied(client);
    const appliedByVersion = new Map(already.map((row) => [row.version, row]));

    // Uma migration já aplicada que teve o arquivo editado é um erro grave:
    // o banco e o código deixariam de corresponder silenciosamente.
    for (const migration of migrations) {
      const previous = appliedByVersion.get(migration.version);
      if (!previous) continue;

      if (previous.checksum === migration.checksum) continue;

      if (previous.checksum === migration.legacyChecksum) {
        // Registro gravado por uma versão anterior deste migrator, que só
        // considerava o .up.sql. Passa a valer o checksum do par completo.
        await client.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [
          migration.checksum,
          migration.version,
        ]);
        continue;
      }

      throw new Error(
        `Migration ${migration.version}_${migration.name} foi alterada depois de aplicada ` +
          '(arquivo .up.sql ou .down.sql). Crie uma nova migration em vez de editar uma existente.',
      );
    }

    // Uma migration com número menor que a última aplicada nunca roda: ela
    // seria pulada em silêncio e o banco ficaria diferente do que o histórico
    // afirma. Acontece quando dois ramos criam migrations em paralelo e o de
    // número menor entra depois — o autor precisa renumerar antes de aplicar.
    const maiorAplicada = already.reduce((maior, row) => Math.max(maior, row.version), 0);
    const menorPendente = migrations.find((m) => !appliedByVersion.has(m.version))?.version;
    if (menorPendente !== undefined && menorPendente < maiorAplicada) {
      throw new Error(
        `Migration ${menorPendente} está pendente mas a ${maiorAplicada} já foi aplicada. ` +
          'Renumere a migration nova para o topo da sequência.',
      );
    }

    for (const migration of migrations) {
      if (appliedByVersion.has(migration.version)) continue;

      log(`aplicando ${String(migration.version).padStart(4, '0')}_${migration.name}`);
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        await client.query(migration.up);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        applied.push(migration.version);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Falha na migration ${migration.version}_${migration.name}: ${(error as Error).message}`,
          { cause: error },
        );
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }

  return { applied, reverted: [] };
}

/** Reverte a última migration aplicada. Falha se ela não tiver arquivo .down.sql. */
export async function migrateDown(
  pool: Pool,
  log: (message: string) => void = console.log,
): Promise<MigrationRunResult> {
  const migrations = await loadMigrations();
  const client = await pool.connect();
  const reverted: number[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await ensureMigrationsTable(client);
    const already = await getApplied(client);
    const last = already.at(-1);
    if (!last) {
      log('nenhuma migration aplicada');
      return { applied: [], reverted: [] };
    }

    const migration = migrations.find((m) => m.version === last.version);
    if (!migration) {
      throw new Error(`Migration ${last.version} está registrada mas o arquivo não existe`);
    }
    if (!migration.down) {
      throw new Error(
        `Migration ${last.version}_${last.name} é irreversível (sem arquivo .down.sql). ` +
          'Reverta restaurando um backup.',
      );
    }

    log(`revertendo ${String(migration.version).padStart(4, '0')}_${migration.name}`);
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      await client.query(migration.down);
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [migration.version]);
      await client.query('COMMIT');
      reverted.push(migration.version);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }

  return { applied: [], reverted };
}

export async function migrationStatus(pool: Pool): Promise<
  Array<{ version: number; name: string; applied: boolean; reversible: boolean }>
> {
  const migrations = await loadMigrations();
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const already = await getApplied(client);
    const appliedVersions = new Set(already.map((row) => row.version));
    return migrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      applied: appliedVersions.has(migration.version),
      reversible: migration.down !== null,
    }));
  } finally {
    client.release();
  }
}

/**
 * Usado pelo readiness check: a API não deve receber tráfego com schema
 * defasado.
 *
 * A comparação é versão a versão, e não por contagem. Contar deixaria passar o
 * caso em que uma migration foi revertida e outra foi criada depois: os
 * números batem, o schema está errado e a instância entraria no balanceador
 * assim mesmo.
 */
export async function hasPendingMigrations(pool: Pool): Promise<boolean> {
  const migrations = await loadMigrations();
  const result = await pool
    .query<AppliedRow>('SELECT version, name, checksum FROM schema_migrations')
    .catch(() => null);
  if (!result) return true;

  const applied = new Map(result.rows.map((row) => [row.version, row]));

  const faltando = migrations.some((migration) => {
    const row = applied.get(migration.version);
    if (!row) return true;
    return row.checksum !== migration.checksum && row.checksum !== migration.legacyChecksum;
  });
  if (faltando) return true;

  // Banco à frente do código: registro de migration sem arquivo correspondente
  // significa que esta instância está com uma versão antiga do repositório.
  const conhecidas = new Set(migrations.map((migration) => migration.version));
  return result.rows.some((row) => !conhecidas.has(row.version));
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const env = getEnv();
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    max: 2,
  });

  try {
    if (command === 'up') {
      const result = await migrateUp(pool);
      console.log(
        result.applied.length ? `${result.applied.length} migration(s) aplicada(s)` : 'nada a aplicar',
      );
    } else if (command === 'down') {
      await migrateDown(pool);
    } else if (command === 'status') {
      const rows = await migrationStatus(pool);
      for (const row of rows) {
        const flag = row.applied ? 'aplicada' : 'pendente';
        const rev = row.reversible ? '' : ' (irreversível)';
        console.log(`${String(row.version).padStart(4, '0')}_${row.name}: ${flag}${rev}`);
      }
    } else {
      console.error(`Comando desconhecido: ${command}. Use up, down ou status.`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
