import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { subscriptionEvents, subscriptions } from '../../src/platform/db/schema/index.js';
import type { SubscriptionPurchaseV2 } from '../../src/modules/billing/play-client.js';
import { RtdnType } from '../../src/modules/billing/billing.service.js';
import {
  createTestApp,
  registerUser,
  resetDatabase,
  type RegisteredUser,
  type TestContext,
} from '../helpers/test-app.js';

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

/** Resposta típica da Play Developer API para uma assinatura em dia. */
function activePurchase(overrides: Partial<SubscriptionPurchaseV2> = {}): SubscriptionPurchaseV2 {
  const expiry = new Date(Date.now() + 30 * 86_400_000).toISOString();
  return {
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    startTime: new Date(Date.now() - 86_400_000).toISOString(),
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    lineItems: [
      {
        productId: 'assinatura',
        expiryTime: expiry,
        autoRenewingPlan: { autoRenewEnabled: true },
        offerDetails: { basePlanId: 'plano-basico', offerId: 'oferta' },
      },
    ],
    ...overrides,
  };
}

async function createWorkspace(user: RegisteredUser, name = 'Minha Loja'): Promise<string> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: user.authHeader,
    payload: { name },
  });
  return response.json().id;
}

async function linkPurchase(user: RegisteredUser, workspaceId: string, token: string) {
  return context.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/billing/subscriptions`,
    headers: user.authHeader,
    payload: { purchaseToken: token },
  });
}

/** Monta o envelope que o Pub/Sub entrega no webhook. */
function pubsubMessage(
  messageId: string,
  notification: { notificationType: number; purchaseToken: string },
) {
  const payload = {
    version: '1.0',
    packageName: 'br.com.gameloop.estoquesimples',
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: '1.0',
      notificationType: notification.notificationType,
      purchaseToken: notification.purchaseToken,
      subscriptionId: 'assinatura',
    },
  };
  return {
    message: { messageId, data: Buffer.from(JSON.stringify(payload)).toString('base64') },
    subscription: 'projects/x/subscriptions/y',
  };
}

describe('vinculação de compra', () => {
  it('valida no Google e concede o direito de sincronizar', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    context.play.setSubscription('token-valido-1', activePurchase());

    const response = await linkPurchase(owner, workspaceId, 'token-valido-1');

    expect(response.statusCode).toBe(200);
    const entitlement = response.json();
    expect(entitlement.active).toBe(true);
    expect(entitlement.planKey).toBe('basico');
    expect(entitlement.state).toBe('ativa');
    expect(entitlement.features['sync.nuvem'].enabled).toBe(true);
  });

  it('confirma a compra no Google para não ser reembolsada automaticamente', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    context.play.setSubscription('token-nao-confirmado', activePurchase());

    await linkPurchase(owner, workspaceId, 'token-nao-confirmado');

    expect(context.play.acknowledged).toContain('token-nao-confirmado');
  });

  it('recusa comprovante que o Google não reconhece', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);

    const response = await linkPurchase(owner, workspaceId, 'token-inexistente');

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('PURCHASE_TOKEN_INVALID');
  });

  it('recusa um comprovante já vinculado a outra empresa', async () => {
    const alice = await registerUser(context);
    const bob = await registerUser(context);
    const aliceWorkspace = await createWorkspace(alice, 'Loja da Alice');
    const bobWorkspace = await createWorkspace(bob, 'Loja do Bob');
    context.play.setSubscription('token-compartilhado', activePurchase());

    const first = await linkPurchase(alice, aliceWorkspace, 'token-compartilhado');
    expect(first.statusCode).toBe(200);

    // Bob tenta usar o mesmo comprovante para liberar a empresa dele.
    const second = await linkPurchase(bob, bobWorkspace, 'token-compartilhado');
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('PURCHASE_TOKEN_IN_USE');

    const bobEntitlement = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${bobWorkspace}/entitlement`,
      headers: bob.authHeader,
    });
    expect(bobEntitlement.json().active).toBe(false);
  });

  it('revincular o mesmo comprovante na mesma empresa é idempotente', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    context.play.setSubscription('token-repetido', activePurchase());

    await linkPurchase(owner, workspaceId, 'token-repetido');
    const second = await linkPurchase(owner, workspaceId, 'token-repetido');
    expect(second.statusCode).toBe(200);

    const rows = await context.services.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
  });

  it('somente quem pode gerenciar assinatura consegue vincular', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    const admin = await registerUser(context);

    const { workspaceMembers } = await import('../../src/platform/db/schema/index.js');
    await context.services.db.insert(workspaceMembers).values({
      workspaceId,
      userId: admin.userId,
      roleKey: 'administrador',
      status: 'active',
    });

    context.play.setSubscription('token-admin', activePurchase());
    const response = await linkPurchase(admin, workspaceId, 'token-admin');

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('MISSING_PERMISSION');
  });

  it('trata a troca de plano seguindo o linkedPurchaseToken', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);

    context.play.setSubscription('token-antigo', activePurchase());
    await linkPurchase(owner, workspaceId, 'token-antigo');

    // Numa troca de plano o Google emite um token novo apontando para o antigo.
    context.play.setSubscription(
      'token-novo',
      activePurchase({ linkedPurchaseToken: 'token-antigo' }),
    );
    const upgrade = await linkPurchase(owner, workspaceId, 'token-novo');
    expect(upgrade.statusCode).toBe(200);

    const rows = await context.services.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId));

    const cipher = context.services.purchaseTokens;
    const byHash = new Map(rows.map((row) => [row.purchaseTokenHash, row.state]));
    expect(byHash.get(cipher.hash('token-antigo'))).toBe('substituida');
    expect(byHash.get(cipher.hash('token-novo'))).toBe('ativa');
    for (const row of rows) {
      expect(row.purchaseTokenEnc).not.toContain('token-antigo');
      expect(row.purchaseTokenEnc).not.toContain('token-novo');
      expect(row.purchaseTokenEnc.startsWith('v1:')).toBe(true);
      expect(cipher.decrypt(row.purchaseTokenEnc).startsWith('token-')).toBe(true);
    }

    // Uma única assinatura viva: nada de cobrar ou contar duas vezes.
    const vivas = rows.filter((row) =>
      ['pendente', 'ativa', 'carencia', 'suspensa', 'cancelada_mas_ativa'].includes(row.state),
    );
    expect(vivas).toHaveLength(1);
  });
});

