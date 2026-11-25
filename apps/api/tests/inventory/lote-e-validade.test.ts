import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

/** `YYYY-MM-DD` a tantos dias de hoje, que é como a validade chega e volta. */
function dia(offset: number): string {
  const data = new Date(Date.now() + offset * 86_400_000);
  return data.toISOString().slice(0, 10);
}

async function empresa(user: RegisteredUser): Promise<string> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: user.authHeader,
    payload: { name: 'Biscoitos do Thiago' },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

describe('lote, fabricação e validade', () => {
  it('distribui o saldo pelos lotes na ordem da validade e tira do lote certo ao estornar', async () => {
    const user = await registerUser(context, { installId: 'aparelho-lote-0001-00000000000000000' });
    const ws = await empresa(user);
    const h = user.authHeader;
    const base = `/v1/workspaces/${ws}`;

    // Cadastro com estoque inicial já carrega lote: é a entrada mais comum.
    const produto = await context.app.inject({
      method: 'POST',
      url: `${base}/products`,
      headers: h,
      payload: {
        name: 'Biscoito de maizena',
        quantity: 10,
        unit: 'un',
        batchCode: 'L1',
        manufacturedOn: dia(-30),
        expiresOn: dia(10),
      },
    });
    expect(produto.statusCode).toBe(201);
    const productId = produto.json().id as string;

    const entrada = (payload: Record<string, unknown>) =>
      context.app.inject({ method: 'POST', url: `${base}/movements`, headers: h, payload: { productId, type: 'entrada', ...payload } });

    expect((await entrada({ quantity: 20, batchCode: 'L2', expiresOn: dia(60) })).statusCode).toBe(201);
    expect((await entrada({ quantity: 5, batchCode: 'L3', expiresOn: dia(-2) })).statusCode).toBe(201);

    const lotes = async (query = '') =>
      (await context.app.inject({ method: 'GET', url: `${base}/batches${query}`, headers: h })).json();

    // Saldo 35 e lotes somando 35: cada um com o que entrou.
    let corpo = await lotes();
    expect(corpo.items.map((item: Record<string, unknown>) => [item['batchCode'], item['quantity']])).toEqual([
      ['L3', 5],
      ['L1', 10],
      ['L2', 20],
    ]);
    expect(corpo.summary).toMatchObject({ expired: 1, expiringSoon: 1, expiredQuantity: 5, withoutBatch: 0 });
    expect(corpo.items[0]).toMatchObject({ expired: true, daysToExpire: -2 });

    // Uma saída de 12 come o lote vencido e o que vence antes (FEFO).
    const saida = await context.app.inject({
      method: 'POST',
      url: `${base}/movements`,
      headers: h,
      payload: { productId, type: 'saida', quantity: 12 },
    });
    expect(saida.statusCode).toBe(201);

    corpo = await lotes();
    expect(corpo.items.map((item: Record<string, unknown>) => [item['batchCode'], item['quantity']])).toEqual([
      ['L1', 3],
      ['L2', 20],
    ]);
    expect(corpo.summary).toMatchObject({ expired: 0, expiringSoon: 1 });

    // Estorno da entrada do L2 tira 20 do próprio L2, não do lote que vence antes.
    const historico = await context.app.inject({ method: 'GET', url: `${base}/movements?productId=${productId}`, headers: h });
    const entradaL2 = historico.json().items.find((item: Record<string, unknown>) => item['batchCode'] === 'L2');
    expect(entradaL2).toMatchObject({ expiresOn: dia(60) });
    const estorno = await context.app.inject({
      method: 'POST',
      url: `${base}/movements/${entradaL2['id']}/cancel`,
      headers: h,
      payload: {},
    });
    expect(estorno.statusCode).toBe(201);

    corpo = await lotes();
    expect(corpo.items.map((item: Record<string, unknown>) => [item['batchCode'], item['quantity']])).toEqual([['L1', 3]]);
  });

  it('filtra o que vence na janela pedida e não inventa lote para entrada antiga sem validade', async () => {
    const user = await registerUser(context, { installId: 'aparelho-lote-0002-00000000000000000' });
    const ws = await empresa(user);
    const h = user.authHeader;
    const base = `/v1/workspaces/${ws}`;

    const id = randomUUID();
    // Produto que já existia antes do recurso: entrada sem lote nenhum.
    expect(
      (await context.app.inject({ method: 'POST', url: `${base}/products`, headers: h, payload: { id, name: 'Farinha', quantity: 8 } })).statusCode,
    ).toBe(201);
    expect(
      (
        await context.app.inject({
          method: 'POST',
          url: `${base}/movements`,
          headers: h,
          payload: { productId: id, type: 'entrada', quantity: 4, batchCode: 'F-9', expiresOn: dia(90) },
        })
      ).statusCode,
    ).toBe(201);

    const todos = (await context.app.inject({ method: 'GET', url: `${base}/batches`, headers: h })).json();
    expect(todos.items).toHaveLength(1);
    expect(todos.items[0]).toMatchObject({ batchCode: 'F-9', quantity: 4 });
    // O saldo de 8 que entrou sem lote aparece à parte, em vez de virar lote.
    expect(todos.summary.withoutBatch).toBe(8);

    const janela = (await context.app.inject({ method: 'GET', url: `${base}/batches?filter=expiring&window=30`, headers: h })).json();
    expect(janela.items).toHaveLength(0);
    const ampla = (await context.app.inject({ method: 'GET', url: `${base}/batches?filter=expiring&window=120`, headers: h })).json();
    expect(ampla.items).toHaveLength(1);
  });

  it('não guarda lote em saída e recusa data inválida', async () => {
    const user = await registerUser(context, { installId: 'aparelho-lote-0003-00000000000000000' });
    const ws = await empresa(user);
    const h = user.authHeader;
    const base = `/v1/workspaces/${ws}`;

    const produto = await context.app.inject({
      method: 'POST',
      url: `${base}/products`,
      headers: h,
      payload: { name: 'Rosquinha', quantity: 10 },
    });
    const productId = produto.json().id as string;

    const saida = await context.app.inject({
      method: 'POST',
      url: `${base}/movements`,
      headers: h,
      payload: { productId, type: 'saida', quantity: 2, batchCode: 'X1', expiresOn: dia(5) },
    });
    expect(saida.statusCode).toBe(201);
    const lotes = (await context.app.inject({ method: 'GET', url: `${base}/batches`, headers: h })).json();
    expect(lotes.items).toHaveLength(0);

    const invalida = await context.app.inject({
      method: 'POST',
      url: `${base}/movements`,
      headers: h,
      payload: { productId, type: 'entrada', quantity: 1, expiresOn: '2026-13-45' },
    });
    expect(invalida.statusCode).toBe(400);
  });
});
