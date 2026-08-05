import type { FastifyInstance } from 'fastify';

import { getEnv, type Env } from './platform/config/env.js';
import { TokenService, loadJwtKeys } from './platform/auth/jwt.js';
import {
  PurchaseTokenCipher,
  decodePurchaseTokenKey,
  ephemeralDevPurchaseTokenKey,
} from './platform/crypto/purchase-token.js';
import { createDb } from './platform/db/client.js';
import { createMailer } from './platform/email/create-mailer.js';
import { LoggingMailer, type Mailer } from './platform/email/mailer.js';
import { registerBillingJobs } from './modules/billing/billing.jobs.js';
import { registerOpsJobs } from './modules/ops/ops.jobs.js';
import { registerSyncJobs } from './modules/sync/sync.jobs.js';
import { GooglePlayClient, type PlayStoreClient } from './modules/billing/play-client.js';
import type { AppServices } from './platform/http/context.js';
import { buildServer } from './platform/http/server.js';

export interface BuildAppOptions {
  env?: Env;
  /** Permite injetar um mailer de teste em vez do padrão. */
  mailer?: Mailer;
  /** Permite injetar um cliente do Google Play controlado pelo teste. */
  playClient?: PlayStoreClient;
}

export interface BuiltApp {
  app: FastifyInstance;
  services: AppServices;
  close: () => Promise<void>;
}

function createPurchaseTokenCipher(env: Env): PurchaseTokenCipher {
  if (env.PURCHASE_TOKEN_ENCRYPTION_KEY) {
    return new PurchaseTokenCipher(decodePurchaseTokenKey(env.PURCHASE_TOKEN_ENCRYPTION_KEY));
  }
  return new PurchaseTokenCipher(ephemeralDevPurchaseTokenKey());
}

/**
 * Monta a aplicação completa: configuração, banco, chaves, e-mail e HTTP.
 * Usada tanto pelo boot de produção quanto pelos testes de integração.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const env = options.env ?? getEnv();
  const dbHandle = createDb(env);
  const keys = await loadJwtKeys(env, (message) => {
    // Em teste a chave efêmera é o comportamento pretendido; avisar em toda
    // suíte só polui a saída.
    if (env.NODE_ENV !== 'test') console.warn(`[auth] ${message}`);
  });

  const purchaseTokens = createPurchaseTokenCipher(env);

  const services: AppServices = {
    env,
    dbHandle,
    db: dbHandle.db,
    tokens: new TokenService(keys, env),
    purchaseTokens,
    // Placeholder até o logger do Fastify existir; trocado abaixo.
    mailer: options.mailer ?? new LoggingMailer(console as never, true),
    playClient: options.playClient ?? new GooglePlayClient(env),
  };

  const app = await buildServer(services);
  services.logger = app.log;
  if (!options.mailer) {
    services.mailer = createMailer(env, app.log);
  }

  registerBillingJobs(services);
  registerSyncJobs(services);
  registerOpsJobs(services);

  return {
    app,
    services,
    close: async () => {
      await app.close();
      await dbHandle.close();
    },
  };
}
