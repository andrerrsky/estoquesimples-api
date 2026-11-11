import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { hashPassword } from '../../src/platform/auth/password.js';
import { createTestApp, registerUser, resetDatabase, type TestContext } from '../helpers/test-app.js';

const ADMIN_PASSWORD = 'PainelSeguro#2026';
const CSRF = { 'x-requested-with': 'estoquesimples-admin' };
const DAY = 86_400_000;

let context: TestContext;

async function login(role: 'owner' | 'support' | 'viewer'): Promise<Record<string, string>> {
  const email = `${role}.${randomUUID()}@exemplo.com.br`;
  await context.services.db.insert(platformAdmins).values({ email, name: `Admin ${role}`, passwordHash: await hashPassword(ADMIN_PASSWORD), role });
  const response = await context.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: CSRF, payload: { email, password: ADMIN_PASSWORD } });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)!.split(';')[0]!;
  return { cookie, ...CSRF };
}

async function cleanCoupons(): Promise<void> {
  await context.services.db.execute(sql`DELETE FROM coupons WHERE code <> 'BF26'`);
  await context.services.db.execute(sql`UPDATE coupons SET active = true WHERE code = 'BF26'`);
}

async function createCoupon(code: string, startOffsetMs: number, endOffsetMs: number): Promise<string> {
  const now = Date.now();
  const rows = await context.services.db.execute<{ id: string }>(sql`
    INSERT INTO coupons (code, label, starts_at, ends_at, yearly_price_cents, monthly_first_cents, monthly_promo_cycles)
    VALUES (${code}, 'Teste', ${new Date(now + startOffsetMs)}, ${new Date(now + endOffsetMs)}, 11990, 1249, 1)
    RETURNING id
  `);
  return rows.rows[0]!.id;
}

async function auditRows(action: string) {
  return (
    await context.services.db.execute<{ target_id: string; metadata: Record<string, unknown> }>(
      sql`SELECT target_id, metadata FROM admin_audit_log WHERE action = ${action} ORDER BY created_at`,
    )
  ).rows;
}

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await resetDatabase(context);
  await cleanCoupons();
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
  await cleanCoupons();
  context.asaas.reset();
  // Preço cheio da migration 0033: outros arquivos mexem nos preços do plano.
  await context.services.db.execute(
    sql`UPDATE plans SET is_active = true, web_price_monthly_cents = 2499, web_price_semiannual_cents = 12990, web_price_yearly_cents = 19990 WHERE key = 'basico'`,
  );
});

describe('painel: cupons (leitura)', () => {
  it('lista cupons com situação, preços e números; detalhe e resgates sem documento nem hash', async () => {
    const viewer = await login('viewer');
    const live = await createCoupon('NOAR26', -DAY, 10 * DAY);
    await createCoupon('VELHO26', -10 * DAY, -DAY);
    const off = await createCoupon('DESLIG26', -DAY, 10 * DAY);
    await context.services.db.execute(sql`UPDATE coupons SET active = false WHERE id = ${off}`);

    // Dois resgates: um pago, um só reservado.
    const owner = await registerUser(context);
    const ws1 = (await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: owner.authHeader, payload: { name: 'Loja Um' } })).json().id;
    const ws2 = (await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: owner.authHeader, payload: { name: 'Loja Dois' } })).json().id;
    const hash1 = createHash('sha256').update('52998224725').digest('hex');
    const hash2 = createHash('sha256').update('11144477735').digest('hex');
    await context.services.db.execute(sql`
      INSERT INTO coupon_redemptions (coupon_id, workspace_id, document_hash, state, cycle, value_cents, redeemed_at)
      VALUES (${live}, ${ws1}, ${hash1}, 'resgatado', 'YEARLY', 11990, now()),
             (${live}, ${ws2}, ${hash2}, 'reservado', 'MONTHLY', 1249, NULL)
    `);

    const list = await context.app.inject({ method: 'GET', url: '/admin/api/coupons', headers: viewer });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body).toMatchObject({ page: 1, total: 4, fullPricing: { monthlyCents: 2499, yearlyCents: 19990 } });
    const byCode = Object.fromEntries(body.items.map((item: { code: string }) => [item.code, item]));
    // Antes de 20/11/2026 o BF26 está agendado.
    if (Date.now() < Date.parse('2026-11-20T03:00:00Z')) expect(byCode['BF26'].status).toBe('agendado');
    expect(byCode['NOAR26']).toMatchObject({ status: 'no_ar', reserved: 1, redeemed: 1, redeemedRevenueCents: 11990, yearlyPriceCents: 11990, monthlyFirstCents: 1249 });
    expect(byCode['VELHO26'].status).toBe('encerrado');
    expect(byCode['DESLIG26'].status).toBe('desativado');

    const detail = await context.app.inject({ method: 'GET', url: `/admin/api/coupons/${live}`, headers: viewer });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ code: 'NOAR26', status: 'no_ar', redeemed: 1 });

    const redemptions = await context.app.inject({ method: 'GET', url: `/admin/api/coupons/${live}/redemptions`, headers: viewer });
    expect(redemptions.statusCode).toBe(200);
    expect(redemptions.json().total).toBe(2);
    const items = redemptions.json().items;
    expect(items.map((item: { workspaceName: string; state: string }) => [item.workspaceName, item.state]).sort()).toEqual([
      ['Loja Dois', 'reservado'],
      ['Loja Um', 'resgatado'],
    ]);
    const text = redemptions.body;
    expect(text).not.toContain(hash1);
    expect(text).not.toContain(hash2);
    expect(text).not.toContain('documentHash');
    expect(text).not.toContain('52998224725');

    const onlyRedeemed = await context.app.inject({ method: 'GET', url: `/admin/api/coupons/${live}/redemptions?state=resgatado`, headers: viewer });
    expect(onlyRedeemed.json().total).toBe(1);

    const missing = await context.app.inject({ method: 'GET', url: `/admin/api/coupons/${randomUUID()}`, headers: viewer });
    expect(missing.statusCode).toBe(404);
  });
});

