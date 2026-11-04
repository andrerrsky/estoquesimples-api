import { eq, sql } from 'drizzle-orm';

import { settingAad } from '../../platform/crypto/purchase-token.js';
import { adminSettings, appConfig, playReviews } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { AppError, ErrorCode, badRequest, notFound } from '../../platform/http/errors.js';
import type { PlayReview } from '../billing/play-client.js';
import { AdminAction, recordAdminAudit, type AdminActor } from '../admin/admin-audit.service.js';
import { offsetOf, type Paginated, type PaginationQuery } from '../admin/admin.schemas.js';
import { OpenAiClient } from './openai-client.js';
import { CsvFormatError, parsePlayReviewsCsv } from './play-reviews-csv.js';

/** Limite do Google para a resposta do desenvolvedor. */
export const REPLY_MAX_LENGTH = 350;

export const SETTING_OPENAI_KEY = 'openai_api_key';

/** Resultado da última coleta (app_config), para o painel dizer se o Google respondeu e o que devolveu. */
const LAST_SYNC_KEY = 'play_reviews_sync';

export interface ReviewsSyncRecord {
  at: string;
  fetched: number;
  created: number;
  updated: number;
  error: string | null;
}

/** Chave da OpenAI guardada pelo painel (cifrada), ou null se não há. */
export async function readOpenAiKey(services: AppServices): Promise<string | null> {
  const rows = await services.db
    .select({ valueEnc: adminSettings.valueEnc })
    .from(adminSettings)
    .where(eq(adminSettings.key, SETTING_OPENAI_KEY))
    .limit(1);
  const row = rows[0];
  return row ? services.purchaseTokens.decrypt(row.valueEnc, settingAad(SETTING_OPENAI_KEY)) : null;
}

export interface ReviewListFilters extends PaginationQuery {
  status?: 'unanswered' | 'answered';
  rating?: number;
  q?: string;
}

function toDate(stamp: { seconds?: string | number } | undefined): Date | null {
  if (!stamp?.seconds) return null;
  return new Date(Number(stamp.seconds) * 1000);
}

/**
 * Avaliações da Play Store: cópia local, resposta e rascunho por IA.
 *
 * A resposta sai sempre pelo Google primeiro; a linha local só muda depois
 * que ele aceitou. A chave da OpenAI vive cifrada em `admin_settings` com a
 * mesma chave AES dos demais segredos em repouso e nunca volta em claro para
 * o painel — só "configurada" e os últimos quatro caracteres.
 */
