import { enqueueJob, registerJobHandler } from '../../platform/jobs/runner.js';
import type { AppServices } from '../../platform/http/context.js';
import { OpsService } from './ops.service.js';

export const OPS_WATCHDOG_JOB = 'ops.watchdog';

/**
 * Vigia periódico do sistema.
 *
 * O alerta sai como log de nível error com `alerta: true`, e não por um
 * provedor específico. A coleta de logs do Railway (ou qualquer outra que
 * venha depois) dispara em cima desse campo. Acoplar o código a um serviço de
 * alerta agora significaria reescrever esta parte na primeira troca de
 * fornecedor, sem ganho nenhum enquanto o serviço tem uma instância.
 */
export function registerOpsJobs(services: AppServices): void {
  const service = new OpsService(services);

  registerJobHandler(OPS_WATCHDOG_JOB, async (_payload, context) => {
    const snapshot = await service.snapshot();
    const alertas = service.alertas(snapshot);

    for (const alerta of alertas) {
      context.logger.error(
        { alerta: true, tipo: alerta.nome, snapshot },
        `alerta: ${alerta.detalhe}`,
      );
    }

    if (alertas.length === 0) {
      context.logger.info({ snapshot }, 'verificação periódica sem alertas');
    }

    await agendar(services);
  });
}

/** Reagenda a próxima verificação, mantendo uma única ocorrência na fila. */
async function agendar(services: AppServices): Promise<void> {
  const minutos = services.env.OPS_WATCHDOG_INTERVAL_MINUTES;
  await enqueueJob(services.db, {
    kind: OPS_WATCHDOG_JOB,
    uniqueKey: `${OPS_WATCHDOG_JOB}:${new Date(Date.now() + minutos * 60_000)
      .toISOString()
      .slice(0, 13)}`,
    runAt: new Date(Date.now() + minutos * 60_000),
    maxAttempts: 3,
  });
}

export async function bootstrapOpsJobs(services: AppServices): Promise<void> {
  await enqueueJob(services.db, {
    kind: OPS_WATCHDOG_JOB,
    uniqueKey: `${OPS_WATCHDOG_JOB}:inicial`,
    runAt: new Date(Date.now() + 60_000),
    maxAttempts: 3,
  });
}
