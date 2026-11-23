import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { errorEvents, products } from '../../src/platform/db/schema/index.js';
import { recordError } from '../../src/modules/errors/error-log.js';
import { createTestApp, registerUser, resetDatabase, type RegisteredUser, type TestContext } from '../helpers/test-app.js';

/**
 * Texto com byte nulo e outros caracteres de controle vindos do aparelho.
 *
 * Caso real: uma empresa ficou com 0 produtos na nuvem desde 06/11/2026 e
 * todo `sync/push` devolvia 500. A importação de planilha de então lia
 * qualquer arquivo pela posição das colunas, inclusive um binário renomeado
 * para `.csv` — e o SQLite do aparelho guarda `\u0000` num texto sem
 * reclamar. No Postgres o mesmo texto é recusado, e o erro subia como 500 em
 * toda tentativa: o estoque da pessoa ficava preso no celular para sempre,
 * sem nada na tela explicando por quê.
 */
const PROTOCOL = { 'x-sync-protocol': '1' };

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

async function empresa(user: RegisteredUser): Promise<string> {
  const created = await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: user.authHeader, payload: { name: 'Loja' } });
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
}

function upsert(payload: Record<string, unknown>) {
  const id = (payload['id'] as string) ?? randomUUID();
  return {
    opId: randomUUID(),
    entity: 'produto' as const,
    op: 'upsert' as const,
    entityId: id,
    payload: { id, name: 'Produto', quantity: 0, unitValue: 0, minStock: 0, unit: 'un', rev: 0, ...payload },
  };
}

const push = (user: RegisteredUser, workspaceId: string, operations: unknown[]) =>
  context.app.inject({ method: 'POST', url: `/v1/workspaces/${workspaceId}/sync/push`, headers: { ...user.authHeader, ...PROTOCOL }, payload: { operations } });

describe('sync: texto com caractere de controle', () => {
  it('byte nulo no nome não derruba o push: o produto sobe limpo', async () => {
    const user = await registerUser(context);
    const workspaceId = await empresa(user);
    const id = randomUUID();

    const response = await push(user, workspaceId, [
      upsert({ id, name: 'Caf\u0000é torrado', description: 'linha 1\nlinha 2\u0007', sku: 'ABC\u0000123' }),
    ]);

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({ status: 'aplicada' });

    const [row] = await context.services.db.select().from(products).where(eq(products.id, id));
    expect(row!.name).toBe('Café torrado');
    expect(row!.sku).toBe('ABC123');
    // Quebra de linha é texto de verdade e fica; o sino (\u0007) não.
    expect(row!.description).toBe('linha 1\nlinha 2');
  });

  it('o resto do lote não é perdido por causa de uma linha suja', async () => {
    const user = await registerUser(context);
    const workspaceId = await empresa(user);
    const sujo = randomUUID();
    const limpo = randomUUID();

    const response = await push(user, workspaceId, [
      upsert({ id: sujo, name: 'Arroz\u0000' }),
      upsert({ id: limpo, name: 'Feijão' }),
    ]);

    expect(response.statusCode).toBe(200);
    const total = await context.services.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM products WHERE workspace_id = ${workspaceId}`,
    );
    expect(Number(total.rows[0]!.n)).toBe(2);
  });

  it('nome que só tem caractere de controle é recusado como nome vazio, sem 500', async () => {
    const user = await registerUser(context);
    const workspaceId = await empresa(user);

    const response = await push(user, workspaceId, [upsert({ name: '\u0000\u0000' })]);

    expect(response.statusCode).toBe(200);
    const resultado = response.json().results[0];
    expect(resultado.status).not.toBe('aplicada');
    expect(resultado.status).toBe('rejeitada');
  });

  /**
   * O registro do erro cita o valor que derrubou o banco. Se ele mesmo não
   * aguentar o byte nulo, o 500 some do painel — foi o que aconteceu: o app
   * reportou o erro e o servidor não tinha nada.
   */
  it('o painel de erros aguenta a mensagem que cita o texto binário', async () => {
    await recordError(context.services, {
      source: 'api',
      kind: 'api',
      code: 'INTERNAL',
      message: 'PostgresError: invalid byte sequence em "Caf\u0000é"',
      stack: 'Error: valor \u0000 recusado\n  at insert',
      route: 'POST /v1/workspaces/:id/sync/push',
      status: 500,
    });

    const registros = await context.services.db.select().from(errorEvents);
    expect(registros).toHaveLength(1);
    expect(registros[0]!.message).toContain('Café');
    expect(registros[0]!.message).not.toContain('\u0000');
  });
});
