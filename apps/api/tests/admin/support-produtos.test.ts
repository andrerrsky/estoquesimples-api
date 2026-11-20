import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { hashPassword } from '../../src/platform/auth/password.js';
import { createTestApp, registerUser, resetDatabase, type RegisteredUser, type TestContext } from '../helpers/test-app.js';

/**
 * Exclusão de produto pelo suporte.
 *
 * A aba Estoque do painel é somente leitura de propósito. A exceção nasceu de
 * um defeito nosso: até a versão 38 do app, a importação lia planilha sem
 * cabeçalho pela posição das colunas, e um arquivo que não era catálogo virava
 * produto na conta do cliente. Limpar isso é nosso, não dele.
 */
const ADMIN_PASSWORD = 'PainelSeguro#2026';
const CSRF = { 'x-requested-with': 'estoquesimples-admin' };

let context: TestContext;

async function admin(role: 'owner' | 'support' | 'viewer'): Promise<string> {
  const email = `${role}.${randomUUID()}@exemplo.com.br`;
  await context.services.db.insert(platformAdmins).values({
    email,
    name: `Admin ${role}`,
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role,
  });
  const response = await context.app.inject({
    method: 'POST',
    url: '/admin/api/auth/login',
    headers: CSRF,
    payload: { email, password: ADMIN_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (raw as string).split(';')[0] as string;
}

async function empresaComProduto(user: RegisteredUser): Promise<{ workspaceId: string; productId: string }> {
  const created = await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: user.authHeader, payload: { name: 'Loja do Teste' } });
  expect(created.statusCode).toBe(201);
  const workspaceId = created.json().id as string;
  const productId = randomUUID();
  const product = await context.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/products`,
    headers: user.authHeader,
    payload: { id: productId, name: 'Senhas do sistema', quantity: 0 },
  });
  expect(product.statusCode).toBe(201);
  return { workspaceId, productId };
}

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
});

describe('suporte: excluir produto do cliente', () => {
  it('exclui logicamente, registra as duas auditorias e o aparelho recebe a lápide', async () => {
    const user = await registerUser(context);
    const { workspaceId, productId } = await empresaComProduto(user);
    const cookie = await admin('support');

    const response = await context.app.inject({
      method: 'POST',
      url: `/admin/api/workspaces/${workspaceId}/products/${productId}/delete`,
      headers: { ...CSRF, cookie },
      payload: { reason: 'Importação criou produto a partir de planilha que não era catálogo.' },
    });
    expect(response.statusCode).toBe(200);

    const rows = await context.services.db.execute<{ deleted_at: string | null }>(
      sql`SELECT deleted_at FROM products WHERE id = ${productId}`,
    );
    expect(rows.rows[0]?.deleted_at).not.toBeNull();

    // O produto sai da leitura do painel, e aparece com "incluir excluídos".
    const lista = await context.app.inject({ method: 'GET', url: `/admin/api/workspaces/${workspaceId}/products`, headers: { cookie } });
    expect(lista.json().items.some((item: { id: string }) => item.id === productId)).toBe(false);
    const comExcluidos = await context.app.inject({ method: 'GET', url: `/admin/api/workspaces/${workspaceId}/products?includeDeleted=true`, headers: { cookie } });
    expect(comExcluidos.json().items.some((item: { id: string }) => item.id === productId)).toBe(true);

    // A lápide é uma operação de sincronização: o aparelho do cliente a recebe
    // no próximo pull, senão o produto voltaria no envio seguinte.
    const pull = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/sync/pull?cursor=0`,
      headers: { ...user.authHeader, 'x-sync-protocol': '1' },
    });
    expect(pull.statusCode).toBe(200);
    const mudancas = pull.json().changes as Array<{ entity: string; deleted: boolean; data: { id: string } }>;
    expect(mudancas.some((change) => change.entity === 'produto' && change.deleted && change.data.id === productId)).toBe(true);

    const adminAudit = await context.services.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM admin_audit_log WHERE action = 'workspace.product_deleted' AND target_id = ${productId}`,
    );
    expect(Number(adminAudit.rows[0]?.n)).toBe(1);
    const empresaAudit = await context.services.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM audit_log WHERE entity_id = ${productId} AND metadata->>'origem' = 'suporte'`,
    );
    expect(Number(empresaAudit.rows[0]?.n)).toBe(1);
  });

  it('exige motivo e recusa quem só pode ler', async () => {
    const user = await registerUser(context);
    const { workspaceId, productId } = await empresaComProduto(user);

    const viewer = await admin('viewer');
    const negado = await context.app.inject({
      method: 'POST',
      url: `/admin/api/workspaces/${workspaceId}/products/${productId}/delete`,
      headers: { ...CSRF, cookie: viewer },
      payload: { reason: 'curiosidade' },
    });
    expect(negado.statusCode).toBe(403);

    const cookie = await admin('support');
    const semMotivo = await context.app.inject({
      method: 'POST',
      url: `/admin/api/workspaces/${workspaceId}/products/${productId}/delete`,
      headers: { ...CSRF, cookie },
      payload: {},
    });
    expect(semMotivo.statusCode).toBe(400);

    const vivo = await context.services.db.execute<{ deleted_at: string | null }>(
      sql`SELECT deleted_at FROM products WHERE id = ${productId}`,
    );
    expect(vivo.rows[0]?.deleted_at).toBeNull();
  });

  it('404 em produto já excluído ou de outra empresa', async () => {
    const user = await registerUser(context);
    const { workspaceId, productId } = await empresaComProduto(user);
    const outro = await registerUser(context);
    const outra = await empresaComProduto(outro);
    const cookie = await admin('support');

    const primeira = await context.app.inject({
      method: 'POST',
      url: `/admin/api/workspaces/${workspaceId}/products/${productId}/delete`,
      headers: { ...CSRF, cookie },
      payload: { reason: 'limpeza do defeito da importação' },
    });
    expect(primeira.statusCode).toBe(200);

    const repetida = await context.app.inject({
      method: 'POST',
      url: `/admin/api/workspaces/${workspaceId}/products/${productId}/delete`,
      headers: { ...CSRF, cookie },
      payload: { reason: 'limpeza do defeito da importação' },
    });
    expect(repetida.statusCode).toBe(404);

    const trocado = await context.app.inject({
      method: 'POST',
      url: `/admin/api/workspaces/${workspaceId}/products/${outra.productId}/delete`,
      headers: { ...CSRF, cookie },
      payload: { reason: 'limpeza do defeito da importação' },
    });
    expect(trocado.statusCode).toBe(404);
  });
});
