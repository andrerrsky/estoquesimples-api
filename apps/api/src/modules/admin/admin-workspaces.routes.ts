import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { adminActor, requireAdmin } from './admin-auth.plugin.js';
import { AdminUsersService } from './admin-users.service.js';
import { timelineItemSchema } from './admin-users.routes.js';
import { AdminWorkspacesService } from './admin-workspaces.service.js';
import {
  commonAdminErrors,
  messageSchema,
  paginatedSchema,
  paginationQuerySchema,
  reasonBodySchema,
  uuidParam,
} from './admin.schemas.js';

const workspaceParams = uuidParam('workspaceId');

const listItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
  ownerEmail: z.string(),
  ownerName: z.string(),
  membersCount: z.number().int(),
  productsCount: z.number().int(),
  subscriptionState: z.string().nullable(),
  subscriptionProvider: z.string().nullable(),
  planKey: z.string().nullable(),
  seededAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
});

const noteSchema = z.object({ id: z.string(), adminEmail: z.string(), body: z.string(), createdAt: z.string() });

export async function registerAdminWorkspacesRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new AdminWorkspacesService(app.services);
  const notes = new AdminUsersService(app.services);

  routes.get(
    '/workspaces',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Lista empresas com busca e filtros',
        hide: true,
        querystring: paginationQuerySchema.extend({
          q: z.string().trim().max(200).optional(),
          subscription: z.enum(['entitled', 'none', 'problem']).optional(),
          deleted: z
            .enum(['true', 'false'])
            .optional()
            .transform((value) => value === 'true'),
          sort: z.enum(['createdAt', 'name', 'lastSyncAt', 'products']).optional(),
          order: z.enum(['asc', 'desc']).optional(),
        }),
        response: { 200: paginatedSchema(listItemSchema), ...commonAdminErrors },
      },
    },
    async (request) => service.list(request.query),
  );

  routes.get(
    '/workspaces/:workspaceId',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Detalhe completo de uma empresa',
        hide: true,
        params: workspaceParams,
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.get(request.params.workspaceId),
  );

  routes.get(
    '/workspaces/:workspaceId/products',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Produtos da empresa (leitura)',
        hide: true,
        params: workspaceParams,
        querystring: paginationQuerySchema.extend({
          q: z.string().trim().max(200).optional(),
          includeDeleted: z
            .enum(['true', 'false'])
            .optional()
            .transform((value) => value === 'true'),
        }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.products(request.params.workspaceId, request.query),
  );

  routes.get(
    '/workspaces/:workspaceId/movements',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Movimentações da empresa (leitura)',
        hide: true,
        params: workspaceParams,
        querystring: paginationQuerySchema.extend({ productId: z.string().uuid().optional() }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.movements(request.params.workspaceId, request.query),
  );

  routes.get(
    '/workspaces/:workspaceId/conflicts',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Conflitos de sincronização da empresa',
        hide: true,
        params: workspaceParams,
        querystring: paginationQuerySchema.extend({
          status: z.enum(['pendente', 'automatico', 'resolvido']).optional(),
        }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.conflicts(request.params.workspaceId, request.query),
  );

  routes.get(
    '/workspaces/:workspaceId/timeline',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Auditoria da empresa e ações do suporte sobre ela',
        hide: true,
        params: workspaceParams,
        querystring: paginationQuerySchema,
        response: { 200: paginatedSchema(timelineItemSchema), ...commonAdminErrors },
      },
    },
    async (request) => service.timeline(request.params.workspaceId, request.query),
  );

  // Ações ------------------------------------------------------------------

  routes.patch(
    '/workspaces/:workspaceId',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Renomeia a empresa',
        hide: true,
        params: workspaceParams,
        body: z.object({ name: z.string().trim().min(1).max(120), reason: z.string().trim().min(3).max(500) }).strict(),
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.rename(adminActor(request), request.params.workspaceId, request.body.name, request.body.reason);
      return { message: 'Empresa renomeada.' };
    },
  );

  routes.post(
    '/workspaces/:workspaceId/delete',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Exclui a empresa (lógico, reversível)',
        hide: true,
        params: workspaceParams,
        body: reasonBodySchema,
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.softDelete(adminActor(request), request.params.workspaceId, request.body.reason);
      return { message: 'Empresa excluída. Pode ser restaurada.' };
    },
  );

  routes.post(
    '/workspaces/:workspaceId/restore',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Restaura uma empresa excluída',
        hide: true,
        params: workspaceParams,
        body: reasonBodySchema,
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.restore(adminActor(request), request.params.workspaceId, request.body.reason);
      return { message: 'Empresa restaurada.' };
    },
  );

  routes.post(
    '/workspaces/:workspaceId/transfer-ownership',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Transfere a propriedade para outro membro ativo',
        hide: true,
        params: workspaceParams,
        body: z.object({ newOwnerUserId: z.string().uuid(), reason: z.string().trim().min(3).max(500) }).strict(),
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.transferOwnership(
        adminActor(request),
        request.params.workspaceId,
        request.body.newOwnerUserId,
        request.body.reason,
      );
      return { message: 'Propriedade transferida.' };
    },
  );

  const memberParams = workspaceParams.extend({ userId: z.string().uuid() });

  routes.put(
    '/workspaces/:workspaceId/members/:userId/role',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Altera o papel de um membro',
        hide: true,
        params: memberParams,
        body: z.object({ role: z.string().min(1).max(40), reason: z.string().trim().min(3).max(500) }).strict(),
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.changeMemberRole(
        adminActor(request),
        request.params.workspaceId,
        request.params.userId,
        request.body.role,
        request.body.reason,
      );
      return { message: 'Papel atualizado.' };
    },
  );

  routes.put(
    '/workspaces/:workspaceId/members/:userId/status',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Suspende ou reativa um membro',
        hide: true,
        params: memberParams,
        body: z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().min(3).max(500) }).strict(),
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.setMemberStatus(
        adminActor(request),
        request.params.workspaceId,
        request.params.userId,
        request.body.status,
        request.body.reason,
      );
      return { message: 'Situação do membro atualizada.' };
    },
  );

  routes.post(
    '/workspaces/:workspaceId/members/:userId/remove',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Remove um membro e encerra as sessões dele',
        hide: true,
        params: memberParams,
        body: reasonBodySchema,
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.removeMember(adminActor(request), request.params.workspaceId, request.params.userId, request.body.reason);
      return { message: 'Membro removido.' };
    },
  );

  routes.post(
    '/workspaces/:workspaceId/invites/:inviteId/cancel',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Cancela um convite pendente',
        hide: true,
        params: workspaceParams.extend({ inviteId: z.string().uuid() }),
        body: reasonBodySchema,
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.cancelInvite(adminActor(request), request.params.workspaceId, request.params.inviteId, request.body.reason);
      return { message: 'Convite cancelado.' };
    },
  );

  // Notas ------------------------------------------------------------------

  routes.get(
    '/workspaces/:workspaceId/notes',
    {
      preHandler: requireAdmin('viewer'),
      schema: {
        tags: ['admin'],
        summary: 'Notas de suporte da empresa',
        hide: true,
        params: workspaceParams,
        response: { 200: z.object({ items: z.array(noteSchema) }), ...commonAdminErrors },
      },
    },
    async (request) => ({ items: await notes.listNotes({ workspaceId: request.params.workspaceId }) }),
  );

  routes.post(
    '/workspaces/:workspaceId/notes',
    {
      preHandler: requireAdmin('support'),
      schema: {
        tags: ['admin'],
        summary: 'Adiciona uma nota de suporte à empresa',
        hide: true,
        params: workspaceParams,
        body: z.object({ body: z.string().trim().min(1).max(4000) }).strict(),
        response: { 201: noteSchema, ...commonAdminErrors },
      },
    },
    async (request, reply) => {
      const note = await notes.addNote(adminActor(request), { workspaceId: request.params.workspaceId }, request.body.body);
      return reply.code(201).send(note);
    },
  );
}
