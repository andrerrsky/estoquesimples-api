import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, CSRF_HEADER, CSRF_VALUE } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { Badge, Card, ConfirmDialog, errorMessage, Notice, PageHeader, Skeleton, Time, useToast } from '../components/ui';
import type { BlogMeta, BlogPostRow } from './BlogPage';

interface Draft {
  title: string;
  seoTitle: string;
  slug: string;
  excerpt: string;
  contentMd: string;
  category: string;
  tags: string;
  faq: Array<{ question: string; answer: string }>;
  coverAlt: string;
  authorName: string;
}

const EMPTY: Draft = { title: '', seoTitle: '', slug: '', excerpt: '', contentMd: '', category: 'controle-de-estoque', tags: '', faq: [], coverAlt: '', authorName: 'Equipe Estoque Simples' };

function fromPost(post: BlogPostRow): Draft {
  return {
    title: post.title,
    seoTitle: post.seoTitle ?? '',
    slug: post.slug,
    excerpt: post.excerpt,
    contentMd: post.contentMd ?? '',
    category: post.category.slug,
    tags: post.tags.join(', '),
    faq: post.faq,
    coverAlt: post.coverAlt ?? '',
    authorName: post.authorName,
  };
}

function slugify(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
}

/** Editor de post: Markdown com prévia, SEO, FAQ e capa. */
export function BlogEditorPage() {
  const { postId } = useParams();
  const creating = !postId || postId === 'novo';
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [slugTouched, setSlugTouched] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [notify, setNotify] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);

  const meta = useQuery({ queryKey: ['blog', 'meta'], queryFn: () => api.get<BlogMeta>('/blog/meta') });
  const post = useQuery({ queryKey: ['blog', 'post', postId], queryFn: () => api.get<BlogPostRow>(`/blog/posts/${postId}`), enabled: !creating });

  useEffect(() => {
    if (post.data) {
      setDraft(fromPost(post.data));
      setSlugTouched(true);
    }
  }, [post.data]);
  useEffect(() => {
    if (meta.data?.settings) setNotify(meta.data.settings.notifyOnPublish);
  }, [meta.data]);

  const field = (key: keyof Draft) => (event: { target: { value: string } }) => {
    const value = event.target.value;
    setDraft((current) => ({ ...current, [key]: value, ...(key === 'title' && !slugTouched ? { slug: slugify(value) } : {}) }));
  };

  const payload = useMemo(
    () => ({
      title: draft.title.trim(),
      seoTitle: draft.seoTitle.trim() || null,
      ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}),
      excerpt: draft.excerpt.trim(),
      contentMd: draft.contentMd,
      category: draft.category,
      tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      faq: draft.faq.filter((item) => item.question.trim() && item.answer.trim()),
      coverAlt: draft.coverAlt.trim() || null,
      authorName: draft.authorName.trim() || 'Equipe Estoque Simples',
    }),
    [draft],
  );

  const preview = useQuery({
    queryKey: ['blog', 'preview', draft.contentMd],
    queryFn: () => api.post<{ html: string; words: number; readingMinutes: number }>('/blog/preview', { contentMd: draft.contentMd }),
    enabled: showPreview && draft.contentMd.length > 0,
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: () => (creating ? api.post<BlogPostRow>('/blog/posts', payload) : api.put<BlogPostRow>(`/blog/posts/${postId}`, payload)),
    onSuccess: (saved) => {
      toast.push(creating ? 'Rascunho criado.' : 'Post salvo.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['blog'] });
      if (creating) navigate(`/blog/${saved.id}`, { replace: true });
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const publish = useMutation({
    mutationFn: async () => {
      // Salva o que está na tela antes de publicar: o que a pessoa vê é o que sai.
      const saved = creating ? await api.post<BlogPostRow>('/blog/posts', payload) : await api.put<BlogPostRow>(`/blog/posts/${postId}`, payload);
      return api.post<BlogPostRow>(`/blog/posts/${saved.id}/publish`, { notify });
    },
    onSuccess: (published) => {
      toast.push(published.notifiedAt || !notify ? 'Post publicado.' : 'Post publicado. O aviso sai em instantes.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['blog'] });
      navigate(`/blog/${published.id}`, { replace: true });
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const unpublish = useMutation({
    mutationFn: () => api.post<BlogPostRow>(`/blog/posts/${postId}/unpublish`),
    onSuccess: () => {
      toast.push('Post voltou a rascunho.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['blog'] });
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const remove = async () => {
    await api.delete(`/blog/posts/${postId}`);
    toast.push('Post apagado.', 'success');
    void queryClient.invalidateQueries({ queryKey: ['blog'] });
    navigate('/blog');
  };

  const uploadCover = async (file: File | undefined) => {
    if (!file || !postId) return;
    setCoverBusy(true);
    try {
      const response = await fetch(`/admin/api/blog/posts/${postId}/cover`, { method: 'PUT', headers: { 'content-type': file.type, [CSRF_HEADER]: CSRF_VALUE }, body: file, credentials: 'same-origin' });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Erro ${response.status}`);
      }
      toast.push('Capa enviada.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['blog', 'post', postId] });
    } catch (error) {
      toast.push(errorMessage(error), 'error');
    } finally {
      setCoverBusy(false);
    }
  };

  const removeCover = useMutation({
    mutationFn: () => api.delete(`/blog/posts/${postId}/cover`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['blog', 'post', postId] }),
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  if (!creating && post.isLoading) return <div className="page"><Skeleton lines={8} /></div>;
  if (!creating && !post.data) return <div className="page"><Notice tone="error">Post não encontrado.</Notice></div>;

  const current = post.data;
  const editable = can('support');
  const busy = save.isPending || publish.isPending || unpublish.isPending;
  const titleLength = draft.title.length;
  const seoLength = (draft.seoTitle || draft.title).length;

  return (
    <div className="page">
      <PageHeader
        title={creating ? 'Novo post' : current?.title ?? 'Post'}
        subtitle={
          current ? (
            <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {current.status === 'published' ? <Badge tone="success">publicado</Badge> : <Badge tone="warning">rascunho</Badge>}
              {current.aiGenerated && <Badge tone="info"><Icon name="sparkle" size={12} /> gerado por IA{current.aiModel ? ` · ${current.aiModel}` : ''}</Badge>}
              {current.publishedAt && <span className="muted">publicado <Time value={current.publishedAt} /></span>}
              {current.notifiedAt && <span className="muted">· push enviado <Time value={current.notifiedAt} /></span>}
              {current.status === 'published' && <a href={current.url} target="_blank" rel="noopener noreferrer">ver no site</a>}
            </span>
          ) : (
            'Escreva em Markdown. O título é o H1 da página; use "##" para as seções.'
          )
        }
        actions={<Link to="/blog" className="btn btn--ghost">Voltar</Link>}
      />

      {current?.aiGenerated && current.status === 'draft' && <Notice tone="info">Este rascunho foi escrito pela IA (pauta: {current.aiTopic}). Revise o texto, ajuste o que precisar e publique.</Notice>}

      <div className="grid grid--2-1">
        <div className="stack">
          <Card title="Conteúdo">
            <div className="stack stack--tight">
              <label className="field">
                <span className="field__label">Título</span>
                <input className="input" value={draft.title} onChange={field('title')} maxLength={120} disabled={!editable} placeholder="Ex.: Estoque mínimo: como definir para nunca faltar produto" />
                <span className="field__hint">{titleLength}/120 · o Google mostra até ~60; use o título para SEO abaixo se precisar de um mais curto.</span>
              </label>
              <label className="field">
                <span className="field__label">Resumo (meta description e lista do blog)</span>
                <textarea className="textarea" rows={2} value={draft.excerpt} onChange={field('excerpt')} maxLength={200} disabled={!editable} placeholder="Uma ou duas frases que respondem por que ler este post." />
                <span className="field__hint" style={{ color: draft.excerpt.length > 160 ? 'var(--warning)' : undefined }}>{draft.excerpt.length}/200 · ideal entre 120 e 160 caracteres.</span>
              </label>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="field__label">Texto (Markdown)</span>
                <div className="row" style={{ gap: 6 }}>
                  <button type="button" className={`chip ${!showPreview ? 'active' : ''}`} onClick={() => setShowPreview(false)}>Editar</button>
                  <button type="button" className={`chip ${showPreview ? 'active' : ''}`} onClick={() => setShowPreview(true)}>Prévia</button>
                </div>
              </div>
              {showPreview ? (
                <div className="blog-preview">
                  {preview.isLoading ? <Skeleton /> : preview.data ? <><div className="muted small" style={{ marginBottom: 8 }}>{preview.data.words} palavras · {preview.data.readingMinutes} min de leitura</div><div className="blog-preview__content" dangerouslySetInnerHTML={{ __html: preview.data.html }} /></> : <span className="muted">Nada para mostrar.</span>}
                </div>
              ) : (
                <textarea className="textarea mono" rows={22} value={draft.contentMd} onChange={field('contentMd')} disabled={!editable} placeholder={'Primeiro parágrafo respondendo a dúvida.\n\n## Primeira seção\n\nTexto, **negrito**, [link](/criar-conta).\n\n- item\n- item\n\n## Resumo\n\n- ponto 1'} />
              )}
              <span className="field__hint">Títulos com "##" e "###", listas com "-" ou "1.", negrito com **, citação com &gt;, links [texto](/caminho). Links externos abrem em nova aba.</span>
            </div>
          </Card>

          <Card title="Perguntas frequentes" subtitle="Aparecem no fim do post e viram FAQ no Google (rich result).">
            <div className="stack stack--tight">
              {draft.faq.map((item, index) => (
                <div key={index} className="form-grid" style={{ alignItems: 'start' }}>
                  <label className="field">
                    <span className="field__label">Pergunta</span>
                    <input className="input" value={item.question} maxLength={200} disabled={!editable} onChange={(event) => setDraft((d) => ({ ...d, faq: d.faq.map((f, i) => (i === index ? { ...f, question: event.target.value } : f)) }))} />
                  </label>
                  <label className="field">
                    <span className="field__label">Resposta</span>
                    <textarea className="textarea" rows={2} value={item.answer} maxLength={1000} disabled={!editable} onChange={(event) => setDraft((d) => ({ ...d, faq: d.faq.map((f, i) => (i === index ? { ...f, answer: event.target.value } : f)) }))} />
                  </label>
                  {editable && <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDraft((d) => ({ ...d, faq: d.faq.filter((_, i) => i !== index) }))} aria-label="Remover pergunta"><Icon name="trash" size={14} /></button>}
                </div>
              ))}
              {editable && draft.faq.length < 6 && (
                <div><button type="button" className="btn btn--secondary btn--sm" onClick={() => setDraft((d) => ({ ...d, faq: [...d.faq, { question: '', answer: '' }] }))}><Icon name="plus" size={14} /> Adicionar pergunta</button></div>
              )}
            </div>
          </Card>
        </div>

        <div className="stack">
          <Card title="Publicação">
            <div className="stack stack--tight">
              {editable && (
                <>
                  <button type="button" className="btn btn--secondary" onClick={() => save.mutate()} disabled={busy || !draft.title || !draft.contentMd}>{save.isPending ? 'Salvando…' : creating ? 'Salvar rascunho' : 'Salvar'}</button>
                  {current?.status !== 'published' ? (
                    <>
                      <label className="checkbox">
                        <input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} disabled={Boolean(current?.notifiedAt)} />
                        {current?.notifiedAt ? 'Push já enviado para este post' : 'Avisar todo mundo (push e caixa de notificações)'}
                      </label>
                      <button type="button" className="btn btn--primary" onClick={() => publish.mutate()} disabled={busy || !draft.title || !draft.contentMd || !draft.excerpt}>{publish.isPending ? 'Publicando…' : 'Publicar'}</button>
                    </>
                  ) : (
                    <button type="button" className="btn btn--secondary" onClick={() => unpublish.mutate()} disabled={busy}>Despublicar (volta a rascunho)</button>
                  )}
                  {!creating && <button type="button" className="btn btn--danger" onClick={() => setConfirmDelete(true)} disabled={busy}><Icon name="trash" size={14} /> Apagar</button>}
                </>
              )}
              {!editable && <span className="muted">Seu papel só permite ler.</span>}
            </div>
          </Card>

          <Card title="Categoria e assuntos">
            <div className="stack stack--tight">
              <label className="field">
                <span className="field__label">Categoria</span>
                <select className="select" value={draft.category} onChange={field('category')} disabled={!editable}>
                  {meta.data?.categories.map((category) => <option key={category.slug} value={category.slug}>{category.label}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="field__label">Tags (separadas por vírgula)</span>
                <input className="input" value={draft.tags} onChange={field('tags')} disabled={!editable} placeholder="estoque mínimo, reposição" />
              </label>
              <label className="field">
                <span className="field__label">Autor</span>
                <input className="input" value={draft.authorName} onChange={field('authorName')} maxLength={80} disabled={!editable} />
              </label>
            </div>
          </Card>

          <Card title="SEO">
            <div className="stack stack--tight">
              <label className="field">
                <span className="field__label">Título para o Google (opcional)</span>
                <input className="input" value={draft.seoTitle} onChange={field('seoTitle')} maxLength={70} disabled={!editable} placeholder={draft.title} />
                <span className="field__hint" style={{ color: seoLength > 60 ? 'var(--warning)' : undefined }}>{seoLength}/60 · aparece como "{(draft.seoTitle || draft.title || 'Título')} · Blog do Estoque Simples".</span>
              </label>
              <label className="field">
                <span className="field__label">Endereço</span>
                <input className="input mono" value={draft.slug} onChange={(event) => { setSlugTouched(true); setDraft((d) => ({ ...d, slug: slugify(event.target.value) })); }} disabled={!editable || current?.status === 'published'} />
                <span className="field__hint">estoquesimples.com.br/blog/{draft.slug || '…'}{current?.status === 'published' ? ' · fixo depois de publicado (links já compartilhados)' : ''}</span>
              </label>
            </div>
          </Card>

          <Card title="Capa" subtitle="JPEG, PNG ou WebP; ideal 1200×630. Sem imagem, o site gera uma capa com o título e a categoria.">
            <div className="stack stack--tight">
              {current?.coverUrl && !current.coverAuto ? (
                <>
                  <img src={current.coverUrl} alt={current.coverAlt ?? ''} style={{ width: '100%', borderRadius: 10, display: 'block' }} />
                  {editable && <button type="button" className="btn btn--ghost btn--sm" onClick={() => removeCover.mutate()} disabled={removeCover.isPending}>Remover capa (volta à gerada)</button>}
                </>
              ) : (
                <span className="muted">{creating ? 'Salve o rascunho para enviar a capa.' : 'Sem imagem enviada: o site gera uma capa com o título e a categoria do post.'}</span>
              )}
              {editable && !creating && (
                <label className="btn btn--secondary btn--sm" style={{ cursor: coverBusy ? 'wait' : 'pointer' }}>
                  <Icon name="download" size={14} /> {coverBusy ? 'Enviando…' : current?.coverUrl && !current.coverAuto ? 'Trocar capa' : 'Enviar capa'}
                  <input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }} disabled={coverBusy} onChange={(event) => void uploadCover(event.target.files?.[0])} />
                </label>
              )}
              <label className="field">
                <span className="field__label">Texto alternativo da capa</span>
                <input className="input" value={draft.coverAlt} onChange={field('coverAlt')} maxLength={200} disabled={!editable} placeholder="O que a imagem mostra" />
              </label>
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Apagar este post?" onConfirm={remove} confirmWord="apagar">
        O post some do site, do web app e do app. Links já compartilhados vão parar na tela de "não encontrado".
      </ConfirmDialog>
    </div>
  );
}
