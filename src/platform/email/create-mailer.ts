import type { Env } from '../config/env.js';
import type { Logger } from '../observability/logger.js';
import { LoggingMailer, type Mailer } from './mailer.js';
import { ResendMailer } from './resend-mailer.js';

/**
 * Escolhe o mailer a partir de `EMAIL_PROVIDER`.
 *
 * Em staging/produção o schema de env rejeita `log` — aqui só cobrimos o
 * caminho feliz e o stub de desenvolvimento.
 */
export function createMailer(env: Env, logger: Logger): Mailer {
  switch (env.EMAIL_PROVIDER) {
    case 'resend':
      return new ResendMailer(env.RESEND_API_KEY!, env.EMAIL_FROM!, logger);
    case 'log':
    default:
      return new LoggingMailer(logger, true);
  }
}
