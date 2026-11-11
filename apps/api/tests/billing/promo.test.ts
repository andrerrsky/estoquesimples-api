import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LifecycleService } from '../../src/modules/lifecycle/lifecycle.service.js';
import { PromotionsService } from '../../src/modules/promotions/promotions.service.js';
import { AppError, ErrorCode } from '../../src/platform/http/errors.js';
import type { EmailMessage } from '../../src/platform/email/mailer.js';
import { createTestApp, registerUser, resetDatabase, type RegisteredUser, type TestContext } from '../helpers/test-app.js';

const WEBHOOK_TOKEN = 'token-de-webhook-do-asaas-para-os-testes';
const CPF = '529.982.247-25';
const OTHER_CPF = '111.444.777-35';

let context: TestContext;

beforeAll(async () => {
  context = await createTestApp({ LIFECYCLE_EMAILS_MODE: 'send', SUPPORT_NOTIFY_EMAILS: 'suporte@exemplo.com.br' });
});

async function cleanCoupons(): Promise<void> {
  await context.services.db.execute(sql`DELETE FROM coupons WHERE code <> 'BF26'`);
  await context.services.db.execute(sql`UPDATE coupons SET active = true WHERE code = 'BF26'`);
}

afterAll(async () => {
  await resetDatabase(context);
  await cleanCoupons();
  // Preços da migration 0033 de volta, para os próximos arquivos.
  await context.services.db.execute(
    sql`UPDATE plans SET web_price_monthly_cents = 2499, web_price_semiannual_cents = 12990, web_price_yearly_cents = 19990 WHERE key = 'basico'`,
  );
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
  await cleanCoupons();
  context.asaas.reset();
  context.mailer.sent.length = 0;
  vi.restoreAllMocks();
  await context.services.db.execute(
    sql`UPDATE plans SET web_price_monthly_cents = 2499, web_price_semiannual_cents = 12990, web_price_yearly_cents = 19990 WHERE key = 'basico'`,
  );
  // Cupom de teste vigente agora (o BF26 tem datas reais).
  await createCoupon('TESTE26', -86_400_000, 10 * 86_400_000);
});

async function createCoupon(code: string, startOffsetMs: number, endOffsetMs: number): Promise<void> {
  const now = Date.now();
  await context.services.db.execute(sql`
    INSERT INTO coupons (code, label, starts_at, ends_at, yearly_price_cents, monthly_first_cents, monthly_promo_cycles)
    VALUES (${code}, 'Black Friday', ${new Date(now + startOffsetMs)}, ${new Date(now + endOffsetMs)}, 11990, 1249, 1)
  `);
}

async function criarEmpresa(user: RegisteredUser, name = 'Loja da Promoção'): Promise<string> {
  const response = await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: user.authHeader, payload: { name } });
  return response.json().id;
}

const body = (extra: Record<string, unknown> = {}) => ({
  name: 'Maria da Silva',
  cpfCnpj: CPF,
  email: 'maria@exemplo.com.br',
  cycle: 'YEARLY',
  billingType: 'PIX',
  coupon: 'teste26',
  ...extra,
});

function checkout(user: RegisteredUser, ws: string, payload: Record<string, unknown> = body()) {
  return context.app.inject({ method: 'POST', url: `/v1/workspaces/${ws}/billing/web/checkout`, headers: user.authHeader, payload });
}

async function overview(user: RegisteredUser, ws: string) {
  return (await context.app.inject({ method: 'GET', url: `/v1/workspaces/${ws}/billing/web`, headers: user.authHeader })).json();
}

let eventSequence = 0;
function webhook(payment: unknown) {
  eventSequence += 1;
  return context.app.inject({
    method: 'POST',
    url: '/v1/billing/webhooks/asaas',
    headers: { 'asaas-access-token': WEBHOOK_TOKEN },
    payload: { id: `evt_promo&${eventSequence}`, event: 'PAYMENT_RECEIVED', payment },
  });
}

