import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import { api, type Paginated } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { HorizontalBars } from '../charts/charts';
import { Icon } from '../components/Icon';
import { Badge, Card, Chips, ConfirmDialog, Empty, errorMessage, Notice, PageHeader, Pagination, Skeleton, StatTile, Time, useToast } from '../components/ui';
import { fmtDecimal, fmtNumber } from '../lib/format';
import { useListParams } from '../lib/hooks';

interface Stats {
  total: number;
  answered: number;
  unanswered: number;
  unansweredNegative: number;
  answeredViaPanel: number;
  average: number | null;
  distribution: Record<string, number>;
  last30d: number;
  lastFetchedAt: string | null;
  playConfigured: boolean;
  openAiConfigured: boolean;
}

interface Review {
  reviewId: string;
  authorName: string | null;
  starRating: number;
  text: string | null;
  language: string | null;
  device: string | null;
  androidOsVersion: string | null;
  appVersionCode: number | null;
  appVersionName: string | null;
  userCommentAt: string | null;
  lastModifiedAt: string | null;
  developerReplyText: string | null;
  developerReplyAt: string | null;
  repliedViaPanel: boolean;
  repliedBy: string | null;
}

interface OpenAiStatus {
  configured: boolean;
  hint: string | null;
  updatedAt: string | null;
  model: string;
}

const REPLY_MAX = 350;

