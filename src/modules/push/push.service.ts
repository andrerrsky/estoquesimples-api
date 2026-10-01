import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { pushCampaigns, pushDeliveries, pushTokens } from '../../platform/db/schema/index.js';
import type { Transaction } from '../../platform/db/client.js';
import type { AppServices } from '../../platform/http/context.js';
import { AppError, ErrorCode, badRequest, conflict, notFound } from '../../platform/http/errors.js';
import { enqueueJob } from '../../platform/jobs/runner.js';
import { ENTITLED_STATES } from '../billing/billing.service.js';
import { ACTIVITY_SQL, sqlList } from '../admin/admin-series.js';
import { AdminAction, recordAdminAudit, type AdminActor } from '../admin/admin-audit.service.js';
import { offsetOf, type Paginated, type PaginationQuery } from '../admin/admin.schemas.js';
import { PUSH_SEND_CAMPAIGN_JOB } from './push.jobs.js';
import type { Audience, CampaignBody } from './push.schemas.js';

export interface TokenRegistration {
  token: string;
  installId: string;
  platform: 'android' | 'ios' | 'web';
  appVersionCode?: number;
  locale?: string;
  notificationsEnabled?: boolean;
  userId: string | null;
  deviceId: string | null;
}

/** Descrição legível do público, gravada na campanha para o histórico. */
export function describeAudience(audience: Audience, activeWithinDays: number): string {
  const base = (() => {
    switch (audience.type) {
      case 'all':
        return 'Todos os aparelhos';
      case 'signed_in':
        return 'Aparelhos com conta';
      case 'anonymous':
        return 'Aparelhos sem conta';
      case 'subscription':
        return audience.entitled ? 'Usuários com assinatura ativa' : 'Usuários sem assinatura ativa';
      case 'inactive':
        return `Usuários sem atividade há ${audience.days} dias`;
      case 'app_version':
        return `Aparelhos com app até a versão ${audience.maxVersionCode}`;
      case 'users':
        return audience.emails.length === 1 ? `Usuário ${audience.emails[0]}` : `${audience.emails.length} usuários específicos`;
      case 'workspace':
        return 'Membros de uma empresa';
    }
  })();
  return `${base} · vistos nos últimos ${activeWithinDays} dias`;
}

/**
 * Push notifications: registro de tokens, campanhas e o funil de entrega.
 *
 * O envio roda num job (uma campanha pode ter milhares de tokens); o painel
 * só marca a campanha como `queued`. O job resolve o público na hora,
 * grava uma linha por token em `push_deliveries` e envia com concorrência
 * limitada. Tokens que o FCM diz não existirem mais são revogados.
 */
