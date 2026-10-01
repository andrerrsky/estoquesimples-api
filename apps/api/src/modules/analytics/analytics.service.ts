import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import { analyticsEvents, devices, workspaceMembers } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import type { AnalyticsEventNameValue } from './analytics.events.js';
import type { AnalyticsBatchBody } from './analytics.schemas.js';

/** Quanto o relógio do aparelho pode estar adiantado antes de o servidor corrigir. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
/** Eventos mais antigos que isto entram com a data do recebimento. */
const MAX_PAST_MS = 30 * 86_400_000;

export interface IngestContext {
  userId: string | null;
  deviceId: string | null;
  ipAddress: string | null;
}

export interface ServerEventInput {
  name: AnalyticsEventNameValue;
  userId?: string | null;
  workspaceId?: string | null;
  deviceId?: string | null;
  properties?: Record<string, string | number | boolean | null>;
}

/**
 * Entrada de eventos de uso.
 *
 * Duas portas: o lote enviado pelo app (`ingestBatch`) e os marcos que a
 * própria API observa (`trackServerEvent`). O segundo existe para que os
 * indicadores principais (cadastro, login, assinatura, sincronização) sejam
 * confiáveis mesmo antes de o app emitir qualquer evento — e continuem
 * sendo, porque são medidos onde o fato acontece.
 */
export class AnalyticsService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  async ingestBatch(
    body: AnalyticsBatchBody,
    context: IngestContext,
  ): Promise<{ accepted: number; duplicated: number; rejected: number }> {
    const now = Date.now();

    // Um evento só pode ser atribuído a uma empresa da qual o usuário
    // participa. Sem esta checagem, o app poderia (por bug ou má-fé) inflar
    // as métricas de outra empresa.
    const requestedWorkspaces = [
      ...new Set(body.events.map((event) => event.workspaceId).filter((id): id is string => !!id)),
    ];
    const allowedWorkspaces = new Set<string>();
    if (context.userId && requestedWorkspaces.length > 0) {
      const rows = await this.db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, context.userId),
            inArray(workspaceMembers.workspaceId, requestedWorkspaces),
            ne(workspaceMembers.status, 'removed'),
          ),
        );
      for (const row of rows) allowedWorkspaces.add(row.workspaceId);
    }

    let deviceId = context.deviceId;
    if (!deviceId && context.userId) {
      const found = await this.db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.userId, context.userId), eq(devices.installId, body.device.installId)))
        .limit(1);
      deviceId = found[0]?.id ?? null;
    }

    let rejected = 0;
    const rows = body.events.flatMap((event) => {
      const occurred = event.occurredAt;
      if (occurred > now + MAX_FUTURE_SKEW_MS) {
        rejected += 1;
        return [];
      }
      const occurredAt = occurred < now - MAX_PAST_MS ? new Date(now) : new Date(occurred);
      const workspaceId =
        event.workspaceId && allowedWorkspaces.has(event.workspaceId) ? event.workspaceId : null;

      return [
        {
          clientEventId: event.id,
          name: event.name,
          occurredAt,
          userId: context.userId,
          workspaceId,
          deviceId,
          installId: body.device.installId,
          platform: body.device.platform,
          appVersionCode: body.device.appVersionCode ?? null,
          sessionKey: event.sessionKey ?? null,
          source: 'app' as const,
          properties: event.properties ?? {},
        },
      ];
    });

    if (rows.length === 0) return { accepted: 0, duplicated: 0, rejected };

    const inserted = await this.db
      .insert(analyticsEvents)
      .values(rows)
      .onConflictDoNothing({ target: analyticsEvents.clientEventId })
      .returning({ id: analyticsEvents.id });

    return { accepted: inserted.length, duplicated: rows.length - inserted.length, rejected };
  }

  /**
   * Registra um marco observado pela própria API.
   *
   * Nunca lança: uma falha ao contar "cadastro concluído" não pode impedir o
   * cadastro. Roda fora da transação do caso de uso e sem contexto de tenant
   * (a tabela só aceita escrita no contexto de sistema).
   */
  async trackServerEvent(input: ServerEventInput): Promise<void> {
    try {
      await this.db.insert(analyticsEvents).values({
        name: input.name,
        occurredAt: new Date(),
        userId: input.userId ?? null,
        workspaceId: input.workspaceId ?? null,
        deviceId: input.deviceId ?? null,
        platform: 'server',
        source: 'server',
        properties: input.properties ?? {},
      });
    } catch (error) {
      this.services.logger?.warn({ err: error, event: input.name }, 'evento de analytics não gravado');
    }
  }

  /** Remove eventos além do prazo de retenção. Chamado pelo job. */
  async purgeExpired(retentionDays: number): Promise<number> {
    const result = await this.db.execute<{ removidos: string }>(sql`
      WITH removidos AS (
        DELETE FROM analytics_events
         WHERE occurred_at < now() - ${`${retentionDays} days`}::interval
        RETURNING 1
      )
      SELECT count(*)::text AS removidos FROM removidos
    `);
    return Number(result.rows[0]?.removidos ?? 0);
  }
}

/** Atalho para módulos que só precisam emitir um evento de servidor. */
export function trackServerEvent(services: AppServices, input: ServerEventInput): Promise<void> {
  return new AnalyticsService(services).trackServerEvent(input);
}
