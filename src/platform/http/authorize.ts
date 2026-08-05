import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { rolePermissions, roles, workspaceMembers, workspaces } from '../db/schema/index.js';
import { withTenant, type Transaction } from '../db/client.js';
import { ErrorCode, forbidden, notFound } from './errors.js';
import { requireAuth } from './authenticate.js';
import type { AppServices, WorkspaceContext } from './context.js';

/**
 * Mapa papel -> permissões, carregado do banco uma vez por processo.
 *
 * Papéis e permissões são dados de sistema, alterados apenas por migration,
 * então consultá-los a cada requisição seria desperdício. O cache é invalidado
 * apenas por reinício — coerente com o fato de que mudá-los exige um deploy.
 */
let permissionCache: Map<string, Set<string>> | null = null;

export async function loadRolePermissions(
  services: AppServices,
): Promise<Map<string, Set<string>>> {
  if (permissionCache) return permissionCache;

  const rows = await services.db
    .select({ roleKey: rolePermissions.roleKey, permissionKey: rolePermissions.permissionKey })
    .from(rolePermissions);

  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = map.get(row.roleKey) ?? new Set<string>();
    set.add(row.permissionKey);
    map.set(row.roleKey, set);
  }

  permissionCache = map;
  return map;
}

/** Usado nos testes, que trocam de banco entre suítes. */
export function clearPermissionCache(): void {
  permissionCache = null;
}

export async function getRoleRanks(services: AppServices): Promise<Map<string, number>> {
  const rows = await services.db.select({ key: roles.key, rank: roles.rank }).from(roles);
  return new Map(rows.map((row) => [row.key, row.rank]));
}

/**
 * Confirma que o usuário participa do workspace e resolve as permissões dele.
 *
 * Este é o ponto central do isolamento entre empresas. Repare que o
 * `workspaceId` da URL nunca é aceito por si só: ele só vale se existir uma
 * linha de participação ativa ligando aquele usuário àquela empresa. Sem essa
 * verificação, trocar o id na URL daria acesso aos dados de outro cliente.
 */
export async function resolveWorkspaceContext(
  services: AppServices,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceContext> {
  const rows = await services.db
    .select({
      roleKey: workspaceMembers.roleKey,
      status: workspaceMembers.status,
      ownerUserId: workspaces.ownerUserId,
      deletedAt: workspaces.deletedAt,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
    )
    .limit(1);

  const row = rows[0];

  // Empresa inexistente e empresa da qual o usuário não participa devolvem a
  // mesma resposta de propósito: descobrir que um workspace existe já seria
  // vazamento de informação.
  if (!row || row.deletedAt) {
    throw notFound('Empresa não encontrada.');
  }
  if (row.status === 'removed') {
    throw notFound('Empresa não encontrada.');
  }
  if (row.status === 'suspended') {
    throw forbidden(ErrorCode.MEMBER_SUSPENDED, 'Seu acesso a esta empresa está suspenso.');
  }

  const permissionsByRole = await loadRolePermissions(services);
  const permissions = permissionsByRole.get(row.roleKey) ?? new Set<string>();

  return {
    workspaceId,
    roleKey: row.roleKey,
    permissions,
    isOwner: row.ownerUserId === userId,
  };
}

interface WorkspaceParams {
  workspaceId?: string;
}

/**
 * preHandler que resolve o workspace da rota e, opcionalmente, exige uma
 * permissão. A validação acontece sempre no servidor: o app Android pode
 * esconder botões, mas isso é conveniência de interface, nunca controle
 * de acesso.
 */
export function requireWorkspace(permission?: string): preHandlerHookHandler {
  return async function workspaceGuard(request: FastifyRequest, _reply: FastifyReply) {
    const auth = requireAuth(request);
    const params = request.params as WorkspaceParams;
    const workspaceId = params.workspaceId;

    if (!workspaceId) {
      throw notFound('Empresa não informada.');
    }

    const services = request.server.services;
    const context = await resolveWorkspaceContext(services, auth.userId, workspaceId);

    if (permission && !context.permissions.has(permission)) {
      throw forbidden(
        ErrorCode.MISSING_PERMISSION,
        'Você não tem permissão para executar esta ação.',
        { requiredPermission: permission, role: context.roleKey },
      );
    }

    request.workspace = context;
  };
}

export function requireWorkspaceContext(request: FastifyRequest): WorkspaceContext {
  if (!request.workspace) {
    throw forbidden(ErrorCode.FORBIDDEN, 'Contexto de empresa não resolvido.');
  }
  return request.workspace;
}

/**
 * Executa o callback numa transação já com o contexto de tenant aplicado
 * (workspace corrente + role app_user, sujeito às políticas de RLS).
 */
export async function inWorkspace<T>(
  request: FastifyRequest,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const auth = requireAuth(request);
  const workspace = requireWorkspaceContext(request);
  return withTenant(
    request.server.services.db,
    { workspaceId: workspace.workspaceId, userId: auth.userId },
    fn,
  );
}
