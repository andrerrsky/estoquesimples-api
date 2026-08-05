import { and, eq, isNull, ne, sql } from 'drizzle-orm';

import {
  devices,
  emailVerificationTokens,
  passwordResetTokens,
  refreshTokens,
  sessions,
  users,
} from '../../platform/db/schema/index.js';
import type { Transaction } from '../../platform/db/client.js';
import type { AppServices } from '../../platform/http/context.js';
import {
  AppError,
  ErrorCode,
  badRequest,
  conflict,
  unauthorized,
} from '../../platform/http/errors.js';
import {
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
  verifyPasswordDummy,
} from '../../platform/auth/password.js';
import {
  addDays,
  addHours,
  addMinutes,
  generateToken,
  hashToken,
} from '../../platform/auth/tokens.js';
import { AuditAction, recordAudit, recordAuditSafe } from '../audit/audit.service.js';
import type { AuthSuccess, DeviceInfo } from './auth.schemas.js';

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

interface IssueSessionInput {
  userId: string;
  deviceId: string | null;
  meta: RequestMeta;
}

export class AuthService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  private get env() {
    return this.services.env;
  }

  // -------------------------------------------------------------------------
  // Cadastro e login
  // -------------------------------------------------------------------------

  async register(
    input: { email: string; password: string; name: string; device?: DeviceInfo },
    meta: RequestMeta,
  ): Promise<AuthSuccess> {
    const policy = checkPasswordPolicy(input.password, input.email);
    if (!policy.valid) {
      throw new AppError(400, ErrorCode.AUTH_WEAK_PASSWORD, 'Senha não atende à política.', {
        details: policy.problems.map((message) => ({ field: 'password', message })),
      });
    }

    const passwordHash = await hashPassword(input.password);

    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(sql`lower(${users.email}) = ${input.email}`, isNull(users.deletedAt)))
        .limit(1);

      if (existing.length > 0) {
        throw conflict(ErrorCode.AUTH_EMAIL_IN_USE, 'Já existe uma conta com este e-mail.');
      }

      const inserted = await tx
        .insert(users)
        .values({ email: input.email, name: input.name, passwordHash })
        .returning();

      const user = inserted[0];
      if (!user) throw new Error('Falha ao criar usuário');

      const deviceId = input.device ? await this.upsertDevice(tx, user.id, input.device) : null;
      const session = await this.issueSession(tx, { userId: user.id, deviceId, meta });

      await recordAudit(tx, {
        actorUserId: user.id,
        actorDeviceId: deviceId,
        action: AuditAction.USER_REGISTERED,
        entityType: 'user',
        entityId: user.id,
        ipAddress: meta.ipAddress,
      });

      // Verificação de e-mail é opcional para entrar, mas exigida para
      // convidar membros. Emitida já no cadastro para o usuário poder
      // confirmar quando quiser.
      await this.sendEmailVerification(tx, user.id, user.email);

      return this.buildAuthSuccess(user, session, deviceId);
    });
  }

  /**
   * Cria a conta de quem chegou por convite, dentro da transação que aceita o
   * convite.
   *
   * Conta e participação na empresa precisam nascer juntas: uma conta criada
   * sem o vínculo deixaria a pessoa autenticada e sem acesso a nada, com o
   * convite já gasto e nenhuma forma de tentar de novo.
   *
   * O e-mail já entra verificado. O token de convite chegou por ele, então
   * pedir uma segunda confirmação pelo mesmo canal não prova nada de novo.
   */
  async createInvitedUser(
    tx: Transaction,
    input: { email: string; password: string; name: string; device?: DeviceInfo },
    meta: RequestMeta,
  ): Promise<AuthSuccess> {
    const policy = checkPasswordPolicy(input.password, input.email);
    if (!policy.valid) {
      throw new AppError(400, ErrorCode.AUTH_WEAK_PASSWORD, 'Senha não atende à política.', {
        details: policy.problems.map((message) => ({ field: 'password', message })),
      });
    }

    const passwordHash = await hashPassword(input.password);

    const inserted = await tx
      .insert(users)
      .values({
        email: input.email,
        name: input.name,
        passwordHash,
        emailVerifiedAt: new Date(),
      })
      .returning();

    const user = inserted[0];
    if (!user) throw new Error('Falha ao criar usuário convidado');

    const deviceId = input.device ? await this.upsertDevice(tx, user.id, input.device) : null;
    const issued = await this.issueSession(tx, { userId: user.id, deviceId, meta });

    await recordAudit(tx, {
      actorUserId: user.id,
      actorDeviceId: deviceId,
      action: AuditAction.USER_REGISTERED,
      entityType: 'user',
      entityId: user.id,
      metadata: { origem: 'convite' },
      ipAddress: meta.ipAddress,
    });

    return this.buildAuthSuccess(user, issued, deviceId);
  }

  async login(
    input: { email: string; password: string; device?: DeviceInfo },
    meta: RequestMeta,
  ): Promise<AuthSuccess> {
    const found = await this.db
      .select()
      .from(users)
      .where(and(sql`lower(${users.email}) = ${input.email}`, isNull(users.deletedAt)))
      .limit(1);

    const user = found[0];

    // Conta inexistente gasta o mesmo tempo de CPU de uma verificação real,
    // e devolve a mesma mensagem, para não permitir enumerar e-mails.
    if (!user) {
      await verifyPasswordDummy(input.password);
      throw unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, 'E-mail ou senha incorretos.');
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const retryAfterSeconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new AppError(
        429,
        ErrorCode.AUTH_ACCOUNT_LOCKED,
        'Muitas tentativas. Tente novamente mais tarde.',
        { extra: { retryAfterSeconds } },
      );
    }

    if (user.status === 'suspended') {
      throw new AppError(403, ErrorCode.AUTH_ACCOUNT_SUSPENDED, 'Conta suspensa.');
    }

    const passwordOk = await verifyPassword(user.passwordHash, input.password);
    if (!passwordOk) {
      await this.registerFailedLogin(user.id, user.failedLoginAttempts + 1, meta);
      throw unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, 'E-mail ou senha incorretos.');
    }

    return this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id));

      const deviceId = input.device ? await this.upsertDevice(tx, user.id, input.device) : null;
      const session = await this.issueSession(tx, { userId: user.id, deviceId, meta });

      await recordAudit(tx, {
        actorUserId: user.id,
        actorDeviceId: deviceId,
        action: AuditAction.USER_LOGGED_IN,
        entityType: 'user',
        entityId: user.id,
        ipAddress: meta.ipAddress,
      });

      return this.buildAuthSuccess(user, session, deviceId);
    });
  }

  /**
   * Bloqueio progressivo: cada tentativa além do limite dobra o tempo de
   * espera, até o teto configurado. Roda fora da transação de login porque
   * precisa persistir mesmo quando a requisição termina em erro.
   */
  private async registerFailedLogin(
    userId: string,
    attempts: number,
    meta: RequestMeta,
  ): Promise<void> {
    let lockedUntil: Date | null = null;

    if (attempts >= this.env.LOGIN_MAX_ATTEMPTS) {
      const excess = attempts - this.env.LOGIN_MAX_ATTEMPTS;
      const seconds = Math.min(
        this.env.LOGIN_LOCK_BASE_SECONDS * 2 ** excess,
        this.env.LOGIN_LOCK_MAX_SECONDS,
      );
      lockedUntil = new Date(Date.now() + seconds * 1000);
    }

    await this.db
      .update(users)
      .set({ failedLoginAttempts: attempts, lockedUntil })
      .where(eq(users.id, userId));

    await recordAuditSafe(this.db, {
      actorUserId: userId,
      action: lockedUntil ? AuditAction.USER_ACCOUNT_LOCKED : AuditAction.USER_LOGIN_FAILED,
      entityType: 'user',
      entityId: userId,
      metadata: { attempts, lockedUntil: lockedUntil?.toISOString() ?? null },
      ipAddress: meta.ipAddress,
    });
  }

  // -------------------------------------------------------------------------
  // Refresh com rotação e detecção de reuso
  // -------------------------------------------------------------------------

  /**
   * Cada refresh consome o token apresentado e emite um novo.
   *
   * Se um token já consumido reaparecer, assumimos que foi roubado: quem tem
   * o token legítimo é quem o usou primeiro, então revogamos a sessão inteira
   * e obrigamos um novo login. Falso positivo é possível (dois clientes
   * atualizando ao mesmo tempo), mas o custo é um login extra, enquanto
   * ignorar o sinal deixaria um atacante com acesso persistente.
   */
  async refresh(presentedToken: string, meta: RequestMeta): Promise<AuthSuccess> {
    const tokenHash = hashToken(presentedToken);

    // A revogação por reuso precisa ser confirmada no banco, e lançar o erro
    // de dentro da transação faria rollback justamente dela. Por isso o caso
    // de reuso volta como resultado e o erro é lançado depois do commit.
    const outcome = await this.db.transaction(
      async (tx): Promise<{ reuse: true } | { reuse: false; value: AuthSuccess }> => {
        const rows = await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, tokenHash))
          .limit(1)
          .for('update');

        const stored = rows[0];
        if (!stored) {
          throw unauthorized(ErrorCode.AUTH_TOKEN_INVALID, 'Refresh token inválido.');
        }

        if (stored.usedAt) {
          const owner = await tx
            .select({ userId: sessions.userId })
            .from(sessions)
            .where(eq(sessions.id, stored.sessionId))
            .limit(1);

          await tx
            .update(sessions)
            .set({ revokedAt: new Date(), revokedReason: 'token_reuse_detected' })
            .where(and(eq(sessions.id, stored.sessionId), isNull(sessions.revokedAt)));

          await recordAudit(tx, {
            actorUserId: owner[0]?.userId ?? null,
            action: AuditAction.USER_TOKEN_REUSE_DETECTED,
            entityType: 'session',
            entityId: stored.sessionId,
            ipAddress: meta.ipAddress,
          });

          return { reuse: true };
        }

        if (stored.expiresAt.getTime() <= Date.now()) {
          throw unauthorized(ErrorCode.AUTH_TOKEN_EXPIRED, 'Refresh token expirado.');
        }

        const sessionRows = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, stored.sessionId))
          .limit(1);

        const session = sessionRows[0];
        if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
          throw unauthorized(
            ErrorCode.AUTH_SESSION_REVOKED,
            'Sessão encerrada. Faça login novamente.',
          );
        }

        const userRows = await tx.select().from(users).where(eq(users.id, session.userId)).limit(1);
        const user = userRows[0];
        if (!user || user.deletedAt || user.status !== 'active') {
          throw unauthorized(ErrorCode.AUTH_SESSION_REVOKED, 'Conta indisponível.');
        }

        const newToken = generateToken();
        const inserted = await tx
          .insert(refreshTokens)
          .values({
            sessionId: session.id,
            tokenHash: hashToken(newToken),
            expiresAt: session.expiresAt,
          })
          .returning();

        const newRow = inserted[0];
        if (!newRow) throw new Error('Falha ao rotacionar refresh token');

        await tx
          .update(refreshTokens)
          .set({ usedAt: new Date(), replacedBy: newRow.id })
          .where(eq(refreshTokens.id, stored.id));

        await tx
          .update(sessions)
          .set({ lastUsedAt: new Date() })
          .where(eq(sessions.id, session.id));

        if (session.deviceId) {
          await tx
            .update(devices)
            .set({ lastSeenAt: new Date() })
            .where(eq(devices.id, session.deviceId));
        }

        const access = await this.services.tokens.signAccessToken({
          sub: user.id,
          sid: session.id,
          ver: user.permissionVersion,
          ...(session.deviceId ? { did: session.deviceId } : {}),
        });

        return {
          reuse: false,
          value: {
            accessToken: access.token,
            expiresIn: access.expiresIn,
            refreshToken: newToken,
            refreshExpiresAt: session.expiresAt.toISOString(),
            sessionId: session.id,
            deviceId: session.deviceId,
            user: this.publicUser(user),
          },
        };
      },
    );

    if (outcome.reuse) {
      throw unauthorized(
        ErrorCode.AUTH_TOKEN_REUSE_DETECTED,
        'Este token já foi utilizado. Por segurança, a sessão foi encerrada.',
      );
    }

    return outcome.value;
  }

  // -------------------------------------------------------------------------
  // Logout
  // -------------------------------------------------------------------------

  async logout(sessionId: string, userId: string, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'logout' })
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)));

      await recordAudit(tx, {
        actorUserId: userId,
        action: AuditAction.USER_LOGGED_OUT,
        entityType: 'session',
        entityId: sessionId,
        ipAddress: meta.ipAddress,
      });
    });
  }

  async logoutAll(
    userId: string,
    options: { exceptSessionId?: string; reason?: string } = {},
    meta: RequestMeta = { ipAddress: null, userAgent: null },
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      const revoked = await revokeUserSessions(tx, userId, {
        ...(options.exceptSessionId ? { exceptSessionId: options.exceptSessionId } : {}),
        reason: options.reason ?? 'logout_all',
      });

      await recordAudit(tx, {
        actorUserId: userId,
        action: AuditAction.USER_LOGGED_OUT_ALL,
        entityType: 'user',
        entityId: userId,
        metadata: { revokedSessions: revoked },
        ipAddress: meta.ipAddress,
      });

      return revoked;
    });
  }

  async revokeSession(sessionId: string, userId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: 'logout' })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }

  // -------------------------------------------------------------------------
  // Senha
  // -------------------------------------------------------------------------

  /**
   * Sempre responde sucesso, exista ou não a conta. Revelar que um e-mail não
   * está cadastrado transformaria este endpoint num verificador de contas.
   */
  async requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
    const found = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)))
      .limit(1);

    const user = found[0];
    if (!user) return;

    const token = generateToken();
    const expiresAt = addMinutes(new Date(), this.env.PASSWORD_RESET_TTL_MINUTES);

    await this.db.transaction(async (tx) => {
      // Invalida pedidos anteriores: só o link mais recente funciona.
      await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));

      await tx.insert(passwordResetTokens).values({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt,
        requestedIp: meta.ipAddress,
      });

      await recordAudit(tx, {
        actorUserId: user.id,
        action: AuditAction.USER_PASSWORD_RESET_REQUESTED,
        entityType: 'user',
        entityId: user.id,
        ipAddress: meta.ipAddress,
      });
    });

    await this.services.mailer.send({
      to: user.email,
      kind: 'password_reset',
      subject: 'Redefinição de senha - Estoque Simples',
      text:
        `Olá, ${user.name}.\n\n` +
        `Use o código abaixo para redefinir sua senha. Ele vale por ${this.env.PASSWORD_RESET_TTL_MINUTES} minutos e só pode ser usado uma vez.\n\n` +
        `${token}\n\n` +
        'Se você não pediu isso, ignore este e-mail: sua senha continua a mesma.',
    });
  }

  async resetPassword(token: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const tokenHash = hashToken(token);

    const policyUser = await this.db
      .select({ email: users.email })
      .from(passwordResetTokens)
      .innerJoin(users, eq(users.id, passwordResetTokens.userId))
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .limit(1);

    const policy = checkPasswordPolicy(newPassword, policyUser[0]?.email);
    if (!policy.valid) {
      throw new AppError(400, ErrorCode.AUTH_WEAK_PASSWORD, 'Senha não atende à política.', {
        details: policy.problems.map((message) => ({ field: 'newPassword', message })),
      });
    }

    const passwordHash = await hashPassword(newPassword);

    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.tokenHash, tokenHash))
        .limit(1)
        .for('update');

      const stored = rows[0];
      if (!stored || stored.usedAt || stored.expiresAt.getTime() <= Date.now()) {
        throw badRequest(ErrorCode.AUTH_TOKEN_INVALID, 'Link de redefinição inválido ou expirado.');
      }

      await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokens.id, stored.id));

      // Incrementar permission_version invalida todo access token já emitido.
      await tx
        .update(users)
        .set({
          passwordHash,
          permissionVersion: sql`${users.permissionVersion} + 1`,
          failedLoginAttempts: 0,
          lockedUntil: null,
        })
        .where(eq(users.id, stored.userId));

      await revokeUserSessions(tx, stored.userId, { reason: 'password_changed' });

      await recordAudit(tx, {
        actorUserId: stored.userId,
        action: AuditAction.USER_PASSWORD_RESET_COMPLETED,
        entityType: 'user',
        entityId: stored.userId,
        ipAddress: meta.ipAddress,
      });
    });
  }

  async changePassword(
    userId: string,
    currentSessionId: string,
    input: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean },
    meta: RequestMeta,
  ): Promise<void> {
    const found = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = found[0];
    if (!user) throw unauthorized(ErrorCode.AUTH_REQUIRED, 'Sessão inválida.');

    const ok = await verifyPassword(user.passwordHash, input.currentPassword);
    if (!ok) {
      throw unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Senha atual incorreta.');
    }

    const policy = checkPasswordPolicy(input.newPassword, user.email);
    if (!policy.valid) {
      throw new AppError(400, ErrorCode.AUTH_WEAK_PASSWORD, 'Senha não atende à política.', {
        details: policy.problems.map((message) => ({ field: 'newPassword', message })),
      });
    }

    const passwordHash = await hashPassword(input.newPassword);

    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));

      if (input.revokeOtherSessions) {
        await revokeUserSessions(tx, userId, {
          exceptSessionId: currentSessionId,
          reason: 'password_changed',
        });
      }

      await recordAudit(tx, {
        actorUserId: userId,
        action: AuditAction.USER_PASSWORD_CHANGED,
        entityType: 'user',
        entityId: userId,
        metadata: { revokedOtherSessions: input.revokeOtherSessions },
        ipAddress: meta.ipAddress,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Verificação de e-mail
  // -------------------------------------------------------------------------

  private async sendEmailVerification(tx: Transaction, userId: string, email: string): Promise<void> {
    const token = generateToken();
    await tx.insert(emailVerificationTokens).values({
      userId,
      email,
      tokenHash: hashToken(token),
      expiresAt: addHours(new Date(), this.env.EMAIL_VERIFICATION_TTL_HOURS),
    });

    await this.services.mailer.send({
      to: email,
      kind: 'email_verification',
      subject: 'Confirme seu e-mail - Estoque Simples',
      text:
        'Use o código abaixo para confirmar seu e-mail:\n\n' +
        `${token}\n\n` +
        `O código vale por ${this.env.EMAIL_VERIFICATION_TTL_HOURS} horas.`,
    });
  }

  async resendEmailVerification(userId: string): Promise<void> {
    const found = await this.db
      .select({ id: users.id, email: users.email, verifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = found[0];
    if (!user || user.verifiedAt) return;

    await this.db.transaction(async (tx) => {
      await tx
        .update(emailVerificationTokens)
        .set({ usedAt: new Date() })
        .where(
          and(eq(emailVerificationTokens.userId, user.id), isNull(emailVerificationTokens.usedAt)),
        );
      await this.sendEmailVerification(tx, user.id, user.email);
    });
  }

  async verifyEmail(token: string, meta: RequestMeta): Promise<void> {
    const tokenHash = hashToken(token);

    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(emailVerificationTokens)
        .where(eq(emailVerificationTokens.tokenHash, tokenHash))
        .limit(1)
        .for('update');

      const stored = rows[0];
      if (!stored || stored.usedAt || stored.expiresAt.getTime() <= Date.now()) {
        throw badRequest(ErrorCode.AUTH_TOKEN_INVALID, 'Código de verificação inválido ou expirado.');
      }

      await tx
        .update(emailVerificationTokens)
        .set({ usedAt: new Date() })
        .where(eq(emailVerificationTokens.id, stored.id));

      await tx
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, stored.userId));

      await recordAudit(tx, {
        actorUserId: stored.userId,
        action: AuditAction.USER_EMAIL_VERIFIED,
        entityType: 'user',
        entityId: stored.userId,
        ipAddress: meta.ipAddress,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Auxiliares
  // -------------------------------------------------------------------------

  private async upsertDevice(
    tx: Transaction,
    userId: string,
    device: DeviceInfo,
  ): Promise<string> {
    const values = {
      userId,
      installId: device.installId,
      platform: device.platform,
      model: device.model ?? null,
      osVersion: device.osVersion ?? null,
      appVersionCode: device.appVersionCode ?? null,
      appVersionName: device.appVersionName ?? null,
      syncProtocolVersion: device.syncProtocolVersion ?? null,
      lastSeenAt: new Date(),
      revokedAt: null,
    };

    const result = await tx
      .insert(devices)
      .values(values)
      .onConflictDoUpdate({
        target: [devices.userId, devices.installId],
        set: {
          model: values.model,
          osVersion: values.osVersion,
          appVersionCode: values.appVersionCode,
          appVersionName: values.appVersionName,
          syncProtocolVersion: values.syncProtocolVersion,
          lastSeenAt: values.lastSeenAt,
          revokedAt: null,
        },
      })
      .returning({ id: devices.id });

    const id = result[0]?.id;
    if (!id) throw new Error('Falha ao registrar dispositivo');
    return id;
  }

  private async issueSession(tx: Transaction, input: IssueSessionInput) {
    const expiresAt = addDays(new Date(), this.env.REFRESH_TOKEN_TTL_DAYS);

    const sessionRows = await tx
      .insert(sessions)
      .values({
        userId: input.userId,
        deviceId: input.deviceId,
        userAgent: input.meta.userAgent,
        ipAddress: input.meta.ipAddress,
        expiresAt,
      })
      .returning();

    const session = sessionRows[0];
    if (!session) throw new Error('Falha ao criar sessão');

    const refreshToken = generateToken();
    await tx.insert(refreshTokens).values({
      sessionId: session.id,
      tokenHash: hashToken(refreshToken),
      expiresAt,
    });

    return { session, refreshToken, expiresAt };
  }

  private async buildAuthSuccess(
    user: typeof users.$inferSelect,
    issued: Awaited<ReturnType<AuthService['issueSession']>>,
    deviceId: string | null,
  ): Promise<AuthSuccess> {
    const access = await this.services.tokens.signAccessToken({
      sub: user.id,
      sid: issued.session.id,
      ver: user.permissionVersion,
      ...(deviceId ? { did: deviceId } : {}),
    });

    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: issued.refreshToken,
      refreshExpiresAt: issued.expiresAt.toISOString(),
      sessionId: issued.session.id,
      deviceId,
      user: this.publicUser(user),
    };
  }

  private publicUser(user: typeof users.$inferSelect) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerifiedAt !== null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}

/**
 * Revoga sessões de um usuário. Exposta fora da classe porque outros módulos
 * precisam dela: remover um membro, mudar o papel dele ou excluir a conta
 * devem derrubar as sessões na mesma transação da mudança.
 */
export async function revokeUserSessions(
  tx: Transaction,
  userId: string,
  options: { exceptSessionId?: string; reason: string },
): Promise<number> {
  const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
  if (options.exceptSessionId) {
    conditions.push(ne(sessions.id, options.exceptSessionId));
  }

  const revoked = await tx
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: options.reason })
    .where(and(...conditions))
    .returning({ id: sessions.id });

  return revoked.length;
}

/**
 * Invalida os access tokens já emitidos para um usuário, sem encerrar as
 * sessões: o cliente usa o refresh token e recebe um novo access token com as
 * permissões atualizadas. É o caminho usado quando o papel de um membro muda.
 */
export async function bumpPermissionVersion(tx: Transaction, userId: string): Promise<void> {
  await tx
    .update(users)
    .set({ permissionVersion: sql`${users.permissionVersion} + 1` })
    .where(eq(users.id, userId));
}
