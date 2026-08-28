import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { nextChangeSeq } from '../../src/modules/sync/change-seq.js';
import { withTenant } from '../../src/platform/db/client.js';
import { products, stockMovements, workspaceMembers } from '../../src/platform/db/schema/index.js';
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

async function createWorkspace(user: RegisteredUser, name = 'Minha Loja'): Promise<string> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: user.authHeader,
    payload: { name },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Falha ao criar workspace: ${response.statusCode} ${response.body}`);
  }
  return response.json().id;
}

async function addMember(
  workspaceId: string,
  owner: RegisteredUser,
  memberUserId: string,
  role: string,
): Promise<void> {
  await context.services.db.insert(workspaceMembers).values({
    workspaceId,
    userId: memberUserId,
    roleKey: role,
    status: 'active',
    invitedBy: owner.userId,
  });
}

async function seedInventory(
  workspaceId: string,
  userId: string,
): Promise<{ productId: string; movementId: string }> {
  const productId = randomUUID();
  const movementId = randomUUID();

  await withTenant(context.services.db, { workspaceId, userId }, async (tx) => {
    const productSeq = await nextChangeSeq(tx, workspaceId);
    await tx.insert(products).values({
      id: productId,
      workspaceId,
      name: '=CMD()',
      description: 'grãos, torrados',
      unitValue: '12.5',
      quantityCache: '10',
      minStock: '2',
      unit: 'un',
      category: 'Bebidas',
      sku: 'CAF-1',
      barcode: '789123',
      supplier: 'Sítio',
      location: 'Prateleira A',
      rev: 1,
      changeSeq: productSeq,
    });

    const movementSeq = await nextChangeSeq(tx, workspaceId);
    await tx.insert(stockMovements).values({
      id: movementId,
      workspaceId,
      productId,
      productName: '=CMD()',
      type: 'saida',
      quantity: '-3',
      note: 'venda',
      occurredAt: new Date('2026-01-15T12:00:00.000Z'),
      recordedAt: new Date('2026-01-15T12:00:01.000Z'),
      changeSeq: movementSeq,
    });
  });

  return { productId, movementId };
}

describe('exportação de dados', () => {
  it('exige autenticação', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${randomUUID()}/export`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('não revela empresa de outro usuário', async () => {
    const owner = await registerUser(context);
    const stranger = await registerUser(context);
    const workspaceId = await createWorkspace(owner);

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/export`,
      headers: stranger.authHeader,
    });
    expect(response.statusCode).toBe(404);
  });

  it('devolve JSON no contrato do aplicativo sem exigir assinatura', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    const { productId, movementId } = await seedInventory(workspaceId, owner.userId);

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/export`,
      headers: owner.authHeader,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.format).toBe('estoquesimples.backup');
    expect(body.version).toBe(1);
    expect(body.source).toBe('cloud');
    expect(body.workspaceId).toBe(workspaceId);
    expect(body.products).toHaveLength(1);
    expect(body.products[0]).toMatchObject({
      id: productId,
      name: '=CMD()',
      quantity: 10,
      unitValue: 12.5,
      sku: 'CAF-1',
    });
    expect(body.movements).toHaveLength(1);
    expect(body.movements[0]).toMatchObject({
      id: movementId,
      productId,
      changeType: 'saida',
      quantity: -3,
    });
  });

  it('CSV de produtos neutraliza fórmula e preserva vírgula na descrição', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    await seedInventory(workspaceId, owner.userId);

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/export/produtos.csv`,
      headers: owner.authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/csv/);
    const csv = response.body;
    expect(csv).toContain("'=CMD()");
    expect(csv).toContain('"grãos, torrados"');
    expect(csv).toContain('CAF-1');
  });

  it('CSV de movimentações leva quantidade com sinal', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    await seedInventory(workspaceId, owner.userId);

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/export/movimentacoes.csv`,
      headers: owner.authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('saida');
    expect(response.body).toMatch(/-3/);
  });

  it('consulta consegue extrair; quem não é membro, não', async () => {
    const owner = await registerUser(context);
    const viewer = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    await addMember(workspaceId, owner, viewer.userId, 'consulta');
    await seedInventory(workspaceId, owner.userId);

    const allowed = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/export`,
      headers: viewer.authHeader,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().products).toHaveLength(1);
  });
});
