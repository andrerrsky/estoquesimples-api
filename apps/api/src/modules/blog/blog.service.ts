import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';

import { adminSettings, blogPosts, pushTokens } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { AppError, ErrorCode, badRequest, conflict, notFound } from '../../platform/http/errors.js';
import { enqueueJob } from '../../platform/jobs/runner.js';
import { blogCoverKey } from '../../platform/storage/object-storage.js';
import { AdminAction, recordAdminAudit, type AdminActor } from '../admin/admin-audit.service.js';
import { normalizeImage } from '../images/image-processing.js';
import { dispatchPush, pushTargetColumns } from '../push/push-dispatch.js';
import { BLOG_CATEGORIES, blogCategory } from './blog.categories.js';
import { DEFAULT_BLOG_SETTINGS, blogSettingsSchema, type BlogListQuery, type BlogPostBody, type BlogSettings } from './blog.schemas.js';
import { readingMinutes, renderMarkdown, slugify } from './markdown.js';

export const BLOG_NOTIFY_JOB = 'blog.notify_post';
const SETTINGS_KEY = 'blog_settings';
/** Push só para aparelhos vistos nos últimos N dias (tokens mortos gastam cota à toa). */
const PUSH_ACTIVE_DAYS = 90;

type PostRow = typeof blogPosts.$inferSelect;

/** O que a web, o app e o painel recebem de um post. */
export interface BlogPostView {
  id: string;
  slug: string;
  title: string;
  seoTitle: string | null;
  excerpt: string;
  contentHtml: string;
  contentMd?: string;
  category: { slug: string; label: string };
  tags: string[];
  faq: Array<{ question: string; answer: string }>;
  status: 'draft' | 'published';
  publishedAt: string | null;
  updatedAt: string;
  createdAt: string;
  /** Capa enviada no painel ou, sem ela, a capa gerada pela API (ver blog-cover.ts). */
  coverUrl: string | null;
  /** `true` quando a capa é a gerada (o painel sabe que não há imagem enviada). */
  coverAuto: boolean;
  coverAlt: string | null;
  authorName: string;
  readingMinutes: number;
  aiGenerated: boolean;
  aiModel?: string | null;
  aiTopic?: string | null;
  notifiedAt?: string | null;
  url: string;
}

