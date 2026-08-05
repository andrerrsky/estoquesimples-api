import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { Database, Transaction } from '../db/client.js';
import { jobs } from '../db/schema/index.js';
import type { AppServices } from '../http/context.js';
import type { Logger } from '../observability/logger.js';
import { recordJobResult } from '../observability/metrics.js';

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
          AND run_at <= now()
        ORDER BY run_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE jobs
      SET locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
      WHERE id IN (SELECT id FROM next_job)
      RETURNING id, kind, payload, attempts, max_attempts
    `);
    return result.rows[0] ?? null;
  });

  if (!claimed) return false;

  const handler = handlers.get(claimed.kind);
  if (!handler) {
    logger.error({ kind: claimed.kind, jobId: claimed.id }, 'nenhum handler registrado para a tarefa');
    await db
      .update(jobs)
      .set({ failedAt: new Date(), lastError: `handler ausente para "${claimed.kind}"` })
      .where(sql`${jobs.id} = ${claimed.id}`);
    return true;
  }

  try {
    await handler(claimed.payload ?? {}, { services, logger, attempt: claimed.attempts });
    recordJobResult(claimed.kind, 'ok');
    await db
      .update(jobs)
      .set({ completedAt: new Date(), lockedAt: null, lockedBy: null })
      .where(sql`${jobs.id} = ${claimed.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = claimed.attempts >= claimed.max_attempts;
    recordJobResult(claimed.kind, exhausted ? 'esgotada' : 'erro');

    logger.error(
      { err: error, kind: claimed.kind, jobId: claimed.id, attempt: claimed.attempts, exhausted },
      'tarefa falhou',
    );

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
 * Libera tarefas presas: se uma instância morreu no meio do processamento,
 * o lock ficaria para sempre. Trinta minutos é folgado o suficiente para não
 * atropelar uma tarefa realmente lenta.
 */
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
