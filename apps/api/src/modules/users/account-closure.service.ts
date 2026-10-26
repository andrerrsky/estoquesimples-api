import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import { auditLog, subscriptions, users, workspaceMembers, workspaces } from '../../platform/db/schema/index.js';
import type { Transaction } from '../../platform/db/client.js';
import type { AppServices } from '../../platform/http/context.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { bumpPermissionVersion, revokeUserSessions, type RequestMeta } from '../auth/auth.service.js';
import { AsaasBillingService } from '../billing/asaas/asaas-billing.service.js';
import { LIVE_STATES } from '../billing/billing.service.js';
import { ACCOUNT_RECOVERY_DAYS } from '../privacy/privacy.service.js';

export interface OwnedWorkspace {
  id: string;
  name: string;
  /** Outras pessoas ativas na empresa (sem contar o dono). */
  otherMembers: number;
  subscription: { provider: 'google_play' | 'asaas'; state: string; renews: boolean } | null;
}

/**
 * Exclusão da conta pelo próprio cliente, inclusive de quem é dono de
 * empresas. Com `closeWorkspaces`, as empresas do dono são excluídas junto
 * (exclusão lógica: somem para todos os membros na hora e são apagadas de vez
 * com a conta, 30 dias depois, ou em 90 dias pela purga de empresas). O
 * suporte que cancela a exclusão da conta restaura as empresas fechadas com
 * ela.
 */
