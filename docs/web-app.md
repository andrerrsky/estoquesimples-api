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
  aparelho que sincronizar depois adota a nuvem (`SYNC_ALREADY_SEEDED`).

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
