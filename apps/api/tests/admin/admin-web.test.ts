import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { SubscriptionPurchaseV2 } from '../../src/modules/billing/play-client.js';
import { hashPassword } from '../../src/platform/auth/password.js';
import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { createTestApp, registerUser, resetDatabase, uniqueEmail, VALID_PASSWORD, type RegisteredUser, type TestContext } from '../helpers/test-app.js';

/**
 * Painel cobrindo Android e web nas mesmas estruturas: preço da web nos
 * planos, provedor nas assinaturas (Google Play × Asaas), plataforma em
 * usuários, analytics, suporte e campanhas.
 */

const ADMIN_PASSWORD = 'PainelSeguro#2026';
const CSRF = { 'x-requested-with': 'estoquesimples-admin' };
const WEBHOOK_TOKEN = 'token-de-webhook-do-asaas-para-os-testes';
const CPF = '529.982.247-25';
const CPF_DIGITS = '52998224725';
const PURCHASE_TOKEN = 'token-de-compra-do-google-que-nunca-pode-vazar';

let context: TestContext;
let originalPrices: { monthly: number | null; yearly: number | null };

async function createAdmin(role: 'owner' | 'support' | 'viewer'): Promise<string> {
  const email = `${role}.${randomUUID()}@exemplo.com.br`;
  await context.services.db.insert(platformAdmins).values({
    email,
    name: `Admin ${role}`,
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role,
  });
  return email;
}

async function loginAs(role: 'owner' | 'support' | 'viewer'): Promise<{ cookie: string; email: string }> {
  const email = await createAdmin(role);
  const response = await context.app.inject({
    method: 'POST',
    url: '/admin/api/auth/login',
    headers: CSRF,
    payload: { email, password: ADMIN_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return { cookie: (raw as string).split(';')[0] as string, email };
}

function get(cookie: string, url: string) {
  return context.app.inject({ method: 'GET', url: `/admin/api${url}`, headers: { cookie } });
}

function mutate(cookie: string, method: 'POST' | 'PATCH' | 'PUT', url: string, payload?: Record<string, unknown>) {
  return context.app.inject({ method, url: `/admin/api${url}`, headers: { cookie, ...CSRF }, ...(payload ? { payload } : {}) });
}

/** Conta criada pela web: o "aparelho" é o navegador, com `platform: web`. */
async function registerWebUser(installId: string): Promise<RegisteredUser> {
  const email = uniqueEmail('web');
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: VALID_PASSWORD, name: 'Usuária da Web', device: { installId, platform: 'web', model: 'Chrome 140', osVersion: 'macOS' } },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return {
    userId: body.user.id,
    email,
    password: VALID_PASSWORD,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    sessionId: body.sessionId,
    deviceId: body.deviceId,
    authHeader: { authorization: `Bearer ${body.accessToken}` },
  };
}

async function createWorkspace(user: RegisteredUser, name: string): Promise<string> {
  const response = await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: user.authHeader, payload: { name } });
  expect(response.statusCode).toBe(201);
  return response.json().id;
}

function checkout(user: RegisteredUser, workspaceId: string) {
  return context.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/billing/web/checkout`,
    headers: user.authHeader,
    payload: { name: 'Maria da Silva', cpfCnpj: CPF, email: 'maria@exemplo.com.br', cycle: 'MONTHLY', billingType: 'PIX' },
  });
}

let eventSequence = 0;
function asaasWebhook(event: string, payload: Record<string, unknown>) {
  eventSequence += 1;
  return context.app.inject({
    method: 'POST',
    url: '/v1/billing/webhooks/asaas',
    headers: { 'asaas-access-token': WEBHOOK_TOKEN },
    payload: { id: `evt_painel&${eventSequence}`, event, dateCreated: '2026-10-01 10:00:00', ...payload },
  });
}

/** Assinatura da web paga: checkout + webhook de pagamento recebido. */
async function subscribeOnWeb(user: RegisteredUser, workspaceId: string): Promise<string> {
  const started = await checkout(user, workspaceId);
  expect(started.statusCode).toBe(200);
  const payment = [...context.asaas.payments.values()].at(-1)!;
  context.asaas.setPaymentStatus(payment.id, 'RECEIVED');
  expect((await asaasWebhook('PAYMENT_RECEIVED', { payment })).statusCode).toBe(200);
  return started.json().subscriptionId as string;
}

function activePurchase(): SubscriptionPurchaseV2 {
  return {
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    startTime: new Date(Date.now() - 86_400_000).toISOString(),
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    lineItems: [
      {
        productId: 'assinatura',
        expiryTime: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        autoRenewingPlan: { autoRenewEnabled: true },
        offerDetails: { basePlanId: 'plano-basico', offerId: 'oferta' },
      },
    ],
  };
}

/** Assinatura do app: comprovante do Google Play vinculado à empresa. */
async function subscribeOnPlay(user: RegisteredUser, workspaceId: string): Promise<void> {
  context.play.setSubscription(PURCHASE_TOKEN, activePurchase());
  const linked = await context.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/billing/subscriptions`,
    headers: user.authHeader,
    payload: { purchaseToken: PURCHASE_TOKEN },
  });
  expect(linked.statusCode).toBeLessThan(300);
}

