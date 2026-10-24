# Aplicação web (`apps/web`)

A versão web do Estoque Simples, publicada em **https://estoquesimples.com.br**.
É um cliente a mais da mesma API que o app Android usa: mesma conta, mesmas
empresas, mesmos papéis, mesmos planos. Não há um segundo backend nem regras
de negócio no front.

## Como é servida

Um único serviço no Railway (a API) atende três coisas e escolhe pelo
cabeçalho `Host`:

| Host | O que responde |
| --- | --- |
| `api.estoquesimples.com.br` | a API (`/v1`), o painel (`/admin`), `/docs`, `/health`, `/ready` |
| `estoquesimples.com.br` (hosts de `WEB_APP_HOSTS`) | a aplicação web (arquivos de `apps/web/dist`) e, **na mesma origem**, a API em `/v1` |
| `www.estoquesimples.com.br` | 301 para o domínio principal |

Por isso a web não usa o prefixo `api.` nem CORS: o navegador fala com
`https://estoquesimples.com.br/v1/...`. A separação continua interna
(`apps/api` × `apps/web`); o que é compartilhado é o processo e o deploy.

Implementação: `apps/api/src/platform/http/web-app.ts` (`registerWebApp`),
registrado antes de qualquer rota. Nos hosts da web só passam `/v1`,
`/health` e `/ready`; o resto é arquivo estático (carregado em memória na
subida, com gzip/brotli, `Cache-Control: immutable` para `/assets/` e
`no-store` para o `index.html`) ou o `index.html` (rotas do React Router).
`/admin`, `/docs`, `/metrics` e `/ops` **não** existem nesses hosts. CSP
`default-src 'self'`: nada de script, fonte ou imagem de terceiros.

Arquivos sem compressão (imagens e o vídeo da página inicial) respondem a
`Range` com 206 (`byteRange` em `web-app.ts`): o Safari não toca `<video>`
sem isso. Todo arquivo sai com `ETag` fraca e responde 304 a `If-None-Match`
(`etagFor`), então o HTML em `no-cache` e os arquivos de `public/` são
revalidados sem download. O vídeo de apresentação e a capa ficam em
`apps/web/public/assets/video/` com nome fixo (720p, ~8,6 MB, carregado em
memória com o resto do build; em `/assets/` o cache é de um ano, então ao
trocar o vídeo troque também o nome do arquivo, que é a URL que o Google
indexa pelo `VideoObject`) e a legenda em `apps/web/public/video/`. Por
causa da CSP ele não pode vir do YouTube nem de outro domínio. Ao trocar o
vídeo, mantenha-o leve: cada instância guarda o build inteiro na memória.

### Aba aberta durante um deploy

Cada tela é um arquivo com o nome da versão (`SupportPage-<hash>.js`). Depois
de um deploy, uma aba que já estava aberta ainda pede as telas pelos nomes
antigos, que não existem mais. Três camadas evitam que isso vire tela de erro:

1. **Servidor** (`web-app.ts`): um `/assets/*.js` que não existe responde com
   um módulo mínimo que recarrega a página (no máximo uma vez a cada 30 s),
   em vez de 404. Vale inclusive para abas com o código antigo.
2. **Cliente** (`apps/web/src/lib/chunks.ts`): a importação de tela que falha
   por esse motivo recarrega a página, com a mesma trava; o evento
   `vite:preloadError` faz o mesmo.
3. **Tela de erro** (`components/RouteError.tsx`): se ainda assim algo
   quebrar, a pessoa vê uma explicação e o botão de recarregar — nunca o erro
   cru do roteador.

O `index.html` nunca é guardado em cache, então recarregar sempre traz a
versão nova.

## Página inicial pré-renderizada

A página inicial é uma **segunda página do build** (`apps/web/landing.html`,
entrada `src/landing-main.tsx`; `vite.config.ts` declara as duas), com o
mesmo `<head>` do `index.html` e um JavaScript bem menor: React e a própria
página, sem roteador, sem cache de consultas e sem o provedor de sessão
(~85 KB gz, dos quais ~64 KB são o React). Por isso os links dela são `<a>`
comuns. O que a aplicação completa teria a mais (o chat de suporte e a
retomada da sessão, que troca "Criar conta" por "Abrir meu estoque") chega
depois, em ociosidade, por `src/landing-extras.tsx`, montado numa raiz
própria ao lado da página.

