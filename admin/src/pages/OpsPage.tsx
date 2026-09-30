import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api, type Paginated } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { Badge, Card, ConfirmDialog, Details, Empty, errorMessage, KeyValue, Notice, PageHeader, Pagination, Props, Skeleton, StatTile, Time, useToast } from '../components/ui';
import { fmtDuration, fmtNumber } from '../lib/format';
import { JOB_KIND, JOB_STATUS } from '../lib/labels';

interface OpsStatus {
  generatedAt: string;
  snapshot: Record<string, number>;
  alerts: Array<{ nome: string; detalhe: string }>;
  environment: Record<string, string | number | boolean>;
  sync: { enabled: boolean; minAppVersionCode: number; source: string; updatedAt: string | null };
  backup: { verifiedAt: string | null; hoursSince: number | null; withinLimit: boolean; maxAgeHours: number; details: Record<string, unknown> };
  migrations: Array<{ version: number; name: string; applied: boolean; reversible: boolean }>;
  jobKinds: Array<{ kind: string; pending: number; failed: number; completed24h: number; lastCompletedAt: string | null; lastError: string | null }>;
}

interface Job {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  uniqueKey: string | null;
  runAt: string;
  attempts: number;
  maxAttempts: number;
  lockedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  lastError: string | null;
  createdAt: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

const ALERT_LABEL: Record<string, string> = {
  jobs_falhos: 'Tarefas falharam',
  fila_atrasada: 'Fila de tarefas atrasada',
  assinaturas_sem_verificacao: 'Assinaturas sem verificação',
  conflitos_esquecidos: 'Conflitos esquecidos',
};

export function OpsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [syncDialog, setSyncDialog] = useState(false);
  const [syncDraft, setSyncDraft] = useState({ enabled: true, minAppVersionCode: 0 });

  const status = useQuery({ queryKey: ['ops', 'status'], queryFn: () => api.get<OpsStatus>('/ops/status'), refetchInterval: 60_000 });
  const data = status.data;
  const s = data?.snapshot ?? {};

  const openSync = () => {
    if (!data) return;
    setSyncDraft({ enabled: data.sync.enabled, minAppVersionCode: data.sync.minAppVersionCode });
    setSyncDialog(true);
  };

