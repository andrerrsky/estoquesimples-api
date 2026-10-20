import { sql } from 'drizzle-orm';

import type { AppServices } from '../../platform/http/context.js';
import { enqueueJob, registerJobHandler } from '../../platform/jobs/runner.js';
import { ENTITLED_STATES } from '../billing/billing.service.js';
import { sqlList } from '../admin/admin-series.js';
import { NotificationService, NotificationType } from '../notifications/notifications.service.js';

export const LOW_STOCK_ALERT_JOB = 'push.low_stock_alert';

/** Uma vez por dia, às 8h de Brasília (11h UTC; o Brasil não tem horário de verão desde 2019). */
const HOUR_UTC = 11;

/**
 * Aviso de estoque baixo para quem usa o web app.
 *
 * O app Android já avisa sozinho (calcula no aparelho, `LowStockWorker`);
 * quem usa só a web (iPhone, iPad, computador) não tinha esse aviso. Uma vez
 * por dia, para cada empresa com produto no mínimo ou abaixo dele, cada
 * pessoa que pode ver o estoque na nuvem e tem os avisos ligados num
 * navegador recebe um Web Push (e o aviso na caixa de notificações). Vai só
 * para navegadores: no Android seria um segundo aviso igual ao do app.
 *
 * Quem pode ver: o proprietário sempre (a nuvem é dele no plano gratuito) e
 * os demais membros ativos só com o plano Equipe em vigor. Um aviso por
 * pessoa, empresa e dia (`dedupeKey`), mesmo se a tarefa rodar duas vezes.
 */
export async function sendLowStockAlerts(services: AppServices): Promise<{ workspaces: number; notified: number }> {
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const rows = await services.db.execute<{
    workspace_id: string;
    workspace_name: string;
    user_id: string;
    total: number;
    names: string[];
  }>(sql`
    WITH low AS (
      SELECT p.workspace_id,
             count(*)::int AS total,
             (array_agg(p.name ORDER BY (p.quantity_cache - p.min_stock), p.name))[1:3] AS names
      FROM products p
      WHERE p.deleted_at IS NULL
        AND (p.quantity_cache <= 0 OR (p.min_stock > 0 AND p.quantity_cache <= p.min_stock))
      GROUP BY p.workspace_id
    )
    SELECT DISTINCT low.workspace_id, w.name AS workspace_name, wm.user_id, low.total, low.names
    FROM low
    JOIN workspaces w ON w.id = low.workspace_id AND w.deleted_at IS NULL
    JOIN workspace_members wm ON wm.workspace_id = low.workspace_id AND wm.status = 'active'
    JOIN users u ON u.id = wm.user_id AND u.deleted_at IS NULL AND u.status = 'active'
    JOIN push_tokens t ON t.user_id = wm.user_id AND t.platform = 'web' AND t.revoked_at IS NULL
      AND coalesce(t.notifications_enabled, true)
    WHERE wm.role_key = 'proprietario'
       OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.workspace_id = low.workspace_id AND s.state IN ${sqlList(ENTITLED_STATES)})
  `);

  const notifications = new NotificationService(services);
  const workspaces = new Set<string>();
  let notified = 0;
  for (const row of rows.rows) {
    workspaces.add(row.workspace_id);
    const names = (row.names ?? []).filter(Boolean);
    const rest = row.total - names.length;
    const list = names.length === 0 ? '' : rest > 0 ? `${names.join(', ')} e mais ${rest}` : names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names.at(-1)}` : names[0];
    const result = await notifications.notify({
      userId: row.user_id,
      workspaceId: row.workspace_id,
      type: NotificationType.STOCK_LOW,
      title: row.total === 1 ? `1 produto acabando em ${row.workspace_name}` : `${row.total} produtos acabando em ${row.workspace_name}`,
      body: list ? `No mínimo ou abaixo dele: ${list}.` : 'Veja o que precisa repor.',
      data: { workspaceId: row.workspace_id, count: row.total },
      dedupeKey: `stock.low:${row.workspace_id}:${day}`,
      pushPlatforms: ['web'],
    });
    if (result.id) notified += 1;
  }
  return { workspaces: workspaces.size, notified };
}

function nextRun(from = new Date()): Date {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), HOUR_UTC, 0, 0));
  if (next.getTime() <= from.getTime() + 60_000) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

async function scheduleNext(services: AppServices): Promise<void> {
  const runAt = nextRun();
  await enqueueJob(services.db, {
    kind: LOW_STOCK_ALERT_JOB,
    uniqueKey: `${LOW_STOCK_ALERT_JOB}:${runAt.toISOString().slice(0, 10)}`,
    runAt,
    maxAttempts: 3,
  });
}

export function registerLowStockJobs(_services: AppServices): void {
  registerJobHandler(LOW_STOCK_ALERT_JOB, async (_payload, context) => {
    try {
      const result = await sendLowStockAlerts(context.services);
      context.logger.info(result, 'avisos de estoque baixo (web) enviados');
    } finally {
      await scheduleNext(context.services);
    }
  });
}

/** Na subida: garante a próxima execução na fila (a chave do dia evita duplicar). */
export async function bootstrapLowStockJobs(services: AppServices): Promise<void> {
  await scheduleNext(services);
}
