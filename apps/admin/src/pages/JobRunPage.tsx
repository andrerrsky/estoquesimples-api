import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { Badge, Card, ConfirmDialog, Empty, errorMessage, KeyValue, Notice, PageHeader, Skeleton, Time, useToast } from '../components/ui';
import { fmtDateTime, fmtDuration } from '../lib/format';
import { JOB_KIND, JOB_STATUS } from '../lib/labels';

interface JobDetail {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  uniqueKey: string | null;
  runAt: string;
  attempts: number;
  maxAttempts: number;
  lockedAt: string | null;
  lockedBy: string | null;
  completedAt: string | null;
  failedAt: string | null;
  lastError: string | null;
  progress: string | null;
  progressAt: string | null;
  dismissedAt: string | null;
  dismissedBy: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'dismissed';
}

interface LogLine {
  id: number;
  attempt: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  at: string;
}

interface JobResponse {
  job: JobDetail;
  logs: LogLine[];
  serverTime: string;
}

const ACTIVE = new Set(['pending', 'running']);

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function elapsed(fromIso: string | null, toIso?: string | null): string {
  if (!fromIso) return '—';
  const end = toIso ? new Date(toIso).getTime() : Date.now();
  return fmtDuration(Math.max(0, Math.round((end - new Date(fromIso).getTime()) / 1000)));
}

/**
 * Uma execução da fila, no estilo de um build do Jenkins: o estado fica fixo
 * no topo (não some quando a tarefa termina), o passo atual aparece em
 * destaque e o log de todas as tentativas corre embaixo, atualizado a cada
 * 2 s enquanto a tarefa está na fila ou rodando. Dá para deixar a página
 * aberta e acompanhar do início ao fim.
 */
