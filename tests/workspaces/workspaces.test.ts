import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withTenant } from '../../src/platform/db/client.js';
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

async function createWorkspace(user: RegisteredUser, name = 'Minha Loja'): Promise<string> {
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

/**
 * Adiciona um usuário existente à empresa com o papel indicado, direto no
 * banco. O fluxo completo de convite é exercitado na suíte da Fase 9; aqui o
 * interesse é a autorização, não o caminho de entrada.
 */
async function addMember(
  workspaceId: string,
  owner: RegisteredUser,
  memberUserId: string,
  role: string,
): Promise<void> {
  await context.services.db.insert(workspaceMembers).values({
    workspaceId,
    userId: memberUserId,
    roleKey: role,
    status: 'active',
    invitedBy: owner.userId,
  });
}

describe('criação de empresa', () => {
  it('define quem criou como proprietário com todas as permissões', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}`,
      headers: owner.authHeader,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.role).toBe('proprietario');
    expect(body.isOwner).toBe(true);
    expect(body.permissions).toContain('workspace.excluir');
    expect(body.permissions).toContain('assinatura.gerenciar');
  });

  it('impede duas empresas com o mesmo nome para o mesmo dono', async () => {
    const owner = await registerUser(context);
    await createWorkspace(owner, 'Loja Central');

    const duplicate = await context.app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: owner.authHeader,
      payload: { name: 'loja central' },
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('DUPLICATE_NAME');
  });

  it('lista apenas as empresas do próprio usuário', async () => {
    const alice = await registerUser(context);
    const bob = await registerUser(context);
    await createWorkspace(alice, 'Loja da Alice');
    await createWorkspace(bob, 'Loja do Bob');

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: alice.authHeader,
    });

    const list = response.json().workspaces;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Loja da Alice');
  });
});

describe('isolamento entre empresas', () => {
  it('nega acesso a empresa da qual o usuário não participa', async () => {
    const alice = await registerUser(context);
    const bob = await registerUser(context);
    const aliceWorkspace = await createWorkspace(alice, 'Loja da Alice');

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${aliceWorkspace}`,
      headers: bob.authHeader,
    });

    // 404 e não 403: confirmar que a empresa existe já seria vazar informação.
    expect(response.statusCode).toBe(404);
  });

  it('bloqueia todas as rotas de empresa para um não membro', async () => {
    const alice = await registerUser(context);
    const bob = await registerUser(context);
    const workspaceId = await createWorkspace(alice);

    const rotas: Array<{ method: 'GET' | 'PATCH' | 'POST' | 'DELETE'; url: string; payload?: unknown }> = [
      { method: 'GET', url: `/v1/workspaces/${workspaceId}` },
      { method: 'GET', url: `/v1/workspaces/${workspaceId}/members` },
      { method: 'GET', url: `/v1/workspaces/${workspaceId}/permissions` },
      { method: 'PATCH', url: `/v1/workspaces/${workspaceId}`, payload: { name: 'Invadida' } },
      {
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/transfer-ownership`,
        payload: { newOwnerUserId: bob.userId },
      },
      { method: 'DELETE', url: `/v1/workspaces/${workspaceId}/members/${alice.userId}` },
    ];

    for (const rota of rotas) {
      const response = await context.app.inject({
        method: rota.method,
        url: rota.url,
        headers: bob.authHeader,
        ...(rota.payload ? { payload: rota.payload } : {}),
      });
      expect([403, 404]).toContain(response.statusCode);
    }
  });

  it('a empresa da Alice permanece intacta após as tentativas do Bob', async () => {
    const alice = await registerUser(context);
    const bob = await registerUser(context);
    const workspaceId = await createWorkspace(alice, 'Nome Original');

    await context.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}`,
      headers: bob.authHeader,
      payload: { name: 'Nome Invadido' },
    });

    const check = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}`,
      headers: alice.authHeader,
    });
    expect(check.json().name).toBe('Nome Original');
  });

  it('não aceita workspaceId forjado no corpo da requisição', async () => {
    const alice = await registerUser(context);
    const bob = await registerUser(context);
    const aliceWorkspace = await createWorkspace(alice);
    const bobWorkspace = await createWorkspace(bob);

    // Bob tenta usar a própria URL mas injetar o workspace da Alice no corpo.
    const response = await context.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${bobWorkspace}`,
      headers: bob.authHeader,
      payload: { name: 'Renomeada', workspaceId: aliceWorkspace },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');

    const aliceCheck = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${aliceWorkspace}`,
      headers: alice.authHeader,
    });
    expect(aliceCheck.json().name).not.toBe('Renomeada');
  });

  it('RLS impede ler membros de outra empresa mesmo sem filtro na consulta', async () => {
    const alice = await registerUser(context);
    const bob = await registerUser(context);
    const aliceWorkspace = await createWorkspace(alice);
    const bobWorkspace = await createWorkspace(bob);

    // Consulta deliberadamente SEM cláusula de workspace, no contexto do Bob.
    // A política de RLS é a única coisa entre esta query e os dados da Alice.
    const rows = await withTenant(
      context.services.db,
      { workspaceId: bobWorkspace, userId: bob.userId },
      async (tx) => tx.select().from(workspaceMembers),
    );

    const workspaceIds = new Set(rows.map((row) => row.workspaceId));
    expect(workspaceIds.has(aliceWorkspace)).toBe(false);
    expect(workspaceIds.has(bobWorkspace)).toBe(true);
  });

  it('RLS bloqueia inserir um membro em outra empresa', async () => {
    const alice = await registerUser(context);
    const bob = await registerUser(context);
    const aliceWorkspace = await createWorkspace(alice);
    const bobWorkspace = await createWorkspace(bob);

    await expect(
      withTenant(
        context.services.db,
        { workspaceId: bobWorkspace, userId: bob.userId },
        async (tx) =>
          tx.insert(workspaceMembers).values({
            workspaceId: aliceWorkspace,
            userId: bob.userId,
            roleKey: 'proprietario',
            status: 'active',
          }),
      ),
    ).rejects.toThrow();
  });

  it('sem workspace definido no contexto, o banco não devolve nada', async () => {
    const alice = await registerUser(context);
    await createWorkspace(alice);

    const rows = await context.services.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      return tx.execute(sql`SELECT * FROM workspace_members`);
    });

    expect(rows.rows).toHaveLength(0);
  });
});

describe('permissões por papel', () => {
  it('operador não consegue alterar configurações da empresa', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    const operatorEmail = uniqueEmail('operador');
    const operator = await registerUser(context, { email: operatorEmail });
    await addMember(workspaceId, owner, operator.userId, 'operador');

    const response = await context.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}`,
      headers: operator.authHeader,
      payload: { name: 'Renomeada pelo operador' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('MISSING_PERMISSION');
    expect(response.json().error.requiredPermission).toBe('workspace.configurar');
  });

  it('somente consulta enxerga produtos mas não pode criar', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    const viewer = await registerUser(context);
    await addMember(workspaceId, owner, viewer.userId, 'consulta');

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/permissions`,
      headers: viewer.authHeader,
    });

    const permissions: string[] = response.json().permissions;
    expect(permissions).toContain('produtos.ver');
    expect(permissions).not.toContain('produtos.criar');
    expect(permissions).not.toContain('membros.convidar');
  });

  it('gerente vê membros mas não pode convidar', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    const manager = await registerUser(context);
    await addMember(workspaceId, owner, manager.userId, 'gerente');

    const permissions: string[] = (
      await context.app.inject({
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/permissions`,
        headers: manager.authHeader,
      })
    ).json().permissions;

    expect(permissions).toContain('membros.ver');
    expect(permissions).not.toContain('membros.convidar');
  });

  it('membro suspenso perde o acesso à empresa', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    const email = uniqueEmail();
    const member = await registerUser(context, { email });
    await addMember(workspaceId, owner, member.userId, 'operador');

    const suspend = await context.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/members/${member.userId}/status`,
      headers: owner.authHeader,
      payload: { status: 'suspended' },
    });
    expect(suspend.statusCode).toBe(200);

    // A suspensão derruba a sessão; ao reautenticar, o acesso é negado.
    const relogged = await loginUser(context, email, VALID_PASSWORD);
    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}`,
      headers: relogged.authHeader,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('MEMBER_SUSPENDED');
  });
});

