import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../../src/platform/auth/password.js';
import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { SUBSCRIPTION_ADMIN_ALERT_JOB, sendSubscriptionAlert } from '../../src/modules/billing/subscription-alerts.js';
import { googleRecurringCents, playCycleFromRaw, playOrderId } from '../../src/modules/billing/play-price.js';
import type { SubscriptionPurchaseV2 } from '../../src/modules/billing/play-client.js';
import { createTestApp, registerUser, resetDatabase, type RegisteredUser, type TestContext } from '../helpers/test-app.js';

let context: TestContext;

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
  context.mailer.clear();
});

/**
 * Comprovante igual ao que a Play devolveu na compra de 23/11/2026: oferta de
 * entrada em curso, preço cheio de R$ 24,99 no `recurringPrice` e vencimento
 * em 30 dias. Nenhum campo diz "mensal" nem "R$ 19,99".
 */
function comprovanteDaPlay(overrides: { offerPhase?: Record<string, unknown> | null; dias?: number } = {}) {
  const dias = overrides.dias ?? 30;
  return {
    kind: 'androidpublisher#subscriptionPurchaseV2',
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    startTime: new Date(Date.now() - 60_000).toISOString(),
    regionCode: 'BR',
    latestOrderId: 'GPA.3394-8955-5424-11571',
    lineItems: [
      {
        productId: 'assinatura',
        expiryTime: new Date(Date.now() + dias * 86_400_000).toISOString(),
        ...(overrides.offerPhase === null ? {} : { offerPhase: overrides.offerPhase ?? { introductoryPrice: {} } }),
        offerDetails: { basePlanId: 'plano-basico', offerId: 'oferta' },
        autoRenewingPlan: { autoRenewEnabled: true, recurringPrice: { units: '24', nanos: 990_000_000, currencyCode: 'BRL' } },
      },
    ],
  };
}

/** Vincula a compra pela rota real: é ela que grava o comprovante em `raw`. */
async function assinaturaDaPlay(owner: RegisteredUser, raw: unknown, token = `token-${Math.random().toString(36).slice(2)}`): Promise<string> {
  const workspaceId = (
    await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: owner.authHeader, payload: { name: 'Loja do App' } })
  ).json().id as string;
  context.play.setSubscription(token, raw as SubscriptionPurchaseV2);
  const vinculo = await context.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/billing/subscriptions`,
    headers: owner.authHeader,
    payload: { purchaseToken: token },
  });
  expect(vinculo.statusCode).toBe(200);
  const [linha] = (
    await context.services.db.execute<{ id: string }>(sql`SELECT id FROM subscriptions WHERE workspace_id = ${workspaceId}`)
  ).rows;
  return linha!.id;
}

describe('leitura do comprovante da Play', () => {
  it('tira o preço recorrente, a fase de oferta, o ciclo e o pedido', () => {
    const raw = comprovanteDaPlay();
    expect(googleRecurringCents(raw)).toEqual({ cents: 2499, inOffer: true });
    expect(playCycleFromRaw(raw)).toBe('MONTHLY');
    expect(playCycleFromRaw(comprovanteDaPlay({ dias: 183 }))).toBe('SEMIANNUALLY');
    expect(playCycleFromRaw(comprovanteDaPlay({ dias: 365 }))).toBe('YEARLY');
    expect(playCycleFromRaw({})).toBeNull();
    expect(playOrderId(raw)).toBe('GPA.3394-8955-5424-11571');
    expect(googleRecurringCents(comprovanteDaPlay({ offerPhase: null })).inOffer).toBe(false);
  });
});

describe('aviso de assinatura comprada no app', () => {
  beforeEach(async () => {
    await context.services.db
      .insert(platformAdmins)
      .values({ email: 'dono@exemplo.com.br', name: 'Dono', passwordHash: await hashPassword('PainelSeguro#2026'), role: 'owner' });
  });

  it('diz o plano, o ciclo, o valor da oferta e o preço cheio', async () => {
    const owner = await registerUser(context);
    const subscriptionId = await assinaturaDaPlay(owner, comprovanteDaPlay());

    expect(await sendSubscriptionAlert(context.services, { subscriptionId, kind: 'nova', from: null })).toEqual({ recipients: 1, sent: 1 });

    // O valor em reais sai do Intl com espaço não separável; o teste compara em texto simples.
    const texto = (context.mailer.lastOfKind('subscription_alert')?.text ?? '').replace(/\u00a0/g, ' ');
    expect(texto).toContain('Plano: Equipe (mensal)');
    expect(texto).toContain('Valor: R$ 19,99 por mês na oferta de entrada (2 primeiros meses), depois R$ 24,99 por mês');
    expect(texto).toContain('Por onde: app Android (Google Play)');
    expect(texto).toContain('Pedido no Google: GPA.3394-8955-5424-11571');
  });

  it('fora da oferta, mostra só o preço recorrente', async () => {
    const owner = await registerUser(context);
    const subscriptionId = await assinaturaDaPlay(owner, comprovanteDaPlay({ offerPhase: null }));

    await sendSubscriptionAlert(context.services, { subscriptionId, kind: 'nova', from: null });

    expect((context.mailer.lastOfKind('subscription_alert')?.text ?? '').replace(/\u00a0/g, ' ')).toContain('Valor: R$ 24,99 por mês');
  });

  it('sem preço no comprovante, diz que o Google não informou em vez de calar', async () => {
    const owner = await registerUser(context);
    const semPreco = comprovanteDaPlay({ offerPhase: null });
    delete (semPreco.lineItems[0] as Record<string, unknown>)['autoRenewingPlan'];
    delete (semPreco as Record<string, unknown>)['latestOrderId'];
    delete (semPreco.lineItems[0] as Record<string, unknown>)['latestSuccessfulOrderId'];
    const subscriptionId = await assinaturaDaPlay(owner, semPreco);

    await sendSubscriptionAlert(context.services, { subscriptionId, kind: 'nova', from: null });

    // O valor em reais sai do Intl com espaço não separável; o teste compara em texto simples.
    const texto = (context.mailer.lastOfKind('subscription_alert')?.text ?? '').replace(/\u00a0/g, ' ');
    expect(texto).toContain('Valor: não informado no comprovante do Google');
    expect(texto).not.toContain('Pedido no Google');
  });

  it('não repete o aviso da mesma compra', async () => {
    const owner = await registerUser(context);
    const subscriptionId = await assinaturaDaPlay(owner, comprovanteDaPlay());
    await sendSubscriptionAlert(context.services, { subscriptionId, kind: 'nova', from: null });
    expect(await sendSubscriptionAlert(context.services, { subscriptionId, kind: 'nova', from: null })).toMatchObject({ skipped: 'já avisada' });
    expect(SUBSCRIPTION_ADMIN_ALERT_JOB).toBe('billing.admin_subscription_alert');
  });
});
