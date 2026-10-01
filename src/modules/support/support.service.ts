import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { platformAdmins, pushTokens, supportMessages, supportTickets, users } from '../../platform/db/schema/index.js';
import type { Transaction } from '../../platform/db/client.js';
import type { AppServices } from '../../platform/http/context.js';
import { AppError, ErrorCode, conflict, notFound } from '../../platform/http/errors.js';
import { AdminAction, recordAdminAudit, type AdminActor } from '../admin/admin-audit.service.js';
import { iso, offsetOf, type Paginated, type PaginationQuery } from '../admin/admin.schemas.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { AnalyticsEventName } from '../analytics/analytics.events.js';
import { OpenAiClient } from '../reviews/openai-client.js';
import { readOpenAiKey } from '../reviews/reviews.service.js';
import type { SupportMessage, SupportTicket } from '../../platform/db/schema/support.js';
import { MAX_OPEN_TICKETS, type CreateTicketBody, type DeviceInfo, type SupportStatus } from './support.schemas.js';

/**
 * Quem está falando com o suporte pelo app.
 *
 * Com sessão, o usuário; sem sessão, a instalação (`installId`, o mesmo
 * identificador da sincronização e do push). Um `installId` é um segredo
 * do aparelho, gerado aleatoriamente — é o que permite a quem não tem
 * conta ver as próprias solicitações e nada mais.
 */
export interface SupportIdentity {
  userId: string | null;
  installId: string;
  deviceId: string | null;
}

export const SUPPORT_REPLY_MAX_LENGTH = 1500;
const SYSTEM_AUTHOR = 'system';

type TicketRow = Record<string, unknown>;

/** Linha do Drizzle (camelCase) no formato das consultas SQL cruas (snake_case). */
function entityToRow(ticket: SupportTicket): TicketRow {
  const row: TicketRow = {};
  for (const [key, value] of Object.entries(ticket)) {
    row[key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)] = value;
  }
  return row;
}

const CATEGORY_LABEL: Record<string, string> = {
  question: 'Dúvida',
  problem: 'Problema',
  suggestion: 'Sugestão',
  billing: 'Assinatura e pagamento',
  account: 'Conta e sincronização',
  other: 'Outro',
};