function sendEvents(user: RegisteredUser, installId: string, platform: 'android' | 'web', names: string[]) {
  return context.app.inject({
    method: 'POST',
    url: '/v1/analytics/events',
    headers: user.authHeader,
    payload: {
      device: { installId, platform, appVersionCode: 30 },
      events: names.map((name) => ({ id: randomUUID(), name, occurredAt: Date.now(), properties: name === 'screen.viewed' ? { screen: `${platform}-inicio` } : {} })),
    },
  });
}

beforeAll(async () => {
  context = await createTestApp();
  // `plans` é tabela de referência (não é truncada): guarda o preço para
  // devolver como estava e não vazar estado para os outros arquivos.
  const rows = await context.services.db.execute<{ monthly: number | null; yearly: number | null }>(
    sql`SELECT web_price_monthly_cents AS monthly, web_price_yearly_cents AS yearly FROM plans WHERE key = 'basico'`,
  );
  originalPrices = { monthly: rows.rows[0]?.monthly ?? null, yearly: rows.rows[0]?.yearly ?? null };
});

afterAll(async () => {
  await context.services.db.execute(
    sql`UPDATE plans SET web_price_monthly_cents = ${originalPrices.monthly}, web_price_yearly_cents = ${originalPrices.yearly} WHERE key = 'basico'`,
  );
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
  context.asaas.reset();
  context.fcm.sent.length = 0;
  await context.services.db.execute(
    sql`UPDATE plans SET web_price_monthly_cents = 2990, web_price_yearly_cents = 29900 WHERE key = 'basico'`,
  );
});