export class PushService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  // -------------------------------------------------------------------------
  // App: tokens e eventos
  // -------------------------------------------------------------------------

  async registerToken(input: TokenRegistration): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Um aparelho tem um token válido por vez: os anteriores da mesma
      // instalação saem de circulação para a campanha não chegar em dobro.
      await tx
        .update(pushTokens)
        .set({ revokedAt: new Date(), revokeReason: 'replaced' })
        .where(and(eq(pushTokens.installId, input.installId), sql`${pushTokens.token} <> ${input.token}`, isNull(pushTokens.revokedAt)));

      await tx
        .insert(pushTokens)
        .values({
          token: input.token,
          installId: input.installId,
          userId: input.userId,
          deviceId: input.deviceId,
          platform: input.platform,
          appVersionCode: input.appVersionCode ?? null,
          locale: input.locale ?? null,
          notificationsEnabled: input.notificationsEnabled ?? null,
          lastSeenAt: new Date(),
        })
        .onConflictDoUpdate({
          target: pushTokens.token,
          set: {
            installId: input.installId,
            // Sem sessão, mantém o dono anterior: o token continua sendo do
            // mesmo aparelho, que provavelmente só está deslogado.
            userId: input.userId ?? sql`${pushTokens.userId}`,
            deviceId: input.deviceId ?? sql`${pushTokens.deviceId}`,
            platform: input.platform,
            appVersionCode: input.appVersionCode ?? null,
            locale: input.locale ?? null,
            notificationsEnabled: input.notificationsEnabled ?? null,
            lastSeenAt: new Date(),
            revokedAt: null,
            revokeReason: null,
          },
        });
    });
  }

  async recordEvent(input: { campaignId: string; installId: string; event: 'delivered' | 'opened' }): Promise<boolean> {
    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ token: pushDeliveries.token, status: pushDeliveries.status })
        .from(pushDeliveries)
        .where(and(eq(pushDeliveries.campaignId, input.campaignId), eq(pushDeliveries.installId, input.installId)))
        .limit(5);
      const row = rows.find((item) => item.status !== 'failed');
      if (!row) return false;

      if (input.event === 'delivered') {
        if (row.status === 'delivered' || row.status === 'opened') return false;
        await tx
          .update(pushDeliveries)
          .set({ status: 'delivered', deliveredAt: now })
          .where(and(eq(pushDeliveries.campaignId, input.campaignId), eq(pushDeliveries.token, row.token)));
        await tx
          .update(pushCampaigns)
          .set({ delivered: sql`${pushCampaigns.delivered} + 1` })
          .where(eq(pushCampaigns.id, input.campaignId));
        return true;
      }

      if (row.status === 'opened') return false;
      const wasDelivered = row.status === 'delivered';
      await tx
        .update(pushDeliveries)
        .set({ status: 'opened', openedAt: now, deliveredAt: sql`coalesce(${pushDeliveries.deliveredAt}, ${now})` })
        .where(and(eq(pushDeliveries.campaignId, input.campaignId), eq(pushDeliveries.token, row.token)));
      await tx
        .update(pushCampaigns)
        .set({
          opened: sql`${pushCampaigns.opened} + 1`,
          // Abrir implica ter recebido, mesmo que o "entregue" tenha se perdido.
          delivered: wasDelivered ? sql`${pushCampaigns.delivered}` : sql`${pushCampaigns.delivered} + 1`,
        })
        .where(eq(pushCampaigns.id, input.campaignId));
      return true;
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // Público
  // -------------------------------------------------------------------------

  private audienceWhere(audience: Audience, activeWithinDays: number): SQL {
    const conditions: SQL[] = [
      sql`t.revoked_at IS NULL`,
      sql`t.last_seen_at > now() - ${`${activeWithinDays} days`}::interval`,
      sql`coalesce(t.notifications_enabled, true)`,
    ];
    switch (audience.type) {
      case 'all':
        break;
      case 'signed_in':
        conditions.push(sql`t.user_id IS NOT NULL`);
        break;
      case 'anonymous':
        conditions.push(sql`t.user_id IS NULL`);
        break;
      case 'subscription': {
        const entitled = sql`EXISTS (
          SELECT 1 FROM workspace_members wm
          JOIN subscriptions s ON s.workspace_id = wm.workspace_id
          WHERE wm.user_id = t.user_id AND wm.status = 'active' AND s.state IN ${sqlList(ENTITLED_STATES)}
        )`;
        conditions.push(audience.entitled ? sql`t.user_id IS NOT NULL AND ${entitled}` : sql`(t.user_id IS NULL OR NOT ${entitled})`);
        break;
      }
      case 'inactive':
        conditions.push(sql`t.user_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM (${ACTIVITY_SQL}) a
          WHERE a.user_id = t.user_id AND a.at > now() - ${`${audience.days} days`}::interval
        )`);
        break;
      case 'app_version':
        conditions.push(sql`t.app_version_code IS NOT NULL AND t.app_version_code <= ${audience.maxVersionCode}`);
        break;
      case 'users':
        // Lista parametrizada (sqlList): o driver não serializa arrays JS
        // como array do Postgres dentro de um template.
        conditions.push(sql`t.user_id IN (
          SELECT id FROM users WHERE deleted_at IS NULL
            AND lower(email) IN ${sqlList(audience.emails.map((email) => email.toLowerCase()))}
        )`);
        break;
      case 'workspace':
        conditions.push(sql`t.user_id IN (
          SELECT user_id FROM workspace_members WHERE workspace_id = ${audience.workspaceId} AND status = 'active'
        )`);
        break;
    }
    return sql.join(conditions, sql` AND `);
  }

  async previewAudience(audience: Audience, activeWithinDays: number) {
    const where = this.audienceWhere(audience, activeWithinDays);
    const rows = await this.db.execute<{ total: number; signed_in: number; installs: number; users: number }>(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE t.user_id IS NOT NULL)::int AS signed_in,
             count(DISTINCT t.install_id)::int AS installs,
             count(DISTINCT t.user_id)::int AS users
      FROM push_tokens t WHERE ${where}
    `);
    const versions = await this.db.execute<{ version: string; count: number }>(sql`
      SELECT coalesce(t.app_version_code::text, '?') AS version, count(*)::int AS count
      FROM push_tokens t WHERE ${where} GROUP BY 1 ORDER BY count DESC LIMIT 6
    `);
    const row = rows.rows[0];
    return {
      total: row?.total ?? 0,
      signedIn: row?.signed_in ?? 0,
      installs: row?.installs ?? 0,
      users: row?.users ?? 0,
      versions: versions.rows,
      label: describeAudience(audience, activeWithinDays),
    };
  }

  // -------------------------------------------------------------------------
  // Campanhas
  // -------------------------------------------------------------------------

  async stats() {
    const rows = await this.db.execute<Record<string, string>>(sql`
      SELECT
        (SELECT count(*) FROM push_tokens WHERE revoked_at IS NULL AND last_seen_at > now() - interval '90 days') AS reachable,
        (SELECT count(*) FROM push_tokens WHERE revoked_at IS NULL AND last_seen_at > now() - interval '90 days' AND user_id IS NOT NULL) AS reachable_signed_in,
        (SELECT count(*) FROM push_tokens WHERE revoked_at IS NULL AND last_seen_at > now() - interval '90 days' AND notifications_enabled = false) AS reachable_muted,
        (SELECT count(*) FROM push_tokens WHERE created_at > now() - interval '7 days') AS new_7d,
        (SELECT count(*) FROM push_campaigns WHERE status = 'sent' AND NOT is_test) AS campaigns_sent,
        (SELECT coalesce(sum(targeted), 0) FROM push_campaigns WHERE status = 'sent' AND NOT is_test) AS targeted,
        (SELECT coalesce(sum(accepted), 0) FROM push_campaigns WHERE status = 'sent' AND NOT is_test) AS accepted,
        (SELECT coalesce(sum(delivered), 0) FROM push_campaigns WHERE status = 'sent' AND NOT is_test) AS delivered,
        (SELECT coalesce(sum(opened), 0) FROM push_campaigns WHERE status = 'sent' AND NOT is_test) AS opened,
        (SELECT count(*) FROM push_campaigns WHERE status IN ('queued','sending')) AS in_progress
    `);
    const r = rows.rows[0] ?? {};
    const n = (key: string) => Number(r[key] ?? 0);
    return {
      reachable: n('reachable'),
      reachableSignedIn: n('reachable_signed_in'),
      reachableMuted: n('reachable_muted'),
      new7d: n('new_7d'),
      campaignsSent: n('campaigns_sent'),
      targeted: n('targeted'),
      accepted: n('accepted'),
      delivered: n('delivered'),
      opened: n('opened'),
      inProgress: n('in_progress'),
      fcmConfigured: this.services.fcm.configured,
      projectId: this.services.fcm.projectId,
    };
  }

  async listCampaigns(query: PaginationQuery & { status?: string; includeTests?: boolean }): Promise<Paginated<Record<string, unknown>>> {
    const conditions = [sql`true`];
    if (query.status) conditions.push(sql`c.status = ${query.status}`);
    if (!query.includeTests) conditions.push(sql`NOT c.is_test`);
    const where = sql.join(conditions, sql` AND `);
    const [rows, total] = await Promise.all([
      this.db.execute<Record<string, unknown>>(sql`
        SELECT c.* FROM push_campaigns c WHERE ${where}
        ORDER BY c.created_at DESC LIMIT ${query.pageSize} OFFSET ${offsetOf(query)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM push_campaigns c WHERE ${where}`),
    ]);
    return {
      items: rows.rows.map((row) => this.toView(row)),
      page: query.page,
      pageSize: query.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  async getCampaign(id: string) {
    const rows = await this.db.execute<Record<string, unknown>>(sql`SELECT * FROM push_campaigns WHERE id = ${id}`);
    const row = rows.rows[0];
    if (!row) throw notFound('Campanha não encontrada.');
    const failures = await this.db.execute<{ error: string; count: number }>(sql`
      SELECT coalesce(error, 'desconhecido') AS error, count(*)::int AS count
      FROM push_deliveries WHERE campaign_id = ${id} AND status = 'failed'
      GROUP BY 1 ORDER BY count DESC LIMIT 8
    `);
    const timeline = await this.db.execute<{ hour: string; delivered: number; opened: number }>(sql`
      SELECT to_char(date_trunc('hour', coalesce(opened_at, delivered_at) AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD HH24:00') AS hour,
             count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
             count(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened
      FROM push_deliveries WHERE campaign_id = ${id} AND (delivered_at IS NOT NULL OR opened_at IS NOT NULL)
      GROUP BY 1 ORDER BY 1 LIMIT 96
    `);
    return { ...this.toView(row), failures: failures.rows, timeline: timeline.rows };
  }

  async listDeliveries(campaignId: string, query: PaginationQuery & { status?: string }) {
    const conditions = [sql`d.campaign_id = ${campaignId}`];
    if (query.status) conditions.push(sql`d.status = ${query.status}`);
    const where = sql.join(conditions, sql` AND `);
    const [rows, total] = await Promise.all([
      this.db.execute<Record<string, unknown>>(sql`
        SELECT d.install_id, d.user_id, u.email, d.status, d.error, d.accepted_at, d.delivered_at, d.opened_at,
               t.platform, t.app_version_code
        FROM push_deliveries d
        LEFT JOIN users u ON u.id = d.user_id
        LEFT JOIN push_tokens t ON t.token = d.token
        WHERE ${where}
        ORDER BY coalesce(d.opened_at, d.delivered_at, d.accepted_at) DESC NULLS LAST
        LIMIT ${query.pageSize} OFFSET ${offsetOf(query)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM push_deliveries d WHERE ${where}`),
    ]);
    return {
      items: rows.rows.map((row) => ({
        installId: row['install_id'],
        userId: row['user_id'],
        email: row['email'],
        status: row['status'],
        error: row['error'],
        platform: row['platform'],
        appVersionCode: row['app_version_code'],
        acceptedAt: row['accepted_at'] ? new Date(row['accepted_at'] as string).toISOString() : null,
        deliveredAt: row['delivered_at'] ? new Date(row['delivered_at'] as string).toISOString() : null,
        openedAt: row['opened_at'] ? new Date(row['opened_at'] as string).toISOString() : null,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  async createCampaign(actor: AdminActor, body: CampaignBody, options: { isTest?: boolean } = {}) {
    const preview = await this.previewAudience(body.audience, body.activeWithinDays);
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(pushCampaigns)
        .values({
          title: body.title,
          body: body.body,
          action: body.action,
          audience: { ...body.audience, activeWithinDays: body.activeWithinDays },
          audienceLabel: preview.label,
          status: 'draft',
          isTest: options.isTest ?? false,
          targeted: preview.total,
          createdBy: actor.adminId,
          createdByEmail: actor.email,
        })
        .returning();
      const campaign = inserted[0];
      if (!campaign) throw new Error('Falha ao criar campanha');
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.PUSH_CAMPAIGN_CREATED,
        targetType: 'push_campaign',
        targetId: campaign.id,
        metadata: { title: campaign.title, audience: campaign.audienceLabel, estimated: preview.total, isTest: campaign.isTest },
      });
      return this.toView(campaign as unknown as Record<string, unknown>);
    });
  }

  async updateCampaign(actor: AdminActor, id: string, body: CampaignBody) {
    const preview = await this.previewAudience(body.audience, body.activeWithinDays);
    return this.db.transaction(async (tx) => {
      const campaign = await this.lock(tx, id);
      if (campaign.status !== 'draft') throw conflict(ErrorCode.CONFLICT, 'Só rascunhos podem ser editados.');
      const updated = await tx
        .update(pushCampaigns)
        .set({
          title: body.title,
          body: body.body,
          action: body.action,
          audience: { ...body.audience, activeWithinDays: body.activeWithinDays },
          audienceLabel: preview.label,
          targeted: preview.total,
        })
        .where(eq(pushCampaigns.id, id))
        .returning();
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.PUSH_CAMPAIGN_UPDATED,
        targetType: 'push_campaign',
        targetId: id,
        metadata: { title: body.title, audience: preview.label, estimated: preview.total },
      });
      return this.toView(updated[0] as unknown as Record<string, unknown>);
    });
  }

  /** Coloca a campanha na fila; o job faz o envio. */
  async send(actor: AdminActor, id: string): Promise<void> {
    if (!this.services.fcm.configured) {
      throw new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, 'Firebase não configurado neste ambiente.');
    }
    await this.db.transaction(async (tx) => {
      const campaign = await this.lock(tx, id);
      if (campaign.status !== 'draft') throw conflict(ErrorCode.CONFLICT, 'Esta campanha já foi enviada ou está na fila.');
      await tx.update(pushCampaigns).set({ status: 'queued' }).where(eq(pushCampaigns.id, id));
      await enqueueJob(tx, {
        kind: PUSH_SEND_CAMPAIGN_JOB,
        payload: { campaignId: id },
        uniqueKey: `${PUSH_SEND_CAMPAIGN_JOB}:${id}`,
        maxAttempts: 3,
      });
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.PUSH_CAMPAIGN_SENT,
        targetType: 'push_campaign',
        targetId: id,
        metadata: { title: campaign.title, audience: campaign.audienceLabel, estimated: campaign.targeted },
      });
    });
  }

  /** Envio de teste: cria a campanha marcada como teste e envia na hora. */
  async sendTest(actor: AdminActor, body: CampaignBody, email: string) {
    if (!this.services.fcm.configured) {
      throw new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, 'Firebase não configurado neste ambiente.');
    }
    const test: CampaignBody = { ...body, audience: { type: 'users', emails: [email] }, activeWithinDays: 365 };
    const created = await this.createCampaign(actor, test, { isTest: true });
    if ((created['targeted'] as number) === 0) {
      await this.db.delete(pushCampaigns).where(eq(pushCampaigns.id, created['id'] as string));
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Nenhum aparelho registrado para este e-mail. Abra o app com essa conta antes.');
    }
    await this.db.update(pushCampaigns).set({ status: 'queued' }).where(eq(pushCampaigns.id, created['id'] as string));
    const result = await this.deliver(created['id'] as string);
    await recordAdminAudit(this.db, {
      actor,
      action: AdminAction.PUSH_TEST_SENT,
      targetType: 'push_campaign',
      targetId: created['id'] as string,
      metadata: { email, ...result },
    });
    return { campaignId: created['id'], ...result };
  }

  async cancel(actor: AdminActor, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const campaign = await this.lock(tx, id);
      if (!['queued', 'sending'].includes(campaign.status)) {
        throw conflict(ErrorCode.CONFLICT, 'Só campanhas na fila ou em envio podem ser canceladas.');
      }
      await tx.update(pushCampaigns).set({ status: 'cancelled', completedAt: new Date() }).where(eq(pushCampaigns.id, id));
      await recordAdminAudit(tx, { actor, action: AdminAction.PUSH_CAMPAIGN_CANCELLED, targetType: 'push_campaign', targetId: id, metadata: { title: campaign.title } });
    });
  }

  async deleteCampaign(actor: AdminActor, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const campaign = await this.lock(tx, id);
      if (campaign.status !== 'draft' && !campaign.isTest) {
        throw conflict(ErrorCode.CONFLICT, 'Campanhas enviadas ficam no histórico e não podem ser apagadas.');
      }
      await tx.delete(pushCampaigns).where(eq(pushCampaigns.id, id));
      await recordAdminAudit(tx, { actor, action: AdminAction.PUSH_CAMPAIGN_DELETED, targetType: 'push_campaign', targetId: id, metadata: { title: campaign.title } });
    });
  }

  // -------------------------------------------------------------------------
  // Envio (executado pelo job)
  // -------------------------------------------------------------------------

  async deliver(campaignId: string): Promise<{ targeted: number; accepted: number; failed: number }> {
    const rows = await this.db.select().from(pushCampaigns).where(eq(pushCampaigns.id, campaignId)).limit(1);
    const campaign = rows[0];
    if (!campaign) throw notFound('Campanha não encontrada.');
    if (campaign.status === 'cancelled') return { targeted: 0, accepted: 0, failed: 0 };
    if (campaign.status !== 'queued' && campaign.status !== 'sending') {
      throw conflict(ErrorCode.CONFLICT, `Campanha em estado ${campaign.status}; nada a enviar.`);
    }

    const spec = campaign.audience as Audience & { activeWithinDays?: number };
    const { activeWithinDays = 90, ...audience } = spec;
    const where = this.audienceWhere(audience as Audience, activeWithinDays);

    // Resolve o público e cria as linhas de entrega antes do primeiro envio:
    // se o processo cair no meio, a retomada sabe o que já foi aceito.
    await this.db.execute(sql`
      INSERT INTO push_deliveries (campaign_id, token, install_id, user_id, status)
      SELECT ${campaignId}, t.token, t.install_id, t.user_id, 'pending'
      FROM push_tokens t WHERE ${where}
      ON CONFLICT DO NOTHING
    `);
    const targetedRow = await this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM push_deliveries WHERE campaign_id = ${campaignId}`);
    const targeted = targetedRow.rows[0]?.total ?? 0;
    await this.db
      .update(pushCampaigns)
      .set({ status: 'sending', targeted, startedAt: campaign.startedAt ?? new Date() })
      .where(eq(pushCampaigns.id, campaignId));

    const action = campaign.action as { screen?: string | null; url?: string | null };
    const message = { campaignId, title: campaign.title, body: campaign.body, screen: action.screen ?? null, url: action.url ?? null };
    const concurrency = this.services.env.PUSH_SEND_CONCURRENCY;
    let accepted = 0;
    let failed = 0;

    for (;;) {
      const status = await this.db.select({ status: pushCampaigns.status }).from(pushCampaigns).where(eq(pushCampaigns.id, campaignId)).limit(1);
      if (status[0]?.status === 'cancelled') break;

      const batch = await this.db
        .select({ token: pushDeliveries.token })
        .from(pushDeliveries)
        .where(and(eq(pushDeliveries.campaignId, campaignId), eq(pushDeliveries.status, 'pending')))
        .limit(concurrency * 4);
      if (batch.length === 0) break;

      for (let i = 0; i < batch.length; i += concurrency) {
        const slice = batch.slice(i, i + concurrency);
        const results = await Promise.all(
          slice.map(async ({ token }) => {
            try {
              return { token, result: await this.services.fcm.send(token, message) };
            } catch (error) {
              // 401/403 do Firebase: credencial errada. Sem sentido continuar.
              throw error;
            }
          }),
        );
        for (const { token, result } of results) {
          if (result.ok) {
            accepted += 1;
            await this.db
              .update(pushDeliveries)
              .set({ status: 'accepted', acceptedAt: new Date() })
              .where(and(eq(pushDeliveries.campaignId, campaignId), eq(pushDeliveries.token, token)));
          } else {
            failed += 1;
            await this.db
              .update(pushDeliveries)
              .set({ status: 'failed', error: result.reason })
              .where(and(eq(pushDeliveries.campaignId, campaignId), eq(pushDeliveries.token, token)));
            if (result.reason === 'unregistered' || result.reason === 'invalid') {
              await this.db
                .update(pushTokens)
                .set({ revokedAt: new Date(), revokeReason: result.reason })
                .where(and(eq(pushTokens.token, token), isNull(pushTokens.revokedAt)));
            }
          }
        }
        await this.db
          .update(pushCampaigns)
          .set({ accepted: sql`${pushCampaigns.accepted} + ${slice.filter((_, index) => results[index]?.result.ok).length}`, failed: sql`${pushCampaigns.failed} + ${slice.filter((_, index) => !results[index]?.result.ok).length}` })
          .where(eq(pushCampaigns.id, campaignId));
      }
    }

    const final = await this.db.select({ status: pushCampaigns.status }).from(pushCampaigns).where(eq(pushCampaigns.id, campaignId)).limit(1);
    if (final[0]?.status !== 'cancelled') {
      await this.db
        .update(pushCampaigns)
        .set({ status: 'sent', completedAt: new Date() })
        .where(eq(pushCampaigns.id, campaignId));
    }
    return { targeted, accepted, failed };
  }

  async markFailed(campaignId: string, error: string): Promise<void> {
    await this.db
      .update(pushCampaigns)
      .set({ status: 'failed', error: error.slice(0, 1000), completedAt: new Date() })
      .where(and(eq(pushCampaigns.id, campaignId), sql`${pushCampaigns.status} IN ('queued', 'sending')`));
  }

  private async lock(tx: Transaction, id: string) {
    const rows = await tx.select().from(pushCampaigns).where(eq(pushCampaigns.id, id)).limit(1).for('update');
    const campaign = rows[0];
    if (!campaign) throw notFound('Campanha não encontrada.');
    return campaign;
  }

  private toView(row: Record<string, unknown>) {
    const date = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
    const pick = (camel: string, snake: string) => (row[camel] !== undefined ? row[camel] : row[snake]);
    return {
      id: row['id'],
      title: row['title'],
      body: row['body'],
      action: row['action'] ?? {},
      audience: row['audience'],
      audienceLabel: pick('audienceLabel', 'audience_label'),
      status: row['status'],
      isTest: pick('isTest', 'is_test'),
      targeted: pick('targeted', 'targeted'),
      accepted: row['accepted'],
      failed: row['failed'],
      delivered: row['delivered'],
      opened: row['opened'],
      error: row['error'],
      createdByEmail: pick('createdByEmail', 'created_by_email'),
      createdAt: date(pick('createdAt', 'created_at')),
      startedAt: date(pick('startedAt', 'started_at')),
      completedAt: date(pick('completedAt', 'completed_at')),
    };
  }
}

