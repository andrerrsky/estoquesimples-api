import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { platformAdmins, subscriptions } from '../../src/platform/db/schema/index.js';
import { hashPassword } from '../../src/platform/auth/password.js';
import { BillingService } from '../../src/modules/billing/billing.service.js';
import {
  createTestApp,
  registerUser,
  resetDatabase,
  type RegisteredUser,
  type TestContext,
} from '../helpers/test-app.js';

const ADMIN_PASSWORD = 'PainelSeguro#2026';
const CSRF = { 'x-requested-with': 'estoquesimples-admin' };

let context: TestContext;

async function createAdmin(role: 'owner' | 'support' | 'viewer') {
  const email = `${role}.${randomUUID()}@exemplo.com.br`;
  await context.services.db.insert(platformAdmins).values({
    email,
    name: `Admin ${role}`,
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role,
  });
  return email;
}

async function loginAdmin(email: string): Promise<string> {
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

/** Empresa recém-criada pelo app, sem assinatura nenhuma. */
async function criarEmpresa(user: RegisteredUser): Promise<string> {
  const created = await context.app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: user.authHeader,
    payload: { name: `Loja ${randomUUID().slice(0, 8)}` },
  });
  expect(created.statusCode).toBe(201);
  return created.json().id;
}

async function darCortesia(
  cookie: string,
  workspaceId: string,
  payload: Record<string, unknown> = { days: 30, reason: 'Falha de sincronização no primeiro dia' },
) {
  return context.app.inject({
    method: 'POST',
    url: `/admin/api/workspaces/${workspaceId}/courtesies`,
    headers: { cookie, ...CSRF },
    payload,
  });
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

describe('dias de cortesia', () => {
  it('empresa sem assinatura passa a ter acesso, com o plano prometido', async () => {
    const admin = await loginAdmin(await createAdmin('support'));
    const user = await registerUser(context);
    const workspaceId = await criarEmpresa(user);

    const antes = await new BillingService(context.services).getEntitlement(workspaceId);
    expect(antes.planKey).toBe('gratuito');
    expect(antes.courtesyUntil).toBeNull();

    const resposta = await darCortesia(admin, workspaceId);
    expect(resposta.statusCode).toBe(200);

    const depois = await new BillingService(context.services).getEntitlement(workspaceId);
    expect(depois.active).toBe(true);
    expect(depois.planKey).toBe('basico');
    expect(depois.state).toBe('cortesia');
    // Sem assinatura, é a cortesia que responde "até quando isto vale".
    expect(depois.currentPeriodEnd).toBe(depois.courtesyUntil);

    const dias = (new Date(depois.courtesyUntil as string).getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(29.9);
    expect(dias).toBeLessThan(30.1);
  });

  it('soma ao fim do período pago em vez de se sobrepor a ele', async () => {
    const admin = await loginAdmin(await createAdmin('support'));
    const user = await registerUser(context);
    const workspaceId = await criarEmpresa(user);

    // Assinatura anual já paga: a cortesia tem de começar onde ela termina,
    // senão "30 dias a mais" não daria dia nenhum a quem está em dia.
    const fimDoPlano = new Date(Date.now() + 300 * 86_400_000);
    await context.services.db.insert(subscriptions).values({
      workspaceId,
      planKey: 'basico',
      provider: 'asaas',
      providerSubscriptionId: `sub_${randomUUID()}`,
      providerCustomerId: `cus_${randomUUID()}`,
      state: 'ativa',
      autoRenewing: true,
      currentPeriodEnd: fimDoPlano,
    });

    const resposta = await darCortesia(admin, workspaceId);
    const { startsAt, endsAt } = resposta.json();
    expect(new Date(startsAt).getTime()).toBe(fimDoPlano.getTime());
    expect(new Date(endsAt).getTime()).toBe(fimDoPlano.getTime() + 30 * 86_400_000);

    // Enquanto a assinatura vale, ela continua mandando no retrato.
    const direitos = await new BillingService(context.services).getEntitlement(workspaceId);
    expect(direitos.state).toBe('ativa');
    expect(direitos.currentPeriodEnd).toBe(fimDoPlano.toISOString());
    expect(direitos.courtesyUntil).toBe(new Date(endsAt).toISOString());
  });

  it('duas concessões somam: a segunda começa onde a primeira termina', async () => {
    const admin = await loginAdmin(await createAdmin('support'));
    const user = await registerUser(context);
    const workspaceId = await criarEmpresa(user);

    const primeira = await darCortesia(admin, workspaceId, { days: 30, reason: 'Pelo transtorno' });
    const segunda = await darCortesia(admin, workspaceId, { days: 30, reason: 'Por ter ficado' });

    expect(new Date(segunda.json().startsAt).getTime()).toBe(new Date(primeira.json().endsAt).getTime());

    const direitos = await new BillingService(context.services).getEntitlement(workspaceId);
    const dias = (new Date(direitos.courtesyUntil as string).getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(59.9);
  });

  it('a cortesia vencida não dá acesso', async () => {
    const admin = await loginAdmin(await createAdmin('support'));
    const user = await registerUser(context);
    const workspaceId = await criarEmpresa(user);

    await darCortesia(admin, workspaceId, { days: 1, reason: 'Teste de prazo' });

    // Empurra o fim para trás, como se o dia já tivesse passado.
    await context.services.db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import('drizzle-orm')).sql`UPDATE courtesy_grants SET starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' WHERE workspace_id = ${workspaceId}`,
    );

    const direitos = await new BillingService(context.services).getEntitlement(workspaceId);
    expect(direitos.active).toBe(false);
    expect(direitos.planKey).toBe('gratuito');
    expect(direitos.courtesyUntil).toBeNull();
  });

  it('revogar devolve a empresa ao que ela era, e a linha fica no histórico', async () => {
    const admin = await loginAdmin(await createAdmin('support'));
    const user = await registerUser(context);
    const workspaceId = await criarEmpresa(user);

    await darCortesia(admin, workspaceId);
    const lista = await context.app.inject({
      method: 'GET',
      url: `/admin/api/workspaces/${workspaceId}/courtesies`,
      headers: { cookie: admin },
    });
    expect(lista.statusCode).toBe(200);
    const grant = lista.json().items[0];
    expect(grant).toMatchObject({ days: 30, planKey: 'basico', active: true });

    const revogada = await context.app.inject({
      method: 'POST',
      url: `/admin/api/workspaces/${workspaceId}/courtesies/${grant.id}/revoke`,
      headers: { cookie: admin, ...CSRF },
      payload: { reason: 'Dada na empresa errada' },
    });
    expect(revogada.statusCode).toBe(200);

    const direitos = await new BillingService(context.services).getEntitlement(workspaceId);
    expect(direitos.active).toBe(false);
    expect(direitos.courtesyUntil).toBeNull();

    const depois = await context.app.inject({
      method: 'GET',
      url: `/admin/api/workspaces/${workspaceId}/courtesies`,
      headers: { cookie: admin },
    });
    expect(depois.json().items[0]).toMatchObject({ id: grant.id, active: false });
    expect(depois.json().items[0].revokedAt).not.toBeNull();

    // Revogar duas vezes é conflito, não um segundo desconto.
    const denovo = await context.app.inject({
      method: 'POST',
      url: `/admin/api/workspaces/${workspaceId}/courtesies/${grant.id}/revoke`,
      headers: { cookie: admin, ...CSRF },
      payload: { reason: 'Repetindo' },
    });
    expect(denovo.statusCode).toBe(409);
  });

  it('a concessão fica na trilha de auditoria do painel', async () => {
    const email = await createAdmin('support');
    const admin = await loginAdmin(email);
    const user = await registerUser(context);
    const workspaceId = await criarEmpresa(user);

    await darCortesia(admin, workspaceId, { days: 15, reason: 'Compensação pelo saldo divergente' });

    const trilha = await context.app.inject({
      method: 'GET',
      url: '/admin/api/audit/admins',
      headers: { cookie: admin },
    });
    expect(trilha.statusCode).toBe(200);
    expect(trilha.json().items[0]).toMatchObject({
      action: 'workspace.courtesy_granted',
      adminEmail: email,
      targetId: workspaceId,
      metadata: { days: 15, planKey: 'basico', reason: 'Compensação pelo saldo divergente' },
    });
  });

  it('quem só lê não pode dar cortesia, e o motivo é obrigatório', async () => {
    const viewer = await loginAdmin(await createAdmin('viewer'));
    const support = await loginAdmin(await createAdmin('support'));
    const user = await registerUser(context);
    const workspaceId = await criarEmpresa(user);

    expect((await darCortesia(viewer, workspaceId)).statusCode).toBe(403);
    expect((await darCortesia(support, workspaceId, { days: 30 })).statusCode).toBe(400);
    // Um ano é o teto: acima disso não é cortesia, é plano dado de graça.
    expect((await darCortesia(support, workspaceId, { days: 400, reason: 'Exagero' })).statusCode).toBe(400);
    expect((await darCortesia(support, workspaceId, { days: 0, reason: 'Nada' })).statusCode).toBe(400);
  });

  it('empresa excluída não recebe cortesia', async () => {
    const admin = await loginAdmin(await createAdmin('support'));
    const user = await registerUser(context);
    const workspaceId = await criarEmpresa(user);

    const excluida = await context.app.inject({
      method: 'POST',
      url: `/admin/api/workspaces/${workspaceId}/delete`,
      headers: { cookie: admin, ...CSRF },
      payload: { reason: 'Encerrada a pedido' },
    });
    expect(excluida.statusCode).toBe(200);

    expect((await darCortesia(admin, workspaceId)).statusCode).toBe(409);
  });

  it('a cortesia não mexe na assinatura, que é espelho do provedor', async () => {
    const admin = await loginAdmin(await createAdmin('support'));
    const user = await registerUser(context);
    const workspaceId = await criarEmpresa(user);

    const fimDoPlano = new Date(Date.now() + 10 * 86_400_000);
    await context.services.db.insert(subscriptions).values({
      workspaceId,
      planKey: 'basico',
      provider: 'google_play',
      purchaseTokenHash: randomUUID(),
      purchaseTokenEnc: 'v1:teste',
      googleProductId: 'assinatura',
      state: 'ativa',
      autoRenewing: true,
      currentPeriodEnd: fimDoPlano,
    });

    await darCortesia(admin, workspaceId);

    const [assinatura] = await context.services.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId));
    expect(assinatura?.currentPeriodEnd?.toISOString()).toBe(fimDoPlano.toISOString());
    expect(assinatura?.state).toBe('ativa');
  });
});
