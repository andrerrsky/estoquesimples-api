import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { addCycle, deriveAsaasState } from '../../src/modules/billing/asaas/asaas-state.js';
import { documentType } from '../../src/modules/billing/asaas/document.js';
import { AppError, ErrorCode } from '../../src/platform/http/errors.js';
import { createTestApp, registerUser, resetDatabase, type RegisteredUser, type TestContext } from '../helpers/test-app.js';

const WEBHOOK_TOKEN = 'token-de-webhook-do-asaas-para-os-testes';

let context: TestContext;

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
  context.asaas.reset();
  await context.services.db.execute(
    sql`UPDATE plans SET web_price_monthly_cents = 2990, web_price_yearly_cents = 29900 WHERE key = 'basico'`,
  );
});

async function criarEmpresa(user: RegisteredUser): Promise<string> {
  const response = await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: user.authHeader, payload: { name: 'Loja Assinante' } });
  return response.json().id;
}

const checkoutBody = { name: 'Maria da Silva', cpfCnpj: '529.982.247-25', email: 'maria@exemplo.com.br', cycle: 'MONTHLY', billingType: 'PIX' };

function checkout(user: RegisteredUser, ws: string, body: Record<string, unknown> = checkoutBody) {
  return context.app.inject({ method: 'POST', url: `/v1/workspaces/${ws}/billing/web/checkout`, headers: user.authHeader, payload: body });
}

let eventSequence = 0;
function webhook(event: string, payload: Record<string, unknown>, options: { id?: string; token?: string } = {}) {
  eventSequence += 1;
  return context.app.inject({
    method: 'POST',
    url: '/v1/billing/webhooks/asaas',
    headers: { 'asaas-access-token': options.token ?? WEBHOOK_TOKEN },
    payload: { id: options.id ?? `evt_teste&${eventSequence}`, event, dateCreated: '2026-10-01 10:00:00', ...payload },
  });
}

async function entitlement(user: RegisteredUser, ws: string) {
  return (await context.app.inject({ method: 'GET', url: `/v1/workspaces/${ws}/entitlement`, headers: user.authHeader })).json();
}

async function overview(user: RegisteredUser, ws: string) {
  return (await context.app.inject({ method: 'GET', url: `/v1/workspaces/${ws}/billing/web`, headers: user.authHeader })).json();
}

describe('estado derivado do Asaas (função pura)', () => {
  const sub = { status: 'ACTIVE', deleted: false, cycle: 'MONTHLY' as const, nextDueDate: null };
  const at = (date: string) => new Date(`${date}T12:00:00-03:00`);

  it('percorre pendente → ativa → carência → suspensa conforme pagamentos e datas', () => {
    const pending = [{ id: 'p1', status: 'PENDING', dueDate: '2026-10-01', deleted: false }];
    expect(deriveAsaasState({ subscription: sub, payments: pending, now: at('2026-10-01'), graceDays: 5 }).state).toBe('pendente');

    const paid = [{ id: 'p1', status: 'RECEIVED', dueDate: '2026-10-01', deleted: false }];
    const active = deriveAsaasState({ subscription: sub, payments: paid, now: at('2026-10-15'), graceDays: 5 });
    expect(active.state).toBe('ativa');
    expect(active.currentPeriodEnd?.toISOString()).toBe(new Date('2026-11-01T23:59:59-03:00').toISOString());

    const second = [...paid, { id: 'p2', status: 'OVERDUE', dueDate: '2026-11-01', deleted: false }];
    expect(deriveAsaasState({ subscription: sub, payments: second, now: at('2026-11-03'), graceDays: 5 })).toMatchObject({ state: 'carencia', openPaymentId: 'p2' });
    expect(deriveAsaasState({ subscription: sub, payments: second, now: at('2026-11-10'), graceDays: 5 }).state).toBe('suspensa');

    const renewed = [...paid, { id: 'p2', status: 'CONFIRMED', dueDate: '2026-11-01', deleted: false }];
    expect(deriveAsaasState({ subscription: sub, payments: renewed, now: at('2026-11-10'), graceDays: 5 }).state).toBe('ativa');
  });

  it('cancelamento mantém o período pago; estorno e contestação tiram o acesso', () => {
    const paid = [{ id: 'p1', status: 'CONFIRMED', dueDate: '2026-10-01', deleted: false }];
    const cancelled = { ...sub, status: 'INACTIVE', deleted: true };
    expect(deriveAsaasState({ subscription: cancelled, payments: paid, now: at('2026-10-20'), graceDays: 5 }).state).toBe('cancelada_mas_ativa');
    expect(deriveAsaasState({ subscription: cancelled, payments: paid, now: at('2026-11-02'), graceDays: 5 }).state).toBe('expirada');
    expect(deriveAsaasState({ subscription: cancelled, payments: [], now: at('2026-10-02'), graceDays: 5 }).state).toBe('expirada');

    const refunded = [{ id: 'p1', status: 'REFUNDED', dueDate: '2026-10-01', deleted: false }];
    expect(deriveAsaasState({ subscription: sub, payments: refunded, now: at('2026-10-05'), graceDays: 5 }).state).toBe('reembolsada');
    const disputed = [{ id: 'p1', status: 'CHARGEBACK_REQUESTED', dueDate: '2026-10-01', deleted: false }];
    expect(deriveAsaasState({ subscription: sub, payments: disputed, now: at('2026-10-05'), graceDays: 5 }).state).toBe('suspensa');
  });

  it('soma ciclos sem estourar o mês e valida documentos', () => {
    expect(addCycle('2026-01-31', 'MONTHLY')).toBe('2026-02-28');
    expect(addCycle('2026-12-15', 'MONTHLY')).toBe('2027-01-15');
    expect(addCycle('2024-02-29', 'YEARLY')).toBe('2025-02-28');
    expect(documentType('529.982.247-25')).toBe('CPF');
    expect(documentType('11.222.333/0001-81')).toBe('CNPJ');
    expect(documentType('111.111.111-11')).toBeNull();
    expect(documentType('529.982.247-26')).toBeNull();
  });
});

