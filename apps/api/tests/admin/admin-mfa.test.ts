import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../../src/platform/auth/password.js';
import { currentStep, totpAt } from '../../src/platform/auth/totp.js';
import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { createTestApp, resetDatabase, type TestContext } from '../helpers/test-app.js';

const PASSWORD = 'PainelSeguro#2026';
const CSRF = { 'x-requested-with': 'estoquesimples-admin' };

let context: TestContext;

beforeAll(async () => {
  context = await createTestApp({ ADMIN_MFA_REQUIRED: 'true' });
});

afterAll(async () => {
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
  context.mailer.sent.length = 0;
});

async function createAdmin(role: 'owner' | 'support' | 'viewer' = 'owner'): Promise<string> {
  const email = `${role}.${randomUUID()}@exemplo.com.br`;
  await context.services.db.insert(platformAdmins).values({ email, name: `Admin ${role}`, passwordHash: await hashPassword(PASSWORD), role });
  return email;
}

const cookieOf = (response: { headers: Record<string, unknown> }): string => {
  const raw = response.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
};

async function login(email: string, code?: string) {
  return context.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: CSRF, payload: { email, password: PASSWORD, ...(code ? { code } : {}) } });
}

const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: Record<string, unknown>) =>
  context.app.inject({ method, url: `/admin/api${url}`, headers: { ...CSRF, cookie }, ...(payload === undefined ? {} : { payload }) } as const);

/** Cadastra o autenticador; devolve o segredo, os códigos de recuperação e o cookie novo (a sessão troca). */
async function enroll(email: string): Promise<{ secret: string; recoveryCodes: string[]; cookie: string; oldCookie: string }> {
  const oldCookie = cookieOf(await login(email));
  const setup = await call('POST', '/auth/mfa/setup', oldCookie, {});
  expect(setup.statusCode).toBe(200);
  const { secret } = setup.json() as { secret: string };
  const emailCode = /: (\d{6})/.exec(context.mailer.lastOfKind('security_alert')!.text)![1]!;
  const enable = await call('POST', '/auth/mfa/enable', oldCookie, { code: totpAt(secret, currentStep()), emailCode });
  expect(enable.statusCode).toBe(200);
  return { secret, recoveryCodes: (enable.json() as { recoveryCodes: string[] }).recoveryCodes, cookie: cookieOf(enable), oldCookie };
}

describe('segundo fator do painel', () => {
  it('sem cadastro, só sessão e tela de cadastro respondem', async () => {
    const email = await createAdmin();
    const cookie = cookieOf(await login(email));
    expect((await call('GET', '/overview', cookie)).json().error.code).toBe('ADMIN_MFA_SETUP_REQUIRED');
    expect((await call('GET', '/auth/me', cookie)).json()).toMatchObject({ mfaEnabled: false, mfaRequired: true });
    expect((await call('GET', '/auth/mfa', cookie)).statusCode).toBe(200);
  });

  it('cadastro exige o código do e-mail, troca a sessão e avisa', async () => {
    const email = await createAdmin();
    const cookie = cookieOf(await login(email));
    const { secret } = (await call('POST', '/auth/mfa/setup', cookie, {})).json() as { secret: string };
    const wrong = await call('POST', '/auth/mfa/enable', cookie, { code: totpAt(secret, currentStep()), emailCode: '000000' });
    expect(wrong.statusCode).toBe(400);

    const { recoveryCodes, cookie: fresh, oldCookie } = await enroll(email);
    expect(recoveryCodes).toHaveLength(10);
    expect((await call('GET', '/auth/me', oldCookie)).statusCode).toBe(401);
    expect((await call('GET', '/overview', fresh)).statusCode).toBe(200);
    expect(context.mailer.sent.some((message) => message.to === email && /ativado/.test(message.subject))).toBe(true);
  });

  it('login pede o código, recusa repetição do mesmo código e aceita recuperação uma vez só', async () => {
    const email = await createAdmin();
    const { secret, recoveryCodes } = await enroll(email);

    const noCode = await login(email);
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json().error.code).toBe('ADMIN_MFA_REQUIRED');

    // O passo usado no cadastro já foi consumido: o mesmo código não entra de novo.
    const replay = await login(email, totpAt(secret, currentStep()));
    expect(replay.statusCode).toBe(401);
    const next = await login(email, totpAt(secret, currentStep() + 1));
    expect(next.statusCode).toBe(200);

    expect((await login(email, recoveryCodes[0])).statusCode).toBe(200);
    expect((await login(email, recoveryCodes[0])).statusCode).toBe(401);
    const [row] = await context.services.db.select({ codes: platformAdmins.recoveryCodes }).from(platformAdmins).where(eq(platformAdmins.email, email));
    expect(row?.codes).toHaveLength(9);
  });

  it('desativar exige senha e código e passa pelo freio de tentativas', async () => {
    const email = await createAdmin();
    const { cookie, recoveryCodes } = await enroll(email);
    for (let i = 0; i < 5; i += 1) {
      const response = await call('POST', '/auth/mfa/disable', cookie, { password: 'senha-errada-123', code: '123456' });
      expect([401, 429]).toContain(response.statusCode);
    }
    const blocked = await call('POST', '/auth/mfa/disable', cookie, { password: PASSWORD, code: recoveryCodes[0] });
    expect(blocked.statusCode).toBe(429);
  });

  it('owner zera o segundo fator de outro administrador, derruba as sessões dele e avisa', async () => {
    const ownerEmail = await createAdmin('owner');
    const { cookie: ownerCookie } = await enroll(ownerEmail);
    const supportEmail = await createAdmin('support');
    const { cookie: supportCookie } = await enroll(supportEmail);
    const [support] = await context.services.db.select({ id: platformAdmins.id }).from(platformAdmins).where(eq(platformAdmins.email, supportEmail));

    const reset = await call('POST', `/admins/${support!.id}/mfa/reset`, ownerCookie, {});
    expect(reset.statusCode).toBe(200);
    expect((await call('GET', '/auth/me', supportCookie)).statusCode).toBe(401);
    expect(context.mailer.sent.some((message) => message.to === supportEmail && /zerado/.test(message.subject))).toBe(true);

    const again = cookieOf(await login(supportEmail));
    expect((await call('GET', '/overview', again)).json().error.code).toBe('ADMIN_MFA_SETUP_REQUIRED');
  });
});
