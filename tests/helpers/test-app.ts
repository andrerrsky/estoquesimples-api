import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';

import { buildApp, type BuiltApp } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/platform/config/env.js';
import { InMemoryMailer } from '../../src/platform/email/mailer.js';
import { FakePlayStoreClient } from '../../src/modules/billing/play-client.js';

export interface TestContext extends BuiltApp {
  app: FastifyInstance;
  mailer: InMemoryMailer;
  play: FakePlayStoreClient;
  env: Env;
}

/**
 * Monta a API apontando para o Postgres da suíte.
 *
 * Os limites de rate limit ficam altos por padrão para não interferir nos
 * testes funcionais; os casos que verificam o rate limit passam valores
 * próprios via `overrides`.
 */
export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestContext> {
  const databaseUrl = inject('databaseUrl');

  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'silent',
    RATE_LIMIT_GLOBAL_MAX: '100000',
    RATE_LIMIT_AUTH_MAX: '100000',
    DATABASE_POOL_MAX: '8',
    // Webhook do Play exige token sempre; testes herdam um valor padrão.
    GOOGLE_PUBSUB_VERIFICATION_TOKEN: 'test-pubsub-token',
    ...overrides,
  } as NodeJS.ProcessEnv);

  const mailer = new InMemoryMailer();
  const play = new FakePlayStoreClient();
  const built = await buildApp({ env, mailer, playClient: play });

  return { ...built, mailer, play, env };
}

/**
 * Tabelas de referência populadas por migration. Truncá-las apagaria o RBAC
 * e todo teste seguinte falharia por papel inexistente.
 */
const SEED_TABLES = new Set([
  'schema_migrations',
  'roles',
  'permissions',
  'role_permissions',
  'plans',
  'plan_features',
]);

/**
 * Limpa as tabelas de dados preservando schema e dados de referência.
 * TRUNCATE ... CASCADE resolve a ordem das chaves estrangeiras sozinho, o que
 * evita manter uma lista ordenada à mão.
 */
export async function resetDatabase(context: TestContext): Promise<void> {
  const result = await context.services.db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `);

  const tables = result.rows
    .filter((row) => !SEED_TABLES.has(row.tablename))
    .map((row) => `"${row.tablename}"`);
  if (tables.length === 0) return;

  await context.services.db.execute(
    sql.raw(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`),
  );
}

export interface RegisteredUser {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  deviceId: string | null;
  authHeader: { authorization: string };
}

let emailCounter = 0;

export function uniqueEmail(prefix = 'user'): string {
  emailCounter += 1;
  return `${prefix}.${Date.now()}.${emailCounter}@exemplo.com.br`;
}

export const VALID_PASSWORD = 'SenhaForte#2026';

export async function registerUser(
  context: TestContext,
  options: { email?: string; password?: string; name?: string; installId?: string } = {},
): Promise<RegisteredUser> {
  const email = options.email ?? uniqueEmail();
  const password = options.password ?? VALID_PASSWORD;

  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email,
      password,
      name: options.name ?? 'Usuário de Teste',
      ...(options.installId
        ? { device: { installId: options.installId, platform: 'android' } }
        : {}),
    },
  });

  if (response.statusCode !== 201) {
    throw new Error(`Falha ao registrar usuário de teste: ${response.statusCode} ${response.body}`);
  }

  const body = response.json();
  return {
    userId: body.user.id,
    email,
    password,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    sessionId: body.sessionId,
    deviceId: body.deviceId,
    authHeader: { authorization: `Bearer ${body.accessToken}` },
  };
}

/** Reautentica e devolve um par de tokens novo (usado após mudanças de permissão). */
export async function loginUser(
  context: TestContext,
  email: string,
  password: string,
): Promise<RegisteredUser> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Falha no login de teste: ${response.statusCode} ${response.body}`);
  }

  const body = response.json();
  return {
    userId: body.user.id,
    email,
    password,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    sessionId: body.sessionId,
    deviceId: body.deviceId,
    authHeader: { authorization: `Bearer ${body.accessToken}` },
  };
}
