import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { invites } from '../../src/platform/db/schema/index.js';
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

/**
 * Convidar exige e-mail confirmado. Nos testes, confirmar pelo endpoint real
 * a cada caso só adicionaria ruído: o fluxo de verificação tem suíte própria.
 */
async function confirmarEmail(user: RegisteredUser): Promise<void> {
  await context.services.db.execute(
    sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.userId}::uuid`,
  );
}

/**
 * Cria a empresa sem vincular assinatura. Convidar equipe não depende da nuvem.
 */
async function criarEmpresa(user: RegisteredUser, name = 'Minha Loja'): Promise<string> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: user.authHeader,
    payload: { name },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Falha ao criar workspace: ${response.statusCode} ${response.body}`);
  }
  return response.json().id;
}

/** Extrai o token do corpo do e-mail, que é o único lugar onde ele existe. */
function tokenDoConvite(): string {
  const message = context.mailer.lastOfKind('invite');
  expect(message).toBeDefined();
  const match = message!.text.match(/esinv_[A-Za-z0-9_-]+/);
  expect(match).not.toBeNull();
  return match![0];
}

async function convidar(
  owner: RegisteredUser,
  workspaceId: string,
  email: string,
  roleKey = 'operador',
) {
  return context.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/invites`,
    headers: owner.authHeader,
    payload: { email, roleKey },
  });
}

async function prepararConvite(roleKey = 'operador') {
  const owner = await registerUser(context);
  await confirmarEmail(owner);
  const logado = await loginUser(context, owner.email, owner.password);
  const workspaceId = await criarEmpresa(logado);
  const email = uniqueEmail('convidado');

  const criado = await convidar(logado, workspaceId, email, roleKey);
  expect(criado.statusCode).toBe(201);

  return { owner: logado, workspaceId, email, token: tokenDoConvite() };
}

describe('emissão de convites', () => {
  it('envia o convite por e-mail e guarda apenas o hash do token', async () => {
    const { token, workspaceId, email } = await prepararConvite();

    const [linha] = await context.services.db
      .select({ tokenHash: invites.tokenHash, email: invites.email })
      .from(invites)
      .where(eq(invites.workspaceId, workspaceId));

    expect(linha?.email).toBe(email);
    expect(linha?.tokenHash).not.toContain(token);
    expect(token.startsWith('esinv_')).toBe(true);
  });

  it('exige e-mail confirmado de quem convida', async () => {
    const owner = await registerUser(context);
    const workspaceId = await criarEmpresa(owner);

    const response = await convidar(owner, workspaceId, uniqueEmail('convidado'));
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_EMAIL_NOT_VERIFIED');
  });

  it('impede convidar para um papel igual ou superior ao de quem convida', async () => {
    const { owner, workspaceId } = await prepararConvite();

    const response = await convidar(
      owner,
      workspaceId,
      uniqueEmail('outro'),
      'administrador' as const,
    );
    expect(response.statusCode).toBe(201);

    const proprietario = await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/invites`,
      headers: owner.authHeader,
      payload: { email: uniqueEmail('outro'), roleKey: 'proprietario' },
    });
    expect(proprietario.statusCode).toBe(400);
  });

  it('reconvidar substitui o link anterior em vez de acumular', async () => {
    const { owner, workspaceId, email, token: primeiro } = await prepararConvite();

    const reenvio = await convidar(owner, workspaceId, email);
    expect(reenvio.statusCode).toBe(201);
    const segundo = tokenDoConvite();
    expect(segundo).not.toBe(primeiro);

    const antigo = await context.app.inject({ method: 'GET', url: `/v1/invites/${primeiro}` });
    expect(antigo.statusCode).toBe(410);

    const novo = await context.app.inject({ method: 'GET', url: `/v1/invites/${segundo}` });
    expect(novo.statusCode).toBe(200);
  });

  it('recusa convidar quem já é membro', async () => {
    const { owner, workspaceId, email, token } = await prepararConvite();

    await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      payload: { name: 'Convidado', password: VALID_PASSWORD },
    });

    const repetido = await convidar(owner, workspaceId, email);
    expect(repetido.statusCode).toBe(409);
    expect(repetido.json().error.code).toBe('ALREADY_MEMBER');
  });

  it('não permite convidar quem só tem permissão de leitura', async () => {
    const { owner, workspaceId, token } = await prepararConvite('consulta');

    const aceite = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      payload: { name: 'Somente Consulta', password: VALID_PASSWORD },
    });
    expect(aceite.statusCode).toBe(200);
    const convidado = aceite.json().auth;

    const tentativa = await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/invites`,
      headers: { authorization: `Bearer ${convidado.accessToken}` },
      payload: { email: uniqueEmail('terceiro'), roleKey: 'operador' },
    });
    expect(tentativa.statusCode).toBe(403);
    expect(owner.userId).toBeDefined();
  });
});

describe('consulta do convite', () => {
  it('mostra empresa e papel sem exigir conta', async () => {
    const { token, email } = await prepararConvite('gerente');

    const response = await context.app.inject({ method: 'GET', url: `/v1/invites/${token}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workspaceName: 'Minha Loja',
      roleKey: 'gerente',
      email,
      hasAccount: false,
    });
  });

  it('avisa quando já existe conta com aquele e-mail', async () => {
    const owner = await registerUser(context);
    await confirmarEmail(owner);
    const logado = await loginUser(context, owner.email, owner.password);
    const workspaceId = await criarEmpresa(logado);

    const existente = await registerUser(context);
    expect((await convidar(logado, workspaceId, existente.email)).statusCode).toBe(201);

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/invites/${tokenDoConvite()}`,
    });
    expect(response.json().hasAccount).toBe(true);
  });

  it('devolve 404 para token inexistente', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/invites/esinv_tokenqueNuncaExistiu000000',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('INVITE_INVALID');
  });
});

describe('aceite por quem ainda não tem conta', () => {
  it('cria a senha, entra na empresa e já recebe uma sessão', async () => {
    const { workspaceId, email, token } = await prepararConvite('gerente');

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      payload: {
        name: 'Pessoa Convidada',
        password: VALID_PASSWORD,
        device: { installId: 'convidado-install-1', platform: 'android' },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.workspaceId).toBe(workspaceId);
    expect(body.roleKey).toBe('gerente');
    expect(body.auth.user.email).toBe(email);

    // O token de convite chegou pelo e-mail: exigir uma segunda confirmação
    // pelo mesmo canal não provaria nada.
    expect(body.auth.user.emailVerified).toBe(true);

    const empresas = await context.app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: { authorization: `Bearer ${body.auth.accessToken}` },
    });
    expect(empresas.json().workspaces).toHaveLength(1);
    expect(empresas.json().workspaces[0].role).toBe('gerente');
  });

  it('exige nome e senha de quem não tem conta', async () => {
    const { token } = await prepararConvite();

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('recusa senha fraca sem consumir o convite', async () => {
    const { token } = await prepararConvite();

    const fraca = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      payload: { name: 'Convidado', password: 'senha123' },
    });
    expect(fraca.statusCode).toBe(400);

    const segunda = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      payload: { name: 'Convidado', password: VALID_PASSWORD },
    });
    expect(segunda.statusCode).toBe(200);
  });

  it('o token vale uma única vez', async () => {
    const { token } = await prepararConvite();

    const primeiro = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      payload: { name: 'Convidado', password: VALID_PASSWORD },
    });
    expect(primeiro.statusCode).toBe(200);

    const segundo = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      payload: { name: 'Outro', password: VALID_PASSWORD },
    });
    expect(segundo.statusCode).toBe(410);
    expect(segundo.json().error.code).toBe('INVITE_ALREADY_USED');
  });

  it('recusa convite expirado', async () => {
    const { token } = await prepararConvite();

    await context.services.db.execute(
      sql`UPDATE invites SET expires_at = now() - interval '1 day'`,
    );

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      payload: { name: 'Convidado', password: VALID_PASSWORD },
    });
    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe('INVITE_EXPIRED');
  });
});

describe('aceite por quem já tem conta', () => {
  it('entra na empresa usando a sessão existente', async () => {
    const owner = await registerUser(context);
    await confirmarEmail(owner);
    const dono = await loginUser(context, owner.email, owner.password);
    const workspaceId = await criarEmpresa(dono);

    const existente = await registerUser(context);
    await convidar(dono, workspaceId, existente.email, 'operador');
    const token = tokenDoConvite();

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      headers: existente.authHeader,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().auth).toBeNull();

    // As permissões mudaram, então o access token antigo precisa ser trocado
    // antes de valer de novo.
    const comTokenAntigo = await context.app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: existente.authHeader,
    });
    expect(comTokenAntigo.statusCode).toBe(401);
    expect(comTokenAntigo.json().error.code).toBe('AUTH_PERMISSION_STALE');

    const renovado = await loginUser(context, existente.email, existente.password);
    const empresas = await context.app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: renovado.authHeader,
    });
    expect(empresas.json().workspaces[0].id).toBe(workspaceId);
  });

  it('pede autenticação quando o e-mail já tem conta', async () => {
    const owner = await registerUser(context);
    await confirmarEmail(owner);
    const dono = await loginUser(context, owner.email, owner.password);
    const workspaceId = await criarEmpresa(dono);

    const existente = await registerUser(context);
    await convidar(dono, workspaceId, existente.email);

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${tokenDoConvite()}/accept`,
      payload: { name: 'Qualquer', password: VALID_PASSWORD },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_REQUIRED');
  });

  it('não deixa outra pessoa usar um link repassado', async () => {
    const { token } = await prepararConvite();

    const intruso = await registerUser(context);
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      headers: intruso.authHeader,
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('INVITE_INVALID');

    // O convite continua de pé para quem foi convidado de verdade.
    const ainda = await context.app.inject({ method: 'GET', url: `/v1/invites/${token}` });
    expect(ainda.statusCode).toBe(200);
  });
});

