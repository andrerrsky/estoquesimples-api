# Blog (`/blog`)

Dicas, avisos e novidades para quem usa o Estoque Simples, com três
leitores: o site (`estoquesimples.com.br/blog`, feito para o Google), o
web app (mesmas páginas, dentro do menu "Dicas e novidades") e o app
Android (`BlogActivity`/`BlogPostActivity`, a partir da versão 26). Quem
escreve é o painel (`/admin/blog`) ou a IA, duas vezes por semana.

## Onde está

| Parte | Caminho |
| --- | --- |
| Tabela e migração | `blog_posts` · `apps/api/src/platform/db/migrations/0021_blog.*.sql` · `schema/blog.ts` |
| Regras, leitura e publicação | `apps/api/src/modules/blog/blog.service.ts` |
| Markdown → HTML (sanitizado) | `apps/api/src/modules/blog/markdown.ts` |
| Categorias fixas | `apps/api/src/modules/blog/blog.categories.ts` |
| Páginas renderizadas no servidor (SEO), sitemap e RSS | `apps/api/src/modules/blog/blog-ssr.ts` · `blog-pages.ts` (ligado em `platform/http/web-app.ts`) |
| API pública | `GET /v1/blog/posts`, `/v1/blog/facets`, `/v1/blog/posts/:slug`, `/v1/blog/covers/:file` (`blog.routes.ts`) |
| Painel | `apps/api/src/modules/admin/admin-blog.routes.ts` · `apps/admin/src/pages/BlogPage.tsx` (lista, IA e configurações) · `BlogEditorPage.tsx` (editor) |
| IA | `apps/api/src/modules/blog/blog-ai.ts` (pautas, fatos do produto, regras de estilo, validação) · `blog.jobs.ts` (agenda) |
| Push e caixa de notificações | `BlogService.notifyEveryone` (job `blog.notify_post`) |
| Web | `apps/web/src/pages/BlogPage.tsx` · `components/PublicShell.tsx` · `styles/pages-blog.css` |
| Android | `apps/android/.../blog/` (`BlogClient`, `BlogHtml`, `BlogActivity`, `BlogPostActivity`) |

## O post

Markdown no painel (título é o H1; `##`/`###` viram seções com `id`,
listas, citação, negrito, link, imagem). A API gera o HTML uma vez ao
salvar (`content_html`), já limpo: só as tags do renderizador, links só
`http(s)` ou caminhos do site, externos com `rel="noopener nofollow"`.
Campos para o Google: `seo_title` (até 70, opcional), `excerpt` (40–200,
vira meta description), `faq` (vira `FAQPage`), `cover` (WebP até 1600 px
no mesmo bucket das fotos, chave `blog/covers/<hash>.webp`), `tags`.
Sem capa enviada, a API gera uma (`blog-cover.ts`): SVG com título,
categoria e marca, rasterizado pelo sharp em `/v1/blog/covers/auto/<slug>.webp`
(1200×630; `-4x3` e `-1x1` para as outras proporções do Google), em cache
na memória. Onde o servidor não tem fonte, a rota redireciona para
`/og.jpg`.
`author_name` começa em "Equipe Estoque Simples". `reading_minutes` sai
da contagem de palavras.

**Exclusivo para quem tem conta** (`members_only`, checkbox no editor):
no site público e para quem não está logado só aparece o começo
(`previewHtml`: abertura e primeira seção, até 40% dos blocos) com um
cadeado e o convite para criar conta; `GET /v1/blog/posts/:slug` devolve
o post inteiro quando vem um Bearer válido (sessão opcional) e marca
`locked: true` quando cortou. Toda conta (gratuita ou não) lê tudo. O
HTML do servidor é sempre o de quem não tem conta (o cookie de sessão
não chega às páginas); o web app pede o post de novo quando há sessão.
No JSON-LD o post sai com `isAccessibleForFree: false` e `hasPart`
apontando para o trecho restrito, o markup que o Google pede para
conteúdo com acesso restrito; o RSS leva só o começo.

Estados: `draft` → `published` (com `published_at`) → de volta a `draft`
("despublicar"). O `slug` é fixo depois de publicado: links já
compartilhados continuam valendo. Apagar é definitivo (a página passa a
404; o sitemap deixa de listar).

## SEO (versão web)

O `web-app.ts` intercepta `/blog`, `/blog/:slug`, `/sitemap.xml` e
`/blog/feed.xml` antes dos arquivos estáticos e devolve HTML pronto a
partir do `index.html` da web (mesmo CSS, mesmo bundle): o Google e quem
compartilha no WhatsApp veem a página inteira sem JavaScript, e o React
só "hidrata" por cima (`main.tsx` limpa `[data-ssr]` e monta com os dados
de `<script id="blog-data">`).

