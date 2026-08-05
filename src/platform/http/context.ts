import type { Env } from '../config/env.js';
import type { TokenService } from '../auth/jwt.js';
import type { PurchaseTokenCipher } from '../crypto/purchase-token.js';
import type { Database, DbHandle } from '../db/client.js';
import type { Mailer } from '../email/mailer.js';
import type { Logger } from '../observability/logger.js';
import type { PlayStoreClient } from '../../modules/billing/play-client.js';

/**
 * Container de dependências da aplicação.
 *
 * Composição explícita em vez de um framework de injeção: a árvore de
 * dependências é pequena e ler este tipo já diz tudo o que a API precisa
 * para funcionar. Facilita também montar variações nos testes.
 */
export interface AppServices {
  env: Env;
  dbHandle: DbHandle;
  db: Database;
  tokens: TokenService;
  /** Cifra purchase tokens do Google Play antes de gravar no banco. */
  purchaseTokens: PurchaseTokenCipher;
  mailer: Mailer;
  playClient: PlayStoreClient;
  /**
   * Logger de processos que rodam fora de uma requisição (fila de tarefas,
   * reconciliação). Dentro de uma rota, prefira `request.log`, que já carrega
   * o identificador de correlação.
   */
  logger?: Logger;
}

/** Identidade autenticada, anexada à request pelo preHandler de autenticação. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  permissionVersion: number;
  deviceId: string | null;
  email: string;
  emailVerified: boolean;
}

/** Resultado da resolução de workspace, anexado quando a rota exige um. */
export interface WorkspaceContext {
  workspaceId: string;
  roleKey: string;
  permissions: ReadonlySet<string>;
  isOwner: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: AppServices;
    authenticate: import('fastify').preHandlerHookHandler;
  }

  interface FastifyRequest {
    auth?: AuthContext;
    workspace?: WorkspaceContext;
  }
}