describe('gestão dos convites', () => {
  it('lista convites com o estado atual', async () => {
    const { owner, workspaceId, email } = await prepararConvite();

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/invites`,
      headers: owner.authHeader,
    });

    expect(response.statusCode).toBe(200);
    const lista = response.json().invites;
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ email, roleKey: 'operador', status: 'pendente' });
  });

  it('marca como expirado o convite fora do prazo', async () => {
    const { owner, workspaceId } = await prepararConvite();
    await context.services.db.execute(
      sql`UPDATE invites SET expires_at = now() - interval '1 day'`,
    );

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/invites`,
      headers: owner.authHeader,
    });
    expect(response.json().invites[0].status).toBe('expirado');
  });

  it('cancelar invalida o link imediatamente', async () => {
    const { owner, workspaceId, token } = await prepararConvite();

    const [linha] = await context.services.db
      .select({ id: invites.id })
      .from(invites)
      .where(eq(invites.workspaceId, workspaceId));

    const cancelamento = await context.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/invites/${linha!.id}`,
      headers: owner.authHeader,
    });
    expect(cancelamento.statusCode).toBe(200);

    const aceite = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      payload: { name: 'Convidado', password: VALID_PASSWORD },
    });
    expect(aceite.statusCode).toBe(410);
    expect(aceite.json().error.code).toBe('INVITE_INVALID');
  });

  it('convites de outra empresa não aparecem na lista', async () => {
    const primeira = await prepararConvite();
    const segunda = await prepararConvite();

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${segunda.workspaceId}/invites`,
      headers: segunda.owner.authHeader,
    });

    const emails = response.json().invites.map((convite: { email: string }) => convite.email);
    expect(emails).toContain(segunda.email);
    expect(emails).not.toContain(primeira.email);
  });
});

