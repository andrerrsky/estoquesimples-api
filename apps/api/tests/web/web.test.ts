import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workspaceMembers } from '../../src/platform/db/schema/index.js';
import {
  createTestApp,
  loginUser,
  registerUser,
  resetDatabase,
  uniqueEmail,
  VALID_PASSWORD,
  type RegisteredUser,
  type TestContext,
} from '../helpers/test-app.js';

const WEB = { host: 'web.test', 'x-requested-with': 'estoquesimples-web' };
const SYNC = { 'x-sync-protocol': '1' };

let context: TestContext;

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
  context.fcm.sent.length = 0;
});

async function criarEmpresa(user: RegisteredUser, name = 'Loja Web'): Promise<string> {
  const response = await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: user.authHeader, payload: { name } });
  expect(response.statusCode).toBe(201);
  return response.json().id;
}

async function setLimit(limit: number | null): Promise<void> {
  await context.services.db.execute(
    sql`UPDATE plan_features SET limit_value = ${limit} WHERE plan_key = 'gratuito' AND feature_key = 'produtos.sincronizados'`,
  );
}

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first ?? '').split(';')[0] ?? '';
}

describe('hosts: aplicação web e API na mesma instância', () => {
  it('no host da web entrega a interface e a API em /v1; painel e docs não respondem por ele', async () => {
    const home = await context.app.inject({ method: 'GET', url: '/', headers: { host: 'web.test' } });
    expect(home.statusCode).toBe(200);
    expect(home.headers['content-type']).toContain('text/html');
    expect(home.headers['content-security-policy']).toContain("default-src 'self'");

    for (const url of ['/app/estoque', '/admin', '/docs', '/admin/api/overview']) {
      const page = await context.app.inject({ method: 'GET', url, headers: { host: 'web.test' } });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
    }

    const api = await context.app.inject({ method: 'GET', url: '/v1/config', headers: { host: 'web.test' } });
    expect(api.statusCode).toBe(200);
    expect(api.headers['content-type']).toContain('application/json');

    const post = await context.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: { host: 'web.test' }, payload: {} });
    expect(post.statusCode).toBe(404);

    // Script de uma versão anterior (aba aberta durante um deploy): em vez de
    // 404, um módulo que recarrega a página, sem cache.
    const staleScript = await context.app.inject({ method: 'GET', url: '/assets/SupportPage-OU6pYmGZ.js', headers: { host: 'web.test' } });
    expect(staleScript.statusCode).toBe(200);
    expect(staleScript.headers['content-type']).toContain('text/javascript');
    expect(staleScript.headers['cache-control']).toBe('no-store');
    expect(staleScript.body).toContain('location.reload()');

    // Os demais arquivos que não existem continuam sendo 404 de verdade.
    for (const missing of ['/assets/nao-existe.css', '/imagem.png', '/assets/sub/pasta.js']) {
      const asset = await context.app.inject({ method: 'GET', url: missing, headers: { host: 'web.test' } });
      expect(asset.statusCode, missing).toBe(404);
    }

    const www = await context.app.inject({ method: 'GET', url: '/entrar?x=1', headers: { host: 'www.web.test' } });
    expect(www.statusCode).toBe(301);
    expect(www.headers.location).toBe('https://web.test/entrar?x=1');
  });

  it('no host da API nada muda: identificação em / e painel em /admin', async () => {
    const root = await context.app.inject({ method: 'GET', url: '/', headers: { host: 'api.test' } });
    expect(root.json()).toMatchObject({ service: 'estoquesimples-api' });
    const unknown = await context.app.inject({ method: 'GET', url: '/app/estoque', headers: { host: 'api.test' } });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('sessão web (cookie httpOnly)', () => {
  it('exige o cabeçalho anti-CSRF, guarda o refresh token só no cookie e rotaciona na renovação', async () => {
    const email = uniqueEmail('web');
    const semHeader = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/web/register',
      headers: { host: 'web.test' },
      payload: { email, password: VALID_PASSWORD, name: 'Usuária Web' },
    });
    expect(semHeader.statusCode).toBe(403);

    const crossSite = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/web/register',
      headers: { ...WEB, 'sec-fetch-site': 'cross-site' },
      payload: { email, password: VALID_PASSWORD, name: 'Usuária Web' },
    });
    expect(crossSite.statusCode).toBe(403);

    const registered = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/web/register',
      headers: WEB,
      payload: { email, password: VALID_PASSWORD, name: 'Usuária Web', device: { installId: 'navegador-teste-0001', platform: 'android', model: 'Chrome 140' } },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().refreshToken).toBeUndefined();
    expect(registered.json().accessToken).toBeTruthy();
    const setCookie = String(registered.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/v1/auth/web');
    const firstCookie = cookieOf(registered);

    // O aparelho registrado por esta rota é sempre "web", diga o cliente o que disser.
    const devices = await context.services.db.execute<{ platform: string }>(sql`SELECT platform FROM devices`);
    expect(devices.rows[0]?.platform).toBe('web');

    const semCookie = await context.app.inject({ method: 'POST', url: '/v1/auth/web/refresh', headers: WEB });
    expect(semCookie.statusCode).toBe(401);

    const refreshed = await context.app.inject({ method: 'POST', url: '/v1/auth/web/refresh', headers: { ...WEB, cookie: firstCookie } });
    expect(refreshed.statusCode).toBe(200);
    const secondCookie = cookieOf(refreshed);
    expect(secondCookie).not.toBe(firstCookie);

    // Outra aba renovando com o cookie antigo no mesmo instante: não é roubo,
    // é corrida. Recebe 409 e a sessão continua de pé.
    const race = await context.app.inject({ method: 'POST', url: '/v1/auth/web/refresh', headers: { ...WEB, cookie: firstCookie } });
    expect(race.statusCode).toBe(409);
    expect(race.json().error.code).toBe('AUTH_REFRESH_IN_PROGRESS');
    const stillValid = await context.app.inject({ method: 'POST', url: '/v1/auth/web/refresh', headers: { ...WEB, cookie: secondCookie } });
    expect(stillValid.statusCode).toBe(200);
    const thirdCookie = cookieOf(stillValid);

    const me = await context.app.inject({ method: 'GET', url: '/v1/me', headers: { host: 'web.test', authorization: `Bearer ${stillValid.json().accessToken}` } });
    expect(me.statusCode).toBe(200);

    const logout = await context.app.inject({ method: 'POST', url: '/v1/auth/web/logout', headers: { ...WEB, cookie: thirdCookie } });
    expect(logout.statusCode).toBe(200);
    const afterLogout = await context.app.inject({ method: 'POST', url: '/v1/auth/web/refresh', headers: { ...WEB, cookie: thirdCookie } });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('token de refresh reutilizado fora da janela de corrida derruba a sessão', async () => {
    const email = uniqueEmail('reuso');
    const registered = await context.app.inject({ method: 'POST', url: '/v1/auth/web/register', headers: WEB, payload: { email, password: VALID_PASSWORD, name: 'Reuso' } });
    const firstCookie = cookieOf(registered);
    const refreshed = await context.app.inject({ method: 'POST', url: '/v1/auth/web/refresh', headers: { ...WEB, cookie: firstCookie } });
    await context.services.db.execute(sql`UPDATE refresh_tokens SET used_at = now() - interval '5 minutes' WHERE used_at IS NOT NULL`);

    const reuse = await context.app.inject({ method: 'POST', url: '/v1/auth/web/refresh', headers: { ...WEB, cookie: firstCookie } });
    expect(reuse.statusCode).toBe(401);
    const dead = await context.app.inject({ method: 'POST', url: '/v1/auth/web/refresh', headers: { ...WEB, cookie: cookieOf(refreshed) } });
    expect(dead.statusCode).toBe(401);
  });
});

