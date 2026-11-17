import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SupportService } from '../../src/modules/support/support.service.js';
import { hashPassword } from '../../src/platform/auth/password.js';
import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { startJobRunner } from '../../src/platform/jobs/runner.js';
import { createTestApp, resetDatabase, type TestContext } from '../helpers/test-app.js';

const PASSWORD = 'PainelSeguro#2026';
const CSRF = { 'x-requested-with': 'estoquesimples-admin' };

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
  await context.services.db.execute(sql`DELETE FROM jobs WHERE kind LIKE 'support.%'`);
  context.mailer.clear();
});

async function ownerCookie(): Promise<string> {
  const email = `dono.${randomUUID()}@exemplo.com.br`;
  await context.services.db.insert(platformAdmins).values({ email, name: 'Dono do Estoque', passwordHash: await hashPassword(PASSWORD), role: 'owner' });
  const login = await context.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: CSRF, payload: { email, password: PASSWORD } });
  const raw = login.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
}

/** O que o chat da web manda para abrir a conversa. */
function chatTicket(installId: string, message: string) {
  return {
    installId,
    subject: message.slice(0, 80),
    message,
    category: 'question',
    contactName: 'Marina Souza',
    contactEmail: 'marina@exemplo.com.br',
    device: { platform: 'web', model: 'Chrome 140', osVersion: 'macOS' },
    diagnostics: { channel: 'chat', path: '/ajuda' },
  };
}

/**
 * Finge a OpenAI: devolve o JSON combinado e guarda os prompts, para o teste
 * conferir que os números dos planos vieram do banco, e não do prompt.
 */
function fakeOpenAi(answer: Record<string, unknown>) {
  const prompts: Array<{ system: string; user: string }> = [];
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.openai.com/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), { status: 200 });
    if (url.startsWith('https://api.openai.com/v1/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: Array<{ content: string }>; max_tokens?: number };
      // O ping de validação da chave manda um token só; não é uma resposta ao cliente.
      if (body.max_tokens === 1) return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
      prompts.push({ system: body.messages[0]?.content ?? '', user: body.messages[1]?.content ?? '' });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 });
    }
    return realFetch(input, init);
  });
  return { prompts, restore: () => spy.mockRestore() };
}

async function ligarRespostaAutomatica(cookie: string): Promise<void> {
  expect((await context.app.inject({ method: 'PUT', url: '/admin/api/settings/openai', headers: { cookie, ...CSRF }, payload: { apiKey: `sk-${'c'.repeat(40)}` } })).statusCode).toBe(200);
  const ligar = await context.app.inject({ method: 'PUT', url: '/admin/api/support/settings', headers: { cookie, ...CSRF }, payload: { aiAutoReplyEnabled: true } });
  expect(ligar.json()).toEqual({ aiAutoReplyEnabled: true });
}

