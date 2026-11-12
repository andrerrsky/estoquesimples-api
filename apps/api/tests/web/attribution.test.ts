import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../../src/platform/auth/password.js';
import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { adsConversionTime, offlineConversionsCsv } from '../../src/modules/auth/signup-attribution.js';
import { createTestApp, resetDatabase, uniqueEmail, VALID_PASSWORD, type TestContext } from '../helpers/test-app.js';

const WEB = { host: 'web.test', 'x-requested-with': 'estoquesimples-web' };
const ADMIN_PASSWORD = 'PainelSeguro#2026';
const ADMIN_CSRF = { 'x-requested-with': 'estoquesimples-admin' };

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

async function register(attribution?: Record<string, string>, name = 'Pessoa Anúncio') {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/auth/web/register',
    headers: WEB,
    payload: { email: uniqueEmail('origem'), password: VALID_PASSWORD, name, ...(attribution ? { attribution } : {}) },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { id: body.user.id as string, authHeader: { authorization: `Bearer ${body.accessToken}` } };
}

async function storedAttribution(userId: string): Promise<Record<string, string> | null> {
  const rows = await context.services.db.execute<{ a: Record<string, string> | null }>(sql`SELECT signup_attribution AS a FROM users WHERE id = ${userId}`);
  return rows.rows[0]?.a ?? null;
}

async function ownerCookie(): Promise<string> {
  const email = `owner.${randomUUID()}@exemplo.com.br`;
  await context.services.db.insert(platformAdmins).values({ email, name: 'Dono', passwordHash: await hashPassword(ADMIN_PASSWORD), role: 'owner' });
  const response = await context.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: ADMIN_CSRF, payload: { email, password: ADMIN_PASSWORD } });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';
}

describe('origem do cadastro web', () => {
  it('grava UTMs, clique e escolha de cookies; o evento leva as UTMs e nunca o gclid', async () => {
    const user = await register({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'pesquisa_estoque',
      utm_content: 'salao',
      gclid: 'Cj0KCQ-teste_123',
      landing: '/',
      consent: 'v2_accepted',
    });
    const stored = await storedAttribution(user.id);
    expect(stored).toMatchObject({ utm_source: 'google', utm_campaign: 'pesquisa_estoque', gclid: 'Cj0KCQ-teste_123', consent: 'v2_accepted', landing: '/' });
    expect(stored?.at).toBeTruthy();

    const events = await context.services.db.execute<{ properties: Record<string, unknown> }>(
      sql`SELECT properties FROM analytics_events WHERE name = 'user.registered' AND user_id = ${user.id}`,
    );
    const props = events.rows[0]?.properties ?? {};
    expect(props).toMatchObject({ origin: 'direto', utm_campaign: 'pesquisa_estoque', utm_content: 'salao', has_click_id: true });
    expect(JSON.stringify(props)).not.toContain('Cj0KCQ');
  });

  it('visita sem campanha não grava nada; valores com e-mail ou fora do formato são recusados', async () => {
    const direct = await register({ consent: 'refused' });
    expect(await storedAttribution(direct.id)).toBeNull();

    for (const attribution of [{ utm_source: 'fulano@exemplo.com' }, { gclid: 'abc def' }, { landing: 'https://outro.site/' }, { email: 'x' }]) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/auth/web/register',
        headers: WEB,
        payload: { email: uniqueEmail('ruim'), password: VALID_PASSWORD, name: 'Ruim', attribution },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('a escolha de cookies feita depois do cadastro atualiza a origem (e só de quem tem origem)', async () => {
    const user = await register({ utm_source: 'google', gclid: 'G-1', consent: 'v2_accepted' });
    const put = await context.app.inject({ method: 'PUT', url: '/v1/me/cookie-consent', headers: user.authHeader, payload: { consent: 'refused' } });
    expect(put.statusCode).toBe(200);
    expect((await storedAttribution(user.id))?.consent).toBe('refused');

    const direct = await register();
    await context.app.inject({ method: 'PUT', url: '/v1/me/cookie-consent', headers: direct.authHeader, payload: { consent: 'v2_accepted' } });
    expect(await storedAttribution(direct.id)).toBeNull();
  });
});

describe('origem da instalação no app Android', () => {
  it('o cadastro do app grava o Install Referrer da Play, sem enviar o clique a ninguém', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: uniqueEmail('play'),
        password: VALID_PASSWORD,
        name: 'Pessoa Play',
        attribution: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'app_instalacoes', gclid: 'EAIaIQ-play_1' },
      },
    });
    expect(response.statusCode).toBe(201);
    const stored = await storedAttribution(response.json().user.id);
    expect(stored).toMatchObject({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'app_instalacoes', gclid: 'EAIaIQ-play_1', consent: 'none' });
  });

  it('instalação orgânica da loja também fica registrada; sem atribuição o cadastro segue como antes', async () => {
    const organic = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: uniqueEmail('organico'), password: VALID_PASSWORD, name: 'Orgânico', attribution: { utm_source: 'google-play', utm_medium: 'organic' } },
    });
    expect(organic.statusCode).toBe(201);
    expect(await storedAttribution(organic.json().user.id)).toMatchObject({ utm_source: 'google-play', utm_medium: 'organic' });

    const plain = await context.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: uniqueEmail('sem'), password: VALID_PASSWORD, name: 'Sem origem' } });
    expect(plain.statusCode).toBe(201);
    expect(await storedAttribution(plain.json().user.id)).toBeNull();

    const bad = await context.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: uniqueEmail('ruim'), password: VALID_PASSWORD, name: 'Ruim', attribution: { referrer: 'x' } } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('primeiros passos na web', () => {
  it('cria a empresa no cadastro web (o do app não)', async () => {
    const user = await register();
    const list = await context.app.inject({ method: 'GET', url: '/v1/workspaces', headers: user.authHeader });
    expect(list.statusCode).toBe(200);
    const items = list.json().workspaces ?? list.json();
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Minha empresa');

    const app = await context.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: uniqueEmail('app'), password: VALID_PASSWORD, name: 'App' } });
    expect(app.statusCode).toBe(201);
    const appList = await context.app.inject({ method: 'GET', url: '/v1/workspaces', headers: { authorization: `Bearer ${app.json().accessToken}` } });
    expect(appList.json().workspaces ?? appList.json()).toHaveLength(0);
  });

});

