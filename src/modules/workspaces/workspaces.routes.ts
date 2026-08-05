import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireAuth } from '../../platform/http/authenticate.js';
import { requireWorkspace, requireWorkspaceContext } from '../../platform/http/authorize.js';
import { errorSchema, messageSchema } from '../auth/auth.schemas.js';
import { requestMeta } from '../auth/auth.routes.js';
import { WorkspaceService } from './workspaces.service.js';

const commonErrors = {
  400: errorSchema,
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
};

const workspaceParams = z.object({ workspaceId: z.string().uuid() });

const memberSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
  status: z.string(),
  joinedAt: z.string(),
});

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new WorkspaceService(app.services);

  routes.post(
    '/workspaces',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['workspace'],
        summary: 'Cria uma empresa e define quem criou como proprietário',
        security: [{ bearerAuth: [] }],
        body: z.object({ name: z.string().trim().min(1).max(120) }).strict(),
        response: {
          201: z.object({ id: z.string().uuid(), name: z.string(), createdAt: z.string() }),
          ...commonErrors,
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await service.assertNameAvailable(auth.userId, request.body.name);
      const created = await service.create(auth.userId, request.body, requestMeta(request));
      return reply.code(201).send(created);
    },
  );

  routes.get(
    '/workspaces',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['workspace'],
        summary: 'Lista as empresas do usuário',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            workspaces: z.array(
              z.object({
                id: z.string().uuid(),
                name: z.string(),
                role: z.string(),
                isOwner: z.boolean(),
                memberCount: z.number().int(),
                createdAt: z.string(),
              }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return { workspaces: await service.listForUser(auth.userId) };
    },
  );

  routes.get(
    '/workspaces/:workspaceId',
    {
      preHandler: [app.authenticate, requireWorkspace('workspace.ver')],
      schema: {
        tags: ['workspace'],
        summary: 'Detalhes da empresa e permissões efetivas do usuário',
        security: [{ bearerAuth: [] }],
        params: workspaceParams,
        response: {
          200: z.object({
            id: z.string().uuid(),
            name: z.string(),
            settings: z.record(z.unknown()),
            ownerUserId: z.string().uuid(),
            createdAt: z.string(),
            role: z.string(),
            isOwner: z.boolean(),
            permissions: z.array(z.string()),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const context = requireWorkspaceContext(request);
      const workspace = await service.get(context.workspaceId);
      return {
        ...workspace,
        role: context.roleKey,
        isOwner: context.isOwner,
        // A interface usa isto para esconder ações indisponíveis. É apenas
        // conveniência: o servidor revalida a permissão em cada chamada.
        permissions: [...context.permissions].sort(),
      };
    },
  );

  routes.patch(
    '/workspaces/:workspaceId',
    {
      preHandler: [app.authenticate, requireWorkspace('workspace.configurar')],
      schema: {
        tags: ['workspace'],
        summary: 'Atualiza nome e configurações da empresa',
        security: [{ bearerAuth: [] }],
        params: workspaceParams,
        body: z
          .object({
            name: z.string().trim().min(1).max(120).optional(),
            settings: z.record(z.unknown()).optional(),
          })
          .strict(),
        response: { 200: messageSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const context = requireWorkspaceContext(request);
      await service.update(context.workspaceId, auth.userId, request.body, requestMeta(request));
      return { message: 'Empresa atualizada.' };
    },
  );

  routes.get(
    '/workspaces/:workspaceId/members',
    {
      preHandler: [app.authenticate, requireWorkspace('membros.ver')],
      schema: {
        tags: ['workspace'],
        summary: 'Lista os membros da empresa',
        security: [{ bearerAuth: [] }],
        params: workspaceParams,
        response: { 200: z.object({ members: z.array(memberSchema) }), ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const context = requireWorkspaceContext(request);
      return { members: await service.listMembers(context.workspaceId, auth.userId) };
    },
  );

  // PUT é aceito junto com PATCH porque o cliente Android usa
  // HttpURLConnection, que não implementa PATCH. Semanticamente é o mesmo
  // recurso: o corpo traz o papel inteiro, não um pedaço dele.
  routes.route({
    method: ['PATCH', 'PUT'],
    url: '/workspaces/:workspaceId/members/:userId/role',
    preHandler: [app.authenticate, requireWorkspace('membros.alterar_papel')],
    schema: {
      tags: ['workspace'],
      summary: 'Altera o papel de um membro',
      description:
        'Não é possível conceder um papel igual ou superior ao próprio. ' +
        'A mudança invalida o token de acesso do membro, que passa a valer com as novas permissões na próxima renovação.',
      security: [{ bearerAuth: [] }],
      params: workspaceParams.extend({ userId: z.string().uuid() }),
      body: z.object({ role: z.string().min(1).max(40) }).strict(),
      response: { 200: messageSchema, ...commonErrors },
    },
    handler: async (request) => {
      const auth = requireAuth(request);
      const context = requireWorkspaceContext(request);
      await service.changeMemberRole(
        context.workspaceId,
        { userId: auth.userId, roleKey: context.roleKey },
        request.params.userId,
        request.body.role,
        requestMeta(request),
      );
      return { message: 'Papel atualizado.' };
    },
  });

  routes.route({
    method: ['PATCH', 'PUT'],
    url: '/workspaces/:workspaceId/members/:userId/status',
    preHandler: [app.authenticate, requireWorkspace('membros.suspender')],
    schema: {
      tags: ['workspace'],
      summary: 'Suspende ou reativa um membro',
      security: [{ bearerAuth: [] }],
      params: workspaceParams.extend({ userId: z.string().uuid() }),
      body: z.object({ status: z.enum(['active', 'suspended']) }).strict(),
      response: { 200: messageSchema, ...commonErrors },
    },
    handler: async (request) => {
      const auth = requireAuth(request);
      const context = requireWorkspaceContext(request);
      await service.setMemberStatus(
        context.workspaceId,
        { userId: auth.userId, roleKey: context.roleKey },
        request.params.userId,
        request.body.status,
        requestMeta(request),
      );
      return { message: 'Situação do membro atualizada.' };
    },
  });

  routes.delete(
    '/workspaces/:workspaceId/members/:userId',
    {
      preHandler: [app.authenticate, requireWorkspace('membros.remover')],
      schema: {
        tags: ['workspace'],
        summary: 'Remove um membro e encerra as sessões dele',
        security: [{ bearerAuth: [] }],
        params: workspaceParams.extend({ userId: z.string().uuid() }),
        response: { 200: messageSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const context = requireWorkspaceContext(request);
      await service.removeMember(
        context.workspaceId,
        { userId: auth.userId, roleKey: context.roleKey },
        request.params.userId,
        requestMeta(request),
      );
      return { message: 'Membro removido.' };
    },
  );

  routes.post(
    '/workspaces/:workspaceId/transfer-ownership',
    {
      preHandler: [app.authenticate, requireWorkspace('workspace.transferir')],
      schema: {
        tags: ['workspace'],
        summary: 'Transfere a propriedade da empresa',
        description: 'O proprietário atual passa a administrador, mantendo o acesso.',
        security: [{ bearerAuth: [] }],
        params: workspaceParams,
        body: z.object({ newOwnerUserId: z.string().uuid() }).strict(),
        response: { 200: messageSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const context = requireWorkspaceContext(request);
      await service.transferOwnership(
        context.workspaceId,
        auth.userId,
        request.body.newOwnerUserId,
        requestMeta(request),
      );
      return { message: 'Propriedade transferida.' };
    },
  );

  routes.get(
    '/workspaces/:workspaceId/permissions',
    {
      preHandler: [app.authenticate, requireWorkspace()],
      schema: {
        tags: ['workspace'],
        summary: 'Permissões efetivas do usuário nesta empresa',
        security: [{ bearerAuth: [] }],
        params: workspaceParams,
        response: {
          200: z.object({
            role: z.string(),
            isOwner: z.boolean(),
            permissions: z.array(z.string()),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const context = requireWorkspaceContext(request);
      return {
        role: context.roleKey,
        isOwner: context.isOwner,
        permissions: [...context.permissions].sort(),
      };
    },
  );
}