/** Espera a fila processar as tarefas do atendimento. */
async function filaVazia(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const pending = await context.services.db.execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM jobs WHERE kind LIKE 'support.%' AND completed_at IS NULL AND failed_at IS NULL`,
    );
    if ((pending.rows[0]?.total ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('resposta automática por IA no suporte', () => {
  it('desligada, nada muda: nenhuma tarefa de IA é enfileirada', async () => {
    const installId = randomUUID();
    const created = await context.app.inject({ method: 'POST', url: '/v1/support/tickets', payload: chatTicket(installId, 'Quantos produtos o plano gratuito sincroniza?') });
    expect(created.statusCode).toBe(201);

    const jobs = await context.services.db.execute<{ kind: string }>(sql`SELECT kind FROM jobs`);
    expect(jobs.rows.map((row) => row.kind)).toEqual(['support.notify_team']);
  });

  it('ligada, responde a dúvida de plano com os números do banco e deixa a conversa como respondida', async () => {
    const cookie = await ownerCookie();
    const openai = fakeOpenAi({ acao: 'responder', resposta: 'Marina, no Gratuito a nuvem guarda até 50 produtos; no Equipe não tem limite.' });
    const stop = startJobRunner(context.services, context.app.log, { intervalMs: 50 });
    try {
      await ligarRespostaAutomatica(cookie);
      const installId = randomUUID();
      const created = await context.app.inject({ method: 'POST', url: '/v1/support/tickets', payload: chatTicket(installId, 'Quantos produtos o plano gratuito sincroniza na nuvem?') });
      const ticketId = (created.json() as { id: string }).id;
      await filaVazia();

      const detail = (await context.app.inject({ method: 'GET', url: `/v1/support/tickets/${ticketId}?installId=${installId}` })).json() as {
        ticket: { status: string };
        messages: Array<{ author: string; authorName: string | null; body: string; ai?: boolean }>;
      };
      expect(detail.ticket.status).toBe('answered');
      const resposta = detail.messages.at(-1)!;
      expect(resposta.author).toBe('support');
      expect(resposta.ai).toBe(true);
      // Sem nome de atendente: a conversa mostra a equipe, não uma pessoa inventada.
      expect(resposta.authorName).toBe('Equipe Estoque Simples');
      expect(resposta.body).toContain('50 produtos');

      // O prompt levou os planos lidos do banco (os mesmos de Painel › Planos),
      // o primeiro nome do cliente e as regras de atendimento do dono.
      const { system, user } = openai.prompts[0]!;
      expect(system).toContain('Plano "Gratuito"');
      expect(system).toMatch(/produtos sincronizados na nuvem: 50/);
      expect(system).toContain('Não existe plano "Pro"');
      expect(system).toContain('Nunca ofereça reembolso, desconto ou cupom.');
      expect(user).toContain('Primeiro nome do cliente: Marina.');
      expect(user).not.toContain('marina@exemplo.com.br');

      // Resposta automática não marca "precisa de humano" nem avisa o dono.
      const marcado = await context.services.db.execute<{ needs_human: boolean }>(sql`SELECT needs_human FROM support_tickets WHERE id = ${ticketId}`);
      expect(marcado.rows[0]?.needs_human).toBe(false);
      expect(context.mailer.lastOfKind('support_needs_human')).toBeUndefined();
    } finally {
      stop();
      openai.restore();
    }
  });

  it('pedido de reembolso: a IA escalona, nada é enviado ao cliente e o dono recebe um e-mail só', async () => {
    const cookie = await ownerCookie();
    const openai = fakeOpenAi({ acao: 'humano', motivo: 'Pedido de reembolso: depende de uma pessoa.' });
    const stop = startJobRunner(context.services, context.app.log, { intervalMs: 50 });
    try {
      await ligarRespostaAutomatica(cookie);
      const installId = randomUUID();
      const created = await context.app.inject({ method: 'POST', url: '/v1/support/tickets', payload: chatTicket(installId, 'Quero o reembolso da assinatura que paguei ontem.') });
      const ticketId = (created.json() as { id: string }).id;
      await filaVazia();

      // O cliente escreve de novo: a segunda mensagem não gera um segundo e-mail.
      await context.app.inject({ method: 'POST', url: `/v1/support/tickets/${ticketId}/messages`, payload: { installId, message: 'Alguém pode ver isso?' } });
      await filaVazia();

      const detail = (await context.app.inject({ method: 'GET', url: `/v1/support/tickets/${ticketId}?installId=${installId}` })).json() as {
        ticket: { status: string };
        messages: Array<{ author: string }>;
      };
      // Nenhuma resposta ao cliente, e a nota do escalonamento é interna.
      expect(detail.messages.every((message) => message.author === 'user')).toBe(true);
      expect(detail.ticket.status).toBe('open');

      const row = await context.services.db.execute<{ needs_human: boolean; needs_human_reason: string }>(
        sql`SELECT needs_human, needs_human_reason FROM support_tickets WHERE id = ${ticketId}`,
      );
      expect(row.rows[0]?.needs_human).toBe(true);
      expect(row.rows[0]?.needs_human_reason).toContain('reembolso');

      const avisos = context.mailer.sent.filter((message) => message.kind === 'support_needs_human');
      expect(avisos).toHaveLength(1);
      expect(avisos[0]!.subject).toContain('precisa de você');
      expect(avisos[0]!.text).toContain('Pedido de reembolso');
      expect(avisos[0]!.text).toContain('Marina');
      // Regra de atendimento: no aviso ao dono também vai só o primeiro nome.
      expect(avisos[0]!.text).not.toContain('marina@exemplo.com.br');
    } finally {
      stop();
      openai.restore();
    }
  });

  it('OpenAI fora do ar: escalona em silêncio em vez de arriscar uma resposta errada', async () => {
    const cookie = await ownerCookie();
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://api.openai.com/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), { status: 200 });
      if (url.startsWith('https://api.openai.com/v1/chat/completions')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { max_tokens?: number };
        if (body.max_tokens === 1) return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
        return new Response(JSON.stringify({ error: { message: 'upstream caiu' } }), { status: 500 });
      }
      return realFetch(input, init);
    });
    const stop = startJobRunner(context.services, context.app.log, { intervalMs: 50 });
    try {
      await ligarRespostaAutomatica(cookie);
      const installId = randomUUID();
      const created = await context.app.inject({ method: 'POST', url: '/v1/support/tickets', payload: chatTicket(installId, 'O app não abre no meu celular.') });
      const ticketId = (created.json() as { id: string }).id;
      await filaVazia();

      const row = await context.services.db.execute<{ needs_human: boolean }>(sql`SELECT needs_human FROM support_tickets WHERE id = ${ticketId}`);
      expect(row.rows[0]?.needs_human).toBe(true);
      expect(context.mailer.sent.filter((message) => message.kind === 'support_needs_human')).toHaveLength(1);
      // A tarefa não fica em repetição: já decidiu o que fazer.
      const jobs = await context.services.db.execute<{ attempts: number; completed_at: string | null }>(
        sql`SELECT attempts, completed_at FROM jobs WHERE kind = 'support.ai_reply'`,
      );
      expect(jobs.rows[0]?.completed_at).not.toBeNull();
      expect(jobs.rows[0]?.attempts).toBe(1);
    } finally {
      stop();
      spy.mockRestore();
    }
  });

  it('pessoa do time já na conversa: a IA não responde mais', async () => {
    const cookie = await ownerCookie();
    const openai = fakeOpenAi({ acao: 'responder', resposta: 'Resposta que não deveria ser enviada.' });
    const stop = startJobRunner(context.services, context.app.log, { intervalMs: 50 });
    try {
      await ligarRespostaAutomatica(cookie);
      const installId = randomUUID();
      const created = await context.app.inject({ method: 'POST', url: '/v1/support/tickets', payload: chatTicket(installId, 'Como exporto o estoque para planilha?') });
      const ticketId = (created.json() as { id: string }).id;
      await filaVazia();
      const antes = openai.prompts.length;

      // Alguém do time responde à mão e o cliente volta a escrever.
      await context.app.inject({ method: 'POST', url: `/admin/api/support/tickets/${ticketId}/messages`, headers: { cookie, ...CSRF }, payload: { body: 'Pelo menu Relatórios, Marina.', internal: false } });
      await context.app.inject({ method: 'POST', url: `/v1/support/tickets/${ticketId}/messages`, payload: { installId, message: 'Achei, obrigada!' } });
      await filaVazia();

      expect(openai.prompts.length).toBe(antes);
      const row = await context.services.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM support_messages WHERE ticket_id = ${ticketId} AND ai`);
      // Só a primeira resposta da IA; depois do humano, nenhuma.
      expect(row.rows[0]?.total).toBe(1);
    } finally {
      stop();
      openai.restore();
    }
  });
});

