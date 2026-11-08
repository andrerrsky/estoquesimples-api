import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../../src/platform/auth/password.js';
import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { invalidGoogleCredential, profileFromClaims, type GoogleProfile } from '../../src/modules/auth/google-identity.js';
import { createTestApp, resetDatabase, uniqueEmail, VALID_PASSWORD, type TestContext } from '../helpers/test-app.js';

const WEB = { host: 'web.test', 'x-requested-with': 'estoquesimples-web' };
const CLIENT_ID = '123456-abcdef.apps.googleusercontent.com';
const DEVICE = { installId: 'navegador-google-0001-000000000000', platform: 'web', model: 'Chrome' };

let context: TestContext;
/** Token falso → perfil: o teste decide o que o "Google" confirmou. */
const tokens = new Map<string, GoogleProfile>();

beforeAll(async () => {
  context = await createTestApp({ GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID });
  context.services.googleVerifier = async (credential) => {
    const profile = tokens.get(credential);
    if (!profile) throw invalidGoogleCredential();
    return profile;
  };
});

afterAll(async () => {
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
  tokens.clear();
});

function token(profile: GoogleProfile): string {
  const value = `token-google-${randomUUID()}`;
  tokens.set(value, profile);
  return value;
}

const google = (credential: string, extra: Record<string, unknown> = {}) =>
  context.app.inject({ method: 'POST', url: '/v1/auth/web/google', headers: WEB, payload: { credential, device: DEVICE, ...extra } });

async function userRow(email: string) {
  return (
    await context.services.db.execute<{ id: string; signup_method: string; password_hash: string | null; email_verified_at: string | null; signup_attribution: Record<string, string> | null }>(
      sql`SELECT id, signup_method, password_hash, email_verified_at, signup_attribution FROM users WHERE lower(email) = ${email.toLowerCase()} AND deleted_at IS NULL`,
    )
  ).rows;
}

