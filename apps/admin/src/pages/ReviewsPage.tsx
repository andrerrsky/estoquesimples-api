import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

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
  lastSync: { at: string; fetched: number; created: number; updated: number; error: string | null } | null;
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
      {s && s.playConfigured && s.lastSync?.error && (
        <Notice tone="error" title="A última busca no Google falhou">
          <Time value={s.lastSync.at} />: {s.lastSync.error}
        </Notice>
      )}
      {s && s.playConfigured && s.total === 0 && (
        <Notice tone="info" title="Nenhuma avaliação guardada ainda">
          {s.lastSync && !s.lastSync.error ? (
            <>
              A última busca (<Time value={s.lastSync.at} />) chegou ao Google e ele devolveu <strong>{fmtNumber(s.lastSync.fetched)}</strong> avaliação(ões).{' '}
            </>
          ) : null}
          A API do Google só devolve avaliações <strong>com comentário escrito nos últimos 7 dias</strong>; as mais antigas que aparecem na página da Play Store não vêm por ela. Para trazer o histórico, use <strong>Importar avaliações antigas</strong> (ao lado) com os relatórios mensais da Play Console. A coleta automática roda a cada 6 horas.
        </Notice>
      )}

      <div className="grid grid--tiles">
        <StatTile label="Não respondidas" value={fmtNumber(s?.unanswered)} foot={`${fmtNumber(s?.unansweredNegative ?? 0)} com 1 ou 2 estrelas`} tone={(s?.unansweredNegative ?? 0) > 0 ? 'alert' : undefined} />
        <StatTile label="Respondidas" value={fmtNumber(s?.answered)} foot={answeredRate === null ? '—' : `${answeredRate}% do total · ${fmtNumber(s?.answeredViaPanel ?? 0)} por este painel`} />
        <StatTile label="Nota média" value={s?.average ? fmtDecimal(s.average) : '—'} foot={`${fmtNumber(s?.total ?? 0)} avaliações com comentário`} />
        <StatTile label="Últimos 30 dias" value={fmtNumber(s?.last30d)} foot="novas avaliações com comentário" />
        <StatTile label="Rascunho por IA" value={openai.data?.configured ? 'ativo' : 'inativo'} foot={openai.data?.configured ? `OpenAI · ${openai.data.model}` : 'configure em Inteligência artificial'} />
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
          <Card title="Rascunho por IA" subtitle="Usa a chave da OpenAI do painel">
            <p className="small" style={{ margin: 0 }}>{openai.data?.configured ? <>Ativo com o modelo <strong>{openai.data.model}</strong>.</> : 'Sem chave configurada: o botão de rascunho fica desligado.'} A chave fica em <Link to="/ia">Inteligência artificial</Link>, junto com o teste e o que usa a IA.</p>
          </Card>
          {can('support') && <ImportCard onImported={refresh} />}
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

interface ImportResult {
  rows: number;
  created: number;
  updated: number;
  unchanged: number;
  withoutText: number;
  withoutId: number;
  otherPackage: number;
}

/**
 * O relatório da Play Console vem em UTF-16 com BOM; os exportados de novo
 * por uma planilha costumam virar UTF-8. Decodifica pelo BOM, com UTF-8 como
 * padrão, antes de mandar o texto para a API.
 */
async function readReport(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  // UTF-16 sem BOM: metade dos bytes é zero.
  if (bytes.length > 4 && bytes[1] === 0 && bytes[3] === 0) return new TextDecoder('utf-16le').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Importa o histórico: os relatórios mensais de avaliações baixados da Play Console. */
function ImportCard({ onImported }: { onImported: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Array<{ file: string; result?: ImportResult; error?: string }>>([]);

  const importFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    const done: typeof results = [];
    for (const file of Array.from(files)) {
      try {
        const content = await readReport(file);
        const result = await api.post<ImportResult>('/reviews/import', { fileName: file.name, content });
        done.push({ file: file.name, result });
      } catch (error) {
        done.push({ file: file.name, error: errorMessage(error) });
      }
    }
    setResults(done);
    setBusy(false);
    const created = done.reduce((sum, item) => sum + (item.result?.created ?? 0), 0);
    toast.push(`${fmtNumber(created)} avaliação(ões) antiga(s) importada(s).`, done.some((item) => item.error) ? 'error' : 'success');
    onImported();
  };

  return (
    <Card title="Importar avaliações antigas" subtitle="A API do Google só traz os últimos 7 dias; o histórico vem dos relatórios mensais da Play Console">
      <ol className="small" style={{ margin: '0 0 12px', paddingLeft: 18, lineHeight: 1.6 }}>
        <li>Play Console › <strong>Baixar relatórios</strong> › <strong>Avaliações</strong>.</li>
        <li>Escolha o app e baixe os meses que quiser (um CSV por mês).</li>
        <li>Selecione os arquivos aqui; pode mandar vários de uma vez e repetir sem duplicar.</li>
      </ol>
      <label className={`btn btn--secondary ${busy ? 'is-disabled' : ''}`} style={{ cursor: busy ? 'progress' : 'pointer' }}>
        <Icon name="upload" size={16} /> {busy ? 'Importando…' : 'Escolher relatórios (.csv)'}
        <input type="file" accept=".csv,text/csv" multiple hidden disabled={busy} onChange={(event) => { void importFiles(event.target.files); event.target.value = ''; }} />
      </label>
      {results.length > 0 && (
        <ul className="small muted" style={{ margin: '12px 0 0', paddingLeft: 18 }}>
          {results.map((item) => (
            <li key={item.file}>
              <strong>{item.file}</strong>:{' '}
              {item.error
                ? <span style={{ color: 'var(--danger, #b42318)' }}>{item.error}</span>
                : `${fmtNumber(item.result!.created)} novas, ${fmtNumber(item.result!.updated)} atualizadas, ${fmtNumber(item.result!.unchanged)} já estavam aqui${item.result!.withoutText ? `, ${fmtNumber(item.result!.withoutText)} só com estrelas (ignoradas)` : ''}${item.result!.withoutId ? `, ${fmtNumber(item.result!.withoutId)} sem link` : ''}${item.result!.otherPackage ? `, ${fmtNumber(item.result!.otherPackage)} de outro app` : ''}.`}
            </li>
          ))}
        </ul>
      )}
      <p className="small muted" style={{ margin: '12px 0 0' }}>O relatório não traz o nome de quem avaliou. Responder às antigas depende do Google aceitar; se recusar, o painel mostra o motivo.</p>
    </Card>
  );
}