describe('contexto entregue à IA', () => {
  it('monta os planos a partir de plan_features, e muda quando o painel muda o preço', async () => {
    const { planFactsFor } = await import('../../src/modules/support/support-ai.js');
    const antes = await planFactsFor(context.services.db);
    expect(antes).toContain('Plano "Equipe"');
    expect(antes).toContain('pessoas na empresa: sem limite');
    // Recurso de liga/desliga não vira "sem limite" só porque não tem número.
    expect(antes).toContain('análise avançada: sim');
    expect(antes).toContain('identidade visual da empresa: sim');
    // No gratuito, o número é a resposta: 50 produtos e 1 pessoa.
    expect(antes).toMatch(/Gratuito[\s\S]*produtos sincronizados na nuvem: 50/);
    expect(antes).toMatch(/Gratuito[\s\S]*pessoas na empresa: 1/);

    // `plans` é tabela de referência (o reset não a limpa): o preço volta ao
    // que era para não vazar para os outros arquivos de teste.
    const original = (await context.services.db.execute<{ cents: number | null }>(sql`SELECT web_price_monthly_cents AS cents FROM plans WHERE key = 'basico'`)).rows[0]?.cents ?? null;
    try {
      await context.services.db.execute(sql`UPDATE plans SET web_price_monthly_cents = 3499 WHERE key = 'basico'`);
      const depois = await planFactsFor(context.services.db);
      expect(depois).toContain('R$ 34,99');
    } finally {
      await context.services.db.execute(sql`UPDATE plans SET web_price_monthly_cents = ${original} WHERE key = 'basico'`);
    }
  });
});