export class ReviewsService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  // -------------------------------------------------------------------------
  // Coleta
  // -------------------------------------------------------------------------

  async sync(): Promise<{ fetched: number; created: number; updated: number }> {
    const { playClient } = this.services;
    if (!playClient.configured) {
      throw new AppError(503, ErrorCode.BILLING_UNAVAILABLE, 'Google Play não configurado neste ambiente.');
    }
    try {
      const result = await this.fetchAll();
      await this.recordSync({ ...result, error: null });
      return result;
    } catch (error) {
      await this.recordSync({ fetched: 0, created: 0, updated: 0, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async fetchAll(): Promise<{ fetched: number; created: number; updated: number }> {
    const { playClient } = this.services;
    let pageToken: string | null = null;
    let fetched = 0;
    let created = 0;
    let updated = 0;
    // Teto de páginas: a API devolve no máximo 7 dias, mas nunca se sabe.
    for (let page = 0; page < 20; page += 1) {
      const result = await playClient.listReviews(pageToken);
      for (const review of result.reviews) {
        const outcome = await this.upsert(review);
        fetched += 1;
        if (outcome === 'created') created += 1;
        else if (outcome === 'updated') updated += 1;
      }
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }
    return { fetched, created, updated };
  }

  private async recordSync(record: Omit<ReviewsSyncRecord, 'at'>): Promise<void> {
    const value: ReviewsSyncRecord = { ...record, error: record.error?.slice(0, 500) ?? null, at: new Date().toISOString() };
    try {
      await this.db
        .insert(appConfig)
        .values({ key: LAST_SYNC_KEY, value, updatedAt: new Date() })
        .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: new Date() } });
    } catch (error) {
      this.services.logger?.warn({ err: error }, 'não foi possível registrar a coleta de avaliações');
    }
  }

  async lastSync(): Promise<ReviewsSyncRecord | null> {
    const rows = await this.db.select({ value: appConfig.value }).from(appConfig).where(eq(appConfig.key, LAST_SYNC_KEY)).limit(1);
    return (rows[0]?.value as ReviewsSyncRecord | undefined) ?? null;
  }

  private async upsert(review: PlayReview): Promise<'created' | 'updated' | 'unchanged'> {
    const user = review.comments?.find((comment) => comment.userComment)?.userComment;
    const developer = review.comments?.find((comment) => comment.developerComment)?.developerComment;
    if (!user || !user.starRating) return 'unchanged';

    const userAt = toDate(user.lastModified);
    const developerAt = toDate(developer?.lastModified);
    const lastModifiedAt =
      userAt && developerAt ? new Date(Math.max(userAt.getTime(), developerAt.getTime())) : (developerAt ?? userAt);

    const device = user.deviceMetadata?.productName
      ? `${user.deviceMetadata.manufacturer ? `${user.deviceMetadata.manufacturer} ` : ''}${user.deviceMetadata.productName}`
      : (user.device ?? null);

    const existing = await this.db
      .select({ lastModifiedAt: playReviews.lastModifiedAt, replyText: playReviews.developerReplyText })
      .from(playReviews)
      .where(eq(playReviews.reviewId, review.reviewId))
      .limit(1);

    const values = {
      reviewId: review.reviewId,
      authorName: review.authorName ?? null,
      starRating: user.starRating,
      text: user.text ?? null,
      language: user.reviewerLanguage ?? null,
      device,
      androidOsVersion: user.androidOsVersion !== undefined ? String(user.androidOsVersion) : null,
      appVersionCode: user.appVersionCode ?? null,
      appVersionName: user.appVersionName ?? null,
      userCommentAt: userAt,
      lastModifiedAt,
      developerReplyText: developer?.text ?? null,
      developerReplyAt: developerAt,
      raw: review as unknown as Record<string, unknown>,
      fetchedAt: new Date(),
    };

    await this.db
      .insert(playReviews)
      .values(values)
      .onConflictDoUpdate({
        target: playReviews.reviewId,
        set: {
          authorName: sql`coalesce(excluded.author_name, ${playReviews.authorName})`,
          starRating: values.starRating,
          text: values.text,
          language: values.language,
          device: values.device,
          androidOsVersion: values.androidOsVersion,
          appVersionCode: values.appVersionCode,
          appVersionName: values.appVersionName,
          userCommentAt: values.userCommentAt,
          lastModifiedAt: values.lastModifiedAt,
          // A resposta vinda do Google vale mais que a local: se alguém
          // respondeu pelo Play Console, é isso que o usuário vê.
          developerReplyText: values.developerReplyText,
          developerReplyAt: values.developerReplyAt,
          raw: values.raw,
          fetchedAt: values.fetchedAt,
        },
      });

    const previous = existing[0];
    if (!previous) return 'created';
    const changed =
      previous.lastModifiedAt?.getTime() !== lastModifiedAt?.getTime() ||
      (previous.replyText ?? null) !== (values.developerReplyText ?? null);
    return changed ? 'updated' : 'unchanged';
  }

  // -------------------------------------------------------------------------
  // Importação do relatório da Play Console (histórico)
  // -------------------------------------------------------------------------

  /**
   * Importa um relatório mensal de avaliações da Play Console. Avaliação que
   * já está aqui só é atualizada quando o relatório é mais novo que a cópia
   * local (a coleta pela API costuma estar à frente) e nunca perde o nome de
   * quem avaliou, que o relatório não traz.
   */
  async importCsv(content: string): Promise<{ rows: number; created: number; updated: number; unchanged: number; withoutText: number; withoutId: number; otherPackage: number }> {
    let parsed;
    try {
      parsed = parsePlayReviewsCsv(content, this.services.env.GOOGLE_PLAY_PACKAGE_NAME || null);
    } catch (error) {
      if (error instanceof CsvFormatError) throw badRequest(ErrorCode.VALIDATION_FAILED, error.message);
      throw error;
    }
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const review of parsed.reviews) {
      const existing = await this.db
        .select({ lastModifiedAt: playReviews.lastModifiedAt })
        .from(playReviews)
        .where(eq(playReviews.reviewId, review.reviewId))
        .limit(1);
      const previous = existing[0];
      if (previous?.lastModifiedAt && review.lastModifiedAt && previous.lastModifiedAt >= review.lastModifiedAt) {
        unchanged += 1;
        continue;
      }
      const values = {
        reviewId: review.reviewId,
        starRating: review.starRating,
        text: review.text,
        language: review.language,
        device: review.device,
        appVersionCode: review.appVersionCode,
        appVersionName: review.appVersionName,
        userCommentAt: review.userCommentAt,
        lastModifiedAt: review.lastModifiedAt,
        developerReplyText: review.developerReplyText,
        developerReplyAt: review.developerReplyAt,
        raw: { origem: 'relatorio_play_console', link: review.link },
        fetchedAt: new Date(),
      };
      await this.db
        .insert(playReviews)
        .values(values)
        .onConflictDoUpdate({
          target: playReviews.reviewId,
          set: {
            starRating: values.starRating,
            text: values.text,
            language: values.language,
            device: sql`coalesce(excluded.device, ${playReviews.device})`,
            appVersionCode: sql`coalesce(excluded.app_version_code, ${playReviews.appVersionCode})`,
            appVersionName: sql`coalesce(excluded.app_version_name, ${playReviews.appVersionName})`,
            userCommentAt: values.userCommentAt,
            lastModifiedAt: values.lastModifiedAt,
            developerReplyText: values.developerReplyText,
            developerReplyAt: values.developerReplyAt,
            fetchedAt: values.fetchedAt,
          },
        });
      if (previous) updated += 1;
      else created += 1;
    }
    return {
      rows: parsed.reviews.length + parsed.withoutText + parsed.withoutId + parsed.otherPackage,
      created,
      updated,
      unchanged,
      withoutText: parsed.withoutText,
      withoutId: parsed.withoutId,
      otherPackage: parsed.otherPackage,
    };
  }

  // -------------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------------

  async stats() {
    const rows = await this.db.execute<Record<string, string>>(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE developer_reply_text IS NOT NULL)::int AS answered,
        count(*) FILTER (WHERE developer_reply_text IS NULL)::int AS unanswered,
        count(*) FILTER (WHERE developer_reply_text IS NULL AND star_rating <= 2)::int AS unanswered_negative,
        count(*) FILTER (WHERE replied_via_panel)::int AS answered_via_panel,
        round(avg(star_rating)::numeric, 2)::text AS average,
        count(*) FILTER (WHERE star_rating = 5)::int AS r5,
        count(*) FILTER (WHERE star_rating = 4)::int AS r4,
        count(*) FILTER (WHERE star_rating = 3)::int AS r3,
        count(*) FILTER (WHERE star_rating = 2)::int AS r2,
        count(*) FILTER (WHERE star_rating = 1)::int AS r1,
        max(fetched_at) AS last_fetched_at,
        count(*) FILTER (WHERE user_comment_at > now() - interval '30 days')::int AS last_30d
      FROM play_reviews
    `);
    const r = rows.rows[0] ?? {};
    const n = (key: string) => Number(r[key] ?? 0);
    return {
      total: n('total'),
      answered: n('answered'),
      unanswered: n('unanswered'),
      unansweredNegative: n('unanswered_negative'),
      answeredViaPanel: n('answered_via_panel'),
      average: r['average'] ? Number(r['average']) : null,
      distribution: { 5: n('r5'), 4: n('r4'), 3: n('r3'), 2: n('r2'), 1: n('r1') },
      last30d: n('last_30d'),
      lastFetchedAt: r['last_fetched_at'] ? new Date(r['last_fetched_at']).toISOString() : null,
      lastSync: await this.lastSync(),
      playConfigured: this.services.playClient.configured,
      openAiConfigured: (await this.readSetting(SETTING_OPENAI_KEY)) !== null,
    };
  }

  async list(filters: ReviewListFilters): Promise<Paginated<Record<string, unknown>>> {
    const conditions = [sql`true`];
    if (filters.status === 'unanswered') conditions.push(sql`r.developer_reply_text IS NULL`);
    if (filters.status === 'answered') conditions.push(sql`r.developer_reply_text IS NOT NULL`);
    if (filters.rating) conditions.push(sql`r.star_rating = ${filters.rating}`);
    if (filters.q) {
      const term = `%${filters.q.toLowerCase()}%`;
      conditions.push(sql`(lower(coalesce(r.text,'')) LIKE ${term} OR lower(coalesce(r.author_name,'')) LIKE ${term})`);
    }
    const where = sql.join(conditions, sql` AND `);

    const [rows, total] = await Promise.all([
      this.db.execute<Record<string, unknown>>(sql`
        SELECT r.review_id, r.author_name, r.star_rating, r.text, r.language, r.device, r.android_os_version,
               r.app_version_code, r.app_version_name, r.user_comment_at, r.last_modified_at,
               r.developer_reply_text, r.developer_reply_at, r.replied_via_panel, a.email AS replied_by
        FROM play_reviews r
        LEFT JOIN platform_admins a ON a.id = r.replied_by_admin_id
        WHERE ${where}
        ORDER BY (r.developer_reply_text IS NULL) DESC, r.last_modified_at DESC NULLS LAST
        LIMIT ${filters.pageSize} OFFSET ${offsetOf(filters)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM play_reviews r WHERE ${where}`),
    ]);

    return {
      items: rows.rows.map((row) => ({
        reviewId: row['review_id'],
        authorName: row['author_name'],
        starRating: row['star_rating'],
        text: row['text'],
        language: row['language'],
        device: row['device'],
        androidOsVersion: row['android_os_version'],
        appVersionCode: row['app_version_code'],
        appVersionName: row['app_version_name'],
        userCommentAt: row['user_comment_at'] ? new Date(row['user_comment_at'] as string).toISOString() : null,
        lastModifiedAt: row['last_modified_at'] ? new Date(row['last_modified_at'] as string).toISOString() : null,
        developerReplyText: row['developer_reply_text'],
        developerReplyAt: row['developer_reply_at'] ? new Date(row['developer_reply_at'] as string).toISOString() : null,
        repliedViaPanel: row['replied_via_panel'],
        repliedBy: row['replied_by'],
      })),
      page: filters.page,
      pageSize: filters.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Resposta
  // -------------------------------------------------------------------------

  async reply(actor: AdminActor, reviewId: string, text: string): Promise<void> {
    const cleaned = text.trim();
    if (cleaned.length === 0) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Escreva a resposta.');
    if (cleaned.length > REPLY_MAX_LENGTH) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, `A Play Store aceita no máximo ${REPLY_MAX_LENGTH} caracteres.`);
    }
    const rows = await this.db.select().from(playReviews).where(eq(playReviews.reviewId, reviewId)).limit(1);
    const review = rows[0];
    if (!review) throw notFound('Avaliação não encontrada.');

    // Google primeiro: se ele recusar, nada muda localmente.
    await this.services.playClient.replyToReview(reviewId, cleaned);

    await this.db.transaction(async (tx) => {
      await tx
        .update(playReviews)
        .set({
          developerReplyText: cleaned,
          developerReplyAt: new Date(),
          repliedViaPanel: true,
          repliedByAdminId: actor.adminId,
          lastModifiedAt: new Date(),
        })
        .where(eq(playReviews.reviewId, reviewId));
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.REVIEW_REPLIED,
        targetType: 'review',
        targetId: reviewId,
        metadata: {
          starRating: review.starRating,
          previousReply: review.developerReplyText,
          reply: cleaned,
        },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Rascunho por IA
  // -------------------------------------------------------------------------

  async draft(actor: AdminActor, reviewId: string, instructions?: string): Promise<{ text: string; model: string }> {
    const apiKey = await this.readSetting(SETTING_OPENAI_KEY);
    if (!apiKey) {
      throw new AppError(409, ErrorCode.CONFLICT, 'Configure a chave da OpenAI para gerar rascunhos.');
    }
    const rows = await this.db.select().from(playReviews).where(eq(playReviews.reviewId, reviewId)).limit(1);
    const review = rows[0];
    if (!review) throw notFound('Avaliação não encontrada.');

    const client = new OpenAiClient(apiKey, this.services.env.OPENAI_MODEL);
    const text = await client.draftReviewReply({
      starRating: review.starRating,
      text: review.text ?? '',
      authorName: review.authorName,
      appVersionName: review.appVersionName,
      language: review.language,
      previousReply: review.developerReplyText,
      instructions: instructions?.trim() || null,
      maxLength: REPLY_MAX_LENGTH,
    });

    await recordAdminAudit(this.db, {
      actor,
      action: AdminAction.REVIEW_DRAFT_GENERATED,
      targetType: 'review',
      targetId: reviewId,
      metadata: { model: this.services.env.OPENAI_MODEL, length: text.length },
    });

    return { text, model: this.services.env.OPENAI_MODEL };
  }

  // -------------------------------------------------------------------------
  // Configuração da OpenAI
  // -------------------------------------------------------------------------

  async openAiStatus(): Promise<{ configured: boolean; hint: string | null; updatedAt: string | null; model: string }> {
    const rows = await this.db
      .select({ valueEnc: adminSettings.valueEnc, updatedAt: adminSettings.updatedAt })
      .from(adminSettings)
      .where(eq(adminSettings.key, SETTING_OPENAI_KEY))
      .limit(1);
    const row = rows[0];
    if (!row) return { configured: false, hint: null, updatedAt: null, model: this.services.env.OPENAI_MODEL };
    const key = this.services.purchaseTokens.decrypt(row.valueEnc, settingAad(SETTING_OPENAI_KEY));
    return {
      configured: true,
      hint: `…${key.slice(-4)}`,
      updatedAt: row.updatedAt.toISOString(),
      model: this.services.env.OPENAI_MODEL,
    };
  }

  /** Testa a chave guardada com uma chamada real ao modelo (ver `OpenAiClient.ping`). */
  async testOpenAiKey(): Promise<{ ok: true; model: string; ms: number }> {
    const key = await this.readSetting(SETTING_OPENAI_KEY);
    if (!key) throw notFound('Nenhuma chave da OpenAI configurada.');
    const model = this.services.env.OPENAI_MODEL;
    const started = Date.now();
    await new OpenAiClient(key, model).ping();
    return { ok: true, model, ms: Date.now() - started };
  }

  async setOpenAiKey(actor: AdminActor, apiKey: string): Promise<void> {
    const cleaned = apiKey.trim();
    if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(cleaned)) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Isso não parece uma chave da OpenAI (começa com "sk-").');
    }
    // Valida antes de guardar: uma chave errada só apareceria na primeira
    // tentativa de rascunho, longe de quem a digitou.
    await new OpenAiClient(cleaned, this.services.env.OPENAI_MODEL).verify();

    await this.db.transaction(async (tx) => {
      await tx
        .insert(adminSettings)
        .values({ key: SETTING_OPENAI_KEY, valueEnc: this.services.purchaseTokens.encrypt(cleaned, settingAad(SETTING_OPENAI_KEY)), updatedBy: actor.adminId })
        .onConflictDoUpdate({
          target: adminSettings.key,
          set: { valueEnc: this.services.purchaseTokens.encrypt(cleaned, settingAad(SETTING_OPENAI_KEY)), updatedAt: new Date(), updatedBy: actor.adminId },
        });
      await recordAdminAudit(tx, {
        actor,
        action: AdminAction.SETTING_UPDATED,
        targetType: 'setting',
        targetId: SETTING_OPENAI_KEY,
        metadata: { hint: `…${cleaned.slice(-4)}` },
      });
    });
  }

  async removeOpenAiKey(actor: AdminActor): Promise<void> {
    await this.db.transaction(async (tx) => {
      const deleted = await tx.delete(adminSettings).where(eq(adminSettings.key, SETTING_OPENAI_KEY)).returning({ key: adminSettings.key });
      if (deleted.length === 0) throw notFound('Nenhuma chave configurada.');
      await recordAdminAudit(tx, { actor, action: AdminAction.SETTING_REMOVED, targetType: 'setting', targetId: SETTING_OPENAI_KEY });
    });
  }

  private async readSetting(key: string): Promise<string | null> {
    const rows = await this.db
      .select({ valueEnc: adminSettings.valueEnc })
      .from(adminSettings)
      .where(eq(adminSettings.key, key))
      .limit(1);
    const row = rows[0];
    return row ? this.services.purchaseTokens.decrypt(row.valueEnc, settingAad(key)) : null;
  }
}

