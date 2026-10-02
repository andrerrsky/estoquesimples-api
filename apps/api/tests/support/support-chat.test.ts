import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SUPPORT_NOTIFY_TEAM_JOB, SupportService } from '../../src/modules/support/support.service.js';
import { hashPassword } from '../../src/platform/auth/password.js';
import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { createTestApp, registerUser, resetDatabase, type TestContext } from '../helpers/test-app.js';

let context: TestContext;

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
  await context.services.db.execute(sql`DELETE FROM platform_admins`);
  await context.services.db.execute(sql`DELETE FROM jobs WHERE kind = ${SUPPORT_NOTIFY_TEAM_JOB}`);
  context.mailer.clear();
});

async function createAdmin(role: 'owner' | 'support', status: 'active' | 'disabled' = 'active'): Promise<string> {
  const email = `${role}.${randomUUID()}@exemplo.com.br`;
  await context.services.db.insert(platformAdmins).values({ email, name: `Admin ${role}`, passwordHash: await hashPassword('SenhaDoPainel#2026'), role, status });
  return email;
}

/** O que o chat da web envia para abrir a conversa de um visitante. */
function chatTicket(installId: string, extra: Record<string, unknown> = {}) {
  return {
    installId,
    subject: 'Não consigo entrar na minha conta',
    message: 'Não consigo entrar na minha conta desde ontem.',
    category: 'question',
    contactName: 'Marina',
    contactEmail: 'Marina@Exemplo.com.br',
    device: { platform: 'web', model: 'Chrome 140', osVersion: 'macOS' },
    diagnostics: { channel: 'chat', path: '/entrar' },
    ...extra,
  };
}

describe('chat de suporte da web', () => {
  it('visitante abre a conversa sem conta, só ele a enxerga, e a equipe é avisada por e-mail', async () => {
    const owner = await createAdmin('owner');
    await createAdmin('support');
    await createAdmin('owner', 'disabled');
    const installId = randomUUID();

    const created = await context.app.inject({ method: 'POST', url: '/v1/support/tickets', payload: chatTicket(installId) });
    expect(created.statusCode).toBe(201);
    const ticket = created.json();

    // A conversa é da instalação: outro navegador não a vê nem escreve nela.
    const mine = await context.app.inject({ method: 'GET', url: `/v1/support/tickets/${ticket.id}?installId=${installId}` });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().messages).toHaveLength(1);
    const other = randomUUID();
    expect((await context.app.inject({ method: 'GET', url: `/v1/support/tickets/${ticket.id}?installId=${other}` })).statusCode).toBe(404);
    expect((await context.app.inject({ method: 'GET', url: `/v1/support/tickets?installId=${other}` })).json().tickets).toHaveLength(0);
    const intruder = await context.app.inject({ method: 'POST', url: `/v1/support/tickets/${ticket.id}/messages`, payload: { installId: other, message: 'oi' } });
    expect(intruder.statusCode).toBe(404);

    // O aviso entra na fila junto com a solicitação, uma vez só.
    const queued = await context.services.db.execute<{ payload: { ticketId: string } }>(sql`SELECT payload FROM jobs WHERE kind = ${SUPPORT_NOTIFY_TEAM_JOB}`);
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]?.payload.ticketId).toBe(ticket.id);

    // Só o owner ativo recebe; o e-mail traz quem escreveu, de onde e o texto.
    const result = await new SupportService(context.services).notifyTeamOfNewTicket(ticket.id);
    expect(result).toEqual({ recipients: 1, sent: 1 });
    const mail = context.mailer.lastOfKind('support_new_ticket');
    expect(mail?.to).toBe(owner);
    expect(mail?.subject).toBe(`[Suporte #${ticket.number}] Não consigo entrar na minha conta`);
    expect(mail?.text).toContain('Marina <marina@exemplo.com.br> (sem conta)');
    expect(mail?.text).toContain('Origem: Web (chat)');
    expect(mail?.text).toContain('Não consigo entrar na minha conta desde ontem.');
    expect(mail?.text).toContain(`/suporte/${ticket.id}`);
  });

  it('com sessão, a conversa é da conta e o e-mail identifica a pessoa; mensagens seguintes não avisam de novo', async () => {
    await createAdmin('owner');
    const user = await registerUser(context);
    const installId = randomUUID();

    const created = await context.app.inject({
      method: 'POST',
      url: '/v1/support/tickets',
      headers: user.authHeader,
      // Contato informado é ignorado quando há conta: vale o e-mail dela.
      payload: chatTicket(installId, { contactName: null, contactEmail: 'outro@exemplo.com.br' }),
    });
    expect(created.statusCode).toBe(201);
    const ticket = created.json();

    const reply = await context.app.inject({ method: 'POST', url: `/v1/support/tickets/${ticket.id}/messages`, headers: user.authHeader, payload: { installId, message: 'Mais um detalhe.' } });
    expect(reply.statusCode).toBe(201);
    const queued = await context.services.db.execute(sql`SELECT 1 FROM jobs WHERE kind = ${SUPPORT_NOTIFY_TEAM_JOB}`);
    expect(queued.rows).toHaveLength(1);

    await new SupportService(context.services).notifyTeamOfNewTicket(ticket.id);
    const mail = context.mailer.lastOfKind('support_new_ticket');
    expect(mail?.text).toContain(`<${user.email}> (com conta)`);
    expect(mail?.text).not.toContain('outro@exemplo.com.br');
    // A primeira mensagem é a que vai no aviso, não a mais recente.
    expect(mail?.text).not.toContain('Mais um detalhe.');
  });

  it('SUPPORT_NOTIFY_EMAILS substitui os owners; sem destinatário, nada é enviado', async () => {
    const installId = randomUUID();
    const created = await context.app.inject({ method: 'POST', url: '/v1/support/tickets', payload: chatTicket(installId) });
    const ticket = created.json();

    // Sem owner e sem lista: nada a fazer, e não é erro.
    expect(await new SupportService(context.services).notifyTeamOfNewTicket(ticket.id)).toEqual({ recipients: 0, sent: 0 });
    expect(context.mailer.lastOfKind('support_new_ticket')).toBeUndefined();

    await createAdmin('owner');
    const services = { ...context.services, env: { ...context.services.env, SUPPORT_NOTIFY_EMAILS: ['equipe@exemplo.com.br', 'dono@exemplo.com.br'] } };
    expect(await new SupportService(services).notifyTeamOfNewTicket(ticket.id)).toEqual({ recipients: 2, sent: 2 });
    expect(context.mailer.sent.filter((message) => message.kind === 'support_new_ticket').map((message) => message.to)).toEqual(['equipe@exemplo.com.br', 'dono@exemplo.com.br']);
  });
});
