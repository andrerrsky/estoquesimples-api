import { sql } from 'drizzle-orm';

import type { AppServices } from '../../platform/http/context.js';
import type { GaugeSample } from '../../platform/observability/metrics.js';

/**
 * Retrato do sistema lido do banco.
 *
 * Existe separado das métricas acumuladas em memória porque estes números não
 * são eventos: são estados que precisam estar corretos mesmo depois de um
 * reinício. Uma fila com tarefas travadas continua travada depois do deploy,
 * e um contador zerado esconderia isso.
 */
export interface OpsSnapshot extends Record<string, number> {
  jobsPendentes: number;
  jobsAtrasados: number;
  jobsFalhos: number;
  conflitosPendentes: number;
  conflitosAntigos: number;
  assinaturasAtivas: number;
  assinaturasDesatualizadas: number;
  empresasAtivas: number;
  dispositivosAtivos7d: number;
  operacoesSync24h: number;
}

const ATRASO_TOLERADO = "interval '15 minutes'";
const CONFLITO_ANTIGO = "interval '7 days'";
const ASSINATURA_DESATUALIZADA = "interval '48 hours'";

/** Os mesmos estados que concedem acesso em billing.service. */
const ESTADOS_COM_ACESSO = "ARRAY['ativa','carencia','cancelada_mas_ativa']";

export class OpsService {
  constructor(private readonly services: AppServices) {}

  async snapshot(): Promise<OpsSnapshot> {
    const { db } = this.services;

    // Uma consulta só: são contagens pequenas, e ir sete vezes ao banco a cada
    // coleta do Prometheus multiplicaria por sete o custo do monitoramento.
    const resultado = await db.execute<Record<string, string>>(sql`
      SELECT
        (SELECT count(*) FROM jobs
          WHERE completed_at IS NULL AND failed_at IS NULL) AS jobs_pendentes,
        (SELECT count(*) FROM jobs
          WHERE completed_at IS NULL AND failed_at IS NULL
            AND run_at < now() - ${sql.raw(ATRASO_TOLERADO)}) AS jobs_atrasados,
        (SELECT count(*) FROM jobs WHERE failed_at IS NOT NULL) AS jobs_falhos,
        (SELECT count(*) FROM conflict_log WHERE status = 'pendente') AS conflitos_pendentes,
        (SELECT count(*) FROM conflict_log
          WHERE status = 'pendente'
            AND created_at < now() - ${sql.raw(CONFLITO_ANTIGO)}) AS conflitos_antigos,
        (SELECT count(*) FROM subscriptions
          WHERE state = ANY(${sql.raw(ESTADOS_COM_ACESSO)})) AS assinaturas_ativas,
        (SELECT count(*) FROM subscriptions
          WHERE state = ANY(${sql.raw(ESTADOS_COM_ACESSO)})
            AND last_verified_at < now() - ${sql.raw(ASSINATURA_DESATUALIZADA)})
          AS assinaturas_desatualizadas,
        (SELECT count(*) FROM workspaces WHERE deleted_at IS NULL) AS empresas_ativas,
        (SELECT count(*) FROM devices
          WHERE revoked_at IS NULL AND last_seen_at > now() - interval '7 days')
          AS dispositivos_ativos,
        (SELECT count(*) FROM sync_operations
          WHERE created_at > now() - interval '24 hours') AS operacoes_sync
    `);

    const linha = resultado.rows[0] ?? {};
    const numero = (chave: string): number => Number(linha[chave] ?? 0);

    return {
      jobsPendentes: numero('jobs_pendentes'),
      jobsAtrasados: numero('jobs_atrasados'),
      jobsFalhos: numero('jobs_falhos'),
      conflitosPendentes: numero('conflitos_pendentes'),
      conflitosAntigos: numero('conflitos_antigos'),
      assinaturasAtivas: numero('assinaturas_ativas'),
      assinaturasDesatualizadas: numero('assinaturas_desatualizadas'),
      empresasAtivas: numero('empresas_ativas'),
      dispositivosAtivos7d: numero('dispositivos_ativos'),
      operacoesSync24h: numero('operacoes_sync'),
    };
  }

  async gauges(): Promise<GaugeSample[]> {
    const estado = await this.snapshot();
    return [
      { name: 'jobs_pending', help: 'Tarefas na fila aguardando execução', value: estado.jobsPendentes },
      { name: 'jobs_overdue', help: 'Tarefas com horário de execução vencido', value: estado.jobsAtrasados },
      { name: 'jobs_failed', help: 'Tarefas que esgotaram as tentativas', value: estado.jobsFalhos },
      { name: 'sync_conflicts_pending', help: 'Conflitos aguardando decisão', value: estado.conflitosPendentes },
      {
        name: 'sync_conflicts_pending_old',
        help: 'Conflitos pendentes há mais de sete dias',
        value: estado.conflitosAntigos,
      },
      { name: 'subscriptions_active', help: 'Assinaturas ativas', value: estado.assinaturasAtivas },
      {
        name: 'subscriptions_unverified',
        help: 'Assinaturas ativas sem verificação recente no Google Play',
        value: estado.assinaturasDesatualizadas,
      },
      { name: 'workspaces_active', help: 'Empresas não excluídas', value: estado.empresasAtivas },
      {
        name: 'devices_active_7d',
        help: 'Aparelhos que sincronizaram nos últimos sete dias',
        value: estado.dispositivosAtivos7d,
      },
      {
        name: 'sync_operations_24h',
        help: 'Operações de sincronização recebidas nas últimas 24 horas',
        value: estado.operacoesSync24h,
      },
    ];
  }

  /**
   * Condições que merecem alguém acordado.
   *
   * A lista é curta de propósito. Alerta que dispara toda semana por algo que
   * ninguém trata deixa de ser lido, e o primeiro incidente de verdade passa
   * despercebido junto com ele.
   */
  alertas(estado: OpsSnapshot): { nome: string; detalhe: string }[] {
    const encontrados: { nome: string; detalhe: string }[] = [];

    if (estado.jobsFalhos > 0) {
      encontrados.push({
        nome: 'jobs_falhos',
        detalhe: `${estado.jobsFalhos} tarefa(s) esgotaram as tentativas e não serão repetidas.`,
      });
    }
    if (estado.jobsAtrasados > 20) {
      encontrados.push({
        nome: 'fila_atrasada',
        detalhe: `${estado.jobsAtrasados} tarefas vencidas: a fila não está sendo consumida.`,
      });
    }
    if (estado.assinaturasDesatualizadas > 0) {
      encontrados.push({
        nome: 'assinaturas_sem_verificacao',
        detalhe:
          `${estado.assinaturasDesatualizadas} assinatura(s) ativas sem confirmação do Google Play ` +
          'há mais de 48 horas. Acesso pode estar sendo concedido indevidamente.',
      });
    }
    if (estado.conflitosAntigos > 0) {
      encontrados.push({
        nome: 'conflitos_esquecidos',
        detalhe:
          `${estado.conflitosAntigos} conflito(s) pendentes há mais de sete dias. ` +
          'Enquanto não são resolvidos, os aparelhos seguem com dados divergentes.',
      });
    }

    return encontrados;
  }
}
