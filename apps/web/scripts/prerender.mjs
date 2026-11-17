// Reescreve dist/landing.html (gerado pelo Vite a partir de landing.html)
// com a página inicial já renderizada dentro de #root. A API entrega esse arquivo em `/` (ver
// apps/api/src/platform/http/web-app.ts): buscadores e prévias de link
// (WhatsApp, Telegram) leem o conteúdo sem executar JavaScript, e a primeira
// pintura não espera o bundle. Roda depois de `vite build` e de
// `vite build --ssr src/entry-prerender.tsx --outDir dist-ssr`.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const ssr = join(root, 'dist-ssr');

const { render, renderVideo, renderPlanilha, PLAY_RATING, VIDEO, PLANILHA, DUVIDAS } = await import(pathToFileURL(join(ssr, 'entry-prerender.js')).href);
const SITE = 'https://estoquesimples.com.br';
// O React emite `<link rel="preload">` das imagens no começo do fragmento
// (ele não tem um <head> para pôr). Dentro de #root esse nó faria a
// hidratação falhar (o primeiro filho deixaria de ser a página), e o ícone
// não precisa de preload: sai.
const html = render().replace(/^(<link\b[^>]*>)+/, '');
if (!html.includes('id="lp-titulo"')) throw new Error('prerender: a página inicial não foi renderizada');
if (!html.startsWith('<div class="lp">')) throw new Error('prerender: o HTML não começa pela página (hidratação falharia)');

// A base é o landing.html que o Vite acabou de gerar (com a entrada leve e
// os preloads dos seus pedaços), não o index.html da aplicação.
const index = readFileSync(join(dist, 'landing.html'), 'utf8');
const marker = '<div id="root"></div>';
if (!index.includes(marker)) throw new Error('prerender: #root não encontrado em dist/landing.html');
if (!index.includes('landing-')) throw new Error('prerender: dist/landing.html não aponta para a entrada leve');

// O vídeo é descrito ao Google na página de exibição (/video), não aqui.
// O Google só indexa um vídeo que seja o conteúdo principal da página; na
// página inicial ele é uma seção entre várias, e o Search Console recusava
// a indexação com "o vídeo não está em uma página de exibição". O JSON-LD
// mora onde o vídeo é o assunto — ver buildVideoPage, no fim deste arquivo.

// A nota da Google Play entra no JSON-LD só aqui, onde ela também está
// visível na página (regra do Google para rich results), a partir da mesma
// constante que a página usa.
const rating = `"aggregateRating": { "@type": "AggregateRating", "ratingValue": "${PLAY_RATING.ratingValue}", "ratingCount": "${PLAY_RATING.ratingCount}", "bestRating": "5" },`;
if (!index.includes('"offers":')) throw new Error('prerender: JSON-LD sem "offers" em index.html');

const landing = index
  .replace('"offers":', `${rating} "offers":`)
  .replace(marker, `<div id="root">${html}</div>`);

writeFileSync(join(dist, 'landing.html'), landing);

// --- Página de exibição do vídeo (/video) ---------------------------------
//
// HTML estático, sem bundle e sem hidratação: o <video> é nativo e os links
// são <a> comuns. Reaproveita a folha de estilo e o pré-carregamento da
// fonte que o Vite gerou para a página inicial, então a página tem a cara do
// site sem um segundo build. O JSON-LD VideoObject mora aqui (ver o
// comentário lá em cima).

/** A legenda vira transcrição: blocos separados pelas pausas da narração. */
function transcriptFromVtt(vtt) {
  const seconds = (stamp) => {
    const [h, m, rest] = stamp.split(':');
    return Number(h) * 3600 + Number(m) * 60 + Number(rest.replace(',', '.'));
  };
  const cues = [];
  for (const chunk of vtt.split(/\r?\n\r?\n/)) {
    const lines = chunk.split(/\r?\n/).filter(Boolean);
    const timing = lines.find((line) => line.includes('-->'));
    if (!timing) continue;
    const [from, to] = timing.split('-->').map((part) => part.trim());
    const text = lines.slice(lines.indexOf(timing) + 1).join(' ').trim();
    if (text) cues.push({ start: seconds(from), end: seconds(to), text });
  }
  // Uma pausa de meio segundo entre uma fala e a seguinte marca mudança de
  // assunto no roteiro; é por ela que a transcrição é separada.
  const blocks = [];
  for (const cue of cues) {
    const last = blocks[blocks.length - 1];
    if (last && cue.start - last.end <= 0.5) {
      last.text = `${last.text} ${cue.text}`;
      last.end = cue.end;
    } else {
      blocks.push({ start: cue.start, end: cue.end, text: cue.text });
    }
  }
  return blocks.map((block) => ({
    time: `${Math.floor(block.start / 60)}:${String(Math.floor(block.start % 60)).padStart(2, '0')}`,
    text: block.text,
  }));
}

