import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import {
  adminAccountNotes,
  devices,
  sessions,
  subscriptions,
  users,
  workspaces,
} from '../../platform/db/schema/index.js';
import type { Transaction } from '../../platform/db/client.js';
import type { AppServices } from '../../platform/http/context.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../platform/http/errors.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { AuthService, bumpPermissionVersion, revokeUserSessions } from '../auth/auth.service.js';
import { AdminAction, recordAdminAudit, type AdminActor } from './admin-audit.service.js';
import { iso, offsetOf, type Paginated, type PaginationQuery } from './admin.schemas.js';

export interface UserListFilters extends PaginationQuery {
  q?: string;
  status?: 'active' | 'suspended' | 'pending_deletion';
  emailVerified?: boolean;
  sort?: 'createdAt' | 'lastActivityAt' | 'name' | 'email';
  order?: 'asc' | 'desc';
}

export interface UserListItem {
  id: string;
  email: string;
  name: string;
  status: string;
  emailVerified: boolean;
  createdAt: string;
  lastActivityAt: string | null;
  workspacesCount: number;
  hasActiveSubscription: boolean;
  lockedUntil: string | null;
}

export interface UserDetail {
  id: string;
  email: string;
  name: string;
  status: string;
  emailVerified: boolean;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletionRequestedAt: string | null;
  lockedUntil: string | null;
  failedLoginAttempts: number;
  permissionVersion: number;
  lastActivityAt: string | null;
  workspaces: Array<{
    id: string;
    name: string;
    role: string;
    memberStatus: string;
    isOwner: boolean;
    joinedAt: string;
    subscriptionState: string | null;
    planKey: string | null;
    deletedAt: string | null;
  }>;
  devices: Array<{
    id: string;
    installId: string;
    platform: string;
    model: string | null;
    osVersion: string | null;
    appVersionName: string | null;
    appVersionCode: number | null;
    lastSeenAt: string;
    createdAt: string;
    revokedAt: string | null;
  }>;
  sessions: Array<{
    id: string;
    deviceId: string | null;
    deviceModel: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: string;
    lastUsedAt: string;
    expiresAt: string;
  }>;
  purchasedSubscriptions: Array<{
    id: string;
    workspaceId: string;
    workspaceName: string;
    planKey: string;
    state: string;
    startedAt: string | null;
    currentPeriodEnd: string | null;
  }>;
  counts: { auditEvents30d: number; analyticsEvents30d: number; loginFailures7d: number };
}

const SORT_COLUMNS: Record<NonNullable<UserListFilters['sort']>, string> = {
  createdAt: 'u.created_at',
  lastActivityAt: 'last_activity_at',
  name: 'lower(u.name)',
  email: 'lower(u.email)',
};

/**
 * Operações de suporte sobre contas.
 *
 * Tudo aqui roda no contexto de sistema (papel dono, sem workspace) porque o
 * administrador não é membro de empresa nenhuma. Cada mudança grava duas
 * trilhas: `admin_audit_log` (quem do nosso lado fez) e, quando afeta a
 * sessão ou o acesso do cliente, `audit_log` (para aparecer na linha do
 * tempo da conta que o próprio cliente poderia ver).
 */
export class AdminUsersService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  async list(filters: UserListFilters): Promise<Paginated<UserListItem>> {
    const conditions = [sql`u.deleted_at IS NULL`];
    if (filters.q) {
      const term = `%${filters.q.toLowerCase()}%`;
      const maybeUuid = /^[0-9a-f-]{36}$/i.test(filters.q);
      conditions.push(
        maybeUuid
          ? sql`(u.id = ${filters.q}::uuid OR lower(u.email) LIKE ${term} OR lower(u.name) LIKE ${term})`
          : sql`(lower(u.email) LIKE ${term} OR lower(u.name) LIKE ${term})`,
      );
    }
    if (filters.status) conditions.push(sql`u.status = ${filters.status}`);
    if (filters.emailVerified === true) conditions.push(sql`u.email_verified_at IS NOT NULL`);
    if (filters.emailVerified === false) conditions.push(sql`u.email_verified_at IS NULL`);

    const where = sql.join(conditions, sql` AND `);
    const sortColumn = SORT_COLUMNS[filters.sort ?? 'createdAt'];
    const order = filters.order === 'asc' ? sql`ASC NULLS FIRST` : sql`DESC NULLS LAST`;

