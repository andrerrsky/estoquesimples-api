import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { products, stockMovements, workspaces } from '../../src/platform/db/schema/index.js';
import type { SubscriptionPurchaseV2 } from '../../src/modules/billing/play-client.js';
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
});

const PROTOCOL_HEADER = { 'x-sync-protocol': '1' };

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

/** Empresa com assinatura ativa: pré-condição de qualquer sincronização. */
async function setupWorkspace(user: RegisteredUser): Promise<string> {
  const created = await context.app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: user.authHeader,
    payload: { name: `Loja ${randomUUID().slice(0, 8)}` },
  });
  const workspaceId = created.json().id;

  const token = `token-${randomUUID()}`;
  context.play.setSubscription(token, activePurchase());

  const linked = await context.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/billing/subscriptions`,
    headers: user.authHeader,
    payload: { purchaseToken: token },
  });
  if (linked.statusCode !== 200) {
    throw new Error(`Falha ao ativar a assinatura de teste: ${linked.statusCode} ${linked.body}`);
  }

  return workspaceId;
}

function produto(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    name: `Produto ${randomUUID().slice(0, 8)}`,
    quantity: 10,
    unitValue: 5.5,
    minStock: 2,
    unit: 'un',
    rev: 0,
    ...overrides,
  };
}

function movimentacao(productId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    productId,
    productName: 'Produto',
    changeType: 'entrada',
    quantity: 10,
    occurredAt: Date.now(),
    ...overrides,
  };
}

async function startUpload(
  user: RegisteredUser,
  workspaceId: string,
  declaredProducts: number,
  declaredMovements: number,
) {
  return context.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/sync/initial-upload`,
    headers: { ...user.authHeader, ...PROTOCOL_HEADER },
    payload: { declaredProducts, declaredMovements, batchSize: 200 },
  });
}