describe('Continuar com o Google (web)', () => {
  it('config pública diz se o botão existe', async () => {
    const config = await context.app.inject({ method: 'GET', url: '/v1/auth/web/config', headers: { host: 'web.test' } });
    expect(config.json()).toEqual({ googleClientId: CLIENT_ID });
  });

  it('cria a conta sem senha, com e-mail confirmado, método google, empresa automática e origem; entrar de novo não duplica', async () => {
    const email = uniqueEmail('google');
    const profile = { sub: 'google-sub-1', email, name: 'Ana Google' };
    const first = await google(token(profile), { attribution: { utm_source: 'google', utm_medium: 'cpc', gclid: 'G-1', consent: 'v2_accepted' } });
    expect(first.statusCode).toBe(200);
    expect(first.json().isNew).toBe(true);
    expect(first.json().user).toMatchObject({ email, emailVerified: true, hasPassword: false, signupMethod: 'google' });
    expect(String(first.headers['set-cookie'])).toContain('HttpOnly');

    const [row] = await userRow(email);
    expect(row).toMatchObject({ signup_method: 'google', password_hash: null });
    expect(row?.email_verified_at).toBeTruthy();
    expect(row?.signup_attribution?.gclid).toBe('G-1');
    const ws = await context.app.inject({ method: 'GET', url: '/v1/workspaces', headers: { authorization: `Bearer ${first.json().accessToken}` } });
    expect(ws.json().workspaces).toHaveLength(1);

    const again = await google(token(profile));
    expect(again.statusCode).toBe(200);
    expect(again.json().isNew).toBe(false);
    expect(await userRow(email)).toHaveLength(1);
    const ws2 = await context.app.inject({ method: 'GET', url: '/v1/workspaces', headers: { authorization: `Bearer ${again.json().accessToken}` } });
    expect(ws2.json().workspaces).toHaveLength(1);

    const events = await context.services.db.execute<{ name: string; m: string | null }>(
      sql`SELECT name, properties->>'method' AS m FROM analytics_events WHERE user_id = ${row!.id} AND name IN ('user.registered', 'user.logged_in') ORDER BY id`,
    );
    expect(events.rows).toEqual([
      { name: 'user.registered', m: 'google' },
      { name: 'user.logged_in', m: 'google' },
    ]);
  });

  it('conta com senha e mesmo e-mail: liga o Google, confirma o e-mail, mantém o método e a senha continua valendo', async () => {
    const email = uniqueEmail('mista');
    const reg = await context.app.inject({ method: 'POST', url: '/v1/auth/web/register', headers: WEB, payload: { email, password: VALID_PASSWORD, name: 'Bruno', device: DEVICE } });
    expect(reg.statusCode).toBe(201);
    const response = await google(token({ sub: 'google-sub-2', email: email.toUpperCase(), name: 'Bruno G' }));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ isNew: false, user: { hasPassword: true, signupMethod: 'email', emailVerified: true, name: 'Bruno' } });
    expect(await userRow(email)).toHaveLength(1);
    const audit = await context.services.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.google_linked'`);
    expect(audit.rows[0]?.n).toBe(1);
    const login = await context.app.inject({ method: 'POST', url: '/v1/auth/web/login', headers: WEB, payload: { email, password: VALID_PASSWORD } });
    expect(login.statusCode).toBe(200);
  });

  it('conta criada com o Google: login por senha dá a mesma resposta de senha errada; pode criar senha e excluir a conta confirmando o e-mail', async () => {
    const email = uniqueEmail('semsenha');
    const created = await google(token({ sub: 'google-sub-3', email, name: 'Carla' }));
    const authHeader = { authorization: `Bearer ${created.json().accessToken}` };
    const login = await context.app.inject({ method: 'POST', url: '/v1/auth/web/login', headers: WEB, payload: { email, password: 'QualquerSenha#2026' } });
    expect(login.statusCode).toBe(401);
    expect(login.json().error.code).toBe('AUTH_INVALID_CREDENTIALS');

    const noProof = await context.app.inject({ method: 'DELETE', url: '/v1/me', headers: authHeader, payload: { closeWorkspaces: true } });
    expect(noProof.statusCode).toBe(400);
    const otherGoogle = await context.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: authHeader,
      payload: { googleCredential: token({ sub: 'outra-conta-google', email: 'outra@gmail.com', name: 'Outra' }), closeWorkspaces: true },
    });
    expect(otherGoogle.statusCode).toBe(401);

    // "Esqueci minha senha" de conta só Google: e-mail explica e oferece criar senha.
    await context.app.inject({ method: 'POST', url: '/v1/auth/forgot-password', payload: { email } });
    const resetMail = context.mailer.lastOfKind('password_reset');
    expect(resetMail?.subject).toContain('usa o Google');
    expect(resetMail?.text).toContain('Continuar com o Google');

    const setPassword = await context.app.inject({ method: 'POST', url: '/v1/auth/change-password', headers: authHeader, payload: { newPassword: 'NovaSenhaForte#2026', revokeOtherSessions: false } });
    expect([200, 204]).toContain(setPassword.statusCode);
    const loginNow = await context.app.inject({ method: 'POST', url: '/v1/auth/web/login', headers: WEB, payload: { email, password: 'NovaSenhaForte#2026' } });
    expect(loginNow.statusCode).toBe(200);
  });

  it('exclusão da conta sem senha confirmando com a mesma conta Google', async () => {
    const email = uniqueEmail('excluir');
    const profile = { sub: 'google-sub-4', email, name: 'Dani' };
    const created = await google(token(profile));
    const del = await context.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: { authorization: `Bearer ${created.json().accessToken}` },
      payload: { googleCredential: token(profile), closeWorkspaces: true },
    });
    expect(del.statusCode).toBe(200);
  });

  it('token inválido, sem o cabeçalho anti-CSRF ou conta suspensa: recusado', async () => {
    expect((await google('token-google-que-nao-existe-1234')).statusCode).toBe(401);
    const csrf = await context.app.inject({ method: 'POST', url: '/v1/auth/web/google', headers: { host: 'web.test' }, payload: { credential: 'token-google-que-nao-existe-1234' } });
    expect(csrf.statusCode).toBe(403);

    const email = uniqueEmail('suspensa');
    await google(token({ sub: 'google-sub-5', email, name: 'Eva' }));
    await context.services.db.execute(sql`UPDATE users SET status = 'suspended' WHERE lower(email) = ${email}`);
    const blocked = await google(token({ sub: 'google-sub-5', email, name: 'Eva' }));
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('AUTH_ACCOUNT_SUSPENDED');
  });

  it('sem Client ID configurado a rota não existe', async () => {
    const other = await createTestApp();
    try {
      expect((await other.app.inject({ method: 'GET', url: '/v1/auth/web/config', headers: { host: 'web.test' } })).json()).toEqual({ googleClientId: null });
      expect((await other.app.inject({ method: 'POST', url: '/v1/auth/web/google', headers: WEB, payload: { credential: 'token-google-qualquer-123456' } })).statusCode).toBe(404);
    } finally {
      await other.close();
    }
  });

  it('regras do token: e-mail confirmado obrigatório, e-mail em minúsculas, nome com reserva', () => {
    expect(profileFromClaims({ sub: '1', email: 'Fulano@Gmail.com', email_verified: true, name: ' Fulano ' })).toEqual({ sub: '1', email: 'fulano@gmail.com', name: 'Fulano' });
    expect(profileFromClaims({ sub: '1', email: 'semnome@gmail.com', email_verified: 'true' }).name).toBe('semnome');
    expect(() => profileFromClaims({ sub: '1', email: 'x@gmail.com', email_verified: false })).toThrow();
    expect(() => profileFromClaims({ email: 'x@gmail.com', email_verified: true })).toThrow();
  });

  it('painel: método na lista, filtro e contagem por método com cliques no botão', async () => {
    await google(token({ sub: 'google-sub-6', email: uniqueEmail('painel'), name: 'Fabi' }));
    await context.app.inject({ method: 'POST', url: '/v1/auth/web/register', headers: WEB, payload: { email: uniqueEmail('normal'), password: VALID_PASSWORD, name: 'Gil', device: DEVICE } });
    await context.app.inject({
      method: 'POST',
      url: '/v1/analytics/events',
      payload: { device: { installId: 'instalacao-clique-0001', platform: 'web', appVersionCode: 1 }, events: [{ id: randomUUID(), name: 'signup.google_clicked', occurredAt: Date.now(), properties: { page: '/criar-conta' } }] },
    });

    const adminEmail = `owner.${randomUUID()}@exemplo.com.br`;
    await context.services.db.insert(platformAdmins).values({ email: adminEmail, name: 'Dono', passwordHash: await hashPassword('PainelSeguro#2026'), role: 'owner' });
    const loginAdmin = await context.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: { 'x-requested-with': 'estoquesimples-admin' }, payload: { email: adminEmail, password: 'PainelSeguro#2026' } });
    const raw = loginAdmin.headers['set-cookie'];
    const h = { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '', 'x-requested-with': 'estoquesimples-admin' };

    const stats = (await context.app.inject({ method: 'GET', url: '/admin/api/users/signup-methods?days=30', headers: h })).json();
    expect(stats).toMatchObject({ days: 30, email: 1, google: 1, googleClicks: 1, googleOneTap: 0, activatedEmail: 0, activatedGoogle: 0 });
    const onlyGoogle = (await context.app.inject({ method: 'GET', url: '/admin/api/users?signupMethod=google', headers: h })).json();
    expect(onlyGoogle.items).toHaveLength(1);
    expect(onlyGoogle.items[0].signupMethod).toBe('google');
  });
});