  return (
    <div className="page">
      <PageHeader
        title="Operação"
        subtitle={data ? <>Atualizado <Time value={data.generatedAt} /> · API {String(data.environment['nodeEnv'])} v{String(data.environment['version'])} no ar há {fmtDuration(Number(data.environment['uptimeSeconds']))}</> : 'Estado da API e da fila de tarefas'}
        actions={<button type="button" className="btn btn--ghost" onClick={() => void status.refetch()}><Icon name="refresh" /> Atualizar</button>}
      />

      {data && data.alerts.length === 0 && <Notice tone="success" title="Sem alertas">Fila, assinaturas e conflitos dentro do esperado.</Notice>}
      {data?.alerts.map((alert) => (
        <Notice key={alert.nome} tone="warning" title={ALERT_LABEL[alert.nome] ?? alert.nome}>{alert.detalhe}</Notice>
      ))}

      <div className="grid grid--tiles">
        <StatTile label="Tarefas na fila" value={fmtNumber(s['jobsPendentes'])} foot={`${fmtNumber(s['jobsAtrasados'] ?? 0)} atrasadas`} tone={(s['jobsAtrasados'] ?? 0) > 20 ? 'alert' : undefined} />
        <StatTile label="Tarefas falhas" value={fmtNumber(s['jobsFalhos'])} foot="esgotaram as tentativas" tone={(s['jobsFalhos'] ?? 0) > 0 ? 'alert' : undefined} />
        <StatTile label="Conflitos pendentes" value={fmtNumber(s['conflitosPendentes'])} foot={`${fmtNumber(s['conflitosAntigos'] ?? 0)} há mais de 7 dias`} tone={(s['conflitosAntigos'] ?? 0) > 0 ? 'alert' : undefined} />
        <StatTile label="Assinaturas sem verificação" value={fmtNumber(s['assinaturasDesatualizadas'])} foot="ativas, sem confirmação há 48h" tone={(s['assinaturasDesatualizadas'] ?? 0) > 0 ? 'alert' : undefined} />
        <StatTile label="Aparelhos ativos (7d)" value={fmtNumber(s['dispositivosAtivos7d'])} foot={`${fmtNumber(s['operacoesSync24h'] ?? 0)} operações de sync em 24h`} />
      </div>

      <div className="grid grid--2">
        <Card
          title="Sincronização"
          subtitle="Interruptor de emergência: vale em segundos, sem deploy nem nova versão do app"
          actions={can('owner') && data && <button type="button" className="btn btn--secondary btn--sm" onClick={openSync}>Alterar</button>}
        >
          {data ? (
            <KeyValue
              items={[
                { label: 'Situação', value: data.sync.enabled ? <Badge tone="success">ligada</Badge> : <Badge tone="error">desligada</Badge> },
                { label: 'Versão mínima do app', value: data.sync.minAppVersionCode === 0 ? 'qualquer' : `versionCode ≥ ${data.sync.minAppVersionCode}` },
                { label: 'Origem', value: data.sync.source === 'banco' ? <>configuração gravada pelo painel/ops <Time value={data.sync.updatedAt} /></> : 'variável de ambiente' },
                { label: 'Protocolo', value: `v${String(data.environment['syncProtocolVersion'])} (mínimo aceito v${String(data.environment['syncMinSupportedProtocol'])})` },
              ]}
            />
          ) : (
            <Skeleton />
          )}
          <p className="caption" style={{ marginTop: 12 }}>Desligada, o app continua funcionando no aparelho e acumula as alterações; nada é perdido.</p>
        </Card>
        <Card title="Ambiente">
          {data ? (
            <KeyValue
              items={[
                { label: 'Google Play', value: data.environment['playConfigured'] ? <Badge tone="success">configurado</Badge> : <Badge tone="warning">sem conta de serviço</Badge> },
                { label: 'E-mail', value: String(data.environment['emailProvider']) },
                { label: 'Fila de tarefas', value: data.environment['jobsEnabled'] ? 'ligada nesta instância' : <Badge tone="warning">desligada nesta instância</Badge> },
                { label: 'Token de operação', value: data.environment['opsTokenConfigured'] ? 'configurado (/metrics, /ops)' : <Badge tone="warning">ausente: /metrics responde 404</Badge> },
                { label: 'Retenção de eventos', value: `${String(data.environment['analyticsRetentionDays'])} dias` },
                { label: 'Backup verificado', value: data.backup.verifiedAt ? <>{data.backup.withinLimit ? <Badge tone="success">em dia</Badge> : <Badge tone="error">vencido</Badge>} há {data.backup.hoursSince}h (limite {data.backup.maxAgeHours}h)</> : <Badge tone="warning">nunca verificado</Badge> },
              ]}
            />
          ) : (
            <Skeleton />
          )}
          {data && Object.keys(data.backup.details).length > 0 && (
            <div style={{ marginTop: 10 }}>
              <Details summary="detalhes do último exercício de restauração"><Props value={data.backup.details} /></Details>
            </div>
          )}
        </Card>
      </div>

      <Card title="Tarefas por tipo" subtitle="Rotinas periódicas da API">
        {data ? (
          <div className="table-wrap">
            <table className="table table--compact">
              <thead><tr><th>Tarefa</th><th className="num">Na fila</th><th className="num">Falhas</th><th className="num">Concluídas 24h</th><th>Última conclusão</th><th>Último erro</th></tr></thead>
              <tbody>
                {data.jobKinds.map((kind) => (
                  <tr key={kind.kind}>
                    <td><div className="cell-main">{JOB_KIND[kind.kind] ?? kind.kind}</div><div className="cell-sub"><code>{kind.kind}</code></div></td>
                    <td className="num">{fmtNumber(kind.pending)}</td>
                    <td className="num" style={{ color: kind.failed > 0 ? 'var(--error)' : undefined }}>{fmtNumber(kind.failed)}</td>
                    <td className="num">{fmtNumber(kind.completed24h)}</td>
                    <td><Time value={kind.lastCompletedAt} /></td>
                    <td className="muted small" style={{ maxWidth: 360 }}>{kind.lastError ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Skeleton />
        )}
      </Card>

      <JobsCard />

      <Card title="Migrations" subtitle="Schema aplicado neste banco">
        {data ? (
          <div className="row">
            {data.migrations.map((migration) => (
              <Badge key={migration.version} tone={migration.applied ? 'success' : 'warning'} plain>
                {String(migration.version).padStart(4, '0')}_{migration.name}{!migration.reversible && ' (irreversível)'}
              </Badge>
            ))}
          </div>
        ) : (
          <Skeleton />
        )}
      </Card>

      <ConfirmDialog
        open={syncDialog}
        onClose={() => setSyncDialog(false)}
        title="Alterar sincronização"
        description="Vale para todos os aparelhos imediatamente. Use para incidentes ou para liberar uma versão nova aos poucos."
        confirmLabel="Aplicar"
        danger={!syncDraft.enabled}
        confirmWord={syncDraft.enabled ? undefined : 'desligar'}
        onConfirm={async (reason) => {
          await api.put('/ops/sync', { ...syncDraft, reason });
          toast.push('Configuração de sincronização aplicada.', 'success');
          void queryClient.invalidateQueries({ queryKey: ['ops'] });
        }}
      >
        <label className="checkbox"><input type="checkbox" checked={syncDraft.enabled} onChange={(event) => setSyncDraft({ ...syncDraft, enabled: event.target.checked })} /> sincronização ligada</label>
        <label className="field">
          <span className="field__label">Versão mínima do app (versionCode; 0 = qualquer)</span>
          <input className="input" type="number" min={0} value={syncDraft.minAppVersionCode} onChange={(event) => setSyncDraft({ ...syncDraft, minAppVersionCode: Number(event.target.value) || 0 })} />
        </label>
      </ConfirmDialog>
    </div>
  );
}

function JobsCard() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<'failed' | 'pending' | 'completed' | ''>('failed');
  const [page, setPage] = useState(1);
  const [cancelId, setCancelId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['ops', 'jobs', filter, page],
    queryFn: () => api.get<Paginated<Job>>('/ops/jobs', { status: filter || undefined, page, pageSize: 25 }),
    placeholderData: (previous) => previous,
  });

  const retry = async (id: string) => {
    try {
      await api.post(`/ops/jobs/${id}/retry`);
      toast.push('Tarefa recolocada na fila.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['ops'] });
    } catch (error) {
      toast.push(errorMessage(error), 'error');
    }
  };

  return (
    <Card
      title="Fila de tarefas"
      subtitle="Uma tabela no Postgres consumida com SKIP LOCKED; retentativas com backoff"
      flush
      actions={
        <select className="select select--sm" value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setPage(1); }}>
          <option value="failed">Falhas</option>
          <option value="pending">Na fila</option>
          <option value="completed">Concluídas</option>
          <option value="">Todas</option>
        </select>
      }
    >
      <div className="table-wrap">
        <table className="table table--compact">
          <thead><tr><th>Tarefa</th><th>Situação</th><th className="num">Tentativas</th><th>Agendada</th><th>Terminou</th><th>Erro</th><th></th></tr></thead>
          <tbody>
            {query.isLoading ? (
              <tr><td colSpan={7}><Skeleton /></td></tr>
            ) : (query.data?.items.length ?? 0) === 0 ? (
              <tr><td colSpan={7}><Empty icon="check" title="Nenhuma tarefa nesta lista" /></td></tr>
            ) : (
              query.data?.items.map((job) => (
                <tr key={job.id}>
                  <td><div className="cell-main">{JOB_KIND[job.kind] ?? job.kind}</div>{job.uniqueKey && <div className="cell-sub mono">{job.uniqueKey}</div>}</td>
                  <td><Badge tone={JOB_STATUS[job.status]?.tone}>{JOB_STATUS[job.status]?.label}</Badge></td>
                  <td className="num">{job.attempts}/{job.maxAttempts}</td>
                  <td><Time value={job.runAt} /></td>
                  <td><Time value={job.completedAt ?? job.failedAt} /></td>
                  <td className="muted small" style={{ maxWidth: 320 }}>{job.lastError ?? '—'}</td>
                  <td className="nowrap">
                    {can('support') && job.status === 'failed' && <button type="button" className="btn btn--ghost btn--sm" onClick={() => void retry(job.id)}>Repetir</button>}
                    {can('support') && job.status === 'pending' && <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCancelId(job.id)}>Cancelar</button>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {query.data && <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={setPage} />}
      <ConfirmDialog
        open={cancelId !== null}
        onClose={() => setCancelId(null)}
        title="Cancelar tarefa"
        description="A tarefa é marcada como falha e não roda. Rotinas periódicas se reagendam sozinhas na próxima execução."
        confirmLabel="Cancelar tarefa"
        danger
        onConfirm={async (reason) => {
          if (!cancelId) return;
          await api.post(`/ops/jobs/${cancelId}/cancel`, { reason });
          toast.push('Tarefa cancelada.', 'success');
          void queryClient.invalidateQueries({ queryKey: ['ops'] });
        }}
      />
    </Card>
  );
}
