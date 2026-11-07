import { sql, type SQL } from 'drizzle-orm';

import { emailsSentToday } from '../../platform/email/counting-mailer.js';
import { MailerRateLimitError } from '../../platform/email/mailer.js';
import type { AppServices } from '../../platform/http/context.js';
import { sqlList } from '../admin/admin-series.js';
import { LIVE_STATES } from '../billing/billing.service.js';
import { LIFECYCLE_KINDS, renderLifecycleEmail, type LifecycleKind } from './lifecycle.templates.js';

/**
 * Funil de e-mails do ciclo de vida: totalmente automático, decidido a cada
 * hora a partir dos dados do produto (cadastro, primeiro produto, última
 * atividade, uso do plano). Ver docs/emails-ciclo-de-vida.md.
 *
 * Garantias:
 * - nada sai em `LIFECYCLE_EMAILS_MODE=off`; em `dry_run` (padrão) só registra;
 * - nunca para quem pediu para não receber, teve bounce permanente/spam,
 *   conta suspensa ou excluída;
 * - no máximo 1 e-mail do ciclo de vida a cada 48 h por pessoa e 1 por rodada;
 * - cada passo uma vez (`dedupe_key`); o que foi simulado no `dry_run` conta
 *   como feito, então ligar o envio nunca dispara uma rajada de atrasados;
 * - janela de cada passo limitada (um passo vencido há dias não sai);
 * - para antes de gastar a cota diária do provedor (teto do ciclo de vida e
 *   teto de todos os e-mails do dia) e ao primeiro erro de limite;
 * - só em horário comercial de Brasília (9 h às 20 h).
 */

const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 20;

/** Ordem de prioridade quando mais de um passo vence para a mesma pessoa. */
const PRIORITY: LifecycleKind[] = ['activation_d8', 'activation_d4', 'activation_d1', 'limit_50', 'limit_40', 'confirm_email', 'reengage_14d'];

export interface LifecycleCandidate {
  kind: LifecycleKind;
  userId: string;
  email: string;
  name: string;
  emailVerified: boolean;
  workspaceId: string | null;
  workspaceName: string | null;
  productCount: number;
  lowStockCount: number | null;
  dedupeKey: string;
}

export interface LifecycleRunResult {
  mode: 'off' | 'dry_run' | 'send';
  skipped?: 'off' | 'outside_hours' | 'quota';
  decided: number;
  sent: number;
  failed: number;
  stoppedByRateLimit: boolean;
}

function brasiliaHour(now: Date): number {
  return new Date(now.getTime() - 3 * 3_600_000).getUTCHours();
}

const ELIGIBLE = sql`u.status = 'active' AND u.deleted_at IS NULL AND u.lifecycle_emails_opt_out_at IS NULL AND u.email_suppressed_at IS NULL`;
const NO_RECENT = sql`NOT EXISTS (SELECT 1 FROM lifecycle_emails r WHERE r.user_id = u.id AND r.created_at > now() - interval '48 hours')`;
/** Contas da web (o app Android guarda produtos no aparelho; sem nuvem, "sem produto" seria falso). */
const WEB_ONLY = sql`EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.id AND d.platform = 'web') AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.id AND d.platform <> 'web')`;
const HAS_EVER_PRODUCT = sql`EXISTS (SELECT 1 FROM products p JOIN workspaces w ON w.id = p.workspace_id WHERE w.owner_user_id = u.id)`;

