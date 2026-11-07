import { sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import type { Logger } from '../observability/logger.js';
import type { EmailMessage, Mailer, SendResult } from './mailer.js';

/** Dia de Brasília (YYYY-MM-DD), a mesma referência da cota diária. */
export function brasiliaDay(date = new Date()): string {
  return new Date(date.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Ponto único de envio: conta cada e-mail que sai, de qualquer tipo, por dia
 * (`email_send_counts`). Os e-mails do ciclo de vida consultam esse total
 * antes de cada envio para nunca gastar a cota diária do provedor de que os
 * essenciais (redefinição de senha, verificação, convite) dependem. Os
 * essenciais nunca são bloqueados aqui: só contados. Falha ao contar não
 * derruba o envio.
 */
export class CountingMailer implements Mailer {
  constructor(
    private readonly inner: Mailer,
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  async send(message: EmailMessage): Promise<SendResult | void> {
    const result = await this.inner.send(message);
    try {
      await this.db.execute(sql`
        INSERT INTO email_send_counts (day, kind, count) VALUES (${brasiliaDay()}::date, ${message.kind}, 1)
        ON CONFLICT (day, kind) DO UPDATE SET count = email_send_counts.count + 1
      `);
    } catch (error) {
      this.logger?.warn({ err: error }, 'não foi possível contar o e-mail enviado');
    }
    return result;
  }
}

/** Total de e-mails enviados hoje (todos os tipos) e só os do ciclo de vida. */
export async function emailsSentToday(db: Database): Promise<{ total: number; lifecycle: number }> {
  const rows = await db.execute<{ total: number; lifecycle: number }>(sql`
    SELECT COALESCE(sum(count), 0)::int AS total,
           COALESCE(sum(count) FILTER (WHERE kind = 'lifecycle'), 0)::int AS lifecycle
    FROM email_send_counts WHERE day = ${brasiliaDay()}::date
  `);
  return rows.rows[0] ?? { total: 0, lifecycle: 0 };
}