Cada página traz `<title>` (a marca só entra quando cabe em ~60
caracteres), meta description, canonical, `max-image-preview:large`, Open Graph e
Twitter card, `article:published_time`, e JSON-LD: `Blog` + `BreadcrumbList`
na lista; `BlogPosting` (autor `Organization`, imagem, datas, `wordCount`)
+ `BreadcrumbList` + `FAQPage` no post. Filtros por categoria têm
canonical próprio (`/blog?categoria=...`); busca e filtro por mês saem
com `noindex` para não duplicar. Paginação usa `rel=prev/next`.
Barra final ou maiúsculas em `/blog/...` dão 301 para a forma canônica;
categoria vazia e página além da última saem `noindex`.
`/sitemap.xml` lista as páginas fixas, as categorias com post e os posts
publicados (`lastmod`);
`/blog/feed.xml` é RSS 2.0. `Cache-Control: public, max-age=120,
stale-while-revalidate=600`.

## IA: três vezes por semana

Job `blog.ai_write`, terça e sexta às 12:00 UTC (9h em Brasília) para os
posts públicos e quinta para o **post exclusivo** (`aiMembersOnlyWeekly`;
desligado, ficam só terça e sexta), único por data. O exclusivo recebe
um briefing a mais (`MEMBERS_ONLY_BRIEF`): a abertura e a primeira seção
precisam valer por si (é o que o site público mostra), e a partir da
segunda seção entra o material prático que justifica a conta (checklist,
modelo pronto, passo a passo ou exemplo completo), com ~350 palavras a
mais; a validação exige 4+ seções e uma dessas seções práticas, e recusa
texto que peça cadastro. Usa a mesma chave da OpenAI configurada em Avaliações › OpenAI
(`openai-client.ts`, `completeJson` com `response_format: json_object`).
Sem chave, o job registra e sai.

Para a IA não fugir do tema, o prompt é fechado (`blog-ai.ts`):

- **Banco de pautas** (`AI_TOPICS`, 36 itens com categoria, briefing e
  palavra-chave) rodando em round-robin entre categorias; cada pauta é
  usada uma vez (`ai_topic`). Acabando o banco, o modelo propõe uma pauta
  nova dentro das mesmas categorias.
- **Fatos do produto** (`PRODUCT_FACTS`): o que o app faz e o que não
  faz, planos, plataformas. A IA só pode citar funcionalidades dali.
- **Central de ajuda** (`packages/help/faq.json`): as perguntas da
  categoria entram como contexto ("RAG" simples, sem vetor: a base é
  pequena e cabe no prompt).
- **Regras de estilo e SEO** (`STYLE_RULES`): português do Brasil,
  "você", 600–1400 palavras, H2 com a palavra-chave, "## Resumo" no fim,
  um link interno (`/criar-conta`, `/ajuda`, outro post), sem link
  externo, sem promessas ("garantido", "100%"), sem inventar números.
- **Validação** (`BlogAiWriter.check`): tamanho (meta por pauta,
  `targetWords`: 950, ou 1600 nas pautas concorridas), seções,
  palavra-chave no título, no resumo, no primeiro parágrafo e em um `##`,
  menção ao Estoque Simples, links só para páginas do site e posts
  publicados (pelo menos um post quando já há 3), nenhum link externo nem
  promessa, FAQ com 3 itens, e recusa de pauta cuja palavra-chave já tem
  post (canibalização, também na escolha da pauta). Falhou, tenta uma
  segunda vez com os motivos; falhou de novo, não publica nada e registra.

Configurações (painel › Blog › IA e configurações, guardadas em
`admin_settings`/`blog_settings`): `aiEnabled`, `aiAutoPublish` (desligado
= vira rascunho para revisão) e `notifyOnPublish`. O post da IA sai com
`ai_generated = true`, `ai_model` e `ai_topic`; o painel mostra a tag
"gerado por IA" e o rascunho avisa qual pauta foi usada. "Escrever com
IA" no painel gera um rascunho na hora (pauta seguinte ou uma escolhida
no banco).

## Push a cada post

Publicar enfileira `blog.notify_post` (único por post). O job cria uma
notificação `blog.post` na caixa de cada conta ativa (dedupe
`blog:<id>`), marca `notified_at` e dispara push para os aparelhos vistos
nos últimos 90 dias, em lotes de `PUSH_SEND_CONCURRENCY`, com
`screen: 'blog'` e a URL do post. Web (`sw.js`, página de notificações) e
Android (`MainActivity.pushScreenTarget`) abrem o post. Despublicar e
publicar de novo não avisa duas vezes.

## Conferir localmente

```bash
curl -s localhost:3000/blog | head -c 600
curl -s localhost:3000/sitemap.xml
curl -s localhost:3000/v1/blog/posts?category=novidades
```

(`localhost` é host da web; `127.0.0.1` cai na API/painel.)