export function JobRunPage() {
  const { jobId = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [logs, setLogs] = useState<LogLine[]>([]);
  const lastId = useRef(0);
  const [follow, setFollow] = useState(true);
  const consoleRef = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  useEffect(() => {
    setLogs([]);
    lastId.current = 0;
  }, [jobId]);

  const query = useQuery({
    queryKey: ['ops', 'job', jobId],
    queryFn: async () => {
      const data = await api.get<JobResponse>(`/ops/jobs/${jobId}`, lastId.current ? { after: lastId.current } : undefined);
      if (data.logs.length > 0) {
        lastId.current = data.logs[data.logs.length - 1]!.id;
        setLogs((previous) => [...previous, ...data.logs]);
      }
      return data;
    },
    refetchInterval: (state) => (state.state.data && ACTIVE.has(state.state.data.job.status) ? 2_000 : 15_000),
  });
  const job = query.data?.job;
  const active = job ? ACTIVE.has(job.status) : false;

  // Cronômetro do topo andando enquanto roda.
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  // Segue o fim do log, como o console do Jenkins; rolar para cima pausa.
  useEffect(() => {
    if (follow && consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [logs, follow]);

  const retry = useMutation({
    mutationFn: () => api.post(`/ops/jobs/${jobId}/retry`),
    onSuccess: () => {
      toast.push('Tarefa recolocada na fila. Acompanhe aqui.', 'success');
      setFollow(true);
      void queryClient.invalidateQueries({ queryKey: ['ops'] });
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  if (query.isLoading) {
    return (
      <div className="page">
        <Skeleton lines={8} />
      </div>
    );
  }
  if (query.isError || !job) {
    return (
      <div className="page">
        <Empty icon="alert" title="Tarefa não encontrada">
          <Link to="/operacao">Voltar para a fila</Link>
        </Empty>
      </div>
    );
  }

  const status = JOB_STATUS[job.status];
  const postId = typeof job.result?.['postId'] === 'string' ? (job.result['postId'] as string) : null;
  const finishedAt = job.completedAt ?? job.failedAt ?? job.dismissedAt;
  const attempts = [...new Set(logs.map((line) => line.attempt))];

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: 'Operação', to: '/operacao' }, { label: 'Fila de tarefas', to: '/operacao' }, { label: JOB_KIND[job.kind] ?? job.kind }]}
        title={JOB_KIND[job.kind] ?? job.kind}
        subtitle={<span className="mono">{job.uniqueKey ?? job.id}</span>}
        actions={
          <div className="row" style={{ gap: 8 }}>
            {postId && (
              <button type="button" className="btn btn--primary" onClick={() => navigate(`/blog/${postId}`)}>
                <Icon name="note" size={16} /> Abrir o post
              </button>
            )}
            {can('support') && (job.status === 'failed' || job.status === 'dismissed') && (
              <button type="button" className="btn btn--secondary" onClick={() => retry.mutate()} disabled={retry.isPending}>
                <Icon name="refresh" size={16} /> {retry.isPending ? 'Recolocando…' : 'Repetir'}
              </button>
            )}
            {can('support') && job.status === 'failed' && (
              <button type="button" className="btn btn--ghost" onClick={() => setDismissOpen(true)}>Ignorar</button>
            )}
            {can('support') && job.status === 'pending' && (
              <button type="button" className="btn btn--ghost" onClick={() => setCancelOpen(true)}>Cancelar</button>
            )}
          </div>
        }
      />

      <div className={`job-status job-status--${job.status}`} role="status" aria-live="polite">
        <span className="job-status__icon" aria-hidden="true">
          {active ? <span className="job-status__spinner" /> : <Icon name={job.status === 'completed' ? 'check' : job.status === 'dismissed' ? 'eyeOff' : 'alert'} size={22} />}
        </span>
        <div className="job-status__text">
          <div className="job-status__title">
            {job.status === 'pending' && 'Na fila, aguardando o próximo ciclo (até 5 s)'}
            {job.status === 'running' && (job.progress ?? 'Executando')}
            {job.status === 'completed' && 'Concluída'}
            {job.status === 'failed' && 'Falhou'}
            {job.status === 'dismissed' && 'Falha ignorada'}
          </div>
          <div className="job-status__sub">
            {job.status === 'running' && <>tentativa {job.attempts} de {job.maxAttempts} · rodando há {elapsed(job.lockedAt)}{job.progressAt && <> · passo atual há {elapsed(job.progressAt)}</>}</>}
            {job.status === 'pending' && <>agendada para {fmtDateTime(job.runAt)}{job.attempts > 0 && <> · já teve {job.attempts} tentativa(s)</>}</>}
            {(job.status === 'completed' || job.status === 'failed') && <>{job.attempts} tentativa(s) · terminou {fmtDateTime(finishedAt)}</>}
            {job.status === 'dismissed' && <>por {job.dismissedBy ?? '—'} em {fmtDateTime(job.dismissedAt)}</>}
          </div>
        </div>
        <Badge tone={status?.tone}>{status?.label ?? job.status}</Badge>
      </div>

      {job.status === 'failed' && job.lastError && <Notice tone="error" title="Erro da última tentativa">{job.lastError}</Notice>}

      <div className="grid grid--2-1">
        <Card
          title="Log"
          subtitle={active ? 'Atualiza a cada 2 s enquanto a tarefa roda' : 'Todas as tentativas desta tarefa'}
          flush
          actions={
            <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> Seguir o fim
            </label>
          }
        >
          <div
            ref={consoleRef}
            className="job-console"
            onScroll={(event) => {
              const el = event.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              if (!atBottom && follow) setFollow(false);
            }}
          >
            {logs.length === 0 ? (
              <div className="job-console__empty">{active ? 'Aguardando a primeira linha…' : 'Sem log para esta tarefa (execuções anteriores a 04/11/2026 não gravavam log).'}</div>
            ) : (
              logs.map((line, index) => (
                <div key={line.id}>
                  {(index === 0 || logs[index - 1]!.attempt !== line.attempt) && attempts.length > 1 && (
                    <div className="job-console__divider">— tentativa {line.attempt} —</div>
                  )}
                  <div className={`job-console__line job-console__line--${line.level}`}>
                    <span className="job-console__time">{clock(line.at)}</span>
                    <span className="job-console__msg">{line.message}</span>
                  </div>
                </div>
              ))
            )}
            {active && <div className="job-console__cursor" aria-hidden="true">▍</div>}
          </div>
        </Card>

        <div className="stack">
          <Card title="Detalhes">
            <KeyValue
              items={[
                { label: 'Situação', value: <Badge tone={status?.tone}>{status?.label ?? job.status}</Badge> },
                { label: 'Criada', value: <Time value={job.createdAt} /> },
                { label: 'Agendada', value: fmtDateTime(job.runAt) },
                { label: 'Início', value: job.lockedAt ? fmtDateTime(job.lockedAt) : '—' },
                { label: 'Fim', value: finishedAt ? fmtDateTime(finishedAt) : '—' },
                { label: 'Duração', value: job.lockedAt ? elapsed(job.lockedAt, finishedAt) : '—' },
                { label: 'Tentativas', value: `${job.attempts} de ${job.maxAttempts}` },
                { label: 'Instância', value: <span className="mono small">{job.lockedBy ?? '—'}</span> },
              ]}
            />
          </Card>
          {Object.keys(job.payload).length > 0 && (
            <Card title="Parâmetros">
              <pre className="job-json">{JSON.stringify(job.payload, null, 2)}</pre>
            </Card>
          )}
          {job.result && (
            <Card title="Resultado">
              <pre className="job-json">{JSON.stringify(job.result, null, 2)}</pre>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={dismissOpen}
        onClose={() => setDismissOpen(false)}
        title="Ignorar tarefa falha"
        description="A tarefa sai da lista de falhas e do alerta, sem ser repetida. O motivo fica na auditoria."
        confirmLabel="Ignorar"
        onConfirm={async (reason) => {
          await api.post(`/ops/jobs/${jobId}/dismiss`, { reason });
          toast.push('Tarefa descartada.', 'success');
          void queryClient.invalidateQueries({ queryKey: ['ops'] });
        }}
      />
      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancelar tarefa"
        description="A tarefa é marcada como falha e não roda."
        confirmLabel="Cancelar tarefa"
        danger
        onConfirm={async (reason) => {
          await api.post(`/ops/jobs/${jobId}/cancel`, { reason });
          toast.push('Tarefa cancelada.', 'success');
          void queryClient.invalidateQueries({ queryKey: ['ops'] });
        }}
      />
    </div>
  );
}
