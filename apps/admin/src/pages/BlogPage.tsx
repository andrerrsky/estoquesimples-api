import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { Badge, Card, Empty, errorMessage, KeyValue, Notice, PageHeader, Pagination, Skeleton, Tabs, Time, useToast } from '../components/ui';
import { useListParams } from '../lib/hooks';

export interface BlogPostRow {
  id: string;
  slug: string;
  title: string;
  seoTitle: string | null;
  excerpt: string;
  contentMd?: string;
  category: { slug: string; label: string };
  tags: string[];
  faq: Array<{ question: string; answer: string }>;
  status: 'draft' | 'published';
  publishedAt: string | null;
  updatedAt: string;
  createdAt: string;
  coverUrl: string | null;
  coverAuto: boolean;
  coverAlt: string | null;
  authorName: string;
  readingMinutes: number;
  aiGenerated: boolean;
  membersOnly: boolean;
  aiModel?: string | null;
  aiTopic?: string | null;
  notifiedAt?: string | null;
  url: string;
}

export interface BlogMeta {
  categories: Array<{ slug: string; label: string; description: string }>;
  settings: { aiEnabled: boolean; aiAutoPublish: boolean; aiMembersOnlyWeekly: boolean; notifyOnPublish: boolean };
  openAiConfigured: boolean;
  nextAiRun: string;
  topics: Array<{ key: string; category: string; brief: string; keyword: string; used: boolean }>;
  topicsTotal: number;
}

