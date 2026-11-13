import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
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

    // p1 vem de uma versão do app que já conhece o custo; p2, de uma antiga.
    const p1 = produto({ unitCost: 3.25 });
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
    const custos = Object.fromEntries(gravados.map((p) => [p.id, p.unitCost === null ? null : Number(p.unitCost)]));
    expect(custos).toEqual({ [p1.id]: 3.25, [p2.id]: null });
  });

  it('movimentação que chega antes do produto fica ligada a ele no fim, sem mexer no saldo declarado', async () => {
    // O aparelho pagina produtos e movimentações em lotes independentes, e o
    // histórico pode chegar primeiro. Sem o vínculo, a conferência de saldo
    // não reconheceria essas movimentações como recebidas e o aparelho as
    // reenviaria todo dia — somando um saldo que já veio declarado.
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const p1 = produto({ quantity: 40 });
    const start = await startUpload(user, workspaceId, 1, 2);
    const { uploadId } = start.json();

    const antigas = [
      movimentacao(p1.id, { quantity: 25 }),
      movimentacao(p1.id, { quantity: 15 }),
    ];
    // Lote 0: só o histórico. O produto só aparece no lote 1.
    expect((await sendBatch(user, workspaceId, uploadId, {
      batchIndex: 0, products: [], movements: antigas,
    })).statusCode).toBe(200);
    expect((await sendBatch(user, workspaceId, uploadId, {
      batchIndex: 1, products: [p1], movements: [],
    })).statusCode).toBe(200);

    const complete = await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/sync/initial-upload/${uploadId}/complete`,
      headers: { ...user.authHeader, ...PROTOCOL_HEADER },
      payload: { declaredProducts: 1, declaredMovements: 2 },
    });
    expect(complete.statusCode).toBe(200);

    // O saldo continua o que o aparelho declarou: na carga inicial o
    // histórico é incompleto por natureza e somá-lo daria outro número.
    const [gravado] = await context.services.db
      .select({ quantity: products.quantityCache })
      .from(products)
      .where(eq(products.id, p1.id));
    expect(Number(gravado?.quantity)).toBe(40);

    // E as duas estão vinculadas, logo a conferência as enxerga.
    const vinculadas = await context.services.db
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(eq(stockMovements.productId, p1.id));
    expect(vinculadas.map((m) => m.id).sort()).toEqual(antigas.map((m) => m.id).sort());

    const historico = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/sync/balances/${p1.id}/movements`,
      headers: { ...user.authHeader, ...PROTOCOL_HEADER },
    });
    expect(historico.statusCode).toBe(200);
    expect([...historico.json().items].sort()).toEqual(antigas.map((m) => m.id).sort());
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

  it('grava nome repetido com sufixo, sela e leva o nome final ao aparelho', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const start = await startUpload(user, workspaceId, 2, 0);
    const { uploadId } = start.json();

    // Bancos antigos têm nomes repetidos com frequência. O índice único
    // recusaria o segundo e a carga nunca fecharia; agora ele entra como
    // "café (2)" e nada se perde.
    const repetido = produto({ name: 'café' });
    const primeiro = await sendBatch(user, workspaceId, uploadId, {
      batchIndex: 0,
      products: [produto({ name: 'Café' }), repetido],
      movements: [],
    });
    expect(primeiro.statusCode).toBe(200);
    expect(primeiro.json().receivedProducts).toBe(2);

    const complete = await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/sync/initial-upload/${uploadId}/complete`,
      headers: { ...user.authHeader, ...PROTOCOL_HEADER },
      payload: { declaredProducts: 2, declaredMovements: 0 },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({ products: 2, missingProducts: 0 });

    // O renomeado vem depois do cursor: o aparelho recebe o nome final.
    const changes = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/sync/pull?cursor=${complete.json().cursor}`,
      headers: { ...user.authHeader, ...PROTOCOL_HEADER },
    });
    expect(changes.statusCode).toBe(200);
    const nomes = JSON.stringify(changes.json());
    expect(nomes).toContain('café (2)');
    expect(nomes).toContain(repetido.id);
  });

  it('sela mesmo com produtos criados durante o envio (eles sobem depois pela fila)', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const start = await startUpload(user, workspaceId, 1, 0);
    const { uploadId } = start.json();
    const lote = await sendBatch(user, workspaceId, uploadId, {
      batchIndex: 0,
      products: [produto({ name: 'Esmalte' })],
      movements: [],
    });
    expect(lote.statusCode).toBe(200);

    // O aparelho declara o que tem AGORA: a pessoa cadastrou mais 3 enquanto
    // o envio corria. Antes isso travava a empresa na carga inicial.
    const complete = await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/sync/initial-upload/${uploadId}/complete`,
      headers: { ...user.authHeader, ...PROTOCOL_HEADER },
      payload: { declaredProducts: 4, declaredMovements: 0 },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({ products: 1, missingProducts: 3 });
  });

  it('recusa selar com um lote faltando no meio', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const start = await startUpload(user, workspaceId, 2, 0);
    const { uploadId } = start.json();
    await sendBatch(user, workspaceId, uploadId, { batchIndex: 0, products: [produto({ name: 'A' })], movements: [] });
    await sendBatch(user, workspaceId, uploadId, { batchIndex: 2, products: [produto({ name: 'C' })], movements: [] });

    // Selar sem o lote 1 tornaria os registros dele irrecuperáveis.
    const complete = await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/sync/initial-upload/${uploadId}/complete`,
      headers: { ...user.authHeader, ...PROTOCOL_HEADER },
      payload: { declaredProducts: 3, declaredMovements: 0 },
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

  it('plano gratuito aceita a carga inicial até o teto de produtos e recusa acima dele', async () => {
    const user = await registerUser(context);
    const created = await context.app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: user.authHeader,
      payload: { name: 'Sem assinatura' },
    });
    const workspaceId = created.json().id;
    await context.services.db.execute(
      sql`UPDATE plan_features SET limit_value = 2 WHERE plan_key = 'gratuito' AND feature_key = 'produtos.sincronizados'`,
    );
    try {
      const acima = await startUpload(user, workspaceId, 3, 0);
      expect(acima.statusCode).toBe(403);
      expect(acima.json().error.code).toBe('PLAN_LIMIT_REACHED');

      const dentro = await startUpload(user, workspaceId, 2, 0);
      expect(dentro.statusCode).toBe(201);
      const uploadId = dentro.json().uploadId;

      // O declarado era 2, mas o lote traz 3: a conferência real é por lote.
      const lote = await context.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/sync/initial-upload/${uploadId}/batch`,
        headers: { ...user.authHeader, ...PROTOCOL_HEADER },
        payload: { batchIndex: 0, products: [produto(), produto(), produto()], movements: [] },
      });
      expect(lote.statusCode).toBe(403);
      expect(lote.json().error.code).toBe('PLAN_LIMIT_REACHED');
    } finally {
      await context.services.db.execute(
        sql`UPDATE plan_features SET limit_value = 50 WHERE plan_key = 'gratuito' AND feature_key = 'produtos.sincronizados'`,
      );
    }
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
