import { sql } from 'drizzle-orm';

import type { Transaction } from '../../platform/db/client.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';

/**
 * Aloca a próxima posição na sequência de alterações da empresa.
 *
 * Um `UPDATE ... RETURNING` na linha da empresa, e não uma sequência do
 * Postgres. A diferença importa: sequências entregam números fora de ordem
 * quando transações concorrentes terminam em ordem diferente da que começaram,
 * e o aparelho que lê por cursor pularia em silêncio os registros que ficaram
 * para trás. O bloqueio na linha da empresa serializa as escritas, que é
 * exatamente o que uma leitura por cursor precisa para não ter buracos.
 */
export async function nextChangeSeq(tx: Transaction, workspaceId: string): Promise<number> {
  const result = await tx.execute<{ next_change_seq: string }>(
    sql`SELECT next_change_seq(${workspaceId}::uuid) AS next_change_seq`,
  );
  const raw = result.rows[0]?.next_change_seq;
  if (raw === undefined) {
    throw new AppError(500, ErrorCode.INTERNAL, 'Não foi possível ordenar a alteração.');
  }
  return Number(raw);
}