export class AccountClosureService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  async ownedWorkspaces(userId: string): Promise<OwnedWorkspace[]> {
    const owned = await this.db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(and(eq(workspaces.ownerUserId, userId), isNull(workspaces.deletedAt)))
      .orderBy(workspaces.name);
    if (owned.length === 0) return [];
    const ids = owned.map((item) => item.id);
    const members = await this.db
      .select({ workspaceId: workspaceMembers.workspaceId, total: sql<number>`count(*)::int` })
      .from(workspaceMembers)
      .where(and(inArray(workspaceMembers.workspaceId, ids), eq(workspaceMembers.status, 'active'), ne(workspaceMembers.userId, userId)))
      .groupBy(workspaceMembers.workspaceId);
    const live = await this.db
      .select({ workspaceId: subscriptions.workspaceId, provider: subscriptions.provider, state: subscriptions.state, autoRenewing: subscriptions.autoRenewing, canceledAt: subscriptions.canceledAt })
      .from(subscriptions)
      .where(and(inArray(subscriptions.workspaceId, ids), inArray(subscriptions.state, [...LIVE_STATES])));
    return owned.map((item) => {
      const sub = live.find((row) => row.workspaceId === item.id);
      return {
        id: item.id,
        name: item.name,
        otherMembers: members.find((row) => row.workspaceId === item.id)?.total ?? 0,
        subscription: sub
          ? {
              provider: sub.provider as 'google_play' | 'asaas',
              state: sub.state,
              // Google: renova enquanto auto_renewing; Asaas: enquanto não pediu cancelamento.
              renews: sub.provider === 'google_play' ? sub.autoRenewing : !sub.canceledAt && sub.state !== 'cancelada_mas_ativa',
            }
          : null,
      };
    });
  }

  /**
   * Pede a exclusão da conta. Dono de empresa precisa de `closeWorkspaces`
   * (senão 409 LAST_OWNER com a lista). Assinatura do Google Play que ainda
   * renova bloqueia (só a pessoa cancela, na Play Store); a do Asaas é
   * cancelada aqui.
   */
  async requestDeletion(userId: string, options: { closeWorkspaces: boolean }, meta: RequestMeta): Promise<{ recoverableUntil: Date; closedWorkspaces: string[] }> {
    const owned = await this.ownedWorkspaces(userId);
    if (owned.length > 0 && !options.closeWorkspaces) {
      throw new AppError(409, ErrorCode.LAST_OWNER, 'Você é proprietário de empresas. Exclua-as junto com a conta ou transfira a propriedade antes.', {
        extra: { workspaces: owned },
      });
    }
    const playRenewing = owned.filter((item) => item.subscription?.provider === 'google_play' && item.subscription.renews);
    if (playRenewing.length > 0) {
      throw new AppError(409, ErrorCode.WORKSPACE_SUBSCRIPTION_ACTIVE, 'Cancele a assinatura no Google Play (Play Store › Pagamentos e assinaturas) antes de excluir a empresa: o Google continuaria cobrando.', {
        extra: { workspaces: playRenewing.map((item) => ({ id: item.id, name: item.name })) },
      });
    }

    // Asaas: cancela na origem antes de mexer no banco (sem cobrança nova
    // para uma empresa que não existe mais). Falha aqui interrompe tudo.
    const asaas = new AsaasBillingService(this.services);
    for (const item of owned) {
      if (item.subscription?.provider !== 'asaas' || !item.subscription.renews) continue;
      const [row] = await this.db
        .select({ id: subscriptions.id, providerSubscriptionId: subscriptions.providerSubscriptionId })
        .from(subscriptions)
        .where(and(eq(subscriptions.workspaceId, item.id), inArray(subscriptions.state, [...LIVE_STATES])))
        .limit(1);
      if (!row) continue;
      await asaas.cancelAtProvider(row.providerSubscriptionId);
      await this.db.update(subscriptions).set({ canceledAt: new Date(), cancelReason: 'conta_excluida' }).where(eq(subscriptions.id, row.id));
    }

    const requestedAt = new Date();
    const recoverableUntil = new Date(requestedAt.getTime() + ACCOUNT_RECOVERY_DAYS * 86_400_000);
    const closedWorkspaces = owned.map((item) => item.id);

    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ status: 'pending_deletion', deletionRequestedAt: requestedAt }).where(eq(users.id, userId));
      for (const item of owned) {
        await this.setWorkspaceDeleted(tx, item.id, requestedAt);
        await recordAudit(tx, {
          workspaceId: item.id,
          actorUserId: userId,
          action: AuditAction.WORKSPACE_DELETED,
          entityType: 'workspace',
          entityId: item.id,
          metadata: { origem: 'conta_excluida', otherMembers: item.otherMembers },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        });
      }
      await revokeUserSessions(tx, userId, { reason: 'account_deleted' });
      await recordAudit(tx, {
        actorUserId: userId,
        action: AuditAction.USER_DELETION_REQUESTED,
        entityType: 'user',
        entityId: userId,
        metadata: { recoverableUntil: recoverableUntil.toISOString(), closedWorkspaces },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
    });
    return { recoverableUntil, closedWorkspaces };
  }

  /** Exclusão lógica da empresa: todos os membros perdem o acesso na hora. */
  private async setWorkspaceDeleted(tx: Transaction, workspaceId: string, at: Date | null): Promise<void> {
    await tx.update(workspaces).set({ deletedAt: at }).where(eq(workspaces.id, workspaceId));
    const members = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), ne(workspaceMembers.status, 'removed')));
    for (const member of members) await bumpPermissionVersion(tx, member.userId);
  }

  /**
   * Suporte cancelou a exclusão da conta: as empresas fechadas junto com ela
   * (registradas no pedido) voltam, se ainda existem e continuam excluídas.
   * Devolve quantas voltaram.
   */
  async restoreClosedWorkspaces(tx: Transaction, userId: string): Promise<string[]> {
    const [request] = await tx
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, userId), eq(auditLog.action, AuditAction.USER_DELETION_REQUESTED)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    const ids = ((request?.metadata as { closedWorkspaces?: unknown } | undefined)?.closedWorkspaces ?? []) as unknown[];
    const valid = ids.filter((id): id is string => typeof id === 'string');
    if (valid.length === 0) return [];
    const stillDeleted = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(inArray(workspaces.id, valid), eq(workspaces.ownerUserId, userId), sql`${workspaces.deletedAt} IS NOT NULL`));
    for (const row of stillDeleted) await this.setWorkspaceDeleted(tx, row.id, null);
    return stillDeleted.map((row) => row.id);
  }
}