export class BlogService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  private siteUrl(): string {
    return (this.services.env.WEB_APP_URL ?? 'https://estoquesimples.com.br').replace(/\/$/, '');
  }

  toView(row: PostRow, options: { withSource?: boolean } = {}): BlogPostView {
    const category = blogCategory(row.category) ?? { slug: row.category, label: row.category };
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      seoTitle: row.seoTitle,
      excerpt: row.excerpt,
      contentHtml: row.contentHtml,
      ...(options.withSource ? { contentMd: row.contentMd, aiModel: row.aiModel, aiTopic: row.aiTopic, notifiedAt: row.notifiedAt?.toISOString() ?? null } : {}),
      category: { slug: category.slug, label: category.label },
      tags: row.tags ?? [],
      faq: row.faq ?? [],
      status: row.status,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      coverUrl: row.coverHash ? `/v1/blog/covers/${row.coverHash}.webp` : `/v1/blog/covers/auto/${row.slug}.webp`,
      coverAuto: !row.coverHash,
      coverAlt: row.coverAlt ?? (row.coverHash ? null : `${row.title} — ${category.label}, no blog do Estoque Simples`),
      authorName: row.authorName,
      readingMinutes: row.readingMinutes,
      aiGenerated: row.aiGenerated,
      url: `${this.siteUrl()}/blog/${row.slug}`,
    };
  }

  // -------------------------------------------------------------------------
  // Leitura pública
  // -------------------------------------------------------------------------

  private publishedWhere(query: BlogListQuery) {
    const conditions = [eq(blogPosts.status, 'published'), isNotNull(blogPosts.publishedAt)];
    if (query.category) conditions.push(eq(blogPosts.category, query.category));
    if (query.month) {
      conditions.push(sql`to_char(${blogPosts.publishedAt} AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') = ${query.month}`);
    }
    if (query.q) {
      const like = `%${query.q}%`;
      conditions.push(sql`(${blogPosts.title} ILIKE ${like} OR ${blogPosts.excerpt} ILIKE ${like} OR ${blogPosts.tags}::text ILIKE ${like})`);
    }
    return and(...conditions);
  }

  async listPublished(query: BlogListQuery): Promise<{ items: BlogPostView[]; total: number; page: number; pageSize: number }> {
    const where = this.publishedWhere(query);
    const [rows, count] = await Promise.all([
      this.db
        .select()
        .from(blogPosts)
        .where(where)
        .orderBy(desc(blogPosts.publishedAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.db.select({ total: sql<number>`count(*)::int` }).from(blogPosts).where(where),
    ]);
    return {
      items: rows.map((row) => ({ ...this.toView(row), contentHtml: '' })),
      total: count[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** Meses com post publicado (filtro por data) e quantos por categoria. */
  async facets(): Promise<{ months: Array<{ month: string; count: number }>; categories: Array<{ slug: string; label: string; description: string; count: number }> }> {
    const months = await this.db.execute<{ month: string; count: number }>(sql`
      SELECT to_char(published_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS month, count(*)::int AS count
      FROM blog_posts WHERE status = 'published' AND published_at IS NOT NULL
      GROUP BY 1 ORDER BY 1 DESC LIMIT 36
    `);
    const byCategory = await this.db.execute<{ category: string; count: number }>(sql`
      SELECT category, count(*)::int AS count FROM blog_posts WHERE status = 'published' GROUP BY 1
    `);
    const counts = new Map(byCategory.rows.map((row) => [row.category, row.count]));
    return {
      months: months.rows,
      categories: BLOG_CATEGORIES.map((category) => ({ ...category, count: counts.get(category.slug) ?? 0 })),
    };
  }

  async getPublished(slug: string): Promise<BlogPostView | null> {
    const rows = await this.db
      .select()
      .from(blogPosts)
      .where(and(eq(blogPosts.slug, slug), eq(blogPosts.status, 'published')))
      .limit(1);
    return rows[0] ? this.toView(rows[0]) : null;
  }

  /** Posts da mesma categoria para "leia também"; faltando, os mais novos das outras. */
  async related(post: BlogPostView, limit = 3): Promise<BlogPostView[]> {
    const rows = await this.db
      .select()
      .from(blogPosts)
      .where(and(eq(blogPosts.status, 'published'), sql`${blogPosts.id} <> ${post.id}`))
      .orderBy(sql`(${blogPosts.category} = ${post.category.slug}) desc`, desc(blogPosts.publishedAt))
      .limit(limit);
    return rows.map((row) => ({ ...this.toView(row), contentHtml: '' }));
  }

  /** Para o sitemap e o feed. */
  async allPublished(limit = 500): Promise<BlogPostView[]> {
    const rows = await this.db.select().from(blogPosts).where(eq(blogPosts.status, 'published')).orderBy(desc(blogPosts.publishedAt)).limit(limit);
    return rows.map((row) => this.toView(row));
  }

  async readCover(hash: string): Promise<Buffer | null> {
    if (!/^[0-9a-f]{64}$/.test(hash) || !this.services.storage.configured) return null;
    try {
      return await this.services.storage.get(blogCoverKey(hash));
    } catch (error) {
      this.services.logger?.warn({ err: error, hash }, 'capa do blog não pôde ser lida');
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Painel
  // -------------------------------------------------------------------------

  async listAll(query: { status?: 'draft' | 'published'; q?: string; page: number; pageSize: number }) {
    const conditions = [sql`true`];
    if (query.status) conditions.push(eq(blogPosts.status, query.status));
    if (query.q) conditions.push(sql`(${blogPosts.title} ILIKE ${`%${query.q}%`} OR ${blogPosts.slug} ILIKE ${`%${query.q}%`})`);
    const where = and(...conditions);
    const [rows, count] = await Promise.all([
      this.db
        .select()
        .from(blogPosts)
        .where(where)
        .orderBy(sql`coalesce(${blogPosts.publishedAt}, ${blogPosts.createdAt}) DESC`)
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.db.select({ total: sql<number>`count(*)::int` }).from(blogPosts).where(where),
    ]);
    return { items: rows.map((row) => ({ ...this.toView(row, { withSource: false }), contentHtml: '' })), total: count[0]?.total ?? 0, page: query.page, pageSize: query.pageSize };
  }

  async getById(id: string): Promise<BlogPostView> {
    const rows = await this.db.select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1);
    if (!rows[0]) throw notFound('Post não encontrado.');
    return this.toView(rows[0], { withSource: true });
  }

  private async uniqueSlug(base: string, exceptId?: string): Promise<string> {
    const root = slugify(base) || 'post';
    let candidate = root;
    for (let n = 2; n < 50; n += 1) {
      const rows = await this.db.select({ id: blogPosts.id }).from(blogPosts).where(eq(blogPosts.slug, candidate)).limit(1);
      if (!rows[0] || rows[0].id === exceptId) return candidate;
      candidate = `${root}-${n}`;
    }
    throw conflict(ErrorCode.CONFLICT, 'Não foi possível gerar um endereço único para este post.');
  }

  private fieldsFrom(body: BlogPostBody) {
    const rendered = renderMarkdown(body.contentMd);
    if (rendered.words < 80) throw badRequest(ErrorCode.VALIDATION_FAILED, 'O texto está curto demais: escreva pelo menos 80 palavras.');
    return {
      title: body.title,
      seoTitle: body.seoTitle?.trim() || null,
      excerpt: body.excerpt,
      contentMd: body.contentMd,
      contentHtml: rendered.html,
      category: body.category,
      tags: dedupeTags(body.tags),
      faq: body.faq,
      coverAlt: body.coverAlt?.trim() || null,
      readingMinutes: readingMinutes(rendered.words),
      ...(body.authorName ? { authorName: body.authorName } : {}),
    };
  }

  async create(actor: AdminActor | null, body: BlogPostBody, options: { ai?: { model: string; topic: string } } = {}): Promise<BlogPostView> {
    const slug = await this.uniqueSlug(body.slug ?? body.title);
    const inserted = await this.db
      .insert(blogPosts)
      .values({
        ...this.fieldsFrom(body),
        slug,
        status: 'draft',
        aiGenerated: Boolean(options.ai),
        aiModel: options.ai?.model ?? null,
        aiTopic: options.ai?.topic ?? null,
        createdBy: actor?.adminId ?? null,
      })
      .returning();
    const post = inserted[0];
    if (!post) throw new Error('Falha ao criar o post');
    if (actor) {
      await recordAdminAudit(this.db, { actor, action: AdminAction.BLOG_POST_CREATED, targetType: 'blog_post', targetId: post.id, metadata: { title: post.title, slug: post.slug } });
    }
    return this.toView(post, { withSource: true });
  }

  async update(actor: AdminActor, id: string, body: BlogPostBody): Promise<BlogPostView> {
    const current = await this.getById(id);
    const slug = body.slug && body.slug !== current.slug ? await this.uniqueSlug(body.slug, id) : current.slug;
    const updated = await this.db
      .update(blogPosts)
      .set({ ...this.fieldsFrom(body), slug, updatedAt: new Date() })
      .where(eq(blogPosts.id, id))
      .returning();
    const post = updated[0];
    if (!post) throw notFound('Post não encontrado.');
    await recordAdminAudit(this.db, { actor, action: AdminAction.BLOG_POST_UPDATED, targetType: 'blog_post', targetId: id, metadata: { title: post.title, slug: post.slug } });
    return this.toView(post, { withSource: true });
  }

  /**
   * Publica (ou republica). O aviso a todo mundo sai uma vez só por post,
   * pela fila: despublicar e publicar de novo não manda outro push.
   */
  async publish(actor: AdminActor | null, id: string, options: { notify?: boolean } = {}): Promise<BlogPostView> {
    const settings = await this.settings();
    const notify = options.notify ?? settings.notifyOnPublish;
    const post = await this.db.transaction(async (tx) => {
      const rows = await tx.select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1).for('update');
      const current = rows[0];
      if (!current) throw notFound('Post não encontrado.');
      const updated = await tx
        .update(blogPosts)
        .set({ status: 'published', publishedAt: current.publishedAt ?? new Date(), updatedAt: new Date() })
        .where(eq(blogPosts.id, id))
        .returning();
      const published = updated[0]!;
      if (notify && !published.notifiedAt) {
        await enqueueJob(tx, { kind: BLOG_NOTIFY_JOB, payload: { postId: id }, uniqueKey: `${BLOG_NOTIFY_JOB}:${id}`, maxAttempts: 3 });
      }
      if (actor) {
        await recordAdminAudit(tx, { actor, action: AdminAction.BLOG_POST_PUBLISHED, targetType: 'blog_post', targetId: id, metadata: { title: published.title, slug: published.slug, notify } });
      }
      return published;
    });
    return this.toView(post, { withSource: true });
  }

  async unpublish(actor: AdminActor, id: string): Promise<BlogPostView> {
    const updated = await this.db.update(blogPosts).set({ status: 'draft', updatedAt: new Date() }).where(eq(blogPosts.id, id)).returning();
    const post = updated[0];
    if (!post) throw notFound('Post não encontrado.');
    await recordAdminAudit(this.db, { actor, action: AdminAction.BLOG_POST_UNPUBLISHED, targetType: 'blog_post', targetId: id, metadata: { title: post.title } });
    return this.toView(post, { withSource: true });
  }

  async remove(actor: AdminActor, id: string): Promise<void> {
    const deleted = await this.db.delete(blogPosts).where(eq(blogPosts.id, id)).returning({ title: blogPosts.title, slug: blogPosts.slug, coverHash: blogPosts.coverHash });
    const post = deleted[0];
    if (!post) throw notFound('Post não encontrado.');
    if (post.coverHash && this.services.storage.configured) {
      await this.services.storage.delete(blogCoverKey(post.coverHash)).catch(() => undefined);
    }
    await recordAdminAudit(this.db, { actor, action: AdminAction.BLOG_POST_DELETED, targetType: 'blog_post', targetId: id, metadata: { title: post.title, slug: post.slug } });
  }

  /** Capa: imagem reduzida e guardada no bucket, com o hash como nome (ver docs/images.md). */
  async setCover(actor: AdminActor, id: string, bytes: Buffer, contentType: string): Promise<BlogPostView> {
    if (!this.services.storage.configured) {
      throw new AppError(503, ErrorCode.IMAGES_UNAVAILABLE, 'O armazenamento de imagens não está disponível agora.');
    }
    await this.getById(id);
    // A capa sai sempre em 1200×630: é o tamanho que as metatags, o JSON-LD e o <img> declaram.
    const normalized = await normalizeImage(bytes, contentType, { maxEdge: 1600, maxBytes: 6 * 1024 * 1024, cover: { width: 1200, height: 630 } });
    try {
      await this.services.storage.put(blogCoverKey(normalized.hash), normalized.bytes, normalized.contentType);
    } catch (error) {
      throw new AppError(503, ErrorCode.IMAGES_UNAVAILABLE, 'Não foi possível guardar a capa agora. Tente de novo em instantes.', { cause: error, expected: false });
    }
    const updated = await this.db.update(blogPosts).set({ coverHash: normalized.hash, updatedAt: new Date() }).where(eq(blogPosts.id, id)).returning();
    await recordAdminAudit(this.db, { actor, action: AdminAction.BLOG_POST_UPDATED, targetType: 'blog_post', targetId: id, metadata: { cover: normalized.hash } });
    return this.toView(updated[0]!, { withSource: true });
  }

  async removeCover(actor: AdminActor, id: string): Promise<BlogPostView> {
    const current = await this.getById(id);
    const updated = await this.db.update(blogPosts).set({ coverHash: null, updatedAt: new Date() }).where(eq(blogPosts.id, id)).returning();
    const hash = current.coverUrl?.match(/([0-9a-f]{64})/)?.[1];
    if (hash && this.services.storage.configured) await this.services.storage.delete(blogCoverKey(hash)).catch(() => undefined);
    await recordAdminAudit(this.db, { actor, action: AdminAction.BLOG_POST_UPDATED, targetType: 'blog_post', targetId: id, metadata: { cover: null } });
    return this.toView(updated[0]!, { withSource: true });
  }

  /** Markdown → HTML sem gravar, para a prévia do editor. */
  preview(markdown: string): { html: string; words: number; readingMinutes: number } {
    const rendered = renderMarkdown(markdown);
    return { html: rendered.html, words: rendered.words, readingMinutes: readingMinutes(rendered.words) };
  }

  // -------------------------------------------------------------------------
  // Configurações
  // -------------------------------------------------------------------------

  async settings(): Promise<BlogSettings> {
    const rows = await this.db.select({ valueEnc: adminSettings.valueEnc }).from(adminSettings).where(eq(adminSettings.key, SETTINGS_KEY)).limit(1);
    if (!rows[0]) return DEFAULT_BLOG_SETTINGS;
    try {
      return blogSettingsSchema.parse(JSON.parse(this.services.purchaseTokens.decrypt(rows[0].valueEnc)));
    } catch {
      return DEFAULT_BLOG_SETTINGS;
    }
  }

  async saveSettings(actor: AdminActor, settings: BlogSettings): Promise<BlogSettings> {
    const valueEnc = this.services.purchaseTokens.encrypt(JSON.stringify(settings));
    await this.db
      .insert(adminSettings)
      .values({ key: SETTINGS_KEY, valueEnc })
      .onConflictDoUpdate({ target: adminSettings.key, set: { valueEnc, updatedAt: new Date() } });
    await recordAdminAudit(this.db, { actor, action: AdminAction.SETTING_UPDATED, targetType: 'setting', targetId: SETTINGS_KEY, metadata: settings });
    return settings;
  }

  // -------------------------------------------------------------------------
  // Aviso de post novo (executado pelo job)
  // -------------------------------------------------------------------------

  /**
   * Caixa de notificações de todas as contas ativas e push para os aparelhos
   * vistos recentemente (Android pelo FCM, web pelo Web Push). Idempotente
   * por post: a caixa usa dedupe e `notified_at` fecha a porta ao push.
   */
  async notifyEveryone(postId: string): Promise<{ inbox: number; pushAccepted: number; pushFailed: number }> {
    const rows = await this.db.select().from(blogPosts).where(eq(blogPosts.id, postId)).limit(1);
    const post = rows[0];
    if (!post || post.status !== 'published') return { inbox: 0, pushAccepted: 0, pushFailed: 0 };
    if (post.notifiedAt) return { inbox: 0, pushAccepted: 0, pushFailed: 0 };

    const view = this.toView(post);
    const title = `Novo no blog: ${post.title}`.slice(0, 80);
    const body = post.excerpt.slice(0, 500);
    const data: Record<string, string> = { notificationType: 'blog.post', screen: 'blog', url: view.url, slug: post.slug, postId: post.id };
    const dedupeKey = `blog:${post.id}`;

    await this.db.execute(sql`
      INSERT INTO notifications (user_id, type, title, body, data, dedupe_key)
      SELECT u.id, 'blog.post', ${title}, ${body}, ${JSON.stringify(data)}::jsonb, ${dedupeKey}
      FROM users u WHERE u.status = 'active' AND u.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `);
    const inbox = await this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM notifications WHERE dedupe_key = ${dedupeKey}`);

    // Marca antes de enviar: se o job cair no meio, a retomada não manda duas vezes.
    await this.db.update(blogPosts).set({ notifiedAt: new Date() }).where(eq(blogPosts.id, postId));

    const targets = await this.db
      .select(pushTargetColumns)
      .from(pushTokens)
      .where(
        and(
          sql`${pushTokens.revokedAt} IS NULL`,
          sql`${pushTokens.notificationsEnabled} IS DISTINCT FROM false`,
          sql`${pushTokens.lastSeenAt} > now() - make_interval(days => ${PUSH_ACTIVE_DAYS})`,
        ),
      );
    let pushAccepted = 0;
    let pushFailed = 0;
    const concurrency = this.services.env.PUSH_SEND_CONCURRENCY;
    for (let start = 0; start < targets.length; start += concurrency) {
      const slice = targets.slice(start, start + concurrency);
      const results = await Promise.all(
        slice.map((target) => dispatchPush(this.services, target, { title, body, data }).catch((error: unknown) => ({ ok: false as const, reason: 'error' as const, message: String(error) }))),
      );
      for (const result of results) {
        if (result.ok) pushAccepted += 1;
        else if (result.reason !== 'unconfigured') pushFailed += 1;
      }
    }
    return { inbox: inbox.rows[0]?.total ?? 0, pushAccepted, pushFailed };
  }
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const clean = tag.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}
