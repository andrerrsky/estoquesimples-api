import { sql } from 'drizzle-orm';

import type { AppServices } from '../../platform/http/context.js';
import { brandLogoKey, imageKey } from '../../platform/storage/object-storage.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

/** Dias entre o pedido de exclusão e o expurgo (o que a resposta do pedido promete). */
export const ACCOUNT_RECOVERY_DAYS = 30;

/**
 * Janelas de retenção (tabela em docs/seguranca.md, que precisa contar a
 * mesma história da Política de Privacidade). Valores em dias.
 */
export const RETENTION = {
  /** Sessões encerradas ou vencidas (IP e navegador de quem entrou). */
  endedSessions: 90,
  /** Tokens de uso único (redefinir senha, confirmar e-mail, abrir a web logada) depois de vencidos. */
  usedTokens: 30,
  /** IP nos registros de auditoria (o registro fica; o IP sai). */
  auditIp: 180,
  /** Caixa de notificações. */
  notifications: 365,
  /** Aparelhos que não aparecem há tanto tempo (push). */
  stalePushTokens: 180,
  /** Conversas de suporte encerradas sem mensagem nova. */
  closedSupport: 730,
  /** Tarefas da fila já concluídas ou que falharam de vez. */
  finishedJobs: 30,
  /** Convites aceitos, cancelados ou vencidos (e-mail de quem foi convidado). */
  closedInvites: 90,
} as const;

type Counted = {
  count: number;
};

export class PrivacyService {
  constructor(private readonly services: AppServices) {}

  private async run(query: ReturnType<typeof sql>): Promise<number> {
    const result = await this.services.db.execute(query);
    return result.rowCount ?? 0;
  }

  /**
   * Expurga as contas cujo pedido de exclusão passou do prazo de
   * recuperação. Apagar a linha de `users` leva junto (ON DELETE CASCADE)
   * sessões, tokens, aparelhos, vínculos com empresas e notificações, e
   * desvincula (SET NULL) analytics, push, suporte, auditoria e histórico de
   * estoque. Antes disso sai o que não está ligado por chave estrangeira:
   * contato das conversas de suporte, erros registrados e IPs da auditoria.
   * Empresas que a pessoa ainda possui ficam: a conta não é expurgada e o
   * caso vai para o log (o pedido de exclusão já recusa quem é o único dono).
   */
  async purgeDeletedAccounts(now = new Date()): Promise<{ purged: number; skipped: number }> {
    const cutoff = new Date(now.getTime() - ACCOUNT_RECOVERY_DAYS * 86_400_000);
    const due = await this.services.db.execute<{ id: string }>(sql`
      SELECT id FROM users
      WHERE status = 'pending_deletion' AND deletion_requested_at < ${cutoff} AND deleted_at IS NULL
      ORDER BY deletion_requested_at
      LIMIT 200
    `);
    let purged = 0;
    let skipped = 0;
    for (const { id } of due.rows) {
      const owns = await this.services.db.execute<Counted>(sql`
        SELECT count(*)::int AS count FROM workspaces WHERE owner_user_id = ${id} AND deleted_at IS NULL
      `);
      if ((owns.rows[0]?.count ?? 0) > 0) {
        skipped += 1;
        this.services.logger?.warn({ userId: id }, 'expurgo de conta adiado: ainda é dona de empresa ativa');
        continue;
      }
      // Fotos e logotipos dessas empresas saem do bucket antes das linhas: sem
      // as linhas de `workspace_images`, a coleta de lixo não acharia mais os
      // arquivos. Falha aqui adia o expurgo para a próxima execução.
      await this.deleteWorkspaceObjects(id);
      await this.services.db.transaction(async (tx) => {
        // Empresas já excluídas que a pessoa possuía: saem inteiras (estoque, fotos, assinatura).
        await tx.execute(sql`DELETE FROM workspaces WHERE owner_user_id = ${id} AND deleted_at IS NOT NULL`);
        await tx.execute(sql`DELETE FROM support_tickets WHERE user_id = ${id}`);
        await tx.execute(sql`UPDATE error_events SET user_id = NULL, user_agent = NULL WHERE user_id = ${id}`);
        await tx.execute(sql`UPDATE audit_log SET ip_address = NULL WHERE actor_user_id = ${id}`);
        // A trilha do painel fica (quem fez o quê), sem o e-mail da pessoa nos detalhes.
        await tx.execute(sql`
          UPDATE admin_audit_log
          SET metadata = (metadata - 'email') #- '{changes,email}' #- '{changes,name}'
          WHERE target_id = ${id} AND (metadata ? 'email' OR metadata #> '{changes,email}' IS NOT NULL OR metadata #> '{changes,name}' IS NOT NULL)
        `);
        await tx.execute(sql`DELETE FROM invites WHERE accepted_by = ${id}`);
        await tx.execute(sql`DELETE FROM users WHERE id = ${id}`);
        // O registro do expurgo não guarda nada que identifique a pessoa além do id, que já não aponta para ninguém.
        await recordAudit(tx, {
          actorUserId: null,
          action: AuditAction.USER_PURGED,
          entityType: 'user',
          entityId: id,
          metadata: { reason: 'deletion_requested', recoveryDays: ACCOUNT_RECOVERY_DAYS },
          ipAddress: null,
        });
      });
      purged += 1;
    }
    return { purged, skipped };
  }

