import type { Logger } from '../observability/logger.js';
import { maskEmail, type EmailMessage, type Mailer } from './mailer.js';

/**
 * Envio via Resend (HTTPS). Zero dependências extras — usa `fetch` do Node 22.
 *
 * Adequado para Railway/homologação/produção com pouco volume (convites, reset,
 * verificação). Para SMTP próprio, use `SmtpMailer`.
 */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly logger: Logger,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      // Sem isto, um DNS/TLS mudo no Resend prende o POST /register para sempre.
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      this.logger.error(
        { kind: message.kind, to: maskEmail(message.to), status: response.status },
        'falha ao enviar e-mail via Resend',
      );
      throw new Error(`Resend respondeu ${response.status}: ${detail}`);
    }

    this.logger.info(
      { kind: message.kind, to: maskEmail(message.to) },
      'e-mail enviado via Resend',
    );
  }
}