const transcript = transcriptFromVtt(readFileSync(join(root, 'public/video/apresentacao.vtt'), 'utf8'));
const videoHtml = renderVideo(transcript).replace(/^(<link\b[^>]*>)+/, '');
if (!videoHtml.includes('lp-video__player')) throw new Error('prerender: a página do vídeo não foi renderizada');

const stylesheet = /<link rel="stylesheet"[^>]*>/.exec(index)?.[0];
const fontPreload = /<link rel="preload"[^>]*fonts[^>]*>/.exec(index)?.[0] ?? '';
if (!stylesheet) throw new Error('prerender: folha de estilo não encontrada em dist/landing.html');

const VIDEO_URL = `${SITE}/video`;
const videoTitle = 'Vídeo: como o Estoque Simples funciona no dia a dia';
const videoDescription = 'Veja em 1 min 40 s o cadastro de produtos, as entradas e saídas, o aviso de estoque baixo e os relatórios, nas telas reais do aplicativo. Com legenda e transcrição.';
const videoJsonLd = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'VideoObject',
  name: VIDEO.name,
  description: VIDEO.description,
  thumbnailUrl: [`${SITE}${VIDEO.poster}`],
  uploadDate: VIDEO.uploadDate,
  duration: VIDEO.duration,
  contentUrl: `${SITE}${VIDEO.src}`,
  url: VIDEO_URL,
  inLanguage: 'pt-BR',
  isFamilyFriendly: true,
  publisher: { '@type': 'Organization', name: 'Estoque Simples', url: `${SITE}/` },
  transcript: transcript.map((block) => block.text).join(' '),
});

// Layout próprio desta página (as classes .lp- vêm da folha do site).
const videoCss = `
    .vp-main { max-width: 1040px; margin: 0 auto; padding: 28px 20px 8px; }
    .vp-head { max-width: 760px; margin: 0 auto 24px; text-align: center; }
    .vp-title { margin: 8px 0 12px; }
    .vp-frame { margin-top: 0; }
    .vp-cta { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin: 24px 0 8px; }
    .vp-section { max-width: 760px; margin: 40px auto 0; }
    .vp-section .landing__h2 { margin-bottom: 8px; }
    .vp-transcript { list-style: none; margin: 20px 0 0; padding: 0; }
    .vp-transcript li { display: flex; gap: 14px; padding: 10px 0; border-top: 1px solid var(--border); }
    .vp-transcript__time { flex: 0 0 44px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .vp-links { margin: 16px 0 0; padding-left: 20px; }
    .vp-links li { margin: 6px 0; }
    .vp-footer { max-width: 1040px; margin: 48px auto 0; padding: 20px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 14px; text-align: center; }
    @media (max-width: 640px) { .vp-main { padding: 20px 16px 8px; } }`;

const videoPage = `<!doctype html>
<!-- Página de exibição do vídeo (/video), gerada em scripts/prerender.mjs.
     HTML estático: sem bundle, sem hidratação. Ver src/pages/VideoPage.tsx. -->
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#1C679D" />
    <title>${videoTitle} · Estoque Simples</title>
    <meta name="description" content="${videoDescription}" />
    <link rel="canonical" href="${VIDEO_URL}" />
    <meta property="og:type" content="video.other" />
    <meta property="og:site_name" content="Estoque Simples" />
    <meta property="og:locale" content="pt_BR" />
    <meta property="og:url" content="${VIDEO_URL}" />
    <meta property="og:title" content="${videoTitle}" />
    <meta property="og:description" content="${videoDescription}" />
    <meta property="og:image" content="${SITE}${VIDEO.poster}" />
    <meta property="og:image:width" content="1280" />
    <meta property="og:image:height" content="720" />
    <meta property="og:video" content="${SITE}${VIDEO.src}" />
    <meta property="og:video:type" content="video/mp4" />
    <meta name="twitter:card" content="player" />
    ${fontPreload}
    <link rel="icon" type="image/svg+xml" href="/icon.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    ${stylesheet}
    <style>${videoCss}
    </style>
    <script type="application/ld+json">${videoJsonLd}</script>
  </head>
  <body>
    ${videoHtml}
  </body>
</html>
`;
writeFileSync(join(dist, 'video.html'), videoPage);
console.log(`prerender: dist/video.html (${(videoPage.length / 1024).toFixed(0)} kB, ${transcript.length} trechos de transcrição)`);

