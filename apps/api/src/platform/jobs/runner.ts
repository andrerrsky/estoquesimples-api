import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { Database, Transaction } from '../db/client.js';
import { jobLogs, jobs } from '../db/schema/index.js';
import type { AppServices } from '../http/context.js';
import type { Logger } from '../observability/logger.js';
import { recordJobResult } from '../observability/metrics.js';
import { recordError } from '../../modules/errors/error-log.js';

/**
 * Fila de tarefas em cima do próprio Postgres.
 *
 * `FOR UPDATE SKIP LOCKED` permite que várias instâncias da API consumam a
 * mesma fila sem coordenação externa e sem processar a mesma tarefa duas
 * vezes. Deliberadamente não introduzimos Redis ou um broker: o volume
 * previsto (reconciliação de assinaturas e limpeza de tombstones) não
 * justifica mais um componente de infraestrutura para manter e monitorar.
 */

export interface JobContext {
  services: AppServices;
  logger: Logger;
  attempt: number;
  /**
   * Conta em que passo a tarefa está ("escrevendo o post", por exemplo).
   * Fica gravado na própria linha da fila, que o painel mostra em
   * Operação › Fila de tarefas enquanto a tarefa roda. Nunca falha: um erro
   * ao anotar o passo não pode derrubar a tarefa.
   */
  progress: (step: string) => Promise<void>;
  /** Uma linha a mais no log da execução (página da tarefa no painel). Nunca falha. */
  log: (message: string, level?: JobLogLevel) => Promise<void>;
  /** Guarda o que a tarefa produziu (ex.: `{ postId }`) para o painel oferecer o atalho. */
  setResult: (result: Record<string, unknown>) => Promise<void>;
}

export type JobLogLevel = 'info' | 'warn' | 'error';

/** Quanto tempo o log de uma execução fica guardado. */
const LOG_RETENTION_DAYS = 30;

/** Grava uma linha no log da tarefa. Falha ao gravar não derruba a tarefa. */
export async function appendJobLog(
  db: Database,
  logger: Logger,
  entry: { jobId: string; attempt: number; message: string; level?: JobLogLevel },
): Promise<void> {
  try {
    await db.insert(jobLogs).values({
      jobId: entry.jobId,
      attempt: entry.attempt,
      level: entry.level ?? 'info',
      message: entry.message.slice(0, 4000),
    });
  } catch (error) {
    logger.warn({ err: error, jobId: entry.jobId }, 'não foi possível gravar o log da tarefa');
  }
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export type JobHandler = (payload: Record<string, unknown>, context: JobContext) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}