O build (`apps/web/package.json`, script `build`) ainda roda `vite build
--ssr src/entry-prerender.tsx` e `scripts/prerender.mjs`, que reescreve
`dist/landing.html` com a `LandingPage` já em HTML dentro de `#root`, o
JSON-LD do vídeo (`VideoObject`, com os caminhos com hash do build) e a nota
da Google Play (`aggregateRating`), e põe a data do build no `sitemap.xml`.
`web-app.ts` entrega esse arquivo em `/` e o `index.html` nas demais rotas.
Buscadores e prévias de link (WhatsApp, Telegram) leem o conteúdo sem
JavaScript e a primeira pintura não espera o bundle; no navegador
`landing-main.tsx` **hidrata** esse HTML (`hydrateRoot`), então o que já
estava na tela (um vídeo em andamento, o foco do teclado) continua onde
estava. Para a hidratação bater, a `LandingPage` não pode depender de
`window` na renderização (só em efeitos) e o portal dos avisos
(`ToastProvider`) e o chat da raiz da aplicação só entram depois do primeiro
render. O `prerender.mjs` recusa um HTML que não comece pela página.

A `LandingPage` também continua sendo a rota `/` da aplicação (`App.tsx`),
para quem navega de volta a ela de dentro da aplicação; lá ela lê a sessão
com `useAuthOptional` (de `auth/context.ts`, que tem só o contexto e os
hooks, para o pacote da página não arrastar o cliente HTTP). No celular os
extras não baixam o chat (ele só aparece a partir de 900px): só a sessão.

Visitante sem sessão não chama `/v1/auth/web/refresh` ao abrir a página: o
cliente guarda em `localStorage` (`es_web_sessao`) se já houve login neste
navegador e só tenta renovar quando pode haver cookie (ver `api/client.ts`).

SEO estático fica no `index.html`: título, descrição, canonical, Open Graph
(`public/og.jpg`, 1200×630), JSON-LD `SoftwareApplication` (sem preço do
plano pago). `public/robots.txt` libera o site e bloqueia `/app/`, convites e
redefinição de senha; `public/sitemap.xml` lista as páginas públicas. A nota
da Google Play exibida na página (`PLAY_RATING` em `LandingPage.tsx`) é
copiada da listagem a cada versão, com a data no comentário.

## Web app instalável

A web é um **PWA**: `apps/web/public/manifest.webmanifest` (nome, cores,
`start_url: /app`, ícones 192/512 e maskable) + `apple-touch-icon.png` e as
metatags do `index.html`. É o que permite instalar na tela inicial do iPhone
e do iPad (Safari › Compartilhar › Adicionar à Tela de Início), do Android
(Chrome) e do computador (Chrome, Edge, Safari/Dock). Não há service worker:
a instalação funciona, mas o web app **não abre offline**. A página
`/plataformas` (pública) e `/app/plataformas` explicam as plataformas e os
passos, e oferecem "Instalar agora" nos navegadores que disparam
`beforeinstallprompt`. Os ícones PNG são gerados a partir de
`packages/design/icon.svg`; se a marca mudar, regere-os.

A caixa "Instalar o web app" de `/plataformas` abre com um vídeo de 1 min
20 s (`public/assets/video/instalar-web-app.mp4`, 1280×720, com capa
`instalar-web-app-capa.webp` e legendas `public/video/instalar-web-app.vtt`):
iPhone em detalhe (Safari, Compartilhar, Adicionar à Tela de Início,
Adicionar), depois Android e computador, com narração. Os arquivos ficam em
`public/` sem hash: ao trocar o vídeo, troque também o nome do arquivo. O
play gera o evento `platform.install_video_played`.

## Sessão

| | Android | Web |
| --- | --- | --- |
| Access token (JWT EdDSA, 15 min) | memória/armazenamento do app | **só em memória** |
| Refresh token | armazenamento do app | cookie `es_web`: `httpOnly`, `Secure`, `SameSite=Strict`, `Path=/v1/auth/web` |
| Rotas | `/v1/auth/login|register|refresh|logout` | `/v1/auth/web/login|register|refresh|logout`, `/v1/auth/web/invites/:token/accept` |

O JavaScript da página nunca enxerga o refresh token. As rotas `/v1/auth/web/*`
exigem o cabeçalho `x-requested-with: estoquesimples-web` e conferem
`Sec-Fetch-Site` (anti-CSRF). O refresh continua de uso único; como duas abas
podem tentar renovar ao mesmo tempo, o reuso dentro de 20 s responde 409
`AUTH_REFRESH_IN_PROGRESS` (em vez de derrubar a sessão) e o cliente tenta de
novo — além de serializar a renovação entre abas com Web Locks
(`apps/web/src/api/client.ts`). O dispositivo da sessão é registrado com
`platform: "web"`: é o que identifica a origem no painel.