export class LifecycleService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  /** Quem deve receber cada passo agora (antes dos limites de cota). */
  async candidates(): Promise<LifecycleCandidate[]> {
    const start = this.services.env.LIFECYCLE_ACTIVATION_START.toISOString();
    const activation = (kind: LifecycleKind, fromHours: number, toHours: number): SQL => sql`
      SELECT ${kind}::text AS kind, u.id AS user_id, u.email, u.name, (u.email_verified_at IS NOT NULL) AS email_verified,
             NULL::uuid AS workspace_id, NULL::text AS workspace_name, 0 AS product_count, NULL::int AS low_stock_count,
             ${kind}::text || ':' || u.id::text AS dedupe_key
      FROM users u
      WHERE ${ELIGIBLE} AND ${NO_RECENT} AND ${WEB_ONLY}
        AND u.created_at >= ${start}::timestamptz
        AND u.created_at <= now() - make_interval(hours => ${fromHours})
        AND u.created_at >  now() - make_interval(hours => ${toHours})
        AND NOT ${HAS_EVER_PRODUCT}
    `;

    const rows = await this.db.execute<{
      kind: LifecycleKind;
      user_id: string;
      email: string;
      name: string;
      email_verified: boolean;
      workspace_id: string | null;
      workspace_name: string | null;
      product_count: number;
      low_stock_count: number | null;
      dedupe_key: string;
    }>(sql`
      ${activation('activation_d1', 24, 72)}
      UNION ALL ${activation('activation_d4', 96, 144)}
      UNION ALL ${activation('activation_d8', 192, 240)}
      UNION ALL
      SELECT 'confirm_email', u.id, u.email, u.name, false, NULL::uuid, NULL::text, 0, NULL::int, 'confirm_email:' || u.id::text
      FROM users u
      WHERE ${ELIGIBLE} AND ${NO_RECENT} AND u.email_verified_at IS NULL AND ${HAS_EVER_PRODUCT}
        AND u.created_at <= now() - interval '120 hours' AND u.created_at > now() - interval '192 hours'
      UNION ALL
      -- Reengajamento: dono com produtos, sem atividade própria (app ou web) há 14–21 dias; no máximo a cada 90 dias.
      SELECT 'reengage_14d', u.id, u.email, u.name, (u.email_verified_at IS NOT NULL), w.id, w.name,
             (SELECT count(*)::int FROM products p WHERE p.workspace_id = w.id AND p.deleted_at IS NULL),
             (SELECT count(*)::int FROM products p WHERE p.workspace_id = w.id AND p.deleted_at IS NULL AND p.min_stock > 0 AND p.quantity_cache < p.min_stock),
             'reengage_14d:' || u.id::text || ':' || to_char(now(), 'YYYY-MM-DD')
      FROM users u
      JOIN LATERAL (
        SELECT w.id, w.name FROM workspaces w
        WHERE w.owner_user_id = u.id AND w.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM products p WHERE p.workspace_id = w.id AND p.deleted_at IS NULL)
        ORDER BY w.created_at LIMIT 1
      ) w ON true
      JOIN LATERAL (
        SELECT max(at) AS last_at FROM (
          SELECT max(e.occurred_at) AS at FROM analytics_events e WHERE e.user_id = u.id AND e.source = 'app'
          UNION ALL
          SELECT max(a.created_at) FROM audit_log a WHERE a.actor_user_id = u.id
        ) x
      ) act ON true
      WHERE ${ELIGIBLE} AND ${NO_RECENT}
        AND act.last_at < now() - interval '14 days' AND act.last_at > now() - interval '21 days'
        AND NOT EXISTS (SELECT 1 FROM lifecycle_emails r WHERE r.user_id = u.id AND r.kind = 'reengage_14d' AND r.created_at > now() - interval '90 days')
      UNION ALL
      -- Limite do plano grátis: por empresa do dono, sem assinatura viva (nem pagamento pendente).
      SELECT CASE WHEN c.n >= 50 THEN 'limit_50' ELSE 'limit_40' END, u.id, u.email, u.name, (u.email_verified_at IS NOT NULL), w.id, w.name, c.n, NULL::int,
             CASE WHEN c.n >= 50 THEN 'limit_50:' ELSE 'limit_40:' END || w.id::text
      FROM workspaces w
      JOIN users u ON u.id = w.owner_user_id
      JOIN LATERAL (SELECT count(*)::int AS n FROM products p WHERE p.workspace_id = w.id AND p.deleted_at IS NULL) c ON true
      WHERE ${ELIGIBLE} AND ${NO_RECENT} AND w.deleted_at IS NULL AND c.n >= 40
        AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.workspace_id = w.id AND s.state IN ${sqlList(LIVE_STATES)})
    `);

    const seen = new Set<string>();
    const byPriority = [...rows.rows].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
    const out: LifecycleCandidate[] = [];
    for (const row of byPriority) {
      if (seen.has(row.user_id) || !LIFECYCLE_KINDS.includes(row.kind)) continue;
      seen.add(row.user_id);
      out.push({
        kind: row.kind,
        userId: row.user_id,
        email: row.email,
        name: row.name,
        emailVerified: row.email_verified,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        productCount: row.product_count,
        lowStockCount: row.low_stock_count,
        dedupeKey: row.dedupe_key,
      });
    }
    return out;
  }

  private baseUrl(): string {
    return this.services.env.WEB_APP_URL ?? 'https://estoquesimples.com.br';
  }

  /** Link rastreável: UTMs do e-mail (GA e painel) e o id do envio (`le`), sem dado pessoal. */
  trackedLink(path: string, kind: LifecycleKind, emailId: string): string {
    const url = new URL(path, this.baseUrl());
    url.searchParams.set('utm_source', 'lifecycle');
    url.searchParams.set('utm_medium', 'email');
    url.searchParams.set('utm_campaign', 'ciclo_de_vida');
    url.searchParams.set('utm_content', kind);
    url.searchParams.set('le', emailId);
    return url.toString();
  }

  unsubscribeUrl(emailId: string): string {
    return `${this.baseUrl()}/v1/email/descadastrar?t=${emailId}`;
  }

  /** Uma rodada: decide, registra e (em `send`) envia, dentro dos limites. */
  async run(now = new Date()): Promise<LifecycleRunResult> {
    const env = this.services.env;
    const mode = env.LIFECYCLE_EMAILS_MODE;
    const result: LifecycleRunResult = { mode, decided: 0, sent: 0, failed: 0, stoppedByRateLimit: false };
    if (mode === 'off') return { ...result, skipped: 'off' };
    const hour = brasiliaHour(now);
    if (hour < BUSINESS_START_HOUR || hour >= BUSINESS_END_HOUR) return { ...result, skipped: 'outside_hours' };

    const today = await emailsSentToday(this.db);
    // No dry_run, as simulações do dia contam para o teto, como se tivessem saído.
    const simulatedToday =
      mode === 'dry_run'
        ? ((await this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM lifecycle_emails WHERE status = 'dry_run' AND created_at > date_trunc('day', now() - interval '3 hours') + interval '3 hours'`)).rows[0]?.n ?? 0)
        : 0;
    let budget = Math.min(env.LIFECYCLE_DAILY_LIMIT - today.lifecycle - simulatedToday, env.EMAIL_DAILY_TOTAL_LIMIT - today.total - simulatedToday);
    if (budget <= 0) return { ...result, skipped: 'quota' };

    const replyTo = env.LIFECYCLE_REPLY_TO ?? env.SUPPORT_NOTIFY_EMAILS[0];
    for (const candidate of await this.candidates()) {
      if (budget <= 0) break;
      const claimed = await this.db.execute<{ id: string }>(sql`
        INSERT INTO lifecycle_emails (user_id, workspace_id, kind, dedupe_key, status)
        VALUES (${candidate.userId}, ${candidate.workspaceId}, ${candidate.kind}, ${candidate.dedupeKey}, ${mode === 'send' ? 'sent' : 'dry_run'})
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING id
      `);
      const id = claimed.rows[0]?.id;
      if (!id) continue;
      result.decided += 1;
      budget -= 1;
      if (mode !== 'send') continue;

      const rendered = renderLifecycleEmail(candidate.kind, {
        firstName: candidate.name.trim().split(/\s+/)[0] ?? '',
        workspaceName: candidate.workspaceName,
        emailVerified: candidate.emailVerified,
        productCount: candidate.productCount,
        lowStockCount: candidate.lowStockCount,
        link: (path) => this.trackedLink(path, candidate.kind, id),
        unsubscribeUrl: this.unsubscribeUrl(id),
      });
      try {
        const sent = await this.services.mailer.send({
          to: candidate.email,
          kind: 'lifecycle',
          subject: rendered.subject,
          text: rendered.text,
          fromName: env.LIFECYCLE_FROM_NAME,
          ...(replyTo ? { replyTo } : {}),
          headers: {
            'List-Unsubscribe': `<${this.unsubscribeUrl(id)}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });
        const providerId = sent && typeof sent === 'object' ? sent.id ?? null : null;
        await this.db.execute(sql`UPDATE lifecycle_emails SET provider_id = ${providerId} WHERE id = ${id}`);
        result.sent += 1;
      } catch (error) {
        if (error instanceof MailerRateLimitError) {
          // Limite do provedor: devolve o passo (sai na próxima rodada dentro da janela) e para o dia.
          await this.db.execute(sql`DELETE FROM lifecycle_emails WHERE id = ${id}`);
          result.decided -= 1;
          result.stoppedByRateLimit = true;
          break;
        }
        const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
        await this.db.execute(sql`UPDATE lifecycle_emails SET status = 'failed', error = ${message} WHERE id = ${id}`);
        result.failed += 1;
        this.services.logger?.error({ err: error, kind: candidate.kind }, 'e-mail do ciclo de vida não saiu');
      }
    }
    return result;
  }

  /** Descadastro em 1 clique pelo id do envio (token do link). */
  async unsubscribe(emailId: string): Promise<boolean> {
    const rows = await this.db.execute<{ user_id: string }>(sql`
      UPDATE lifecycle_emails SET unsubscribed_at = COALESCE(unsubscribed_at, now()) WHERE id = ${emailId} RETURNING user_id
    `);
    const userId = rows.rows[0]?.user_id;
    if (!userId) return false;
    await this.db.execute(sql`UPDATE users SET lifecycle_emails_opt_out_at = COALESCE(lifecycle_emails_opt_out_at, now()) WHERE id = ${userId}`);
    return true;
  }

  /** Clique num link do e-mail (o web app avisa ao abrir com `?le=`). */
  async markClicked(emailId: string): Promise<void> {
    await this.db.execute(sql`UPDATE lifecycle_emails SET clicked_at = COALESCE(clicked_at, now()) WHERE id = ${emailId}`);
  }

  /** Eventos do provedor (webhook do Resend). Bounce permanente e spam suprimem o endereço. */
  async applyProviderEvent(event: { type: string; providerId: string | null; to: string | null; permanentBounce: boolean }): Promise<void> {
    const column =
      event.type === 'email.delivered'
        ? 'delivered_at'
        : event.type === 'email.opened'
          ? 'opened_at'
          : event.type === 'email.clicked'
            ? 'clicked_at'
            : event.type === 'email.bounced'
              ? 'bounced_at'
              : event.type === 'email.complained'
                ? 'complained_at'
                : null;
    if (!column) return;
    let userId: string | null = null;
    if (event.providerId) {
      const rows = await this.db.execute<{ user_id: string }>(sql`
        UPDATE lifecycle_emails SET ${sql.raw(column)} = COALESCE(${sql.raw(column)}, now())
        WHERE provider_id = ${event.providerId} RETURNING user_id
      `);
      userId = rows.rows[0]?.user_id ?? null;
    }
    const suppress = event.type === 'email.complained' || (event.type === 'email.bounced' && event.permanentBounce);
    if (!suppress) return;
    if (userId) {
      await this.db.execute(sql`UPDATE users SET email_suppressed_at = COALESCE(email_suppressed_at, now()) WHERE id = ${userId}`);
    } else if (event.to) {
      // Bounce/spam de um e-mail essencial (sem registro aqui): suprime pelo endereço.
      await this.db.execute(sql`UPDATE users SET email_suppressed_at = COALESCE(email_suppressed_at, now()) WHERE lower(email) = ${event.to.toLowerCase()} AND deleted_at IS NULL`);
    }
  }
}
