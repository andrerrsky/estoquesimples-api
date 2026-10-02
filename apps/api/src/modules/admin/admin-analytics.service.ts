import { sql, type SQL } from 'drizzle-orm';

import type { AppServices } from '../../platform/http/context.js';
import { ANALYTICS_EVENT_CATALOG, DEFAULT_FUNNEL } from '../analytics/analytics.events.js';
import {
  activitySql,
  bucketExpr,
  eventPlatformExpr,
  fillSeries,
  providerOfPlatform,
  resolveRange,
  userOnPlatform,
  type ClientPlatform,
  type ResolvedRange,
  type SeriesPoint,
} from './admin-series.js';
import { offsetOf, type PaginationQuery } from './admin.schemas.js';

/**
 * Registro de métricas do painel.
 *
 * Cada métrica é uma pergunta com uma consulta. Acrescentar uma nova é
 * acrescentar uma entrada aqui: o endpoint `/analytics/metrics` devolve todas,
 * e o painel as exibe sem saber de antemão quais existem. A consulta recebe
 * o intervalo e devolve um número; o `previous` (mesmo intervalo, deslocado)
 * dá a variação sem cada tela ter de calculá-la.
 *
 * Plataforma (app × web): só a métrica que tem essa dimensão de verdade a
 * aplica, e declara como em `platformNote`. As demais ignoram o recorte e o
 * painel as marca como "todas as plataformas" — melhor do que um número que
 * parece filtrado e não é.
 */
export interface MetricDefinition {
  key: string;
  label: string;
  description: string;
  unit: 'count' | 'percent' | 'users' | 'events';
  /** Como o recorte de plataforma é aplicado; ausente = a métrica não tem essa dimensão. */
  platformNote?: string;
  /** Consulta que devolve um único número para o intervalo. `platform` só chega a quem declara `platformNote`. */
  query: (range: { from: Date; to: Date }, platform?: ClientPlatform) => SQL;
}

/** `AND provider = …` do provedor da plataforma; iOS não tem provedor e zera. */
function providerFilter(platform?: ClientPlatform): SQL {
  if (!platform) return sql``;
  const provider = providerOfPlatform(platform);
  return provider ? sql`AND provider = ${provider}` : sql`AND false`;
}

const eventPlatformFilter = (platform?: ClientPlatform): SQL =>
  platform ? sql`AND ${eventPlatformExpr()} = ${platform}` : sql``;

