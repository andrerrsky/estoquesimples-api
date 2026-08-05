import { sql } from 'drizzle-orm';

import { enqueueJob, registerJobHandler } from '../../platform/jobs/runner.js';
import type { AppServices } from '../../platform/http/context.js';

export const SYNC_RETENTION_JOB = 'sync.retention';

/**
 * Limpeza do que a sincronização acumula.
 *
 * Duas coisas crescem sem parar: o registro das operações já processadas e as
 * lápides dos produtos excluídos. Nenhuma das duas pode ser apagada por
 * idade apenas — cada uma protege contra um problema específico, e removê-la
 * cedo demais recria exatamente o problema.
 */
export function registerSyncJobs(services: AppServices): void {
  registerJobHandler(SYNC_RETENTION_JOB, async (_payload, context) => {
    const diasOperacoes = context.services.env.SYNC_OPERATION_RETENTION_DAYS;
    const diasLapides = context.services.env.TOMBSTONE_RETENTION_DAYS;

    // O registro de operações existe para reconhecer um reenvio. Um aparelho
    // não fica meses tentando enviar a mesma coisa: passado o prazo, a chance
    // de o reenvio ainda chegar é menor que o custo de guardar tudo.
    const operacoes = await context.services.db.execute<{ removidas: string }>(sql`
      WITH removidas AS (
        DELETE FROM sync_operations
         WHERE created_at < now() - ${`${diasOperacoes} days`}::interval
        RETURNING 1
      )
      SELECT count(*)::text AS removidas FROM removidas
    `);

    // A lápide só pode sair depois que todos os aparelhos da empresa já
    // leram além dela. Apagar antes faria o aparelho atrasado nunca saber da
    // exclusão e ficar com um produto fantasma para sempre.
    // Prazo próprio (TOMBSTONE_RETENTION_DAYS): misturar com o das operações
    // forçava resyncs ~6× mais cedo do que o configurado.
    const lapides = await context.services.db.execute<{ empresas: string }>(sql`
      WITH limite AS (
        SELECT w.id AS workspace_id,
               COALESCE(MIN(c.cursor), 0) AS menor_cursor
          FROM workspaces w
          LEFT JOIN sync_cursors c ON c.workspace_id = w.id
         GROUP BY w.id
      ),
      apagadas AS (
        DELETE FROM products p
         USING limite l
         WHERE p.workspace_id = l.workspace_id
           AND p.deleted_at IS NOT NULL
           AND p.deleted_at < now() - ${`${diasLapides} days`}::interval
           AND p.change_seq < l.menor_cursor
        RETURNING p.workspace_id, p.change_seq
      ),
      avanco AS (
        UPDATE workspaces w
           SET tombstone_horizon_seq = GREATEST(w.tombstone_horizon_seq, maior.seq)
          FROM (
            SELECT workspace_id, MAX(change_seq) AS seq FROM apagadas GROUP BY workspace_id
          ) AS maior
         WHERE w.id = maior.workspace_id
        RETURNING 1
      )
      SELECT count(*)::text AS empresas FROM avanco
    `);

    context.logger.info(
      {
        operacoesRemovidas: Number(operacoes.rows[0]?.removidas ?? 0),
        empresasComLapidesLimpas: Number(lapides.rows[0]?.empresas ?? 0),
      },
      'limpeza de sincronização concluída',
    );

    await scheduleNext(context.services);
  });
}

async function scheduleNext(services: AppServices): Promise<void> {
  const runAt = new Date(Date.now() + services.env.SYNC_RETENTION_INTERVAL_MINUTES * 60_000);

  await enqueueJob(services.db, {
    kind: SYNC_RETENTION_JOB,
    uniqueKey: `${SYNC_RETENTION_JOB}:${runAt.toISOString().slice(0, 13)}`,
    runAt,
    maxAttempts: 3,
  });
}

export async function bootstrapSyncJobs(services: AppServices): Promise<void> {
  await enqueueJob(services.db, {
    kind: SYNC_RETENTION_JOB,
    uniqueKey: `${SYNC_RETENTION_JOB}:bootstrap`,
    runAt: new Date(Date.now() + 120_000),
    maxAttempts: 3,
  });
}