describe('painel: preço da web nos planos', () => {
  it('owner edita o preço com motivo, fica auditado e passa a valer no checkout', async () => {
    const { cookie } = await loginAs('owner');

    const before = await get(cookie, '/billing/plans');
    expect(before.statusCode).toBe(200);
    expect(before.json().asaasConfigured).toBe(true);
    const basico = before.json().items.find((plan: { key: string }) => plan.key === 'basico');
    expect(basico).toMatchObject({ webPriceMonthlyCents: 2990, webPriceYearlyCents: 29900, soldOnWeb: true });
    expect(before.json().items.find((plan: { key: string }) => plan.key === 'gratuito')).toMatchObject({ webPriceMonthlyCents: null, soldOnWeb: false });

    const semMotivo = await mutate(cookie, 'PATCH', '/billing/plans/basico', { webPriceMonthlyCents: 3990 });
    expect(semMotivo.statusCode).toBe(400);

    const saved = await mutate(cookie, 'PATCH', '/billing/plans/basico', { webPriceMonthlyCents: 3990, webPriceYearlyCents: null, reason: 'Reajuste anual; plano anual sai da venda' });
    expect(saved.statusCode).toBe(200);

    const after = await get(cookie, '/billing/plans');
    expect(after.json().items.find((plan: { key: string }) => plan.key === 'basico')).toMatchObject({ webPriceMonthlyCents: 3990, webPriceYearlyCents: null });

    const audit = await get(cookie, '/audit/admins?action=plan.updated');
    expect(audit.json().items[0]).toMatchObject({
      action: 'plan.updated',
      targetId: 'basico',
      metadata: {
        reason: 'Reajuste anual; plano anual sai da venda',
        changes: { webPriceMonthlyCents: { from: 2990, to: 3990 }, webPriceYearlyCents: { from: 29900, to: null } },
      },
    });

    // É este preço que a web usa: mensal novo, anual fora da venda.
    const owner = await registerUser(context);
    const ws = await createWorkspace(owner, 'Loja do Preço');
    const pricing = await context.app.inject({ method: 'GET', url: `/v1/workspaces/${ws}/billing/web`, headers: owner.authHeader });
    expect(pricing.json().pricing).toEqual({ monthlyCents: 3990, yearlyCents: null });
  });

  it('valida centavos (inteiro, piso e teto), restringe ao plano da web e exige owner', async () => {
    const { cookie } = await loginAs('owner');
    const patch = (body: Record<string, unknown>, plan = 'basico') => mutate(cookie, 'PATCH', `/billing/plans/${plan}`, { reason: 'teste de validação', ...body });

    expect((await patch({ webPriceMonthlyCents: 499 })).statusCode).toBe(400);
    expect((await patch({ webPriceMonthlyCents: 0 })).statusCode).toBe(400);
    expect((await patch({ webPriceMonthlyCents: -2990 })).statusCode).toBe(400);
    expect((await patch({ webPriceMonthlyCents: 29.9 })).statusCode).toBe(400);
    expect((await patch({ webPriceMonthlyCents: '2990' })).statusCode).toBe(400);
    expect((await patch({ webPriceYearlyCents: 1_000_001 })).statusCode).toBe(400);
    // Plano que a web não vende não recebe preço (seria configuração morta).
    expect((await patch({ webPriceMonthlyCents: 2990 }, 'gratuito')).statusCode).toBe(400);
    expect((await patch({ webPriceMonthlyCents: 2990 }, 'inexistente')).statusCode).toBe(404);
    // Sem mudança de verdade não há o que auditar.
    expect((await patch({ webPriceMonthlyCents: 2990 })).statusCode).toBe(400);

    const support = await loginAs('support');
    const forbidden = await mutate(support.cookie, 'PATCH', '/billing/plans/basico', { webPriceMonthlyCents: 3990, reason: 'sem permissão' });
    expect(forbidden.statusCode).toBe(403);

    const rows = await context.services.db.execute<{ monthly: number }>(sql`SELECT web_price_monthly_cents AS monthly FROM plans WHERE key = 'basico'`);
    expect(rows.rows[0]?.monthly).toBe(2990);
  });
});