export const METRICS: MetricDefinition[] = [
  {
    key: 'new_users',
    label: 'Contas criadas',
    description: 'Cadastros concluídos no período.',
    unit: 'users',
    platformNote: 'Contas criadas no período que têm aparelho (ou navegador) registrado na plataforma.',
    query: (r, platform) => sql`
      SELECT count(*)::int AS v FROM users u
      WHERE u.created_at >= ${r.from} AND u.created_at < ${r.to}
        ${platform ? sql`AND ${userOnPlatform(sql`u.id`, platform)}` : sql``}
    `,
  },
  {
    key: 'active_users',
    label: 'Usuários ativos',
    description: 'Usuários com ao menos um evento ou ação no período.',
    unit: 'users',
    platformNote: 'Só eventos de uso da plataforma; ações da auditoria não guardam de onde vieram.',
    query: (r, platform) => sql`SELECT count(DISTINCT user_id)::int AS v FROM (${activitySql(platform)}) a WHERE at >= ${r.from} AND at < ${r.to}`,
  },
  {
    key: 'events',
    label: 'Eventos registrados',
    description: 'Total de eventos de uso recebidos (app, web e API).',
    unit: 'events',
    platformNote: 'Eventos enviados pela plataforma e os da API que registram de onde vieram.',
    query: (r, platform) => sql`
      SELECT count(*)::int AS v FROM analytics_events
      WHERE occurred_at >= ${r.from} AND occurred_at < ${r.to} ${eventPlatformFilter(platform)}
    `,
  },
  {
    key: 'workspaces_created',
    label: 'Empresas criadas',
    description: 'Empresas criadas no período.',
    unit: 'count',
    query: (r) => sql`SELECT count(*)::int AS v FROM workspaces WHERE created_at >= ${r.from} AND created_at < ${r.to}`,
  },
  {
    key: 'initial_uploads',
    label: 'Cargas iniciais concluídas',
    description: 'Empresas que enviaram o estoque do aparelho para a nuvem.',
    unit: 'count',
    query: (r) => sql`SELECT count(*)::int AS v FROM initial_uploads WHERE status = 'concluida' AND completed_at >= ${r.from} AND completed_at < ${r.to}`,
  },
  {
    key: 'subscriptions_started',
    label: 'Assinaturas vinculadas',
    description: 'Compras do Google Play vinculadas e contratações iniciadas na web (inclui as ainda não pagas).',
    unit: 'count',
    platformNote: 'Pelo provedor: Google Play no app Android, Asaas na web.',
    query: (r, platform) => sql`SELECT count(*)::int AS v FROM subscriptions WHERE created_at >= ${r.from} AND created_at < ${r.to} ${providerFilter(platform)}`,
  },
  {
    key: 'subscriptions_churned',
    label: 'Assinaturas encerradas',
    description: 'Assinaturas que expiraram ou foram reembolsadas no período.',
    unit: 'count',
    platformNote: 'Pelo provedor: Google Play no app Android, Asaas na web.',
    query: (r, platform) => sql`SELECT count(*)::int AS v FROM subscriptions WHERE state IN ('expirada','reembolsada') AND updated_at >= ${r.from} AND updated_at < ${r.to} ${providerFilter(platform)}`,
  },
  {
    key: 'cancellations',
    label: 'Renovação desligada',
    description: 'Assinaturas cuja renovação automática foi desligada no período.',
    unit: 'count',
    platformNote: 'Pelo provedor: Google Play no app Android, Asaas na web.',
    query: (r, platform) => sql`SELECT count(*)::int AS v FROM subscriptions WHERE canceled_at >= ${r.from} AND canceled_at < ${r.to} ${providerFilter(platform)}`,
  },
  {
    key: 'sync_operations',
    label: 'Operações de sincronização',
    description: 'Operações recebidas dos aparelhos.',
    unit: 'count',
    query: (r) => sql`SELECT count(*)::int AS v FROM sync_operations WHERE created_at >= ${r.from} AND created_at < ${r.to}`,
  },
  {
    key: 'conflicts',
    label: 'Conflitos registrados',
    description: 'Conflitos de sincronização detectados.',
    unit: 'count',
    query: (r) => sql`SELECT count(*)::int AS v FROM conflict_log WHERE created_at >= ${r.from} AND created_at < ${r.to}`,
  },
  {
    key: 'login_failures',
    label: 'Falhas de login',
    description: 'Tentativas de login com senha errada.',
    unit: 'count',
    query: (r) => sql`SELECT count(*)::int AS v FROM audit_log WHERE action = 'user.login_failed' AND created_at >= ${r.from} AND created_at < ${r.to}`,
  },
  {
    key: 'exports',
    label: 'Exportações',
    description: 'Extrações de dados (CSV/JSON) pela API.',
    unit: 'count',
    query: (r) => sql`SELECT count(*)::int AS v FROM audit_log WHERE action = 'data.exported' AND created_at >= ${r.from} AND created_at < ${r.to}`,
  },
];

export interface EventListFilters extends PaginationQuery {
  name?: string;
  userId?: string;
  workspaceId?: string;
  source?: 'app' | 'server';
  /** Plataforma atribuída ao evento (`eventPlatformExpr`); `server` = sem plataforma. */
  platform?: ClientPlatform | 'server';
  from?: Date;
  to?: Date;
  q?: string;
}

