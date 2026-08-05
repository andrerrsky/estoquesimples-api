import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import type { TestProject } from 'vitest/node';

import { migrateUp } from '../../src/platform/db/migrate.js';

/**
 * Sobe um Postgres real para a suíte inteira e aplica as migrations.
 *
 * Não usamos banco em memória nem mock: metade do que precisamos garantir
 * (RLS, índices únicos parciais, FOR UPDATE SKIP LOCKED, sequências por
 * workspace) só existe no Postgres de verdade. Testar contra outra coisa daria
 * falsa segurança justamente nos pontos mais críticos.
 *
 * A resolução do banco segue esta ordem:
 *  1. TEST_DATABASE_URL, quando o ambiente já fornece um (caso do CI);
 *  2. o Postgres do docker-compose deste repositório, num banco separado
 *     `estoquesimples_test` criado na hora;
 *  3. um container efêmero via testcontainers.
 *
 * O passo 2 existe porque o desenvolvedor já roda `docker compose up -d` para
 * trabalhar, e reaproveitar essa instância torna a suíte bem mais rápida do
 * que subir um container a cada execução.
 */

const COMPOSE_ADMIN_URL =
  process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://estoque:estoque@localhost:5433/postgres';
const TEST_DATABASE_NAME = 'estoquesimples_test';

async function tryComposePostgres(): Promise<string | null> {
  const admin = new Pool({ connectionString: COMPOSE_ADMIN_URL, max: 1, connectionTimeoutMillis: 3000 });
  try {
    // Recriar o banco a cada execução garante que a suíte começa sempre do
    // mesmo estado, independente do que a execução anterior deixou para trás.
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE_NAME}`);
    const url = new URL(COMPOSE_ADMIN_URL);
    url.pathname = `/${TEST_DATABASE_NAME}`;
    return url.toString();
  } catch {
    return null;
  } finally {
    await admin.end().catch(() => undefined);
  }
}

export default async function setup(project: TestProject) {
  let container: StartedPostgreSqlContainer | null = null;
  let databaseUrl = process.env['TEST_DATABASE_URL'] ?? null;

  databaseUrl ??= await tryComposePostgres();

  if (!databaseUrl) {
    try {
      container = await new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase(TEST_DATABASE_NAME)
        .withUsername('estoque')
        .withPassword('estoque')
        .start();
      databaseUrl = container.getConnectionUri();
    } catch (error) {
      throw new Error(
        'Não foi possível obter um Postgres para os testes.\n' +
          'Suba o banco local com "docker compose up -d" ou defina TEST_DATABASE_URL.\n' +
          `Detalhe: ${(error as Error).message}`,
      );
    }
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await migrateUp(pool, () => undefined);
  } finally {
    await pool.end();
  }

  project.provide('databaseUrl', databaseUrl);

  return async () => {
    await container?.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
