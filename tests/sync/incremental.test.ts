import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  products,
  syncCursors,
  workspaceMembers,
  workspaces,
} from '../../src/platform/db/schema/index.js';
import type { SubscriptionPurchaseV2 } from '../../src/modules/billing/play-client.js';
import {
  createTestApp,
  loginUser,
  registerUser,
  resetDatabase,
  VALID_PASSWORD,
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

const PROTOCOL = { 'x-sync-protocol': '1' };

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

interface OperacaoParcial {
  opId?: string;
  entity?: 'produto' | 'movimentacao';
  op?: 'upsert' | 'delete' | 'movement';
  entityId?: string;
  baseRev?: number | null;
  payload?: Record<string, unknown>;
}

function upsertProduto(overrides: OperacaoParcial = {}) {
  const id = overrides.entityId ?? randomUUID();
  return {
    opId: overrides.opId ?? randomUUID(),
    entity: 'produto' as const,
    op: 'upsert' as const,
    entityId: id,
    ...(overrides.baseRev === undefined ? {} : { baseRev: overrides.baseRev }),
    payload: {
      id,
      name: `Produto ${randomUUID().slice(0, 8)}`,
      quantity: 0,
      unitValue: 3.5,
      minStock: 1,
      unit: 'un',
      rev: 0,
      ...overrides.payload,
    },
  };
}

function movimentacao(productId: string | null, overrides: OperacaoParcial = {}) {
  const id = overrides.entityId ?? randomUUID();
  return {
    opId: overrides.opId ?? randomUUID(),
    entity: 'movimentacao' as const,
    op: 'movement' as const,
    entityId: id,
    payload: {
      id,
      productId,
      productName: 'Produto',
      changeType: 'entrada',
      quantity: 5,
      occurredAt: Date.now(),
      ...overrides.payload,
    },
  };
}

async function push(user: RegisteredUser, workspaceId: string, operations: unknown[]) {
  return context.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/sync/push`,
    headers: { ...user.authHeader, ...PROTOCOL },
    payload: { operations },
  });
}

async function pull(user: RegisteredUser, workspaceId: string, cursor = 0, limit?: number) {
  const query = limit === undefined ? `cursor=${cursor}` : `cursor=${cursor}&limit=${limit}`;
  return context.app.inject({
    method: 'GET',
    url: `/v1/workspaces/${workspaceId}/sync/pull?${query}`,
    headers: { ...user.authHeader, ...PROTOCOL },
  });
}

describe('envio incremental', () => {
  it('aplica um produto novo e devolve a versão gravada', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const operacao = upsertProduto({ payload: { name: 'Café em grão' } });
    const response = await push(user, workspaceId, [operacao]);

    expect(response.statusCode).toBe(200);
    const [resultado] = response.json().results;
    expect(resultado).toMatchObject({ status: 'aplicada', rev: 0 });
    expect(Number(resultado.changeSeq)).toBeGreaterThan(0);

    const [gravado] = await context.services.db
      .select()
      .from(products)
      .where(eq(products.id, operacao.entityId));
    expect(gravado?.name).toBe('Café em grão');
  });

  it('reenviar a mesma operação não aplica duas vezes', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const produtoId = randomUUID();
    await push(user, workspaceId, [upsertProduto({ entityId: produtoId })]);

    // A saída de estoque é o caso que dói: aplicada duas vezes, o cliente vê
    // o dobro sendo debitado sem nenhum registro explicando.
    const saida = movimentacao(produtoId, {
      payload: { changeType: 'saida', quantity: -3 },
    });

    const primeira = await push(user, workspaceId, [saida]);
    expect(primeira.json().results[0].status).toBe('aplicada');

    const segunda = await push(user, workspaceId, [saida]);
    // Replay devolve o status original com replayed=true — nunca minta
    // "duplicada" sobre uma rejeição/conflito.
    expect(segunda.json().results[0].status).toBe('aplicada');
    expect(segunda.json().results[0].replayed).toBe(true);

    const [produto] = await context.services.db
      .select()
      .from(products)
      .where(eq(products.id, produtoId));
    expect(Number(produto?.quantityCache)).toBe(-3);
  });

  it('movimentação ajusta o saldo do produto', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const produtoId = randomUUID();
    await push(user, workspaceId, [
      upsertProduto({ entityId: produtoId, payload: { quantity: 10 } }),
    ]);

    await push(user, workspaceId, [
      movimentacao(produtoId, { payload: { changeType: 'entrada', quantity: 4 } }),
      movimentacao(produtoId, { payload: { changeType: 'saida', quantity: -6 } }),
    ]);

    const [produto] = await context.services.db
      .select()
      .from(products)
      .where(eq(products.id, produtoId));
    expect(Number(produto?.quantityCache)).toBe(8);
  });

  it('edição a partir de uma versão vencida volta como conflito', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const produtoId = randomUUID();
    await push(user, workspaceId, [
      upsertProduto({ entityId: produtoId, payload: { name: 'Chá' } }),
    ]);

    // Primeiro aparelho edita e o servidor passa para rev 1.
    const primeira = await push(user, workspaceId, [
      upsertProduto({ entityId: produtoId, baseRev: 0, payload: { name: 'Chá preto' } }),
    ]);
    expect(primeira.json().results[0]).toMatchObject({ status: 'aplicada', rev: 1 });

    // O segundo aparelho estava offline e ainda enxerga rev 0.
    const segunda = await push(user, workspaceId, [
      upsertProduto({ entityId: produtoId, baseRev: 0, payload: { name: 'Chá verde' } }),
    ]);
    const resultado = segunda.json().results[0];
    expect(resultado.status).toBe('conflito');
    expect(resultado.server.name).toBe('Chá preto');

    const [produto] = await context.services.db
      .select()
      .from(products)
      .where(eq(products.id, produtoId));
    expect(produto?.name).toBe('Chá preto');
  });

  it('nome repetido é rejeitado sem derrubar o resto do lote', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    await push(user, workspaceId, [upsertProduto({ payload: { name: 'Açúcar' } })]);

    const response = await push(user, workspaceId, [
      upsertProduto({ payload: { name: 'açúcar' } }),
      upsertProduto({ payload: { name: 'Farinha' } }),
    ]);

    const [repetido, valido] = response.json().results;
    expect(repetido).toMatchObject({ status: 'rejeitada', code: 'DUPLICATE_NAME' });
    expect(valido.status).toBe('aplicada');
  });

  it('exclusão vira lápide e repetir a exclusão continua valendo', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const produtoId = randomUUID();
    await push(user, workspaceId, [upsertProduto({ entityId: produtoId })]);

    const exclusao = {
      opId: randomUUID(),
      entity: 'produto' as const,
      op: 'delete' as const,
      entityId: produtoId,
      payload: { id: produtoId, deletedAt: Date.now(), rev: 1 },
    };

    expect((await push(user, workspaceId, [exclusao])).json().results[0].status).toBe('aplicada');
    const replay = await push(user, workspaceId, [exclusao]);
    expect(replay.json().results[0].status).toBe('aplicada');
    expect(replay.json().results[0].replayed).toBe(true);

    const [produto] = await context.services.db
      .select()
      .from(products)
      .where(eq(products.id, produtoId));
    expect(produto?.deletedAt).not.toBeNull();
  });

  it('excluir um produto libera o nome para um novo cadastro', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const produtoId = randomUUID();
    await push(user, workspaceId, [
      upsertProduto({ entityId: produtoId, payload: { name: 'Leite' } }),
    ]);
    await push(user, workspaceId, [
      {
        opId: randomUUID(),
        entity: 'produto' as const,
        op: 'delete' as const,
        entityId: produtoId,
        payload: { id: produtoId, deletedAt: Date.now(), rev: 1 },
      },
    ]);

    const recriado = await push(user, workspaceId, [upsertProduto({ payload: { name: 'Leite' } })]);
    expect(recriado.json().results[0].status).toBe('aplicada');
  });

  it('recusa a operação de quem não tem permissão sem pedir para tentar de novo', async () => {
    const dono = await registerUser(context);
    const workspaceId = await setupWorkspace(dono);

    const consulta = await registerUser(context);
    await context.services.db.insert(workspaceMembers).values({
      workspaceId,
      userId: consulta.userId,
      roleKey: 'consulta',
      status: 'active',
      invitedBy: dono.userId,
    });
    const sessao = await loginUser(context, consulta.email, VALID_PASSWORD);

    const response = await push(sessao, workspaceId, [upsertProduto()]);
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({
      status: 'rejeitada',
      code: 'MISSING_PERMISSION',
    });
  });
});

describe('leitura incremental', () => {
  it('entrega apenas o que mudou depois do cursor', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    await push(user, workspaceId, [upsertProduto({ payload: { name: 'Primeiro' } })]);
    const primeiraLeitura = await pull(user, workspaceId, 0);
    expect(primeiraLeitura.json().changes).toHaveLength(1);

    const cursor = Number(primeiraLeitura.json().nextCursor);
    await push(user, workspaceId, [upsertProduto({ payload: { name: 'Segundo' } })]);

    const segundaLeitura = await pull(user, workspaceId, cursor);
    const changes = segundaLeitura.json().changes;
    expect(changes).toHaveLength(1);
    expect((changes[0].data as { name: string }).name).toBe('Segundo');
  });

  it('devolve as alterações em ordem e pagina sem deixar buracos', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const produtoId = randomUUID();
    await push(user, workspaceId, [upsertProduto({ entityId: produtoId })]);
    await push(user, workspaceId, [
      movimentacao(produtoId),
      movimentacao(produtoId),
      movimentacao(produtoId),
    ]);

    const vistos: string[] = [];
    let cursor = 0;
    let hasMore = true;

    while (hasMore) {
      const pagina = await pull(user, workspaceId, cursor, 2);
      const corpo = pagina.json();
      for (const change of corpo.changes) {
        vistos.push(change.changeSeq);
      }
      cursor = Number(corpo.nextCursor);
      hasMore = corpo.hasMore;
    }

    // Um produto e três movimentações, cada um com sua posição, sem repetição
    // e em ordem crescente.
    expect(vistos).toHaveLength(4);
    expect(new Set(vistos).size).toBe(4);
    expect([...vistos].sort((a, b) => Number(a) - Number(b))).toEqual(vistos);
  });

  it('a lápide chega para o outro aparelho', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const produtoId = randomUUID();
    await push(user, workspaceId, [upsertProduto({ entityId: produtoId })]);
    const depoisDoCadastro = Number((await pull(user, workspaceId, 0)).json().nextCursor);

    await push(user, workspaceId, [
      {
        opId: randomUUID(),
        entity: 'produto' as const,
        op: 'delete' as const,
        entityId: produtoId,
        payload: { id: produtoId, deletedAt: Date.now(), rev: 1 },
      },
    ]);

    const changes = (await pull(user, workspaceId, depoisDoCadastro)).json().changes;
    expect(changes).toHaveLength(1);
    expect(changes[0].deleted).toBe(true);
    expect((changes[0].data as { id: string }).id).toBe(produtoId);
  });

  it('cursor anterior à limpeza de lápides exige recarga completa', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    await push(user, workspaceId, [upsertProduto()]);
    await push(user, workspaceId, [upsertProduto()]);

    // Simula a limpeza tendo passado por cima do ponto em que este aparelho
    // parou: as exclusões que ele não viu já não existem para serem entregues.
    await context.services.db
      .update(workspaces)
      .set({ tombstoneHorizonSeq: 2 })
      .where(eq(workspaces.id, workspaceId));

    const response = await pull(user, workspaceId, 1);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('SYNC_RESYNC_REQUIRED');
  });

  it('cursor à frente do servidor exige recarga completa', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const response = await pull(user, workspaceId, 999);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('SYNC_RESYNC_REQUIRED');
  });

  it('não entrega dados de uma empresa para quem não participa dela', async () => {
    const dono = await registerUser(context);
    const workspaceId = await setupWorkspace(dono);
    await push(dono, workspaceId, [upsertProduto()]);

    const estranho = await registerUser(context);
    const response = await pull(estranho, workspaceId, 0);

    expect([403, 404]).toContain(response.statusCode);
  });

  it('o que um aparelho envia chega ao outro', async () => {
    const dono = await registerUser(context);
    const workspaceId = await setupWorkspace(dono);

    const colega = await registerUser(context);
    await context.services.db.insert(workspaceMembers).values({
      workspaceId,
      userId: colega.userId,
      roleKey: 'gerente',
      status: 'active',
      invitedBy: dono.userId,
    });
    const sessaoColega = await loginUser(context, colega.email, VALID_PASSWORD);

    const produtoId = randomUUID();
    await push(dono, workspaceId, [
      upsertProduto({ entityId: produtoId, payload: { name: 'Pão de forma', quantity: 12 } }),
    ]);
    await push(dono, workspaceId, [
      movimentacao(produtoId, { payload: { changeType: 'saida', quantity: -2 } }),
    ]);

    const changes = (await pull(sessaoColega, workspaceId, 0)).json().changes;
    expect(changes).toHaveLength(2);
    expect(changes[0].entity).toBe('produto');
    expect(changes[1].entity).toBe('movimentacao');
    // O saldo do produto chega pela movimentação, não por uma nova versão do
    // produto: quantidade é consequência do histórico.
    expect((changes[1].data as { quantity: number }).quantity).toBe(-2);
  });

  it('registra a posição do aparelho para acompanhar quem está atrasado', async () => {
    const user = await registerUser(context, { installId: randomUUID() });
    const workspaceId = await setupWorkspace(user);

    await push(user, workspaceId, [upsertProduto()]);
    const leitura = await pull(user, workspaceId, 0);
    const cursor = Number(leitura.json().nextCursor);

    const [registro] = await context.services.db
      .select({ cursor: syncCursors.cursor })
      .from(syncCursors)
      .where(eq(syncCursors.workspaceId, workspaceId));
    expect(registro?.cursor).toBe(cursor);
  });
});
