import { auditLog } from '../../platform/db/schema/index.js';
import type { Database, Transaction } from '../../platform/db/client.js';

/**
 * Ações auditáveis. Lista fechada para que a consulta de auditoria e os
 * alertas possam confiar nos valores, em vez de casar strings soltas.
 */
export const AuditAction = {
  USER_REGISTERED: 'user.registered',
  USER_LOGGED_IN: 'user.logged_in',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_ACCOUNT_LOCKED: 'user.account_locked',
  USER_LOGGED_OUT: 'user.logged_out',
  USER_LOGGED_OUT_ALL: 'user.logged_out_all',
  USER_PASSWORD_CHANGED: 'user.password_changed',
  USER_PASSWORD_RESET_REQUESTED: 'user.password_reset_requested',
  USER_PASSWORD_RESET_COMPLETED: 'user.password_reset_completed',
  USER_EMAIL_VERIFIED: 'user.email_verified',
  USER_DELETION_REQUESTED: 'user.deletion_requested',
  USER_TOKEN_REUSE_DETECTED: 'user.token_reuse_detected',
  DEVICE_REGISTERED: 'device.registered',
  DEVICE_REVOKED: 'device.revoked',

  WORKSPACE_CREATED: 'workspace.created',
  WORKSPACE_UPDATED: 'workspace.updated',
  WORKSPACE_DELETED: 'workspace.deleted',
  WORKSPACE_OWNERSHIP_TRANSFERRED: 'workspace.ownership_transferred',
  MEMBER_ROLE_CHANGED: 'member.role_changed',
  MEMBER_REMOVED: 'member.removed',
  MEMBER_SUSPENDED: 'member.suspended',
  MEMBER_REACTIVATED: 'member.reactivated',
  INVITE_CREATED: 'invite.created',
  INVITE_RESENT: 'invite.resent',
  INVITE_CANCELLED: 'invite.cancelled',
  INVITE_ACCEPTED: 'invite.accepted',

  SUBSCRIPTION_LINKED: 'subscription.linked',
  SUBSCRIPTION_STATE_CHANGED: 'subscription.state_changed',
  SUBSCRIPTION_TOKEN_REJECTED: 'subscription.token_rejected',
  SUBSCRIPTION_RECONCILED: 'subscription.reconciled',

  SYNC_INITIAL_UPLOAD_STARTED: 'sync.initial_upload_started',
  SYNC_INITIAL_UPLOAD_COMPLETED: 'sync.initial_upload_completed',
  SYNC_CONFLICT_RECORDED: 'sync.conflict_recorded',
  SYNC_CONFLICT_RESOLVED: 'sync.conflict_resolved',
  SYNC_RESYNC_REQUIRED: 'sync.resync_required',

  PRODUCT_DELETED: 'product.deleted',
  PRODUCT_RESTORED: 'product.restored',
  STOCK_ADJUSTED: 'stock.adjusted',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntryInput {
  workspaceId?: string | null;
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  action: AuditActionValue;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

/**
 * Grava um evento de auditoria.
 *
 * Aceita uma transação para que o registro seja atômico com a operação que o
 * originou: ou os dois acontecem, ou nenhum. Auditoria que some quando a
 * operação falha pela metade é pior do que não ter auditoria.
 */
export async function recordAudit(
  executor: Database | Transaction,
  entry: AuditEntryInput,
): Promise<void> {
  await executor.insert(auditLog).values({
    workspaceId: entry.workspaceId ?? null,
    actorUserId: entry.actorUserId ?? null,
    actorDeviceId: entry.actorDeviceId ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? {},
    ipAddress: entry.ipAddress ?? null,
  });
}

/**
 * Versão que nunca propaga erro, para eventos fora do caminho crítico.
 *
 * Uma falha ao registrar "login efetuado" não deve impedir o usuário de
 * entrar; a falha é logada e a requisição segue.
 */
export async function recordAuditSafe(
  executor: Database | Transaction,
  entry: AuditEntryInput,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await recordAudit(executor, entry);
  } catch (error) {
    onError?.(error);
  }
}