    const [rows, total] = await Promise.all([
      this.db.execute<{
        id: string;
        email: string;
        name: string;
        status: string;
        email_verified_at: string | null;
        created_at: string;
        last_activity_at: string | null;
        workspaces_count: number;
        has_subscription: boolean;
        locked_until: string | null;
      }>(sql`
        SELECT u.id, u.email, u.name, u.status, u.email_verified_at, u.created_at, u.locked_until,
               (SELECT max(s.last_used_at) FROM sessions s WHERE s.user_id = u.id) AS last_activity_at,
               (SELECT count(*)::int FROM workspace_members wm
                  WHERE wm.user_id = u.id AND wm.status <> 'removed') AS workspaces_count,
               EXISTS (
                 SELECT 1 FROM workspace_members wm
                 JOIN subscriptions sub ON sub.workspace_id = wm.workspace_id
                 WHERE wm.user_id = u.id AND wm.status = 'active'
                   AND sub.state IN ('ativa','carencia','cancelada_mas_ativa')
               ) AS has_subscription
        FROM users u
        WHERE ${where}
        ORDER BY ${sql.raw(sortColumn)} ${order}, u.id
        LIMIT ${filters.pageSize} OFFSET ${offsetOf(filters)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM users u WHERE ${where}`),
    ]);

    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        status: row.status,
        emailVerified: row.email_verified_at !== null,
        createdAt: new Date(row.created_at).toISOString(),
        lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
        workspacesCount: row.workspaces_count,
        hasActiveSubscription: row.has_subscription,
        lockedUntil: row.locked_until ? new Date(row.locked_until).toISOString() : null,
      })),
      page: filters.page,
      pageSize: filters.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  async get(userId: string): Promise<UserDetail> {
    const rows = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user || user.deletedAt) throw notFound('Usuário não encontrado.');

    const [memberships, deviceRows, sessionRows, purchased, counts, activity] = await Promise.all([
      this.db.execute<{
        id: string; name: string; role: string; member_status: string; owner_user_id: string;
        joined_at: string; deleted_at: string | null; sub_state: string | null; plan_key: string | null;
      }>(sql`
        SELECT w.id, w.name, wm.role_key AS role, wm.status AS member_status, w.owner_user_id,
               wm.joined_at, w.deleted_at,
               s.state AS sub_state, s.plan_key
        FROM workspace_members wm
        JOIN workspaces w ON w.id = wm.workspace_id
        LEFT JOIN subscriptions s ON s.workspace_id = w.id
          AND s.state IN ('pendente','ativa','carencia','suspensa','cancelada_mas_ativa')
        WHERE wm.user_id = ${userId}
        ORDER BY wm.joined_at
      `),
      this.db.select().from(devices).where(eq(devices.userId, userId)).orderBy(desc(devices.lastSeenAt)),
      this.db
        .select({
          id: sessions.id,
          deviceId: sessions.deviceId,
          deviceModel: devices.model,
          ipAddress: sessions.ipAddress,
          userAgent: sessions.userAgent,
          createdAt: sessions.createdAt,
          lastUsedAt: sessions.lastUsedAt,
          expiresAt: sessions.expiresAt,
        })
        .from(sessions)
        .leftJoin(devices, eq(devices.id, sessions.deviceId))
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), sql`${sessions.expiresAt} > now()`))
        .orderBy(desc(sessions.lastUsedAt)),
      this.db
        .select({
          id: subscriptions.id,
          workspaceId: subscriptions.workspaceId,
          workspaceName: workspaces.name,
          planKey: subscriptions.planKey,
          state: subscriptions.state,
          startedAt: subscriptions.startedAt,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
        })
        .from(subscriptions)
        .innerJoin(workspaces, eq(workspaces.id, subscriptions.workspaceId))
        .where(eq(subscriptions.purchaserUserId, userId))
        .orderBy(desc(subscriptions.createdAt)),
      this.db.execute<{ audit: number; events: number; failures: number }>(sql`
        SELECT
          (SELECT count(*)::int FROM audit_log WHERE actor_user_id = ${userId} AND created_at > now() - interval '30 days') AS audit,
          (SELECT count(*)::int FROM analytics_events WHERE user_id = ${userId} AND occurred_at > now() - interval '30 days') AS events,
          (SELECT count(*)::int FROM audit_log WHERE actor_user_id = ${userId}
             AND action IN ('user.login_failed','user.account_locked') AND created_at > now() - interval '7 days') AS failures
      `),
      this.db.execute<{ last: string | null }>(sql`
        SELECT greatest(
          (SELECT max(last_used_at) FROM sessions WHERE user_id = ${userId}),
          (SELECT max(occurred_at) FROM analytics_events WHERE user_id = ${userId})
        ) AS last
      `),
    ]);

    const c = counts.rows[0];
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      emailVerified: user.emailVerifiedAt !== null,
      emailVerifiedAt: iso(user.emailVerifiedAt),
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      deletionRequestedAt: iso(user.deletionRequestedAt),
      lockedUntil: iso(user.lockedUntil),
      failedLoginAttempts: user.failedLoginAttempts,
      permissionVersion: user.permissionVersion,
      lastActivityAt: activity.rows[0]?.last ? new Date(activity.rows[0].last).toISOString() : null,
      workspaces: memberships.rows.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        memberStatus: row.member_status,
        isOwner: row.owner_user_id === userId,
        joinedAt: new Date(row.joined_at).toISOString(),
        subscriptionState: row.sub_state,
        planKey: row.plan_key,
        deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
      })),
      devices: deviceRows.map((row) => ({
        id: row.id,
        installId: row.installId,
        platform: row.platform,
        model: row.model,
        osVersion: row.osVersion,
        appVersionName: row.appVersionName,
        appVersionCode: row.appVersionCode,
        lastSeenAt: row.lastSeenAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        revokedAt: iso(row.revokedAt),
      })),
      sessions: sessionRows.map((row) => ({
        id: row.id,
        deviceId: row.deviceId,
        deviceModel: row.deviceModel,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
      purchasedSubscriptions: purchased.map((row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        planKey: row.planKey,
        state: row.state,
        startedAt: iso(row.startedAt),
        currentPeriodEnd: iso(row.currentPeriodEnd),
      })),
      counts: {
        auditEvents30d: c?.audit ?? 0,
        analyticsEvents30d: c?.events ?? 0,
        loginFailures7d: c?.failures ?? 0,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Ações
  // -------------------------------------------------------------------------

  async update(
    actor: AdminActor,
    userId: string,
    input: { name?: string; email?: string; reason: string },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const user = await this.lock(tx, userId);
      const patch: Partial<typeof users.$inferInsert> = {};
      const changes: Record<string, { from: unknown; to: unknown }> = {};

      if (input.name !== undefined && input.name !== user.name) {
        patch.name = input.name;
        changes['name'] = { from: user.name, to: input.name };
      }
      if (input.email !== undefined && input.email !== user.email) {
        const taken = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(sql`lower(${users.email}) = ${input.email}`, isNull(users.deletedAt)))
          .limit(1);
        if (taken.length > 0) {
          throw conflict(ErrorCode.AUTH_EMAIL_IN_USE, 'Já existe uma conta com este e-mail.');
        }
        patch.email = input.email;
        // Trocar o endereço invalida a confirmação anterior: o novo e-mail
        // não foi provado. O administrador pode confirmar em seguida, de
        // forma explícita e auditada, se tiver verificado por outro canal.
        patch.emailVerifiedAt = null;
        changes['email'] = { from: user.email, to: input.email };
      }
      if (Object.keys(patch).length === 0) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'Nada para alterar.');
      }

      await tx.update(users).set(patch).where(eq(users.id, userId));
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.USER_UPDATED,
        targetType: 'user',
        targetId: userId,
        metadata: { changes, reason: input.reason },
      });
    });
  }

  async suspend(actor: AdminActor, userId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const user = await this.lock(tx, userId);
      if (user.status === 'suspended') {
        throw conflict(ErrorCode.CONFLICT, 'A conta já está suspensa.');
      }
      await tx.update(users).set({ status: 'suspended' }).where(eq(users.id, userId));
      await bumpPermissionVersion(tx, userId);
      const revoked = await revokeUserSessions(tx, userId, { reason: 'permission_changed' });

      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.USER_SUSPENDED,
        targetType: 'user',
        targetId: userId,
        metadata: { reason, revokedSessions: revoked, previousStatus: user.status },
      });
      await recordAudit(tx, {
        action: AuditAction.USER_LOGGED_OUT_ALL,
        entityType: 'user',
        entityId: userId,
        metadata: { revokedSessions: revoked, motivo: 'conta_suspensa_pelo_suporte' },
      });
    });
  }

  async reactivate(actor: AdminActor, userId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const user = await this.lock(tx, userId);
      if (user.status !== 'suspended') {
        throw conflict(ErrorCode.CONFLICT, 'A conta não está suspensa.');
      }
      await tx
        .update(users)
        .set({ status: 'active', failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, userId));
      await bumpPermissionVersion(tx, userId);
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.USER_REACTIVATED,
        targetType: 'user',
        targetId: userId,
        metadata: { reason },
      });
    });
  }

  /** Limpa o bloqueio por tentativas de login. */
  async unlock(actor: AdminActor, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const user = await this.lock(tx, userId);
      await tx
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, userId));
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.USER_UNLOCKED,
        targetType: 'user',
        targetId: userId,
        metadata: { lockedUntil: iso(user.lockedUntil), attempts: user.failedLoginAttempts },
      });
    });
  }

  async verifyEmail(actor: AdminActor, userId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const user = await this.lock(tx, userId);
      if (user.emailVerifiedAt) throw conflict(ErrorCode.CONFLICT, 'O e-mail já está confirmado.');
      await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.USER_EMAIL_VERIFIED,
        targetType: 'user',
        targetId: userId,
        metadata: { reason, email: user.email },
      });
      await recordAudit(tx, {
        actorUserId: userId,
        action: AuditAction.USER_EMAIL_VERIFIED,
        entityType: 'user',
        entityId: userId,
        metadata: { origem: 'suporte' },
      });
    });
  }

  async revokeSessions(actor: AdminActor, userId: string, reason: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, userId);
      const revoked = await revokeUserSessions(tx, userId, { reason: 'logout_all' });
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.USER_SESSIONS_REVOKED,
        targetType: 'user',
        targetId: userId,
        metadata: { reason, revokedSessions: revoked },
      });
      await recordAudit(tx, {
        action: AuditAction.USER_LOGGED_OUT_ALL,
        entityType: 'user',
        entityId: userId,
        metadata: { revokedSessions: revoked, motivo: 'suporte' },
      });
      return revoked;
    });
  }

  async revokeDevice(actor: AdminActor, userId: string, deviceId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, userId);
      const revoked = await tx
        .update(devices)
        .set({ revokedAt: new Date() })
        .where(and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)))
        .returning({ id: devices.id });
      if (revoked.length === 0) throw notFound('Dispositivo não encontrado ou já revogado.');

      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'device_revoked' })
        .where(and(eq(sessions.deviceId, deviceId), eq(sessions.userId, userId), isNull(sessions.revokedAt)));

      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.USER_DEVICE_REVOKED,
        targetType: 'user',
        targetId: userId,
        metadata: { deviceId, reason },
      });
      await recordAudit(tx, {
        action: AuditAction.DEVICE_REVOKED,
        entityType: 'device',
        entityId: deviceId,
        metadata: { userId, origem: 'suporte' },
      });
    });
  }

  /** Dispara o mesmo fluxo de "esqueci a senha" que o cliente usaria. */
  async sendPasswordReset(actor: AdminActor, userId: string): Promise<void> {
    const rows = await this.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user) throw notFound('Usuário não encontrado.');

    const auth = new AuthService(this.services);
    await auth.requestPasswordReset(user.email, { ipAddress: actor.ipAddress, userAgent: 'painel-admin' });
    await recordAdminAudit(this.db, {
      actor,
      action: AdminAction.USER_PASSWORD_RESET_SENT,
      targetType: 'user',
      targetId: userId,
    });
  }

  async cancelDeletion(actor: AdminActor, userId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const user = await this.lock(tx, userId);
      if (user.status !== 'pending_deletion') {
        throw conflict(ErrorCode.CONFLICT, 'A conta não está com exclusão pendente.');
      }
      await tx
        .update(users)
        .set({ status: 'active', deletionRequestedAt: null })
        .where(eq(users.id, userId));
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.USER_DELETION_CANCELLED,
        targetType: 'user',
        targetId: userId,
        metadata: { reason, requestedAt: iso(user.deletionRequestedAt) },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Notas de suporte
  // -------------------------------------------------------------------------

  async listNotes(target: { userId?: string; workspaceId?: string }) {
    const rows = await this.db
      .select()
      .from(adminAccountNotes)
      .where(
        target.userId
          ? eq(adminAccountNotes.userId, target.userId)
          : eq(adminAccountNotes.workspaceId, target.workspaceId ?? ''),
      )
      .orderBy(desc(adminAccountNotes.createdAt))
      .limit(200);
    return rows.map((row) => ({
      id: row.id,
      adminEmail: row.adminEmail,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async addNote(actor: AdminActor, target: { userId?: string; workspaceId?: string }, body: string) {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(adminAccountNotes)
        .values({
          userId: target.userId ?? null,
          workspaceId: target.workspaceId ?? null,
          adminId: actor.adminId,
          adminEmail: actor.email,
          body,
        })
        .returning();
      const note = inserted[0];
      if (!note) throw new Error('Falha ao criar nota');
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.NOTE_CREATED,
        targetType: target.userId ? 'user' : 'workspace',
        targetId: target.userId ?? target.workspaceId ?? null,
        metadata: { noteId: note.id },
      });
      return { id: note.id, adminEmail: note.adminEmail, body: note.body, createdAt: note.createdAt.toISOString() };
    });
  }

  async deleteNote(actor: AdminActor, noteId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(adminAccountNotes)
        .where(eq(adminAccountNotes.id, noteId))
        .returning({ id: adminAccountNotes.id, userId: adminAccountNotes.userId, workspaceId: adminAccountNotes.workspaceId });
      const note = deleted[0];
      if (!note) throw notFound('Nota não encontrada.');
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.NOTE_DELETED,
        targetType: note.userId ? 'user' : 'workspace',
        targetId: note.userId ?? note.workspaceId ?? null,
        metadata: { noteId },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Linha do tempo: auditoria do cliente + ações do suporte sobre ele
  // -------------------------------------------------------------------------

  async timeline(userId: string, query: PaginationQuery) {
    const rows = await this.db.execute<{
      source: 'user' | 'admin';
      id: string;
      action: string;
      at: string;
      actor: string | null;
      workspace_id: string | null;
      workspace_name: string | null;
      entity_type: string | null;
      entity_id: string | null;
      metadata: Record<string, unknown>;
      ip: string | null;
    }>(sql`
      SELECT * FROM (
        SELECT 'user'::text AS source, a.id::text, a.action, a.created_at AS at,
               NULL::text AS actor, a.workspace_id, w.name AS workspace_name,
               a.entity_type, a.entity_id, a.metadata, host(a.ip_address) AS ip
        FROM audit_log a LEFT JOIN workspaces w ON w.id = a.workspace_id
        WHERE a.actor_user_id = ${userId}
           OR (a.entity_type = 'user' AND a.entity_id = ${userId})
           OR (a.entity_type = 'workspace_member' AND a.metadata->>'targetUserId' = ${userId})
        UNION ALL
        SELECT 'admin'::text, l.id::text, l.action, l.created_at, l.admin_email,
               NULL::uuid, NULL::text, l.target_type, l.target_id, l.metadata, host(l.ip_address)
        FROM admin_audit_log l
        WHERE l.target_type = 'user' AND l.target_id = ${userId}
      ) t
      ORDER BY at DESC
      LIMIT ${query.pageSize} OFFSET ${offsetOf(query)}
    `);

    const total = await this.db.execute<{ total: number }>(sql`
      SELECT (
        (SELECT count(*) FROM audit_log a
          WHERE a.actor_user_id = ${userId}
             OR (a.entity_type = 'user' AND a.entity_id = ${userId})
             OR (a.entity_type = 'workspace_member' AND a.metadata->>'targetUserId' = ${userId}))
        + (SELECT count(*) FROM admin_audit_log l WHERE l.target_type = 'user' AND l.target_id = ${userId})
      )::int AS total
    `);

    return {
      items: rows.rows.map((row) => ({
        source: row.source,
        id: row.id,
        action: row.action,
        at: new Date(row.at).toISOString(),
        actor: row.actor,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        entityType: row.entity_type,
        entityId: row.entity_id,
        metadata: row.metadata ?? {},
        ip: row.ip,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  async events(userId: string, query: PaginationQuery) {
    const [rows, total] = await Promise.all([
      this.db.execute<{
        id: string; name: string; occurred_at: string; workspace_id: string | null; workspace_name: string | null;
        platform: string; app_version_code: number | null; source: string; properties: Record<string, unknown>; session_key: string | null;
      }>(sql`
        SELECT e.id::text, e.name, e.occurred_at, e.workspace_id, w.name AS workspace_name,
               e.platform, e.app_version_code, e.source, e.properties, e.session_key
        FROM analytics_events e LEFT JOIN workspaces w ON w.id = e.workspace_id
        WHERE e.user_id = ${userId}
        ORDER BY e.occurred_at DESC
        LIMIT ${query.pageSize} OFFSET ${offsetOf(query)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM analytics_events WHERE user_id = ${userId}`),
    ]);
    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        name: row.name,
        occurredAt: new Date(row.occurred_at).toISOString(),
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        platform: row.platform,
        appVersionCode: row.app_version_code,
        source: row.source,
        properties: row.properties ?? {},
        sessionKey: row.session_key,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  private async lock(tx: Transaction, userId: string) {
    const rows = await tx.select().from(users).where(eq(users.id, userId)).limit(1).for('update');
    const user = rows[0];
    if (!user || user.deletedAt) throw notFound('Usuário não encontrado.');
    return user;
  }
}
