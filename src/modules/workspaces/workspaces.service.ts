import { and, desc, eq, ne, sql } from 'drizzle-orm';

import { withTenant, type Transaction } from '../../platform/db/client.js';
import {
  users,
  workspaceMembers,
  workspaces,
} from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../platform/http/errors.js';
import { getRoleRanks } from '../../platform/http/authorize.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { bumpPermissionVersion, revokeUserSessions } from '../auth/auth.service.js';
import type { RequestMeta } from '../auth/auth.service.js';

export const OWNER_ROLE = 'proprietario';

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: string;
  isOwner: boolean;
  memberCount: number;
  createdAt: string;
}

export class WorkspaceService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  /**
   * Cria a empresa e registra quem criou como proprietário, na mesma
   * transação. Uma empresa sem dono seria um estado impossível de administrar.
   */
  async create(
    userId: string,
    input: { name: string },
    meta: RequestMeta,
  ): Promise<{ id: string; name: string; createdAt: string }> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(workspaces)
        .values({ name: input.name, ownerUserId: userId })
        .returning();

      const workspace = inserted[0];
      if (!workspace) throw new Error('Falha ao criar empresa');

      await tx.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId,
        roleKey: OWNER_ROLE,
        status: 'active',
      });

      await recordAudit(tx, {
        workspaceId: workspace.id,
        actorUserId: userId,
        action: AuditAction.WORKSPACE_CREATED,
        entityType: 'workspace',
        entityId: workspace.id,
        metadata: { name: workspace.name },
        ipAddress: meta.ipAddress,
      });

      return {
        id: workspace.id,
        name: workspace.name,
        createdAt: workspace.createdAt.toISOString(),
      };
    });
  }

  /** Empresas das quais o usuário participa. Atravessa tenants por natureza. */
  async listForUser(userId: string): Promise<WorkspaceSummary[]> {
    const rows = await this.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        role: workspaceMembers.roleKey,
        ownerUserId: workspaces.ownerUserId,
        createdAt: workspaces.createdAt,
        memberCount: sql<number>`(
          SELECT count(*)::int FROM workspace_members wm
          WHERE wm.workspace_id = ${workspaces.id} AND wm.status = 'active'
        )`,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          ne(workspaceMembers.status, 'removed'),
          sql`${workspaces.deletedAt} IS NULL`,
        ),
      )
      .orderBy(desc(workspaces.createdAt));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      isOwner: row.ownerUserId === userId,
      memberCount: row.memberCount,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async get(workspaceId: string): Promise<{
    id: string;
    name: string;
    settings: Record<string, unknown>;
    ownerUserId: string;
    createdAt: string;
  }> {
    const rows = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    const workspace = rows[0];
    if (!workspace || workspace.deletedAt) throw notFound('Empresa não encontrada.');

    return {
      id: workspace.id,
      name: workspace.name,
      settings: workspace.settings as Record<string, unknown>,
      ownerUserId: workspace.ownerUserId,
      createdAt: workspace.createdAt.toISOString(),
    };
  }

  async update(
    workspaceId: string,
    userId: string,
    input: { name?: string; settings?: Record<string, unknown> },
    meta: RequestMeta,
  ): Promise<void> {
    await withTenant(this.db, { workspaceId, userId }, async (tx) => {
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch['name'] = input.name;
      if (input.settings !== undefined) patch['settings'] = input.settings;
      if (Object.keys(patch).length === 0) return;

      await tx.update(workspaces).set(patch).where(eq(workspaces.id, workspaceId));

      await recordAudit(tx, {
        workspaceId,
        actorUserId: userId,
        action: AuditAction.WORKSPACE_UPDATED,
        entityType: 'workspace',
        entityId: workspaceId,
        metadata: { fields: Object.keys(patch) },
        ipAddress: meta.ipAddress,
      });
    });
  }

  async listMembers(workspaceId: string, userId: string) {
    return withTenant(this.db, { workspaceId, userId }, async (tx) => {
      const rows = await tx
        .select({
          id: workspaceMembers.id,
          userId: workspaceMembers.userId,
          name: users.name,
          email: users.email,
          role: workspaceMembers.roleKey,
          status: workspaceMembers.status,
          joinedAt: workspaceMembers.joinedAt,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), ne(workspaceMembers.status, 'removed')),
        )
        .orderBy(workspaceMembers.joinedAt);

      return rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        name: row.name,
        email: row.email,
        role: row.role,
        status: row.status,
        joinedAt: row.joinedAt.toISOString(),
      }));
    });
  }

  /**
   * Altera o papel de um membro.
   *
   * Duas regras estruturais: ninguém promove alguém a um papel igual ou
   * superior ao seu (senão um administrador se tornaria proprietário sozinho),
   * e o papel de proprietário só muda por transferência explícita.
   */
  async changeMemberRole(
    workspaceId: string,
    actor: { userId: string; roleKey: string },
    targetUserId: string,
    newRoleKey: string,
    meta: RequestMeta,
  ): Promise<void> {
    if (newRoleKey === OWNER_ROLE) {
      throw badRequest(
        ErrorCode.FORBIDDEN,
        'Use a transferência de propriedade para definir um novo proprietário.',
      );
    }

    const ranks = await getRoleRanks(this.services);
    const actorRank = ranks.get(actor.roleKey) ?? 0;
    const newRank = ranks.get(newRoleKey);
    if (newRank === undefined) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Papel inválido.');

    if (newRank >= actorRank) {
      throw forbidden(
        ErrorCode.MISSING_PERMISSION,
        'Você não pode conceder um papel igual ou superior ao seu.',
      );
    }

    await withTenant(this.db, { workspaceId, userId: actor.userId }, async (tx) => {
      const target = await this.findMember(tx, workspaceId, targetUserId);

      if (target.roleKey === OWNER_ROLE) {
        throw forbidden(
          ErrorCode.LAST_OWNER,
          'O proprietário só muda de papel por transferência de propriedade.',
        );
      }

      const targetRank = ranks.get(target.roleKey) ?? 0;
      if (targetRank >= actorRank) {
        throw forbidden(
          ErrorCode.MISSING_PERMISSION,
          'Você não pode alterar um membro de papel igual ou superior ao seu.',
        );
      }

      await tx
        .update(workspaceMembers)
        .set({ roleKey: newRoleKey })
        .where(eq(workspaceMembers.id, target.id));

      // O access token carrega a versão de permissão. Incrementá-la faz o
      // token atual ser recusado e força o cliente a buscar um novo, já com o
      // papel atualizado — sem isso, a mudança só valeria após 15 minutos.
      await bumpPermissionVersion(tx, targetUserId);

      await recordAudit(tx, {
        workspaceId,
        actorUserId: actor.userId,
        action: AuditAction.MEMBER_ROLE_CHANGED,
        entityType: 'workspace_member',
        entityId: target.id,
        metadata: { targetUserId, from: target.roleKey, to: newRoleKey },
        ipAddress: meta.ipAddress,
      });
    });
  }

  /**
   * Remove um membro e derruba as sessões dele imediatamente.
   *
   * Manter as sessões vivas deixaria o removido sincronizando por até 15
   * minutos, que é justamente o cenário "usuário removido enquanto offline"
   * que o plano exige tratar.
   */
  async removeMember(
    workspaceId: string,
    actor: { userId: string; roleKey: string },
    targetUserId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const ranks = await getRoleRanks(this.services);
    const actorRank = ranks.get(actor.roleKey) ?? 0;

    await withTenant(this.db, { workspaceId, userId: actor.userId }, async (tx) => {
      const target = await this.findMember(tx, workspaceId, targetUserId);

      if (target.roleKey === OWNER_ROLE) {
        throw forbidden(
          ErrorCode.LAST_OWNER,
          'O proprietário não pode ser removido. Transfira a propriedade antes.',
        );
      }

      const targetRank = ranks.get(target.roleKey) ?? 0;
      if (targetUserId !== actor.userId && targetRank >= actorRank) {
        throw forbidden(
          ErrorCode.MISSING_PERMISSION,
          'Você não pode remover um membro de papel igual ou superior ao seu.',
        );
      }

      await tx
        .update(workspaceMembers)
        .set({ status: 'removed', removedAt: new Date() })
        .where(eq(workspaceMembers.id, target.id));

      await bumpPermissionVersion(tx, targetUserId);
      await revokeUserSessions(tx, targetUserId, { reason: 'member_removed' });

      await recordAudit(tx, {
        workspaceId,
        actorUserId: actor.userId,
        action: AuditAction.MEMBER_REMOVED,
        entityType: 'workspace_member',
        entityId: target.id,
        metadata: { targetUserId, role: target.roleKey },
        ipAddress: meta.ipAddress,
      });
    });
  }

  async setMemberStatus(
    workspaceId: string,
    actor: { userId: string; roleKey: string },
    targetUserId: string,
    status: 'active' | 'suspended',
    meta: RequestMeta,
  ): Promise<void> {
    const ranks = await getRoleRanks(this.services);
    const actorRank = ranks.get(actor.roleKey) ?? 0;

    await withTenant(this.db, { workspaceId, userId: actor.userId }, async (tx) => {
      const target = await this.findMember(tx, workspaceId, targetUserId);

      if (target.roleKey === OWNER_ROLE) {
        throw forbidden(ErrorCode.LAST_OWNER, 'O proprietário não pode ser suspenso.');
      }
      if ((ranks.get(target.roleKey) ?? 0) >= actorRank) {
        throw forbidden(
          ErrorCode.MISSING_PERMISSION,
          'Você não pode alterar um membro de papel igual ou superior ao seu.',
        );
      }

      await tx
        .update(workspaceMembers)
        .set({ status })
        .where(eq(workspaceMembers.id, target.id));

      await bumpPermissionVersion(tx, targetUserId);
      if (status === 'suspended') {
        await revokeUserSessions(tx, targetUserId, { reason: 'permission_changed' });
      }

      await recordAudit(tx, {
        workspaceId,
        actorUserId: actor.userId,
        action:
          status === 'suspended' ? AuditAction.MEMBER_SUSPENDED : AuditAction.MEMBER_REACTIVATED,
        entityType: 'workspace_member',
        entityId: target.id,
        metadata: { targetUserId },
        ipAddress: meta.ipAddress,
      });
    });
  }

  /**
   * Transfere a propriedade. O antigo dono vira administrador em vez de perder
   * o acesso: rebaixar alguém a nada durante uma transferência seria uma forma
   * fácil de se trancar para fora da própria empresa.
   */
  async transferOwnership(
    workspaceId: string,
    currentOwnerId: string,
    newOwnerUserId: string,
    meta: RequestMeta,
  ): Promise<void> {
    if (currentOwnerId === newOwnerUserId) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'O novo proprietário deve ser outro membro.');
    }

    await withTenant(this.db, { workspaceId, userId: currentOwnerId }, async (tx) => {
      const target = await this.findMember(tx, workspaceId, newOwnerUserId);
      if (target.status !== 'active') {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'O novo proprietário precisa estar ativo.');
      }

      await tx
        .update(workspaces)
        .set({ ownerUserId: newOwnerUserId })
        .where(eq(workspaces.id, workspaceId));

      await tx
        .update(workspaceMembers)
        .set({ roleKey: OWNER_ROLE })
        .where(eq(workspaceMembers.id, target.id));

      await tx
        .update(workspaceMembers)
        .set({ roleKey: 'administrador' })
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, currentOwnerId),
          ),
        );

      await bumpPermissionVersion(tx, newOwnerUserId);
      await bumpPermissionVersion(tx, currentOwnerId);

      await recordAudit(tx, {
        workspaceId,
        actorUserId: currentOwnerId,
        action: AuditAction.WORKSPACE_OWNERSHIP_TRANSFERRED,
        entityType: 'workspace',
        entityId: workspaceId,
        metadata: { from: currentOwnerId, to: newOwnerUserId },
        ipAddress: meta.ipAddress,
      });
    });
  }

  private async findMember(tx: Transaction, workspaceId: string, targetUserId: string) {
    const rows = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .limit(1);

    const member = rows[0];
    if (!member || member.status === 'removed') {
      throw notFound('Membro não encontrado nesta empresa.');
    }
    return member;
  }

  /** Impede criar uma segunda empresa com o mesmo nome para o mesmo dono. */
  async assertNameAvailable(userId: string, name: string): Promise<void> {
    const existing = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.ownerUserId, userId),
          sql`lower(${workspaces.name}) = ${name.toLowerCase()}`,
          sql`${workspaces.deletedAt} IS NULL`,
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      throw conflict(ErrorCode.DUPLICATE_NAME, 'Você já tem uma empresa com este nome.');
    }
  }
}
