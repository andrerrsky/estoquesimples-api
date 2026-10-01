import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { conflictLog, products } from '../../src/platform/db/schema/index.js';
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
  await context.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/billing/subscriptions`,
    headers: user.authHeader,
    payload: { purchaseToken: token },
  });

  return workspaceId;
}

interface CampoProduto {
  name?: string;
  description?: string | null;
  unitValue?: number;
  minStock?: number;
  category?: string | null;
  supplier?: string | null;
  location?: string | null;
  unit?: string | null;
}

const BASE: Required<Pick<CampoProduto, 'name' | 'unitValue' | 'minStock'>> & CampoProduto = {
  name: 'Café',
  unitValue: 20,
  minStock: 2,
  description: 'Pacote de 500g',
  category: 'Bebidas',
  supplier: 'Torrefação Central',
  location: 'Prateleira A',
  unit: 'un',
};

function upsert(
  entityId: string,
  campos: CampoProduto,
  opcoes: { baseRev?: number; previous?: Record<string, unknown> } = {},
) {
  return {
    opId: randomUUID(),
    entity: 'produto' as const,
    op: 'upsert' as const,
    entityId,
    ...(opcoes.baseRev === undefined ? {} : { baseRev: opcoes.baseRev }),
    payload: {
      id: entityId,
      quantity: 0,
      rev: 0,
      ...BASE,
      ...campos,
      ...(opcoes.previous ? { previous: opcoes.previous } : {}),
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

async function listarConflitos(user: RegisteredUser, workspaceId: string, status = 'pendente') {
  return context.app.inject({
    method: 'GET',
    url: `/v1/workspaces/${workspaceId}/conflicts?status=${status}`,
    headers: { ...user.authHeader, ...PROTOCOL },
  });
}

/** Cria o produto e deixa o servidor em rev 1 com uma alteração de outro aparelho. */
async function cenarioDivergente(
  user: RegisteredUser,
  workspaceId: string,
  alteracaoRemota: CampoProduto,
  previousRemoto: Record<string, unknown>,
): Promise<string> {
  const produtoId = randomUUID();
  await push(user, workspaceId, [upsert(produtoId, {})]);
  await push(user, workspaceId, [
    upsert(produtoId, alteracaoRemota, { baseRev: 0, previous: previousRemoto }),
  ]);
  return produtoId;
}

describe('merge por campo', () => {
  it('mescla edições que não se cruzam', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    // Um aparelho corrigiu o fornecedor; o outro, offline, a categoria. As duas
    // pessoas fizeram trabalhos diferentes e nenhuma delas deve perder o dela.
    const produtoId = await cenarioDivergente(
      user,
      workspaceId,
      { supplier: 'Novo Fornecedor' },
      { supplier: 'Torrefação Central' },
    );

    const response = await push(user, workspaceId, [
      upsert(
        produtoId,
        { category: 'Mercearia' },
        { baseRev: 0, previous: { category: 'Bebidas' } },
      ),
    ]);

    expect(response.json().results[0].status).toBe('aplicada');

    const [produto] = await context.services.db
      .select()
      .from(products)
      .where(eq(products.id, produtoId));
    expect(produto?.supplier).toBe('Novo Fornecedor');
    expect(produto?.category).toBe('Mercearia');
  });

  it('quando os dois mexem no mesmo campo descritivo, o valor perdido fica registrado', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const produtoId = await cenarioDivergente(
      user,
      workspaceId,
      { location: 'Depósito' },
      { location: 'Prateleira A' },
    );

    const response = await push(user, workspaceId, [
      upsert(
        produtoId,
        { location: 'Prateleira B' },
        { baseRev: 0, previous: { location: 'Prateleira A' } },
      ),
    ]);

    // A operação passa: o campo descritivo não trava a sincronização.
    expect(response.json().results[0].status).toBe('aplicada');

    const [produto] = await context.services.db
      .select()
      .from(products)
      .where(eq(products.id, produtoId));
    expect(produto?.location).toBe('Depósito');

    const [registro] = await context.services.db
      .select()
      .from(conflictLog)
      .where(eq(conflictLog.entityId, produtoId));
    expect(registro).toMatchObject({ field: 'location', status: 'automatico' });
    expect(registro?.discardedValue).toBe('Prateleira B');
    expect(registro?.keptValue).toBe('Depósito');
  });

  it('não acusa conflito quando os dois chegaram ao mesmo valor', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const produtoId = await cenarioDivergente(
      user,
      workspaceId,
      { unit: 'kg' },
      { unit: 'un' },
    );

    const response = await push(user, workspaceId, [
      upsert(produtoId, { unit: 'kg' }, { baseRev: 0, previous: { unit: 'un' } }),
    ]);

    expect(response.json().results[0].status).toBe('aplicada');
    const registros = await context.services.db
      .select()
      .from(conflictLog)
      .where(eq(conflictLog.entityId, produtoId));
    expect(registros).toHaveLength(0);
  });

  it('nome disputado exige decisão de uma pessoa', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const produtoId = await cenarioDivergente(
      user,
      workspaceId,
      { name: 'Café torrado' },
      { name: 'Café' },
    );

    const response = await push(user, workspaceId, [
      upsert(produtoId, { name: 'Café em grão' }, { baseRev: 0, previous: { name: 'Café' } }),
    ]);

    const resultado = response.json().results[0];
    expect(resultado.status).toBe('conflito');
    expect(resultado.server.name).toBe('Café torrado');

    const pendentes = (await listarConflitos(user, workspaceId)).json();
    expect(pendentes.pending).toBe(1);
    expect(pendentes.conflicts[0]).toMatchObject({
      field: 'name',
      kind: 'campo',
      status: 'pendente',
      discardedValue: 'Café em grão',
      keptValue: 'Café torrado',
    });
  });

  it('preço disputado não é decidido pelo servidor', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const produtoId = await cenarioDivergente(
      user,
      workspaceId,
      { unitValue: 25 },
      { unitValue: 20 },
    );

    const response = await push(user, workspaceId, [
      upsert(produtoId, { unitValue: 18.5 }, { baseRev: 0, previous: { unitValue: 20 } }),
    ]);

    expect(response.json().results[0].status).toBe('conflito');

    const [produto] = await context.services.db
      .select()
      .from(products)
      .where(eq(products.id, produtoId));
    expect(Number(produto?.unitValue)).toBe(25);
  });

  it('aparelho antigo, sem ponto de partida, recebe o estado atual', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);

    const produtoId = await cenarioDivergente(
      user,
      workspaceId,
      { description: 'Atualizada' },
      { description: 'Pacote de 500g' },
    );

    // Versão anterior do app: envia a edição sem dizer de onde partiu.
    const response = await push(user, workspaceId, [
      upsert(produtoId, { description: 'Outra' }, { baseRev: 0 }),
    ]);

    expect(response.json().results[0].status).toBe('conflito');
    expect((await listarConflitos(user, workspaceId)).json().pending).toBe(1);
  });
});

describe('resolução de conflitos', () => {
  async function conflitoDeNome(user: RegisteredUser, workspaceId: string) {
    const produtoId = await cenarioDivergente(
      user,
      workspaceId,
      { name: 'Café torrado' },
      { name: 'Café' },
    );
    await push(user, workspaceId, [
      upsert(produtoId, { name: 'Café em grão' }, { baseRev: 0, previous: { name: 'Café' } }),
    ]);

    const conflito = (await listarConflitos(user, workspaceId)).json().conflicts[0];
    return { produtoId, conflictId: conflito.id as string };
  }

  it('escolher o valor local reaplica o que havia sido descartado', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);
    const { produtoId, conflictId } = await conflitoDeNome(user, workspaceId);

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/conflicts/${conflictId}/resolve`,
      headers: { ...user.authHeader, ...PROTOCOL },
      payload: { escolha: 'meu' },
    });

    expect(response.statusCode).toBe(200);
    const [produto] = await context.services.db
      .select()
      .from(products)
      .where(eq(products.id, produtoId));
    expect(produto?.name).toBe('Café em grão');
  });

  it('escolher o valor do servidor apenas encerra o conflito', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);
    const { produtoId, conflictId } = await conflitoDeNome(user, workspaceId);

    await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/conflicts/${conflictId}/resolve`,
      headers: { ...user.authHeader, ...PROTOCOL },
      payload: { escolha: 'servidor' },
    });

    const [produto] = await context.services.db
      .select()
      .from(products)
      .where(eq(products.id, produtoId));
    expect(produto?.name).toBe('Café torrado');
    expect((await listarConflitos(user, workspaceId)).json().pending).toBe(0);
  });

  it('o mesmo conflito não é resolvido duas vezes', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);
    const { conflictId } = await conflitoDeNome(user, workspaceId);

    const url = `/v1/workspaces/${workspaceId}/conflicts/${conflictId}/resolve`;
    await context.app.inject({
      method: 'POST',
      url,
      headers: { ...user.authHeader, ...PROTOCOL },
      payload: { escolha: 'servidor' },
    });

    const segunda = await context.app.inject({
      method: 'POST',
      url,
      headers: { ...user.authHeader, ...PROTOCOL },
      payload: { escolha: 'meu' },
    });
    expect(segunda.statusCode).toBe(409);
  });
});

describe('exclusão durante edição', () => {
  async function excluidoEEditado(user: RegisteredUser, workspaceId: string) {
    const produtoId = randomUUID();
    await push(user, workspaceId, [upsert(produtoId, {})]);
    await push(user, workspaceId, [
      {
        opId: randomUUID(),
        entity: 'produto' as const,
        op: 'delete' as const,
        entityId: produtoId,
        payload: { id: produtoId, deletedAt: Date.now(), rev: 1 },
      },
    ]);

    // O outro aparelho estava offline editando o produto que sumiu.
    const response = await push(user, workspaceId, [
      upsert(
        produtoId,
        { description: 'Nova descrição' },
        { baseRev: 0, previous: { description: 'Pacote de 500g' } },
      ),
    ]);
    return { produtoId, resultado: response.json().results[0] };
  }

  it('a exclusão prevalece e a edição fica guardada', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);
    const { produtoId, resultado } = await excluidoEEditado(user, workspaceId);

    expect(resultado.status).toBe('conflito');

    const [produto] = await context.services.db
      .select()
      .from(products)
      .where(eq(products.id, produtoId));
    expect(produto?.deletedAt).not.toBeNull();

    const pendentes = (await listarConflitos(user, workspaceId)).json();
    expect(pendentes.conflicts[0]).toMatchObject({ kind: 'exclusao_vs_edicao' });
  });

  it('restaurar traz o produto de volta com a edição aplicada', async () => {
    const user = await registerUser(context);
    const workspaceId = await setupWorkspace(user);
    const { produtoId } = await excluidoEEditado(user, workspaceId);

    const conflito = (await listarConflitos(user, workspaceId)).json().conflicts[0];
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/conflicts/${conflito.id}/resolve`,
      headers: { ...user.authHeader, ...PROTOCOL },
      payload: { escolha: 'restaurar' },
    });

    expect(response.statusCode).toBe(200);
    const [produto] = await context.services.db
      .select()
      .from(products)
      .where(eq(products.id, produtoId));
    expect(produto?.deletedAt).toBeNull();
    expect(produto?.description).toBe('Nova descrição');
  });

  it('quem não participa da empresa não enxerga os conflitos dela', async () => {
    const dono = await registerUser(context);
    const workspaceId = await setupWorkspace(dono);
    await excluidoEEditado(dono, workspaceId);

    const estranho = await registerUser(context);
    const response = await listarConflitos(estranho, workspaceId);
    expect([403, 404]).toContain(response.statusCode);
  });
});