O restante da API (`/v1/me`, `/v1/workspaces/*`…) é chamado com
`Authorization: Bearer`, exatamente como o app faz.

### Abrir na web já conectado

"Abrir a versão web" no app (Conta e Assinatura) e "Abrir no navegador" no
web app instalado (Minha conta, só em modo tela inicial) evitam digitar a
senha de novo:

1. o cliente (Bearer) chama `POST /v1/auth/web-handoff` e recebe um código de
   uso único (`web_handoff_tokens`, só o hash; vale 2 minutos e uma vez);
2. abre `/entrar/app#codigo=…&para=/app/plano&empresa=<id>`; o código vai no
   **fragmento** (não chega a servidor nenhum, nem a logs ou `Referer`) e a
   página o apaga da barra antes de usar;
3. a página chama `POST /v1/auth/web/handoff` (mesmas regras anti-CSRF das
   rotas web) e recebe uma sessão web própria, em cookie. A sessão do app não
   muda. `para` só aceita caminhos dentro de `/app`.

## Estoque: lê por REST, grava pelo motor de sincronização

A web é online (não guarda o estoque no navegador). Lê por rotas paginadas e
grava por rotas REST que **montam operações e as entregam ao mesmo
`SyncService.push` do app** (`apps/api/src/modules/inventory/`):

- mesmas permissões por papel, mesmo teto de produtos do plano, mesma guarda
  de plano (`assertCloudAccess`: nuvem liberada e, sem o recurso de equipe,
  só o proprietário);
- movimentação continua sendo fato imutável: cadastro com estoque inicial
  gera a movimentação `cadastro`, mudar a quantidade gera `ajuste`, cancelar
  gera o estorno ligado à original;
- **o saldo é sempre a soma das movimentações** (um produto criado por `push`
  nasce com saldo zero e o movimento de cadastro forma o saldo; o `pull`
  desconta do saldo do produto as movimentações que o aparelho ainda vai
  receber);
- edição concorrente usa o mesmo `rev`/mescla por campo; conflito de mesmo
  campo responde 409 `SYNC_CONFLICT` e a requisição inteira é desfeita (na
  web nada fica "pendente" sem a pessoa ver);
- idempotência: o cliente gera o `id` do produto/movimentação; repetir a
  requisição não duplica;
- a primeira gravação pela web marca a empresa como semeada (`seeded_at`); um
  aparelho que sincronizar depois adota a nuvem (`SYNC_ALREADY_SEEDED`). Se
  esse aparelho nunca sincronizou, os produtos cadastrados nele antes do login
  vão para a nuvem junto, com o histórico (`LocalMerge`); repetidos (mesmo
  código de barras ou nome) ficam com a versão da nuvem. Restaurar uma cópia
  do banco com a conta conectada faz a mesma conferência na rodada seguinte
  (`SyncMeta.RECONCILIAR`).

Rotas (todas em `/v1/workspaces/:workspaceId`): `products` (lista com busca,
filtros e paginação; `facets`; detalhe; criar; editar; excluir; `restore`;
`bulk`; `import`), `movements` (lista; criar entrada/saída; `:id/cancel`;
`bulk-cancel`), `reports/summary`, `reports/analysis` (plano Equipe). O
contrato completo está em `/docs` (OpenAPI).

## O que a web oferece

| Área | Rota | Observações |
| --- | --- | --- |
| Página inicial, termos e privacidade | `/`, `/termos`, `/privacidade` | públicas; os documentos vêm de `packages/legal` |
| Entrar, criar conta, senha, convite | `/entrar`, `/criar-conta`, `/esqueci-a-senha`, `/redefinir-senha`, `/confirmar-email`, `/convite/:token` | os e-mails da API trazem links para estas telas (`WEB_APP_URL`) |
| Estoque | `/app/estoque` | busca, filtros, cadastro/edição, entrada e saída com "Desfazer", exclusão com restauração, edição em massa, leitor de código de barras (quando o navegador tem `BarcodeDetector`) |
| Histórico | `/app/historico` | filtros, estorno, exportação CSV |
| Relatórios | `/app/relatorios` | resumo por período, impressão/PDF, CSV |
| Análise Avançada | `/app/analise` | plano Equipe |
| Importar e exportar | `/app/importar` | CSV lido no navegador; exportações da API |
| Conflitos | `/app/conflitos` | decisões pendentes da sincronização |
| Identidade visual | `/app/marca` | plano Equipe; proprietário e administradores ([branding.md](branding.md)) |
| Entrada da empresa | `/<identificador>/entrar` | pública; a mesma tela de entrada com a marca da empresa |
| Equipe | `/app/equipe` | membros, papéis, convites (plano Equipe) |
| Plano | `/app/plano` | estado, contratação e pagamentos via Asaas ([billing-asaas.md](billing-asaas.md)) |
| Notificações | `/app/notificacoes` | caixa compartilhada com o app ([notifications.md](notifications.md)) |
| Suporte | `/app/suporte` | as mesmas solicitações do app ([support.md](support.md)) |
| Conta e empresas | `/app/conta`, `/app/empresas` | perfil, senha, sessões, exclusão; criar/trocar de empresa |

