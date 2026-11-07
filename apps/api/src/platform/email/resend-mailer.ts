import type { Logger } from '../observability/logger.js';
import { MailerRateLimitError, maskEmail, type EmailMessage, type Mailer, type SendResult } from './mailer.js';

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

  async send(message: EmailMessage): Promise<SendResult> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      // Sem isto, um DNS/TLS mudo no Resend prende o POST /register para sempre.
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        from: message.fromName ? `${message.fromName.replace(/[<>"]/g, '')} <${this.from}>` : this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
      }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      this.logger.error(
        {
          kind: message.kind,
          to: maskEmail(message.to),
          status: response.status,
          detail,
        },
        'falha ao enviar e-mail via Resend',
      );
      if (response.status === 429 || /quota|rate.?limit|daily_quota/i.test(detail)) throw new MailerRateLimitError(`${response.status} ${detail}`);
      throw new Error(`Resend respondeu ${response.status}: ${detail}`);
    }
    const body = (await response.json().catch(() => ({}))) as { id?: string };

    this.logger.info(
      { kind: message.kind, to: maskEmail(message.to) },
      'e-mail enviado via Resend',
    );
    return { id: body.id };
  }
}
