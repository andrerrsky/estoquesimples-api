import type { Logger } from '../observability/logger.js';

/**
 * Porta de envio de e-mail.
 *
 * Implementações: `LoggingMailer` (dev) e `ResendMailer` (staging/produção).
 * A escolha vem de `EMAIL_PROVIDER` via `createMailer`.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Tipo lógico da mensagem, usado em logs e métricas. */
  kind: 'password_reset' | 'email_verification' | 'invite' | 'security_alert';
}

export interface Mailer {
  send: (message: EmailMessage) => Promise<void>;
}

/**
 * Implementação de desenvolvimento: registra que o e-mail seria enviado,
 * sem o corpo (que contém tokens de uso único).
 *
 * Em staging/produção esta classe não pode ser o mailer efetivo — convites,
 * reset e verificação reportariam sucesso e ninguém receberia nada. O boot
 * da aplicação exige um provedor real nesses ambientes.
 */
export class LoggingMailer implements Mailer {
  constructor(
    private readonly logger: Logger,
    private readonly allowSilent: boolean = true,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    if (!this.allowSilent) {
      throw new Error(
        `E-mail não enviado (${message.kind}): nenhum provedor configurado. ` +
          'Defina um mailer real antes de subir em staging/produção.',
      );
    }
    this.logger.info(
      { kind: message.kind, to: maskEmail(message.to) },
      'e-mail não enviado: nenhum provedor configurado',
    );
  }
}

/** Coleta as mensagens em memória. Usado nos testes para inspecionar tokens. */
export class InMemoryMailer implements Mailer {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  lastOfKind(kind: EmailMessage['kind']): EmailMessage | undefined {
    return this.sent.filter((message) => message.kind === kind).at(-1);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}