describe('assinatura pela web (Asaas)', () => {
  it('contrata, confirma o pagamento por webhook e libera o plano Equipe', async () => {
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);

    expect((await overview(owner, ws))).toMatchObject({ checkoutAvailable: true, pricing: { monthlyCents: 2990, yearlyCents: 29900 }, subscription: null });

    const invalid = await checkout(owner, ws, { ...checkoutBody, cpfCnpj: '123.456.789-00' });
    expect(invalid.statusCode).toBe(400);

    const started = await checkout(owner, ws);
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ state: 'pendente', payment: { status: 'PENDING', valueCents: 2990 } });
    expect(started.json().payment.invoiceUrl).toContain('asaas.com/i/');
    expect(context.asaas.customers.size).toBe(1);
    expect([...context.asaas.customers.values()][0]).toMatchObject({ externalReference: ws, cpfCnpj: '52998224725' });

    // Repetir a contratação devolve a mesma cobrança: nada de segunda assinatura.
    const again = await checkout(owner, ws);
    expect(again.json().payment.id).toBe(started.json().payment.id);
    expect(context.asaas.subscriptions.size).toBe(1);

    expect((await entitlement(owner, ws))).toMatchObject({ active: false, planKey: 'gratuito' });

    const payment = [...context.asaas.payments.values()][0]!;
    const forged = await webhook('PAYMENT_RECEIVED', { payment }, { token: 'token-errado-token-errado-token-errado' });
    expect(forged.statusCode).toBe(401);

    context.asaas.setPaymentStatus(payment.id, 'RECEIVED');
    const delivered = await webhook('PAYMENT_RECEIVED', { payment: { ...payment, creditCard: { creditCardNumber: '8829', creditCardToken: 'segredo' } } }, { id: 'evt_pago&1' });
    expect(delivered.statusCode).toBe(200);

    const after = await entitlement(owner, ws);
    expect(after).toMatchObject({ active: true, planKey: 'basico', state: 'ativa', limits: { products: null } });
    expect(after.features['equipe.membros'].enabled).toBe(true);

    // O mesmo evento de novo não reprocessa nem duplica.
    const duplicated = await webhook('PAYMENT_RECEIVED', { payment }, { id: 'evt_pago&1' });
    expect(duplicated.statusCode).toBe(200);
    const events = await context.services.db.execute<{ total: number; payload: string }>(
      sql`SELECT count(*)::int AS total, max(payload::text) AS payload FROM subscription_events WHERE provider = 'asaas'`,
    );
    expect(events.rows[0]?.total).toBe(1);
    expect(events.rows[0]?.payload).not.toContain('segredo');

    const view = await overview(owner, ws);
    expect(view.subscription).toMatchObject({ provider: 'asaas', state: 'ativa', billingCycle: 'MONTHLY', managedBy: 'web', priceCents: 2990 });
    expect(view.customer).toMatchObject({ name: 'Maria da Silva', documentType: 'CPF', documentHint: 'final 25' });
    expect(view.payments[0]).toMatchObject({ status: 'RECEIVED', valueCents: 2990 });
    expect(JSON.stringify(view)).not.toContain('52998224725');

    // O proprietário foi avisado na caixa de notificações.
    const inbox = await context.app.inject({ method: 'GET', url: '/v1/notifications', headers: owner.authHeader });
    expect(inbox.json().items[0]).toMatchObject({ type: 'billing.payment_confirmed' });

    const already = await checkout(owner, ws);
    expect(already.statusCode).toBe(409);
  });

  it('eventos fora de ordem convergem: o estado vem sempre da consulta ao provedor', async () => {
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);
    await checkout(owner, ws);
    const payment = [...context.asaas.payments.values()][0]!;
    context.asaas.setPaymentStatus(payment.id, 'RECEIVED');

    // Chega primeiro o "recebido" e depois um "criado" atrasado: continua ativa.
    await webhook('PAYMENT_RECEIVED', { payment });
    await webhook('PAYMENT_CREATED', { payment: { ...payment, status: 'PENDING' } });
    expect((await entitlement(owner, ws)).state).toBe('ativa');
  });

  it('atraso entra em carência, cancelamento preserva o período pago e estorno revoga', async () => {
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);
    await checkout(owner, ws);
    const subscription = [...context.asaas.subscriptions.values()][0]!;
    const first = [...context.asaas.payments.values()][0]!;

    // Primeira mensalidade paga há um mês; a segunda venceu ontem.
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    first.dueDate = day(-32);
    context.asaas.setPaymentStatus(first.id, 'RECEIVED');
    const second = context.asaas.addPayment(subscription.id, day(-1), 'OVERDUE');
    await webhook('PAYMENT_OVERDUE', { payment: second });

    expect((await entitlement(owner, ws))).toMatchObject({ state: 'carencia', active: true });
    expect((await overview(owner, ws)).openPayment).toMatchObject({ status: 'OVERDUE' });

    context.asaas.setPaymentStatus(second.id, 'CONFIRMED');
    await webhook('PAYMENT_CONFIRMED', { payment: second });
    expect((await entitlement(owner, ws)).state).toBe('ativa');

    const cancelled = await context.app.inject({ method: 'POST', url: `/v1/workspaces/${ws}/billing/web/cancel`, headers: owner.authHeader });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().subscription).toMatchObject({ state: 'cancelada_mas_ativa', autoRenewing: false });
    expect(context.asaas.subscriptions.get(subscription.id)?.deleted).toBe(true);
    expect((await entitlement(owner, ws)).active).toBe(true);

    context.asaas.setPaymentStatus(second.id, 'REFUNDED');
    await webhook('PAYMENT_REFUNDED', { payment: second });
    expect((await entitlement(owner, ws))).toMatchObject({ active: false, planKey: 'gratuito' });
  });

  it('webhook que chega antes da assinatura ser gravada é reprocessado pela reconciliação', async () => {
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);

    const early = await webhook('SUBSCRIPTION_CREATED', { subscription: { id: 'sub_000002', customer: 'cus_000001', status: 'ACTIVE' } });
    expect(early.statusCode).toBe(200);

    await checkout(owner, ws);
    const { AsaasBillingService } = await import('../../src/modules/billing/asaas/asaas-billing.service.js');
    const result = await new AsaasBillingService(context.services).retryPendingEvents();
    expect(result.processed).toBe(1);
  });

  it('falha do provedor não deixa assinatura órfã e pendente antiga é cancelada pela reconciliação', async () => {
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);

    context.asaas.failNext = new AppError(503, ErrorCode.BILLING_UNAVAILABLE, 'instável');
    const failed = await checkout(owner, ws);
    expect(failed.statusCode).toBe(503);
    expect((await overview(owner, ws)).subscription).toBeNull();

    await checkout(owner, ws);
    await context.services.db.execute(sql`UPDATE subscriptions SET created_at = now() - interval '30 days' WHERE provider = 'asaas'`);
    const { AsaasBillingService } = await import('../../src/modules/billing/asaas/asaas-billing.service.js');
    const result = await new AsaasBillingService(context.services).reconcile();
    expect(result.cancelled).toBe(1);
    expect((await overview(owner, ws)).subscription).toBeNull();
    expect([...context.asaas.subscriptions.values()][0]?.deleted).toBe(true);
  });

  it('só o proprietário contrata; preço ausente desliga a venda; empresa alheia não enxerga', async () => {
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);
    const stranger = await registerUser(context);

    expect((await checkout(stranger, ws)).statusCode).toBe(404);
    expect((await context.app.inject({ method: 'GET', url: `/v1/workspaces/${ws}/billing/web`, headers: stranger.authHeader })).statusCode).toBe(404);

    await context.services.db.execute(sql`UPDATE plans SET web_price_monthly_cents = NULL, web_price_yearly_cents = NULL WHERE key = 'basico'`);
    expect((await overview(owner, ws)).checkoutAvailable).toBe(false);
    expect((await checkout(owner, ws)).statusCode).toBe(409);
  });
});
