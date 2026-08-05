import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { devices, sessions, users, workspaces } from '../../platform/db/schema/index.js';
import { requireAuth } from '../../platform/http/authenticate.js';
import {
  AppError,
  ErrorCode,
  notFound,
  unauthorized,
} from '../../platform/http/errors.js';
import { verifyPassword } from '../../platform/auth/password.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { revokeUserSessions } from '../auth/auth.service.js';
import { deviceInfoSchema, errorSchema, messageSchema } from '../auth/auth.schemas.js';
import { requestMeta } from '../auth/auth.routes.js';

const commonErrors = {
  400: errorSchema,
  401: errorSchema,
  404: errorSchema,
  409: errorSchema,
};

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.services;

  routes.get(
    '/me',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['usuário'],
        summary: 'Perfil do usuário autenticado',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            id: z.string().uuid(),
            email: z.string(),
            name: z.string(),
            emailVerified: z.boolean(),
            status: z.string(),
            createdAt: z.string(),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const rows = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1);
      const user = rows[0];
      if (!user) throw notFound('Usuário não encontrado.');

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerifiedAt !== null,
        status: user.status,
        createdAt: user.createdAt.toISOString(),
      };
    },
  );

  routes.patch(
    '/me',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['usuário'],
        summary: 'Atualiza o perfil',
        security: [{ bearerAuth: [] }],
        body: z.object({ name: z.string().trim().min(1).max(120) }).strict(),
        response: { 200: messageSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await db.update(users).set({ name: request.body.name }).where(eq(users.id, auth.userId));
      return { message: 'Perfil atualizado.' };
    },
  );

  routes.get(
    '/me/sessions',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['usuário'],
        summary: 'Lista as sessões ativas',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            sessions: z.array(
              z.object({
                id: z.string().uuid(),
                current: z.boolean(),
                deviceId: z.string().uuid().nullable(),
                deviceModel: z.string().nullable(),
                appVersionName: z.string().nullable(),
                createdAt: z.string(),
                lastUsedAt: z.string(),
                expiresAt: z.string(),
              }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const rows = await db
        .select({
          id: sessions.id,
          deviceId: sessions.deviceId,
          deviceModel: devices.model,
          appVersionName: devices.appVersionName,
          createdAt: sessions.createdAt,
          lastUsedAt: sessions.lastUsedAt,
          expiresAt: sessions.expiresAt,
        })
        .from(sessions)
        .leftJoin(devices, eq(devices.id, sessions.deviceId))
        .where(and(eq(sessions.userId, auth.userId), isNull(sessions.revokedAt)))
        .orderBy(desc(sessions.lastUsedAt));

      return {
        sessions: rows.map((row) => ({
          id: row.id,
          current: row.id === auth.sessionId,
          deviceId: row.deviceId,
          deviceModel: row.deviceModel,
          appVersionName: row.appVersionName,
          createdAt: row.createdAt.toISOString(),
          lastUsedAt: row.lastUsedAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
        })),
      };
    },
  );

  routes.delete(
    '/me/sessions/:sessionId',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['usuário'],
        summary: 'Encerra uma sessão específica',
        security: [{ bearerAuth: [] }],
        params: z.object({ sessionId: z.string().uuid() }),
        response: { 200: messageSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const revoked = await db
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'logout' })
        .where(
          and(
            eq(sessions.id, request.params.sessionId),
            eq(sessions.userId, auth.userId),
            isNull(sessions.revokedAt),
          ),
        )
        .returning({ id: sessions.id });

      if (revoked.length === 0) throw notFound('Sessão não encontrada.');
      return { message: 'Sessão encerrada.' };
    },
  );

  routes.get(
    '/me/devices',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['usuário'],
        summary: 'Lista os dispositivos registrados',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            devices: z.array(
              z.object({
                id: z.string().uuid(),
                installId: z.string(),
                platform: z.string(),
                model: z.string().nullable(),
                appVersionName: z.string().nullable(),
                appVersionCode: z.number().int().nullable(),
                lastSeenAt: z.string(),
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
      const rows = await db
        .select()
        .from(devices)
        .where(and(eq(devices.userId, auth.userId), isNull(devices.revokedAt)))
        .orderBy(desc(devices.lastSeenAt));

      return {
        devices: rows.map((row) => ({
          id: row.id,
          installId: row.installId,
          platform: row.platform,
          model: row.model,
          appVersionName: row.appVersionName,
          appVersionCode: row.appVersionCode,
          lastSeenAt: row.lastSeenAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        })),
      };
    },
  );

  routes.post(
    '/me/devices',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['usuário'],
        summary: 'Registra ou atualiza o dispositivo atual',
        security: [{ bearerAuth: [] }],
        body: deviceInfoSchema,
        response: {
          200: z.object({ deviceId: z.string().uuid() }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const body = request.body;

      const result = await db
        .insert(devices)
        .values({
          userId: auth.userId,
          installId: body.installId,
          platform: body.platform,
          model: body.model ?? null,
          osVersion: body.osVersion ?? null,
          appVersionCode: body.appVersionCode ?? null,
          appVersionName: body.appVersionName ?? null,
          syncProtocolVersion: body.syncProtocolVersion ?? null,
        })
        .onConflictDoUpdate({
          target: [devices.userId, devices.installId],
          set: {
            model: body.model ?? null,
            osVersion: body.osVersion ?? null,
            appVersionCode: body.appVersionCode ?? null,
            appVersionName: body.appVersionName ?? null,
            syncProtocolVersion: body.syncProtocolVersion ?? null,
            lastSeenAt: new Date(),
            revokedAt: null,
          },
        })
        .returning({ id: devices.id });

      const deviceId = result[0]?.id;
      if (!deviceId) throw notFound('Falha ao registrar dispositivo.');
      return { deviceId };
    },
  );

  routes.delete(
    '/me/devices/:deviceId',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['usuário'],
        summary: 'Revoga um dispositivo e encerra as sessões dele',
        security: [{ bearerAuth: [] }],
        params: z.object({ deviceId: z.string().uuid() }),
        response: { 200: messageSchema, ...commonErrors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      await db.transaction(async (tx) => {
        const revoked = await tx
          .update(devices)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(devices.id, request.params.deviceId),
              eq(devices.userId, auth.userId),
              isNull(devices.revokedAt),
            ),
          )
          .returning({ id: devices.id });

        if (revoked.length === 0) throw notFound('Dispositivo não encontrado.');

        // Revogar o aparelho sem derrubar as sessões dele não revogaria nada
        // na prática: o token continuaria funcionando.
        await tx
          .update(sessions)
          .set({ revokedAt: new Date(), revokedReason: 'device_revoked' })
          .where(
            and(
              eq(sessions.deviceId, request.params.deviceId),
              eq(sessions.userId, auth.userId),
              isNull(sessions.revokedAt),
            ),
          );

        await recordAudit(tx, {
          actorUserId: auth.userId,
          action: AuditAction.DEVICE_REVOKED,
          entityType: 'device',
          entityId: request.params.deviceId,
          ipAddress: requestMeta(request).ipAddress,
        });
      });

      return { message: 'Dispositivo revogado.' };
    },
  );

  routes.delete(
    '/me',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['usuário'],
        summary: 'Solicita a exclusão da conta',
        description:
          'A conta entra em período de recuperação antes da exclusão definitiva. ' +
          'Nenhum dado local do aplicativo é afetado.',
        security: [{ bearerAuth: [] }],
        body: z.object({ password: z.string().min(1).max(200) }).strict(),
        response: {
          200: z.object({ message: z.string(), recoverableUntil: z.string() }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const rows = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1);
      const user = rows[0];
      if (!user) throw notFound('Usuário não encontrado.');

      const ok = await verifyPassword(user.passwordHash, request.body.password);
      if (!ok) {
        throw unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Senha incorreta.');
      }

      // Proprietário sem transferência: a conta entraria em pending_deletion,
      // o authenticate barraria o usuário, e ninguém mais poderia transferir
      // (só o papel proprietário tem workspace.transferir). O workspace ficaria
      // sem dono capaz de agir e a assinatura encalhada.
      const owned = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(and(eq(workspaces.ownerUserId, auth.userId), isNull(workspaces.deletedAt)));
      if (owned.length > 0) {
        throw new AppError(
          409,
          ErrorCode.LAST_OWNER,
          'Transfira a propriedade ou exclua as empresas das quais você é o único proprietário antes de apagar a conta.',
          {
            extra: {
              workspaces: owned.map((w) => ({ id: w.id, name: w.name })),
            },
          },
        );
      }

      const requestedAt = new Date();
      const recoverableUntil = new Date(requestedAt.getTime() + 30 * 86_400_000);

      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ status: 'pending_deletion', deletionRequestedAt: requestedAt })
          .where(eq(users.id, auth.userId));

        await revokeUserSessions(tx, auth.userId, { reason: 'account_deleted' });

        await recordAudit(tx, {
          actorUserId: auth.userId,
          action: AuditAction.USER_DELETION_REQUESTED,
          entityType: 'user',
          entityId: auth.userId,
          metadata: { recoverableUntil: recoverableUntil.toISOString() },
          ipAddress: requestMeta(request).ipAddress,
        });
      });

      return {
        message: 'Exclusão solicitada. A conta será removida definitivamente após o período de recuperação.',
        recoverableUntil: recoverableUntil.toISOString(),
      };
    },
  );
}