export class AdminAnalyticsService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  private async scalar(query: SQL): Promise<number> {
    const result = await this.db.execute<{ v: number | string | null }>(query);
    return Number(result.rows[0]?.v ?? 0);
  }

  /** Todas as métricas do registro, com o período anterior para comparação. */
  async metrics(range: ResolvedRange, platform?: ClientPlatform) {
    const span = range.to.getTime() - range.from.getTime();
    const previous = { from: new Date(range.from.getTime() - span), to: range.from };

    const values = await Promise.all(
      METRICS.map(async (metric) => {
        // Só recebe o recorte quem declarou como o aplica.
        const applied = platform !== undefined && metric.platformNote !== undefined;
        const scope = applied ? platform : undefined;
        const [current, prior] = await Promise.all([
          this.scalar(metric.query(range, scope)),
          this.scalar(metric.query(previous, scope)),
        ]);
        return {
          key: metric.key,
          label: metric.label,
          description: metric.description,
          unit: metric.unit,
          value: current,
          previous: prior,
          /** O número acima já está recortado pela plataforma pedida. */
          platformApplied: applied,
          platformNote: metric.platformNote ?? null,
        };
      }),
    );

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString(), days: range.days },
      platform: platform ?? null,
      items: values,
    };
  }

  async summary(range: ResolvedRange, platform?: ClientPlatform) {
    const activity = activitySql(platform);
    const onPlatform = eventPlatformFilter(platform);
    const [activeSeries, eventSeries, topEvents, screens, platforms, versions, activeNow, byPlatform] = await Promise.all([
      this.db.execute<{ bucket: string; value: string }>(sql`
        SELECT ${bucketExpr(sql`at`, range.granularity)} AS bucket, count(DISTINCT user_id)::int AS value
        FROM (${activity}) a WHERE at >= ${range.from} AND at < ${range.to}
        GROUP BY 1 ORDER BY 1
      `),
      this.db.execute<{ bucket: string; value: string }>(sql`
        SELECT ${bucketExpr(sql`occurred_at`, range.granularity)} AS bucket, count(*)::int AS value
        FROM analytics_events WHERE occurred_at >= ${range.from} AND occurred_at < ${range.to} ${onPlatform}
        GROUP BY 1 ORDER BY 1
      `),
      this.db.execute<{ name: string; source: string; events: number; users: number; installs: number }>(sql`
        SELECT name, min(source) AS source, count(*)::int AS events,
               count(DISTINCT user_id)::int AS users, count(DISTINCT install_id)::int AS installs
        FROM analytics_events WHERE occurred_at >= ${range.from} AND occurred_at < ${range.to} ${onPlatform}
        GROUP BY name ORDER BY events DESC LIMIT 30
      `),
      this.db.execute<{ screen: string; views: number; users: number }>(sql`
        SELECT properties->>'screen' AS screen, count(*)::int AS views, count(DISTINCT coalesce(user_id::text, install_id))::int AS users
        FROM analytics_events
        WHERE name = 'screen.viewed' AND properties ? 'screen' AND occurred_at >= ${range.from} AND occurred_at < ${range.to} ${onPlatform}
        GROUP BY 1 ORDER BY views DESC LIMIT 15
      `),
      // Aparelhos por plataforma: é a própria dimensão, então nunca é recortado.
      this.db.execute<{ platform: string; count: number; active_30d: number; users_30d: number }>(sql`
        SELECT platform, count(*)::int AS count,
               count(*) FILTER (WHERE last_seen_at > now() - interval '30 days')::int AS active_30d,
               count(DISTINCT user_id) FILTER (WHERE last_seen_at > now() - interval '30 days')::int AS users_30d
        FROM devices WHERE revoked_at IS NULL GROUP BY platform ORDER BY count DESC
      `),
      this.db.execute<{ version: string; count: number }>(sql`
        SELECT coalesce(app_version_name, 'desconhecida') AS version, count(*)::int AS count
        FROM devices WHERE revoked_at IS NULL AND last_seen_at > now() - interval '30 days'
          ${platform ? sql`AND platform = ${platform}` : sql``}
        GROUP BY 1 ORDER BY count DESC LIMIT 10
      `),
      this.db.execute<{ dau: number; wau: number; mau: number }>(sql`
        SELECT
          (SELECT count(DISTINCT user_id)::int FROM (${activity}) a WHERE at > now() - interval '1 day') AS dau,
          (SELECT count(DISTINCT user_id)::int FROM (${activity}) a WHERE at > now() - interval '7 days') AS wau,
          (SELECT count(DISTINCT user_id)::int FROM (${activity}) a WHERE at > now() - interval '30 days') AS mau
      `),
      // Eventos do período por plataforma atribuída (também sem recorte). A
      // linha `server` são os marcos da API que não dizem de onde vieram.
      this.db.execute<{ platform: string; events: number; users: number; installs: number }>(sql`
        SELECT ${eventPlatformExpr()} AS platform, count(*)::int AS events,
               count(DISTINCT user_id)::int AS users, count(DISTINCT install_id)::int AS installs
        FROM analytics_events WHERE occurred_at >= ${range.from} AND occurred_at < ${range.to}
        GROUP BY 1 ORDER BY events DESC
      `),
    ]);

    const catalog = new Map(ANALYTICS_EVENT_CATALOG.map((item) => [item.name, item]));
    const now = activeNow.rows[0];

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString(), granularity: range.granularity, days: range.days },
      platform: platform ?? null,
      active: { dau: now?.dau ?? 0, wau: now?.wau ?? 0, mau: now?.mau ?? 0 },
      series: {
        activeUsers: fillSeries(activeSeries.rows, range),
        events: fillSeries(eventSeries.rows, range),
      },
      topEvents: topEvents.rows.map((row) => ({
        name: row.name,
        source: row.source,
        description: catalog.get(row.name as never)?.description ?? null,
        events: row.events,
        users: row.users,
        installs: row.installs,
      })),
      topScreens: screens.rows.map((row) => ({ screen: row.screen, views: row.views, users: row.users })),
      platforms: platforms.rows.map((row) => ({ platform: row.platform, count: row.count, active30d: row.active_30d, users30d: row.users_30d })),
      byPlatform: byPlatform.rows,
      appVersions: versions.rows,
    };
  }

  /** Série de um evento específico, contando eventos ou usuários distintos. */
  async eventSeries(name: string, range: ResolvedRange, metric: 'events' | 'users', platform?: ClientPlatform): Promise<SeriesPoint[]> {
    const value = metric === 'users'
      ? sql`count(DISTINCT coalesce(user_id::text, install_id))::int`
      : sql`count(*)::int`;
    const rows = await this.db.execute<{ bucket: string; value: string }>(sql`
      SELECT ${bucketExpr(sql`occurred_at`, range.granularity)} AS bucket, ${value} AS value
      FROM analytics_events
      WHERE name = ${name} AND occurred_at >= ${range.from} AND occurred_at < ${range.to} ${eventPlatformFilter(platform)}
      GROUP BY 1 ORDER BY 1
    `);
    return fillSeries(rows.rows, range);
  }

  async eventNames() {
    const rows = await this.db.execute<{ name: string; source: string; total: number; last_seen: string; first_seen: string }>(sql`
      SELECT name, min(source) AS source, count(*)::int AS total, max(occurred_at) AS last_seen, min(occurred_at) AS first_seen
      FROM analytics_events GROUP BY name ORDER BY total DESC
    `);
    const catalog = new Map(ANALYTICS_EVENT_CATALOG.map((item) => [item.name, item]));
    const seen = new Set(rows.rows.map((row) => row.name));

    return {
      items: [
        ...rows.rows.map((row) => ({
          name: row.name,
          source: row.source,
          total: row.total,
          firstSeen: new Date(row.first_seen).toISOString(),
          lastSeen: new Date(row.last_seen).toISOString(),
          inCatalog: catalog.has(row.name as never),
          description: catalog.get(row.name as never)?.description ?? null,
        })),
        ...ANALYTICS_EVENT_CATALOG.filter((item) => !seen.has(item.name)).map((item) => ({
          name: item.name,
          source: item.source,
          total: 0,
          firstSeen: null,
          lastSeen: null,
          inCatalog: true,
          description: item.description,
        })),
      ],
    };
  }

  async events(filters: EventListFilters) {
    const conditions = [sql`true`];
    if (filters.name) conditions.push(sql`e.name = ${filters.name}`);
    if (filters.userId) conditions.push(sql`e.user_id = ${filters.userId}`);
    if (filters.workspaceId) conditions.push(sql`e.workspace_id = ${filters.workspaceId}`);
    if (filters.source) conditions.push(sql`e.source = ${filters.source}`);
    if (filters.platform) conditions.push(sql`${eventPlatformExpr('e')} = ${filters.platform}`);
    if (filters.from) conditions.push(sql`e.occurred_at >= ${filters.from}`);
    if (filters.to) conditions.push(sql`e.occurred_at < ${filters.to}`);
    if (filters.q) {
      const term = `%${filters.q.toLowerCase()}%`;
      conditions.push(sql`(lower(coalesce(u.email,'')) LIKE ${term} OR lower(coalesce(w.name,'')) LIKE ${term} OR e.install_id LIKE ${term})`);
    }
    const where = sql.join(conditions, sql` AND `);
    const base = sql`
      FROM analytics_events e
      LEFT JOIN users u ON u.id = e.user_id
      LEFT JOIN workspaces w ON w.id = e.workspace_id
      WHERE ${where}
    `;

    const [rows, total] = await Promise.all([
      this.db.execute<{
        id: string; name: string; occurred_at: string; received_at: string; user_id: string | null; user_email: string | null;
        workspace_id: string | null; workspace_name: string | null; install_id: string | null; platform: string; attributed_platform: string;
        app_version_code: number | null; session_key: string | null; source: string; properties: Record<string, unknown>;
      }>(sql`
        SELECT e.id::text, e.name, e.occurred_at, e.received_at, e.user_id, u.email AS user_email,
               e.workspace_id, w.name AS workspace_name, e.install_id, e.platform,
               ${eventPlatformExpr('e')} AS attributed_platform, e.app_version_code,
               e.session_key, e.source, e.properties
        ${base}
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT ${filters.pageSize} OFFSET ${offsetOf(filters)}
      `),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total ${base}`),
    ]);

    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        name: row.name,
        occurredAt: new Date(row.occurred_at).toISOString(),
        receivedAt: new Date(row.received_at).toISOString(),
        userId: row.user_id,
        userEmail: row.user_email,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        installId: row.install_id,
        platform: row.platform,
        // Para evento da API: de onde ele veio, quando o emissor registrou.
        attributedPlatform: row.attributed_platform,
        appVersionCode: row.app_version_code,
        sessionKey: row.session_key,
        source: row.source,
        properties: row.properties ?? {},
      })),
      page: filters.page,
      pageSize: filters.pageSize,
      total: total.rows[0]?.total ?? 0,
    };
  }

  /**
   * Funil: quantas identidades passaram por cada etapa no período.
   *
   * A identidade é o usuário quando existe; antes da conta, é a instalação.
   * Para não contar a mesma pessoa duas vezes (uma como instalação, outra
   * como usuário), a instalação é traduzida para o usuário que a registrou.
   *
   * Com recorte de plataforma o funil é o das *pessoas que usam a
   * plataforma*: a conta entra se tem aparelho (ou navegador) registrado
   * nela (`userOnPlatform`); a instalação ainda sem conta, pela plataforma
   * do próprio evento. Recortar evento a evento zeraria as etapas que só a
   * API observa (empresa criada, carga inicial), que não têm plataforma.
   */
  async funnel(range: ResolvedRange, platform?: ClientPlatform) {
    const identityOnPlatform = platform
      ? sql`AND (CASE WHEN e.user_id IS NOT NULL THEN ${userOnPlatform(sql`e.user_id`, platform)} ELSE e.platform = ${platform} END)`
      : sql``;
    const steps = await Promise.all(
      DEFAULT_FUNNEL.map(async (step) => {
        const count = await this.scalar(sql`
          SELECT count(DISTINCT identity)::int AS v FROM (
            SELECT coalesce(
              e.user_id::text,
              (SELECT d.user_id::text FROM devices d WHERE d.install_id = e.install_id ORDER BY d.created_at LIMIT 1),
              e.install_id
            ) AS identity
            FROM analytics_events e
            WHERE e.name = ${step.event} AND e.occurred_at >= ${range.from} AND e.occurred_at < ${range.to}
              ${identityOnPlatform}
          ) t WHERE identity IS NOT NULL
        `);
        return { key: step.key, label: step.label, event: step.event, count };
      }),
    );

    // Complementa com fontes que existem mesmo sem eventos: cadastro,
    // empresa, carga inicial e assinatura têm tabela própria. Vale o maior
    // dos dois números — o evento de servidor pode não existir para dados
    // anteriores à instalação do analytics.
    const on = (userId: SQL): SQL => (platform ? sql`AND ${userOnPlatform(userId, platform)}` : sql``);
    const [registered, workspaced, uploaded, subscribed] = await Promise.all([
      this.scalar(sql`SELECT count(*)::int AS v FROM users WHERE created_at >= ${range.from} AND created_at < ${range.to} ${on(sql`users.id`)}`),
      this.scalar(sql`SELECT count(DISTINCT owner_user_id)::int AS v FROM workspaces WHERE created_at >= ${range.from} AND created_at < ${range.to} ${on(sql`workspaces.owner_user_id`)}`),
      this.scalar(sql`SELECT count(DISTINCT created_by)::int AS v FROM initial_uploads WHERE status = 'concluida' AND completed_at >= ${range.from} AND completed_at < ${range.to} ${on(sql`initial_uploads.created_by`)}`),
      // "Assinou" = comprou. No Google a linha só nasce com a compra; na web
      // ela nasce no checkout e só conta depois do primeiro pagamento.
      this.scalar(sql`
        SELECT count(DISTINCT purchaser_user_id)::int AS v FROM subscriptions
        WHERE created_at >= ${range.from} AND created_at < ${range.to}
          AND (provider = 'google_play' OR started_at IS NOT NULL)
          ${on(sql`subscriptions.purchaser_user_id`)}
      `),
    ]);
    const fallback: Record<string, number> = { registered, workspace: workspaced, uploaded, subscribed };

    const merged = steps.map((step) => ({ ...step, count: Math.max(step.count, fallback[step.key] ?? 0) }));
    const first = merged[0]?.count ?? 0;
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      platform: platform ?? null,
      steps: merged.map((step, index) => ({
        ...step,
        ofFirst: first > 0 ? step.count / first : null,
        ofPrevious: index > 0 && (merged[index - 1]?.count ?? 0) > 0 ? step.count / (merged[index - 1]?.count ?? 1) : null,
      })),
    };
  }

  /**
   * Retenção por coorte semanal de cadastro: dos usuários criados na semana
   * N, quantos estiveram ativos 1, 2, ... semanas depois.
   */
  async retention(weeks = 8) {
    const rows = await this.db.execute<{ cohort: string; size: number; week: number; active: number }>(sql`
      WITH cohorts AS (
        SELECT id AS user_id, date_trunc('week', created_at AT TIME ZONE 'America/Sao_Paulo') AS cohort
        FROM users
        WHERE deleted_at IS NULL AND created_at >= date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo') - (${weeks} || ' weeks')::interval
      ),
      activity AS (
        SELECT user_id, date_trunc('week', at AT TIME ZONE 'America/Sao_Paulo') AS week FROM (${activitySql()}) a
      ),
      sizes AS (SELECT cohort, count(*)::int AS size FROM cohorts GROUP BY cohort)
      SELECT to_char(c.cohort, 'YYYY-MM-DD') AS cohort, s.size,
             (EXTRACT(EPOCH FROM (a.week - c.cohort)) / 604800)::int AS week,
             count(DISTINCT a.user_id)::int AS active
      FROM cohorts c
      JOIN sizes s ON s.cohort = c.cohort
      JOIN activity a ON a.user_id = c.user_id AND a.week >= c.cohort
      GROUP BY c.cohort, s.size, week
      ORDER BY c.cohort, week
    `);

    const byCohort = new Map<string, { cohort: string; size: number; weeks: Record<number, number> }>();
    for (const row of rows.rows) {
      const entry = byCohort.get(row.cohort) ?? { cohort: row.cohort, size: row.size, weeks: {} };
      entry.weeks[row.week] = row.active;
      byCohort.set(row.cohort, entry);
    }
    return {
      weeks,
      cohorts: [...byCohort.values()].map((entry) => ({
        cohort: entry.cohort,
        size: entry.size,
        retention: Array.from({ length: weeks + 1 }, (_, week) =>
          entry.size > 0 && entry.weeks[week] !== undefined ? entry.weeks[week]! / entry.size : null,
        ),
      })),
    };
  }
}

export { resolveRange };
