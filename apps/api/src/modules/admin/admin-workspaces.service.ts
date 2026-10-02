import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';

import {
  invites,
  subscriptions,
  users,
  workspaceMembers,
  workspaces,
} from '../../platform/db/schema/index.js';
import type { Transaction } from '../../platform/db/client.js';
import type { AppServices } from '../../platform/http/context.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../platform/http/errors.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { ENTITLED_STATES, LIVE_STATES } from '../billing/billing.service.js';
import { bumpPermissionVersion, revokeUserSessions } from '../auth/auth.service.js';
import { OWNER_ROLE } from '../workspaces/workspaces.service.js';
import { AdminAction, recordAdminAudit, type AdminActor } from './admin-audit.service.js';
import { sqlList } from './admin-series.js';
import { iso, offsetOf, type Paginated, type PaginationQuery } from './admin.schemas.js';

export interface WorkspaceListFilters extends PaginationQuery {
  q?: string;
  subscription?: 'entitled' | 'none' | 'problem';
  deleted?: boolean;
  sort?: 'createdAt' | 'name' | 'lastSyncAt' | 'products';
  order?: 'asc' | 'desc';
}

export interface WorkspaceListItem {
  id: string;
  name: string;
  ownerId: string;
  ownerEmail: string;
  ownerName: string;
  membersCount: number;
  productsCount: number;
  subscriptionState: string | null;
  /** `google_play` (app) ou `asaas` (web) da assinatura viva. */
  subscriptionProvider: string | null;
  planKey: string | null;
  seededAt: string | null;
  lastSyncAt: string | null;
  createdAt: string;
  deletedAt: string | null;
}

const SORT_COLUMNS: Record<NonNullable<WorkspaceListFilters['sort']>, string> = {
  createdAt: 'w.created_at',
  name: 'lower(w.name)',
  lastSyncAt: 'last_sync_at',
  products: 'products_count',
};

/**
 * Suporte a empresas (workspaces).
 *
 * As alterações de membros repetem as invariantes do serviço usado pelo app
 * (o proprietário só muda por transferência; mudar papel invalida tokens;
 * remover derruba sessões) mas rodam no contexto de sistema, porque o
 * administrador não é membro de empresa nenhuma. Além do `admin_audit_log`,
 * cada mudança grava o mesmo evento em `audit_log` que o app gravaria, com
 * `origem: 'suporte'`, para que a auditoria da empresa continue completa.
 */
export class AdminWorkspacesService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  async list(filters: WorkspaceListFilters): Promise<Paginated<WorkspaceListItem>> {
    const conditions = [filters.deleted ? sql`w.deleted_at IS NOT NULL` : sql`w.deleted_at IS NULL`];
    if (filters.q) {
      const term = `%${filters.q.toLowerCase()}%`;
      const maybeUuid = /^[0-9a-f-]{36}$/i.test(filters.q);
      conditions.push(
        maybeUuid
          ? sql`(w.id = ${filters.q}::uuid OR lower(w.name) LIKE ${term} OR lower(o.email) LIKE ${term})`
          : sql`(lower(w.name) LIKE ${term} OR lower(o.email) LIKE ${term} OR lower(o.name) LIKE ${term})`,
      );
    }
    if (filters.subscription === 'entitled') {
      conditions.push(sql`s.state IN ${sqlList(ENTITLED_STATES)}`);
    } else if (filters.subscription === 'none') {
      conditions.push(sql`s.id IS NULL`);
    } else if (filters.subscription === 'problem') {
      conditions.push(sql`s.state IN ('pendente','suspensa')`);
    }

    const where = sql.join(conditions, sql` AND `);
    const sortColumn = SORT_COLUMNS[filters.sort ?? 'createdAt'];
    const order = filters.order === 'asc' ? sql`ASC NULLS FIRST` : sql`DESC NULLS LAST`;

    const base = sql`
      FROM workspaces w
      JOIN users o ON o.id = w.owner_user_id
      LEFT JOIN subscriptions s ON s.workspace_id = w.id AND s.state IN ${sqlList(LIVE_STATES)}
      WHERE ${where}
    `;

