import { adminAuditLog } from '../../platform/db/schema/index.js';
import type { Database, Transaction } from '../../platform/db/client.js';

/**
 * Ações que um administrador pode executar no painel.
 *
 * Lista fechada, como `AuditAction`: o explorador de auditoria e qualquer
 * alerta futuro confiam nos valores. Toda ação que altera dado, permissão,
 * assinatura ou sessão de um cliente precisa estar aqui e ser gravada.
 */
export const AdminAction = {
  ADMIN_LOGGED_IN: 'admin.logged_in',
  ADMIN_LOGIN_FAILED: 'admin.login_failed',
  ADMIN_LOGGED_OUT: 'admin.logged_out',
  ADMIN_CREATED: 'admin.created',
  ADMIN_UPDATED: 'admin.updated',
  ADMIN_PASSWORD_RESET: 'admin.password_reset',
  ADMIN_DISABLED: 'admin.disabled',
  ADMIN_REACTIVATED: 'admin.reactivated',
  ADMIN_SESSIONS_REVOKED: 'admin.sessions_revoked',

  USER_UPDATED: 'user.updated',
  USER_SUSPENDED: 'user.suspended',
  USER_REACTIVATED: 'user.reactivated',
  USER_UNLOCKED: 'user.unlocked',
  USER_EMAIL_VERIFIED: 'user.email_verified',
  USER_SESSIONS_REVOKED: 'user.sessions_revoked',
  USER_DEVICE_REVOKED: 'user.device_revoked',
  USER_PASSWORD_RESET_SENT: 'user.password_reset_sent',
  USER_DELETION_CANCELLED: 'user.deletion_cancelled',

  WORKSPACE_UPDATED: 'workspace.updated',
  WORKSPACE_DELETED: 'workspace.deleted',
  WORKSPACE_RESTORED: 'workspace.restored',
  WORKSPACE_OWNERSHIP_TRANSFERRED: 'workspace.ownership_transferred',
  WORKSPACE_MEMBER_ROLE_CHANGED: 'workspace.member_role_changed',
  WORKSPACE_MEMBER_STATUS_CHANGED: 'workspace.member_status_changed',
  WORKSPACE_MEMBER_REMOVED: 'workspace.member_removed',
  WORKSPACE_INVITE_CANCELLED: 'workspace.invite_cancelled',

  SUBSCRIPTION_REFRESHED: 'subscription.refreshed',
  SUBSCRIPTION_EVENT_RETRIED: 'subscription.event_retried',
  PLAN_UPDATED: 'plan.updated',
  PLAN_FEATURE_UPDATED: 'plan.feature_updated',

  NOTE_CREATED: 'note.created',
  NOTE_DELETED: 'note.deleted',

  OPS_SYNC_CONFIG_CHANGED: 'ops.sync_config_changed',
  OPS_JOB_RETRIED: 'ops.job_retried',
  OPS_JOB_CANCELLED: 'ops.job_cancelled',

  REVIEW_REPLIED: 'review.replied',
  REVIEW_DRAFT_GENERATED: 'review.draft_generated',
  REVIEWS_SYNCED: 'reviews.synced',
  SETTING_UPDATED: 'setting.updated',
  SETTING_REMOVED: 'setting.removed',

  PUSH_CAMPAIGN_CREATED: 'push.campaign_created',
  PUSH_CAMPAIGN_UPDATED: 'push.campaign_updated',
  PUSH_CAMPAIGN_SENT: 'push.campaign_sent',
  PUSH_CAMPAIGN_CANCELLED: 'push.campaign_cancelled',
  PUSH_CAMPAIGN_DELETED: 'push.campaign_deleted',
  PUSH_TEST_SENT: 'push.test_sent',

  SUPPORT_REPLIED: 'support.replied',
  SUPPORT_NOTE_ADDED: 'support.note_added',
  SUPPORT_STATUS_CHANGED: 'support.status_changed',
  SUPPORT_TICKET_UPDATED: 'support.ticket_updated',
  SUPPORT_DRAFT_GENERATED: 'support.draft_generated',

  DATA_EXPORTED: 'data.exported',
} as const;

export type AdminActionValue = (typeof AdminAction)[keyof typeof AdminAction];

/** Ações que não alteram nada e, por isso, não precisam de confirmação. */
export const READ_ONLY_ADMIN_ACTIONS: ReadonlySet<AdminActionValue> = new Set([
  AdminAction.ADMIN_LOGGED_IN,
  AdminAction.ADMIN_LOGIN_FAILED,
  AdminAction.ADMIN_LOGGED_OUT,
  AdminAction.DATA_EXPORTED,
  AdminAction.REVIEW_DRAFT_GENERATED,
  AdminAction.REVIEWS_SYNCED,
  AdminAction.SUPPORT_DRAFT_GENERATED,
]);

export interface AdminActor {
  adminId: string;
  email: string;
  ipAddress: string | null;
}

export interface AdminAuditInput {
  actor: AdminActor;
  action: AdminActionValue;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Grava uma ação administrativa.
 *
 * Aceita a transação da operação para que registro e mudança sejam atômicos:
 * uma suspensão de conta sem a linha de auditoria correspondente é
 * exatamente o cenário que a auditoria existe para impedir.
 */
export async function recordAdminAudit(
  executor: Database | Transaction,
  entry: AdminAuditInput,
): Promise<void> {
  await executor.insert(adminAuditLog).values({
    adminId: entry.actor.adminId,
    adminEmail: entry.actor.email,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ?? {},
    ipAddress: entry.actor.ipAddress,
  });
}

/** Variante que nunca propaga erro, para eventos fora do caminho crítico. */
export async function recordAdminAuditSafe(
  executor: Database | Transaction,
  entry: AdminAuditInput,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await recordAdminAudit(executor, entry);
  } catch (error) {
    onError?.(error);
  }
}