describe('estados da assinatura', () => {
  const casos: Array<{ google: string; estado: string; temDireito: boolean }> = [
    { google: 'SUBSCRIPTION_STATE_ACTIVE', estado: 'ativa', temDireito: true },
    { google: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', estado: 'carencia', temDireito: true },
    { google: 'SUBSCRIPTION_STATE_CANCELED', estado: 'cancelada_mas_ativa', temDireito: true },
    { google: 'SUBSCRIPTION_STATE_ON_HOLD', estado: 'suspensa', temDireito: false },
    { google: 'SUBSCRIPTION_STATE_PAUSED', estado: 'suspensa', temDireito: false },
    { google: 'SUBSCRIPTION_STATE_PENDING', estado: 'pendente', temDireito: false },
  ];

  for (const caso of casos) {
    it(`${caso.google} vira "${caso.estado}" e ${caso.temDireito ? 'concede' : 'nega'} acesso`, async () => {
      const owner = await registerUser(context);
      const workspaceId = await createWorkspace(owner);
      const token = `token-${caso.estado}-${Math.random().toString(36).slice(2)}`;
      context.play.setSubscription(token, activePurchase({ subscriptionState: caso.google }));

      const response = await linkPurchase(owner, workspaceId, token);
      expect(response.statusCode).toBe(200);
      expect(response.json().state).toBe(caso.estado);
      expect(response.json().active).toBe(caso.temDireito);
    });
  }

  it('assinatura cancelada mas dentro do período pago continua valendo', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    context.play.setSubscription(
      'token-cancelado',
      activePurchase({
        subscriptionState: 'SUBSCRIPTION_STATE_CANCELED',
        canceledStateContext: {
          userInitiatedCancellation: { cancelTime: new Date().toISOString() },
        },
        lineItems: [
          {
            productId: 'assinatura',
            expiryTime: new Date(Date.now() + 10 * 86_400_000).toISOString(),
            autoRenewingPlan: { autoRenewEnabled: false },
            offerDetails: { basePlanId: 'plano-basico' },
          },
        ],
      }),
    );

    const response = await linkPurchase(owner, workspaceId, 'token-cancelado');
    expect(response.json().active).toBe(true);
    expect(response.json().autoRenewing).toBe(false);
  });

  it('período já vencido não concede acesso mesmo com estado desatualizado', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    context.play.setSubscription(
      'token-vencido',
      activePurchase({
        lineItems: [
          {
            productId: 'assinatura',
            expiryTime: new Date(Date.now() - 86_400_000).toISOString(),
            autoRenewingPlan: { autoRenewEnabled: false },
            offerDetails: { basePlanId: 'plano-basico' },
          },
        ],
      }),
    );

    const response = await linkPurchase(owner, workspaceId, 'token-vencido');
    // O Google ainda diz "ativa", mas a data de expiração já passou. A data
    // manda, para não liberar acesso enquanto a reconciliação não roda.
    expect(response.json().active).toBe(false);
  });

  it('empresa sem assinatura fica no plano gratuito e sem sincronização', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/entitlement`,
      headers: owner.authHeader,
    });

    expect(response.json().active).toBe(false);
    expect(response.json().planKey).toBe('gratuito');
    expect(response.json().state).toBe('sem_assinatura');
  });

  it('informa até quando o app pode confiar no retrato sem rede', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    context.play.setSubscription('token-offline', activePurchase());

    const response = await linkPurchase(owner, workspaceId, 'token-offline');
    const validUntil = new Date(response.json().offlineValidUntil).getTime();
    const esperado = Date.now() + context.env.ENTITLEMENT_OFFLINE_MAX_DAYS * 86_400_000;

    expect(Math.abs(validUntil - esperado)).toBeLessThan(60_000);
  });
});

describe('notificações do Google (RTDN)', () => {
  async function setupSubscription(token: string) {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    context.play.setSubscription(token, activePurchase());
    await linkPurchase(owner, workspaceId, token);
    return { owner, workspaceId };
  }

  it('revalida no Google em vez de confiar no conteúdo da notificação', async () => {
    const { owner, workspaceId } = await setupSubscription('token-rtdn');

    // A notificação diz apenas "algo mudou". O estado verdadeiro vem da
    // consulta que fazemos em seguida.
    context.play.setSubscription(
      'token-rtdn',
      activePurchase({ subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD' }),
    );

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/billing/webhooks/google?token=test-pubsub-token',
      payload: pubsubMessage('msg-1', {
        notificationType: RtdnType.RENEWED,
        purchaseToken: 'token-rtdn',
      }),
    });
    expect(response.statusCode).toBe(200);

    const entitlement = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/entitlement`,
      headers: owner.authHeader,
    });
    // A notificação era de renovação, mas o Google informa suspensão.
    expect(entitlement.json().state).toBe('suspensa');
    expect(entitlement.json().active).toBe(false);
  });

  it('processa a mesma notificação uma única vez', async () => {
    await setupSubscription('token-duplicado');
    const message = pubsubMessage('msg-repetida', {
      notificationType: RtdnType.RENEWED,
      purchaseToken: 'token-duplicado',
    });

    const first = await context.app.inject({
      method: 'POST',
      url: '/v1/billing/webhooks/google?token=test-pubsub-token',
      payload: message,
    });
    const second = await context.app.inject({
      method: 'POST',
      url: '/v1/billing/webhooks/google?token=test-pubsub-token',
      payload: message,
    });

    expect(first.json().duplicated).toBe(false);
    expect(second.json().duplicated).toBe(true);

    const events = await context.services.db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.notificationId, 'msg-repetida'));
    expect(events).toHaveLength(1);
  });

  it('notificações fora de ordem convergem para o estado real', async () => {
    const { owner, workspaceId } = await setupSubscription('token-fora-de-ordem');

    // Chega primeiro o cancelamento, depois a renovação — ordem invertida.
    // Como cada notificação dispara uma consulta, o resultado é sempre o
    // estado atual, independente da sequência de chegada.
    context.play.setSubscription(
      'token-fora-de-ordem',
      activePurchase({ subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' }),
    );

    await context.app.inject({
      method: 'POST',
      url: '/v1/billing/webhooks/google?token=test-pubsub-token',
      payload: pubsubMessage('msg-cancel', {
        notificationType: RtdnType.CANCELED,
        purchaseToken: 'token-fora-de-ordem',
      }),
    });
    await context.app.inject({
      method: 'POST',
      url: '/v1/billing/webhooks/google?token=test-pubsub-token',
      payload: pubsubMessage('msg-renew', {
        notificationType: RtdnType.RENEWED,
        purchaseToken: 'token-fora-de-ordem',
      }),
    });

    const entitlement = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/entitlement`,
      headers: owner.authHeader,
    });
    expect(entitlement.json().state).toBe('ativa');
  });

  it('revogação por reembolso tira o acesso na hora', async () => {
    const { owner, workspaceId } = await setupSubscription('token-reembolsado');

    // O Google ainda pode reportar o período como válido; a revogação vale mais.
    await context.app.inject({
      method: 'POST',
      url: '/v1/billing/webhooks/google?token=test-pubsub-token',
      payload: pubsubMessage('msg-revoked', {
        notificationType: RtdnType.REVOKED,
        purchaseToken: 'token-reembolsado',
      }),
    });

    const entitlement = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/entitlement`,
      headers: owner.authHeader,
    });
    expect(entitlement.json().state).toBe('sem_assinatura');
    expect(entitlement.json().active).toBe(false);
  });

  it('aceita a notificação de teste enviada na configuração do tópico', async () => {
    const payload = {
      message: {
        messageId: 'msg-teste',
        data: Buffer.from(
          JSON.stringify({ version: '1.0', testNotification: { version: '1.0' } }),
        ).toString('base64'),
      },
    };

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/billing/webhooks/google?token=test-pubsub-token',
      payload,
    });
    expect(response.statusCode).toBe(200);
  });

  it('guarda notificação de token ainda não vinculado sem falhar', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/billing/webhooks/google?token=test-pubsub-token',
      payload: pubsubMessage('msg-orfa', {
        notificationType: RtdnType.PURCHASED,
        purchaseToken: 'token-nunca-vinculado',
      }),
    });

    expect(response.statusCode).toBe(200);
    const events = await context.services.db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.notificationId, 'msg-orfa'));
    expect(events).toHaveLength(1);
  });

  it('recusa chamada sem o token de verificação quando ele está configurado', async () => {
    const protegido = await createTestApp({ GOOGLE_PUBSUB_VERIFICATION_TOKEN: 'segredo-do-pubsub' });
    try {
      const semToken = await protegido.app.inject({
        method: 'POST',
        url: '/v1/billing/webhooks/google',
        payload: pubsubMessage('msg-sem-token', {
          notificationType: RtdnType.RENEWED,
          purchaseToken: 'qualquer',
        }),
      });
      expect(semToken.statusCode).toBe(401);

      const comToken = await protegido.app.inject({
        method: 'POST',
        url: '/v1/billing/webhooks/google?token=segredo-do-pubsub',
        payload: pubsubMessage('msg-com-token', {
          notificationType: RtdnType.RENEWED,
          purchaseToken: 'qualquer',
        }),
      });
      expect(comToken.statusCode).toBe(200);
    } finally {
      await protegido.close();
    }
  });
});

