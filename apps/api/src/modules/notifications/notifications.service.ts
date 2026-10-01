import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { notifications, pushTokens } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { notFound } from '../../platform/http/errors.js';

/**
 * Tipos de notificação conhecidos.
 *
 * Catálogo aberto: `type` é texto livre no banco e um tipo novo não exige
 * migration. A lista existe para que quem emite e quem exibe (web, Android,
 * painel) concordem sobre o que cada `data` carrega:
 *
 *   support.reply / support.resolved   { ticketId, ticketNumber }
 *   billing.payment_confirmed|payment_overdue|subscription_suspended|
 *     subscription_ended|subscription_refunded   { workspaceId }
 *   team.invite_accepted | team.member_joined    { workspaceId }
 *   campaign                                     { campaignId, screen?, url? }
 */
export const NotificationType = {
  SUPPORT_REPLY: 'support.reply',
  SUPPORT_RESOLVED: 'support.resolved',
  BILLING_PAYMENT_CONFIRMED: 'billing.payment_confirmed',
  BILLING_PAYMENT_OVERDUE: 'billing.payment_overdue',
  BILLING_SUBSCRIPTION_SUSPENDED: 'billing.subscription_suspended',
  BILLING_SUBSCRIPTION_ENDED: 'billing.subscription_ended',
  BILLING_SUBSCRIPTION_REFUNDED: 'billing.subscription_refunded',
  TEAM_INVITE_ACCEPTED: 'team.invite_accepted',
  CAMPAIGN: 'campaign',
} as const;

export type NotificationTypeValue = (typeof NotificationType)[keyof typeof NotificationType];

export interface NotifyInput {
  userId: string;
  workspaceId?: string | null;
  type: NotificationTypeValue | (string & {});
  title: string;
  body?: string;
  /** Valores simples: viram `data` do push (strings) e da caixa. */
  data?: Record<string, string | number | boolean | null>;
  /** Mesma chave para o mesmo usuário não gera segundo aviso. */
  dedupeKey?: string;
  /** Também manda push para os aparelhos do usuário (padrão: sim). */
  push?: boolean;
}

export interface NotifyResult {
  /** `null` quando o aviso já existia (dedupe). */
  id: string | null;
  pushAccepted: number;
  pushFailed: number;
  pushMuted: number;
  pushError: string | null;
}

/**
 * Notificações ao usuário: uma caixa única no servidor e, a partir dela, os
 * canais de entrega.
 *
 * A linha em `notifications` é a notificação; o push (FCM) é só uma forma de
 * avisar o aparelho. A web lê a caixa por `GET /v1/notifications`; o Android
 * recebe o push e pode ler a mesma caixa. Um canal novo (web push, e-mail)
 * entra aqui, em `deliver`, sem que quem emite precise mudar.
 */
export class NotificationService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  async notify(input: NotifyInput): Promise<NotifyResult> {
    const title = input.title.slice(0, 160);
    const body = (input.body ?? '').slice(0, 1000);

    const inserted = await this.db
      .insert(notifications)
      .values({
        userId: input.userId,
        workspaceId: input.workspaceId ?? null,
        type: input.type,
        title,
        body,
        data: input.data ?? {},
        dedupeKey: input.dedupeKey ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: notifications.id });

    const id = inserted[0]?.id ?? null;
    if (!id) return { id: null, pushAccepted: 0, pushFailed: 0, pushMuted: 0, pushError: null };

    if (input.push === false) return { id, pushAccepted: 0, pushFailed: 0, pushMuted: 0, pushError: null };
    const push = await this.pushToUser(input.userId, {
      title,
      body,
      data: { ...stringify(input.data ?? {}), type: pushType(input.type), notificationId: id },
    });
    return { id, ...push };
  }

  /**
   * Envia um push de dados para os aparelhos de um usuário (e, opcionalmente,
   * de uma instalação sem conta). Nunca lança: quem chama já gravou o que
   * importava e só quer saber o resultado.
   */
  async pushToUser(
    userId: string | null,
    message: { title: string; body: string; data: Record<string, string> },
    options: { installId?: string | null } = {},
  ): Promise<{ pushAccepted: number; pushFailed: number; pushMuted: number; pushError: string | null }> {
    const result = { pushAccepted: 0, pushFailed: 0, pushMuted: 0, pushError: null as string | null };
    if (!this.services.fcm.configured) return { ...result, pushError: 'Firebase não configurado' };
    if (!userId && !options.installId) return result;

    const owner = userId && options.installId
      ? sql`(${pushTokens.userId} = ${userId} OR ${pushTokens.installId} = ${options.installId})`
      : userId
        ? eq(pushTokens.userId, userId)
        : eq(pushTokens.installId, options.installId as string);

    const tokens = await this.db
      .select({ token: pushTokens.token, enabled: pushTokens.notificationsEnabled })
      .from(pushTokens)
      .where(and(isNull(pushTokens.revokedAt), owner))
      .limit(10);

    for (const row of tokens) {
      if (row.enabled === false) {
        result.pushMuted += 1;
        continue;
      }
      try {
        const sent = await this.services.fcm.send(row.token, message);
        if (sent.ok) {
          result.pushAccepted += 1;
        } else {
          result.pushFailed += 1;
          result.pushError = sent.message;
          if (sent.reason === 'unregistered' || sent.reason === 'invalid') {
            await this.db
              .update(pushTokens)
              .set({ revokedAt: new Date(), revokeReason: sent.reason })
              .where(eq(pushTokens.token, row.token));
          }
        }
      } catch (error) {
        result.pushFailed += 1;
        result.pushError = error instanceof Error ? error.message : String(error);
        this.services.logger?.warn({ err: error, userId }, 'push de notificação não enviado');
      }
    }
    return result;
  }

  async list(userId: string, options: { unreadOnly?: boolean; limit: number; before?: string | undefined }) {
    const conditions = [eq(notifications.userId, userId)];
    if (options.unreadOnly) conditions.push(isNull(notifications.readAt));
    if (options.before) conditions.push(sql`${notifications.createdAt} < ${new Date(options.before)}`);

    const rows = await this.db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt))
      .limit(options.limit + 1);

    const items = rows.slice(0, options.limit).map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      data: row.data as Record<string, unknown>,
      workspaceId: row.workspaceId,
      read: row.readAt !== null,
      createdAt: row.createdAt.toISOString(),
    }));
    return { items, hasMore: rows.length > options.limit, unread: await this.unreadCount(userId) };
  }

  async unreadCount(userId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return rows[0]?.count ?? 0;
  }

  async markRead(userId: string, id: string): Promise<void> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .returning({ id: notifications.id });
    if (updated.length === 0) throw notFound('Notificação não encontrada.');
  }

  async markAllRead(userId: string): Promise<number> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return updated.length;
  }
}

function stringify(data: Record<string, string | number | boolean | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) out[key] = String(value);
  }
  return out;
}

/**
 * `type` do push: o app Android decide o destino por ele. Suporte mantém o
 * valor que o app já entende (`support`); os demais vão como `notice`, que o
 * app exibe e abre na tela inicial.
 */
function pushType(type: string): string {
  if (type.startsWith('support.')) return 'support';
  if (type === 'campaign') return 'campaign';
  return 'notice';
}