Adaptações em relação ao app: não há modo offline (as fotos de produto existem
nas duas pontas: [images.md](images.md)); backup local e notificação de estoque baixo
pelo sistema são do app; a compra pela Google Play só existe no Android e, na
web, a contratação é pelo Asaas.

## Código

```
apps/web/
  src/api/         cliente HTTP (sessão, renovação) e contratos
  src/auth/        sessão do usuário
  src/workspace/   empresa em uso, permissões e plano
  src/components/  estrutura (AppShell), UI básica, peças do estoque
  src/pages/       uma tela por arquivo, carregadas sob demanda
  src/lib/         formatação pt-BR, CSV, unidades, rótulos, analytics
  src/styles/      folha da aplicação
packages/design/   tokens visuais (os do app Android) usados por web e painel
packages/legal/    Termos e Política: fonte única da web e dos assets do app
```

Vite + React 19 + React Router 7 + TanStack Query, sem biblioteca de UI. O
que a interface esconde por permissão ou plano é conveniência: quem decide é
a API, e toda tela trata o erro que ela devolve.

## Rodando

```bash
npm run dev          # API em http://localhost:3000
npm run dev:web      # web em http://localhost:5173 (proxy de /v1 para a API)
```

Para testar exatamente como em produção (API servindo o build):
`npm run build` e suba a API com `WEB_APP_HOSTS=localhost` (só o nome, sem porta) — a raiz de
`http://localhost:3000` passa a ser a aplicação web (e `/admin` deixa de
responder nesse host).

## Variáveis

| Variável | Para quê |
| --- | --- |
| `WEB_APP_HOSTS` | hosts servidos como aplicação web (o primeiro é o principal) |
| `WEB_APP_URL` | endereço público usado nos e-mails e no retorno do pagamento |
| `WEB_SESSION_COOKIE_NAME` | nome do cookie da sessão (padrão `es_web`) |

## O que não fazer

- Não duplicar regra no front: limite de plano, permissão, validação de
  estoque e estado de assinatura vêm da API.
- Não criar um CRUD que grave em `products`/`stock_movements` por fora do
  `SyncService.push`: aparelhos e navegador precisam ver o mesmo histórico.
- Não guardar token em `localStorage` nem pôr credencial de provedor
  (Asaas, Google) no bundle.
- Não reutilizar o cookie do painel para clientes: são identidades distintas.

## Leitor de código de barras e fotos

O leitor (`components/BarcodeScanner.tsx`) aparece na busca do estoque e no
campo de código de barras do cadastro/edição, em qualquer navegador com
câmera. A decodificação (`lib/barcode-decode.ts`, carregado só ao abrir o
leitor, ~110 KB gz) usa o `BarcodeDetector` nativo quando ele existe e lê os
formatos de produto (Chrome no Android e no Mac) e, nos demais (Safari no
iPhone e no iPad, Firefox, Chrome no Windows), a ZXing empacotada com a
aplicação — nada sai da página e a CSP continua `'self'`. Sem câmera ao vivo
(permissão negada), dá para tirar uma foto do código; leitores USB funcionam
sem nada disso, porque digitam no campo.

A foto do produto abre em tela cheia (`components/PhotoViewer.tsx`) na ficha
do produto e no formulário de edição, com zoom da foto (pinça, toque duplo,
roda do mouse, botões) sem ampliar a página; o Voltar do aparelho fecha.

No iPhone, campos com menos de 16px fazem o Safari ampliar a página ao focar
e não desfazer: em telas de toque todo campo tem 16px (`app.css`) e, por
segurança, a troca de tela desfaz um zoom que tenha ficado (`lib/viewport.ts`).

A identidade visual salva (ou o logotipo trocado/removido) vale na hora: a
confirmação do servidor que chega com a prévia aberta é guardada
(`lib/brand.ts`, `committed`) e é ela que fica ao sair da tela de edição. No
app Android, uma marca trocada pela web aparece ao voltar para a tela inicial
(o app confere os direitos no máximo uma vez por minuto) e as telas abertas
se redesenham (`BaseActivity`, `BrandStore.notifyChanged`).