describe('reconciliação', () => {
  it('corrige o estado quando a notificação se perdeu', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    context.play.setSubscription('token-reconciliar', activePurchase());
    await linkPurchase(owner, workspaceId, 'token-reconciliar');

    // A assinatura expirou no Google e nenhuma notificação chegou.
    context.play.setSubscription(
      'token-reconciliar',
      activePurchase({
        subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
        lineItems: [
          {
            productId: 'assinatura',
            expiryTime: new Date(Date.now() - 86_400_000).toISOString(),
            offerDetails: { basePlanId: 'plano-basico' },
          },
        ],
      }),
    );

    const { BillingService } = await import('../../src/modules/billing/billing.service.js');
    const service = new BillingService(context.services);
    const resultado = await service.reconcile({ staleMinutes: 0 });

    expect(resultado.checked).toBeGreaterThan(0);
    expect(resultado.updated).toBe(1);

    const entitlement = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/entitlement`,
      headers: owner.authHeader,
    });
    expect(entitlement.json().active).toBe(false);
  });

  it('uma falha do Google não interrompe a reconciliação das demais', async () => {
    const owner = await registerUser(context);
    const workspaceA = await createWorkspace(owner, 'Loja A');
    const workspaceB = await createWorkspace(owner, 'Loja B');
    context.play.setSubscription('token-loja-a', activePurchase());
    context.play.setSubscription('token-loja-b', activePurchase());
    await linkPurchase(owner, workspaceA, 'token-loja-a');
    await linkPurchase(owner, workspaceB, 'token-loja-b');

    context.play.failNext(new Error('Google fora do ar'));

    const { BillingService } = await import('../../src/modules/billing/billing.service.js');
    const service = new BillingService(context.services);
    const resultado = await service.reconcile({ staleMinutes: 0 });

    expect(resultado.checked).toBe(2);
    expect(resultado.failed).toBe(1);
  });
});

describe('isolamento', () => {
  it('não expõe a assinatura de outra empresa', async () => {
    const alice = await registerUser(context);
    const bob = await registerUser(context);
    const aliceWorkspace = await createWorkspace(alice);
    context.play.setSubscription('token-alice', activePurchase());
    await linkPurchase(alice, aliceWorkspace, 'token-alice');

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${aliceWorkspace}/entitlement`,
      headers: bob.authHeader,
    });

    expect(response.statusCode).toBe(404);
  });

  it('o comprovante de compra nunca aparece nas respostas', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    context.play.setSubscription('token-secreto-nao-vazar', activePurchase());
    await linkPurchase(owner, workspaceId, 'token-secreto-nao-vazar');

    const lista = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/billing/subscriptions`,
      headers: owner.authHeader,
    });
    const entitlement = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/entitlement`,
      headers: owner.authHeader,
    });

    expect(lista.body).not.toContain('token-secreto-nao-vazar');
    expect(entitlement.body).not.toContain('token-secreto-nao-vazar');

    const stored = await context.services.db.select().from(subscriptions);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0])).not.toContain('token-secreto-nao-vazar');
    expect(stored[0]?.purchaseTokenEnc.startsWith('v1:')).toBe(true);
    expect(stored[0]?.raw).not.toHaveProperty('linkedPurchaseToken');
  });
});