describe('painel: cupons (ações)', () => {
  it('desativar e ativar exigem owner e motivo, gravam auditoria; desativado some de /public/promo e o checkout recusa', async () => {
    const id = await createCoupon('FREIO26', -DAY, 10 * DAY);
    const owner = await login('owner');
    const support = await login('support');

    // Papel insuficiente.
    const denied = await context.app.inject({ method: 'POST', url: `/admin/api/coupons/${id}/deactivate`, headers: support, payload: { reason: 'freio de emergência' } });
    expect(denied.statusCode).toBe(403);
    // Sem motivo.
    const noReason = await context.app.inject({ method: 'POST', url: `/admin/api/coupons/${id}/deactivate`, headers: owner, payload: {} });
    expect(noReason.statusCode).toBe(400);

    expect((await context.app.inject({ method: 'GET', url: '/v1/public/promo' })).json()).toMatchObject({ active: true, code: 'FREIO26' });

    const off = await context.app.inject({ method: 'POST', url: `/admin/api/coupons/${id}/deactivate`, headers: owner, payload: { reason: 'preço errado no anúncio' } });
    expect(off.statusCode).toBe(200);
    expect(await auditRows('coupon.deactivated')).toEqual([{ target_id: id, metadata: { code: 'FREIO26', reason: 'preço errado no anúncio' } }]);

    // Some da campanha em destaque (BF26 é a próxima, então ela aparece como upcoming).
    const promo = (await context.app.inject({ method: 'GET', url: '/v1/public/promo' })).json();
    expect(promo.code).not.toBe('FREIO26');
    expect(promo.active).toBe(false);

    // O checkout recusa o cupom desativado.
    const user = await registerUser(context);
    const ws = (await context.app.inject({ method: 'POST', url: '/v1/workspaces', headers: user.authHeader, payload: { name: 'Loja do Freio' } })).json().id;
    const checkout = await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/billing/web/checkout`,
      headers: user.authHeader,
      payload: { name: 'Maria da Silva', cpfCnpj: '529.982.247-25', email: 'maria@exemplo.com.br', cycle: 'YEARLY', billingType: 'PIX', coupon: 'freio26' },
    });
    expect(checkout.statusCode).toBe(409);
    expect(checkout.json().error).toMatchObject({ code: 'CONFLICT', couponReason: 'invalido' });
    expect(context.asaas.subscriptions.size).toBe(0);

    // Desativar de novo: conflito, sem nova linha de auditoria.
    expect((await context.app.inject({ method: 'POST', url: `/admin/api/coupons/${id}/deactivate`, headers: owner, payload: { reason: 'de novo' } })).statusCode).toBe(409);
    expect(await auditRows('coupon.deactivated')).toHaveLength(1);

    const on = await context.app.inject({ method: 'POST', url: `/admin/api/coupons/${id}/activate`, headers: owner, payload: { reason: 'anúncio corrigido' } });
    expect(on.statusCode).toBe(200);
    expect(await auditRows('coupon.activated')).toHaveLength(1);
    expect((await context.app.inject({ method: 'GET', url: '/v1/public/promo' })).json()).toMatchObject({ active: true, code: 'FREIO26' });
  });

  it('muda a vigência: fim depois do início; início só enquanto agendado; auditado com de/para', async () => {
    const owner = await login('owner');
    const viewer = await login('viewer');
    const scheduled = await createCoupon('AGENDA26', 2 * DAY, 10 * DAY);
    const live = await createCoupon('VIVO26', -DAY, 10 * DAY);
    const patch = (id: string, headers: Record<string, string>, payload: Record<string, unknown>) =>
      context.app.inject({ method: 'PATCH', url: `/admin/api/coupons/${id}`, headers, payload });

    expect((await patch(scheduled, viewer, { endsAt: new Date(Date.now() + 20 * DAY).toISOString(), reason: 'prorrogar' })).statusCode).toBe(403);

    // Fim antes do início.
    const before = await patch(scheduled, owner, { endsAt: new Date(Date.now() + DAY).toISOString(), reason: 'teste' });
    expect(before.statusCode).toBe(400);
    expect(before.json().error.message).toMatch(/depois do início/);

    // Início de um cupom agendado: pode (com fuso de Brasília explícito).
    const ok = await patch(scheduled, owner, { startsAt: '2030-01-01T00:00:00-03:00', endsAt: '2030-01-31T23:59:59-03:00', reason: 'adiada para janeiro' });
    expect(ok.statusCode).toBe(200);
    const detail = (await context.app.inject({ method: 'GET', url: `/admin/api/coupons/${scheduled}`, headers: viewer })).json();
    expect(detail).toMatchObject({ startsAt: '2030-01-01T03:00:00.000Z', endsAt: '2030-02-01T02:59:59.000Z', status: 'agendado' });
    const audit = await auditRows('coupon.period_changed');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ code: 'AGENDA26', reason: 'adiada para janeiro', changes: { startsAt: { to: '2030-01-01T03:00:00.000Z' }, endsAt: { to: '2030-02-01T02:59:59.000Z' } } });

    // Início de um cupom no ar: não pode.
    const started = await patch(live, owner, { startsAt: new Date(Date.now() + DAY).toISOString(), reason: 'teste' });
    expect(started.statusCode).toBe(400);
    expect(started.json().error.message).toMatch(/não começou/);

    // Encerrar antes: o fim vai para o passado (mas depois do início) e o cupom fica encerrado.
    const end = await patch(live, owner, { endsAt: new Date(Date.now() - 60_000).toISOString(), reason: 'meta batida' });
    expect(end.statusCode).toBe(200);
    expect((await context.app.inject({ method: 'GET', url: `/admin/api/coupons/${live}`, headers: viewer })).json().status).toBe('encerrado');

    // Sem mudança: recusa.
    expect((await patch(live, owner, { reason: 'nada' })).statusCode).toBe(400);
    // Preço não é editável (corpo estrito).
    expect((await patch(live, owner, { yearlyPriceCents: 9990, reason: 'baixar' })).statusCode).toBe(400);
  });

  it('cria cupom: código, preços abaixo do cheio e ≥ R$ 5,00, único; só owner', async () => {
    const owner = await login('owner');
    const support = await login('support');
    const base = {
      code: 'natal26',
      label: 'Natal',
      startsAt: '2026-12-20T00:00:00-03:00',
      endsAt: '2026-12-26T23:59:59-03:00',
      yearlyPriceCents: 14990,
      monthlyFirstCents: 1490,
      monthlyPromoCycles: 2,
      reason: 'campanha de Natal aprovada',
    };
    const create = (headers: Record<string, string>, payload: Record<string, unknown>) =>
      context.app.inject({ method: 'POST', url: '/admin/api/coupons', headers, payload });

    expect((await create(support, base)).statusCode).toBe(403);

    for (const [payload, message] of [
      [{ ...base, code: 'NA' }, /4 a 32/],
      [{ ...base, code: 'NATAL-26' }, /4 a 32/],
      [{ ...base, yearlyPriceCents: 19990 }, /menor que o preço cheio/],
      [{ ...base, monthlyFirstCents: 400 }, /./],
      [{ ...base, endsAt: '2026-12-19T23:59:59-03:00' }, /depois do início/],
      [{ ...base, yearlyPriceCents: null, monthlyFirstCents: null }, /anual, o do 1º mês/],
    ] as const) {
      const response = await create(owner, payload);
      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(response.json().error)).toMatch(message);
    }

    const created = await create(owner, base);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ code: 'NATAL26', status: 'agendado', startsAt: '2026-12-20T03:00:00.000Z', monthlyPromoCycles: 2, reserved: 0 });
    expect(await auditRows('coupon.created')).toHaveLength(1);

    const duplicate = await create(owner, base);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.message).toMatch(/Já existe/);
  });
});
