import { z } from 'zod';

/**
 * Toda configuração passa por aqui e é validada na inicialização.
 * Um valor ausente ou inválido derruba o processo antes de aceitar tráfego,
 * em vez de falhar de forma obscura na primeira requisição.
 */

const csv = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
    DATABASE_SSL: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    // Chaves Ed25519 em PEM PKCS8/SPKI. Em produção são obrigatórias.
    JWT_PRIVATE_KEY: z.string().optional(),
    JWT_PUBLIC_KEY: z.string().optional(),
    JWT_KEY_ID: z.string().default('k1'),
    JWT_ISSUER: z.string().default('estoquesimples-api'),
    JWT_AUDIENCE: z.string().default('estoquesimples-app'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(60),

    CORS_ORIGINS: z.string().default('').transform(csv),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
    SYNC_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(5_242_880),

    RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),

    // Bloqueio progressivo de conta após tentativas de login malsucedidas.
    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    LOGIN_LOCK_BASE_SECONDS: z.coerce.number().int().positive().default(60),
    LOGIN_LOCK_MAX_SECONDS: z.coerce.number().int().positive().default(3600),

    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),
    EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().positive().default(48),
    INVITE_TTL_DAYS: z.coerce.number().int().positive().default(7),

    // Protocolo de sincronização. Clientes fora da janela recebem 426.
    SYNC_PROTOCOL_VERSION: z.coerce.number().int().positive().default(1),
    SYNC_PROTOCOL_MIN_SUPPORTED: z.coerce.number().int().positive().default(1),
    SYNC_MAX_BATCH_ITEMS: z.coerce.number().int().positive().default(500),
    SYNC_DEFAULT_PAGE_SIZE: z.coerce.number().int().positive().default(500),
    /**
     * Prazo antes de a limpeza poder remover operações já processadas e
     * lápides que todos os aparelhos já leram.
     */
    SYNC_OPERATION_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    SYNC_RETENTION_INTERVAL_MINUTES: z.coerce.number().int().positive().default(720),
    TOMBSTONE_RETENTION_DAYS: z.coerce.number().int().positive().default(180),

    // Por quantos dias o app confia no snapshot de direitos sem contato com a API.
    ENTITLEMENT_OFFLINE_MAX_DAYS: z.coerce.number().int().positive().default(7),

    // Google Play (Fase 3). Opcionais para permitir subir a API sem billing.
    GOOGLE_PLAY_PACKAGE_NAME: z.string().default('br.com.gameloop.estoquesimples'),
    GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    GOOGLE_PUBSUB_VERIFICATION_TOKEN: z.string().optional(),
    BILLING_RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(360),

    /**
     * Provedor de e-mail. `log` só é aceito em development/test — em
     * staging/produção exige `resend` com `RESEND_API_KEY` e `EMAIL_FROM`.
     */
    EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
    EMAIL_FROM: z.string().email().optional(),
    RESEND_API_KEY: z.string().min(10).optional(),

    /**
     * Chave AES-256 (32 bytes em base64) para cifrar purchase tokens em
     * repouso. Obrigatória em staging/produção. Em development/test, se
     * ausente, usa uma chave determinística só para o ambiente local.
     */
    PURCHASE_TOKEN_ENCRYPTION_KEY: z.string().optional(),

    // Feature flag remota: permite desligar a sincronização sem novo release do app.
    FEATURE_SYNC_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    FEATURE_SYNC_MIN_APP_VERSION_CODE: z.coerce.number().int().nonnegative().default(0),

    /**
     * Token dos endpoints de operação (/metrics, /ops/*). Sem ele, esses
     * endereços respondem 404 — aberto seria pior do que ausente.
     */
    OPS_TOKEN: z.string().min(24).optional(),
    OPS_WATCHDOG_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
    /** Prazo máximo aceitável desde a última restauração de teste bem-sucedida. */
    BACKUP_MAX_AGE_HOURS: z.coerce.number().int().positive().default(48),

    JOBS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    // -----------------------------------------------------------------------
    // Painel administrativo (/admin) e analytics de produto
    // -----------------------------------------------------------------------

    /** Desliga o painel e a API administrativa inteira (respondem 404). */
    ADMIN_PANEL_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    /**
     * Primeiro administrador. Criado na subida se ainda não existir nenhum
     * com este e-mail; depois disso as variáveis podem ser removidas. Sem
     * elas, use `npm run admin:create`.
     */
    ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),
    ADMIN_BOOTSTRAP_PASSWORD: z.string().min(12).max(200).optional(),
    ADMIN_BOOTSTRAP_NAME: z.string().min(1).max(120).default('Administrador'),
    /** Sessão do painel: expira por inatividade e tem um teto absoluto. */
    ADMIN_SESSION_IDLE_HOURS: z.coerce.number().int().positive().default(12),
    ADMIN_SESSION_MAX_DAYS: z.coerce.number().int().positive().default(7),
    ADMIN_COOKIE_NAME: z.string().min(1).max(40).default('es_admin'),
    /** Endereço público do painel, usado nos links dos e-mails para a equipe. */
    ADMIN_PANEL_URL: z
      .string()
      .url()
      .optional()
      .transform((value) => value?.replace(/\/+$/, '')),
    /**
     * Quem recebe o e-mail de "solicitação de suporte nova" (separados por
     * vírgula). Vazio = os administradores ativos de papel owner do painel.
     */
    SUPPORT_NOTIFY_EMAILS: z
      .string()
      .default('')
      .transform((value) => csv(value).map((email) => email.toLowerCase()).filter((email) => email.includes('@'))),
    /**
     * Segredo que assina o cookie de sessão do painel. Sem ele, um valor
     * efêmero é gerado a cada boot: o painel funciona, mas todo restart
     * derruba as sessões abertas. Configure em staging/produção
     * (`openssl rand -base64 48`); a subida avisa no log enquanto faltar.
     */
    ADMIN_COOKIE_SECRET: z.string().min(32).optional(),

    /** Eventos mais antigos do que isto são apagados pelo job de retenção. */
    ANALYTICS_RETENTION_DAYS: z.coerce.number().int().positive().default(400),
    ANALYTICS_MAX_BATCH: z.coerce.number().int().positive().max(1000).default(200),
    /** Lotes de eventos por janela de rate limit, por usuário/IP. */
    ANALYTICS_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),

    /** Coleta das avaliações da Play Store (exige a conta de serviço). */
    PLAY_REVIEWS_SYNC_INTERVAL_MINUTES: z.coerce.number().int().positive().default(360),
    /** Modelo usado para rascunhar respostas; a chave fica em admin_settings. */
    OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),

    /**
     * Push (Firebase Cloud Messaging). Sem FIREBASE_SERVICE_ACCOUNT_JSON a
     * mesma conta de serviço do Google Play é usada (mesmo projeto GCP);
     * ela precisa do papel "Firebase Cloud Messaging API Admin".
     */
    FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    FIREBASE_PROJECT_ID: z.string().optional(),
    PUSH_SEND_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(16),

    // -----------------------------------------------------------------------
    // Aplicação web (apps/web), servida pela própria API em outro domínio
    // -----------------------------------------------------------------------

    /**
     * Hosts em que a API entrega a aplicação web na raiz (ex.:
     * `estoquesimples.com.br,www.estoquesimples.com.br`). Nesses hosts só
     * `/v1` e a interface respondem; painel, documentação e métricas ficam
     * de fora. Vazio = a web não é servida por esta instância.
     */
    WEB_APP_HOSTS: z
      .string()
      .default('')
      .transform((value) => csv(value).map((host) => host.toLowerCase())),
    /**
     * Endereço público da aplicação web, sem barra no fim. Entra nos links
     * dos e-mails (convite, redefinição de senha) e no retorno do pagamento.
     */
    WEB_APP_URL: z
      .string()
      .url()
      .optional()
      .transform((value) => value?.replace(/\/+$/, '')),
    /** Cookie httpOnly com o refresh token da sessão web. */
    WEB_SESSION_COOKIE_NAME: z.string().min(1).max(40).default('es_web'),

    // -----------------------------------------------------------------------
    // Asaas: pagamento da assinatura pela web
    // -----------------------------------------------------------------------

    /** Chave da API do Asaas (`$aact_prod_…` ou `$aact_hmlg_…`). Sem ela a venda na web fica desligada. */
    ASAAS_API_KEY: z.string().min(20).optional(),
    ASAAS_ENVIRONMENT: z.enum(['sandbox', 'production']).default('production'),
    /**
     * Token que o Asaas envia no cabeçalho `asaas-access-token` de cada
     * webhook (o mesmo cadastrado no webhook). Obrigatório quando há chave.
     */
    ASAAS_WEBHOOK_TOKEN: z.string().min(32).max(255).optional(),
    /** Dias de acesso mantido com a mensalidade em atraso. */
    ASAAS_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(5),
    /** Assinatura criada e nunca paga é cancelada depois deste prazo. */
    ASAAS_PENDING_EXPIRE_DAYS: z.coerce.number().int().min(1).max(60).default(7),
    /** Assinatura suspensa por falta de pagamento é cancelada depois deste prazo. */
    ASAAS_SUSPENDED_CANCEL_DAYS: z.coerce.number().int().min(1).max(180).default(30),
    ASAAS_RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
  })
  .superRefine((value, ctx) => {
    const isProdLike = value.NODE_ENV === 'production' || value.NODE_ENV === 'staging';
    if (isProdLike && (!value.JWT_PRIVATE_KEY || !value.JWT_PUBLIC_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_PRIVATE_KEY'],
        message:
          'JWT_PRIVATE_KEY e JWT_PUBLIC_KEY são obrigatórios fora de desenvolvimento. Gere com: npm run keys:generate',
      });
    }
    if (isProdLike && !value.GOOGLE_PUBSUB_VERIFICATION_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GOOGLE_PUBSUB_VERIFICATION_TOKEN'],
        message:
          'GOOGLE_PUBSUB_VERIFICATION_TOKEN é obrigatório em staging/produção. Sem ele o webhook do Play fica aberto.',
      });
    }
    if (isProdLike && !value.PURCHASE_TOKEN_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PURCHASE_TOKEN_ENCRYPTION_KEY'],
        message:
          'PURCHASE_TOKEN_ENCRYPTION_KEY é obrigatória em staging/produção. Gere com: openssl rand -base64 32',
      });
    }
    if (value.ADMIN_BOOTSTRAP_EMAIL && !value.ADMIN_BOOTSTRAP_PASSWORD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_BOOTSTRAP_PASSWORD'],
        message: 'ADMIN_BOOTSTRAP_PASSWORD é obrigatória quando ADMIN_BOOTSTRAP_EMAIL está definido.',
      });
    }
    if (value.ASAAS_API_KEY && !value.ASAAS_WEBHOOK_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ASAAS_WEBHOOK_TOKEN'],
        message:
          'ASAAS_WEBHOOK_TOKEN é obrigatório quando ASAAS_API_KEY está definido. Sem ele qualquer um poderia forjar um pagamento.',
      });
    }
    if (value.ASAAS_API_KEY) {
      const sandboxKey = value.ASAAS_API_KEY.startsWith('$aact_hmlg_');
      const productionKey = value.ASAAS_API_KEY.startsWith('$aact_prod_');
      if ((sandboxKey && value.ASAAS_ENVIRONMENT !== 'sandbox') || (productionKey && value.ASAAS_ENVIRONMENT !== 'production')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ASAAS_ENVIRONMENT'],
          message: 'ASAAS_ENVIRONMENT não corresponde ao ambiente da ASAAS_API_KEY (sandbox usa $aact_hmlg_, produção usa $aact_prod_).',
        });
      }
    }
    if (isProdLike && value.EMAIL_PROVIDER === 'log') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_PROVIDER'],
        message: 'EMAIL_PROVIDER=log não é permitido em staging/produção. Use resend.',
      });
    }
    if (value.EMAIL_PROVIDER === 'resend') {
      if (!value.RESEND_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RESEND_API_KEY'],
          message: 'RESEND_API_KEY é obrigatória quando EMAIL_PROVIDER=resend.',
        });
      }
      if (!value.EMAIL_FROM) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_FROM'],
          message: 'EMAIL_FROM é obrigatório quando EMAIL_PROVIDER=resend.',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;
let envFileLoaded = false;

/**
 * Carrega o .env local, se existir.
 *
 * Em produção as variáveis vêm do painel do Railway e nenhum arquivo existe,
 * então a ausência é o caso normal e não deve gerar ruído. Valores já
 * presentes no ambiente têm prioridade sobre o arquivo.
 */
function loadEnvFileOnce(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  try {
    process.loadEnvFile();
  } catch {
    // Arquivo ausente: comportamento esperado fora do desenvolvimento.
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env) loadEnvFileOnce();

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuração inválida:\n${details}`);
  }
  return parsed.data;
}

export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Usado apenas em testes, para trocar a configuração entre casos. */
export function setEnvForTesting(env: Env | null): void {
  cached = env;
}

export const isProduction = (env: Env): boolean => env.NODE_ENV === 'production';