async function sendBatch(
  user: RegisteredUser,
  workspaceId: string,
  uploadId: string,
  payload: Record<string, unknown>,
) {
  return context.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/sync/initial-upload/${uploadId}/batch`,
    headers: { ...user.authHeader, ...PROTOCOL_HEADER },
    payload,
  });
}

describe('carga inicial', () => {
  it('envia produtos e movimentações e devolve o cursor', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const p1 = produto();
    const p2 = produto();

    const start = await startUpload(user, workspaceId, 2, 1);
    expect(start.statusCode).toBe(201);
    const { uploadId, nextBatchIndex } = start.json();
    expect(nextBatchIndex).toBe(0);

    const batch = await sendBatch(user, workspaceId, uploadId, {
      batchIndex: 0,
      products: [p1, p2],
      movements: [movimentacao(p1.id)],
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json()).toMatchObject({
      duplicate: false,
      receivedProducts: 2,
      receivedMovements: 1,
    });

    const complete = await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/sync/initial-upload/${uploadId}/complete`,
      headers: { ...user.authHeader, ...PROTOCOL_HEADER },
      payload: { declaredProducts: 2, declaredMovements: 1 },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({ missingProducts: 0, missingMovements: 0 });
    // O cursor é a posição da empresa na própria sequência, não um contador global.
    expect(Number(complete.json().cursor)).toBeGreaterThan(0);

    const gravados = await context.services.db
      .select()
      .from(products)
      .where(eq(products.workspaceId, workspaceId));
    expect(gravados).toHaveLength(2);
  });

  it('reenviar o mesmo lote não duplica nem soma duas vezes', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const p1 = produto();
    const start = await startUpload(user, workspaceId, 1, 0);
    const { uploadId } = start.json();

    const payload = { batchIndex: 0, products: [p1], movements: [] };

    const primeira = await sendBatch(user, workspaceId, uploadId, payload);
    expect(primeira.json()).toMatchObject({ duplicate: false, receivedProducts: 1 });

    // Este é o caso que motiva todo o desenho: a resposta se perdeu e o
    // aparelho reenvia porque, para ele, nada aconteceu.
    const segunda = await sendBatch(user, workspaceId, uploadId, payload);
    expect(segunda.json()).toMatchObject({ duplicate: true, receivedProducts: 1 });

    const gravados = await context.services.db
      .select()
      .from(products)
      .where(eq(products.workspaceId, workspaceId));
    expect(gravados).toHaveLength(1);
  });

  it('retoma uma sessão interrompida no lote seguinte', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const start = await startUpload(user, workspaceId, 2, 0);
    const { uploadId } = start.json();

    await sendBatch(user, workspaceId, uploadId, {
      batchIndex: 0,
      products: [produto()],
      movements: [],
    });

    // O app foi encerrado e pede a sessão de novo ao voltar.
    const retomada = await startUpload(user, workspaceId, 2, 0);
    expect(retomada.json()).toMatchObject({
      uploadId,
      nextBatchIndex: 1,
      receivedProducts: 1,
    });
  });

  it('preserva movimentação sem produto correspondente', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const start = await startUpload(user, workspaceId, 0, 1);
    const { uploadId } = start.json();

    // Histórico legado: o produto foi renomeado ou apagado antes de existirem
    // identificadores. O registro é verdadeiro e não pode ser descartado.
    const orfa = movimentacao(randomUUID(), { productName: 'Produto que sumiu' });
    const batch = await sendBatch(user, workspaceId, uploadId, {
      batchIndex: 0,
      products: [],
      movements: [orfa],
    });
    expect(batch.json().receivedMovements).toBe(1);

    const [gravada] = await context.services.db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.id, orfa.id));
    expect(gravada?.productId).toBeNull();
    expect(gravada?.productName).toBe('Produto que sumiu');
  });

  it('recusa uma segunda carga inicial na mesma empresa', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const start = await startUpload(user, workspaceId, 0, 0);
    const { uploadId } = start.json();

    await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/sync/initial-upload/${uploadId}/complete`,
      headers: { ...user.authHeader, ...PROTOCOL_HEADER },
      payload: { declaredProducts: 0, declaredMovements: 0 },
    });

    // Um aparelho novo não pode sobrescrever a nuvem com a própria cópia.
    const segunda = await startUpload(user, workspaceId, 5, 5);
    expect(segunda.statusCode).toBe(409);
    expect(segunda.json().error.code).toBe('SYNC_ALREADY_SEEDED');
  });

  it('isola nome repetido no lote e recusa selar com registros faltando', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const start = await startUpload(user, workspaceId, 2, 0);
    const { uploadId } = start.json();

    // Bancos antigos têm nomes repetidos com frequência. O índice único
    // recusa o segundo, mas isso não pode travar a carga inteira: o lote
    // segue e o produto conflitante conta como não gravado.
    const primeiro = await sendBatch(user, workspaceId, uploadId, {
      batchIndex: 0,
      products: [
        produto({ name: 'Café' }),
        produto({ name: 'café' }),
      ],
      movements: [],
    });
    expect(primeiro.statusCode).toBe(200);
    expect(primeiro.json().receivedProducts).toBe(1);

    // Selar com registros faltando tornaria a perda irrecuperável.
    const complete = await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/sync/initial-upload/${uploadId}/complete`,
      headers: { ...user.authHeader, ...PROTOCOL_HEADER },
      payload: { declaredProducts: 2, declaredMovements: 0 },
    });
    expect(complete.statusCode).toBe(409);
    expect(complete.json().error.code).toBe('SYNC_UPLOAD_COUNT_MISMATCH');
  });

  it('recusa aparelho com protocolo mais antigo que o suportado', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/sync/initial-upload`,
      headers: { ...user.authHeader, 'x-sync-protocol': '0' },
      payload: { declaredProducts: 0, declaredMovements: 0, batchSize: 200 },
    });

    expect(response.statusCode).toBe(426);
    expect(response.json().error.code).toBe('SYNC_PROTOCOL_UNSUPPORTED');
  });

  it('recusa sincronização sem assinatura ativa', async () => {
    const user = await registerUser(context);
    const created = await context.app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: user.authHeader,
      payload: { name: 'Sem assinatura' },
    });
    const workspaceId = created.json().id;

    const response = await startUpload(user, workspaceId, 1, 0);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('não vaza a carga de uma empresa para outra', async () => {
    const dono = await registerUser(context);
    const workspaceId = await setupWorkspace(dono);

    const start = await startUpload(dono, workspaceId, 1, 0);
    const { uploadId } = start.json();

    const estranho = await registerUser(context);
    const response = await sendBatch(estranho, workspaceId, uploadId, {
      batchIndex: 0,
      products: [produto()],
      movements: [],
    });

    // 403 ou 404: confirmar que a empresa existe já seria vazar informação.
    expect([403, 404]).toContain(response.statusCode);
  });

  it('marca a empresa como semeada apenas ao concluir', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const start = await startUpload(user, workspaceId, 0, 0);
    const { uploadId } = start.json();

    const [antes] = await context.services.db
      .select({ seededAt: workspaces.seededAt })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(antes?.seededAt).toBeNull();

    await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/sync/initial-upload/${uploadId}/complete`,
      headers: { ...user.authHeader, ...PROTOCOL_HEADER },
      payload: { declaredProducts: 0, declaredMovements: 0 },
    });

    const [depois] = await context.services.db
      .select({ seededAt: workspaces.seededAt })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(depois?.seededAt).not.toBeNull();
  });
});