export interface EnqueueOptions {
  kind: string;
  payload?: Record<string, unknown>;
  /** Impede enfileirar a mesma tarefa duas vezes enquanto a anterior não concluir. */
  uniqueKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

export async function enqueueJob(
  executor: Database | Transaction,
  options: EnqueueOptions,
): Promise<void> {
  await executor
    .insert(jobs)
    .values({
      kind: options.kind,
      payload: options.payload ?? {},
      uniqueKey: options.uniqueKey ?? null,
      runAt: options.runAt ?? new Date(),
      maxAttempts: options.maxAttempts ?? 5,
    })
    .onConflictDoNothing();
}

interface ClaimedJob extends Record<string, unknown> {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  unique_key: string | null;
}

/** Backoff exponencial com teto de 1 hora entre tentativas. */
function retryDelaySeconds(attempt: number): number {
  return Math.min(2 ** attempt * 15, 3600);
}

async function claimAndRun(
  services: AppServices,
  logger: Logger,
  workerId: string,
): Promise<boolean> {
  const { db } = services;

  const claimed = await db.transaction(async (tx) => {
    const result = await tx.execute<ClaimedJob>(sql`
      WITH next_job AS (
        SELECT id FROM jobs
        WHERE completed_at IS NULL
          AND failed_at IS NULL
          AND locked_at IS NULL
          AND run_at <= now()
        ORDER BY run_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE jobs
      SET locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1, progress = NULL, progress_at = NULL
      WHERE id IN (SELECT id FROM next_job)
      RETURNING id, kind, payload, attempts, max_attempts, unique_key
    `);
    return result.rows[0] ?? null;
  });

  if (!claimed) return false;

  const startedAtMs = Date.now();
  const log = (message: string, level: JobLogLevel = 'info') =>
    appendJobLog(db, logger, { jobId: claimed.id, attempt: claimed.attempts, message, level });
  await log(`Tentativa ${claimed.attempts} de ${claimed.max_attempts} iniciada (${workerId}).`);

  const handler = handlers.get(claimed.kind);
  if (!handler) {
    await log(`Nenhum handler registrado para "${claimed.kind}".`, 'error');
    logger.error({ kind: claimed.kind, jobId: claimed.id }, 'nenhum handler registrado para a tarefa');
    await db
      .update(jobs)
      .set({ failedAt: new Date(), lastError: `handler ausente para "${claimed.kind}"` })
      .where(sql`${jobs.id} = ${claimed.id}`);
    return true;
  }

  const progress = async (step: string): Promise<void> => {
    try {
      await db
        .update(jobs)
        .set({ progress: step.slice(0, 200), progressAt: new Date() })
        .where(sql`${jobs.id} = ${claimed.id}`);
      logger.info({ kind: claimed.kind, jobId: claimed.id, passo: step }, 'tarefa avançou');
    } catch (error) {
      logger.warn({ err: error, jobId: claimed.id }, 'não foi possível anotar o passo da tarefa');
    }
    await log(step);
  };
  const setResult = async (result: Record<string, unknown>): Promise<void> => {
    try {
      await db.update(jobs).set({ result }).where(sql`${jobs.id} = ${claimed.id}`);
    } catch (error) {
      logger.warn({ err: error, jobId: claimed.id }, 'não foi possível guardar o resultado da tarefa');
    }
  };

  try {
    await handler(claimed.payload ?? {}, { services, logger, attempt: claimed.attempts, progress, log, setResult });
    recordJobResult(claimed.kind, 'ok');
    await log(`Concluída em ${seconds(Date.now() - startedAtMs)}.`);
    await db
      .update(jobs)
      .set({ completedAt: new Date(), lockedAt: null, lockedBy: null })
      .where(sql`${jobs.id} = ${claimed.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = claimed.attempts >= claimed.max_attempts;
    recordJobResult(claimed.kind, exhausted ? 'esgotada' : 'erro');
    await log(`Falhou depois de ${seconds(Date.now() - startedAtMs)}: ${message}`, 'error');
    await log(
      exhausted
        ? 'Tentativas esgotadas: a tarefa fica em Falhas até alguém repetir ou ignorar.'
        : `Nova tentativa agendada para daqui a ${retryDelaySeconds(claimed.attempts)} s.`,
      exhausted ? 'error' : 'warn',
    );

    logger.error(
      { err: error, kind: claimed.kind, jobId: claimed.id, attempt: claimed.attempts, exhausted },
      'tarefa falhou',
    );
    // Só a última tentativa vai para o painel: as anteriores são retentativas normais.
    if (exhausted) {
      void recordError(services, {
        source: 'api',
        kind: 'job',
        code: claimed.kind,
        message: error instanceof Error ? `${error.name}: ${message}` : message,
        stack: error instanceof Error ? (error.stack ?? null) : null,
        context: { jobId: claimed.id, tentativas: claimed.attempts },
      });
    }

    await db
      .update(jobs)
      .set({
        lockedAt: null,
        lockedBy: null,
        lastError: message.slice(0, 1000),
        ...(exhausted
          ? { failedAt: new Date() }
          : { runAt: new Date(Date.now() + retryDelaySeconds(claimed.attempts) * 1000) }),
      })
      .where(sql`${jobs.id} = ${claimed.id}`);
  }

  return true;
}

/**
 * Libera tarefas presas (a consulta de cima pula o que está com `locked_at`,
 * então sem isto uma tarefa cuja instância morreu nunca mais rodaria): se uma instância morreu no meio do processamento,
 * o lock ficaria para sempre. Trinta minutos é folgado o suficiente para não
 * atropelar uma tarefa realmente lenta.
 */
let lastLogCleanup = 0;

/** Apaga o log de execuções antigas, no máximo uma vez por hora. */
async function pruneJobLogs(db: Database): Promise<void> {
  if (Date.now() - lastLogCleanup < 3_600_000) return;
  lastLogCleanup = Date.now();
  await db.execute(sql`DELETE FROM job_logs WHERE created_at < now() - make_interval(days => ${LOG_RETENTION_DAYS})`);
}

async function releaseStaleLocks(db: Database): Promise<void> {
  await db.execute(sql`
    UPDATE jobs
    SET locked_at = NULL, locked_by = NULL
    WHERE locked_at < now() - interval '30 minutes'
      AND completed_at IS NULL
      AND failed_at IS NULL
  `);
}

export function startJobRunner(
  services: AppServices,
  logger: Logger,
  options: { intervalMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 5_000;
  const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await releaseStaleLocks(services.db);
      await pruneJobLogs(services.db).catch((error: unknown) => logger.warn({ err: error }, 'falha ao limpar o log das tarefas'));
      // Drena até 20 tarefas por ciclo para não monopolizar o event loop.
      for (let i = 0; i < 20; i += 1) {
        const processed = await claimAndRun(services, logger, workerId);
        if (!processed) break;
      }
    } catch (error) {
      logger.error({ err: error }, 'falha no ciclo da fila de tarefas');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Não impede o processo de encerrar quando só a fila estiver ativa.
  timer.unref();

  logger.info({ workerId, intervalMs }, 'fila de tarefas iniciada');

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
