import { and, eq, isNull, sql } from 'drizzle-orm';

import { adminSessions, platformAdmins } from '../../platform/db/schema/index.js';
import type { Transaction } from '../../platform/db/client.js';
import type { AppServices } from '../../platform/http/context.js';
import {
  AppError,
  ErrorCode,
  badRequest,
  conflict,
  notFound,
  unauthorized,
} from '../../platform/http/errors.js';
import {
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
  verifyPasswordDummy,
} from '../../platform/auth/password.js';
import { addDays, addHours, generateToken, hashToken } from '../../platform/auth/tokens.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { AdminAction, recordAdminAudit, recordAdminAuditSafe, type AdminActor } from './admin-audit.service.js';
import { ADMIN_ROLE_RANK, type AdminPublic, type AdminRole } from './admin.schemas.js';

/** Identidade do administrador autenticado, anexada à request. */
export interface AdminContext {
  adminId: string;
  sessionId: string;
  email: string;
  name: string;
  role: AdminRole;
}

/** Bloqueio progressivo com os mesmos parâmetros das contas de cliente. */
const LOGIN_MAX_ATTEMPTS = 5;
const LOCK_BASE_SECONDS = 60;
const LOCK_MAX_SECONDS = 3600;

/** Renova `last_used_at` no máximo a cada 5 minutos: uma escrita por clique seria desperdício. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

export class AdminAuthService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  private get env() {
    return this.services.env;
  }

  // -------------------------------------------------------------------------
  // Login e sessão
  // -------------------------------------------------------------------------

  async login(
    input: { email: string; password: string },
    meta: RequestMeta,
  ): Promise<{ token: string; expiresAt: Date; admin: AdminPublic }> {
    const found = await this.db
      .select()
      .from(platformAdmins)
      .where(sql`lower(${platformAdmins.email}) = ${input.email}`)
      .limit(1);

    const admin = found[0];

    // Mesmo tempo e mesma mensagem para conta inexistente e senha errada.
    if (!admin) {
      await verifyPasswordDummy(input.password);
      throw unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, 'E-mail ou senha incorretos.');
    }

    if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
      const retryAfterSeconds = Math.ceil((admin.lockedUntil.getTime() - Date.now()) / 1000);
      throw new AppError(
        429,
        ErrorCode.AUTH_ACCOUNT_LOCKED,
        'Muitas tentativas. Tente novamente mais tarde.',
        { extra: { retryAfterSeconds } },
      );
    }

    if (admin.status !== 'active') {
      throw new AppError(403, ErrorCode.AUTH_ACCOUNT_SUSPENDED, 'Acesso desativado.');
    }

    const ok = await verifyPassword(admin.passwordHash, input.password);
    if (!ok) {
      await this.registerFailedLogin(admin, meta);
      throw unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, 'E-mail ou senha incorretos.');
    }

    const token = generateToken();
    const expiresAt = this.idleExpiry(new Date());

    await this.db.transaction(async (tx) => {
      await tx
        .update(platformAdmins)
        .set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(platformAdmins.id, admin.id));

      await tx.insert(adminSessions).values({
        adminId: admin.id,
        tokenHash: hashToken(token),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        expiresAt,
      });

      await recordAdminAudit(tx, {
        actor: { adminId: admin.id, email: admin.email, ipAddress: meta.ipAddress },
        action: AdminAction.ADMIN_LOGGED_IN,
        targetType: 'admin',
        targetId: admin.id,
      });
    });

    return { token, expiresAt, admin: this.toPublic(admin) };
  }

  private async registerFailedLogin(
    admin: typeof platformAdmins.$inferSelect,
    meta: RequestMeta,
  ): Promise<void> {
    const attempts = admin.failedLoginAttempts + 1;
    let lockedUntil: Date | null = null;
    if (attempts >= LOGIN_MAX_ATTEMPTS) {
      const excess = attempts - LOGIN_MAX_ATTEMPTS;
      const seconds = Math.min(LOCK_BASE_SECONDS * 2 ** excess, LOCK_MAX_SECONDS);
      lockedUntil = new Date(Date.now() + seconds * 1000);
    }

    await this.db
      .update(platformAdmins)
      .set({ failedLoginAttempts: attempts, lockedUntil })
      .where(eq(platformAdmins.id, admin.id));

    await recordAdminAuditSafe(this.db, {
      actor: { adminId: admin.id, email: admin.email, ipAddress: meta.ipAddress },
      action: AdminAction.ADMIN_LOGIN_FAILED,
      targetType: 'admin',
      targetId: admin.id,
      metadata: { attempts, lockedUntil: lockedUntil?.toISOString() ?? null },
    });
  }

  /**
   * Resolve a sessão a partir do token do cookie.
   *
   * A sessão expira por inatividade (`ADMIN_SESSION_IDLE_HOURS`) e tem um
   * teto absoluto (`ADMIN_SESSION_MAX_DAYS`) contado do login: um cookie
   * roubado não vale para sempre só porque o painel fica aberto numa aba.
   */
  async resolveSession(token: string): Promise<AdminContext> {
    const rows = await this.db
      .select({
        sessionId: adminSessions.id,
        createdAt: adminSessions.createdAt,
        lastUsedAt: adminSessions.lastUsedAt,
        expiresAt: adminSessions.expiresAt,
        revokedAt: adminSessions.revokedAt,
        adminId: platformAdmins.id,
        email: platformAdmins.email,
        name: platformAdmins.name,
        role: platformAdmins.role,
        status: platformAdmins.status,
      })
      .from(adminSessions)
      .innerJoin(platformAdmins, eq(platformAdmins.id, adminSessions.adminId))
      .where(eq(adminSessions.tokenHash, hashToken(token)))
      .limit(1);

    const row = rows[0];
    const now = Date.now();
    if (!row || row.revokedAt) {
      throw unauthorized(ErrorCode.AUTH_SESSION_REVOKED, 'Sessão encerrada. Entre novamente.');
    }
    if (row.expiresAt.getTime() <= now) {
      throw unauthorized(ErrorCode.AUTH_SESSION_REVOKED, 'Sessão expirada. Entre novamente.');
    }
    const absoluteLimit = addDays(row.createdAt, this.env.ADMIN_SESSION_MAX_DAYS).getTime();
    if (absoluteLimit <= now) {
      throw unauthorized(ErrorCode.AUTH_SESSION_REVOKED, 'Sessão expirada. Entre novamente.');
    }
    if (row.status !== 'active') {
      throw new AppError(403, ErrorCode.AUTH_ACCOUNT_SUSPENDED, 'Acesso desativado.');
    }

    if (now - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      const expiresAt = new Date(Math.min(this.idleExpiry(new Date()).getTime(), absoluteLimit));
      await this.db
        .update(adminSessions)
        .set({ lastUsedAt: new Date(), expiresAt })
        .where(eq(adminSessions.id, row.sessionId));
    }

    return {
      adminId: row.adminId,
      sessionId: row.sessionId,
      email: row.email,
      name: row.name,
      role: row.role as AdminRole,
    };
  }

  async logout(context: AdminContext, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(adminSessions)
        .set({ revokedAt: new Date(), revokedReason: 'logout' })
        .where(and(eq(adminSessions.id, context.sessionId), isNull(adminSessions.revokedAt)));

      await recordAdminAudit(tx, {
        actor: { adminId: context.adminId, email: context.email, ipAddress: meta.ipAddress },
        action: AdminAction.ADMIN_LOGGED_OUT,
        targetType: 'admin',
        targetId: context.adminId,
      });
    });
  }

  private idleExpiry(from: Date): Date {
    return addHours(from, this.env.ADMIN_SESSION_IDLE_HOURS);
  }

  // -------------------------------------------------------------------------
  // Gestão de administradores (papel owner)
  // -------------------------------------------------------------------------

  async list(): Promise<AdminPublic[]> {
    const rows = await this.db.select().from(platformAdmins).orderBy(platformAdmins.createdAt);
    return rows.map((row) => this.toPublic(row));
  }

  async create(
    actor: AdminActor,
    input: { email: string; name: string; password: string; role: AdminRole },
  ): Promise<AdminPublic> {
    const policy = checkPasswordPolicy(input.password, input.email);
    if (!policy.valid) {
      throw new AppError(400, ErrorCode.AUTH_WEAK_PASSWORD, 'Senha não atende à política.', {
        details: policy.problems.map((message) => ({ field: 'password', message })),
      });
    }

    const passwordHash = await hashPassword(input.password);

    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: platformAdmins.id })
        .from(platformAdmins)
        .where(sql`lower(${platformAdmins.email}) = ${input.email.toLowerCase()}`)
        .limit(1);
      if (existing.length > 0) {
        throw conflict(ErrorCode.AUTH_EMAIL_IN_USE, 'Já existe um administrador com este e-mail.');
      }

      const inserted = await tx
        .insert(platformAdmins)
        .values({
          email: input.email.toLowerCase(),
          name: input.name,
          passwordHash,
          role: input.role,
          createdBy: actor.adminId,
        })
        .returning();
      const admin = inserted[0];
      if (!admin) throw new Error('Falha ao criar administrador');

      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.ADMIN_CREATED,
        targetType: 'admin',
        targetId: admin.id,
        metadata: { email: admin.email, role: admin.role },
      });

      return this.toPublic(admin);
    });
  }

  async update(
    actor: AdminActor,
    targetId: string,
    input: { name?: string; role?: AdminRole; status?: 'active' | 'disabled' },
  ): Promise<AdminPublic> {
    return this.db.transaction(async (tx) => {
      const target = await this.findForUpdate(tx, targetId);

      // Ninguém rebaixa ou desativa a si mesmo: seria a forma mais fácil de
      // trancar o último owner para fora do painel.
      if (target.id === actor.adminId && (input.role !== undefined || input.status !== undefined)) {
        throw badRequest(ErrorCode.FORBIDDEN, 'Altere seu próprio papel ou situação por outro administrador.');
      }

      if (
        (input.role !== undefined && input.role !== 'owner') ||
        input.status === 'disabled'
      ) {
        await this.assertNotLastOwner(tx, target);
      }

      const patch: Partial<typeof platformAdmins.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.role !== undefined) patch.role = input.role;
      if (input.status !== undefined) patch.status = input.status;

      const updated = await tx
        .update(platformAdmins)
        .set(patch)
        .where(eq(platformAdmins.id, target.id))
        .returning();
      const admin = updated[0];
      if (!admin) throw notFound('Administrador não encontrado.');

      if (input.status === 'disabled') {
        await this.revokeSessions(tx, target.id, 'disabled');
      }

      const action =
        input.status === 'disabled'
          ? AdminAction.ADMIN_DISABLED
          : input.status === 'active' && target.status !== 'active'
            ? AdminAction.ADMIN_REACTIVATED
            : AdminAction.ADMIN_UPDATED;

      await recordAdminAudit(tx, {
        actor,
        action,
        targetType: 'admin',
        targetId: admin.id,
        metadata: {
          changes: Object.fromEntries(
            Object.entries(patch).map(([key, value]) => [
              key,
              { from: (target as Record<string, unknown>)[key], to: value },
            ]),
          ),
        },
      });

      return this.toPublic(admin);
    });
  }

  /** Define uma nova senha e derruba as sessões do alvo. */
  async resetPassword(actor: AdminActor, targetId: string, newPassword: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const target = await this.findForUpdate(tx, targetId);
      const policy = checkPasswordPolicy(newPassword, target.email);
      if (!policy.valid) {
        throw new AppError(400, ErrorCode.AUTH_WEAK_PASSWORD, 'Senha não atende à política.', {
          details: policy.problems.map((message) => ({ field: 'password', message })),
        });
      }

      await tx
        .update(platformAdmins)
        .set({ passwordHash: await hashPassword(newPassword), failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(platformAdmins.id, target.id));

      await this.revokeSessions(tx, target.id, 'password_changed');

      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.ADMIN_PASSWORD_RESET,
        targetType: 'admin',
        targetId: target.id,
      });
    });
  }

  async revokeAllSessions(actor: AdminActor, targetId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const target = await this.findForUpdate(tx, targetId);
      const revoked = await this.revokeSessions(tx, target.id, 'revoked_by_admin');
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.ADMIN_SESSIONS_REVOKED,
        targetType: 'admin',
        targetId: target.id,
        metadata: { revokedSessions: revoked },
      });
      return revoked;
    });
  }

  private async revokeSessions(tx: Transaction, adminId: string, reason: string): Promise<number> {
    const revoked = await tx
      .update(adminSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(adminSessions.adminId, adminId), isNull(adminSessions.revokedAt)))
      .returning({ id: adminSessions.id });
    return revoked.length;
  }

  private async findForUpdate(tx: Transaction, id: string) {
    const rows = await tx
      .select()
      .from(platformAdmins)
      .where(eq(platformAdmins.id, id))
      .limit(1)
      .for('update');
    const admin = rows[0];
    if (!admin) throw notFound('Administrador não encontrado.');
    return admin;
  }

  private async assertNotLastOwner(
    tx: Transaction,
    target: typeof platformAdmins.$inferSelect,
  ): Promise<void> {
    if (target.role !== 'owner' || target.status !== 'active') return;
    const owners = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(platformAdmins)
      .where(and(eq(platformAdmins.role, 'owner'), eq(platformAdmins.status, 'active')));
    if ((owners[0]?.count ?? 0) <= 1) {
      throw conflict(ErrorCode.LAST_OWNER, 'Este é o último owner ativo. Promova outro antes.');
    }
  }

  toPublic(admin: typeof platformAdmins.$inferSelect): AdminPublic {
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role as AdminRole,
      status: admin.status as 'active' | 'disabled',
      lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
      createdAt: admin.createdAt.toISOString(),
    };
  }
}

export function hasAdminRole(context: AdminContext, minimum: AdminRole): boolean {
  return ADMIN_ROLE_RANK[context.role] >= ADMIN_ROLE_RANK[minimum];
}