describe('exportação de ativações para o Google Ads', () => {
  it('só contas com gclid, aceite v2 e primeiro produto há mais de 6 horas; horário do produto em Brasília', async () => {
    const make = async (consent: string, gclid: string, hoursAgo: number | null) => {
      const user = await register({ utm_source: 'google', gclid, consent });
      if (hoursAgo !== null) {
        const ws = (await context.app.inject({ method: 'GET', url: '/v1/workspaces', headers: user.authHeader })).json();
        const wsId = (ws.workspaces ?? ws)[0].id;
        await context.app.inject({ method: 'POST', url: `/v1/workspaces/${wsId}/products`, headers: user.authHeader, payload: { name: 'Item', quantity: 1 } });
        await context.services.db.execute(sql`UPDATE products SET created_at = now() - make_interval(hours => ${hoursAgo}) WHERE workspace_id = ${wsId}`);
      }
      return user;
    };
    const buyer = await make('v2_accepted', 'GCLID_OK', 8);
    const refused = await make('refused', 'GCLID_RECUSOU', 8);
    // Assinatura paga pela web de quem veio do anúncio: vira a conversão "Assinatura (offline)" com o valor cobrado.
    const subscribe = async (user: typeof buyer, state: string, hoursAgo: number) => {
      const ws = (await context.app.inject({ method: 'GET', url: '/v1/workspaces', headers: user.authHeader })).json();
      const wsId = (ws.workspaces ?? ws)[0].id;
      await context.services.db.execute(sql`
        INSERT INTO subscriptions (workspace_id, plan_key, provider, state, started_at, billing_cycle, price_cents, provider_subscription_id, provider_customer_id, auto_renewing, acknowledged)
        VALUES (${wsId}, 'basico', 'asaas', ${state}, now() - make_interval(hours => ${hoursAgo}), 'SEMIANNUALLY', 12990, ${`sub_${wsId}`}, 'cus_x', true, true)
      `);
    };
    await subscribe(buyer, 'ativa', 7);
    await subscribe(refused, 'ativa', 7);
    await make('v1_accepted', 'GCLID_TEXTO_ANTIGO', 8);
    await make('none', 'GCLID_SEM_ESCOLHA', 8);
    await make('v2_accepted', 'GCLID_CEDO', 2);
    await make('v2_accepted', 'GCLID_SEM_PRODUTO', null);

    const cookie = await ownerCookie();
    const response = await context.app.inject({ method: 'GET', url: '/admin/api/ads/offline-conversions.csv?days=7', headers: { cookie, ...ADMIN_CSRF } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    const lines = response.body.trim().split('\n');
    expect(lines[0]).toBe('Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^GCLID_OK,Ativação \(offline\),\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}-03:00,12,BRL$/);
    expect(lines[2]).toMatch(/^GCLID_OK,Assinatura \(offline\),\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}-03:00,129\.90,BRL$/);
  });

  it('formata o horário em Brasília e escapa células', () => {
    expect(adsConversionTime(new Date('2026-11-07T14:32:10Z'))).toBe('2026-11-07 11:32:10-03:00');
    expect(offlineConversionsCsv([{ gclid: 'a', convertedAt: new Date('2026-11-07T02:00:00Z') }], 'Nome, com vírgula')).toContain('a,"Nome, com vírgula",2026-11-06 23:00:00-03:00,12,BRL');
  });

  it('a lista de usuários mostra a origem e a ativação, sem o identificador do clique', async () => {
    await register({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'pesquisa_estoque', utm_content: 'salao', gclid: 'SEGREDO', consent: 'v2_accepted' });
    const cookie = await ownerCookie();
    const response = await context.app.inject({ method: 'GET', url: '/admin/api/users', headers: { cookie, ...ADMIN_CSRF } });
    expect(response.statusCode).toBe(200);
    const item = response.json().items[0];
    expect(item.origin).toEqual({ source: 'google', medium: 'cpc', campaign: 'pesquisa_estoque', content: 'salao', hasClickId: true, consent: 'v2_accepted' });
    expect(item.activated).toBe(false);
    expect(response.body).not.toContain('SEGREDO');
  });
});

describe('CSP da web', () => {
  it('libera os domínios que o gtag usa para avisar o Google Ads (sem eles a conversão é bloqueada no navegador)', async () => {
    const home = await context.app.inject({ method: 'GET', url: '/', headers: { host: 'web.test' } });
    const csp = String(home.headers['content-security-policy']);
    const connect = csp.split(';').find((part) => part.trim().startsWith('connect-src')) ?? '';
    for (const host of ['https://www.google.com', 'https://*.g.doubleclick.net', 'https://www.googleadservices.com', 'https://analytics.google.com']) {
      expect(connect).toContain(host);
    }
    expect(csp).toContain("script-src 'self' https://www.googletagmanager.com https://accounts.google.com;");
  });
});

describe('upload programado do Google Ads', () => {
  it('sem senha configurada não existe; com senha exige autenticação básica do usuário googleads', async () => {
    expect((await context.app.inject({ method: 'GET', url: '/v1/ads/offline-conversions.csv' })).statusCode).toBe(404);

    const password = 'senha-de-teste-do-upload-1234567890';
    const other = await createTestApp({ ADS_UPLOAD_PASSWORD: password });
    try {
      const basic = (user: string, pass: string) => ({ authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` });
      const challenge = await other.app.inject({ method: 'GET', url: '/v1/ads/offline-conversions.csv' });
      expect(challenge.statusCode).toBe(401);
      expect(challenge.headers['www-authenticate']).toContain('Basic realm=');
      expect((await other.app.inject({ method: 'GET', url: '/v1/ads/offline-conversions.csv', headers: basic('googleads', 'errada-errada-errada-errada') })).statusCode).toBe(401);
      expect((await other.app.inject({ method: 'GET', url: '/v1/ads/offline-conversions.csv', headers: basic('outro', password) })).statusCode).toBe(401);
      const ok = await other.app.inject({ method: 'GET', url: '/v1/ads/offline-conversions.csv', headers: basic('googleads', password) });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toContain('text/csv');
      expect(ok.body.split('\n')[0]).toBe('Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency');
      // Sem conversão no período o arquivo nunca vai só com o cabeçalho (o Google recusa); leva a linha de exemplo.
      expect(ok.body).toContain('SEM_CONVERSOES_NO_PERIODO,Ativação (offline),');
      // Assinaturas: endereço próprio, mesma autenticação.
      expect((await other.app.inject({ method: 'GET', url: '/v1/ads/offline-subscriptions.csv' })).statusCode).toBe(401);
      const subs = await other.app.inject({ method: 'GET', url: '/v1/ads/offline-subscriptions.csv', headers: basic('googleads', password) });
      expect(subs.statusCode).toBe(200);
      expect(subs.body.split('\n')[0]).toBe('Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency');
      expect(subs.body).toContain('SEM_CONVERSOES_NO_PERIODO,Assinatura (offline),');
    } finally {
      await other.close();
    }
  });
});