describe('painel: assinaturas por provedor', () => {
  it('lista, filtra e conta Google Play e Asaas na mesma tela', async () => {
    const appOwner = await registerUser(context, { installId: 'aparelho-do-google-1' });
    const appWs = await createWorkspace(appOwner, 'Loja do App');
    await subscribeOnPlay(appOwner, appWs);

    const webOwner = await registerWebUser('navegador-da-web-1');
    const webWs = await createWorkspace(webOwner, 'Loja da Web');
    await subscribeOnWeb(webOwner, webWs);

    const { cookie } = await loginAs('viewer');

    const all = await get(cookie, '/billing/subscriptions');
    expect(all.json().total).toBe(2);

    const web = await get(cookie, '/billing/subscriptions?provider=asaas');
    expect(web.json().total).toBe(1);
    expect(web.json().items[0]).toMatchObject({ provider: 'asaas', workspaceName: 'Loja da Web', state: 'ativa', billingCycle: 'MONTHLY', billingType: 'PIX', priceCents: 2990, productId: null });

    const play = await get(cookie, '/billing/subscriptions?provider=google_play');
    expect(play.json().total).toBe(1);
    expect(play.json().items[0]).toMatchObject({ provider: 'google_play', workspaceName: 'Loja do App', productId: 'assinatura', priceCents: null });

    expect((await get(cookie, '/billing/subscriptions?provider=stripe')).statusCode).toBe(400);

    const stats = await get(cookie, '/billing/stats');
    expect(stats.json()).toMatchObject({ playConfigured: true, asaasConfigured: true, asaasEnvironment: 'sandbox' });
    expect(stats.json().byProvider).toEqual([
      { provider: 'google_play', total: 1, entitled: 1, problem: 0, eventsPending: 0, mrrCents: null },
      { provider: 'asaas', total: 1, entitled: 1, problem: 0, eventsPending: 0, mrrCents: 2990 },
    ]);

    const plans = await get(cookie, '/billing/plans');
    expect(plans.json().items.find((plan: { key: string }) => plan.key === 'basico')).toMatchObject({
      activeSubscriptions: 2,
      activeSubscriptionsByProvider: { google_play: 1, asaas: 1 },
    });

    // Empresa e visão geral mostram de onde a assinatura vem.
    const workspace = await get(cookie, `/workspaces/${webWs}`);
    expect(workspace.json().subscriptions[0]).toMatchObject({ provider: 'asaas', billingCycle: 'MONTHLY', priceCents: 2990 });
    const workspaces = await get(cookie, '/workspaces?subscription=entitled');
    expect(workspaces.json().items.map((item: { subscriptionProvider: string }) => item.subscriptionProvider).sort()).toEqual(['asaas', 'google_play']);

    const overview = await get(cookie, '/overview');
    expect(overview.json().kpis).toMatchObject({ subscriptionsEntitledGooglePlay: 1, subscriptionsEntitledAsaas: 1 });
    expect(overview.json().recentSubscriptionChanges.map((change: { provider: string }) => change.provider)).toContain('asaas');

    const user = await get(cookie, `/users/${webOwner.userId}`);
    expect(user.json().purchasedSubscriptions[0]).toMatchObject({ provider: 'asaas' });
    expect(user.json().workspaces[0]).toMatchObject({ subscriptionProvider: 'asaas' });
  });

  it('detalhe do Asaas traz pagador, cobranças e eventos sem documento inteiro nem dados de cartão', async () => {
    const owner = await registerWebUser('navegador-da-web-2');
    const ws = await createWorkspace(owner, 'Loja Assinante');
    const subscriptionId = await subscribeOnWeb(owner, ws);

    // Em assinatura no cartão o Asaas devolve o token do cartão junto. Ele
    // não pode ficar guardado em `raw` nem ser repassado pelo painel.
    const remote = [...context.asaas.subscriptions.values()][0]!;
    Object.assign(remote, { creditCard: { creditCardNumber: '8829', creditCardBrand: 'VISA', creditCardToken: 'token-do-cartao-secreto' } });
    const { cookie } = await loginAs('support');
    expect((await mutate(cookie, 'POST', `/billing/subscriptions/${subscriptionId}/refresh`)).statusCode).toBe(200);
    const stored = await context.services.db.execute<{ raw: string }>(sql`SELECT raw::text AS raw FROM subscriptions WHERE id = ${subscriptionId}`);
    expect(stored.rows[0]?.raw).toContain(remote.id);
    expect(stored.rows[0]?.raw).not.toContain('token-do-cartao-secreto');
    expect(stored.rows[0]?.raw).not.toContain('creditCard');

    const detail = await get(cookie, `/billing/subscriptions/${subscriptionId}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body).toMatchObject({ provider: 'asaas', state: 'ativa', refreshable: true, productId: null });
    expect(body.asaas).toMatchObject({
      providerSubscriptionId: remote.id,
      billingCycle: 'MONTHLY',
      billingType: 'PIX',
      priceCents: 2990,
      environment: 'sandbox',
      customer: { name: 'Maria da Silva', email: 'maria@exemplo.com.br', documentType: 'CPF', documentHint: 'final 25' },
    });
    expect(body.asaas.payments).toHaveLength(1);
    expect(body.asaas.payments[0]).toMatchObject({ status: 'RECEIVED', valueCents: 2990, billingType: 'PIX', deleted: false });
    expect(body.asaas.payments[0].invoiceUrl).toMatch(/^https:\/\//);
    expect(body.asaas.payments[0].paidAt).not.toBeNull();
    expect(body.events[0]).toMatchObject({ provider: 'asaas', eventType: 'PAYMENT_RECEIVED', retryable: false });
    expect(body.events[0].processedAt).not.toBeNull();
    expect(body.raw.subscription).toMatchObject({ id: remote.id, status: 'ACTIVE', cycle: 'MONTHLY' });

    const text = JSON.stringify(body);
    expect(text).not.toContain(CPF_DIGITS);
    expect(text).not.toContain(CPF);
    expect(text).not.toContain('token-do-cartao-secreto');
    expect(text).not.toContain('creditCard');
    expect(text).not.toContain(WEBHOOK_TOKEN);
  });

  it('detalhe do Google não tem bloco do Asaas nem expõe o comprovante', async () => {
    const owner = await registerUser(context, { installId: 'aparelho-do-google-2' });
    const ws = await createWorkspace(owner, 'Loja do App');
    await subscribeOnPlay(owner, ws);
    const { cookie } = await loginAs('viewer');

    const list = await get(cookie, '/billing/subscriptions');
    const detail = await get(cookie, `/billing/subscriptions/${list.json().items[0].id}`);
    expect(detail.json()).toMatchObject({ provider: 'google_play', asaas: null, productId: 'assinatura', refreshable: true });
    expect(JSON.stringify(detail.json())).not.toContain(PURCHASE_TOKEN);
    expect(JSON.stringify(list.json())).not.toContain(PURCHASE_TOKEN);
  });

  it('reconsulta despacha para o provedor da assinatura e recusa assinatura encerrada', async () => {
    const owner = await registerWebUser('navegador-da-web-3');
    const ws = await createWorkspace(owner, 'Loja em Atraso');
    const subscriptionId = await subscribeOnWeb(owner, ws);
    const { cookie } = await loginAs('support');

    // O estorno acontece no Asaas e o webhook se perde: só a reconsulta vê.
    const payment = [...context.asaas.payments.values()][0]!;
    context.asaas.setPaymentStatus(payment.id, 'REFUNDED');

    const viewer = await loginAs('viewer');
    expect((await mutate(viewer.cookie, 'POST', `/billing/subscriptions/${subscriptionId}/refresh`)).statusCode).toBe(403);

    const refreshed = await mutate(cookie, 'POST', `/billing/subscriptions/${subscriptionId}/refresh`);
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ provider: 'asaas', from: 'ativa', to: 'reembolsada' });
    expect(refreshed.json().entitlement).toMatchObject({ active: false });

    const audit = await get(cookie, '/audit/admins?action=subscription.refreshed');
    expect(audit.json().items[0]).toMatchObject({ targetId: subscriptionId, metadata: { provider: 'asaas', from: 'ativa', to: 'reembolsada' } });

    // Encerrada: não há assinatura viva para revalidar.
    const again = await mutate(cookie, 'POST', `/billing/subscriptions/${subscriptionId}/refresh`);
    expect(again.statusCode).toBe(409);
    const detail = await get(cookie, `/billing/subscriptions/${subscriptionId}`);
    expect(detail.json()).toMatchObject({ state: 'reembolsada', refreshable: false });

    // Google continua pelo mesmo botão.
    const appOwner = await registerUser(context, { installId: 'aparelho-do-google-3' });
    const appWs = await createWorkspace(appOwner, 'Loja do App');
    await subscribeOnPlay(appOwner, appWs);
    const play = await get(cookie, '/billing/subscriptions?provider=google_play');
    context.play.setSubscription(PURCHASE_TOKEN, { ...activePurchase(), subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' });
    const playRefresh = await mutate(cookie, 'POST', `/billing/subscriptions/${play.json().items[0].id}/refresh`);
    expect(playRefresh.json()).toMatchObject({ provider: 'google_play', from: 'ativa', to: 'carencia' });
  });

  it('eventos: filtra por provedor e reprocessa webhook pendente do Asaas', async () => {
    const owner = await registerWebUser('navegador-da-web-4');
    const ws = await createWorkspace(owner, 'Loja do Webhook');

    // O webhook chega antes de a assinatura existir aqui: fica pendente.
    const early = await asaasWebhook('SUBSCRIPTION_CREATED', { subscription: { id: 'sub_000002', customer: 'cus_000001', status: 'ACTIVE' } });
    expect(early.statusCode).toBe(200);

    const { cookie } = await loginAs('support');
    const pending = await get(cookie, '/billing/events?onlyPending=true&provider=asaas');
    expect(pending.json().total).toBe(1);
    const event = pending.json().items[0];
    expect(event).toMatchObject({ provider: 'asaas', eventType: 'SUBSCRIPTION_CREATED', retryable: true, attempts: 1, workspaceName: null });
    expect((await get(cookie, '/billing/events?onlyPending=true&provider=google_play')).json().total).toBe(0);
    expect((await get(cookie, '/billing/stats')).json().byProvider[1]).toMatchObject({ provider: 'asaas', eventsPending: 1 });

    // Ainda sem assinatura: o reprocessamento diz que falhou, não finge.
    const failed = await mutate(cookie, 'POST', `/billing/events/${event.id}/retry`);
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toEqual({ outcome: 'failed', error: 'assinatura ainda não registrada' });

    expect((await checkout(owner, ws)).statusCode).toBe(200);
    const viewer = await loginAs('viewer');
    expect((await mutate(viewer.cookie, 'POST', `/billing/events/${event.id}/retry`)).statusCode).toBe(403);

    const listed = await get(cookie, '/billing/events?onlyPending=true&provider=asaas');
    expect(listed.json().items[0]).toMatchObject({ workspaceName: 'Loja do Webhook', retryable: true });

    const retried = await mutate(cookie, 'POST', `/billing/events/${event.id}/retry`);
    expect(retried.json()).toEqual({ outcome: 'processed', error: null });
    expect((await get(cookie, '/billing/events?onlyPending=true')).json().total).toBe(0);
    expect((await mutate(cookie, 'POST', `/billing/events/${event.id}/retry`)).statusCode).toBe(409);

    const audit = await get(cookie, '/audit/admins?action=subscription.event_retried');
    expect(audit.json().items.map((item: { metadata: { provider: string; outcome: string } }) => `${item.metadata.provider}:${item.metadata.outcome}`)).toEqual(['asaas:processed', 'asaas:failed']);
  });
});

describe('painel: usuários por plataforma', () => {
  it('mostra as plataformas da conta, filtra a lista e marca aparelho e sessão', async () => {
    const android = await registerUser(context, { installId: 'aparelho-android-0001' });
    const web = await registerWebUser('navegador-chrome-0001');
    const both = await registerUser(context, { installId: 'aparelho-android-0002' });
    const bothWeb = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: both.email, password: both.password, device: { installId: 'navegador-chrome-0002', platform: 'web' } },
    });
    expect(bothWeb.statusCode).toBe(200);
    const semAparelho = await registerUser(context);

    const { cookie } = await loginAs('viewer');
    const all = await get(cookie, '/users?sort=createdAt&order=asc');
    expect(all.json().total).toBe(4);
    const platformsOf = (id: string) => all.json().items.find((item: { id: string }) => item.id === id).platforms;
    expect(platformsOf(android.userId)).toEqual(['android']);
    expect(platformsOf(web.userId)).toEqual(['web']);
    expect(platformsOf(both.userId)).toEqual(['android', 'web']);
    expect(platformsOf(semAparelho.userId)).toEqual([]);

    const onWeb = await get(cookie, '/users?platform=web');
    expect(onWeb.json().items.map((item: { id: string }) => item.id).sort()).toEqual([web.userId, both.userId].sort());
    const onAndroid = await get(cookie, '/users?platform=android');
    expect(onAndroid.json().total).toBe(2);
    expect((await get(cookie, '/users?platform=windows')).statusCode).toBe(400);

    const detail = await get(cookie, `/users/${both.userId}`);
    expect(detail.json().platforms).toEqual(['android', 'web']);
    expect(detail.json().devices.map((device: { platform: string }) => device.platform).sort()).toEqual(['android', 'web']);
    expect(detail.json().sessions.map((session: { platform: string | null }) => session.platform).sort()).toEqual(['android', 'web']);

    const noDevice = await get(cookie, `/users/${semAparelho.userId}`);
    expect(noDevice.json().sessions[0]).toMatchObject({ platform: null });
  });

  it('lista a caixa de notificações da conta', async () => {
    const owner = await registerWebUser('navegador-da-web-5');
    const ws = await createWorkspace(owner, 'Loja Avisada');
    await subscribeOnWeb(owner, ws);
    const { cookie } = await loginAs('viewer');

    const inbox = await get(cookie, `/users/${owner.userId}/notifications`);
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json()).toMatchObject({ total: 1, unread: 1 });
    expect(inbox.json().items[0]).toMatchObject({ type: 'billing.payment_confirmed', workspaceName: 'Loja Avisada', readAt: null });
  });
});

describe('painel: analytics por plataforma', () => {
  it('recorta resumo, métricas, eventos e funil por plataforma e mostra o quadro por plataforma', async () => {
    const android = await registerUser(context, { installId: 'instalacao-android-9001' });
    const web = await registerWebUser('navegador-web-9001');
    await createWorkspace(web, 'Loja Web');
    expect((await sendEvents(android, 'instalacao-android-9001', 'android', ['app.opened', 'screen.viewed', 'product.created'])).statusCode).toBe(202);
    expect((await sendEvents(web, 'navegador-web-9001', 'web', ['app.opened', 'screen.viewed'])).statusCode).toBe(202);

    const { cookie } = await loginAs('viewer');

    const all = await get(cookie, '/analytics/summary?days=7');
    expect(all.json().platform).toBeNull();
    expect(all.json().active.mau).toBe(2);
    const byPlatform = Object.fromEntries(all.json().byPlatform.map((row: { platform: string; events: number; users: number }) => [row.platform, row]));
    // Do cliente + `user.registered` da API, que registra de onde veio.
    expect(byPlatform['android']).toMatchObject({ events: 4, users: 1 });
    expect(byPlatform['web']).toMatchObject({ events: 3, users: 1 });
    // `workspace.created` não diz a plataforma: fica sem recorte.
    expect(byPlatform['server']).toMatchObject({ events: 1 });
    expect(all.json().platforms).toEqual(expect.arrayContaining([
      { platform: 'android', count: 1, active30d: 1, users30d: 1 },
      { platform: 'web', count: 1, active30d: 1, users30d: 1 },
    ]));

    const onWeb = await get(cookie, '/analytics/summary?days=7&platform=web');
    expect(onWeb.json().platform).toBe('web');
    expect(onWeb.json().active).toMatchObject({ dau: 1, mau: 1 });
    expect(onWeb.json().topEvents.map((event: { name: string }) => event.name).sort()).toEqual(['app.opened', 'screen.viewed', 'user.registered']);
    expect(onWeb.json().topScreens).toEqual([{ screen: 'web-inicio', views: 1, users: 1 }]);
    expect(onWeb.json().series.events.reduce((sum: number, point: { v: number }) => sum + point.v, 0)).toBe(3);
    expect((await get(cookie, '/analytics/summary?platform=desktop')).statusCode).toBe(400);

    const metrics = await get(cookie, '/analytics/metrics?days=7&platform=android');
    const metric = (key: string) => metrics.json().items.find((item: { key: string }) => item.key === key);
    expect(metric('events')).toMatchObject({ value: 4, platformApplied: true });
    expect(metric('active_users')).toMatchObject({ value: 1, platformApplied: true });
    expect(metric('new_users')).toMatchObject({ value: 1, platformApplied: true });
    // Empresa não tem plataforma: o número continua o total, e a API avisa.
    expect(metric('workspaces_created')).toMatchObject({ value: 1, platformApplied: false, platformNote: null });
    const unfiltered = await get(cookie, '/analytics/metrics?days=7');
    expect(unfiltered.json().items.find((item: { key: string }) => item.key === 'events')).toMatchObject({ value: 8, platformApplied: false });

    const series = await get(cookie, '/analytics/events/app.opened/series?days=7&platform=web&metric=events');
    expect(series.json().points.reduce((sum: number, point: { v: number }) => sum + point.v, 0)).toBe(1);

    const explorer = await get(cookie, '/analytics/events?platform=web');
    expect(explorer.json().total).toBe(3);
    expect(explorer.json().items.every((item: { attributedPlatform: string }) => item.attributedPlatform === 'web')).toBe(true);
    expect((await get(cookie, '/analytics/events?platform=server')).json().total).toBe(1);

    const funnel = await get(cookie, '/analytics/funnel?days=7&platform=web');
    const step = (key: string) => funnel.json().steps.find((item: { key: string }) => item.key === key).count;
    expect(funnel.json().platform).toBe('web');
    expect([step('opened'), step('registered'), step('workspace'), step('subscribed')]).toEqual([1, 1, 1, 0]);
    const funnelAndroid = await get(cookie, '/analytics/funnel?days=7&platform=android');
    expect(funnelAndroid.json().steps.find((item: { key: string }) => item.key === 'workspace').count).toBe(0);
    const funnelAll = await get(cookie, '/analytics/funnel?days=7');
    expect(funnelAll.json().steps.find((item: { key: string }) => item.key === 'registered').count).toBe(2);

    const overview = await get(cookie, '/overview');
    expect(overview.json().kpis).toMatchObject({ mau: 2, mauAndroid: 1, mauWeb: 1 });
  });

  it('assinatura da web só conta como "assinou" depois de paga, e as métricas seguem o provedor', async () => {
    const owner = await registerWebUser('navegador-web-9002');
    const ws = await createWorkspace(owner, 'Loja Pendente');
    expect((await checkout(owner, ws)).statusCode).toBe(200);
    const { cookie } = await loginAs('viewer');

    const subscribed = async (query = '') => {
      const funnel = await get(cookie, `/analytics/funnel?days=7${query}`);
      return funnel.json().steps.find((item: { key: string }) => item.key === 'subscribed').count;
    };
    expect(await subscribed()).toBe(0);

    const payment = [...context.asaas.payments.values()][0]!;
    context.asaas.setPaymentStatus(payment.id, 'RECEIVED');
    await asaasWebhook('PAYMENT_RECEIVED', { payment });
    expect(await subscribed()).toBe(1);
    expect(await subscribed('&platform=web')).toBe(1);
    expect(await subscribed('&platform=android')).toBe(0);

    const started = async (platform: string) => {
      const metrics = await get(cookie, `/analytics/metrics?days=7&platform=${platform}`);
      return metrics.json().items.find((item: { key: string }) => item.key === 'subscriptions_started');
    };
    expect(await started('web')).toMatchObject({ value: 1, platformApplied: true });
    expect(await started('android')).toMatchObject({ value: 0, platformApplied: true });
  });
});

describe('painel: suporte e campanhas alcançando a web', () => {
  it('solicitação aberta pela web aparece com a plataforma e entra no filtro', async () => {
    const web = await registerWebUser('navegador-suporte-0001');
    const opened = await context.app.inject({
      method: 'POST',
      url: '/v1/support/tickets',
      headers: web.authHeader,
      payload: { installId: 'navegador-suporte-0001', subject: 'Não acho a importação', message: 'Onde importo a planilha?', device: { platform: 'web', model: 'Chrome 140', osVersion: 'macOS' } },
    });
    expect(opened.statusCode).toBe(201);
    const app = await context.app.inject({
      method: 'POST',
      url: '/v1/support/tickets',
      payload: { installId: 'aparelho-suporte-0001', subject: 'PDF não abre', message: 'O app fecha.', device: { model: 'Galaxy A54', osVersion: '14' } },
    });
    expect(app.statusCode).toBe(201);

    const { cookie } = await loginAs('viewer');
    const all = await get(cookie, '/support/tickets');
    expect(all.json().items.map((item: { platform: string }) => item.platform).sort()).toEqual(['android', 'web']);
    const onWeb = await get(cookie, '/support/tickets?platform=web');
    expect(onWeb.json().total).toBe(1);
    expect(onWeb.json().items[0]).toMatchObject({ platform: 'web', subject: 'Não acho a importação' });
    expect((await get(cookie, '/support/tickets?platform=android')).json().total).toBe(1);
  });

  it('campanha estima e registra quem recebe pela caixa de notificações (web sem push)', async () => {
    const app = await registerUser(context, { installId: 'instalacao-campanha-01' });
    const web = await registerWebUser('navegador-campanha-01');
    await context.app.inject({
      method: 'PUT',
      url: '/v1/push/tokens',
      headers: app.authHeader,
      payload: { token: 'token-campanha-app-xxxxxxxxxxxx', installId: 'instalacao-campanha-01', platform: 'android', notificationsEnabled: true },
    });
    const { cookie } = await loginAs('support');

    const preview = await mutate(cookie, 'POST', '/push/audience/preview', { audience: { type: 'signed_in' } });
    // Um aparelho com push; duas contas pela caixa (a da web só por ela).
    expect(preview.json()).toMatchObject({ total: 1, users: 1, inboxUsers: 2 });
    const anonymous = await mutate(cookie, 'POST', '/push/audience/preview', { audience: { type: 'anonymous' } });
    expect(anonymous.json()).toMatchObject({ total: 0, inboxUsers: 0 });

    const created = await mutate(cookie, 'POST', '/push/campaigns', { title: 'Novidade na web', body: 'Agora dá para usar pelo navegador.', audience: { type: 'signed_in' } });
    expect(created.statusCode).toBe(201);
    const campaignId = created.json().id as string;
    expect((await mutate(cookie, 'POST', `/push/campaigns/${campaignId}/send`)).statusCode).toBe(200);
    const { PushService } = await import('../../src/modules/push/push.service.js');
    await new PushService(context.services).deliver(campaignId);

    const detail = await get(cookie, `/push/campaigns/${campaignId}`);
    expect(detail.json()).toMatchObject({ status: 'sent', targeted: 1, accepted: 1, inboxCount: 2 });
    expect((await get(cookie, '/push/stats')).json()).toMatchObject({ campaignsSent: 1, inbox: 2 });

    const inbox = await get(cookie, `/users/${web.userId}/notifications`);
    expect(inbox.json().items[0]).toMatchObject({ type: 'campaign', title: 'Novidade na web' });
  });

  it('operação informa se o Asaas está configurado', async () => {
    const { cookie } = await loginAs('viewer');
    const ops = await get(cookie, '/ops/status');
    expect(ops.json().environment).toMatchObject({ playConfigured: true, asaasConfigured: true, asaasEnvironment: 'sandbox' });
  });
});