/** Paga a cobrança em aberto da assinatura no Asaas de teste e avisa por webhook. */
async function payOpen(subscriptionRemoteId: string) {
  const payment = [...context.asaas.payments.values()].find((p) => p.subscription === subscriptionRemoteId && p.status === 'PENDING' && !p.deleted)!;
  context.asaas.setPaymentStatus(payment.id, 'RECEIVED');
  expect((await webhook(payment)).statusCode).toBe(200);
  return payment;
}

async function subscriptionRow(ws: string) {
  const rows = await context.services.db.execute<{ id: string; price_cents: number; coupon_id: string | null; promo_restored_at: string | null; provider_subscription_id: string; state: string }>(
    sql`SELECT id, price_cents, coupon_id, promo_restored_at, provider_subscription_id, state FROM subscriptions WHERE workspace_id = ${ws} ORDER BY created_at DESC LIMIT 1`,
  );
  return rows.rows[0]!;
}

async function redemptions() {
  return (
    await context.services.db.execute<{ state: string; document_hash: string; cycle: string; value_cents: number; workspace_id: string }>(
      sql`SELECT state, document_hash, cycle, value_cents, workspace_id FROM coupon_redemptions ORDER BY created_at`,
    )
  ).rows;
}

describe('campanha e cupom (vigência e preços)', () => {
  it('BF26: próxima antes de 20/11, vigente até 01/12 23:59:59 de Brasília, depois some', async () => {
    await context.services.db.execute(sql`DELETE FROM coupons WHERE code <> 'BF26'`);
    const service = new PromotionsService(context.services);
    const pricing = { monthlyCents: 2499, yearlyCents: 19990 };

    const before = new Date('2026-11-11T15:00:00Z');
    const upcoming = await service.featured(before);
    expect(upcoming?.code).toBe('BF26');
    expect(service.view(upcoming!, pricing, before)).toEqual({
      active: false,
      upcoming: true,
      code: 'BF26',
      label: 'Black Friday',
      startsAt: '2026-11-20T03:00:00.000Z',
      endsAt: '2026-12-02T02:59:59.000Z',
      yearly: { fullCents: 19990, promoCents: 11990, monthlyEquivalentCents: 999 },
      monthly: { fullCents: 2499, firstCents: 1249, promoCycles: 1 },
    });
    expect(service.reasonFor(upcoming, before)).toBe('ainda_nao_comecou');

    const lastSecond = new Date('2026-12-02T02:59:59.500Z');
    expect(service.reasonFor(upcoming, new Date('2026-11-20T03:00:00Z'))).toBeNull();
    expect(service.reasonFor(upcoming, lastSecond)).toBeNull();
    expect((await service.featured(lastSecond))?.code).toBe('BF26');

    const after = new Date('2026-12-02T03:00:00Z');
    expect(service.reasonFor(upcoming, after)).toBe('expirado');
    expect(await service.featured(after)).toBeNull();
  });

  it('GET /public/promo: vigente em destaque; sem campanha, active e upcoming falsos', async () => {
    const promo = await context.app.inject({ method: 'GET', url: '/v1/public/promo' });
    expect(promo.statusCode).toBe(200);
    expect(promo.headers['cache-control']).toBe('public, max-age=60');
    expect(promo.json()).toMatchObject({
      active: true,
      upcoming: false,
      code: 'TESTE26',
      yearly: { fullCents: 19990, promoCents: 11990, monthlyEquivalentCents: 999 },
      monthly: { fullCents: 2499, firstCents: 1249, promoCycles: 1 },
    });

    await context.services.db.execute(sql`UPDATE coupons SET active = false`);
    expect((await context.app.inject({ method: 'GET', url: '/v1/public/promo' })).json()).toEqual({ active: false, upcoming: false });
  });

  it('GET /public/coupons/:code: válido, inválido, expirado e ainda não começou', async () => {
    await createCoupon('VELHO', -10 * 86_400_000, -86_400_000);
    await createCoupon('FUTURO', 86_400_000, 10 * 86_400_000);
    const get = async (code: string) => (await context.app.inject({ method: 'GET', url: `/v1/public/coupons/${encodeURIComponent(code)}` })).json();

    expect(await get(' teste26 ')).toMatchObject({ valid: true, reason: null, code: 'TESTE26', active: true, yearly: { promoCents: 11990 } });
    expect(await get('NAOEXISTE')).toEqual({ valid: false, reason: 'invalido' });
    expect(await get('VELHO')).toMatchObject({ valid: false, reason: 'expirado', monthly: { firstCents: 1249 } });
    expect(await get('FUTURO')).toMatchObject({ valid: false, reason: 'ainda_nao_comecou', upcoming: true });
  });
});