// --- Página da planilha gratuita (/planilha-de-controle-de-estoque) -------
//
// Mesma receita da /video: HTML estático, sem bundle. Existe porque as
// variações de "planilha de controle de estoque" somam mais de 10 mil buscas
// por mês no Brasil (ver docs/pautas-blog-2026-11.md) — o maior termo do
// nosso nicho, e o público que ainda controla estoque na mão.

const planilhaHtml = renderPlanilha().replace(/^(<link\b[^>]*>)+/, '');
if (!planilhaHtml.includes('pl-duvidas')) throw new Error('prerender: a página da planilha não foi renderizada');
if (!existsSync(join(dist, PLANILHA.arquivo.replace(/^\//, '')))) {
  throw new Error(`prerender: ${PLANILHA.arquivo} não está no build — a página ofereceria um download quebrado`);
}

const PLANILHA_URL = `${SITE}/planilha-de-controle-de-estoque`;
const planilhaTitulo = 'Planilha de controle de estoque grátis (Excel)';
const planilhaDescricao = 'Baixe grátis, sem cadastro: planilha de controle de estoque com entradas, saídas, saldo automático e aviso de estoque mínimo. Funciona no Excel e no Google Planilhas.';
// As mesmas perguntas que estão visíveis na página (regra do Google).
const planilhaFaq = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: DUVIDAS.map((item) => ({
    '@type': 'Question',
    name: item.p,
    acceptedAnswer: { '@type': 'Answer', text: item.r },
  })),
});

const planilhaGrafo = JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebPage',
      '@id': `${PLANILHA_URL}#pagina`,
      url: PLANILHA_URL,
      name: planilhaTitulo,
      description: planilhaDescricao,
      inLanguage: 'pt-BR',
      datePublished: PLANILHA.atualizadaIso,
      dateModified: PLANILHA.atualizadaIso,
      isPartOf: { '@id': `${SITE}/#site` },
      publisher: { '@id': `${SITE}/#org` },
      primaryImageOfPage: { '@id': `${PLANILHA_URL}#capa` },
    },
    {
      '@type': 'ImageObject',
      '@id': `${PLANILHA_URL}#capa`,
      url: `${SITE}/og-planilha.jpg`,
      width: 800,
      height: 420,
    },
    {
      '@type': 'CreativeWork',
      '@id': `${PLANILHA_URL}#arquivo`,
      name: 'Planilha de controle de estoque',
      description: 'Planilha em Excel com cadastro de produtos, entrada e saída, saldo automático, aviso de estoque mínimo e resumo do valor em estoque.',
      url: `${SITE}${PLANILHA.arquivo}`,
      encodingFormat: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileFormat: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentSize: PLANILHA.tamanho,
      inLanguage: 'pt-BR',
      dateModified: PLANILHA.atualizadaIso,
      isAccessibleForFree: true,
      license: `${SITE}/termos`,
      author: { '@id': `${SITE}/#org` },
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'BRL', availability: 'https://schema.org/InStock' },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Início', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: 'Planilha de controle de estoque', item: PLANILHA_URL },
      ],
    },
    {
      '@type': 'SoftwareApplication',
      name: 'Estoque Simples',
      operatingSystem: 'Android, Web',
      applicationCategory: 'BusinessApplication',
      inLanguage: 'pt-BR',
      installUrl: 'https://play.google.com/store/apps/details?id=br.com.gameloop.estoquesimples',
      aggregateRating: { '@type': 'AggregateRating', ratingValue: PLAY_RATING.ratingValue, ratingCount: PLAY_RATING.ratingCount, bestRating: '5' },
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'BRL', description: 'Plano Gratuito, para uma pessoa' },
    },
  ],
});

