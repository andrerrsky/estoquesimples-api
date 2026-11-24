import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../../src/platform/auth/password.js';
import { currentStep, totpAt } from '../../src/platform/auth/totp.js';
import { adminSessions, adminTrustedDevices, platformAdmins } from '../../src/platform/db/schema/index.js';
import { createTestApp, resetDatabase, type TestContext } from '../helpers/test-app.js';

/**
 * Navegador confiável do painel.
 *
 * O dono usa dois computadores: a sessão morria em 12 h de inatividade e o
 * código do autenticador era pedido quase toda vez. Aqui o navegador fica
 * conhecido por alguns dias — dispensando o código, nunca a senha — e os dois
 * computadores ficam conectados ao mesmo tempo.
 */
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

type Resposta = Awaited<ReturnType<TestContext['app']['inject']>>;

/** Pega um cookie pelo nome entre os `set-cookie` da resposta. */
function cookieNamed(response: Resposta, name: string): string | null {
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const found = list.find((item) => String(item).startsWith(`${name}=`));
  if (!found) return null;
  const pair = String(found).split(';')[0]!;
  // Cookie apagado (clearCookie) volta com valor vazio.
  return pair.endsWith('=') ? null : pair;
}

const sessionCookie = (response: Resposta) => cookieNamed(response, 'es_admin')!;
const deviceCookie = (response: Resposta) => cookieNamed(response, 'es_admin_device');

async function createAdmin(): Promise<string> {
  const email = `owner.${randomUUID()}@exemplo.com.br`;
  await context.services.db.insert(platformAdmins).values({ email, name: 'Admin', passwordHash: await hashPassword(PASSWORD), role: 'owner' });
  return email;
}

function login(email: string, options: { code?: string; trustDevice?: boolean; device?: string | null } = {}) {
  return context.app.inject({
    method: 'POST',
    url: '/admin/api/auth/login',
    headers: { ...CSRF, ...(options.device ? { cookie: options.device } : {}) },
    payload: {
      email,
      password: PASSWORD,
      ...(options.code ? { code: options.code } : {}),
      ...(options.trustDevice ? { trustDevice: true } : {}),
    },
  });
}

const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: Record<string, unknown>) =>
  context.app.inject({ method, url: `/admin/api${url}`, headers: { ...CSRF, cookie }, ...(payload === undefined ? {} : { payload }) } as const);

/** Cadastra o autenticador e devolve o segredo e o cookie de sessão novo. */
async function enroll(email: string): Promise<{ secret: string; cookie: string; recoveryCodes: string[] }> {
  const first = sessionCookie(await login(email));
  const { secret } = (await call('POST', '/auth/mfa/setup', first, {})).json() as { secret: string };
  const emailCode = /: (\d{6})/.exec(context.mailer.lastOfKind('security_alert')!.text)![1]!;
  const enable = await call('POST', '/auth/mfa/enable', first, { code: totpAt(secret, currentStep()), emailCode });
  expect(enable.statusCode).toBe(200);
  return { secret, cookie: sessionCookie(enable), recoveryCodes: (enable.json() as { recoveryCodes: string[] }).recoveryCodes };
}

/** Códigos de passos diferentes: o mesmo passo não entra duas vezes. */
const codigo = (secret: string, offset = 0) => totpAt(secret, currentStep() + offset);

