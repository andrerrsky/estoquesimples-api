import { and, eq, ne, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../../platform/db/client.js';
import { pgErrorCode } from '../../platform/db/client.js';
import { brandSlugReservations, workspaceBrandings, workspaces, type WorkspaceBranding } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { AppError, ErrorCode, type ErrorDetail } from '../../platform/http/errors.js';
import { brandLogoKey } from '../../platform/storage/object-storage.js';
import { AnalyticsEventName } from '../analytics/analytics.events.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { BillingService } from '../billing/billing.service.js';
import { normalizeImage } from '../images/image-processing.js';
import { colorProblems, normalizeSlug, slugProblem, type BrandFont } from './brand-rules.js';
import { loadEffectiveBranding, logoUrl, type BrandLogoView, type BrandingView } from './branding-view.js';

/** Limites do logotipo: pequeno por construção, aparece em telas e cabeçalhos. */
const LOGO_MAX_EDGE = 640;
const LOGO_MAX_BYTES = 262_144;
/** Quanto tempo um identificador abandonado fica reservado para a empresa de origem. */
const RESERVATION_DAYS = 90;

export interface BrandConfigView {
  slug: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  textColor: string | null;
  font: BrandFont;
  logo: BrandLogoView | null;
  blocked: boolean;
  blockedReason: string | null;
  version: number;
  updatedAt: string | null;
}

export interface BrandUpdateInput {
  slug: string;
  primaryColor: string | null;
  accentColor: string | null;
  textColor: string | null;
  font: BrandFont;
}

const configOf = (row: WorkspaceBranding | undefined): BrandConfigView => ({
  slug: row?.slug ?? null,
  primaryColor: row?.primaryColor ?? null,
  accentColor: row?.accentColor ?? null,
  textColor: row?.textColor ?? null,
  font: row?.font === 'serif' ? 'serif' : 'default',
  logo:
    row?.slug && row.logoHash && row.logoWidth && row.logoHeight
      ? { url: logoUrl(row.slug, row.logoHash), hash: row.logoHash, width: row.logoWidth, height: row.logoHeight }
      : null,
  blocked: !!row?.blockedAt,
  blockedReason: row?.blockedReason ?? null,
  version: row?.version ?? 0,
  updatedAt: row?.updatedAt.toISOString() ?? null,
});

const fieldError = (field: string, message: string, extra?: Record<string, unknown>): AppError =>
  new AppError(422, ErrorCode.BRAND_INVALID, message, { details: [{ field, message }], ...(extra ? { extra } : {}) });

/** Identidade visual por empresa. Ver docs/branding.md. */
export class BrandingService {
  private readonly billing: BillingService;
  private readonly analytics: AnalyticsService;
  /** Resposta pública por identificador, 30 s: a tela de login é pública e pode receber rajadas. */
  private readonly publicCache = new Map<string, { at: number; view: BrandingView | null }>();

  constructor(private readonly services: AppServices) {
    this.billing = new BillingService(services);
    this.analytics = new AnalyticsService(services);
  }

  private get db() {
    return this.services.db;
  }

  // -------------------------------------------------------------------------
  // Leitura para quem edita
  // -------------------------------------------------------------------------

  async getForEditor(tx: Transaction, workspaceId: string, eligible: boolean) {
    const [row] = await tx.select().from(workspaceBrandings).where(eq(workspaceBrandings.workspaceId, workspaceId)).limit(1);
    const [workspace] = await tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    const effective = await loadEffectiveBranding(tx, workspaceId, eligible);
    return {
      eligible,
      config: configOf(row),
      effective,
      suggestedSlug: normalizeSlug(workspace?.name ?? ''),
    };
  }

  // -------------------------------------------------------------------------
  // Gravação
  // -------------------------------------------------------------------------

  private assertEligible(eligible: boolean): void {
    if (!eligible) {
      throw new AppError(403, ErrorCode.BRAND_NOT_IN_PLAN, 'A identidade visual personalizada está disponível para assinantes do plano Equipe.');
    }
  }

  async update(tx: Transaction, input: { workspaceId: string; userId: string; eligible: boolean; body: BrandUpdateInput }) {
    this.assertEligible(input.eligible);
    const { workspaceId, body } = input;

    const slug = normalizeSlug(body.slug);
    const slugIssue = slugProblem(slug);
    if (slugIssue) throw fieldError('slug', slugIssue);

    const colors = {
      primary: body.primaryColor?.toLowerCase() ?? null,
      accent: body.accentColor?.toLowerCase() ?? null,
      text: body.textColor?.toLowerCase() ?? null,
    };
    const problems = colorProblems(colors);
    if (problems.length > 0) {
      const details: ErrorDetail[] = problems.map((problem) => ({ field: problem.field, message: problem.message }));
      const suggestions = Object.fromEntries(problems.filter((p) => p.suggestion).map((p) => [p.field, p.suggestion]));
      throw new AppError(422, ErrorCode.BRAND_INVALID, problems[0]!.message, { details, extra: { suggestions } });
    }

    // Identificador de outra empresa, ou abandonado por outra e ainda reservado.
    // Consulta em contexto de sistema: o tenant só enxergaria as próprias linhas.
    const [taken] = await this.db
      .select({ workspaceId: workspaceBrandings.workspaceId })
      .from(workspaceBrandings)
      .where(and(eq(workspaceBrandings.slug, slug), ne(workspaceBrandings.workspaceId, workspaceId)))
      .limit(1);
    const [reserved] = await this.db
      .select({ workspaceId: brandSlugReservations.workspaceId })
      .from(brandSlugReservations)
      .where(
        and(
          eq(brandSlugReservations.slug, slug),
          ne(brandSlugReservations.workspaceId, workspaceId),
          sql`${brandSlugReservations.releasedAt} > now() - make_interval(days => ${RESERVATION_DAYS})`,
        ),
      )
      .limit(1);
    if (taken || reserved) throw new AppError(409, ErrorCode.BRAND_SLUG_TAKEN, 'Este identificador já está em uso. Escolha outro.', { details: [{ field: 'slug', message: 'Já está em uso.' }] });

    const [current] = await tx.select().from(workspaceBrandings).where(eq(workspaceBrandings.workspaceId, workspaceId)).limit(1);

    try {
      // Identificador antigo fica reservado; voltar a um identificador próprio libera a reserva.
      if (current?.slug && current.slug !== slug) {
        await tx
          .insert(brandSlugReservations)
          .values({ slug: current.slug, workspaceId })
          .onConflictDoUpdate({ target: brandSlugReservations.slug, set: { workspaceId, releasedAt: sql`now()` } });
      }
      await tx.delete(brandSlugReservations).where(and(eq(brandSlugReservations.slug, slug), eq(brandSlugReservations.workspaceId, workspaceId)));

      const values = {
        slug,
        primaryColor: colors.primary,
        accentColor: colors.accent,
        textColor: colors.text,
        font: body.font,
        updatedBy: input.userId,
        updatedAt: new Date(),
      };
      const [saved] = current
        ? await tx
            .update(workspaceBrandings)
            .set({ ...values, version: sql`${workspaceBrandings.version} + 1` })
            .where(eq(workspaceBrandings.workspaceId, workspaceId))
            .returning()
        : await tx.insert(workspaceBrandings).values({ workspaceId, ...values }).returning();

      await recordAudit(tx, {
        workspaceId,
        actorUserId: input.userId,
        action: AuditAction.BRAND_UPDATED,
        entityType: 'workspace_branding',
        entityId: workspaceId,
        metadata: { slug, colors: Object.values(colors).filter(Boolean).length, font: body.font, previousSlug: current?.slug ?? null },
      });
      void this.analytics.trackServerEvent({
        name: AnalyticsEventName.BRAND_UPDATED,
        userId: input.userId,
        workspaceId,
        properties: { colors: Object.values(colors).filter(Boolean).length, font: body.font, hasLogo: !!saved?.logoHash },
      });
      this.publicCache.clear();
      return configOf(saved);
    } catch (error) {
      if (pgErrorCode(error) === '23505') {
        throw new AppError(409, ErrorCode.BRAND_SLUG_TAKEN, 'Este identificador já está em uso. Escolha outro.', { details: [{ field: 'slug', message: 'Já está em uso.' }] });
      }
      throw error;
    }
  }

  async putLogo(tx: Transaction, input: { workspaceId: string; userId: string; eligible: boolean; bytes: Buffer; contentType: string }) {
    this.assertEligible(input.eligible);
    if (!this.services.storage.configured) {
      throw new AppError(503, ErrorCode.IMAGES_UNAVAILABLE, 'O envio de imagens não está disponível agora. Tente novamente mais tarde.');
    }
    const [current] = await tx.select().from(workspaceBrandings).where(eq(workspaceBrandings.workspaceId, input.workspaceId)).limit(1);
    // O logotipo vive na URL pública da empresa: o identificador vem antes.
    if (!current?.slug) throw fieldError('slug', 'Defina o identificador da empresa antes de enviar o logotipo.');

    const logo = await normalizeImage(input.bytes, input.contentType, { maxEdge: LOGO_MAX_EDGE, maxBytes: LOGO_MAX_BYTES });
    if (logo.hash !== current.logoHash) {
      await this.services.storage.put(brandLogoKey(input.workspaceId, logo.hash), logo.bytes, logo.contentType);
    }
    const [saved] = await tx
      .update(workspaceBrandings)
      .set({
        logoHash: logo.hash,
        logoContentType: logo.contentType,
        logoBytes: logo.bytes.length,
        logoWidth: logo.width,
        logoHeight: logo.height,
        updatedBy: input.userId,
        updatedAt: new Date(),
        version: sql`${workspaceBrandings.version} + 1`,
      })
      .where(eq(workspaceBrandings.workspaceId, input.workspaceId))
      .returning();

    // Logotipo antigo: sai do bucket depois que a linha já aponta para o novo.
    if (current.logoHash && current.logoHash !== logo.hash) await this.dropObject(input.workspaceId, current.logoHash);

    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actorUserId: input.userId,
      action: AuditAction.BRAND_LOGO_CHANGED,
      entityType: 'workspace_branding',
      entityId: input.workspaceId,
      metadata: { bytes: logo.bytes.length, width: logo.width, height: logo.height },
    });
    void this.analytics.trackServerEvent({ name: AnalyticsEventName.BRAND_LOGO_UPLOADED, userId: input.userId, workspaceId: input.workspaceId, properties: { bytes: logo.bytes.length } });
    this.publicCache.clear();
    return configOf(saved);
  }

  async removeLogo(tx: Transaction, input: { workspaceId: string; userId: string }) {
    const [current] = await tx.select().from(workspaceBrandings).where(eq(workspaceBrandings.workspaceId, input.workspaceId)).limit(1);
    if (!current?.logoHash) return configOf(current);
    const [saved] = await tx
      .update(workspaceBrandings)
      .set({ logoHash: null, logoContentType: null, logoBytes: null, logoWidth: null, logoHeight: null, updatedBy: input.userId, updatedAt: new Date(), version: sql`${workspaceBrandings.version} + 1` })
      .where(eq(workspaceBrandings.workspaceId, input.workspaceId))
      .returning();
    await this.dropObject(input.workspaceId, current.logoHash);
    await recordAudit(tx, { workspaceId: input.workspaceId, actorUserId: input.userId, action: AuditAction.BRAND_LOGO_REMOVED, entityType: 'workspace_branding', entityId: input.workspaceId });
    void this.analytics.trackServerEvent({ name: AnalyticsEventName.BRAND_LOGO_REMOVED, userId: input.userId, workspaceId: input.workspaceId });
    this.publicCache.clear();
    return configOf(saved);
  }

  /** Volta ao visual padrão: apaga cores, fonte e logotipo; mantém o identificador. Não exige plano (sair é sempre possível). */
  async reset(tx: Transaction, input: { workspaceId: string; userId: string }) {
    const [current] = await tx.select().from(workspaceBrandings).where(eq(workspaceBrandings.workspaceId, input.workspaceId)).limit(1);
    if (!current) return configOf(undefined);
    const [saved] = await tx
      .update(workspaceBrandings)
      .set({
        primaryColor: null, accentColor: null, textColor: null, font: 'default',
        logoHash: null, logoContentType: null, logoBytes: null, logoWidth: null, logoHeight: null,
        updatedBy: input.userId, updatedAt: new Date(), version: sql`${workspaceBrandings.version} + 1`,
      })
      .where(eq(workspaceBrandings.workspaceId, input.workspaceId))
      .returning();
    if (current.logoHash) await this.dropObject(input.workspaceId, current.logoHash);
    await recordAudit(tx, { workspaceId: input.workspaceId, actorUserId: input.userId, action: AuditAction.BRAND_RESET, entityType: 'workspace_branding', entityId: input.workspaceId });
    void this.analytics.trackServerEvent({ name: AnalyticsEventName.BRAND_RESET, userId: input.userId, workspaceId: input.workspaceId });
    this.publicCache.clear();
    return configOf(saved);
  }

  private async dropObject(workspaceId: string, hash: string): Promise<void> {
    try {
      await this.services.storage.delete(brandLogoKey(workspaceId, hash));
    } catch (error) {
      // Objeto órfão é inofensivo (ninguém aponta para ele); não derruba a operação.
      this.services.logger?.warn({ err: error, workspaceId }, 'logotipo antigo não removido do bucket');
    }
  }

  // -------------------------------------------------------------------------
  // Público (tela de entrada /<slug>/entrar)
  // -------------------------------------------------------------------------

  /**
   * Resolve um identificador para a marca ativa, ou `null`. Identificador
   * inexistente, sem plano, sem configuração ou bloqueado são
   * indistinguíveis de fora: a rota pública não serve para descobrir quem é
   * cliente. Identificador antigo (reservado) aponta para o atual.
   */
  async resolvePublic(rawSlug: string): Promise<BrandingView | null> {
    const slug = normalizeSlug(rawSlug);
    if (!WELL_FORMED(slug)) return null;
    const cached = this.publicCache.get(slug);
    const ttl = this.services.env.BRAND_PUBLIC_CACHE_MS;
    if (cached && ttl > 0 && Date.now() - cached.at < ttl) return cached.view;

    let workspaceId: string | null = null;
    const [row] = await this.db.select({ workspaceId: workspaceBrandings.workspaceId }).from(workspaceBrandings).where(eq(workspaceBrandings.slug, slug)).limit(1);
    workspaceId = row?.workspaceId ?? null;
    if (!workspaceId) {
      const [old] = await this.db
        .select({ workspaceId: brandSlugReservations.workspaceId })
        .from(brandSlugReservations)
        .where(and(eq(brandSlugReservations.slug, slug), sql`${brandSlugReservations.releasedAt} > now() - make_interval(days => ${RESERVATION_DAYS})`))
        .limit(1);
      workspaceId = old?.workspaceId ?? null;
    }

    let view: BrandingView | null = null;
    if (workspaceId) {
      const entitlement = await this.billing.getEntitlement(workspaceId);
      view = entitlement.branding.active ? entitlement.branding : null;
    }
    if (this.publicCache.size > 500) this.publicCache.clear();
    this.publicCache.set(slug, { at: Date.now(), view });
    return view;
  }

  /** Bytes do logotipo da empresa dona do identificador (só se a marca estiver ativa). */
  async readPublicLogo(rawSlug: string): Promise<{ bytes: Buffer; hash: string; contentType: string } | null> {
    const view = await this.resolvePublic(rawSlug);
    if (!view?.logo || !view.slug) return null;
    const [row] = await this.db.select().from(workspaceBrandings).where(eq(workspaceBrandings.slug, view.slug)).limit(1);
    if (!row?.logoHash || !row.logoContentType) return null;
    const bytes = await this.services.storage.get(brandLogoKey(row.workspaceId, row.logoHash));
    if (!bytes) return null;
    return { bytes, hash: row.logoHash, contentType: row.logoContentType };
  }

  // -------------------------------------------------------------------------
  // Painel administrativo
  // -------------------------------------------------------------------------

  async adminSetBlocked(workspaceId: string, adminEmail: string, reason: string | null): Promise<BrandConfigView> {
    const blocked = reason !== null;
    const [saved] = await this.db
      .update(workspaceBrandings)
      .set({ blockedAt: blocked ? new Date() : null, blockedReason: reason, version: sql`${workspaceBrandings.version} + 1`, updatedAt: new Date() })
      .where(eq(workspaceBrandings.workspaceId, workspaceId))
      .returning();
    if (!saved) throw new AppError(404, ErrorCode.NOT_FOUND, 'Esta empresa não configurou identidade visual.');
    await recordAudit(this.db, {
      workspaceId,
      action: blocked ? AuditAction.BRAND_BLOCKED : AuditAction.BRAND_UNBLOCKED,
      entityType: 'workspace_branding',
      entityId: workspaceId,
      metadata: { admin: adminEmail, reason },
    });
    this.publicCache.clear();
    return configOf(saved);
  }

  async adminGet(workspaceId: string): Promise<BrandConfigView | null> {
    const [row] = await this.db.select().from(workspaceBrandings).where(eq(workspaceBrandings.workspaceId, workspaceId)).limit(1);
    return row ? configOf(row) : null;
  }
}

/** Rotas públicas aceitam qualquer slug bem formado (inclusive reservado, que simplesmente não existe). */
const WELL_FORMED = (slug: string): boolean => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length >= 3 && slug.length <= 32;