  /** Apaga do bucket as fotos e logotipos das empresas excluídas que pertencem à conta. */
  private async deleteWorkspaceObjects(userId: string): Promise<void> {
    const { storage } = this.services;
    if (!storage.configured) return;
    const images = await this.services.db.execute<{ workspace_id: string; hash: string }>(sql`
      SELECT i.workspace_id, i.hash FROM workspace_images i JOIN workspaces w ON w.id = i.workspace_id
      WHERE w.owner_user_id = ${userId} AND w.deleted_at IS NOT NULL
    `);
    const logos = await this.services.db.execute<{ workspace_id: string; logo_hash: string }>(sql`
      SELECT b.workspace_id, b.logo_hash FROM workspace_brandings b JOIN workspaces w ON w.id = b.workspace_id
      WHERE w.owner_user_id = ${userId} AND w.deleted_at IS NOT NULL AND b.logo_hash IS NOT NULL
    `);
    const keys = [
      ...images.rows.map((row) => imageKey(row.workspace_id, row.hash)),
      ...logos.rows.map((row) => brandLogoKey(row.workspace_id, row.logo_hash)),
    ];
    for (const key of keys) await storage.delete(key);
  }

  /** Aplica as janelas de `RETENTION`. Cada passo é independente: um erro não segura os outros. */
  async applyRetention(now = new Date()): Promise<Record<string, number>> {
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
    const steps: Record<string, ReturnType<typeof sql>> = {
      sessions: sql`DELETE FROM sessions WHERE (revoked_at IS NOT NULL OR expires_at < now()) AND COALESCE(revoked_at, expires_at) < ${days(RETENTION.endedSessions)}`,
      adminSessions: sql`DELETE FROM admin_sessions WHERE (revoked_at IS NOT NULL OR expires_at < now()) AND COALESCE(revoked_at, expires_at) < ${days(RETENTION.endedSessions)}`,
      passwordResetTokens: sql`DELETE FROM password_reset_tokens WHERE expires_at < ${days(RETENTION.usedTokens)}`,
      emailVerificationTokens: sql`DELETE FROM email_verification_tokens WHERE expires_at < ${days(RETENTION.usedTokens)}`,
      webHandoffTokens: sql`DELETE FROM web_handoff_tokens WHERE expires_at < ${days(RETENTION.usedTokens)}`,
      auditIp: sql`UPDATE audit_log SET ip_address = NULL WHERE ip_address IS NOT NULL AND created_at < ${days(RETENTION.auditIp)}`,
      adminAuditIp: sql`UPDATE admin_audit_log SET ip_address = NULL WHERE ip_address IS NOT NULL AND created_at < ${days(RETENTION.auditIp)}`,
      notifications: sql`DELETE FROM notifications WHERE created_at < ${days(RETENTION.notifications)}`,
      pushTokens: sql`DELETE FROM push_tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ${days(RETENTION.endedSessions)}) OR last_seen_at < ${days(RETENTION.stalePushTokens)}`,
      supportTickets: sql`DELETE FROM support_tickets WHERE status = 'resolved' AND last_message_at < ${days(RETENTION.closedSupport)}`,
      invites: sql`DELETE FROM invites WHERE (accepted_at IS NOT NULL OR cancelled_at IS NOT NULL OR expires_at < now()) AND COALESCE(accepted_at, cancelled_at, expires_at) < ${days(RETENTION.closedInvites)}`,
      jobs: sql`DELETE FROM jobs WHERE (completed_at IS NOT NULL AND completed_at < ${days(RETENTION.finishedJobs)}) OR (failed_at IS NOT NULL AND failed_at < ${days(RETENTION.finishedJobs)})`,
    };
    const removed: Record<string, number> = {};
    for (const [name, query] of Object.entries(steps)) {
      try {
        removed[name] = await this.run(query);
      } catch (error) {
        removed[name] = -1;
        this.services.logger?.error({ err: error, step: name }, 'passo de retenção falhou');
      }
    }
    return removed;
  }
}