describe('navegador confiável no painel', () => {
  it('marcado com o código, dispensa o código depois — e continua pedindo a senha', async () => {
    const email = await createAdmin();
    const { secret } = await enroll(email);

    const marcado = await login(email, { code: codigo(secret, 1), trustDevice: true });
    expect(marcado.statusCode).toBe(200);
    const device = deviceCookie(marcado);
    expect(device).toBeTruthy();
    expect(context.mailer.sent.some((m) => m.to === email && /confiável/i.test(m.subject))).toBe(true);

    // Mesmo navegador, sem código: entra.
    const semCodigo = await login(email, { device });
    expect(semCodigo.statusCode).toBe(200);
    expect((await call('GET', '/auth/me', sessionCookie(semCodigo))).statusCode).toBe(200);

    // Sem o cookie, segue pedindo o código.
    const outro = await login(email);
    expect(outro.statusCode).toBe(401);
    expect(outro.json().error.code).toBe('ADMIN_MFA_REQUIRED');

    // Com o cookie e a senha errada, não entra: a confiança nunca dispensa a senha.
    const senhaErrada = await context.app.inject({
      method: 'POST',
      url: '/admin/api/auth/login',
      headers: { ...CSRF, cookie: device! },
      payload: { email, password: 'SenhaQualquer#2026' },
    });
    expect(senhaErrada.statusCode).toBe(401);
    expect(senhaErrada.json().error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('a sessão do navegador confiável dura dias, e os dois computadores ficam conectados', async () => {
    const email = await createAdmin();
    const { secret, recoveryCodes } = await enroll(email);

    const computadorA = await login(email, { code: codigo(secret, 1), trustDevice: true });
    const sessaoA = sessionCookie(computadorA);
    const expiraA = new Date((computadorA.json() as { expiresAt: string }).expiresAt);
    // Mais do que as 12 h de inatividade e do que o teto de 7 dias de antes.
    expect(expiraA.getTime() - Date.now()).toBeGreaterThan(8 * 86_400_000);

    const computadorB = await login(email, { code: recoveryCodes[0]!, trustDevice: true });
    const sessaoB = sessionCookie(computadorB);

    // Entrar no segundo não derruba o primeiro.
    expect((await call('GET', '/auth/me', sessaoA)).statusCode).toBe(200);
    expect((await call('GET', '/auth/me', sessaoB)).statusCode).toBe(200);

    // O navegador precisa guardar o cookie por todo o prazo da sessão: com
    // Max-Age de 7 dias ele apagava o cookie no sétimo e pedia o código antes
    // da hora, mesmo com a sessão ainda válida no servidor.
    const maxAge = String(
      (Array.isArray(computadorA.headers['set-cookie']) ? computadorA.headers['set-cookie'] : [String(computadorA.headers['set-cookie'])]).find((item) =>
        String(item).startsWith('es_admin='),
      ),
    ).match(/Max-Age=(\d+)/)?.[1];
    expect(Number(maxAge)).toBe(10 * 86_400);

    const devices = (await call('GET', '/auth/trusted-devices', sessaoB)).json() as { days: number; items: Array<{ current: boolean }> };
    expect(devices.days).toBe(10);
    expect(devices.items).toHaveLength(2);
    expect(devices.items.filter((item) => item.current)).toHaveLength(1);
  });

  it('deixar de confiar encerra a sessão daquele navegador e volta a pedir o código', async () => {
    const email = await createAdmin();
    const { secret } = await enroll(email);

    const confiavel = await login(email, { code: codigo(secret, 1), trustDevice: true });
    const sessao = sessionCookie(confiavel);
    const device = deviceCookie(confiavel);
    const [item] = (await call('GET', '/auth/trusted-devices', sessao)).json().items as Array<{ id: string }>;

    const revoke = await call('POST', `/auth/trusted-devices/${item!.id}/revoke`, sessao, {});
    expect(revoke.statusCode).toBe(200);

    // A sessão longa cai na hora: é assim que se corta um computador perdido.
    expect((await call('GET', '/auth/me', sessao)).statusCode).toBe(401);
    // E o cookie antigo não dispensa mais o código.
    const depois = await login(email, { device });
    expect(depois.statusCode).toBe(401);
    expect(depois.json().error.code).toBe('ADMIN_MFA_REQUIRED');
  });

  it('não dá para confiar sem o código: nem sem segundo fator, nem só com o cookie', async () => {
    // Sem segundo fator cadastrado, a marcação é ignorada.
    const semMfa = await createAdmin();
    const resposta = await login(semMfa, { trustDevice: true });
    expect(resposta.statusCode).toBe(200);
    expect(deviceCookie(resposta)).toBeNull();
    expect(await context.services.db.select().from(adminTrustedDevices)).toHaveLength(0);

    // Com segundo fator, entrar pelo cookie e pedir confiança não cria outro navegador.
    const email = await createAdmin();
    const { secret } = await enroll(email);
    const primeiro = await login(email, { code: codigo(secret, 1), trustDevice: true });
    const device = deviceCookie(primeiro);
    const segundo = await login(email, { device, trustDevice: true });
    expect(segundo.statusCode).toBe(200);
    const devices = await context.services.db.select().from(adminTrustedDevices).where(isNull(adminTrustedDevices.revokedAt));
    expect(devices).toHaveLength(1);
  });

  it('o token do cookie é rotacionado a cada entrada, sem esticar o prazo', async () => {
    const email = await createAdmin();
    const { secret } = await enroll(email);
    const marcado = await login(email, { code: codigo(secret, 1), trustDevice: true });
    const primeiro = deviceCookie(marcado)!;
    const [antes] = await context.services.db.select().from(adminTrustedDevices);

    const segundo = await login(email, { device: primeiro });
    const rotacionado = deviceCookie(segundo)!;
    expect(rotacionado).not.toBe(primeiro);

    const [depois] = await context.services.db.select().from(adminTrustedDevices);
    expect(depois!.expiresAt.getTime()).toBe(antes!.expiresAt.getTime());

    // O cookie antigo não serve mais.
    const velho = await login(email, { device: primeiro });
    expect(velho.statusCode).toBe(401);
    expect(velho.json().error.code).toBe('ADMIN_MFA_REQUIRED');
  });

  it('sessão vencida fica na auditoria com o motivo, uma vez só', async () => {
    const email = await createAdmin();
    const { secret } = await enroll(email);
    const entrada = await login(email, { code: codigo(secret, 1), trustDevice: true });
    const sessao = sessionCookie(entrada);
    expect((await call('GET', '/auth/me', sessao)).statusCode).toBe(200);

    // Vencimento no passado: é o que o painel vê quando a pessoa volta depois
    // do prazo.
    await context.services.db.execute(sql`UPDATE admin_sessions SET expires_at = now() - interval '1 minute'`);
    expect((await call('GET', '/auth/me', sessao)).statusCode).toBe(401);
    expect((await call('GET', '/auth/me', sessao)).statusCode).toBe(401);

    const linhas = await context.services.db.execute<{ motivo: string; confiavel: boolean; n: number }>(sql`
      SELECT metadata->>'motivo' AS motivo, (metadata->>'navegadorConfiavel')::boolean AS confiavel, count(*)::int AS n
      FROM admin_audit_log WHERE action = 'admin.session_expired' GROUP BY 1, 2`);
    expect(linhas.rows).toEqual([{ motivo: 'inatividade', confiavel: true, n: 1 }]);

    // A sessão de antes de ativar o segundo fator também está revogada, sem
    // motivo: aqui interessa a que venceu agora.
    const sessoes = await context.services.db.execute<{ revoked_reason: string }>(sql`SELECT revoked_reason FROM admin_sessions WHERE revoked_reason IS NOT NULL`);
    expect(sessoes.rows).toEqual([{ revoked_reason: 'inatividade' }]);
  });

  it('cookie forjado é tratado como ausente', async () => {
    const email = await createAdmin();
    await enroll(email);
    const forjado = await login(email, { device: 'es_admin_device=token-inventado' });
    expect(forjado.statusCode).toBe(401);
    expect(forjado.json().error.code).toBe('ADMIN_MFA_REQUIRED');
  });

  it('trocar a senha derruba a confiança e as sessões longas', async () => {
    const email = await createAdmin();
    const { secret } = await enroll(email);
    const confiavel = await login(email, { code: codigo(secret, 1), trustDevice: true });
    const sessao = sessionCookie(confiavel);
    const device = deviceCookie(confiavel);

    const [admin] = await context.services.db.select().from(platformAdmins).where(eq(platformAdmins.email, email));
    const reset = await call('POST', `/admins/${admin!.id}/reset-password`, sessao, { password: 'OutraSenhaForte#2026' });
    expect(reset.statusCode).toBe(200);

    expect((await call('GET', '/auth/me', sessao)).statusCode).toBe(401);
    const ativos = await context.services.db
      .select()
      .from(adminTrustedDevices)
      .where(and(eq(adminTrustedDevices.adminId, admin!.id), isNull(adminTrustedDevices.revokedAt)));
    expect(ativos).toHaveLength(0);

    const sessoes = await context.services.db
      .select()
      .from(adminSessions)
      .where(and(eq(adminSessions.adminId, admin!.id), isNull(adminSessions.revokedAt)));
    expect(sessoes).toHaveLength(0);
    expect(device).toBeTruthy();
  });
});
