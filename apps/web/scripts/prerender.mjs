// Reescreve dist/landing.html (gerado pelo Vite a partir de landing.html)
// com a página inicial já renderizada dentro de #root. A API entrega esse arquivo em `/` (ver
// apps/api/src/platform/http/web-app.ts): buscadores e prévias de link
// (WhatsApp, Telegram) leem o conteúdo sem executar JavaScript, e a primeira
// pintura não espera o bundle. Roda depois de `vite build` e de
// `vite build --ssr src/entry-prerender.tsx --outDir dist-ssr`.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const ssr = join(root, 'dist-ssr');

const { render, PLAY_RATING, VIDEO } = await import(pathToFileURL(join(ssr, 'entry-prerender.js')).href);
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

// O vídeo da página, descrito ao Google: miniatura, duração e arquivo com
// URL absoluta (os caminhos vêm do build, com hash).
const videoLd = `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'VideoObject',
  name: VIDEO.name,
  description: VIDEO.description,
  thumbnailUrl: [`${SITE}${VIDEO.poster}`],
  uploadDate: VIDEO.uploadDate,
  duration: VIDEO.duration,
  contentUrl: `${SITE}${VIDEO.src}`,
  inLanguage: 'pt-BR',
})}</script>`;

// A nota da Google Play entra no JSON-LD só aqui, onde ela também está
// visível na página (regra do Google para rich results), a partir da mesma
// constante que a página usa.
const rating = `"aggregateRating": { "@type": "AggregateRating", "ratingValue": "${PLAY_RATING.ratingValue}", "ratingCount": "${PLAY_RATING.ratingCount}", "bestRating": "5" },`;
if (!index.includes('"offers":')) throw new Error('prerender: JSON-LD sem "offers" em index.html');

const landing = index
  .replace('</head>', `    ${videoLd}\n  </head>`)
  .replace('"offers":', `${rating} "offers":`)
  .replace(marker, `<div id="root">${html}</div>`);

writeFileSync(join(dist, 'landing.html'), landing);

// Só a página inicial é reescrita a cada build: só ela ganha a data dele.
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const sitemapPath = join(dist, 'sitemap.xml');
writeFileSync(sitemapPath, readFileSync(sitemapPath, 'utf8').replace(/(<loc>https:\/\/estoquesimples\.com\.br\/<\/loc><lastmod>)[^<]*/, `$1${today}`));
rmSync(ssr, { recursive: true, force: true });
console.log(`prerender: dist/landing.html (${(landing.length / 1024).toFixed(0)} kB)`);