    const [rows, total] = await Promise.all([
      this.db.execute<{
        id: string; name: string; owner_id: string; owner_email: string; owner_name: string;
        members_count: number; products_count: number; sub_state: string | null; sub_provider: string | null; plan_key: string | null;
        seeded_at: string | null; last_sync_at: string | null; created_at: string; deleted_at: string | null;
      }>(sql`
        SELECT w.id, w.name, o.id AS owner_id, o.email AS owner_email, o.name AS owner_name,
               (SELECT count(*)::int FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.status = 'active') AS members_count,
               (SELECT count(*)::int FROM products p WHERE p.workspace_id = w.id AND p.deleted_at IS NULL) AS products_count,
               s.state AS sub_state, s.provider AS sub_provider, s.plan_key,
               w.seeded_at,
               (SELECT max(c.updated_at) FROM sync_cursors c WHERE c.workspace_id = w.id) AS last_sync_at,
               w.created_at, w.deleted_at
        ${base}
        ORDER BY ${sql.raw(sortColumn)} ${order}, w.id
        LIMIT ${filters.pageSize} OFFSET ${offsetOf(filters)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total ${base}`),
    ]);

    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        name: row.name,
        ownerId: row.owner_id,
        ownerEmail: row.owner_email,
        ownerName: row.owner_name,
        membersCount: row.members_count,
        productsCount: row.products_count,
        subscriptionState: row.sub_state,
        subscriptionProvider: row.sub_provider,
        planKey: row.plan_key,
        seededAt: row.seeded_at ? new Date(row.seeded_at).toISOString() : null,
        lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
      })),
      page: filters.page,
      pageSize: filters.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  async get(workspaceId: string) {
    const rows = await this.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    const workspace = rows[0];
    if (!workspace) throw notFound('Empresa não encontrada.');

    const [owner, members, pendingInvites, subs, counts, cursors, uploads] = await Promise.all([
      this.db
        .select({ id: users.id, email: users.email, name: users.name, status: users.status })
        .from(users)
        .where(eq(users.id, workspace.ownerUserId))
        .limit(1),
      this.db
        .select({
          id: workspaceMembers.id,
          userId: workspaceMembers.userId,
          email: users.email,
          name: users.name,
          userStatus: users.status,
          role: workspaceMembers.roleKey,
          status: workspaceMembers.status,
          joinedAt: workspaceMembers.joinedAt,
          removedAt: workspaceMembers.removedAt,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, workspaceId))
        .orderBy(workspaceMembers.joinedAt),
      this.db
        .select()
        .from(invites)
        .where(and(eq(invites.workspaceId, workspaceId), isNull(invites.acceptedAt), isNull(invites.cancelledAt)))
        .orderBy(desc(invites.createdAt)),
      this.db
        .select({
          id: subscriptions.id,
          planKey: subscriptions.planKey,
          provider: subscriptions.provider,
          billingCycle: subscriptions.billingCycle,
          billingType: subscriptions.billingType,
          priceCents: subscriptions.priceCents,
          nextDueDate: subscriptions.nextDueDate,
          state: subscriptions.state,
          autoRenewing: subscriptions.autoRenewing,
          acknowledged: subscriptions.acknowledged,
          startedAt: subscriptions.startedAt,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          graceUntil: subscriptions.graceUntil,
          canceledAt: subscriptions.canceledAt,
          lastVerifiedAt: subscriptions.lastVerifiedAt,
          purchaserUserId: subscriptions.purchaserUserId,
          purchaserEmail: users.email,
          productId: subscriptions.googleProductId,
          basePlanId: subscriptions.googleBasePlanId,
          createdAt: subscriptions.createdAt,
        })
        .from(subscriptions)
        .leftJoin(users, eq(users.id, subscriptions.purchaserUserId))
        .where(eq(subscriptions.workspaceId, workspaceId))
        .orderBy(desc(subscriptions.createdAt))
        .limit(20),
      this.db.execute<{
        products: number; products_deleted: number; movements: number; movements_30d: number;
        conflicts_pending: number; conflicts_total: number; sync_ops_7d: number; low_stock: number;
      }>(sql`
        SELECT
          (SELECT count(*)::int FROM products WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL) AS products,
          (SELECT count(*)::int FROM products WHERE workspace_id = ${workspaceId} AND deleted_at IS NOT NULL) AS products_deleted,
          (SELECT count(*)::int FROM stock_movements WHERE workspace_id = ${workspaceId}) AS movements,
          (SELECT count(*)::int FROM stock_movements WHERE workspace_id = ${workspaceId} AND recorded_at > now() - interval '30 days') AS movements_30d,
          (SELECT count(*)::int FROM conflict_log WHERE workspace_id = ${workspaceId} AND status = 'pendente') AS conflicts_pending,
          (SELECT count(*)::int FROM conflict_log WHERE workspace_id = ${workspaceId}) AS conflicts_total,
          (SELECT count(*)::int FROM sync_operations WHERE workspace_id = ${workspaceId} AND created_at > now() - interval '7 days') AS sync_ops_7d,
          (SELECT count(*)::int FROM products WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL AND quantity_cache <= min_stock) AS low_stock
      `),
      this.db.execute<{
        device_id: string; user_id: string | null; user_email: string | null; model: string | null; platform: string | null;
        app_version_name: string | null; cursor: string; last_push_at: string | null; last_pull_at: string | null; updated_at: string;
      }>(sql`
        SELECT c.device_id, c.user_id, u.email AS user_email, d.model, d.platform, d.app_version_name,
               c.cursor::text, c.last_push_at, c.last_pull_at, c.updated_at
        FROM sync_cursors c
        LEFT JOIN devices d ON d.id = c.device_id
        LEFT JOIN users u ON u.id = c.user_id
        WHERE c.workspace_id = ${workspaceId}
        ORDER BY c.updated_at DESC
      `),
      this.db.execute<{
        id: string; status: string; declared_products: number; declared_movements: number;
        received_products: number; received_movements: number; created_at: string; completed_at: string | null;
      }>(sql`
        SELECT id, status, declared_products, declared_movements, received_products, received_movements, created_at, completed_at
        FROM initial_uploads WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC LIMIT 5
      `),
    ]);

    const c = counts.rows[0];
    return {
      id: workspace.id,
      name: workspace.name,
      settings: workspace.settings as Record<string, unknown>,
      changeSeq: Number(workspace.changeSeq),
      tombstoneHorizonSeq: Number(workspace.tombstoneHorizonSeq),
      seededAt: iso(workspace.seededAt),
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
      deletedAt: iso(workspace.deletedAt),
      owner: owner[0] ?? null,
      members: members.map((row) => ({
        id: row.id,
        userId: row.userId,
        email: row.email,
        name: row.name,
        userStatus: row.userStatus,
        role: row.role,
        status: row.status,
        joinedAt: row.joinedAt.toISOString(),
        removedAt: iso(row.removedAt),
      })),
      pendingInvites: pendingInvites.map((row) => ({
        id: row.id,
        email: row.email,
        roleKey: row.roleKey,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        expired: row.expiresAt.getTime() <= Date.now(),
      })),
      subscriptions: subs.map((row) => ({
        id: row.id,
        planKey: row.planKey,
        provider: row.provider,
        billingCycle: row.billingCycle,
        billingType: row.billingType,
        priceCents: row.priceCents,
        nextDueDate: row.nextDueDate,
        state: row.state,
        autoRenewing: row.autoRenewing,
        acknowledged: row.acknowledged,
        startedAt: iso(row.startedAt),
        currentPeriodEnd: iso(row.currentPeriodEnd),
        graceUntil: iso(row.graceUntil),
        canceledAt: iso(row.canceledAt),
        lastVerifiedAt: row.lastVerifiedAt.toISOString(),
        purchaserUserId: row.purchaserUserId,
        purchaserEmail: row.purchaserEmail,
        productId: row.productId,
        basePlanId: row.basePlanId,
        createdAt: row.createdAt.toISOString(),
      })),
      counts: {
        products: c?.products ?? 0,
        productsDeleted: c?.products_deleted ?? 0,
        movements: c?.movements ?? 0,
        movements30d: c?.movements_30d ?? 0,
        conflictsPending: c?.conflicts_pending ?? 0,
        conflictsTotal: c?.conflicts_total ?? 0,
        syncOps7d: c?.sync_ops_7d ?? 0,
        lowStock: c?.low_stock ?? 0,
      },
      syncDevices: cursors.rows.map((row) => ({
        deviceId: row.device_id,
        userId: row.user_id,
        userEmail: row.user_email,
        model: row.model,
        platform: row.platform,
        appVersionName: row.app_version_name,
        cursor: Number(row.cursor),
        lag: Math.max(0, Number(workspace.changeSeq) - Number(row.cursor)),
        lastPushAt: row.last_push_at ? new Date(row.last_push_at).toISOString() : null,
        lastPullAt: row.last_pull_at ? new Date(row.last_pull_at).toISOString() : null,
        updatedAt: new Date(row.updated_at).toISOString(),
      })),
      initialUploads: uploads.rows.map((row) => ({
        id: row.id,
        status: row.status,
        declaredProducts: row.declared_products,
        declaredMovements: row.declared_movements,
        receivedProducts: row.received_products,
        receivedMovements: row.received_movements,
        createdAt: new Date(row.created_at).toISOString(),
        completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Estoque (somente leitura, para diagnóstico)
  // -------------------------------------------------------------------------

  async products(workspaceId: string, query: PaginationQuery & { q?: string; includeDeleted?: boolean }) {
    const conditions = [sql`p.workspace_id = ${workspaceId}`];
    if (!query.includeDeleted) conditions.push(sql`p.deleted_at IS NULL`);
    if (query.q) {
      const term = `%${query.q.toLowerCase()}%`;
      conditions.push(sql`(lower(p.name) LIKE ${term} OR lower(coalesce(p.sku,'')) LIKE ${term} OR lower(coalesce(p.barcode,'')) LIKE ${term})`);
    }
    const where = sql.join(conditions, sql` AND `);

    const [rows, total] = await Promise.all([
      this.db.execute<{
        id: string; name: string; quantity: string; min_stock: string; unit: string | null; category: string | null;
        sku: string | null; barcode: string | null; unit_value: string; rev: number; change_seq: string;
        updated_at: string; deleted_at: string | null;
      }>(sql`
        SELECT p.id, p.name, p.quantity_cache::text AS quantity, p.min_stock::text, p.unit, p.category, p.sku, p.barcode,
               p.unit_value::text, p.rev, p.change_seq::text, p.updated_at, p.deleted_at
        FROM products p WHERE ${where}
        ORDER BY lower(p.name) LIMIT ${query.pageSize} OFFSET ${offsetOf(query)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM products p WHERE ${where}`),
    ]);

    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        name: row.name,
        quantity: Number(row.quantity),
        minStock: Number(row.min_stock),
        unit: row.unit,
        category: row.category,
        sku: row.sku,
        barcode: row.barcode,
        unitValue: Number(row.unit_value),
        rev: row.rev,
        changeSeq: Number(row.change_seq),
        updatedAt: new Date(row.updated_at).toISOString(),
        deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  async movements(workspaceId: string, query: PaginationQuery & { productId?: string }) {
    const conditions = [sql`m.workspace_id = ${workspaceId}`];
    if (query.productId) conditions.push(sql`m.product_id = ${query.productId}`);
    const where = sql.join(conditions, sql` AND `);

    const [rows, total] = await Promise.all([
      this.db.execute<{
        id: string; product_id: string | null; product_name: string | null; type: string; quantity: string;
        note: string | null; occurred_at: string; recorded_at: string; created_by_email: string | null;
        device_model: string | null; reverses_movement_id: string | null;
      }>(sql`
        SELECT m.id, m.product_id, coalesce(p.name, m.product_name) AS product_name, m.type, m.quantity::text,
               m.note, m.occurred_at, m.recorded_at, u.email AS created_by_email, d.model AS device_model,
               m.reverses_movement_id
        FROM stock_movements m
        LEFT JOIN products p ON p.id = m.product_id AND p.workspace_id = m.workspace_id
        LEFT JOIN users u ON u.id = m.created_by
        LEFT JOIN devices d ON d.id = m.device_id
        WHERE ${where}
        ORDER BY m.recorded_at DESC LIMIT ${query.pageSize} OFFSET ${offsetOf(query)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM stock_movements m WHERE ${where}`),
    ]);

    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        productId: row.product_id,
        productName: row.product_name,
        type: row.type,
        quantity: Number(row.quantity),
        note: row.note,
        occurredAt: new Date(row.occurred_at).toISOString(),
        recordedAt: new Date(row.recorded_at).toISOString(),
        createdByEmail: row.created_by_email,
        deviceModel: row.device_model,
        reversesMovementId: row.reverses_movement_id,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  async conflicts(workspaceId: string, query: PaginationQuery & { status?: string }) {
    const conditions = [sql`c.workspace_id = ${workspaceId}`];
    if (query.status) conditions.push(sql`c.status = ${query.status}`);
    const where = sql.join(conditions, sql` AND `);

    const [rows, total] = await Promise.all([
      this.db.execute<{
        id: string; entity_type: string; entity_id: string; field: string | null; kind: string; status: string;
        base_value: unknown; kept_value: unknown; discarded_value: unknown; created_at: string; resolved_at: string | null;
        resolution: string | null; created_by_email: string | null; product_name: string | null;
      }>(sql`
        SELECT c.id, c.entity_type, c.entity_id, c.field, c.kind, c.status, c.base_value, c.kept_value, c.discarded_value,
               c.created_at, c.resolved_at, c.resolution, u.email AS created_by_email, p.name AS product_name
        FROM conflict_log c
        LEFT JOIN users u ON u.id = c.created_by
        LEFT JOIN products p ON p.id = c.entity_id AND p.workspace_id = c.workspace_id
        WHERE ${where}
        ORDER BY c.created_at DESC LIMIT ${query.pageSize} OFFSET ${offsetOf(query)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM conflict_log c WHERE ${where}`),
    ]);

    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        field: row.field,
        kind: row.kind,
        status: row.status,
        baseValue: row.base_value ?? null,
        keptValue: row.kept_value ?? null,
        discardedValue: row.discarded_value ?? null,
        createdAt: new Date(row.created_at).toISOString(),
        resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
        resolution: row.resolution,
        createdByEmail: row.created_by_email,
        productName: row.product_name,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  async timeline(workspaceId: string, query: PaginationQuery) {
    const rowsQuery = this.db.execute<{
      source: 'user' | 'admin'; id: string; action: string; at: string; actor: string | null;
      entity_type: string | null; entity_id: string | null; metadata: Record<string, unknown>; ip: string | null;
    }>(sql`
      SELECT * FROM (
        SELECT 'user'::text AS source, a.id::text, a.action, a.created_at AS at, u.email AS actor,
               a.entity_type, a.entity_id, a.metadata, host(a.ip_address) AS ip
        FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.workspace_id = ${workspaceId}
        UNION ALL
        SELECT 'admin'::text, l.id::text, l.action, l.created_at, l.admin_email,
               l.target_type, l.target_id, l.metadata, host(l.ip_address)
        FROM admin_audit_log l
        WHERE l.target_type = 'workspace' AND l.target_id = ${workspaceId}
      ) t
      ORDER BY at DESC
      LIMIT ${query.pageSize} OFFSET ${offsetOf(query)}
    `);
    const totalQuery = this.db.execute<{ total: number }>(sql`
      SELECT (
        (SELECT count(*) FROM audit_log WHERE workspace_id = ${workspaceId})
        + (SELECT count(*) FROM admin_audit_log WHERE target_type = 'workspace' AND target_id = ${workspaceId})
      )::int AS total
    `);
    const [rows, total] = await Promise.all([rowsQuery, totalQuery]);
    return {
      items: rows.rows.map((row) => ({
        source: row.source,
        id: row.id,
        action: row.action,
        at: new Date(row.at).toISOString(),
        actor: row.actor,
        workspaceId,
        workspaceName: null,
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

  // -------------------------------------------------------------------------
  // Ações
  // -------------------------------------------------------------------------

  async rename(actor: AdminActor, workspaceId: string, name: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const workspace = await this.lock(tx, workspaceId);
      if (workspace.name === name) throw badRequest(ErrorCode.VALIDATION_FAILED, 'O nome é o mesmo.');
      await tx.update(workspaces).set({ name }).where(eq(workspaces.id, workspaceId));
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.WORKSPACE_UPDATED,
        targetType: 'workspace',
        targetId: workspaceId,
        metadata: { changes: { name: { from: workspace.name, to: name } }, reason },
      });
      await recordAudit(tx, {
        workspaceId,
        action: AuditAction.WORKSPACE_UPDATED,
        entityType: 'workspace',
        entityId: workspaceId,
        metadata: { fields: ['name'], origem: 'suporte' },
      });
    });
  }

  /**
   * Exclusão lógica. Os dados continuam no banco (o app não tem caminho de
   * exclusão; este é o único) e podem ser restaurados. Membros perdem o
   * acesso na hora: as sessões são derrubadas e a versão de permissão sobe.
   */
  async softDelete(actor: AdminActor, workspaceId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const workspace = await this.lock(tx, workspaceId);
      if (workspace.deletedAt) throw conflict(ErrorCode.CONFLICT, 'A empresa já está excluída.');

      await tx.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, workspaceId));

      const members = await tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), ne(workspaceMembers.status, 'removed')));
      for (const member of members) {
        await bumpPermissionVersion(tx, member.userId);
      }

      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.WORKSPACE_DELETED,
        targetType: 'workspace',
        targetId: workspaceId,
        metadata: { reason, name: workspace.name, members: members.length },
      });
      await recordAudit(tx, {
        workspaceId,
        action: AuditAction.WORKSPACE_DELETED,
        entityType: 'workspace',
        entityId: workspaceId,
        metadata: { origem: 'suporte', reason },
      });
    });
  }

  async restore(actor: AdminActor, workspaceId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const workspace = await this.lock(tx, workspaceId);
      if (!workspace.deletedAt) throw conflict(ErrorCode.CONFLICT, 'A empresa não está excluída.');

      // O nome pode ter sido reutilizado pelo dono enquanto esta estava excluída.
      const clash = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.ownerUserId, workspace.ownerUserId),
            sql`lower(${workspaces.name}) = ${workspace.name.toLowerCase()}`,
            isNull(workspaces.deletedAt),
          ),
        )
        .limit(1);
      if (clash.length > 0) {
        throw conflict(ErrorCode.DUPLICATE_NAME, 'O dono já tem outra empresa com este nome. Renomeie antes de restaurar.');
      }

      await tx.update(workspaces).set({ deletedAt: null }).where(eq(workspaces.id, workspaceId));
      const members = await tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), ne(workspaceMembers.status, 'removed')));
      for (const member of members) {
        await bumpPermissionVersion(tx, member.userId);
      }

      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.WORKSPACE_RESTORED,
        targetType: 'workspace',
        targetId: workspaceId,
        metadata: { reason, deletedAt: iso(workspace.deletedAt) },
      });
    });
  }

  async transferOwnership(actor: AdminActor, workspaceId: string, newOwnerUserId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const workspace = await this.lock(tx, workspaceId);
      if (workspace.ownerUserId === newOwnerUserId) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'Esta pessoa já é a proprietária.');
      }
      const target = await this.findMember(tx, workspaceId, newOwnerUserId);
      if (target.status !== 'active') {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'O novo proprietário precisa ser um membro ativo.');
      }

      await tx.update(workspaces).set({ ownerUserId: newOwnerUserId }).where(eq(workspaces.id, workspaceId));
      await tx.update(workspaceMembers).set({ roleKey: OWNER_ROLE }).where(eq(workspaceMembers.id, target.id));
      await tx
        .update(workspaceMembers)
        .set({ roleKey: 'administrador' })
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, workspace.ownerUserId)));
      await bumpPermissionVersion(tx, newOwnerUserId);
      await bumpPermissionVersion(tx, workspace.ownerUserId);

      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.WORKSPACE_OWNERSHIP_TRANSFERRED,
        targetType: 'workspace',
        targetId: workspaceId,
        metadata: { from: workspace.ownerUserId, to: newOwnerUserId, reason },
      });
      await recordAudit(tx, {
        workspaceId,
        action: AuditAction.WORKSPACE_OWNERSHIP_TRANSFERRED,
        entityType: 'workspace',
        entityId: workspaceId,
        metadata: { from: workspace.ownerUserId, to: newOwnerUserId, origem: 'suporte' },
      });
    });
  }

  async changeMemberRole(actor: AdminActor, workspaceId: string, userId: string, roleKey: string, reason: string): Promise<void> {
    if (roleKey === OWNER_ROLE) {
      throw badRequest(ErrorCode.FORBIDDEN, 'Use a transferência de propriedade para definir um novo proprietário.');
    }
    await this.db.transaction(async (tx) => {
      await this.lock(tx, workspaceId);
      const target = await this.findMember(tx, workspaceId, userId);
      if (target.roleKey === OWNER_ROLE) {
        throw conflict(ErrorCode.LAST_OWNER, 'O proprietário só muda de papel por transferência.');
      }
      const validRole = await tx.execute<{ key: string }>(sql`SELECT key FROM roles WHERE key = ${roleKey}`);
      if (validRole.rows.length === 0) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Papel inválido.');

      await tx.update(workspaceMembers).set({ roleKey }).where(eq(workspaceMembers.id, target.id));
      await bumpPermissionVersion(tx, userId);

      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.WORKSPACE_MEMBER_ROLE_CHANGED,
        targetType: 'workspace',
        targetId: workspaceId,
        metadata: { targetUserId: userId, from: target.roleKey, to: roleKey, reason },
      });
      await recordAudit(tx, {
        workspaceId,
        action: AuditAction.MEMBER_ROLE_CHANGED,
        entityType: 'workspace_member',
        entityId: target.id,
        metadata: { targetUserId: userId, from: target.roleKey, to: roleKey, origem: 'suporte' },
      });
    });
  }

  async setMemberStatus(actor: AdminActor, workspaceId: string, userId: string, status: 'active' | 'suspended', reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, workspaceId);
      const target = await this.findMember(tx, workspaceId, userId);
      if (target.roleKey === OWNER_ROLE) throw conflict(ErrorCode.LAST_OWNER, 'O proprietário não pode ser suspenso.');
      if (target.status === status) throw conflict(ErrorCode.CONFLICT, 'O membro já está nesta situação.');

      await tx.update(workspaceMembers).set({ status }).where(eq(workspaceMembers.id, target.id));
      await bumpPermissionVersion(tx, userId);
      if (status === 'suspended') await revokeUserSessions(tx, userId, { reason: 'permission_changed' });

      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.WORKSPACE_MEMBER_STATUS_CHANGED,
        targetType: 'workspace',
        targetId: workspaceId,
        metadata: { targetUserId: userId, from: target.status, to: status, reason },
      });
      await recordAudit(tx, {
        workspaceId,
        action: status === 'suspended' ? AuditAction.MEMBER_SUSPENDED : AuditAction.MEMBER_REACTIVATED,
        entityType: 'workspace_member',
        entityId: target.id,
        metadata: { targetUserId: userId, origem: 'suporte' },
      });
    });
  }

  async removeMember(actor: AdminActor, workspaceId: string, userId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, workspaceId);
      const target = await this.findMember(tx, workspaceId, userId);
      if (target.roleKey === OWNER_ROLE) {
        throw conflict(ErrorCode.LAST_OWNER, 'O proprietário não pode ser removido. Transfira a propriedade antes.');
      }
      await tx
        .update(workspaceMembers)
        .set({ status: 'removed', removedAt: new Date() })
        .where(eq(workspaceMembers.id, target.id));
      await bumpPermissionVersion(tx, userId);
      await revokeUserSessions(tx, userId, { reason: 'member_removed' });

      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.WORKSPACE_MEMBER_REMOVED,
        targetType: 'workspace',
        targetId: workspaceId,
        metadata: { targetUserId: userId, role: target.roleKey, reason },
      });
      await recordAudit(tx, {
        workspaceId,
        action: AuditAction.MEMBER_REMOVED,
        entityType: 'workspace_member',
        entityId: target.id,
        metadata: { targetUserId: userId, role: target.roleKey, origem: 'suporte' },
      });
    });
  }

  async cancelInvite(actor: AdminActor, workspaceId: string, inviteId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(invites)
        .set({ cancelledAt: new Date() })
        .where(and(eq(invites.id, inviteId), eq(invites.workspaceId, workspaceId), isNull(invites.acceptedAt), isNull(invites.cancelledAt)))
        .returning({ id: invites.id, email: invites.email });
      const invite = updated[0];
      if (!invite) throw notFound('Convite não encontrado ou já encerrado.');

      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.WORKSPACE_INVITE_CANCELLED,
        targetType: 'workspace',
        targetId: workspaceId,
        metadata: { inviteId, reason },
      });
      await recordAudit(tx, {
        workspaceId,
        action: AuditAction.INVITE_CANCELLED,
        entityType: 'invite',
        entityId: inviteId,
        metadata: { origem: 'suporte' },
      });
    });
  }

  private async lock(tx: Transaction, workspaceId: string) {
    const rows = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1).for('update');
    const workspace = rows[0];
    if (!workspace) throw notFound('Empresa não encontrada.');
    return workspace;
  }

  private async findMember(tx: Transaction, workspaceId: string, userId: string) {
    const rows = await tx
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1);
    const member = rows[0];
    if (!member || member.status === 'removed') throw notFound('Membro não encontrado nesta empresa.');
    return member;
  }
}