describe('gestão de membros', () => {
  it('proprietário altera o papel de um membro', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    const email = uniqueEmail();
    const member = await registerUser(context, { email });
    await addMember(workspaceId, owner, member.userId, 'operador');

    const response = await context.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/members/${member.userId}/role`,
      headers: owner.authHeader,
      payload: { role: 'gerente' },
    });
    expect(response.statusCode).toBe(200);

    const relogged = await loginUser(context, email, VALID_PASSWORD);
    const permissions: string[] = (
      await context.app.inject({
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/permissions`,
        headers: relogged.authHeader,
      })
    ).json().permissions;

    expect(permissions).toContain('produtos.excluir');
  });

  it('alterar o papel invalida o token de acesso em uso', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    const member = await registerUser(context);
    await addMember(workspaceId, owner, member.userId, 'operador');

    const before = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/permissions`,
      headers: member.authHeader,
    });
    expect(before.statusCode).toBe(200);

    await context.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/members/${member.userId}/role`,
      headers: owner.authHeader,
      payload: { role: 'consulta' },
    });

    const after = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/permissions`,
      headers: member.authHeader,
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('AUTH_PERMISSION_STALE');

    // O refresh token continua válido e devolve um token com o papel novo.
    const refreshed = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: member.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);

    const withNewToken = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/permissions`,
      headers: { authorization: `Bearer ${refreshed.json().accessToken}` },
    });
    expect(withNewToken.json().role).toBe('consulta');
  });

  it('administrador não pode promover ninguém a proprietário', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    const admin = await registerUser(context);
    const target = await registerUser(context);
    await addMember(workspaceId, owner, admin.userId, 'administrador');
    await addMember(workspaceId, owner, target.userId, 'operador');

    const response = await context.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/members/${target.userId}/role`,
      headers: admin.authHeader,
      payload: { role: 'proprietario' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('administrador não pode promover alguém ao próprio nível', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    const admin = await registerUser(context);
    const target = await registerUser(context);
    await addMember(workspaceId, owner, admin.userId, 'administrador');
    await addMember(workspaceId, owner, target.userId, 'operador');

    const response = await context.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/members/${target.userId}/role`,
      headers: admin.authHeader,
      payload: { role: 'administrador' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('remover um membro encerra as sessões dele na hora', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    const member = await registerUser(context);
    await addMember(workspaceId, owner, member.userId, 'operador');

    const remove = await context.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/members/${member.userId}`,
      headers: owner.authHeader,
    });
    expect(remove.statusCode).toBe(200);

    const afterRemoval = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/permissions`,
      headers: member.authHeader,
    });
    expect(afterRemoval.statusCode).toBe(401);

    // Nem mesmo o refresh token devolve acesso à empresa.
    const refreshed = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: member.refreshToken },
    });
    expect(refreshed.statusCode).toBe(401);
  });

  it('o proprietário não pode ser removido', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);

    const response = await context.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/members/${owner.userId}`,
      headers: owner.authHeader,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('LAST_OWNER');
  });
});

describe('transferência de propriedade', () => {
  it('troca o dono e rebaixa o anterior a administrador', async () => {
    const ownerEmail = uniqueEmail();
    const owner = await registerUser(context, { email: ownerEmail });
    const workspaceId = await createWorkspace(owner);
    const successorEmail = uniqueEmail();
    const successor = await registerUser(context, { email: successorEmail });
    await addMember(workspaceId, owner, successor.userId, 'administrador');

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/transfer-ownership`,
      headers: owner.authHeader,
      payload: { newOwnerUserId: successor.userId },
    });
    expect(response.statusCode).toBe(200);

    const newOwner = await loginUser(context, successorEmail, VALID_PASSWORD);
    const newOwnerView = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}`,
      headers: newOwner.authHeader,
    });
    expect(newOwnerView.json().role).toBe('proprietario');
    expect(newOwnerView.json().isOwner).toBe(true);

    // O antigo dono continua com acesso, agora como administrador.
    const previous = await loginUser(context, ownerEmail, VALID_PASSWORD);
    const previousView = await context.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}`,
      headers: previous.authHeader,
    });
    expect(previousView.json().role).toBe('administrador');
  });

  it('administrador não pode transferir a propriedade', async () => {
    const owner = await registerUser(context);
    const workspaceId = await createWorkspace(owner);
    const admin = await registerUser(context);
    await addMember(workspaceId, owner, admin.userId, 'administrador');

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/transfer-ownership`,
      headers: admin.authHeader,
      payload: { newOwnerUserId: admin.userId },
    });

    expect(response.statusCode).toBe(403);
  });
});
