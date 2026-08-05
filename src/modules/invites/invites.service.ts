import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client.js';
import { invites, users, workspaceMembers, workspaces } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { getRoleRanks } from '../../platform/http/authorize.js';
import {
  AppError,
  ErrorCode,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from '../../platform/http/errors.js';
import { addDays, generateInviteToken, hashToken } from '../../platform/auth/tokens.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { AuthService, bumpPermissionVersion, type RequestMeta } from '../auth/auth.service.js';
import type { AuthSuccess } from '../auth/auth.schemas.js';
import type { AcceptInviteBody, CreateInviteBody } from './invites.schemas.js';

export interface InviteView {
  id: string;
  email: string;
  roleKey: string;
  status: 'pendente' | 'aceito' | 'cancelado' | 'expirado';
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
}

/**
 * Convites para entrar numa empresa.
 *
 * O token é de uso único, tem prazo e vive apenas no e-mail: o banco guarda só
 * o hash. Isso significa que nem quem tem acesso ao banco consegue aceitar um
 * convite alheio, e que um vazamento de backup não vira acesso a estoques de
 * clientes.
 */
export class InvitesService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  /**
   * Emite o convite e envia o link.
   *
   * Reconvidar o mesmo e-mail substitui o convite anterior em vez de criar
   * outro. Dois links válidos para a mesma pessoa significam que revogar um
   * deles não revoga nada — e o índice único no banco existe exatamente para
   * tornar esse engano impossível.
   */
  async create(
    workspaceId: string,
    actor: { userId: string; roleKey: string; emailVerified: boolean },
    body: CreateInviteBody,
    meta: RequestMeta,
  ): Promise<InviteView> {
    // Convidar é a única ação que dispara e-mail em nome da empresa. Sem
    // confirmar o próprio endereço, uma conta recém-criada com e-mail alheio
    // poderia usar o produto como forma de enviar mensagens.
    if (!actor.emailVerified) {
      throw forbidden(
        ErrorCode.AUTH_EMAIL_NOT_VERIFIED,
        'Confirme seu e-mail antes de convidar outras pessoas.',
      );
    }

    const ranks = await getRoleRanks(this.services);
    const actorRank = ranks.get(actor.roleKey) ?? 0;
    const novoRank = ranks.get(body.roleKey);
    if (novoRank === undefined) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Papel inválido.');
    }
    if (novoRank >= actorRank) {
      throw forbidden(
        ErrorCode.MISSING_PERMISSION,
        'Você não pode convidar alguém para um papel igual ou superior ao seu.',
      );
    }

    const token = generateInviteToken();
    const expiresAt = addDays(new Date(), this.services.env.INVITE_TTL_DAYS);

    const convite = await withTenant(this.db, { workspaceId, userId: actor.userId }, async (tx) => {
      const [jaMembro] = await tx
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            sql`lower(${users.email}) = ${body.email}`,
            eq(workspaceMembers.status, 'active'),
          ),
        );

      if (jaMembro) {
        throw conflict(ErrorCode.ALREADY_MEMBER, 'Esta pessoa já participa da empresa.');
      }

      // Cancelar o pendente antes de inserir o novo: o índice único cobre um
      // convite aberto por e-mail, e reenviar precisa continuar funcionando.
      await tx
        .update(invites)
        .set({ cancelledAt: new Date() })
        .where(
          and(
            eq(invites.workspaceId, workspaceId),
            sql`lower(${invites.email}) = ${body.email}`,
            isNull(invites.acceptedAt),
            isNull(invites.cancelledAt),
          ),
        );

      const [criado] = await tx
        .insert(invites)
        .values({
          workspaceId,
          email: body.email,
          roleKey: body.roleKey,
          tokenHash: hashToken(token),
          invitedBy: actor.userId,
          expiresAt,
        })
        .returning();

      if (!criado) {
        throw new AppError(500, ErrorCode.INTERNAL, 'Não foi possível criar o convite.');
      }

      await recordAudit(tx, {
        workspaceId,
        actorUserId: actor.userId,
        action: AuditAction.INVITE_CREATED,
        entityType: 'invite',
        entityId: criado.id,
        metadata: { roleKey: body.roleKey },
        ipAddress: meta.ipAddress,
      });

      return criado;
    });

    const [empresa] = await this.db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    await this.services.mailer.send({
      to: body.email,
      subject: `Convite para ${empresa?.name ?? 'uma empresa'} no EstoqueSimples`,
      text:
        `Você foi convidado para ${empresa?.name ?? 'uma empresa'} no EstoqueSimples.\n\n` +
        `Use este código no aplicativo: ${token}\n\n` +
        `O convite vale até ${expiresAt.toLocaleDateString('pt-BR')}.`,
      kind: 'invite',
    });

    return this.toView(convite);
  }

  async list(workspaceId: string, userId: string): Promise<InviteView[]> {
    return withTenant(this.db, { workspaceId, userId }, async (tx) => {
      const linhas = await tx
        .select()
        .from(invites)
        .where(eq(invites.workspaceId, workspaceId))
        .orderBy(desc(invites.createdAt))
        .limit(100);

      return linhas.map((linha) => this.toView(linha));
    });
  }

  /** Cancela um convite ainda não aceito. */
  async cancel(
    workspaceId: string,
    actorUserId: string,
    inviteId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await withTenant(this.db, { workspaceId, userId: actorUserId }, async (tx) => {
      const [convite] = await tx
        .select()
        .from(invites)
        .where(and(eq(invites.workspaceId, workspaceId), eq(invites.id, inviteId)));

      if (!convite) {
        throw notFound('Convite não encontrado.');
      }
      if (convite.acceptedAt) {
        throw conflict(ErrorCode.INVITE_ALREADY_USED, 'Este convite já foi aceito.');
      }

      await tx.update(invites).set({ cancelledAt: new Date() }).where(eq(invites.id, inviteId));

      await recordAudit(tx, {
        workspaceId,
        actorUserId,
        action: AuditAction.INVITE_CANCELLED,
        entityType: 'invite',
        entityId: inviteId,
        ipAddress: meta.ipAddress,
      });
    });
  }

  /**
   * Mostra o que o convite oferece.
   *
   * Público por necessidade: quem foi convidado ainda não tem conta. Por isso
   * devolve o mínimo — nome da empresa, papel e prazo. Nada que sirva para
   * mapear clientes a partir de tokens tentados ao acaso.
   */
  async preview(token: string): Promise<{
    workspaceName: string;
    roleKey: string;
    email: string;
    expiresAt: string;
    hasAccount: boolean;
  }> {
    const convite = await this.findValid(token);

    const [empresa] = await this.db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, convite.workspaceId));

    const [conta] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${convite.email.toLowerCase()}`, isNull(users.deletedAt)));

    return {
      workspaceName: empresa?.name ?? 'Empresa',
      roleKey: convite.roleKey,
      email: convite.email,
      expiresAt: convite.expiresAt.toISOString(),
      hasAccount: conta !== undefined,
    };
  }

  /**
   * Aceita o convite.
   *
   * Dois caminhos, um único resultado: a pessoa vira membro. Quem já tem conta
   * precisa estar autenticada — e com o mesmo e-mail do convite, senão bastaria
   * repassar o link para entrar na empresa de outra pessoa. Quem não tem conta
   * cria a senha aqui mesmo, porque exigir cadastro antes faria o convidado
   * sair do fluxo e voltar sem o link.
   */
  async accept(
    token: string,
    body: AcceptInviteBody,
    autenticado: { userId: string; email: string } | null,
    meta: RequestMeta,
  ): Promise<{ workspaceId: string; roleKey: string; auth: AuthSuccess | null }> {
    const convite = await this.findValid(token);

    const [conta] = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${convite.email.toLowerCase()}`, isNull(users.deletedAt)));

    if (conta && !autenticado) {
      throw new AppError(
        401,
        ErrorCode.AUTH_REQUIRED,
        'Já existe uma conta com este e-mail. Entre nela para aceitar o convite.',
      );
    }
    if (autenticado && autenticado.email.toLowerCase() !== convite.email.toLowerCase()) {
      throw forbidden(
        ErrorCode.INVITE_INVALID,
        'Este convite foi enviado para outro e-mail. Entre com a conta convidada.',
      );
    }
    if (!conta && (!body.password || !body.name)) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Informe seu nome e crie uma senha para aceitar o convite.',
        [{ field: 'password', message: 'Obrigatório para quem ainda não tem conta.' }],
      );
    }

    const auth = new AuthService(this.services);

    return this.db.transaction(async (tx) => {
      // Consumir o convite antes de qualquer outra escrita, condicionando à
      // linha ainda estar aberta. Dois toques no mesmo link chegando juntos
      // fazem o segundo não encontrar nada para atualizar.
      const consumidos = await tx
        .update(invites)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(invites.id, convite.id),
            isNull(invites.acceptedAt),
            isNull(invites.cancelledAt),
          ),
        )
        .returning({ id: invites.id });

      if (consumidos.length === 0) {
        throw conflict(ErrorCode.INVITE_ALREADY_USED, 'Este convite já foi utilizado.');
      }

      let sessao: AuthSuccess | null = null;
      let userId: string;

      if (conta) {
        userId = conta.id;
      } else {
        sessao = await auth.createInvitedUser(
          tx,
          {
            email: convite.email.toLowerCase(),
            password: body.password as string,
            name: body.name as string,
            ...(body.device ? { device: body.device } : {}),
          },
          meta,
        );
        userId = sessao.user.id;
      }

      await tx.update(invites).set({ acceptedBy: userId }).where(eq(invites.id, convite.id));

      // Quem já participou e foi removido volta pelo mesmo caminho: a linha de
      // participação é reaproveitada em vez de duplicada.
      await tx
        .insert(workspaceMembers)
        .values({
          workspaceId: convite.workspaceId,
          userId,
          roleKey: convite.roleKey,
          status: 'active',
          invitedBy: convite.invitedBy,
        })
        .onConflictDoUpdate({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
          set: { roleKey: convite.roleKey, status: 'active', joinedAt: new Date() },
        });

      // As permissões de quem já tinha conta mudaram, então os access tokens
      // em circulação precisam ser trocados. Para a conta criada agora não há
      // token antigo a invalidar — e invalidar a versão nasceria derrubando a
      // sessão que acabamos de devolver na resposta.
      if (conta) {
        await bumpPermissionVersion(tx, userId);
      }

      await recordAudit(tx, {
        workspaceId: convite.workspaceId,
        actorUserId: userId,
        action: AuditAction.INVITE_ACCEPTED,
        entityType: 'invite',
        entityId: convite.id,
        metadata: { roleKey: convite.roleKey },
        ipAddress: meta.ipAddress,
      });

      return { workspaceId: convite.workspaceId, roleKey: convite.roleKey, auth: sessao };
    });
  }

  // ---------------------------------------------------------------------------
  // Apoio
  // ---------------------------------------------------------------------------

  /**
   * Busca o convite pelo hash do token.
   *
   * Convite inexistente, cancelado, já aceito e expirado devolvem respostas
   * distintas de propósito: cada um pede uma ação diferente de quem recebeu, e
   * "convite inválido" para os quatro casos deixaria a pessoa sem saber se
   * pede outro ou apenas entra na conta.
   */
  private async findValid(token: string) {
    const [convite] = await this.db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)));

    if (!convite) {
      throw new AppError(404, ErrorCode.INVITE_INVALID, 'Convite não encontrado.');
    }
    if (convite.cancelledAt) {
      throw new AppError(410, ErrorCode.INVITE_INVALID, 'Este convite foi cancelado.');
    }
    if (convite.acceptedAt) {
      throw new AppError(410, ErrorCode.INVITE_ALREADY_USED, 'Este convite já foi utilizado.');
    }
    if (convite.expiresAt.getTime() <= Date.now()) {
      throw new AppError(410, ErrorCode.INVITE_EXPIRED, 'Este convite expirou. Peça um novo.');
    }
    return convite;
  }

  private toView(convite: typeof invites.$inferSelect): InviteView {
    let status: InviteView['status'] = 'pendente';
    if (convite.acceptedAt) status = 'aceito';
    else if (convite.cancelledAt) status = 'cancelado';
    else if (convite.expiresAt.getTime() <= Date.now()) status = 'expirado';

    return {
      id: convite.id,
      email: convite.email,
      roleKey: convite.roleKey,
      status,
      invitedBy: convite.invitedBy,
      expiresAt: convite.expiresAt.toISOString(),
      createdAt: convite.createdAt.toISOString(),
      acceptedAt: convite.acceptedAt ? convite.acceptedAt.toISOString() : null,
    };
  }
}