describe('gestão da equipe pelo aplicativo', () => {
  /**
   * O cliente Android usa HttpURLConnection, que não faz PATCH. As duas rotas
   * de membro aceitam PUT pelo mesmo motivo, e é isso que estes casos fixam:
   * quebrar o alias deixaria o app sem como mudar papéis.
   */
  it('aceita PUT no lugar de PATCH para papel e situação', async () => {
    const { owner, workspaceId, email, token } = await prepararConvite();

    const aceite = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      payload: { name: 'Convidado', password: VALID_PASSWORD },
    });
    const convidado = aceite.json().auth;

    const membros = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/members`,
      headers: owner.authHeader,
    });
    const membro = membros
      .json()
      .members.find((item: { email: string }) => item.email === email);

    const papel = await context.app.inject({
      method: 'PUT',
      url: `/v1/workspaces/${workspaceId}/members/${membro.userId}/role`,
      headers: owner.authHeader,
      payload: { role: 'gerente' },
    });
    expect(papel.statusCode).toBe(200);

    const suspensao = await context.app.inject({
      method: 'PUT',
      url: `/v1/workspaces/${workspaceId}/members/${membro.userId}/status`,
      headers: owner.authHeader,
      payload: { status: 'suspended' },
    });
    expect(suspensao.statusCode).toBe(200);

    // Suspender vale na hora, não no vencimento do token do membro.
    const bloqueado = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${convidado.accessToken}` },
    });
    expect(bloqueado.statusCode).toBeGreaterThanOrEqual(401);

    const reativacao = await context.app.inject({
      method: 'PUT',
      url: `/v1/workspaces/${workspaceId}/members/${membro.userId}/status`,
      headers: owner.authHeader,
      payload: { status: 'active' },
    });
    expect(reativacao.statusCode).toBe(200);

    const renovado = await loginUser(context, email, VALID_PASSWORD);
    const depois = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}`,
      headers: renovado.authHeader,
    });
    expect(depois.statusCode).toBe(200);
    expect(depois.json().role).toBe('gerente');
  });
});

describe('remoção e retorno', () => {
  it('quem foi removido perde o acesso e volta pelo mesmo caminho', async () => {
    const { owner, workspaceId, email, token } = await prepararConvite();

    const aceite = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      payload: { name: 'Convidado', password: VALID_PASSWORD },
    });
    const convidado = aceite.json().auth;

    const membros = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/members`,
      headers: owner.authHeader,
    });
    const membro = membros
      .json()
      .members.find((item: { email: string }) => item.email === email);

    const remocao = await context.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/members/${membro.userId}`,
      headers: owner.authHeader,
    });
    expect(remocao.statusCode).toBe(200);

    // Remover encerra a sessão na hora, não no vencimento do token.
    const depois = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${convidado.accessToken}` },
    });
    expect(depois.statusCode).toBe(401);

    const novoConvite = await convidar(owner, workspaceId, email, 'gerente');
    expect(novoConvite.statusCode).toBe(201);

    const reentrada = await context.app.inject({
      method: 'POST',
      url: `/v1/invites/${tokenDoConvite()}/accept`,
      headers: {
        authorization: `Bearer ${(await loginUser(context, email, VALID_PASSWORD)).accessToken}`,
      },
      payload: {},
    });
    expect(reentrada.statusCode).toBe(200);
    expect(reentrada.json().roleKey).toBe('gerente');
  });
});
