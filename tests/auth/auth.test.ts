import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createTestApp,
  registerUser,
  resetDatabase,
  uniqueEmail,
  VALID_PASSWORD,
  type TestContext,
} from '../helpers/test-app.js';

let context: TestContext;

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
  context.mailer.clear();
});

describe('cadastro', () => {
  it('cria a conta e devolve uma sessão utilizável', async () => {
    const email = uniqueEmail();
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: VALID_PASSWORD, name: 'Maria' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.email).toBe(email);
    expect(body.user.emailVerified).toBe(false);
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();

    const me = await context.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe(email);
  });

  it('nunca devolve o hash da senha', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: uniqueEmail(), password: VALID_PASSWORD, name: 'Maria' },
    });

    expect(response.body).not.toContain('argon2');
    expect(response.json().user).not.toHaveProperty('passwordHash');
  });

  it('rejeita e-mail já cadastrado, ignorando maiúsculas', async () => {
    const email = uniqueEmail();
    await registerUser(context, { email });

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: email.toUpperCase(), password: VALID_PASSWORD, name: 'Outro' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('AUTH_EMAIL_IN_USE');
  });

  it('rejeita senha fraca informando o motivo', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: uniqueEmail(), password: 'curta', name: 'Maria' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('AUTH_WEAK_PASSWORD');
    expect(response.json().error.details.length).toBeGreaterThan(0);
  });

  it('rejeita campos desconhecidos no corpo (mass assignment)', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: uniqueEmail(),
        password: VALID_PASSWORD,
        name: 'Maria',
        permissionVersion: 999,
        status: 'admin',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('login', () => {
  it('autentica com credenciais corretas', async () => {
    const email = uniqueEmail();
    await registerUser(context, { email });

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toBeTruthy();
  });

  it('responde igual para e-mail inexistente e para senha errada', async () => {
    const email = uniqueEmail();
    await registerUser(context, { email });

    const wrongPassword = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'SenhaErrada#2026' },
    });

    const unknownEmail = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: uniqueEmail(), password: VALID_PASSWORD },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    // Mesma resposta nos dois casos: não dá para descobrir se a conta existe.
    expect(wrongPassword.json().error.code).toBe(unknownEmail.json().error.code);
    expect(wrongPassword.json().error.message).toBe(unknownEmail.json().error.message);
  });

  it('bloqueia a conta após tentativas seguidas e informa quando tentar de novo', async () => {
    const locking = await createTestApp({ LOGIN_MAX_ATTEMPTS: '3', LOGIN_LOCK_BASE_SECONDS: '60' });
    try {
      const email = uniqueEmail();
      await registerUser(locking, { email });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const failed = await locking.app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email, password: 'SenhaErrada#2026' },
        });
        expect(failed.statusCode).toBe(401);
      }

      // A senha agora está correta, mas a conta está bloqueada.
      const locked = await locking.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: VALID_PASSWORD },
      });

      expect(locked.statusCode).toBe(429);
      expect(locked.json().error.code).toBe('AUTH_ACCOUNT_LOCKED');
      expect(locked.json().error.retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      await locking.close();
    }
  });

  it('zera o contador de falhas após um login bem-sucedido', async () => {
    const locking = await createTestApp({ LOGIN_MAX_ATTEMPTS: '3' });
    try {
      const email = uniqueEmail();
      await registerUser(locking, { email });

      await locking.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: 'SenhaErrada#2026' },
      });
      await locking.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: VALID_PASSWORD },
      });

      // Duas novas falhas não devem bloquear, porque o contador foi zerado.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const failed = await locking.app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email, password: 'SenhaErrada#2026' },
        });
        expect(failed.statusCode).toBe(401);
      }
    } finally {
      await locking.close();
    }
  });
});