export function BlogPage() {
  const { values, set, page, pageSize } = useListParams();
  const tab = (values['tab'] as 'posts' | 'ia') ?? 'posts';
  const status = (values['status'] as 'draft' | 'published' | '') ?? '';
  const [search, setSearch] = useState(values['q'] ?? '');
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();

  useEffect(() => setSearch(values['q'] ?? ''), [values['q']]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if ((values['q'] ?? '') !== search) set({ q: search });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, values, set]);

  const meta = useQuery({ queryKey: ['blog', 'meta'], queryFn: () => api.get<BlogMeta>('/blog/meta') });
  const posts = useQuery({
    queryKey: ['blog', 'posts', status, values['q'], page, pageSize],
    queryFn: () => api.get<Paginated<BlogPostRow>>('/blog/posts', { status: status || undefined, q: values['q'], page, pageSize }),
    placeholderData: (previous) => previous,
  });

  const saveSettings = useMutation({
    mutationFn: (settings: BlogMeta['settings']) => api.put<BlogMeta['settings']>('/blog/settings', settings),
    onSuccess: () => {
      toast.push('Configurações salvas.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['blog', 'meta'] });
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const writeNow = useMutation({
    mutationFn: (topicKey?: string) => api.post<BlogPostRow>('/blog/ai/write', { publish: false, ...(topicKey ? { topicKey } : {}) }),
    onSuccess: (post) => {
      toast.push('A IA escreveu um rascunho. Revise antes de publicar.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['blog'] });
      navigate(`/blog/${post.id}`);
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const settings = meta.data?.settings;
  const toggle = (key: keyof BlogMeta['settings']) => settings && saveSettings.mutate({ ...settings, [key]: !settings[key] });
  const usedTopics = meta.data?.topics.filter((topic) => topic.used).length ?? 0;

  return (
    <div className="page">
      <PageHeader
        title="Blog"
        subtitle="Dicas, avisos e novidades para quem usa o Estoque Simples. Aparece em estoquesimples.com.br/blog, no web app e no app Android; cada post publicado avisa todo mundo por push."
        actions={
          can('support') ? (
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn btn--secondary" onClick={() => writeNow.mutate(undefined)} disabled={writeNow.isPending || !meta.data?.openAiConfigured} title={meta.data?.openAiConfigured ? 'A IA escreve um rascunho agora, com a próxima pauta' : 'Configure a chave da OpenAI em Avaliações'}>
                <Icon name="sparkle" size={16} /> {writeNow.isPending ? 'Escrevendo…' : 'Escrever com IA'}
              </button>
              <Link to="/blog/novo" className="btn btn--primary"><Icon name="plus" size={16} /> Novo post</Link>
            </div>
          ) : undefined
        }
      />

      <Tabs value={tab} onChange={(next) => set({ tab: next })} items={[{ key: 'posts', label: 'Posts', count: posts.data?.total }, { key: 'ia', label: 'IA e configurações' }]} />

      {tab === 'posts' ? (
        <Card flush>
          <div className="filters" style={{ padding: '14px 18px' }}>
            <select className="select select--sm" value={status} onChange={(event) => set({ status: event.target.value })} aria-label="Estado">
              <option value="">Todos</option>
              <option value="published">Publicados</option>
              <option value="draft">Rascunhos</option>
            </select>
            <input className="input input--sm input--search" placeholder="Título ou endereço" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <div className="table-wrap">
            <table className="table table--compact">
              <thead>
                <tr><th>Post</th><th>Categoria</th><th>Estado</th><th>Publicado</th><th>Atualizado</th><th></th></tr>
              </thead>
              <tbody>
                {posts.isLoading ? (
                  <tr><td colSpan={6}><Skeleton /></td></tr>
                ) : (posts.data?.items.length ?? 0) === 0 ? (
                  <tr><td colSpan={6}><Empty icon="note" title="Nenhum post" /></td></tr>
                ) : (
                  posts.data?.items.map((post) => (
                    <tr key={post.id}>
                      <td style={{ maxWidth: 480 }}>
                        <Link to={`/blog/${post.id}`} className="strong">{post.title}</Link>
                        {post.aiGenerated && <Badge tone="info"> <Icon name="sparkle" size={12} /> IA</Badge>}
                        {post.membersOnly && <Badge plain> <Icon name="lock" size={12} /> Exclusivo</Badge>}
                        <div className="cell-sub">/blog/{post.slug} · {post.readingMinutes} min</div>
                      </td>
                      <td>{post.category.label}</td>
                      <td>{post.status === 'published' ? <Badge tone="success">publicado</Badge> : <Badge tone="warning">rascunho</Badge>}{post.notifiedAt && <div className="cell-sub">push enviado</div>}</td>
                      <td className="nowrap"><Time value={post.publishedAt} /></td>
                      <td className="nowrap"><Time value={post.updatedAt} /></td>
                      <td className="nowrap">
                        {post.status === 'published' && <a className="btn btn--ghost btn--sm" href={post.url} target="_blank" rel="noopener noreferrer" title="Abrir no site"><Icon name="external" size={14} /></a>}
                        <Link className="btn btn--ghost btn--sm" to={`/blog/${post.id}`} title="Editar"><Icon name="edit" size={14} /></Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {posts.data && <Pagination page={posts.data.page} pageSize={posts.data.pageSize} total={posts.data.total} onPage={(next) => set({ page: next }, { resetPage: false })} onPageSize={(size) => set({ pageSize: size })} />}
        </Card>
      ) : (
        <div className="grid grid--2-1">
          <div className="stack">
            <Card title="Geração por IA" subtitle="Terça e sexta (9h de Brasília) a OpenAI escreve um post público a partir de uma pauta do banco, dos fatos do produto e da central de ajuda; quinta, um post exclusivo para quem tem conta. O post sai marcado como gerado por IA.">
              {!meta.data ? (
                <Skeleton />
              ) : (
                <div className="stack">
                  {!meta.data.openAiConfigured && (
                    <Notice tone="warning">Sem chave da OpenAI: a IA não escreve. Configure em <Link to="/avaliacoes">Avaliações › OpenAI</Link>; a mesma chave vale para o suporte e o blog.</Notice>
                  )}
                  <label className="checkbox">
                    <input type="checkbox" checked={settings?.aiEnabled ?? false} onChange={() => toggle('aiEnabled')} disabled={!can('support') || saveSettings.isPending} />
                    A IA escreve posts sozinha (terça e sexta)
                  </label>
                  <label className="checkbox">
                    <input type="checkbox" checked={settings?.aiMembersOnlyWeekly ?? false} onChange={() => toggle('aiMembersOnlyWeekly')} disabled={!can('support') || saveSettings.isPending} />
                    Terceiro post por semana (quinta), exclusivo para quem tem conta, com conteúdo a mais
                  </label>
                  <label className="checkbox">
                    <input type="checkbox" checked={settings?.aiAutoPublish ?? false} onChange={() => toggle('aiAutoPublish')} disabled={!can('support') || saveSettings.isPending} />
                    Publicar na hora (desligado: fica como rascunho para revisão)
                  </label>
                  <label className="checkbox">
                    <input type="checkbox" checked={settings?.notifyOnPublish ?? false} onChange={() => toggle('notifyOnPublish')} disabled={!can('support') || saveSettings.isPending} />
                    Avisar todo mundo (push e caixa de notificações) a cada post publicado
                  </label>
                  <KeyValue
                    items={[
                      { label: 'Próxima execução', value: <Time value={meta.data.nextAiRun} relative={false} /> },
                      { label: 'Pautas do banco', value: `${usedTopics} de ${meta.data.topicsTotal} usadas (depois, a IA propõe pautas novas)` },
                    ]}
                  />
                </div>
              )}
            </Card>
            <Card title="Banco de pautas" subtitle="A ordem alterna as categorias. Clique para a IA escrever uma pauta específica agora (vira rascunho)." flush>
              <div className="table-wrap">
                <table className="table table--compact">
                  <thead><tr><th>Pauta</th><th>Categoria</th><th>Palavra-chave</th><th></th></tr></thead>
                  <tbody>
                    {meta.data?.topics.map((topic) => (
                      <tr key={topic.key} className={topic.used ? 'muted' : ''}>
                        <td style={{ maxWidth: 520 }}>{topic.brief}</td>
                        <td className="nowrap">{meta.data?.categories.find((c) => c.slug === topic.category)?.label ?? topic.category}</td>
                        <td className="nowrap">{topic.keyword}</td>
                        <td className="nowrap">
                          {topic.used ? (
                            <Badge plain>usada</Badge>
                          ) : (
                            can('support') && (
                              <button type="button" className="btn btn--ghost btn--sm" onClick={() => writeNow.mutate(topic.key)} disabled={writeNow.isPending || !meta.data?.openAiConfigured}>
                                <Icon name="sparkle" size={14} /> Escrever
                              </button>
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
          <Card title="Como o blog aparece">
            <KeyValue
              items={[
                { label: 'Site', value: <a href="https://estoquesimples.com.br/blog" target="_blank" rel="noopener noreferrer">estoquesimples.com.br/blog</a> },
                { label: 'Web app', value: 'Menu › Dicas e novidades' },
                { label: 'App Android', value: 'Menu ⋮ › Dicas e novidades (versão 26 ou mais nova)' },
                { label: 'Push', value: 'Um aviso por post publicado, para contas e aparelhos ativos; a notificação abre o post.' },
                { label: 'SEO', value: 'Páginas renderizadas pela API, com JSON-LD (BlogPosting, FAQ, breadcrumb), sitemap e RSS em /blog/feed.xml.' },
              ]}
            />
          </Card>
        </div>
      )}
    </div>
  );
}
