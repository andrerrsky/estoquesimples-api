import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OpsService } from '../../src/modules/ops/ops.service.js';
import { resetMetrics } from '../../src/platform/observability/metrics.js';
import {
  createTestApp,
  registerUser,
  resetDatabase,
  type TestContext,
} from '../helpers/test-app.js';

const OPS_TOKEN = 'token-de-operacao-com-tamanho-suficiente';

let context: TestContext;
const auth = { authorization: `Bearer ${OPS_TOKEN}` };

beforeAll(async () => {
  context = await createTestApp({ OPS_TOKEN });
});

afterAll(async () => {
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
  resetMetrics();
});

describe('proteção dos endpoints de operação', () => {
  it('recusa acesso sem o token de operação', async () => {
    for (const url of ['/metrics', '/ops/status', '/ops/config/sync']) {
      const response = await context.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
    }
  });

  it('recusa o token de um usuário comum', async () => {
    const user = await registerUser(context);
    const response = await context.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: user.authHeader,
    });
    expect(response.statusCode).toBe(401);
  });

  /**
   * Sem OPS_TOKEN configurado o endereço responde 404 em vez de ficar aberto.
   * /metrics público entrega volume de clientes e ritmo de uso a qualquer um.
   */
  it('some quando não há token configurado', async () => {
    const semToken = await createTestApp();
    try {
      const response = await semToken.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: auth,
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await semToken.close();
    }
  });
});

describe('métricas', () => {
  it('conta as requisições atendidas com a rota registrada, não a URL', async () => {
    const user = await registerUser(context);
    await context.app.inject({ method: 'GET', url: '/v1/me', headers: user.authHeader });

    const response = await context.app.inject({ method: 'GET', url: '/metrics', headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');

    const corpo = response.body;
    expect(corpo).toContain('http_requests_total');
    expect(corpo).toContain('route="/v1/me"');
    expect(corpo).toContain('http_request_duration_seconds_bucket');
  });

  it('não cria uma série por empresa', async () => {
    const user = await registerUser(context);
    const empresas: string[] = [];

    for (const nome of ['Loja A', 'Loja B']) {
      const criada = await context.app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: user.authHeader,
        payload: { name: nome },
      });
      empresas.push(criada.json().id);
    }

    const renovado = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    const token = { authorization: `Bearer ${renovado.json().accessToken}` };

    for (const id of empresas) {
      await context.app.inject({ method: 'GET', url: `/v1/workspaces/${id}`, headers: token });
    }

    const corpo = (await context.app.inject({ method: 'GET', url: '/metrics', headers: auth })).body;
    for (const id of empresas) {
      expect(corpo).not.toContain(id);
    }
    expect(corpo).toContain('route="/v1/workspaces/:workspaceId"');
  });

  it('publica os números lidos do banco', async () => {
    const corpo = (await context.app.inject({ method: 'GET', url: '/metrics', headers: auth })).body;

    expect(corpo).toContain('# TYPE jobs_pending gauge');
    expect(corpo).toContain('subscriptions_unverified');
    expect(corpo).toContain('sync_conflicts_pending');
  });
});

