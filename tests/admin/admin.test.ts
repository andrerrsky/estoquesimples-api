import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { hashPassword } from '../../src/platform/auth/password.js';
import { createTestApp, registerUser, resetDatabase, type TestContext } from '../helpers/test-app.js';

const ADMIN_PASSWORD = 'PainelSeguro#2026';
const CSRF = { 'x-requested-with': 'estoquesimples-admin' };

let context: TestContext;

async function createAdmin(role: 'owner' | 'support' | 'viewer', email = `${role}.${randomUUID()}@exemplo.com.br`) {
  await context.services.db.insert(platformAdmins).values({
    email,
    name: `Admin ${role}`,
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role,
  });
  return email;
}

async function loginAdmin(email: string): Promise<{ cookie: string }> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/admin/api/auth/login',
    headers: CSRF,
    payload: { email, password: ADMIN_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(raw).toContain('HttpOnly');
  expect(raw).toContain('SameSite=Strict');
  return { cookie: (raw as string).split(';')[0] as string };
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

describe('painel administrativo: sessão', () => {
  it('recusa login sem o cabeçalho anti-CSRF', async () => {
    const email = await createAdmin('owner');
    const response = await context.app.inject({
      method: 'POST',
      url: '/admin/api/auth/login',
      payload: { email, password: ADMIN_PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });

  it('autentica, identifica e encerra a sessão', async () => {
    const email = await createAdmin('owner');
    const { cookie } = await loginAdmin(email);

    const me = await context.app.inject({ method: 'GET', url: '/admin/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email, role: 'owner' });

    const logout = await context.app.inject({
      method: 'POST',
      url: '/admin/api/auth/logout',
      headers: { cookie, ...CSRF },
    });
    expect(logout.statusCode).toBe(200);

    const after = await context.app.inject({ method: 'GET', url: '/admin/api/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('não aceita o Bearer do aplicativo', async () => {
    const user = await registerUser(context);
    const response = await context.app.inject({
      method: 'GET',
      url: '/admin/api/overview',
      headers: user.authHeader,
    });
    expect(response.statusCode).toBe(401);
  });

  it('bloqueia progressivamente após senhas erradas', async () => {
    const email = await createAdmin('support');
    for (let i = 0; i < 5; i += 1) {
      await context.app.inject({
        method: 'POST',
        url: '/admin/api/auth/login',
        headers: CSRF,
        payload: { email, password: 'errada-errada-errada' },
      });
    }
    const response = await context.app.inject({
      method: 'POST',
      url: '/admin/api/auth/login',
      headers: CSRF,
      payload: { email, password: ADMIN_PASSWORD },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('AUTH_ACCOUNT_LOCKED');
  });
});

describe('painel administrativo: papéis', () => {
  it('viewer lê mas não altera', async () => {
    const viewer = await createAdmin('viewer');
    const { cookie } = await loginAdmin(viewer);
    const user = await registerUser(context);

    const list = await context.app.inject({ method: 'GET', url: '/admin/api/users', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(1);

    const suspend = await context.app.inject({
      method: 'POST',
      url: `/admin/api/users/${user.userId}/suspend`,
      headers: { cookie, ...CSRF },
      payload: { reason: 'teste' },
    });
    expect(suspend.statusCode).toBe(403);
    expect(suspend.json().error.code).toBe('MISSING_PERMISSION');
  });

  it('somente owner administra outros administradores', async () => {
    const support = await createAdmin('support');
    const { cookie } = await loginAdmin(support);
    const response = await context.app.inject({ method: 'GET', url: '/admin/api/admins', headers: { cookie } });
    expect(response.statusCode).toBe(403);
  });
});

describe('painel administrativo: suporte a contas', () => {
  it('suspende a conta, derruba as sessões e registra nas duas trilhas', async () => {
    const support = await createAdmin('support');
    const { cookie } = await loginAdmin(support);
    const user = await registerUser(context, { installId: 'aparelho-teste-123' });

    const suspend = await context.app.inject({
      method: 'POST',
      url: `/admin/api/users/${user.userId}/suspend`,
      headers: { cookie, ...CSRF },
      payload: { reason: 'Uso indevido relatado' },
    });
    expect(suspend.statusCode).toBe(200);

    // O token do cliente deixa de valer imediatamente.
    const me = await context.app.inject({ method: 'GET', url: '/v1/me', headers: user.authHeader });
    expect(me.statusCode).toBe(401);

    const detail = await context.app.inject({
      method: 'GET',
      url: `/admin/api/users/${user.userId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().status).toBe('suspended');
    expect(detail.json().sessions).toHaveLength(0);

    const timeline = await context.app.inject({
      method: 'GET',
      url: `/admin/api/users/${user.userId}/timeline`,
      headers: { cookie },
    });
    const actions = timeline.json().items.map((item: { action: string; source: string }) => `${item.source}:${item.action}`);
    expect(actions).toContain('admin:user.suspended');
    expect(actions).toContain('user:user.registered');

    const adminAudit = await context.app.inject({
      method: 'GET',
      url: '/admin/api/audit/admins',
      headers: { cookie },
    });
    expect(adminAudit.json().items[0]).toMatchObject({
      action: 'user.suspended',
      adminEmail: support,
      targetId: user.userId,
      metadata: { reason: 'Uso indevido relatado' },
    });
  });

  it('exige motivo nas ações destrutivas', async () => {
    const support = await createAdmin('support');
    const { cookie } = await loginAdmin(support);
    const user = await registerUser(context);
    const response = await context.app.inject({
      method: 'POST',
      url: `/admin/api/users/${user.userId}/suspend`,
      headers: { cookie, ...CSRF },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('analytics', () => {
  it('aceita lote do app, deduplica e atribui ao usuário autenticado', async () => {
    const user = await registerUser(context, { installId: 'instalacao-analytics-1' });
    const eventId = randomUUID();
    const payload = {
      device: { installId: 'instalacao-analytics-1', platform: 'android', appVersionCode: 24 },
      events: [
        { id: eventId, name: 'app.opened', occurredAt: Date.now(), properties: { coldStart: true } },
        { id: randomUUID(), name: 'screen.viewed', occurredAt: Date.now(), properties: { screen: 'MainActivity' } },
      ],
    };

    const first = await context.app.inject({
      method: 'POST',
      url: '/v1/analytics/events',
      headers: user.authHeader,
      payload,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ accepted: 2, duplicated: 0, rejected: 0 });

    const again = await context.app.inject({
      method: 'POST',
      url: '/v1/analytics/events',
      headers: user.authHeader,
      payload,
    });
    expect(again.json()).toEqual({ accepted: 0, duplicated: 2, rejected: 0 });

    const owner = await createAdmin('owner');
    const { cookie } = await loginAdmin(owner);
    const events = await context.app.inject({
      method: 'GET',
      url: `/admin/api/users/${user.userId}/events`,
      headers: { cookie },
    });
    // Dois do app + user.registered emitido pela API.
    expect(events.json().total).toBe(3);

    const summary = await context.app.inject({
      method: 'GET',
      url: '/admin/api/analytics/summary?days=7',
      headers: { cookie },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().active.dau).toBe(1);
    expect(summary.json().topScreens[0]).toMatchObject({ screen: 'MainActivity', views: 1 });
  });

  it('não atribui evento a empresa da qual o usuário não participa', async () => {
    const user = await registerUser(context, { installId: 'instalacao-analytics-2' });
    const outro = await registerUser(context);
    const empresa = await context.app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: outro.authHeader,
      payload: { name: 'Empresa alheia' },
    });
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/analytics/events',
      headers: user.authHeader,
      payload: {
        device: { installId: 'instalacao-analytics-2' },
        events: [
          { id: randomUUID(), name: 'product.created', occurredAt: Date.now(), workspaceId: empresa.json().id },
        ],
      },
    });
    expect(response.statusCode).toBe(202);

    const owner = await createAdmin('owner');
    const { cookie } = await loginAdmin(owner);
    const events = await context.app.inject({
      method: 'GET',
      url: '/admin/api/analytics/events?name=product.created',
      headers: { cookie },
    });
    expect(events.json().items[0].workspaceId).toBeNull();
  });

  it('rejeita nome de evento fora do formato', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/analytics/events',
      payload: {
        device: { installId: 'instalacao-analytics-3' },
        events: [{ id: randomUUID(), name: 'Evento Inválido!', occurredAt: Date.now() }],
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('painel administrativo: visão geral e operação', () => {
  it('devolve o retrato com séries preenchidas', async () => {
    await registerUser(context);
    const owner = await createAdmin('owner');
    const { cookie } = await loginAdmin(owner);

    const overview = await context.app.inject({ method: 'GET', url: '/admin/api/overview', headers: { cookie } });
    expect(overview.statusCode).toBe(200);
    const body = overview.json();
    expect(body.kpis.usersTotal).toBe(1);
    expect(body.series.registrations.length).toBeGreaterThanOrEqual(30);
    expect(body.series.registrations.at(-1).v).toBe(1);

    const ops = await context.app.inject({ method: 'GET', url: '/admin/api/ops/status', headers: { cookie } });
    expect(ops.statusCode).toBe(200);
    expect(ops.json().sync.source).toBe('ambiente');

    const toggle = await context.app.inject({
      method: 'PUT',
      url: '/admin/api/ops/sync',
      headers: { cookie, ...CSRF },
      payload: { enabled: false, minAppVersionCode: 0, reason: 'incidente simulado' },
    });
    expect(toggle.statusCode).toBe(200);

    const config = await context.app.inject({ method: 'GET', url: '/v1/config' });
    expect(config.json().sync.enabled).toBe(false);
  });

  it('lista a auditoria das contas com filtros e junções', async () => {
    const user = await registerUser(context, { installId: 'aparelho-auditoria' });
    const owner = await createAdmin('owner');
    const { cookie } = await loginAdmin(owner);

    const all = await context.app.inject({ method: 'GET', url: '/admin/api/audit/users', headers: { cookie } });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBeGreaterThanOrEqual(1);
    expect(all.json().items[0]).toMatchObject({ action: 'user.registered', actorEmail: user.email });

    const filtered = await context.app.inject({
      method: 'GET',
      url: `/admin/api/audit/users?action=user.&q=${encodeURIComponent(user.email)}`,
      headers: { cookie },
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items.every((item: { action: string }) => item.action.startsWith('user.'))).toBe(true);

    const none = await context.app.inject({
      method: 'GET',
      url: '/admin/api/audit/users?action=workspace.deleted',
      headers: { cookie },
    });
    expect(none.json().total).toBe(0);
  });

  it('serve a interface em /admin com CSP', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/admin/usuarios' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-type']).toContain('text/html');
  });
});

describe('avaliações da Play Store', () => {
  it('coleta, lista, conta e responde pelo Google', async () => {
    const support = await createAdmin('support');
    const { cookie } = await loginAdmin(support);
    context.play.reviews.push(
      {
        reviewId: 'rev-1',
        authorName: 'Maria',
        comments: [{ userComment: { text: 'Ótimo app, mas o PDF não abre', starRating: 3, lastModified: { seconds: '1790000000' }, appVersionName: '24', reviewerLanguage: 'pt' } }],
      },
      {
        reviewId: 'rev-2',
        authorName: 'João',
        comments: [
          { userComment: { text: 'Perfeito', starRating: 5, lastModified: { seconds: '1790000100' } } },
          { developerComment: { text: 'Obrigado!', lastModified: { seconds: '1790000200' } } },
        ],
      },
    );

    const sync = await context.app.inject({ method: 'POST', url: '/admin/api/reviews/sync', headers: { cookie, ...CSRF } });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({ fetched: 2, created: 2 });

    const stats = await context.app.inject({ method: 'GET', url: '/admin/api/reviews/stats', headers: { cookie } });
    expect(stats.json()).toMatchObject({ total: 2, answered: 1, unanswered: 1, average: 4 });

    const pending = await context.app.inject({ method: 'GET', url: '/admin/api/reviews?status=unanswered', headers: { cookie } });
    expect(pending.json().total).toBe(1);
    expect(pending.json().items[0].reviewId).toBe('rev-1');

    const tooLong = await context.app.inject({
      method: 'POST',
      url: '/admin/api/reviews/rev-1/reply',
      headers: { cookie, ...CSRF },
      payload: { text: 'x'.repeat(351) },
    });
    expect(tooLong.statusCode).toBe(400);

    const reply = await context.app.inject({
      method: 'POST',
      url: '/admin/api/reviews/rev-1/reply',
      headers: { cookie, ...CSRF },
      payload: { text: 'Obrigado, Maria! Envie um e-mail para suporte@estoquesimples.com.br com o modelo do aparelho que a gente resolve.' },
    });
    expect(reply.statusCode).toBe(200);
    expect(context.play.replies).toHaveLength(1);

    const after = await context.app.inject({ method: 'GET', url: '/admin/api/reviews/stats', headers: { cookie } });
    expect(after.json()).toMatchObject({ answered: 2, unanswered: 0, answeredViaPanel: 1 });

    const audit = await context.app.inject({ method: 'GET', url: '/admin/api/audit/admins?action=review.replied', headers: { cookie } });
    expect(audit.json().items[0]).toMatchObject({ targetId: 'rev-1' });

    const draft = await context.app.inject({ method: 'POST', url: '/admin/api/reviews/rev-1/draft', headers: { cookie, ...CSRF }, payload: {} });
    expect(draft.statusCode).toBe(409);
  });

  it('só owner configura a chave da OpenAI e o formato é validado', async () => {
    const support = await createAdmin('support');
    const { cookie } = await loginAdmin(support);
    const forbidden = await context.app.inject({ method: 'PUT', url: '/admin/api/settings/openai', headers: { cookie, ...CSRF }, payload: { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' } });
    expect(forbidden.statusCode).toBe(403);

    const owner = await createAdmin('owner');
    const session = await loginAdmin(owner);
    const invalid = await context.app.inject({ method: 'PUT', url: '/admin/api/settings/openai', headers: { cookie: session.cookie, ...CSRF }, payload: { apiKey: 'nao-e-uma-chave-da-openai-mesmo' } });
    expect(invalid.statusCode).toBe(400);

    const status = await context.app.inject({ method: 'GET', url: '/admin/api/settings/openai', headers: { cookie: session.cookie } });
    expect(status.json().configured).toBe(false);
  });
});

describe('push notifications', () => {
  it('registra token, envia campanha, revoga token morto e mede entrega e abertura', async () => {
    const alice = await registerUser(context, { installId: 'instalacao-push-1' });
    const bob = await registerUser(context, { installId: 'instalacao-push-2' });

    const registerToken = (token: string, installId: string, auth?: Record<string, string>) =>
      context.app.inject({
        method: 'PUT',
        url: '/v1/push/tokens',
        headers: auth,
        payload: { token, installId, platform: 'android', appVersionCode: 24, notificationsEnabled: true },
      });
    expect((await registerToken('token-alice-velho-xxxxxxxxxxxx', 'instalacao-push-1', alice.authHeader)).statusCode).toBe(200);
    expect((await registerToken('token-alice-novo-xxxxxxxxxxxxx', 'instalacao-push-1', alice.authHeader)).statusCode).toBe(200);
    expect((await registerToken('token-bob-xxxxxxxxxxxxxxxxxxxxx', 'instalacao-push-2', bob.authHeader)).statusCode).toBe(200);
    expect((await registerToken('token-anonimo-xxxxxxxxxxxxxxxxx', 'instalacao-push-3')).statusCode).toBe(200);
    context.fcm.unregistered.add('token-bob-xxxxxxxxxxxxxxxxxxxxx');

    const support = await createAdmin('support');
    const { cookie } = await loginAdmin(support);

    const preview = await context.app.inject({
      method: 'POST',
      url: '/admin/api/push/audience/preview',
      headers: { cookie, ...CSRF },
      payload: { audience: { type: 'all' } },
    });
    // O token antigo da Alice foi substituído: 3 aparelhos alcançáveis.
    expect(preview.json()).toMatchObject({ total: 3, signedIn: 2 });

    const created = await context.app.inject({
      method: 'POST',
      url: '/admin/api/push/campaigns',
      headers: { cookie, ...CSRF },
      payload: { title: 'Novidade', body: 'Relatórios em PDF melhoraram.', action: { screen: 'reports' }, audience: { type: 'signed_in' } },
    });
    expect(created.statusCode).toBe(201);
    const campaignId = created.json().id as string;
    expect(created.json().targeted).toBe(2);

    const send = await context.app.inject({ method: 'POST', url: `/admin/api/push/campaigns/${campaignId}/send`, headers: { cookie, ...CSRF } });
    expect(send.statusCode).toBe(200);

    // O job roda fora da requisição; aqui executamos o envio diretamente.
    const { PushService } = await import('../../src/modules/push/push.service.js');
    const result = await new PushService(context.services).deliver(campaignId);
    expect(result).toEqual({ targeted: 2, accepted: 1, failed: 1 });
    expect(context.fcm.sent[0]).toMatchObject({ token: 'token-alice-novo-xxxxxxxxxxxxx', message: { title: 'Novidade', data: { type: 'campaign', screen: 'reports' } } });

    const delivered = await context.app.inject({
      method: 'POST',
      url: '/v1/push/events',
      payload: { campaignId, installId: 'instalacao-push-1', event: 'delivered' },
    });
    expect(delivered.json()).toEqual({ recorded: true });
    const opened = await context.app.inject({
      method: 'POST',
      url: '/v1/push/events',
      payload: { campaignId, installId: 'instalacao-push-1', event: 'opened' },
    });
    expect(opened.json()).toEqual({ recorded: true });
    const again = await context.app.inject({
      method: 'POST',
      url: '/v1/push/events',
      payload: { campaignId, installId: 'instalacao-push-1', event: 'opened' },
    });
    expect(again.json()).toEqual({ recorded: false });

    const detail = await context.app.inject({ method: 'GET', url: `/admin/api/push/campaigns/${campaignId}`, headers: { cookie } });
    expect(detail.json()).toMatchObject({ status: 'sent', targeted: 2, accepted: 1, failed: 1, delivered: 1, opened: 1 });
    expect(detail.json().failures[0]).toMatchObject({ error: 'unregistered', count: 1 });

    // O token do Bob foi revogado: a próxima prévia não o conta mais.
    const after = await context.app.inject({
      method: 'POST',
      url: '/admin/api/push/audience/preview',
      headers: { cookie, ...CSRF },
      payload: { audience: { type: 'all' } },
    });
    expect(after.json().total).toBe(2);

    const stats = await context.app.inject({ method: 'GET', url: '/admin/api/push/stats', headers: { cookie } });
    expect(stats.json()).toMatchObject({ campaignsSent: 1, accepted: 1, delivered: 1, opened: 1 });
  });

  it('teste para um e-mail envia na hora e exige aparelho registrado', async () => {
    const user = await registerUser(context, { installId: 'instalacao-push-9' });
    const support = await createAdmin('support');
    const { cookie } = await loginAdmin(support);

    const none = await context.app.inject({
      method: 'POST',
      url: '/admin/api/push/test',
      headers: { cookie, ...CSRF },
      payload: { title: 'Teste', body: 'Olá', audience: { type: 'all' }, email: user.email },
    });
    expect(none.statusCode).toBe(400);

    await context.app.inject({
      method: 'PUT',
      url: '/v1/push/tokens',
      headers: user.authHeader,
      payload: { token: 'token-teste-xxxxxxxxxxxxxxxxxxxx', installId: 'instalacao-push-9' },
    });
    const sent = await context.app.inject({
      method: 'POST',
      url: '/admin/api/push/test',
      headers: { cookie, ...CSRF },
      payload: { title: 'Teste', body: 'Olá', audience: { type: 'all' }, email: user.email },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ targeted: 1, accepted: 1 });

    const list = await context.app.inject({ method: 'GET', url: '/admin/api/push/campaigns', headers: { cookie } });
    expect(list.json().total).toBe(0);
    const withTests = await context.app.inject({ method: 'GET', url: '/admin/api/push/campaigns?includeTests=true', headers: { cookie } });
    expect(withTests.json().items[0]).toMatchObject({ isTest: true, status: 'sent' });
  });
});

describe('suporte pelo app', () => {
  const INSTALL = 'instalacao-suporte-0001';
  const device = { model: 'Galaxy A54', manufacturer: 'samsung', osVersion: '14', sdkInt: 34, appVersionCode: 25, appVersionName: '25', locale: 'pt-BR' };

  it('abre sem conta, recebe resposta por push, reabre ao escrever e passa a ser do usuário após login', async () => {
    context.fcm.sent.length = 0;
    await context.app.inject({
      method: 'PUT',
      url: '/v1/push/tokens',
      payload: { token: 'token-suporte-anonimo-xxxxxxxxxx', installId: INSTALL, platform: 'android', notificationsEnabled: true },
    });

    const created = await context.app.inject({
      method: 'POST',
      url: '/v1/support/tickets',
      payload: {
        installId: INSTALL,
        subject: 'Relatório em PDF não abre',
        message: 'Quando toco em gerar o PDF o app fecha.',
        category: 'problem',
        contactEmail: 'cliente@exemplo.com.br',
        device,
        diagnostics: { signedIn: false, products: 42, pendingOperations: 0 },
      },
    });
    expect(created.statusCode).toBe(201);
    const ticket = created.json();
    expect(ticket).toMatchObject({ status: 'open', category: 'problem', messageCount: 1, unread: false });
    expect(ticket.number).toBeGreaterThanOrEqual(1001);

    // Outra instalação não enxerga.
    const foreign = await context.app.inject({ method: 'GET', url: `/v1/support/tickets/${ticket.id}?installId=outra-instalacao-9999` });
    expect(foreign.statusCode).toBe(404);

    const viewer = await createAdmin('viewer');
    const viewerSession = await loginAdmin(viewer);
    const forbidden = await context.app.inject({
      method: 'POST',
      url: `/admin/api/support/tickets/${ticket.id}/messages`,
      headers: { cookie: viewerSession.cookie, ...CSRF },
      payload: { body: 'oi' },
    });
    expect(forbidden.statusCode).toBe(403);

    const support = await createAdmin('support');
    const { cookie } = await loginAdmin(support);

    const list = await context.app.inject({ method: 'GET', url: '/admin/api/support/tickets?status=open', headers: { cookie } });
    expect(list.json().total).toBe(1);
    expect(list.json().items[0]).toMatchObject({ number: ticket.number, unread: true, deviceSummary: 'samsung Galaxy A54 · Android 14 · app 25 (25)', userId: null, contactEmail: 'cliente@exemplo.com.br' });

    const detail = await context.app.inject({ method: 'GET', url: `/admin/api/support/tickets/${ticket.id}`, headers: { cookie } });
    expect(detail.json()).toMatchObject({ device: { model: 'Galaxy A54' }, diagnostics: { products: 42 }, reachableDevices: 1, user: null });
    expect(detail.json().messages).toHaveLength(1);

    const note = await context.app.inject({
      method: 'POST',
      url: `/admin/api/support/tickets/${ticket.id}/messages`,
      headers: { cookie, ...CSRF },
      payload: { body: 'Parece o bug do PDF na versão 25.', internal: true },
    });
    expect(note.statusCode).toBe(201);
    expect(context.fcm.sent).toHaveLength(0);

    const reply = await context.app.inject({
      method: 'POST',
      url: `/admin/api/support/tickets/${ticket.id}/messages`,
      headers: { cookie, ...CSRF },
      payload: { body: 'Olá! Atualize para a versão 26, que corrige o PDF.' },
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().ticket).toMatchObject({ status: 'answered', assignedToEmail: support });
    expect(reply.json().message).toMatchObject({ notifyStatus: 'push', internal: false });
    expect(context.fcm.sent).toHaveLength(1);
    expect(context.fcm.sent[0]).toMatchObject({
      token: 'token-suporte-anonimo-xxxxxxxxxx',
      message: { title: `Resposta do suporte · #${ticket.number}`, data: { type: 'support', ticketId: ticket.id, event: 'reply' } },
    });

    // O app vê a resposta (sem a nota interna) e marca como lida.
    const mine = await context.app.inject({ method: 'GET', url: `/v1/support/tickets?installId=${INSTALL}` });
    expect(mine.json().tickets[0]).toMatchObject({ status: 'answered', unread: true });
    const thread = await context.app.inject({ method: 'GET', url: `/v1/support/tickets/${ticket.id}?installId=${INSTALL}` });
    expect(thread.json().messages.map((m: { author: string }) => m.author)).toEqual(['user', 'support']);
    expect(thread.json().ticket.unread).toBe(false);

    const again = await context.app.inject({
      method: 'POST',
      url: `/v1/support/tickets/${ticket.id}/messages`,
      payload: { installId: INSTALL, message: 'Atualizei e funcionou, obrigado!' },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().ticket.status).toBe('open');

    const resolved = await context.app.inject({
      method: 'POST',
      url: `/admin/api/support/tickets/${ticket.id}/status`,
      headers: { cookie, ...CSRF },
      payload: { status: 'resolved', note: 'Resolvido com a atualização.' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ status: 'resolved', resolvedBy: 'admin' });
    expect(context.fcm.sent[1]?.message.data).toMatchObject({ type: 'support', event: 'resolved' });

    // Cria conta no mesmo aparelho: a solicitação anônima passa a ser dela.
    const user = await registerUser(context, { installId: INSTALL });
    const owned = await context.app.inject({ method: 'GET', url: `/v1/support/tickets?installId=${INSTALL}`, headers: user.authHeader });
    expect(owned.json().tickets).toHaveLength(1);
    const afterClaim = await context.app.inject({ method: 'GET', url: `/admin/api/support/tickets/${ticket.id}`, headers: { cookie } });
    expect(afterClaim.json().user).toMatchObject({ email: user.email });

    const stats = await context.app.inject({ method: 'GET', url: '/admin/api/support/stats', headers: { cookie } });
    expect(stats.json()).toMatchObject({ open: 0, answered: 0, resolved7d: 1, total: 1 });
    expect(stats.json().avgFirstResponseMinutes).not.toBeNull();
  });

  it('sem aparelho registrado avisa por e-mail; usuário pode encerrar e prioridade é ajustável', async () => {
    const user = await registerUser(context, { installId: 'instalacao-suporte-0002' });
    const created = await context.app.inject({
      method: 'POST',
      url: '/v1/support/tickets',
      headers: user.authHeader,
      payload: { installId: 'instalacao-suporte-0002', subject: 'Como convido alguém?', message: 'Quero adicionar um funcionário.', category: 'question', device },
    });
    expect(created.statusCode).toBe(201);
    const ticketId = created.json().id as string;

    const support = await createAdmin('support');
    const { cookie } = await loginAdmin(support);
    const patched = await context.app.inject({
      method: 'PATCH',
      url: `/admin/api/support/tickets/${ticketId}`,
      headers: { cookie, ...CSRF },
      payload: { priority: 'high', assign: 'me' },
    });
    expect(patched.json()).toMatchObject({ priority: 'high', assignedToEmail: support });

    const reply = await context.app.inject({
      method: 'POST',
      url: `/admin/api/support/tickets/${ticketId}/messages`,
      headers: { cookie, ...CSRF },
      payload: { body: 'Em Conta e sincronização > Equipe, toque em Convidar.' },
    });
    expect(reply.json().message.notifyStatus).toBe('email');
    const mail = context.mailer.lastOfKind('support_reply');
    expect(mail?.to).toBe(user.email);
    expect(mail?.text).toContain('Convidar');

    const done = await context.app.inject({ method: 'POST', url: `/v1/support/tickets/${ticketId}/resolve`, headers: user.authHeader, payload: { installId: 'instalacao-suporte-0002' } });
    expect(done.json()).toMatchObject({ status: 'resolved' });

    const filtered = await context.app.inject({ method: 'GET', url: '/admin/api/support/tickets?assigned=me&status=resolved', headers: { cookie } });
    expect(filtered.json().total).toBe(1);
    const search = await context.app.inject({ method: 'GET', url: `/admin/api/support/tickets?q=${encodeURIComponent('convido')}`, headers: { cookie } });
    expect(search.json().total).toBe(1);
  });
});
