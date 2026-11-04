import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { Badge, Card, ConfirmDialog, Empty, errorMessage, Notice, PageHeader, Skeleton, Time, useToast } from '../components/ui';
import { fmtDuration } from '../lib/format';
import { JOB_KIND } from '../lib/labels';

interface OpenAiStatus {
  configured: boolean;
  hint: string | null;
  updatedAt: string | null;
  model: string;
}

interface AiJob {
  id: string;
  kind: string;
  uniqueKey: string | null;
  attempts: number;
  maxAttempts: number;
  lockedAt: string | null;
  failedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  progress: string | null;
  progressAt: string | null;
  status: string;
}

interface BlogMetaLite {
  settings: { aiEnabled: boolean; aiAutoPublish: boolean };
  nextAiRun: string;
}

/** Tarefas da fila que chamam a OpenAI. */
const AI_JOB_KINDS = ['blog.ai_write'];

function since(iso: string | null): string {
  if (!iso) return '';
  return fmtDuration(Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)));
}

/**
 * Inteligência artificial: a chave da OpenAI (uma só, para blog, avaliações e
 * atendimento), um teste de verdade, onde a IA é usada e o que ela está
 * fazendo agora. Antes a chave ficava escondida dentro de Avaliações.
 */
export function AiPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['settings', 'openai'], queryFn: () => api.get<OpenAiStatus>('/settings/openai') });
  const blog = useQuery({ queryKey: ['blog', 'meta'], queryFn: () => api.get<BlogMetaLite>('/blog/meta') });
  const running = useQuery({
    queryKey: ['ops', 'jobs', 'running', 'ia'],
    queryFn: () => api.get<Paginated<AiJob>>('/ops/jobs', { status: 'running', kind: AI_JOB_KINDS[0], page: 1, pageSize: 5 }),
    refetchInterval: 5_000,
  });
  const recent = useQuery({
    queryKey: ['ops', 'jobs', 'recent', 'ia'],
    queryFn: () => api.get<Paginated<AiJob>>('/ops/jobs', { kind: AI_JOB_KINDS[0], page: 1, pageSize: 8 }),
    refetchInterval: 30_000,
  });

  const configured = status.data?.configured ?? false;
  const uses = [
    {
      title: 'Blog',
      text: blog.data
        ? blog.data.settings.aiEnabled
          ? <>Escreve posts sozinha (terça, quinta e sexta, 9h). Próxima: <Time value={blog.data.nextAiRun} relative={false} />. {blog.data.settings.aiAutoPublish ? 'Publica direto.' : 'Sai como rascunho para revisão.'}</>
          : 'Geração automática desligada; o botão "Escrever com IA" continua disponível.'
        : '…',
      to: '/blog?tab=ia',
      action: 'Configurar o blog',
    },
    { title: 'Avaliações', text: 'Rascunho de resposta às avaliações da Play Store; quem responde revisa antes de publicar.', to: '/avaliacoes', action: 'Abrir avaliações' },
    { title: 'Atendimento', text: 'Rascunho da próxima resposta numa solicitação de suporte, a partir da conversa e do diagnóstico do app.', to: '/suporte', action: 'Abrir atendimento' },
  ];

  return (
    <div className="page">
      <PageHeader title="Inteligência artificial" subtitle="Chave da OpenAI e tudo que usa IA no painel" />

      {status.data && !configured && (
        <Notice tone="warning" title="Sem chave da OpenAI">O blog não escreve posts e os rascunhos de avaliações e atendimento ficam desligados até cadastrar a chave abaixo.</Notice>
      )}

      <div className="grid grid--2-1">
        <div className="stack">
          <OpenAiCard status={status.data} canEdit={can('owner')} canTest={can('support')} onChanged={() => void queryClient.invalidateQueries({ queryKey: ['settings'] })} />

          <Card title="Onde a IA é usada" subtitle="Todas usam a mesma chave e o mesmo modelo">
            <div className="stack stack--tight">
              {uses.map((use) => (
                <div key={use.title} className="row" style={{ alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <div className="row" style={{ gap: 8 }}>
                      <strong>{use.title}</strong>
                      {configured ? <Badge tone="success">ativo</Badge> : <Badge tone="warning">sem chave</Badge>}
                    </div>
                    <div className="small muted">{use.text}</div>
                  </div>
                  <Link to={use.to} className="btn btn--ghost btn--sm nowrap">{use.action}</Link>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="stack">
          <Card title="Agora" subtitle="Tarefas de IA em execução (atualiza a cada 5 s)">
            {running.isLoading ? <Skeleton /> : (running.data?.items.length ?? 0) === 0 ? (
              <span className="small muted">Nada rodando neste momento.</span>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }} className="small">
                {running.data!.items.map((job) => (
                  <li key={job.id}><strong>{JOB_KIND[job.kind] ?? job.kind}</strong> · há {since(job.lockedAt)} · {job.progress ?? 'sem passo informado'}</li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Últimas execuções" subtitle="Posts escritos pela IA" flush actions={<Link to="/operacao" className="btn btn--ghost btn--sm">Fila completa</Link>}>
            {recent.isLoading ? <div style={{ padding: 18 }}><Skeleton /></div> : (recent.data?.items.length ?? 0) === 0 ? (
              <Empty icon="sparkle" title="Nenhuma execução ainda" />
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: '4px 18px 14px' }}>
                {recent.data!.items.map((job) => (
                  <li key={job.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="small mono">{job.uniqueKey ?? job.id}</span>
                      <Badge tone={job.status === 'completed' ? 'success' : job.status === 'failed' ? 'error' : job.status === 'running' ? 'brand' : 'neutral'}>
                        {{ completed: 'ok', failed: 'falhou', running: 'rodando', pending: 'agendada', dismissed: 'ignorada' }[job.status] ?? job.status}
                      </Badge>
                    </div>
                    {job.status === 'failed' && job.lastError && <div className="small" style={{ color: 'var(--danger, #b42318)' }}>{job.lastError}</div>}
                    <div className="caption"><Time value={job.completedAt ?? job.failedAt ?? job.lockedAt} /></div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

export function OpenAiCard({ status, canEdit, canTest, onChanged }: { status: OpenAiStatus | undefined; canEdit: boolean; canTest: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [editing, setEditing] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  const save = useMutation({
    mutationFn: () => api.put<{ message: string }>('/settings/openai', { apiKey: key.trim() }),
    onSuccess: (result) => {
      toast.push(result.message, 'success');
      setKey('');
      setEditing(false);
      onChanged();
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  // Chamada real de 1 token: mostra na hora se falta crédito ou se o modelo não está liberado.
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const test = useMutation({
    mutationFn: () => api.post<{ ok: true; model: string; ms: number }>('/settings/openai/test'),
    onSuccess: (result) => setTestResult({ ok: true, text: `A OpenAI respondeu com o modelo ${result.model} em ${result.ms} ms. Chave e crédito em ordem.` }),
    onError: (error) => setTestResult({ ok: false, text: errorMessage(error) }),
  });

  return (
    <Card title="Chave da OpenAI" subtitle="Uma chave para tudo que usa IA no painel; guardada cifrada no servidor">
      {!status ? (
        <Skeleton />
      ) : (
        <div className="stack stack--tight">
          <div className="row">
            {status.configured ? <Badge tone="success">configurada</Badge> : <Badge tone="warning">não configurada</Badge>}
            {status.configured && <span className="caption">chave {status.hint} · modelo {status.model} · <Time value={status.updatedAt} /></span>}
          </div>
          {canEdit && (editing || !status.configured) && (
            <form className="stack stack--tight" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
              <input className="input" type="password" autoComplete="off" placeholder="sk-…" value={key} onChange={(event) => setKey(event.target.value)} />
              <span className="field__hint">A chave é testada na OpenAI antes de ser guardada e nunca volta em claro para o painel.</span>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                {status.configured && <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>Cancelar</button>}
                <button type="submit" className="btn btn--primary btn--sm" disabled={save.isPending || key.trim().length < 20}>{save.isPending ? 'Validando…' : 'Salvar chave'}</button>
              </div>
            </form>
          )}
          {(canEdit || canTest) && status.configured && !editing && (
            <div className="row">
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? 'Testando…' : 'Testar agora'}</button>
              {canEdit && <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(true)}>Trocar chave</button>}
              {canEdit && <button type="button" className="btn btn--danger btn--sm" onClick={() => setRemoveOpen(true)}>Remover</button>}
            </div>
          )}
          {testResult && <Notice tone={testResult.ok ? 'success' : 'error'}>{testResult.text}</Notice>}
          {!canEdit && <span className="caption">Só um owner altera a chave.</span>}
        </div>
      )}
      <ConfirmDialog open={removeOpen} onClose={() => setRemoveOpen(false)} title="Remover chave da OpenAI" description="O blog deixa de escrever posts e os botões de rascunho (avaliações e atendimento) ficam desligados até uma nova chave ser cadastrada." confirmLabel="Remover" danger requireReason={false} onConfirm={async () => { await api.delete('/settings/openai'); toast.push('Chave removida.'); onChanged(); }} />
    </Card>
  );
}
