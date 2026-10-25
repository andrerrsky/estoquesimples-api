import { randomInt } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { clientKey } from '../../platform/http/login-throttle.js';
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
import { addDays, addHours, generateToken, hashToken, safeEquals } from '../../platform/auth/tokens.js';
import { generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, otpauthUri, verifyTotp } from '../../platform/auth/totp.js';
import type { Env } from '../../platform/config/env.js';
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
  /** Segundo fator (TOTP) ativo. */
  mfaEnabled: boolean;
}

/** AAD do segredo TOTP: o blob só decifra na linha do próprio administrador. */
function totpAad(adminId: string): string {
  return `platform_admins.totp_secret:${adminId}`;
}

/** O painel exige segundo fator? Ver ADMIN_MFA_REQUIRED em env.ts. */
export function adminMfaRequired(env: Env): boolean {
  if (env.ADMIN_MFA_REQUIRED) return env.ADMIN_MFA_REQUIRED === 'true';
  return env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
}

/** Bloqueio progressivo com os mesmos parâmetros das contas de cliente. */

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
    input: { email: string; password: string; code?: string | undefined },
    meta: RequestMeta,
  ): Promise<{ token: string; expiresAt: Date; admin: AdminPublic }> {
    const found = await this.db
      .select()
      .from(platformAdmins)
      .where(sql`lower(${platformAdmins.email}) = ${input.email}`)
      .limit(1);

    const admin = found[0];
    const ip = clientKey(meta.ipAddress);

    // Bloqueio por (e-mail, IP), igual para conta existente ou não (ver login-throttle.ts).
    const retryAfterSeconds = this.services.throttle.retryAfter('admin', input.email, ip);
    if (retryAfterSeconds > 0) {
      throw new AppError(429, ErrorCode.AUTH_ACCOUNT_LOCKED, 'Muitas tentativas. Tente novamente mais tarde.', { extra: { retryAfterSeconds } });
    }

    // Mesmo tempo e mesma mensagem para conta inexistente e senha errada.
    if (!admin) {
      await verifyPasswordDummy(input.password);
      this.services.throttle.fail('admin', input.email, ip);
      throw unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, 'E-mail ou senha incorretos.');
    }

    const ok = await verifyPassword(admin.passwordHash, input.password);
    if (!ok) {
      const lockSeconds = this.services.throttle.fail('admin', input.email, ip);
      await this.registerFailedLogin(admin, lockSeconds, meta);
      throw unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, 'E-mail ou senha incorretos.');
    }

    // Depois da senha: quem não a sabe não descobre que o acesso existe e está desativado.
    if (admin.status !== 'active') {
      throw new AppError(403, ErrorCode.AUTH_ACCOUNT_SUSPENDED, 'Acesso desativado.');
    }
    // Segundo fator: senha certa sem código pede o código (sem contar erro);
    // código errado conta como tentativa falha, igual à senha.
    if (admin.totpEnabledAt && admin.totpSecret) {
      if (!input.code) {
        throw unauthorized(ErrorCode.ADMIN_MFA_REQUIRED, 'Digite o código do aplicativo autenticador.');
      }
      const accepted = await this.consumeSecondFactor(admin, input.code, meta);
      if (!accepted) {
        const lockSeconds = this.services.throttle.fail('admin', input.email, ip);
        await this.registerFailedLogin(admin, lockSeconds, meta);
        throw unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Código inválido ou já usado.');
      }
    }
    this.services.throttle.succeed('admin', input.email, ip);

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
    lockSeconds: number,
    meta: RequestMeta,
  ): Promise<void> {
    const attempts = admin.failedLoginAttempts + 1;
    const lockedUntil = lockSeconds > 0 ? new Date(Date.now() + lockSeconds * 1000) : null;

    await this.db
      .update(platformAdmins)
      .set({ failedLoginAttempts: attempts })
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
        totpEnabledAt: platformAdmins.totpEnabledAt,
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
      mfaEnabled: row.totpEnabledAt !== null,
    };
  }

  // -------------------------------------------------------------------------
  // Segundo fator (TOTP)
  // -------------------------------------------------------------------------

  /** Confere um código TOTP (sem replay) ou consome um código de recuperação. */
  private async consumeSecondFactor(admin: typeof platformAdmins.$inferSelect, code: string, meta: RequestMeta): Promise<boolean> {
    const secret = this.services.purchaseTokens.decrypt(admin.totpSecret!, totpAad(admin.id), { requireCurrentFormat: true });
    const step = verifyTotp(secret, code, { afterStep: admin.totpLastStep });
    if (step !== null) {
      // Condicional no banco: dois logins simultâneos com o mesmo código não passam os dois.
      const updated = await this.db
        .update(platformAdmins)
        .set({ totpLastStep: step })
        .where(and(eq(platformAdmins.id, admin.id), sql`coalesce(${platformAdmins.totpLastStep}, -1) < ${step}`))
        .returning({ id: platformAdmins.id });
      return updated.length > 0;
    }
    const hashed = hashToken(normalizeRecoveryCode(code));
    // Remoção condicional no banco: dois logins simultâneos com o mesmo código não passam os dois.
    const consumed = await this.db
      .update(platformAdmins)
      .set({ recoveryCodes: sql`${platformAdmins.recoveryCodes} - ${hashed}::text` })
      .where(and(eq(platformAdmins.id, admin.id), sql`${platformAdmins.recoveryCodes} ? ${hashed}::text`))
      .returning({ recoveryCodes: platformAdmins.recoveryCodes });
    if (consumed.length === 0) return false;
    const remaining = consumed[0]!.recoveryCodes;
    await recordAdminAuditSafe(this.db, {
      actor: { adminId: admin.id, email: admin.email, ipAddress: meta.ipAddress },
      action: AdminAction.ADMIN_MFA_RECOVERY_USED,
      targetType: 'admin',
      targetId: admin.id,
      metadata: { remaining: remaining.length },
    });
    return true;
  }

  async mfaStatus(context: AdminContext): Promise<{ enabled: boolean; required: boolean; recoveryCodesLeft: number }> {
    const [row] = await this.db.select().from(platformAdmins).where(eq(platformAdmins.id, context.adminId)).limit(1);
    return { enabled: Boolean(row?.totpEnabledAt), required: adminMfaRequired(this.env), recoveryCodesLeft: row?.recoveryCodes.length ?? 0 };
  }

  /** Gera um segredo novo (ainda inativo) e devolve o que o autenticador precisa ler. */
  /**
   * Códigos de confirmação do cadastro do autenticador, enviados por e-mail:
   * só a senha não basta para alguém cadastrar o próprio celular num acesso
   * alheio (novo ou recém-zerado). Em memória (instância única), 15 minutos,
   * 5 tentativas.
   */
  private readonly enrollCodes = new Map<string, { hash: string; expiresAt: number; attempts: number }>();

  async startMfaSetup(context: AdminContext): Promise<{ secret: string; otpauthUri: string }> {
    const [row] = await this.db.select().from(platformAdmins).where(eq(platformAdmins.id, context.adminId)).limit(1);
    if (row?.totpEnabledAt) throw conflict(ErrorCode.CONFLICT, 'O segundo fator já está ativo. Desative antes de cadastrar outro aparelho.');
    const secret = generateTotpSecret();
    await this.db.update(platformAdmins).set({ totpSecret: this.services.purchaseTokens.encrypt(secret, totpAad(context.adminId)), totpLastStep: null }).where(eq(platformAdmins.id, context.adminId));
    const emailCode = randomInt(0, 1_000_000).toString().padStart(6, '0');
    this.enrollCodes.set(context.adminId, { hash: hashToken(emailCode), expiresAt: Date.now() + 15 * 60_000, attempts: 0 });
    await this.services.mailer.send({
      to: context.email,
      kind: 'security_alert',
      subject: 'Código para cadastrar o autenticador - Estoque Simples',
      text:
        `Código para confirmar o cadastro do aplicativo autenticador no seu acesso ao painel: ${emailCode}\n\n` +
        'Vale por 15 minutos. Se não foi você, troque a senha e avise um owner do painel.',
    });
    return { secret, otpauthUri: otpauthUri(secret, context.email) };
  }

  private checkEnrollCode(adminId: string, code: string): boolean {
    const entry = this.enrollCodes.get(adminId);
    if (!entry || entry.expiresAt < Date.now() || entry.attempts >= 5) {
      this.enrollCodes.delete(adminId);
      return false;
    }
    entry.attempts += 1;
    const ok = safeEquals(hashToken(code.trim()), entry.hash);
    if (ok) this.enrollCodes.delete(adminId);
    return ok;
  }

  /** Confirma o cadastro com um código do autenticador e devolve os códigos de recuperação (uma vez só). */
  async enableMfa(context: AdminContext, code: string, emailCode: string, meta: RequestMeta): Promise<{ recoveryCodes: string[]; token: string; expiresAt: Date }> {
    if (!this.checkEnrollCode(context.adminId, emailCode)) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Código do e-mail inválido ou vencido. Comece o cadastro de novo para receber outro.');
    }
    const [row] = await this.db.select().from(platformAdmins).where(eq(platformAdmins.id, context.adminId)).limit(1);
    if (!row?.totpSecret) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Comece o cadastro do autenticador primeiro.');
    if (row.totpEnabledAt) throw conflict(ErrorCode.CONFLICT, 'O segundo fator já está ativo.');
    const step = verifyTotp(this.services.purchaseTokens.decrypt(row.totpSecret, totpAad(row.id), { requireCurrentFormat: true }), code);
    if (step === null) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Código inválido. Confira a hora do celular e tente de novo.');
    const recoveryCodes = generateRecoveryCodes();
    // Sessão nova ao ativar: a sessão aberta só com a senha (inclusive outras,
    // de outro navegador) não herda o acesso completo.
    const token = generateToken();
    const expiresAt = this.idleExpiry(new Date());
    await this.db.transaction(async (tx) => {
      await tx
        .update(platformAdmins)
        .set({ totpEnabledAt: new Date(), totpLastStep: step, recoveryCodes: recoveryCodes.map((item) => hashToken(normalizeRecoveryCode(item))) })
        .where(eq(platformAdmins.id, context.adminId));
      await tx.update(adminSessions).set({ revokedAt: new Date() }).where(and(eq(adminSessions.adminId, context.adminId), isNull(adminSessions.revokedAt)));
      await tx.insert(adminSessions).values({ adminId: context.adminId, tokenHash: hashToken(token), ipAddress: meta.ipAddress, userAgent: meta.userAgent, expiresAt });
      await recordAdminAudit(tx, {
        actor: { adminId: context.adminId, email: context.email, ipAddress: meta.ipAddress },
        action: AdminAction.ADMIN_MFA_ENABLED,
        targetType: 'admin',
        targetId: context.adminId,
      });
    });
    await this.notifySecurity(context.email, 'Segundo fator ativado no painel', 'O aplicativo autenticador foi cadastrado no seu acesso ao painel do Estoque Simples. As outras sessões abertas foram encerradas.');
    return { recoveryCodes, token, expiresAt };
  }

  /** Aviso por e-mail de mudança de segurança no acesso ao painel (nunca bloqueia a ação). */
  private async notifySecurity(to: string, subject: string, body: string): Promise<void> {
    try {
      await this.services.mailer.send({
        to,
        kind: 'security_alert',
        subject: `${subject} - Estoque Simples`,
        text: `${body}\n\nSe não foi você, fale agora com um owner do painel para zerar o segundo fator e trocar a senha.`,
      });
    } catch (error) {
      this.services.logger?.warn({ err: error }, 'aviso de segurança do painel não enviado');
    }
  }

  /** O próprio administrador desliga (senha + código). Com o segundo fator obrigatório, cai de volta na tela de cadastro. */
  async disableMfa(context: AdminContext, input: { password: string; code: string }, meta: RequestMeta): Promise<void> {
    const [row] = await this.db.select().from(platformAdmins).where(eq(platformAdmins.id, context.adminId)).limit(1);
    if (!row?.totpEnabledAt) return;
    // Mesmo freio do login: senha e código aqui também são alvo de tentativa e erro.
    const ip = clientKey(meta.ipAddress);
    const retryAfterSeconds = this.services.throttle.retryAfter('admin', row.email.toLowerCase(), ip);
    if (retryAfterSeconds > 0) throw new AppError(429, ErrorCode.AUTH_ACCOUNT_LOCKED, 'Muitas tentativas. Tente novamente mais tarde.', { extra: { retryAfterSeconds } });
    const passwordOk = await verifyPassword(row.passwordHash, input.password);
    const codeOk = passwordOk && (await this.consumeSecondFactor(row, input.code, meta));
    if (!codeOk) {
      this.services.throttle.fail('admin', row.email.toLowerCase(), ip);
      throw unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Senha ou código incorretos.');
    }
    await this.clearMfa(context.adminId, { adminId: context.adminId, email: context.email, ipAddress: meta.ipAddress }, AdminAction.ADMIN_MFA_DISABLED);
    await this.notifySecurity(context.email, 'Segundo fator desativado no painel', 'O segundo fator do seu acesso ao painel do Estoque Simples foi desativado.');
  }

  /** Owner zera o segundo fator de outro administrador (celular perdido sem códigos de recuperação). */
  async resetMfa(actor: AdminActor, targetId: string): Promise<void> {
    if (actor.adminId === targetId) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Para o seu próprio acesso, use "Desativar" na tela de segurança.');
    const [row] = await this.db.select({ id: platformAdmins.id, email: platformAdmins.email }).from(platformAdmins).where(eq(platformAdmins.id, targetId)).limit(1);
    if (!row) throw notFound('Administrador não encontrado.');
    await this.clearMfa(targetId, actor, AdminAction.ADMIN_MFA_RESET);
    await this.notifySecurity(row.email, 'Segundo fator zerado no painel', `${actor.email} zerou o segundo fator do seu acesso ao painel do Estoque Simples e encerrou suas sessões. No próximo acesso você cadastra o autenticador de novo.`);
  }

  private async clearMfa(targetId: string, actor: AdminActor, action: typeof AdminAction.ADMIN_MFA_DISABLED | typeof AdminAction.ADMIN_MFA_RESET): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(platformAdmins)
        .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: [] })
        .where(eq(platformAdmins.id, targetId));
      // Sessões abertas do alvo caem: quem zerou o fator pode estar respondendo a um acesso indevido.
      await tx.update(adminSessions).set({ revokedAt: new Date() }).where(and(eq(adminSessions.adminId, targetId), isNull(adminSessions.revokedAt)));
      await recordAdminAudit(tx, { actor, action, targetType: 'admin', targetId });
    });
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
      mfaEnabled: admin.totpEnabledAt !== null,
    };
  }
}

export function hasAdminRole(context: AdminContext, minimum: AdminRole): boolean {
  return ADMIN_ROLE_RANK[context.role] >= ADMIN_ROLE_RANK[minimum];
}
