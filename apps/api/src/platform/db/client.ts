import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import type { Env } from '../config/env.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DbHandle {
  pool: Pool;
  db: Database;
  close: () => Promise<void>;
}

export function createDb(env: Env): DbHandle {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    // O Railway encerra conexões ociosas; expirá-las antes evita ECONNRESET.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // Sem este handler, um erro num cliente ocioso derruba o processo.
  pool.on('error', (error) => {
    console.error('[db] erro em conexão ociosa:', error.message);
  });

  const db = drizzle(pool, { schema });

  return {
    pool,
    db,
    close: async () => {
      await pool.end();
    },
  };
}

/**
 * Código de erro do Postgres (ex.: `23505` de violação de unicidade), não
 * importa se a exceção capturada é o erro cru do driver `pg` ou um
 * `DrizzleQueryError` — o drizzle-orm passou a embrulhar todo erro de query
 * numa classe própria, guardando o original em `.cause` em vez de copiar
 * `.code` para o embrulho. Checar os dois lugares evita que essa mudança de
 * versão faça um erro de negócio esperado (nome duplicado) virar 500.
 */
export function pgErrorCode(error: unknown): string | undefined {
  const direto = extrairCodigo(error);
  if (direto) return direto;
  const causa = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
  return extrairCodigo(causa);
}

function extrairCodigo(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

export interface TenantContext {
  workspaceId: string;
  userId: string;
}

/**
 * Executa o callback dentro de uma transação com o contexto de tenant aplicado.
 *
 * As duas instruções abaixo são a espinha dorsal do isolamento entre empresas:
 * definimos o workspace corrente e trocamos para o role `app_user`, que está
 * sujeito às políticas de RLS. Mesmo que um repositório esqueça o filtro por
 * `workspace_id`, o banco não devolve linhas de outro tenant.
 *
 * Ambos são `LOCAL`, então voltam ao normal quando a transação termina.
 */
export async function withTenant<T>(
  db: Database,
  context: TenantContext,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.workspace_id', ${context.workspaceId}, true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', ${context.userId}, true)`);
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    return fn(tx);
  });
}

/**
 * Transação de sistema: roda como dono das tabelas, sem RLS.
 *
 * Reservada para o que legitimamente cruza tenants — migrations, reconciliação
 * de assinaturas, limpeza de tombstones, processamento da fila de jobs.
 * Nunca deve ser usada para servir uma requisição de usuário.
 */
export async function withSystem<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => fn(tx));
}