const planilhaCss = `
    .pl-main { max-width: 1040px; margin: 0 auto; padding: 8px 20px; }
    .pl-hero { max-width: 760px; margin: 0 auto; padding: 8px 0 44px; text-align: center; }
    .pl-title { margin: 10px 0 14px; }
    .pl-lead { margin: 0 auto 26px; max-width: 620px; }
    .pl-baixar { margin: 0 0 10px; }
    .pl-meta { margin: 0; font-size: 14px; color: var(--lp-on-brand-soft); }
    .pl-meta--escuro { color: var(--text-muted); }
    .pl-section { max-width: 820px; margin: 48px auto 0; }
    .pl-section .landing__h2 { margin-bottom: 14px; }
    .pl-abas { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 18px; }
    .pl-aba { border: 1px solid var(--border); border-radius: var(--radius-card, 14px); padding: 16px 18px; background: var(--surface-content); }
    .pl-aba__nome { margin: 0 0 6px; font-size: 16px; }
    .pl-aba p { margin: 0; color: var(--text-muted); font-size: 15px; }
    .pl-passos { margin: 18px 0 0; padding-left: 22px; }
    .pl-passos li { margin: 12px 0; }
    .pl-limites { margin: 14px 0 20px; padding-left: 22px; }
    .pl-limites li { margin: 8px 0; }
    .pl-app { border-top: 1px solid var(--border); padding-top: 36px; }
    .pl-cta { display: flex; flex-wrap: wrap; gap: 12px; margin: 22px 0 10px; }
    .pl-duvidas dt { font-weight: 700; margin-top: 18px; }
    .pl-duvidas dd { margin: 6px 0 0; color: var(--text-muted); }
    .pl-footer { max-width: 1040px; margin: 56px auto 0; padding: 20px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 14px; text-align: center; }
    .pl-previa { margin: 28px 0 0; }
    .pl-previa__legenda { margin: 0 0 10px; color: var(--text-muted); font-size: 15px; }
    .pl-previa__rolagem { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-card, 14px); }
    .pl-tabela { border-collapse: collapse; width: 100%; min-width: 720px; font-size: 13px; background: #fff; }
    .pl-tabela th { background: #14507A; color: #fff; font-weight: 700; padding: 10px 12px; text-align: left; white-space: nowrap; }
    .pl-tabela td { padding: 9px 12px; border-top: 1px solid #e3e9ef; background: #F1F4F7; }
    .pl-td--entrada { background: #FFF8E1; }
    .pl-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .pl-situacao { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 700; font-size: 12px; }
    .pl-situacao--ok { background: #E3F4E5; color: #14591B; }
    .pl-situacao--repor { background: #FFECB3; color: #6F4300; }
    .pl-situacao--zerado { background: #FFD9D9; color: #8A1818; }
    .pl-lista-abas { margin: 16px 0 0; }
    .pl-lista-abas dt { font-weight: 700; margin-top: 14px; }
    .pl-lista-abas dd { margin: 4px 0 0; color: var(--text-muted); }
    .pl-baixar--meio { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin: 26px 0 0; }
    .pl-prova { margin: 18px 0 0; font-size: 15px; }
    .pl-versao { margin: 26px 0 0; color: var(--text-muted); font-size: 14px; }
    .pl-section p { line-height: 1.65; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    @media (max-width: 760px) {
      .pl-abas { grid-template-columns: 1fr; }
      .pl-main { padding: 8px 16px; }
      .pl-hero { text-align: center; }
      .pl-lead { text-align: left; }
    }`;

const planilhaPagina = `<!doctype html>
<!-- Página da planilha gratuita, gerada em scripts/prerender.mjs.
     HTML estático: sem bundle. Ver src/pages/PlanilhaPage.tsx. -->
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#1C679D" />
    <title>${planilhaTitulo} · Estoque Simples</title>
    <meta name="description" content="${planilhaDescricao}" />
    <link rel="canonical" href="${PLANILHA_URL}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Estoque Simples" />
    <meta property="og:locale" content="pt_BR" />
    <meta property="og:url" content="${PLANILHA_URL}" />
    <meta property="og:title" content="Planilha de controle de estoque grátis — sem cadastro" />
    <meta property="og:description" content="${planilhaDescricao}" />
    <meta property="og:image" content="${SITE}/og-planilha.jpg" />
    <meta property="og:image:width" content="800" />
    <meta property="og:image:height" content="420" />
    <meta property="og:image:alt" content="Planilha de controle de estoque aberta, com a coluna Situação marcando Repor" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="${SITE}/og-planilha.jpg" />
    ${fontPreload}
    <link rel="icon" type="image/svg+xml" href="/icon.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    ${stylesheet}
    <style>${planilhaCss}
    </style>
    <script type="application/ld+json">${planilhaFaq}</script>
    <script type="application/ld+json">${planilhaGrafo}</script>
  </head>
  <body>
    ${planilhaHtml}
  </body>
</html>
`;
writeFileSync(join(dist, 'planilha.html'), planilhaPagina);
console.log(`prerender: dist/planilha.html (${(planilhaPagina.length / 1024).toFixed(0)} kB)`);

// Só a página inicial é reescrita a cada build: só ela ganha a data dele.
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const sitemapPath = join(dist, 'sitemap.xml');
writeFileSync(sitemapPath, readFileSync(sitemapPath, 'utf8').replace(/(<loc>https:\/\/estoquesimples\.com\.br\/<\/loc><lastmod>)[^<]*/, `$1${today}`));
rmSync(ssr, { recursive: true, force: true });
console.log(`prerender: dist/landing.html (${(landing.length / 1024).toFixed(0)} kB)`);