describe('retrato do sistema', () => {
  it('responde sem alertas num banco saudável', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/ops/status',
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().alertas).toEqual([]);
    expect(response.json().snapshot.jobsFalhos).toBe(0);
  });

  it('avisa quando uma tarefa esgota as tentativas', async () => {
    await context.services.db.execute(sql`
      INSERT INTO jobs (kind, payload, attempts, max_attempts, failed_at, last_error)
      VALUES ('teste.falha', '{}'::jsonb, 5, 5, now(), 'falhou de propósito')
    `);

    const response = await context.app.inject({
      method: 'GET',
      url: '/ops/status',
      headers: auth,
    });

    const alertas = response.json().alertas.map((alerta: { nome: string }) => alerta.nome);
    expect(alertas).toContain('jobs_falhos');
  });

  /**
   * Assinatura ativa sem confirmação recente no Google significa acesso
   * possivelmente concedido a quem já cancelou — o oposto do que a Fase 3 se
   * propôs a garantir.
   */
  it('avisa sobre assinatura ativa sem verificação recente', async () => {
    const owner = await registerUser(context);
    const empresa = await context.app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: owner.authHeader,
      payload: { name: 'Loja com assinatura' },
    });

    const sealed = context.services.purchaseTokens;
    const token = 'token-antigo-de-teste';
    await context.services.db.execute(sql`
      INSERT INTO subscriptions (
        workspace_id, plan_key, purchase_token_hash, purchase_token_enc,
        google_product_id, state, last_verified_at
      ) VALUES (
        ${empresa.json().id}::uuid, 'basico',
        ${sealed.hash(token)}, ${sealed.encrypt(token)},
        'assinatura', 'ativa', now() - interval '5 days'
      )
    `);

    const status = await context.app.inject({
      method: 'GET',
      url: '/ops/status',
      headers: auth,
    });

    const alertas = status.json().alertas.map((alerta: { nome: string }) => alerta.nome);
    expect(alertas).toContain('assinaturas_sem_verificacao');
    expect(status.json().snapshot.assinaturasDesatualizadas).toBe(1);
  });

  it('o vigia enxerga exatamente o que o endpoint mostra', async () => {
    const service = new OpsService(context.services);
    const snapshot = await service.snapshot();
    expect(service.alertas(snapshot)).toEqual([]);
  });
});

describe('interruptor de sincronização', () => {
  it('desliga a sincronização de todos os aparelhos sem redeploy', async () => {
    const antes = await context.app.inject({ method: 'GET', url: '/v1/config' });
    expect(antes.json().sync.enabled).toBe(true);

    const desliga = await context.app.inject({
      method: 'PUT',
      url: '/ops/config/sync',
      headers: auth,
      payload: { enabled: false, minAppVersionCode: 0 },
    });
    expect(desliga.statusCode).toBe(200);

    const depois = await context.app.inject({ method: 'GET', url: '/v1/config' });
    expect(depois.json().sync.enabled).toBe(false);
  });

  it('restringe a sincronização por versão do app durante o lançamento', async () => {
    await context.app.inject({
      method: 'PUT',
      url: '/ops/config/sync',
      headers: auth,
      payload: { enabled: true, minAppVersionCode: 23 },
    });

    const config = await context.app.inject({ method: 'GET', url: '/v1/config' });
    expect(config.json().sync.minAppVersionCode).toBe(23);

    const vigente = await context.app.inject({
      method: 'GET',
      url: '/ops/config/sync',
      headers: auth,
    });
    expect(vigente.json()).toMatchObject({ origem: 'banco', minAppVersionCode: 23 });
  });

  it('sem valor gravado, vale o ambiente', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/ops/config/sync',
      headers: auth,
    });
    expect(response.json().origem).toBe('ambiente');
  });
});

describe('verificação de backup', () => {
  it('começa fora do prazo enquanto nenhuma restauração foi exercitada', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/ops/backup',
      headers: auth,
    });

    expect(response.json()).toMatchObject({ verificadoEm: null, dentroDoPrazo: false });
  });

  it('registra o exercício e passa a considerá-lo em dia', async () => {
    const registro = await context.app.inject({
      method: 'POST',
      url: '/ops/backup',
      headers: auth,
      payload: {
        origem: 'backup-2026-08-04.dump',
        tabelas: 24,
        registros: 1200,
        duracaoSegundos: 42.5,
      },
    });
    expect(registro.statusCode).toBe(200);

    const consulta = await context.app.inject({
      method: 'GET',
      url: '/ops/backup',
      headers: auth,
    });
    expect(consulta.json().dentroDoPrazo).toBe(true);
    expect(consulta.json().detalhes.registros).toBe(1200);
    expect(consulta.json().horasDesdeVerificacao).toBe(0);
  });
});