describe('checkout com cupom', () => {
  it('anual: cobra o promocional, reserva o uso e, paga a 1ª cobrança, resgata e volta ao preço cheio uma vez', async () => {
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);

    expect((await overview(owner, ws)).promo).toMatchObject({ active: true, code: 'TESTE26', eligible: true, ineligibleReason: null });

    const started = await checkout(owner, ws);
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ state: 'pendente', payment: { valueCents: 11990 } });
    const remote = [...context.asaas.subscriptions.values()][0]!;
    expect(remote).toMatchObject({ cycle: 'YEARLY', value: 119.9 });

    const row = await subscriptionRow(ws);
    expect(row.price_cents).toBe(11990);
    expect(row.coupon_id).not.toBeNull();
    const hash = createHash('sha256').update('52998224725').digest('hex');
    expect(await redemptions()).toEqual([{ state: 'reservado', document_hash: hash, cycle: 'YEARLY', value_cents: 11990, workspace_id: ws }]);
    // Pendente com cupom: ainda elegível (pode retomar).
    expect((await overview(owner, ws)).promo).toMatchObject({ eligible: true });

    // Retomar com o mesmo cupom devolve a mesma cobrança.
    const again = await checkout(owner, ws);
    expect(again.json().payment.id).toBe(started.json().payment.id);
    expect(context.asaas.subscriptions.size).toBe(1);

    await payOpen(remote.id);

    expect((await redemptions())[0]).toMatchObject({ state: 'resgatado' });
    expect(context.asaas.subscriptionUpdates).toEqual([{ id: remote.id, value: 199.9, updatePendingPayments: true }]);
    const restored = await subscriptionRow(ws);
    expect(restored).toMatchObject({ state: 'ativa', price_cents: 19990 });
    expect(restored.promo_restored_at).not.toBeNull();

    const events = await context.services.db.execute<{ properties: Record<string, unknown> }>(
      sql`SELECT properties FROM analytics_events WHERE name = 'coupon.redeemed'`,
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.properties).toMatchObject({ code: 'TESTE26', cycle: 'YEARLY', valueCents: 11990 });

    // Reconsultar de novo não chama o Asaas outra vez nem duplica o evento.
    await context.app.inject({ method: 'POST', url: `/v1/workspaces/${ws}/billing/web/refresh`, headers: owner.authHeader });
    expect(context.asaas.subscriptionUpdates).toHaveLength(1);
    expect((await context.services.db.execute(sql`SELECT 1 FROM analytics_events WHERE name = 'coupon.redeemed'`)).rows).toHaveLength(1);

    const view = await overview(owner, ws);
    expect(view.subscription).toMatchObject({ priceCents: 19990 });
    expect(view.promo).toMatchObject({ eligible: false, ineligibleReason: 'assinatura_ativa' });
    expect(JSON.stringify(view)).not.toContain(hash);
  });

  it('mensal: 1º mês promocional; a cobrança seguinte já gerada também passa ao preço cheio', async () => {
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);
    const started = await checkout(owner, ws, body({ cycle: 'MONTHLY' }));
    expect(started.json()).toMatchObject({ payment: { valueCents: 1249 } });
    const remote = [...context.asaas.subscriptions.values()][0]!;
    const first = [...context.asaas.payments.values()][0]!;
    const second = context.asaas.addPayment(remote.id, '2099-01-01');

    context.asaas.setPaymentStatus(first.id, 'RECEIVED');
    await webhook(first);

    expect(context.asaas.subscriptionUpdates).toEqual([{ id: remote.id, value: 24.99, updatePendingPayments: true }]);
    expect(context.asaas.payments.get(second.id)?.value).toBe(24.99);
    expect(await subscriptionRow(ws)).toMatchObject({ price_cents: 2499 });
    expect((await redemptions())[0]).toMatchObject({ state: 'resgatado', cycle: 'MONTHLY', value_cents: 1249 });
  });

  it('falha ao voltar ao preço cheio não derruba nada e é refeita na próxima reconsulta', async () => {
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);
    await checkout(owner, ws);
    const remote = [...context.asaas.subscriptions.values()][0]!;

    const spy = vi
      .spyOn(context.asaas, 'updateSubscription')
      .mockRejectedValueOnce(new AppError(503, ErrorCode.BILLING_UNAVAILABLE, 'O provedor de pagamento está instável.'));
    await payOpen(remote.id);

    const afterFailure = await subscriptionRow(ws);
    expect(afterFailure).toMatchObject({ state: 'ativa', price_cents: 11990, promo_restored_at: null });
    expect((await redemptions())[0]).toMatchObject({ state: 'resgatado' });

    const refreshed = await context.app.inject({ method: 'POST', url: `/v1/workspaces/${ws}/billing/web/refresh`, headers: owner.authHeader });
    expect(refreshed.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(remote.value).toBe(199.9);
    expect(await subscriptionRow(ws)).toMatchObject({ price_cents: 19990 });
  });

  it('recusa cupom inválido, expirado, que ainda não começou e ciclo fora da oferta, com 409 e mensagem pronta', async () => {
    await createCoupon('VELHO', -10 * 86_400_000, -86_400_000);
    await createCoupon('FUTURO', 86_400_000, 10 * 86_400_000);
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);

    const cases: Array<[Record<string, unknown>, string, RegExp]> = [
      [body({ coupon: 'NAOEXISTE' }), 'invalido', /Cupom inválido/],
      [body({ coupon: 'VELHO' }), 'expirado', /expirou/],
      [body({ coupon: 'FUTURO' }), 'ainda_nao_comecou', /ainda não começou/],
      [body({ cycle: 'SEMIANNUALLY' }), 'ciclo_fora_da_oferta', /anual ou o mensal/],
    ];
    for (const [payload, reason, message] of cases) {
      const response = await checkout(owner, ws, payload);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatchObject({ code: 'CONFLICT', couponReason: reason });
      expect(response.json().error.message).toMatch(message);
    }
    // Nada foi criado no Asaas.
    expect(context.asaas.subscriptions.size).toBe(0);
  });

  it('1 uso por empresa e 1 por CPF/CNPJ; empresa com assinatura não é elegível', async () => {
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);
    await checkout(owner, ws);
    await payOpen([...context.asaas.subscriptions.values()][0]!.id);

    // Com o plano ativo: não elegível (mesmo com outro documento).
    const active = await checkout(owner, ws, body({ cpfCnpj: OTHER_CPF }));
    expect(active.statusCode).toBe(409);
    expect(active.json().error.couponReason).toBe('empresa_nao_elegivel');

    // Outra empresa, mesmo CPF: já usado pelo documento.
    const ws2 = await criarEmpresa(owner, 'Filial');
    const sameDocument = await checkout(owner, ws2);
    expect(sameDocument.statusCode).toBe(409);
    expect(sameDocument.json().error).toMatchObject({ couponReason: 'ja_usado', message: 'Este CPF/CNPJ já usou o cupom TESTE26.' });
    // Sem cupom, a mesma empresa contrata normalmente.
    expect((await checkout(owner, ws2, body({ coupon: undefined, cpfCnpj: OTHER_CPF }))).json()).toMatchObject({ payment: { valueCents: 19990 } });

    // A primeira empresa, depois de a assinatura acabar, não usa de novo nem com outro documento.
    await context.services.db.execute(sql`UPDATE subscriptions SET state = 'expirada' WHERE workspace_id = ${ws}`);
    const sameWorkspace = await checkout(owner, ws, body({ cpfCnpj: OTHER_CPF }));
    expect(sameWorkspace.statusCode).toBe(409);
    expect(sameWorkspace.json().error).toMatchObject({ couponReason: 'ja_usado', message: 'Esta empresa já usou o cupom TESTE26.' });
    expect((await overview(owner, ws)).promo).toMatchObject({ eligible: false, ineligibleReason: 'cupom_ja_usado' });
  });

  it('pendente abandonada não queima o cupom; trocar de ciclo com a pendente recria a assinatura', async () => {
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);
    await checkout(owner, ws);
    const yearly = [...context.asaas.subscriptions.values()][0]!;

    const monthly = await checkout(owner, ws, body({ cycle: 'MONTHLY' }));
    expect(monthly.statusCode).toBe(200);
    expect(monthly.json()).toMatchObject({ state: 'pendente', payment: { valueCents: 1249 } });
    expect(yearly.deleted).toBe(true);
    expect((await redemptions()).map((r) => r.state)).toEqual(['reservado', 'reservado']);

    // Sem cupom agora: a pendente com cupom sai e nasce a de preço cheio.
    const full = await checkout(owner, ws, body({ cycle: 'MONTHLY', coupon: '' }));
    expect(full.json()).toMatchObject({ payment: { valueCents: 2499 } });
    expect(await subscriptionRow(ws)).toMatchObject({ coupon_id: null, price_cents: 2499 });
  });
});

