import { createHmac, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../../src/platform/auth/password.js';
import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { MailerRateLimitError, type EmailMessage } from '../../src/platform/email/mailer.js';
import { LifecycleService } from '../../src/modules/lifecycle/lifecycle.service.js';
import { verifySvix } from '../../src/modules/lifecycle/lifecycle.routes.js';
import { createTestApp, resetDatabase, uniqueEmail, VALID_PASSWORD, type TestContext } from '../helpers/test-app.js';

const WEB = { host: 'web.test', 'x-requested-with': 'estoquesimples-web' };
/** 13 h de Brasília: dentro do horário comercial. */
const BUSINESS = new Date('2026-11-09T16:00:00Z');
const SECRET = `whsec_${Buffer.from('segredo-do-webhook-de-teste-123').toString('base64')}`;

let send: TestContext;
let dry: TestContext;

beforeAll(async () => {
  const common = { LIFECYCLE_ACTIVATION_START: '2000-01-01T00:00:00Z', RESEND_WEBHOOK_SECRET: SECRET, SUPPORT_NOTIFY_EMAILS: 'suporte@exemplo.com.br' };
  send = await createTestApp({ ...common, LIFECYCLE_EMAILS_MODE: 'send' });
  dry = await createTestApp({ ...common, LIFECYCLE_EMAILS_MODE: 'dry_run' });
});

afterAll(async () => {
  await send.close();
  await dry.close();
});

beforeEach(async () => {
  await resetDatabase(send);
  send.mailer.sent.length = 0;
});

async function webUser(context: TestContext, hoursAgo: number, name = 'Ana Souza') {
  const response = await context.app.inject({ method: 'POST', url: '/v1/auth/web/register', headers: WEB, payload: { email: uniqueEmail('ciclo'), password: VALID_PASSWORD, name, device: { installId: `navegador-${randomUUID()}`, platform: 'web', model: 'Chrome' } } });
  expect(response.statusCode).toBe(201);
  const id = response.json().user.id as string;
  await context.services.db.execute(sql`UPDATE users SET created_at = now() - make_interval(hours => ${hoursAgo}) WHERE id = ${id}`);
  return { id, authHeader: { authorization: `Bearer ${response.json().accessToken}` } };
}

const lifecycleMails = (context: TestContext) => context.mailer.sent.filter((message: EmailMessage) => message.kind === 'lifecycle');
const rows = async (context: TestContext) =>
  (await context.services.db.execute<{ id: string; kind: string; status: string; user_id: string }>(sql`SELECT id, kind, status, user_id FROM lifecycle_emails ORDER BY created_at`)).rows;

describe('funil de e-mails do ciclo de vida', () => {
  it('ativação: D+1 sai uma vez, com descadastro, link rastreável e remetente pessoal; quem tem produto não recebe', async () => {
    const semProduto = await webUser(send, 30);
    const comProduto = await webUser(send, 30, 'Bruno');
    const ws = (await send.app.inject({ method: 'GET', url: '/v1/workspaces', headers: comProduto.authHeader })).json().workspaces[0].id;
    await send.app.inject({ method: 'POST', url: `/v1/workspaces/${ws}/products`, headers: comProduto.authHeader, payload: { name: 'Shampoo', quantity: 1 } });
    await webUser(send, 5); // cedo demais

    const service = new LifecycleService(send.services);
    const first = await service.run(BUSINESS);
    expect(first).toMatchObject({ mode: 'send', decided: 1, sent: 1 });
    const [mail] = lifecycleMails(send);
    expect(mail?.subject).toContain('falta 1 passo');
    expect(mail?.text).toContain('Oi, Ana!');
    expect(mail?.fromName).toBe('André, do Estoque Simples');
    expect(mail?.replyTo).toBe('suporte@exemplo.com.br');
    expect(mail?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const [row] = await rows(send);
    expect(row).toMatchObject({ kind: 'activation_d1', status: 'sent', user_id: semProduto.id });
    expect(mail?.text).toContain(`le=${row!.id}`);
    expect(mail?.text).toContain('utm_source=lifecycle');
    expect(mail?.headers?.['List-Unsubscribe']).toContain(`t=${row!.id}`);

    // Mesma rodada de novo: nada repete.
    expect((await service.run(BUSINESS)).decided).toBe(0);
    expect(lifecycleMails(send)).toHaveLength(1);
  });

  it('fora do horário comercial não roda; intervalo de 48 h entre e-mails; cadastros antes do início não entram', async () => {
    const user = await webUser(send, 100); // D+4
    const service = new LifecycleService(send.services);
    expect((await service.run(new Date('2026-11-09T02:00:00Z'))).skipped).toBe('outside_hours');
    await send.services.db.execute(sql`INSERT INTO lifecycle_emails (user_id, kind, dedupe_key, status, created_at) VALUES (${user.id}, 'activation_d1', ${`activation_d1:${user.id}`}, 'sent', now() - interval '20 hours')`);
    expect((await service.run(BUSINESS)).decided).toBe(0);
    await send.services.db.execute(sql`UPDATE lifecycle_emails SET created_at = now() - interval '50 hours'`);
    expect((await service.run(BUSINESS)).sent).toBe(1);
    expect(lifecycleMails(send)[0]?.subject).toContain('planilha');

    const late = await createTestApp({ LIFECYCLE_EMAILS_MODE: 'send', LIFECYCLE_ACTIVATION_START: new Date(Date.now() + 86_400_000).toISOString() });
    try {
      await webUser(late, 30);
      expect((await new LifecycleService(late.services).run(BUSINESS)).decided).toBe(0);
    } finally {
      await late.close();
    }
  });

  it('dry_run registra sem enviar, e o que foi simulado não sai depois', async () => {
    await resetDatabase(dry);
    dry.mailer.sent.length = 0;
    await webUser(dry, 30);
    const result = await new LifecycleService(dry.services).run(BUSINESS);
    expect(result).toMatchObject({ mode: 'dry_run', decided: 1, sent: 0 });
    expect(lifecycleMails(dry)).toHaveLength(0);
    expect((await rows(dry))[0]?.status).toBe('dry_run');
    // O mesmo banco visto pelo app em modo envio: o passo simulado já conta como feito.
    expect((await new LifecycleService({ ...dry.services, env: { ...dry.services.env, LIFECYCLE_EMAILS_MODE: 'send' } }).run(BUSINESS)).decided).toBe(0);
  });

  it('descadastro em 1 clique (GET mostra botão, POST efetiva) bloqueia os próximos', async () => {
    const user = await webUser(send, 30);
    await new LifecycleService(send.services).run(BUSINESS);
    const [row] = await rows(send);
    const get = await send.app.inject({ method: 'GET', url: `/v1/email/descadastrar?t=${row!.id}` });
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain('<form method="post"');
    const optOut = (await send.services.db.execute<{ o: string | null }>(sql`SELECT lifecycle_emails_opt_out_at AS o FROM users WHERE id = ${user.id}`)).rows[0]?.o;
    expect(optOut).toBeNull();
    const post = await send.app.inject({ method: 'POST', url: `/v1/email/descadastrar?t=${row!.id}`, payload: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(post.statusCode).toBe(200);
    expect(post.body).toContain('Pronto');
    await send.services.db.execute(sql`UPDATE lifecycle_emails SET created_at = now() - interval '3 days'`);
    await send.services.db.execute(sql`UPDATE users SET created_at = now() - interval '100 hours' WHERE id = ${user.id}`);
    expect((await new LifecycleService(send.services).run(BUSINESS)).decided).toBe(0);
  });

  it('webhook do Resend: assinatura obrigatória; entrega/abertura registradas; bounce permanente suprime', async () => {
    const user = await webUser(send, 30);
    send.mailer.sent.length = 0;
    await new LifecycleService(send.services).run(BUSINESS);
    const [row] = await rows(send);
    await send.services.db.execute(sql`UPDATE lifecycle_emails SET provider_id = 'resend-123' WHERE id = ${row!.id}`);

    const post = (payload: unknown, sign = true) => {
      const body = JSON.stringify(payload);
      const id = `msg_${randomUUID()}`;
      const ts = String(Math.floor(Date.now() / 1000));
      const key = Buffer.from(SECRET.slice(6), 'base64');
      const signature = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
      return send.app.inject({
        method: 'POST',
        url: '/v1/email/resend-webhook',
        headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sign ? `v1,${signature}` : 'v1,errada' },
        payload: body,
      });
    };
    expect((await post({ type: 'email.opened', data: { email_id: 'resend-123' } }, false)).statusCode).toBe(401);
    expect((await post({ type: 'email.delivered', data: { email_id: 'resend-123' } })).statusCode).toBe(200);
    expect((await post({ type: 'email.opened', data: { email_id: 'resend-123' } })).statusCode).toBe(200);
    expect((await post({ type: 'email.bounced', data: { email_id: 'resend-123', bounce: { type: 'Permanent' } } })).statusCode).toBe(200);
    const after = (await send.services.db.execute<{ d: string | null; o: string | null; b: string | null; s: string | null }>(sql`
      SELECT le.delivered_at AS d, le.opened_at AS o, le.bounced_at AS b, u.email_suppressed_at AS s FROM lifecycle_emails le JOIN users u ON u.id = le.user_id WHERE le.id = ${row!.id}`)).rows[0];
    expect(after?.d && after.o && after.b && after.s).toBeTruthy();
    void user;

    // Clique vindo do web app.
    expect((await send.app.inject({ method: 'POST', url: '/v1/email/clicked', payload: { id: row!.id } })).statusCode).toBe(204);
    const clicked = (await send.services.db.execute<{ c: string | null }>(sql`SELECT clicked_at AS c FROM lifecycle_emails WHERE id = ${row!.id}`)).rows[0]?.c;
    expect(clicked).toBeTruthy();
  });

  it('cota: para no teto diário e ao primeiro erro de limite do provedor (devolvendo o passo)', async () => {
    await webUser(send, 30, 'Um');
    await webUser(send, 30, 'Dois');
    await send.services.db.execute(sql`INSERT INTO email_send_counts (day, kind, count) VALUES ((now() - interval '3 hours')::date, 'email_verification', 69) ON CONFLICT (day, kind) DO UPDATE SET count = 69`);
    const capped = await new LifecycleService(send.services).run(BUSINESS);
    expect(capped.sent).toBe(1);

    await send.services.db.execute(sql`DELETE FROM email_send_counts`);
    await send.services.db.execute(sql`DELETE FROM lifecycle_emails`);
    const original = send.services.mailer;
    send.services.mailer = { send: async () => { throw new MailerRateLimitError('429 daily_quota_exceeded'); } };
    try {
      const limited = await new LifecycleService(send.services).run(BUSINESS);
      expect(limited.stoppedByRateLimit).toBe(true);
      expect(await rows(send)).toHaveLength(0);
    } finally {
      send.services.mailer = original;
    }
  });

  it('limite do plano grátis: aviso em 40 produtos para o dono, uma vez por empresa', async () => {
    const owner = await webUser(send, 24 * 30, 'Carla');
    const ws = (await send.app.inject({ method: 'GET', url: '/v1/workspaces', headers: owner.authHeader })).json().workspaces[0].id;
    await send.services.db.execute(sql`
      INSERT INTO products (id, workspace_id, name, created_at, change_seq)
      SELECT gen_random_uuid(), ${ws}, 'Produto ' || g, now() - interval '20 days', next_change_seq(${ws}) FROM generate_series(1, 41) g`);
    const result = await new LifecycleService(send.services).run(BUSINESS);
    expect(result.sent).toBe(1);
    expect(lifecycleMails(send)[0]?.subject).toContain('40 dos 50');
    expect((await rows(send))[0]?.kind).toBe('limit_40');
  });

  it('painel: resumo por tipo, lista de envios e textos', async () => {
    await webUser(send, 30);
    await new LifecycleService(send.services).run(BUSINESS);
    const email = `owner.${randomUUID()}@exemplo.com.br`;
    await send.services.db.insert(platformAdmins).values({ email, name: 'Dono', passwordHash: await hashPassword('PainelSeguro#2026'), role: 'owner' });
    const login = await send.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: { 'x-requested-with': 'estoquesimples-admin' }, payload: { email, password: 'PainelSeguro#2026' } });
    const raw = login.headers['set-cookie'];
    const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';
    const h = { cookie, 'x-requested-with': 'estoquesimples-admin' };
    const summary = (await send.app.inject({ method: 'GET', url: '/admin/api/lifecycle/summary', headers: h })).json();
    expect(summary.mode).toBe('send');
    expect(summary.kinds.find((k: { kind: string }) => k.kind === 'activation_d1').sent).toBe(1);
    expect(summary.today.lifecycle).toBe(1);
    const list = (await send.app.inject({ method: 'GET', url: '/admin/api/lifecycle/emails', headers: h })).json();
    expect(list.items[0]).toMatchObject({ kind: 'activation_d1', status: 'sent' });
    const templates = (await send.app.inject({ method: 'GET', url: '/admin/api/lifecycle/templates', headers: h })).json();
    // 7 do funil + 3 avisos de cupom + 3 da Black Friday.
    expect(templates.items).toHaveLength(13);
  });
});

describe('assinatura Svix', () => {
  it('confere HMAC, versão e janela de 5 minutos', () => {
    const body = '{"type":"email.opened"}';
    const ts = '1794070000';
    const key = Buffer.from(SECRET.slice(6), 'base64');
    const sig = createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64');
    expect(verifySvix(SECRET, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body, 1794070000 * 1000)).toBe(true);
    expect(verifySvix(SECRET, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body, (1794070000 + 600) * 1000)).toBe(false);
    expect(verifySvix(SECRET, { id: 'msg_1', timestamp: ts, signature: `v2,${sig}` }, body, 1794070000 * 1000)).toBe(false);
  });
});