describe('estoque pela web', () => {
  const base = (workspaceId: string) => `/v1/workspaces/${workspaceId}`;

  it('cadastra, busca sem acento, movimenta, estorna e mantém o saldo igual ao que um aparelho recebe', async () => {
    const user = await registerUser(context, { installId: 'aparelho-web-0001' });
    const ws = await criarEmpresa(user);
    const h = user.authHeader;

    const id = randomUUID();
    const body = { id, name: 'Café Torrado', quantity: 10, unitValue: 18.5, minStock: 3, unit: 'un', category: 'Bebidas' };
    const created = await context.app.inject({ method: 'POST', url: `${base(ws)}/products`, headers: h, payload: body });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id, quantity: 10, lowStock: false, rev: 0 });

    // Repetir o envio (resposta perdida) não duplica nem soma de novo.
    const again = await context.app.inject({ method: 'POST', url: `${base(ws)}/products`, headers: h, payload: body });
    expect(again.statusCode).toBe(201);
    expect(again.json().quantity).toBe(10);

    const duplicate = await context.app.inject({ method: 'POST', url: `${base(ws)}/products`, headers: h, payload: { name: 'café torrado', quantity: 1 } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('DUPLICATE_NAME');

    const fraction = await context.app.inject({ method: 'POST', url: `${base(ws)}/products`, headers: h, payload: { name: 'Parafuso', quantity: 1.5, unit: 'un' } });
    expect(fraction.statusCode).toBe(400);
    const kilo = await context.app.inject({ method: 'POST', url: `${base(ws)}/products`, headers: h, payload: { name: 'Açúcar', quantity: 1.5, unit: 'kg', minStock: 2 } });
    expect(kilo.statusCode).toBe(201);

    const search = await context.app.inject({ method: 'GET', url: `${base(ws)}/products?q=${encodeURIComponent('acucar')}`, headers: h });
    expect(search.json().items.map((p: { name: string }) => p.name)).toEqual(['Açúcar']);
    const list = await context.app.inject({ method: 'GET', url: `${base(ws)}/products`, headers: h });
    expect(list.json()).toMatchObject({ total: 2, counts: { all: 2, lowStock: 1 } });
    const low = await context.app.inject({ method: 'GET', url: `${base(ws)}/products?lowStock=true`, headers: h });
    expect(low.json().items.map((p: { name: string }) => p.name)).toEqual(['Açúcar']);

    const tooMuch = await context.app.inject({ method: 'POST', url: `${base(ws)}/movements`, headers: h, payload: { productId: id, type: 'saida', quantity: 11 } });
    expect(tooMuch.statusCode).toBe(409);
    const out = await context.app.inject({ method: 'POST', url: `${base(ws)}/movements`, headers: h, payload: { productId: id, type: 'saida', quantity: 4, note: 'Venda balcão' } });
    expect(out.statusCode).toBe(201);
    expect(out.json().product.quantity).toBe(6);

    const cancel = await context.app.inject({ method: 'POST', url: `${base(ws)}/movements/${out.json().movementId}/cancel`, headers: h, payload: {} });
    expect(cancel.statusCode).toBe(201);
    expect(cancel.json().product.quantity).toBe(10);
    const cancelTwice = await context.app.inject({ method: 'POST', url: `${base(ws)}/movements/${out.json().movementId}/cancel`, headers: h, payload: {} });
    expect(cancelTwice.statusCode).toBe(409);

    const history = await context.app.inject({ method: 'GET', url: `${base(ws)}/movements?productId=${id}`, headers: h });
    const rows = history.json().items as Array<{ type: string; quantity: number; balanceAfter: number; reversedBy: string | null; canCancel: boolean }>;
    expect(rows.map((row) => [row.type, row.quantity, row.balanceAfter])).toEqual([
      ['cancelamento', 4, 10],
      ['saida', -4, 6],
      ['cadastro', 10, 10],
    ]);
    expect(rows[1]?.reversedBy).toBeTruthy();
    expect(rows[1]?.canCancel).toBe(false);

    // O aparelho que entrar agora baixa em vez de enviar (empresa semeada
    // pela web) e chega ao mesmo saldo somando o que recebe.
    const start = await context.app.inject({ method: 'POST', url: `${base(ws)}/sync/initial-upload`, headers: { ...h, ...SYNC }, payload: { declaredProducts: 0, declaredMovements: 0, batchSize: 100 } });
    expect(start.statusCode).toBe(409);
    expect(start.json().error.code).toBe('SYNC_ALREADY_SEEDED');
    const pull = await context.app.inject({ method: 'GET', url: `${base(ws)}/sync/pull?cursor=0`, headers: { ...h, ...SYNC } });
    const saldos = new Map<string, number>();
    for (const change of pull.json().changes as Array<{ entity: string; data: { id: string; productId?: string; quantity: number } }>) {
      if (change.entity === 'produto') saldos.set(change.data.id, change.data.quantity);
      else if (change.data.productId && saldos.has(change.data.productId)) saldos.set(change.data.productId, (saldos.get(change.data.productId) ?? 0) + change.data.quantity);
    }
    expect(saldos.get(id)).toBe(10);
  });

  it('edita com mesclagem por campo, acusa conflito no mesmo campo e ajusta quantidade por movimentação', async () => {
    const user = await registerUser(context);
    const ws = await criarEmpresa(user);
    const h = user.authHeader;
    const created = (await context.app.inject({ method: 'POST', url: `${base(ws)}/products`, headers: h, payload: { name: 'Arroz 5kg', quantity: 20, unitValue: 25 } })).json();

    const first = await context.app.inject({ method: 'PATCH', url: `${base(ws)}/products/${created.id}`, headers: h, payload: { rev: 0, changes: { category: 'Mercearia' }, base: { category: null } } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ category: 'Mercearia', rev: 1 });

    // Outra aba, ainda na versão 0, mexe em outro campo: mescla.
    const merged = await context.app.inject({ method: 'PATCH', url: `${base(ws)}/products/${created.id}`, headers: h, payload: { rev: 0, changes: { supplier: 'Atacadão' }, base: { supplier: null } } });
    expect(merged.statusCode).toBe(200);
    expect(merged.json()).toMatchObject({ category: 'Mercearia', supplier: 'Atacadão', rev: 2 });

    // Preço alterado por duas pessoas a partir da mesma versão: conflito.
    await context.app.inject({ method: 'PATCH', url: `${base(ws)}/products/${created.id}`, headers: h, payload: { rev: 2, changes: { unitValue: 27 }, base: { unitValue: 25 } } });
    const conflict = await context.app.inject({ method: 'PATCH', url: `${base(ws)}/products/${created.id}`, headers: h, payload: { rev: 2, changes: { unitValue: 26 }, base: { unitValue: 25 } } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('SYNC_CONFLICT');
    expect(conflict.json().error.server.unitValue).toBe(27);
    // Na web o conflito é resolvido na hora, pela própria pessoa: a requisição
    // inteira é desfeita e nada fica pendente para decidir depois.
    const pending = await context.app.inject({ method: 'GET', url: `${base(ws)}/conflicts?status=pendente`, headers: { ...h, ...SYNC } });
    expect(pending.json().pending).toBe(0);
    const retried = await context.app.inject({ method: 'PATCH', url: `${base(ws)}/products/${created.id}`, headers: h, payload: { rev: 3, changes: { unitValue: 26 }, base: { unitValue: 27 } } });
    expect(retried.json()).toMatchObject({ unitValue: 26, rev: 4 });

    const adjusted = await context.app.inject({ method: 'PATCH', url: `${base(ws)}/products/${created.id}`, headers: h, payload: { rev: 4, quantity: { target: 17, note: 'Contagem' } } });
    expect(adjusted.statusCode).toBe(200);
    expect(adjusted.json().quantity).toBe(17);
    const history = await context.app.inject({ method: 'GET', url: `${base(ws)}/movements?direction=adjust`, headers: h });
    expect(history.json().items[0]).toMatchObject({ type: 'edicao', quantity: -3, note: 'Contagem', balanceAfter: 17 });

    const removed = await context.app.inject({ method: 'DELETE', url: `${base(ws)}/products/${created.id}`, headers: h });
    expect(removed.statusCode).toBe(200);
    expect((await context.app.inject({ method: 'GET', url: `${base(ws)}/products`, headers: h })).json().total).toBe(0);
    const restored = await context.app.inject({ method: 'POST', url: `${base(ws)}/products/${created.id}/restore`, headers: h });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().quantity).toBe(17);
  });

  it('aplica o plano: teto de produtos no gratuito, equipe só com assinatura e papéis sem permissão', async () => {
    const owner = await registerUser(context);
    const ws = await criarEmpresa(owner);
    await setLimit(2);
    try {
      for (const name of ['A', 'B']) {
        expect((await context.app.inject({ method: 'POST', url: `${base(ws)}/products`, headers: owner.authHeader, payload: { name } })).statusCode).toBe(201);
      }
      const third = await context.app.inject({ method: 'POST', url: `${base(ws)}/products`, headers: owner.authHeader, payload: { name: 'C' } });
      expect(third.statusCode).toBe(403);
      expect(third.json().error.code).toBe('PLAN_LIMIT_REACHED');
      const imported = await context.app.inject({ method: 'POST', url: `${base(ws)}/products/import`, headers: owner.authHeader, payload: { rows: [{ name: 'D' }, { name: 'E' }] } });
      expect(imported.statusCode).toBe(403);
    } finally {
      await setLimit(50);
    }

    const member = await registerUser(context);
    await context.services.db.insert(workspaceMembers).values({ workspaceId: ws, userId: member.userId, roleKey: 'consulta', status: 'active', invitedBy: owner.userId });
    const session = await loginUser(context, member.email, VALID_PASSWORD);
    const blocked = await context.app.inject({ method: 'GET', url: `${base(ws)}/products`, headers: session.authHeader });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('SUBSCRIPTION_REQUIRED');

    // Com o recurso de equipe ligado, o papel "consulta" lê mas não grava.
    await context.services.db.execute(sql`UPDATE plan_features SET enabled = true, limit_value = NULL WHERE plan_key = 'gratuito' AND feature_key = 'equipe.membros'`);
    try {
      expect((await context.app.inject({ method: 'GET', url: `${base(ws)}/products`, headers: session.authHeader })).statusCode).toBe(200);
      const write = await context.app.inject({ method: 'POST', url: `${base(ws)}/products`, headers: session.authHeader, payload: { name: 'Z' } });
      expect(write.statusCode).toBe(403);
      expect(write.json().error.code).toBe('MISSING_PERMISSION');
      const product = (await context.app.inject({ method: 'GET', url: `${base(ws)}/products`, headers: session.authHeader })).json().items[0];
      const movement = await context.app.inject({ method: 'POST', url: `${base(ws)}/movements`, headers: session.authHeader, payload: { productId: product.id, type: 'entrada', quantity: 1 } });
      expect(movement.statusCode).toBe(403);
    } finally {
      await context.services.db.execute(sql`UPDATE plan_features SET enabled = false, limit_value = 1 WHERE plan_key = 'gratuito' AND feature_key = 'equipe.membros'`);
    }

    // Outra empresa não enxerga nada desta.
    const stranger = await registerUser(context);
    const foreign = await context.app.inject({ method: 'GET', url: `${base(ws)}/products`, headers: stranger.authHeader });
    expect(foreign.statusCode).toBe(404);
  });

  it('importa planilha, ajusta em massa, desfaz e resume o estoque', async () => {
    const user = await registerUser(context);
    const ws = await criarEmpresa(user);
    const h = user.authHeader;

    const imported = await context.app.inject({
      method: 'POST',
      url: `${base(ws)}/products/import`,
      headers: h,
      payload: {
        rows: [
          { name: 'Feijão', quantity: 8, unitValue: 9, category: 'Grãos', sku: 'FJ-1', unit: 'un' },
          { name: 'Arroz', quantity: 5, unitValue: 20, category: 'Grãos', minStock: 6 },
          { name: 'Óleo', quantity: 0, unitValue: 7 },
          { quantity: 3 },
        ],
      },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ created: 3, updated: 0, errors: 1 });

    // Reimportar: casa por SKU e por nome; só o que mudou é tocado.
    const again = await context.app.inject({
      method: 'POST',
      url: `${base(ws)}/products/import`,
      headers: h,
      payload: { rows: [{ name: 'Feijão Carioca', sku: 'FJ-1', quantity: 10 }, { name: 'Arroz', quantity: 5, unitValue: 20 }] },
    });
    expect(again.json()).toMatchObject({ created: 0, updated: 1, unchanged: 1 });

    const all = (await context.app.inject({ method: 'GET', url: `${base(ws)}/products`, headers: h })).json().items as Array<{ id: string; name: string; quantity: number }>;
    expect(all.map((p) => [p.name, p.quantity])).toEqual([['Arroz', 5], ['Feijão Carioca', 10], ['Óleo', 0]]);

    const bulk = await context.app.inject({ method: 'POST', url: `${base(ws)}/products/bulk`, headers: h, payload: { productIds: all.map((p) => p.id), action: { type: 'adjust', delta: -6 } } });
    expect(bulk.json()).toMatchObject({ affected: 2 });
    const afterBulk = (await context.app.inject({ method: 'GET', url: `${base(ws)}/products`, headers: h })).json().items as Array<{ name: string; quantity: number }>;
    expect(afterBulk.map((p) => p.quantity)).toEqual([0, 4, 0]);

    const undo = await context.app.inject({ method: 'POST', url: `${base(ws)}/movements/bulk-cancel`, headers: h, payload: { movementIds: bulk.json().movementIds, note: 'Ajuste em massa desfeito' } });
    expect(undo.json()).toMatchObject({ cancelled: 2 });

    const category = await context.app.inject({ method: 'POST', url: `${base(ws)}/products/bulk`, headers: h, payload: { productIds: all.map((p) => p.id), action: { type: 'category', value: 'Mercearia' } } });
    expect(category.json().affected).toBe(3);

    const summary = (await context.app.inject({ method: 'GET', url: `${base(ws)}/reports/summary?period=30d`, headers: h })).json();
    expect(summary).toMatchObject({ products: 3, stockValue: 10 * 9 + 5 * 20, toRestock: 2, outOfStock: 1 });
    expect(summary.byCategory).toEqual([{ category: 'Mercearia', products: 3, quantity: 15, value: 190 }]);
    expect(summary.lowStock.map((p: { name: string }) => p.name).sort()).toEqual(['Arroz', 'Óleo']);

    const facets = (await context.app.inject({ method: 'GET', url: `${base(ws)}/products/facets`, headers: h })).json();
    expect(facets.categories).toEqual([{ value: 'Mercearia', count: 3 }]);

    const analysis = await context.app.inject({ method: 'GET', url: `${base(ws)}/reports/analysis`, headers: h });
    expect(analysis.statusCode).toBe(403);
    expect(analysis.json().error.code).toBe('SUBSCRIPTION_REQUIRED');
  });
});

describe('caixa de notificações', () => {
  it('resposta do suporte chega na caixa do usuário e pode ser marcada como lida', async () => {
    const user = await registerUser(context, { installId: 'instalacao-caixa-0001' });
    const ticket = await context.app.inject({
      method: 'POST',
      url: '/v1/support/tickets',
      headers: user.authHeader,
      payload: { installId: 'instalacao-caixa-0001', subject: 'Dúvida pela web', message: 'Como exporto?', device: { platform: 'web', model: 'Chrome 140', osVersion: 'macOS' } },
    });
    expect(ticket.statusCode).toBe(201);

    const { SupportService } = await import('../../src/modules/support/support.service.js');
    const { platformAdmins } = await import('../../src/platform/db/schema/index.js');
    const [admin] = await context.services.db.insert(platformAdmins).values({ email: uniqueEmail('adm'), name: 'Ana Suporte', passwordHash: 'x', role: 'support' }).returning();
    const support = new SupportService(context.services);
    await support.reply({ adminId: admin!.id, email: admin!.email, ipAddress: null }, ticket.json().id, 'Em Importar e exportar, toque em Exportar CSV.', false);

    const listed = await context.app.inject({ method: 'GET', url: '/v1/notifications', headers: user.authHeader });
    expect(listed.json()).toMatchObject({ unread: 1 });
    expect(listed.json().items[0]).toMatchObject({ type: 'support.reply', read: false, data: { ticketId: ticket.json().id } });

    const adminList = await support.list({ adminId: admin!.id, email: admin!.email, ipAddress: null }, { page: 1, pageSize: 10, platform: 'web' });
    expect(adminList.items[0]).toMatchObject({ platform: 'web', deviceSummary: 'Web · Chrome 140 · macOS' });

    // Outro usuário não vê nem marca a notificação alheia.
    const other = await registerUser(context);
    expect((await context.app.inject({ method: 'GET', url: '/v1/notifications', headers: other.authHeader })).json().items).toHaveLength(0);
    const foreignRead = await context.app.inject({ method: 'POST', url: `/v1/notifications/${listed.json().items[0].id}/read`, headers: other.authHeader });
    expect(foreignRead.statusCode).toBe(404);

    await context.app.inject({ method: 'POST', url: `/v1/notifications/${listed.json().items[0].id}/read`, headers: user.authHeader });
    const count = await context.app.inject({ method: 'GET', url: '/v1/notifications/unread-count', headers: user.authHeader });
    expect(count.json()).toEqual({ unread: 0 });
  });
});