describe('PIX na página', () => {
  it('devolve o QR Code da cobrança PIX em aberto; 404 sem cobrança PIX', async () => {
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);
    const url = `/v1/workspaces/${ws}/billing/web/pix`;

    expect((await context.app.inject({ method: 'GET', url, headers: owner.authHeader })).statusCode).toBe(404);

    const started = await checkout(owner, ws);
    const pix = await context.app.inject({ method: 'GET', url, headers: owner.authHeader });
    expect(pix.statusCode).toBe(200);
    expect(pix.headers['cache-control']).toBe('no-store');
    expect(pix.json()).toMatchObject({ paymentId: started.json().payment.id, valueCents: 11990 });
    expect(pix.json().payload).toContain('br.gov.bcb.pix');
    expect(Buffer.from(pix.json().encodedImage, 'base64').toString()).toMatch(/^png-pay_/);
    expect(pix.json().expirationDate).toEqual(expect.any(String));

    // Boleto: não há PIX a mostrar.
    const ws2 = await criarEmpresa(owner, 'Outra');
    await checkout(owner, ws2, body({ billingType: 'BOLETO', coupon: undefined }));
    expect((await context.app.inject({ method: 'GET', url: `/v1/workspaces/${ws2}/billing/web/pix`, headers: owner.authHeader })).statusCode).toBe(404);

    // Webhook PAYMENT_CONFIRMED: a visão que a web consulta a cada 5 s já sai ativa, sem `refresh`.
    const payment = [...context.asaas.payments.values()][0]!;
    context.asaas.setPaymentStatus(payment.id, 'CONFIRMED');
    const confirmed = await context.app.inject({
      method: 'POST',
      url: '/v1/billing/webhooks/asaas',
      headers: { 'asaas-access-token': WEBHOOK_TOKEN },
      payload: { id: 'evt_pix_confirmado', event: 'PAYMENT_CONFIRMED', payment },
    });
    expect(confirmed.statusCode).toBe(200);
    expect((await overview(owner, ws)).subscription).toMatchObject({ state: 'ativa' });
    // Pago: nada em aberto.
    expect((await context.app.inject({ method: 'GET', url, headers: owner.authHeader })).statusCode).toBe(404);
  });
});