function describeDevice(device: DeviceInfo | Record<string, unknown>): string | null {
  const d = device as DeviceInfo;
  const parts = [
    [d.manufacturer, d.model].filter(Boolean).join(' ') || null,
    d.osVersion ? `Android ${d.osVersion}` : null,
    d.appVersionName ? `app ${d.appVersionName}${d.appVersionCode ? ` (${d.appVersionCode})` : ''}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function excerpt(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Atendimento de suporte: solicitações abertas pelo app, respondidas pelo
 * painel, com notificação por push (ou e-mail, quando não há aparelho).
 */
export class SupportService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  // -------------------------------------------------------------------------
  // Identidade e visibilidade (app)
  // -------------------------------------------------------------------------

  private visibleWhere(identity: SupportIdentity): SQL {
    if (identity.userId) {
      return sql`(${supportTickets.userId} = ${identity.userId} OR (${supportTickets.userId} IS NULL AND ${supportTickets.installId} = ${identity.installId}))`;
    }
    return sql`(${supportTickets.userId} IS NULL AND ${supportTickets.installId} = ${identity.installId})`;
  }

  /**
   * Quem abriu solicitações sem conta e depois entrou passa a ser dono
   * delas: a instalação é a mesma. Idempotente e barato (índice por
   * install_id).
   */
  private async claimAnonymous(identity: SupportIdentity): Promise<void> {
    if (!identity.userId) return;
    await this.db
      .update(supportTickets)
      .set({ userId: identity.userId })
      .where(and(isNull(supportTickets.userId), eq(supportTickets.installId, identity.installId)));
  }

  private async loadVisible(identity: SupportIdentity, ticketId: string): Promise<SupportTicket> {
    const rows = await this.db
      .select()
      .from(supportTickets)
      .where(and(eq(supportTickets.id, ticketId), this.visibleWhere(identity)))
      .limit(1);
    const ticket = rows[0];
    if (!ticket) throw notFound('Solicitação não encontrada.');
    return ticket;
  }

  private async lockVisible(tx: Transaction, identity: SupportIdentity, ticketId: string): Promise<SupportTicket> {
    const rows = await tx
      .select()
      .from(supportTickets)
      .where(and(eq(supportTickets.id, ticketId), this.visibleWhere(identity)))
      .for('update')
      .limit(1);
    const ticket = rows[0];
    if (!ticket) throw notFound('Solicitação não encontrada.');
    return ticket;
  }

  private async lock(tx: Transaction, ticketId: string): Promise<SupportTicket> {
    const rows = await tx.select().from(supportTickets).where(eq(supportTickets.id, ticketId)).for('update').limit(1);
    const ticket = rows[0];
    if (!ticket) throw notFound('Solicitação não encontrada.');
    return ticket;
  }

  // -------------------------------------------------------------------------
  // App
  // -------------------------------------------------------------------------

  async createTicket(identity: SupportIdentity, body: CreateTicketBody) {
    await this.claimAnonymous(identity);

    const openCount = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(supportTickets)
      .where(and(this.visibleWhere(identity), sql`${supportTickets.status} <> 'resolved'`));
    if ((openCount[0]?.count ?? 0) >= MAX_OPEN_TICKETS) {
      throw conflict(ErrorCode.CONFLICT, 'Você já tem várias solicitações em aberto. Responda nelas antes de abrir outra.');
    }

    // A empresa atual do usuário dá contexto ao atendimento (assinatura,
    // equipe), mas só se ele realmente for membro dela.
    const workspaceId = typeof body.diagnostics['workspaceId'] === 'string' && identity.userId
      ? await this.memberWorkspace(identity.userId, body.diagnostics['workspaceId'])
      : null;

    const ticket = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(supportTickets)
        .values({
          userId: identity.userId,
          installId: identity.installId,
          workspaceId,
          contactEmail: identity.userId ? null : (body.contactEmail ?? null),
          contactName: body.contactName ?? null,
          category: body.category,
          subject: body.subject,
          status: 'open',
          device: body.device,
          diagnostics: body.diagnostics,
          appVersionCode: body.device.appVersionCode ?? null,
          messageCount: 1,
          lastMessageAt: new Date(),
          lastMessageBy: 'user',
          userSeenAt: new Date(),
        })
        .returning();
      const created = inserted[0];
      if (!created) throw new Error('Falha ao abrir solicitação');
      await tx.insert(supportMessages).values({ ticketId: created.id, author: 'user', body: body.message });
      return created;
    });

    await new AnalyticsService(this.services).trackServerEvent({
      name: AnalyticsEventName.SUPPORT_TICKET_OPENED,
      userId: identity.userId,
      workspaceId,
      deviceId: identity.deviceId,
      properties: { category: body.category, signedIn: identity.userId !== null, appVersionCode: body.device.appVersionCode ?? null },
    });

    return this.toUserView(ticket);
  }

  private async memberWorkspace(userId: string, workspaceId: string): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return null;
    const rows = await this.db.execute<{ id: string }>(sql`
      SELECT w.id FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ${userId} AND wm.workspace_id = ${workspaceId} AND wm.status = 'active' AND w.deleted_at IS NULL
      LIMIT 1
    `);
    return rows.rows[0]?.id ?? null;
  }

  async listForUser(identity: SupportIdentity) {
    await this.claimAnonymous(identity);
    const rows = await this.db
      .select()
      .from(supportTickets)
      .where(this.visibleWhere(identity))
      .orderBy(sql`${supportTickets.lastMessageAt} DESC`)
      .limit(100);
    return { tickets: rows.map((row) => this.toUserView(row)) };
  }

  async getForUser(identity: SupportIdentity, ticketId: string) {
    await this.claimAnonymous(identity);
    const ticket = await this.loadVisible(identity, ticketId);
    const messages = await this.db
      .select()
      .from(supportMessages)
      .where(and(eq(supportMessages.ticketId, ticketId), eq(supportMessages.internal, false)))
      .orderBy(supportMessages.createdAt)
      .limit(500);
    await this.db.update(supportTickets).set({ userSeenAt: new Date() }).where(eq(supportTickets.id, ticketId));
    return {
      ticket: this.toUserView({ ...ticket, userSeenAt: new Date() }),
      messages: messages.map((message) => this.toUserMessage(message)),
    };
  }

  async addUserMessage(identity: SupportIdentity, ticketId: string, text: string) {
    await this.claimAnonymous(identity);
    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      const ticket = await this.lockVisible(tx, identity, ticketId);
      const inserted = await tx.insert(supportMessages).values({ ticketId, author: 'user', body: text }).returning();
      const updated = await tx
        .update(supportTickets)
        .set({
          status: 'open',
          resolvedAt: null,
          resolvedBy: null,
          messageCount: sql`${supportTickets.messageCount} + 1`,
          lastMessageAt: now,
          lastMessageBy: 'user',
          userSeenAt: now,
        })
        .where(eq(supportTickets.id, ticketId))
        .returning();
      return { ticket: updated[0] ?? ticket, message: inserted[0] };
    });

    await new AnalyticsService(this.services).trackServerEvent({
      name: AnalyticsEventName.SUPPORT_MESSAGE_SENT,
      userId: identity.userId,
      deviceId: identity.deviceId,
      properties: { reopened: result.ticket.status === 'open' },
    });

    return { ticket: this.toUserView(result.ticket), message: result.message ? this.toUserMessage(result.message) : null };
  }

  async resolveByUser(identity: SupportIdentity, ticketId: string) {
    await this.claimAnonymous(identity);
    const now = new Date();
    const ticket = await this.db.transaction(async (tx) => {
      const current = await this.lockVisible(tx, identity, ticketId);
      if (current.status === 'resolved') return current;
      await tx.insert(supportMessages).values({ ticketId, author: SYSTEM_AUTHOR, body: 'Solicitação marcada como resolvida pelo usuário.' });
      const updated = await tx
        .update(supportTickets)
        .set({ status: 'resolved', resolvedAt: now, resolvedBy: 'user', messageCount: sql`${supportTickets.messageCount} + 1`, lastMessageAt: now, lastMessageBy: SYSTEM_AUTHOR, userSeenAt: now })
        .where(eq(supportTickets.id, ticketId))
        .returning();
      return updated[0] ?? current;
    });
    await new AnalyticsService(this.services).trackServerEvent({
      name: AnalyticsEventName.SUPPORT_TICKET_RESOLVED,
      userId: identity.userId,
      deviceId: identity.deviceId,
      properties: { by: 'user' },
    });
    return this.toUserView(ticket);
  }

  private toUserView(ticket: SupportTicket) {
    const unread =
      ticket.lastMessageBy !== 'user' && (ticket.userSeenAt === null || ticket.userSeenAt.getTime() < ticket.lastMessageAt.getTime());
    return {
      id: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      category: ticket.category,
      categoryLabel: CATEGORY_LABEL[ticket.category] ?? ticket.category,
      status: ticket.status,
      messageCount: ticket.messageCount,
      lastMessageAt: ticket.lastMessageAt.toISOString(),
      lastMessageBy: ticket.lastMessageBy,
      unread,
      createdAt: ticket.createdAt.toISOString(),
      resolvedAt: iso(ticket.resolvedAt),
    };
  }

  private toUserMessage(message: SupportMessage) {
    return {
      id: message.id,
      author: message.author === 'admin' ? 'support' : message.author,
      authorName: message.author === 'admin' ? (message.adminName ?? 'Equipe Estoque Simples') : null,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Painel
  // -------------------------------------------------------------------------

  async stats() {
    const rows = await this.db.execute<Record<string, string | null>>(sql`
      SELECT
        count(*) FILTER (WHERE status = 'open')::int AS open,
        count(*) FILTER (WHERE status = 'answered')::int AS answered,
        count(*) FILTER (WHERE status <> 'resolved' AND assigned_to IS NULL)::int AS unassigned,
        count(*) FILTER (WHERE status = 'open' AND last_message_at < now() - interval '24 hours')::int AS open_stale,
        count(*) FILTER (WHERE status = 'resolved' AND resolved_at > now() - interval '7 days')::int AS resolved_7d,
        count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_7d,
        count(*)::int AS total,
        avg(extract(epoch FROM first_response_at - created_at)) FILTER (WHERE first_response_at IS NOT NULL AND created_at > now() - interval '30 days') AS avg_first_response_s
      FROM support_tickets
    `);
    const categories = await this.db.execute<{ category: string; count: number }>(sql`
      SELECT category, count(*)::int AS count FROM support_tickets WHERE status <> 'resolved' GROUP BY 1 ORDER BY count DESC
    `);
    const r = rows.rows[0] ?? {};
    const n = (key: string) => Number(r[key] ?? 0);
    return {
      open: n('open'),
      answered: n('answered'),
      unassigned: n('unassigned'),
      openStale: n('open_stale'),
      resolved7d: n('resolved_7d'),
      new7d: n('new_7d'),
      total: n('total'),
      avgFirstResponseMinutes: r['avg_first_response_s'] ? Math.round(Number(r['avg_first_response_s']) / 60) : null,
      byCategory: categories.rows,
      openAiConfigured: (await readOpenAiKey(this.services)) !== null,
      fcmConfigured: this.services.fcm.configured,
    };
  }

  async list(
    actor: AdminActor,
    query: PaginationQuery & { status?: string; category?: string; priority?: string; assigned?: string; q?: string },
  ): Promise<Paginated<Record<string, unknown>>> {
    const conditions: SQL[] = [sql`true`];
    if (query.status === 'unresolved') conditions.push(sql`t.status <> 'resolved'`);
    else if (query.status) conditions.push(sql`t.status = ${query.status}`);
    if (query.category) conditions.push(sql`t.category = ${query.category}`);
    if (query.priority) conditions.push(sql`t.priority = ${query.priority}`);
    if (query.assigned === 'me') conditions.push(sql`t.assigned_to = ${actor.adminId}`);
    if (query.assigned === 'none') conditions.push(sql`t.assigned_to IS NULL`);
    if (query.q) {
      const term = `%${query.q}%`;
      const asNumber = /^#?\d+$/.test(query.q) ? Number(query.q.replace('#', '')) : null;
      conditions.push(sql`(t.subject ILIKE ${term} OR u.email ILIKE ${term} OR u.name ILIKE ${term} OR t.contact_email ILIKE ${term} OR t.install_id = ${query.q}
        OR t.number = ${asNumber}
        OR EXISTS (SELECT 1 FROM support_messages m WHERE m.ticket_id = t.id AND m.body ILIKE ${term}))`);
    }
    const where = sql.join(conditions, sql` AND `);
    const base = sql`FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE ${where}`;
    const [rows, total] = await Promise.all([
      this.db.execute<TicketRow>(sql`
        SELECT t.*, u.email AS user_email, u.name AS user_name
        ${base}
        ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END,
                 CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                 t.last_message_at DESC
        LIMIT ${query.pageSize} OFFSET ${offsetOf(query)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total ${base}`),
    ]);
    return {
      items: rows.rows.map((row) => this.toAdminView(row)),
      page: query.page,
      pageSize: query.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  async get(ticketId: string) {
    const rows = await this.db.execute<TicketRow>(sql`
      SELECT t.*, u.email AS user_email, u.name AS user_name, u.status AS user_status, u.created_at AS user_created_at,
             w.name AS workspace_name
      FROM support_tickets t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.id = ${ticketId}
    `);
    const row = rows.rows[0];
    if (!row) throw notFound('Solicitação não encontrada.');

    const messages = await this.db.select().from(supportMessages).where(eq(supportMessages.ticketId, ticketId)).orderBy(supportMessages.createdAt).limit(500);
    await this.db.update(supportTickets).set({ adminSeenAt: new Date() }).where(eq(supportTickets.id, ticketId));

    const userId = row['user_id'] as string | null;
    const [workspaces, others, devices] = await Promise.all([
      userId
        ? this.db.execute<{ id: string; name: string; role: string; plan: string | null; state: string | null }>(sql`
            SELECT w.id, w.name, wm.role_key AS role, s.plan_key AS plan, s.state
            FROM workspace_members wm
            JOIN workspaces w ON w.id = wm.workspace_id
            LEFT JOIN LATERAL (
              SELECT plan_key, state FROM subscriptions s WHERE s.workspace_id = w.id ORDER BY s.created_at DESC LIMIT 1
            ) s ON true
            WHERE wm.user_id = ${userId} AND wm.status = 'active' AND w.deleted_at IS NULL
            ORDER BY w.name LIMIT 10
          `)
        : Promise.resolve({ rows: [] as Array<{ id: string; name: string; role: string; plan: string | null; state: string | null }> }),
      this.db.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM support_tickets x
        WHERE x.id <> ${ticketId} AND (${userId ? sql`x.user_id = ${userId}` : sql`x.user_id IS NULL AND x.install_id = ${row['install_id'] as string}`})
      `),
      this.db.execute<{ count: number; muted: number }>(sql`
        SELECT count(*)::int AS count, count(*) FILTER (WHERE notifications_enabled = false)::int AS muted
        FROM push_tokens p WHERE p.revoked_at IS NULL AND (p.install_id = ${row['install_id'] as string}${userId ? sql` OR p.user_id = ${userId}` : sql``})
      `),
    ]);

    return {
      ...this.toAdminView(row),
      device: row['device'] ?? {},
      diagnostics: row['diagnostics'] ?? {},
      workspaceName: row['workspace_name'] ?? null,
      user: userId
        ? {
            id: userId,
            name: row['user_name'],
            email: row['user_email'],
            status: row['user_status'],
            createdAt: row['user_created_at'] ? new Date(row['user_created_at'] as string).toISOString() : null,
            workspaces: workspaces.rows,
          }
        : null,
      otherTickets: others.rows[0]?.count ?? 0,
      reachableDevices: devices.rows[0]?.count ?? 0,
      mutedDevices: devices.rows[0]?.muted ?? 0,
      messages: messages.map((message) => this.toAdminMessage(message)),
    };
  }

  async reply(actor: AdminActor, ticketId: string, body: string, internal: boolean) {
    const now = new Date();
    const admin = await this.db.select({ name: platformAdmins.name }).from(platformAdmins).where(eq(platformAdmins.id, actor.adminId)).limit(1);
    const adminName = admin[0]?.name?.trim().split(/\s+/)[0] ?? 'Suporte';

    const { ticket, message } = await this.db.transaction(async (tx) => {
      const current = await this.lock(tx, ticketId);
      const inserted = await tx
        .insert(supportMessages)
        .values({ ticketId, author: 'admin', adminId: actor.adminId, adminName, body, internal, notifyStatus: internal ? null : 'pending' })
        .returning();
      const saved = inserted[0];
      if (!saved) throw new Error('Falha ao gravar mensagem');

      let updated = current;
      if (internal) {
        await tx.update(supportTickets).set({ adminSeenAt: now }).where(eq(supportTickets.id, ticketId));
      } else {
        const rows = await tx
          .update(supportTickets)
          .set({
            status: 'answered',
            resolvedAt: null,
            resolvedBy: null,
            messageCount: sql`${supportTickets.messageCount} + 1`,
            lastMessageAt: now,
            lastMessageBy: 'admin',
            firstResponseAt: sql`coalesce(${supportTickets.firstResponseAt}, ${now})`,
            adminSeenAt: now,
            assignedTo: sql`coalesce(${supportTickets.assignedTo}, ${actor.adminId})`,
            assignedToEmail: sql`coalesce(${supportTickets.assignedToEmail}, ${actor.email})`,
          })
          .where(eq(supportTickets.id, ticketId))
          .returning();
        updated = rows[0] ?? current;
      }
      await recordAdminAudit(tx, {
        actor,
        action: internal ? AdminAction.SUPPORT_NOTE_ADDED : AdminAction.SUPPORT_REPLIED,
        targetType: 'support_ticket',
        targetId: ticketId,
        metadata: { number: current.number, length: body.length, userId: current.userId, reopened: current.status === 'resolved' && !internal },
      });
      return { ticket: updated, message: saved };
    });

    if (internal) return { ticket: this.toAdminView(entityToRow(ticket)), message: this.toAdminMessage(message) };

    const notify = await this.notifyUser(ticket, {
      title: `Resposta do suporte · #${ticket.number}`,
      body: excerpt(body),
      kind: 'reply',
      email: {
        subject: `Resposta à sua solicitação #${ticket.number} · Estoque Simples`,
        text: `Olá!\n\nSua solicitação "${ticket.subject}" recebeu uma resposta da equipe:\n\n${body}\n\nAbra o app Estoque Simples em Ajuda e suporte para continuar a conversa.`,
      },
    });
    await this.db
      .update(supportMessages)
      .set({ notifyStatus: notify.status, notifyDetail: notify.detail })
      .where(eq(supportMessages.id, message.id));

    return {
      ticket: this.toAdminView(entityToRow(ticket)),
      message: this.toAdminMessage({ ...message, notifyStatus: notify.status, notifyDetail: notify.detail }),
    };
  }

  async setStatus(actor: AdminActor, ticketId: string, status: SupportStatus, note?: string) {
    const now = new Date();
    const ticket = await this.db.transaction(async (tx) => {
      const current = await this.lock(tx, ticketId);
      if (current.status === status) throw conflict(ErrorCode.CONFLICT, 'A solicitação já está nesse estado.');
      const text =
        status === 'resolved'
          ? `Solicitação marcada como resolvida pela equipe.${note ? ` ${note}` : ''}`
          : current.status === 'resolved'
            ? `Solicitação reaberta pela equipe.${note ? ` ${note}` : ''}`
            : status === 'open'
              ? `Solicitação devolvida à fila.${note ? ` ${note}` : ''}`
              : `Solicitação marcada como respondida.${note ? ` ${note}` : ''}`;
      await tx.insert(supportMessages).values({ ticketId, author: SYSTEM_AUTHOR, body: text });
      const rows = await tx
        .update(supportTickets)
        .set({
          status,
          resolvedAt: status === 'resolved' ? now : null,
          resolvedBy: status === 'resolved' ? 'admin' : null,
          messageCount: sql`${supportTickets.messageCount} + 1`,
          lastMessageAt: now,
          lastMessageBy: SYSTEM_AUTHOR,
          adminSeenAt: now,
        })
        .where(eq(supportTickets.id, ticketId))
        .returning();
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.SUPPORT_STATUS_CHANGED,
        targetType: 'support_ticket',
        targetId: ticketId,
        metadata: { number: current.number, from: current.status, to: status, note: note ?? null, userId: current.userId },
      });
      return rows[0] ?? current;
    });

    if (status === 'resolved') {
      await this.notifyUser(ticket, {
        title: `Solicitação #${ticket.number} resolvida`,
        body: note ? excerpt(note) : `"${excerpt(ticket.subject, 80)}" foi encerrada. Se precisar, é só escrever de novo.`,
        kind: 'resolved',
        email: null,
      });
      await new AnalyticsService(this.services).trackServerEvent({
        name: AnalyticsEventName.SUPPORT_TICKET_RESOLVED,
        userId: ticket.userId,
        properties: { by: 'admin' },
      });
    }
    return this.toAdminView(entityToRow(ticket));
  }

  async update(actor: AdminActor, ticketId: string, patch: { priority?: string; category?: string; assign?: 'me' | 'none' }) {
    const ticket = await this.db.transaction(async (tx) => {
      const current = await this.lock(tx, ticketId);
      const changes: Partial<typeof supportTickets.$inferInsert> = {};
      if (patch.priority) changes.priority = patch.priority;
      if (patch.category) changes.category = patch.category;
      if (patch.assign === 'me') {
        changes.assignedTo = actor.adminId;
        changes.assignedToEmail = actor.email;
      } else if (patch.assign === 'none') {
        changes.assignedTo = null;
        changes.assignedToEmail = null;
      }
      const rows = await tx.update(supportTickets).set(changes).where(eq(supportTickets.id, ticketId)).returning();
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.SUPPORT_TICKET_UPDATED,
        targetType: 'support_ticket',
        targetId: ticketId,
        metadata: { number: current.number, ...patch },
      });
      return rows[0] ?? current;
    });
    return this.toAdminView(entityToRow(ticket));
  }

  async draft(actor: AdminActor, ticketId: string, instructions?: string): Promise<{ text: string; model: string }> {
    const apiKey = await readOpenAiKey(this.services);
    if (!apiKey) {
      throw new AppError(409, ErrorCode.CONFLICT, 'Configure a chave da OpenAI (em Avaliações) para gerar rascunhos.');
    }
    const rows = await this.db.execute<TicketRow>(sql`
      SELECT t.*, u.name AS user_name FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ${ticketId}
    `);
    const row = rows.rows[0];
    if (!row) throw notFound('Solicitação não encontrada.');
    const messages = await this.db
      .select()
      .from(supportMessages)
      .where(and(eq(supportMessages.ticketId, ticketId), eq(supportMessages.internal, false)))
      .orderBy(supportMessages.createdAt)
      .limit(200);

    const diagnostics = row['diagnostics'] as Record<string, unknown>;
    const diagnosticsText = Object.entries(diagnostics ?? {})
      .filter(([key]) => key !== 'workspaceId')
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ');

    const client = new OpenAiClient(apiKey, this.services.env.OPENAI_MODEL);
    const text = await client.draftSupportReply({
      subject: row['subject'] as string,
      category: CATEGORY_LABEL[row['category'] as string] ?? (row['category'] as string),
      userName: ((row['user_name'] ?? row['contact_name']) as string | null) ?? null,
      signedIn: row['user_id'] !== null,
      device: describeDevice((row['device'] as DeviceInfo) ?? {}),
      diagnostics: diagnosticsText || null,
      transcript: messages.slice(-12).map((message) => ({
        author: message.author === 'admin' ? 'suporte' : message.author === 'user' ? 'usuário' : 'sistema',
        body: message.body,
      })),
      instructions: instructions?.trim() || null,
      maxLength: SUPPORT_REPLY_MAX_LENGTH,
    });

    await recordAdminAudit(this.db, {
      actor,
      action: AdminAction.SUPPORT_DRAFT_GENERATED,
      targetType: 'support_ticket',
      targetId: ticketId,
      metadata: { model: this.services.env.OPENAI_MODEL, length: text.length },
    });
    return { text, model: this.services.env.OPENAI_MODEL };
  }

  // -------------------------------------------------------------------------
  // Notificação ao usuário
  // -------------------------------------------------------------------------

  /**
   * Avisa o aparelho por push (data message `type=support`). Sem aparelho
   * alcançável, cai para e-mail quando há endereço. Nunca lança: a resposta
   * já foi gravada e o resultado fica registrado na mensagem.
   */
  private async notifyUser(
    ticket: SupportTicket,
    notice: { title: string; body: string; kind: 'reply' | 'resolved'; email: { subject: string; text: string } | null },
  ): Promise<{ status: string; detail: string | null }> {
    const tokens = await this.db
      .select({ token: pushTokens.token, enabled: pushTokens.notificationsEnabled })
      .from(pushTokens)
      .where(
        and(
          isNull(pushTokens.revokedAt),
          ticket.userId
            ? sql`(${pushTokens.installId} = ${ticket.installId} OR ${pushTokens.userId} = ${ticket.userId})`
            : eq(pushTokens.installId, ticket.installId),
        ),
      )
      .limit(10);

    let accepted = 0;
    let failed = 0;
    let muted = 0;
    let lastError: string | null = null;

    if (this.services.fcm.configured && tokens.length > 0) {
      for (const row of tokens) {
        if (row.enabled === false) {
          muted += 1;
          continue;
        }
        try {
          const result = await this.services.fcm.send(row.token, {
            title: notice.title,
            body: notice.body,
            data: { type: 'support', ticketId: ticket.id, ticketNumber: String(ticket.number), event: notice.kind },
          });
          if (result.ok) {
            accepted += 1;
          } else {
            failed += 1;
            lastError = result.message;
            if (result.reason === 'unregistered' || result.reason === 'invalid') {
              await this.db
                .update(pushTokens)
                .set({ revokedAt: new Date(), revokeReason: result.reason })
                .where(eq(pushTokens.token, row.token));
            }
          }
        } catch (error) {
          failed += 1;
          lastError = error instanceof Error ? error.message : String(error);
          this.services.logger?.warn({ err: error, ticketId: ticket.id }, 'push de suporte não enviado');
        }
      }
    }

    if (accepted > 0) {
      return { status: 'push', detail: `${accepted} aparelho(s)${muted > 0 ? `, ${muted} com notificações desligadas` : ''}` };
    }

    if (notice.email) {
      const email = await this.contactEmail(ticket);
      if (email) {
        try {
          await this.services.mailer.send({ to: email, subject: notice.email.subject, text: notice.email.text, kind: 'support_reply' });
          return {
            status: 'email',
            detail: !this.services.fcm.configured
              ? 'Firebase não configurado; avisado por e-mail'
              : tokens.length === 0
                ? 'nenhum aparelho registrado; avisado por e-mail'
                : muted > 0 && failed === 0
                  ? 'notificações desligadas no aparelho; avisado por e-mail'
                  : `push falhou (${lastError ?? 'sem detalhe'}); avisado por e-mail`,
          };
        } catch (error) {
          this.services.logger?.warn({ err: error, ticketId: ticket.id }, 'e-mail de suporte não enviado');
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    if (!this.services.fcm.configured) return { status: 'none', detail: 'Firebase não configurado' };
    if (tokens.length === 0) return { status: 'none', detail: 'nenhum aparelho registrado para avisar' };
    if (muted > 0 && failed === 0) return { status: 'muted', detail: 'notificações desligadas no aparelho' };
    return { status: 'failed', detail: lastError ?? 'push recusado' };
  }

  private async contactEmail(ticket: SupportTicket): Promise<string | null> {
    if (ticket.userId) {
      const rows = await this.db.select({ email: users.email }).from(users).where(eq(users.id, ticket.userId)).limit(1);
      return rows[0]?.email ?? null;
    }
    return ticket.contactEmail ?? null;
  }

  // -------------------------------------------------------------------------
  // Views do painel
  // -------------------------------------------------------------------------

  private toAdminView(row: TicketRow) {
    const at = (key: string) => (row[key] ? new Date(row[key] as string).toISOString() : null);
    const lastMessageAt = new Date(row['last_message_at'] as string).getTime();
    const adminSeenAt = row['admin_seen_at'] ? new Date(row['admin_seen_at'] as string).getTime() : null;
    const device = (row['device'] ?? {}) as DeviceInfo;
    return {
      id: row['id'],
      number: row['number'],
      subject: row['subject'],
      category: row['category'],
      status: row['status'],
      priority: row['priority'],
      userId: row['user_id'] ?? null,
      userEmail: row['user_email'] ?? null,
      userName: row['user_name'] ?? null,
      contactEmail: row['contact_email'] ?? null,
      contactName: row['contact_name'] ?? null,
      installId: row['install_id'],
      workspaceId: row['workspace_id'] ?? null,
      deviceSummary: describeDevice(device),
      appVersionCode: row['app_version_code'] ?? null,
      assignedTo: row['assigned_to'] ?? null,
      assignedToEmail: row['assigned_to_email'] ?? null,
      messageCount: row['message_count'],
      lastMessageAt: at('last_message_at'),
      lastMessageBy: row['last_message_by'],
      unread: row['last_message_by'] === 'user' && (adminSeenAt === null || adminSeenAt < lastMessageAt),
      firstResponseAt: at('first_response_at'),
      resolvedAt: at('resolved_at'),
      resolvedBy: row['resolved_by'] ?? null,
      createdAt: at('created_at'),
      updatedAt: at('updated_at'),
    };
  }

  private toAdminMessage(message: SupportMessage) {
    return {
      id: message.id,
      author: message.author,
      adminId: message.adminId,
      adminName: message.adminName,
      body: message.body,
      internal: message.internal,
      notifyStatus: message.notifyStatus,
      notifyDetail: message.notifyDetail,
      createdAt: message.createdAt.toISOString(),
    };
  }
}