describe('rotação de refresh token', () => {
  it('emite um par novo e invalida o token usado', async () => {
    const user = await registerUser(context);

    const first = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });

    expect(first.statusCode).toBe(200);
    const rotated = first.json();
    expect(rotated.refreshToken).not.toBe(user.refreshToken);
    expect(rotated.sessionId).toBe(user.sessionId);

    const withNewToken = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: rotated.refreshToken },
    });
    expect(withNewToken.statusCode).toBe(200);
  });

  it('encerra a sessão quando um token já consumido é reapresentado', async () => {
    const user = await registerUser(context);

    const rotated = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(rotated.statusCode).toBe(200);

    // Reuso do token original: sinal de roubo.
    const reuse = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });

    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe('AUTH_TOKEN_REUSE_DETECTED');

    // A sessão inteira caiu, inclusive o token que era legítimo.
    const afterRevocation = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: rotated.json().refreshToken },
    });
    expect(afterRevocation.statusCode).toBe(401);
    expect(afterRevocation.json().error.code).toBe('AUTH_SESSION_REVOKED');
  });

  it('rejeita um refresh token inventado', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: 'token-que-nunca-existiu-mas-tem-tamanho-suficiente' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_TOKEN_INVALID');
  });
});

describe('logout', () => {
  it('invalida o access token imediatamente, sem esperar a expiração', async () => {
    const user = await registerUser(context);

    const before = await context.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: user.authHeader,
    });
    expect(before.statusCode).toBe(200);

    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: user.authHeader,
      payload: {},
    });

    const after = await context.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: user.authHeader,
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('AUTH_SESSION_REVOKED');
  });

  it('logout-all derruba as sessões de todos os aparelhos', async () => {
    const email = uniqueEmail();
    const first = await registerUser(context, { email, installId: 'aparelho-numero-1' });

    const secondLogin = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email,
        password: VALID_PASSWORD,
        device: { installId: 'aparelho-numero-2', platform: 'android' },
      },
    });
    const second = secondLogin.json();

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { authorization: `Bearer ${second.accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revokedSessions).toBe(2);

    for (const token of [first.accessToken, second.accessToken]) {
      const check = await context.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(check.statusCode).toBe(401);
    }
  });
});

describe('recuperação de senha', () => {
  it('permite redefinir com o código e encerra as sessões existentes', async () => {
    const email = uniqueEmail();
    const user = await registerUser(context, { email });

    const request = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email },
    });
    expect(request.statusCode).toBe(202);

    const message = context.mailer.lastOfKind('password_reset');
    expect(message).toBeDefined();
    const token = message!.text.trim().split('\n').filter(Boolean).at(-2)!.trim();

    const newPassword = 'OutraSenhaForte#2026';
    const reset = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, newPassword },
    });
    expect(reset.statusCode).toBe(200);

    // A sessão anterior não vale mais.
    const oldSession = await context.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: user.authHeader,
    });
    expect(oldSession.statusCode).toBe(401);

    const login = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: newPassword },
    });
    expect(login.statusCode).toBe(200);
  });

  it('não revela se o e-mail existe', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email: uniqueEmail('nao-existe') },
    });

    expect(response.statusCode).toBe(202);
    expect(context.mailer.sent).toHaveLength(0);
  });

  it('recusa o mesmo código na segunda vez', async () => {
    const email = uniqueEmail();
    await registerUser(context, { email });

    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email },
    });
    const token = context.mailer
      .lastOfKind('password_reset')!
      .text.trim()
      .split('\n')
      .filter(Boolean)
      .at(-2)!
      .trim();

    const first = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, newPassword: 'PrimeiraTroca#2026' },
    });
    expect(first.statusCode).toBe(200);

    const second = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, newPassword: 'SegundaTroca#2026' },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe('AUTH_TOKEN_INVALID');
  });
});

describe('troca de senha autenticada', () => {
  it('exige a senha atual e derruba as outras sessões', async () => {
    const email = uniqueEmail();
    const user = await registerUser(context, { email, installId: 'aparelho-principal' });

    const otherLogin = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: VALID_PASSWORD },
    });
    const other = otherLogin.json();

    const wrongCurrent = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/change-password',
      headers: { authorization: `Bearer ${other.accessToken}` },
      payload: { currentPassword: 'ErradaDemais#2026', newPassword: 'NovaSenha#2026' },
    });
    expect(wrongCurrent.statusCode).toBe(401);

    const changed = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/change-password',
      headers: { authorization: `Bearer ${other.accessToken}` },
      payload: { currentPassword: VALID_PASSWORD, newPassword: 'NovaSenha#2026' },
    });
    expect(changed.statusCode).toBe(200);

    // A sessão que trocou a senha continua válida...
    const stillValid = await context.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(stillValid.statusCode).toBe(200);

    // ...e a outra, não.
    const revoked = await context.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: user.authHeader,
    });
    expect(revoked.statusCode).toBe(401);
  });
});

describe('verificação de e-mail', () => {
  it('confirma o e-mail com o código enviado no cadastro', async () => {
    const user = await registerUser(context);

    const message = context.mailer.lastOfKind('email_verification');
    expect(message).toBeDefined();
    const token = message!.text.trim().split('\n').filter(Boolean)[1]!.trim();

    const verify = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token },
    });
    expect(verify.statusCode).toBe(200);

    const me = await context.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: user.authHeader,
    });
    expect(me.json().emailVerified).toBe(true);
  });
});

describe('proteção dos endpoints', () => {
  it('recusa requisição sem token', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/v1/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_REQUIRED');
  });

  it('recusa token malformado', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer nao-e-um-jwt' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('inclui correlationId nos erros para rastreio no log', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/v1/me' });
    expect(response.json().error.correlationId).toBeTruthy();
  });

  it('não vaza stack trace em erro de rota inexistente', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/v1/rota-que-nao-existe' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('at ');
  });
});

describe('rate limiting', () => {
  it('bloqueia excesso de tentativas de login', async () => {
    const limited = await createTestApp({ RATE_LIMIT_AUTH_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' });
    try {
      const payload = { email: uniqueEmail(), password: VALID_PASSWORD };
      const codes: number[] = [];

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await limited.app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload,
        });
        codes.push(response.statusCode);
      }

      expect(codes.filter((code) => code === 429).length).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });
});

describe('sessões e dispositivos', () => {
  it('lista as sessões marcando a atual', async () => {
    const email = uniqueEmail();
    await registerUser(context, { email, installId: 'aparelho-numero-1' });

    const secondLogin = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email,
        password: VALID_PASSWORD,
        device: { installId: 'aparelho-numero-2', platform: 'android', model: 'Moto G' },
      },
    });
    const second = secondLogin.json();

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/me/sessions',
      headers: { authorization: `Bearer ${second.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    const sessions = response.json().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session: { current: boolean }) => session.current)).toHaveLength(1);
  });

  it('revogar um dispositivo encerra as sessões dele', async () => {
    const user = await registerUser(context, { installId: 'aparelho-a-revogar' });
    expect(user.deviceId).toBeTruthy();

    const response = await context.app.inject({
      method: 'DELETE',
      url: `/v1/me/devices/${user.deviceId}`,
      headers: user.authHeader,
    });
    expect(response.statusCode).toBe(200);

    const check = await context.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: user.authHeader,
    });
    expect(check.statusCode).toBe(401);
  });

  it('reconhece o mesmo aparelho pelo installId em vez de duplicar', async () => {
    const email = uniqueEmail();
    const first = await registerUser(context, { email, installId: 'aparelho-estavel' });

    const again = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email,
        password: VALID_PASSWORD,
        device: { installId: 'aparelho-estavel', platform: 'android' },
      },
    });

    expect(again.json().deviceId).toBe(first.deviceId);
  });
});

describe('infraestrutura', () => {
  it('health responde sem depender do banco', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });

  it('ready confirma banco e migrations em dia', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json().checks).toEqual({ database: true, migrations: true });
  });

  it('expõe a configuração remota de sincronização', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/v1/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json().sync.enabled).toBe(true);
    expect(response.json().sync.protocolVersion).toBe(1);
  });

  it('permite desligar a sincronização por configuração', async () => {
    const disabled = await createTestApp({ FEATURE_SYNC_ENABLED: 'false' });
    try {
      const response = await disabled.app.inject({ method: 'GET', url: '/v1/config' });
      expect(response.json().sync.enabled).toBe(false);
    } finally {
      await disabled.close();
    }
  });
});