describe('e-mails da promoção', () => {
  const lifecycleMails = () => context.mailer.sent.filter((message: EmailMessage) => message.kind === 'lifecycle');
  const at = (iso: string) => new Date(iso);

  async function bf26Live(): Promise<void> {
    // O BF26 vigente no "agora" dos testes (20/11 a 01/12) e só ele.
    await context.services.db.execute(sql`DELETE FROM coupons WHERE code <> 'BF26'`);
  }

  it('campanha: só base grátis com e-mails liberados, a partir das 10 h, uma vez por data', async () => {
    await bf26Live();
    const free = await registerUser(context, { name: 'Ana Souza' });
    await criarEmpresa(free);
    const optedOut = await registerUser(context);
    await criarEmpresa(optedOut);
    await context.services.db.execute(sql`UPDATE users SET lifecycle_emails_opt_out_at = now() WHERE id = ${optedOut.userId}`);
    const blocked = await registerUser(context);
    await criarEmpresa(blocked);
    await context.services.db.execute(sql`UPDATE users SET status = 'suspended' WHERE id = ${blocked.userId}`);
    const subscriber = await registerUser(context);
    const paidWs = await criarEmpresa(subscriber);
    await checkout(subscriber, paidWs, body({ coupon: undefined }));
    await payOpen([...context.asaas.subscriptions.values()][0]!.id);
    const pending = await registerUser(context);
    await criarEmpresa(pending);
    await context.services.db.execute(sql`INSERT INTO subscriptions (workspace_id, plan_key, provider, provider_subscription_id, provider_customer_id, state)
      SELECT w.id, 'basico', 'asaas', 'sub_pendente_teste', 'cus_teste', 'pendente' FROM workspaces w WHERE w.owner_user_id = ${pending.userId}`);

    const service = new LifecycleService(context.services);
    // 9 h de Brasília no dia 20/11: cedo demais para a campanha.
    expect((await service.run(at('2026-11-20T12:00:00Z'))).decided).toBe(0);

    const launch = await service.run(at('2026-11-20T13:30:00Z'));
    expect(launch).toMatchObject({ decided: 1, sent: 1 });
    const [mail] = lifecycleMails();
    expect(mail?.to).toBe(free.email);
    expect(mail?.subject).toBe('Black Friday: Estoque Simples com 40% off');
    expect(mail?.text.split('\n')[0]).toBe('Plano anual por R$ 119,90, só até 01/12');
    expect(mail?.text).toContain('Oi, Ana!');
    expect(mail?.text).toContain('De R$ 199,90 por R$ 119,90 no ano — menos de R$ 10 por mês.');
    expect(mail?.text).toMatch(/Ativar com desconto: https:\/\/web\.test\/black-friday\?cupom=BF26&utm_source=email&utm_medium=lifecycle&utm_campaign=bf2026&utm_content=bf2026_launch&le=[0-9a-f-]{36}/);
    expect(mail?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    // Mesmo dia, outra rodada: nada repete.
    expect((await service.run(at('2026-11-20T16:00:00Z'))).decided).toBe(0);
    // Dia fora do calendário: nada.
    expect((await service.run(at('2026-11-23T16:00:00Z'))).decided).toBe(0);

    await service.run(at('2026-11-27T14:00:00Z'));
    expect(lifecycleMails().at(-1)?.subject).toBe('É hoje: Black Friday do Estoque Simples com 40% off');
    await service.run(at('2026-12-01T14:00:00Z'));
    const last = lifecycleMails().at(-1)!;
    expect(last.subject).toBe('Último dia: Estoque Simples com 40% off');
    expect(last.text.split('\n')[0]).toBe('Plano anual por R$ 119,90, só até hoje (01/12)');
    expect(lifecycleMails().map((m) => m.to)).toEqual([free.email, free.email, free.email]);

    // Cupom desligado: a campanha para.
    await context.services.db.execute(sql`DELETE FROM lifecycle_emails WHERE kind = 'bf2026_last_day'`);
    await context.services.db.execute(sql`UPDATE coupons SET active = false WHERE code = 'BF26'`);
    expect((await service.run(at('2026-12-01T15:00:00Z'))).decided).toBe(0);
  });

  it('aviso antes da cobrança cheia (anual): 15 e 3 dias antes, mesmo para quem descadastrou das dicas, uma vez por marco', async () => {
    const owner = await registerUser(context, { name: 'Bruno Lima' });
    const ws = await criarEmpresa(owner, 'Mercadinho do Bruno');
    await checkout(owner, ws);
    await payOpen([...context.asaas.subscriptions.values()][0]!.id);
    await context.services.db.execute(sql`UPDATE subscriptions SET next_due_date = '2026-11-24' WHERE workspace_id = ${ws}`);
    await context.services.db.execute(sql`UPDATE users SET lifecycle_emails_opt_out_at = now() WHERE id = ${owner.userId}`);

    const service = new LifecycleService(context.services);
    // 16 dias antes: ainda não.
    expect((await service.run(at('2026-11-08T16:00:00Z'))).decided).toBe(0);

    expect(await service.run(at('2026-11-09T16:00:00Z'))).toMatchObject({ decided: 1, sent: 1 });
    const d15 = lifecycleMails().at(-1)!;
    expect(d15.to).toBe(owner.email);
    expect(d15.subject).toBe('Seu plano Equipe renova em 24/11/2026 por R$ 199,90');
    expect(d15.text).toContain('Mercadinho do Bruno');
    expect(d15.headers?.['List-Unsubscribe']).toBeUndefined();
    expect((await service.run(at('2026-11-10T16:00:00Z'))).decided).toBe(0);

    expect(await service.run(at('2026-11-21T16:00:00Z'))).toMatchObject({ decided: 1, sent: 1 });
    const kinds = (await context.services.db.execute<{ kind: string }>(sql`SELECT kind FROM lifecycle_emails ORDER BY created_at`)).rows.map((r) => r.kind);
    expect(kinds).toEqual(['promo_renewal_yearly_d15', 'promo_renewal_yearly_d3']);
  });

  it('aviso do mensal: 7 dias antes da 2ª mensalidade; não sai para quem cancelou a renovação', async () => {
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);
    await checkout(owner, ws, body({ cycle: 'MONTHLY' }));
    await payOpen([...context.asaas.subscriptions.values()][0]!.id);
    await context.services.db.execute(sql`UPDATE subscriptions SET next_due_date = '2026-11-16' WHERE workspace_id = ${ws}`);

    const service = new LifecycleService(context.services);
    expect((await service.run(at('2026-11-08T16:00:00Z'))).decided).toBe(0);
    await context.services.db.execute(sql`UPDATE subscriptions SET canceled_at = now() WHERE workspace_id = ${ws}`);
    expect((await service.run(at('2026-11-09T16:00:00Z'))).decided).toBe(0);
    await context.services.db.execute(sql`UPDATE subscriptions SET canceled_at = NULL WHERE workspace_id = ${ws}`);

    expect(await service.run(at('2026-11-09T16:00:00Z'))).toMatchObject({ decided: 1, sent: 1 });
    const mail = lifecycleMails().at(-1)!;
    expect(mail.subject).toBe('Sua próxima mensalidade do plano Equipe: R$ 24,99 em 16/11/2026');
    expect(mail.text).toContain('1º mês');
  });
});
