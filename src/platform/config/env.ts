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