export function ReviewsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { values, set, page, pageSize } = useListParams({ status: 'unanswered' });
  const status = (values['status'] as 'unanswered' | 'answered' | 'all') ?? 'unanswered';

  const stats = useQuery({ queryKey: ['reviews', 'stats'], queryFn: () => api.get<Stats>('/reviews/stats') });
  const openai = useQuery({ queryKey: ['settings', 'openai'], queryFn: () => api.get<OpenAiStatus>('/settings/openai') });
  const list = useQuery({
    queryKey: ['reviews', 'list', values, page, pageSize],
    queryFn: () => api.get<Paginated<Review>>('/reviews', { status: status === 'all' ? undefined : status, rating: values['rating'], q: values['q'], page, pageSize }),
    placeholderData: (previous) => previous,
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['reviews'] });

  const sync = useMutation({
    mutationFn: () => api.post<{ fetched: number; created: number; updated: number }>('/reviews/sync'),
    onSuccess: (result) => {
      toast.push(`${fmtNumber(result.fetched)} avaliação(ões) lidas: ${fmtNumber(result.created)} novas, ${fmtNumber(result.updated)} atualizadas.`, 'success');
      refresh();
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const s = stats.data;
  const answeredRate = s && s.total > 0 ? Math.round((s.answered / s.total) * 100) : null;

  return (
    <div className="page">
      <PageHeader
        title="Avaliações"
        subtitle={s?.lastFetchedAt ? <>Play Store · última leitura <Time value={s.lastFetchedAt} /></> : 'Avaliações da Play Store com comentário'}
        actions={
          can('support') && (
            <button type="button" className="btn btn--secondary" onClick={() => sync.mutate()} disabled={sync.isPending || s?.playConfigured === false}>
              <Icon name="refresh" /> {sync.isPending ? 'Buscando…' : 'Buscar no Google agora'}
            </button>
          )
        }
      />

      {s && !s.playConfigured && (
        <Notice tone="warning" title="Google Play não configurado">Sem a conta de serviço a API não consegue ler nem responder avaliações.</Notice>
      )}
      {s && s.playConfigured && s.total === 0 && (
        <Notice tone="info" title="Nenhuma avaliação guardada ainda">
          O Google só devolve avaliações com comentário dos últimos 7 dias; a coleta roda a cada 6 horas e você pode buscar agora. Avaliações só com estrelas não aparecem aqui.
        </Notice>
      )}

      <div className="grid grid--tiles">
        <StatTile label="Não respondidas" value={fmtNumber(s?.unanswered)} foot={`${fmtNumber(s?.unansweredNegative ?? 0)} com 1 ou 2 estrelas`} tone={(s?.unansweredNegative ?? 0) > 0 ? 'alert' : undefined} />
        <StatTile label="Respondidas" value={fmtNumber(s?.answered)} foot={answeredRate === null ? '—' : `${answeredRate}% do total · ${fmtNumber(s?.answeredViaPanel ?? 0)} por este painel`} />
        <StatTile label="Nota média" value={s?.average ? fmtDecimal(s.average) : '—'} foot={`${fmtNumber(s?.total ?? 0)} avaliações com comentário`} />
        <StatTile label="Últimos 30 dias" value={fmtNumber(s?.last30d)} foot="novas avaliações com comentário" />
        <StatTile label="Rascunho por IA" value={openai.data?.configured ? 'ativo' : 'inativo'} foot={openai.data?.configured ? `OpenAI · ${openai.data.model}` : 'configure a chave abaixo'} />
      </div>

      <div className="grid grid--2-1">
        <Card flush>
          <div className="filters" style={{ padding: '14px 18px' }}>
            <Chips value={status} onChange={(next) => set({ status: next })} items={[{ key: 'unanswered', label: 'Não respondidas' }, { key: 'answered', label: 'Respondidas' }, { key: 'all', label: 'Todas' }]} />
            <select className="select select--sm" value={values['rating'] ?? ''} onChange={(event) => set({ rating: event.target.value })} aria-label="Nota">
              <option value="">Todas as notas</option>
              {[5, 4, 3, 2, 1].map((rating) => (
                <option key={rating} value={rating}>{rating} estrela{rating > 1 ? 's' : ''}</option>
              ))}
            </select>
            <input className="input input--sm input--search" placeholder="Texto ou nome" defaultValue={values['q'] ?? ''} onKeyDown={(event) => { if (event.key === 'Enter') set({ q: (event.target as HTMLInputElement).value }); }} />
          </div>
          {list.isLoading ? (
            <div style={{ padding: 18 }}><Skeleton lines={6} /></div>
          ) : (list.data?.items.length ?? 0) === 0 ? (
            <Empty icon="check" title={status === 'unanswered' ? 'Nenhuma avaliação pendente' : 'Nenhuma avaliação com esses filtros'} />
          ) : (
            <div style={{ padding: '0 18px' }}>
              {list.data?.items.map((review) => (
                <ReviewCard key={review.reviewId} review={review} canReply={can('support')} aiEnabled={openai.data?.configured ?? false} onChanged={refresh} />
              ))}
            </div>
          )}
          {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(next) => set({ page: next }, { resetPage: false })} />}
        </Card>

        <div className="stack">
          <Card title="Distribuição de notas">
            {s ? (
              <HorizontalBars items={[5, 4, 3, 2, 1].map((rating) => ({ label: `${'★'.repeat(rating)}`, value: s.distribution[String(rating)] ?? 0 }))} />
            ) : (
              <Skeleton />
            )}
          </Card>
          <OpenAiCard status={openai.data} canEdit={can('owner')} onChanged={() => { void queryClient.invalidateQueries({ queryKey: ['settings'] }); refresh(); }} />
        </div>
      </div>
    </div>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span style={{ color: rating <= 2 ? 'var(--error)' : rating === 3 ? 'var(--warning)' : 'var(--success)', letterSpacing: 1 }} aria-label={`${rating} de 5`}>
      {'★'.repeat(rating)}<span style={{ color: 'var(--disabled)' }}>{'★'.repeat(5 - rating)}</span>
    </span>
  );
}

function ReviewCard({ review, canReply, aiEnabled, onChanged }: { review: Review; canReply: boolean; aiEnabled: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(review.developerReplyText === null);
  const [text, setText] = useState(review.developerReplyText ?? '');
  const [instructions, setInstructions] = useState('');
  const [confirm, setConfirm] = useState(false);

  const draft = useMutation({
    mutationFn: () => api.post<{ text: string; model: string }>(`/reviews/${encodeURIComponent(review.reviewId)}/draft`, { instructions: instructions || undefined }),
    onSuccess: (result) => {
      setText(result.text);
      toast.push('Rascunho gerado. Revise antes de publicar.');
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim().length === 0) return;
    setConfirm(true);
  };

  return (
    <article className="list__item" style={{ alignItems: 'stretch', flexDirection: 'column', gap: 8, padding: '16px 0' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <Stars rating={review.starRating} />
          <span className="strong">{review.authorName ?? 'Usuário do Google'}</span>
          <span className="caption"><Time value={review.userCommentAt} /></span>
          {review.developerReplyText ? <Badge tone="success">respondida</Badge> : <Badge tone="warning">sem resposta</Badge>}
          {review.repliedViaPanel && <Badge tone="brand" plain>pelo painel</Badge>}
        </div>
        <span className="caption">
          {[review.device, review.androidOsVersion ? `Android ${review.androidOsVersion}` : null, review.appVersionName ? `app ${review.appVersionName}` : null].filter(Boolean).join(' · ')}
        </span>
      </div>
      <p style={{ whiteSpace: 'pre-wrap' }}>{review.text?.trim() ? review.text : <span className="muted">(sem texto, só a nota)</span>}</p>

      {review.developerReplyText && !open && (
        <div style={{ background: 'var(--brand-tint)', border: '1px solid var(--border)', borderRadius: 'var(--radius-panel)', padding: '10px 12px' }}>
          <div className="caption" style={{ marginBottom: 4 }}>
            Sua resposta · <Time value={review.developerReplyAt} relative={false} />{review.repliedBy && ` · ${review.repliedBy}`}
          </div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-supporting)' }}>{review.developerReplyText}</div>
          {canReply && <button type="button" className="btn btn--link small" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>editar resposta</button>}
        </div>
      )}

      {canReply && open && (
        <form onSubmit={submit} className="stack stack--tight">
          <textarea className="textarea" rows={3} maxLength={REPLY_MAX} value={text} onChange={(event) => setText(event.target.value)} placeholder="Escreva a resposta ou gere um rascunho com a IA…" />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className={`caption ${text.length > REPLY_MAX - 30 ? 'strong' : ''}`} style={{ color: text.length >= REPLY_MAX ? 'var(--error)' : undefined }}>
              {text.length}/{REPLY_MAX}
            </span>
            <div className="row">
              {aiEnabled && (
                <>
                  <input className="input input--sm" style={{ width: 240 }} placeholder="Orientação para a IA (opcional)" value={instructions} onChange={(event) => setInstructions(event.target.value)} maxLength={500} />
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => draft.mutate()} disabled={draft.isPending}>
                    <Icon name="zap" /> {draft.isPending ? 'Gerando…' : 'Gerar com IA'}
                  </button>
                </>
              )}
              {review.developerReplyText && <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setOpen(false); setText(review.developerReplyText ?? ''); }}>Cancelar</button>}
              <button type="submit" className="btn btn--primary btn--sm" disabled={text.trim().length === 0}>Publicar resposta</button>
            </div>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Publicar resposta na Play Store"
        description="A resposta fica pública, junto da avaliação, em nome do Estoque Simples. Dá para editar depois."
        confirmLabel="Publicar"
        requireReason={false}
        onConfirm={async () => {
          await api.post(`/reviews/${encodeURIComponent(review.reviewId)}/reply`, { text: text.trim() });
          toast.push('Resposta publicada na Play Store.', 'success');
          setOpen(false);
          onChanged();
        }}
      >
        <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-panel)', padding: '10px 12px', whiteSpace: 'pre-wrap', fontSize: 'var(--fs-supporting)' }}>{text.trim()}</div>
      </ConfirmDialog>
    </article>
  );
}

function OpenAiCard({ status, canEdit, onChanged }: { status: OpenAiStatus | undefined; canEdit: boolean; onChanged: () => void }) {
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

  return (
    <Card title="Rascunho por IA" subtitle="Chave da OpenAI, guardada cifrada no servidor">
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
          {canEdit && status.configured && !editing && (
            <div className="row">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(true)}>Trocar chave</button>
              <button type="button" className="btn btn--danger btn--sm" onClick={() => setRemoveOpen(true)}>Remover</button>
            </div>
          )}
          {!canEdit && <span className="caption">Só um owner altera a chave.</span>}
        </div>
      )}
      <ConfirmDialog open={removeOpen} onClose={() => setRemoveOpen(false)} title="Remover chave da OpenAI" description="O botão de rascunho deixa de funcionar até uma nova chave ser cadastrada." confirmLabel="Remover" danger requireReason={false} onConfirm={async () => { await api.delete('/settings/openai'); toast.push('Chave removida.'); onChanged(); }} />
    </Card>
  );
}
