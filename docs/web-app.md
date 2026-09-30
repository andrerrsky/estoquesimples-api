# Base para a versão web do Estoque Simples

Este documento fixa as decisões já tomadas para que a versão web possa ser
construída sem reescrever o backend nem as regras de negócio. Nada aqui
exige mudança na API hoje; o que já existe está marcado como **pronto** e o
que falta, como **a fazer**.

## O que a API já oferece (pronto)

| Necessidade | Como a API atende |
| --- | --- |
| Identidade e sessão | `POST /v1/auth/register|login|refresh|logout`, JWT EdDSA de 15 min + refresh rotativo; `device.platform: "web"` já é aceito |
| Empresas e equipe | `/v1/workspaces*`, `/v1/invites*` — mesmas regras de papel e permissão do Android; `GET /v1/workspaces/:id` devolve `permissions` para a UI esconder ações |
| Assinatura | `GET /v1/workspaces/:id/entitlement` decide o acesso; vínculo de compra continua vindo do Play (ver "compra na web") |
| Estoque | contrato de sync (`initial-upload`, `push`, `pull`, `conflicts`) é o mesmo para qualquer cliente; `GET /v1/workspaces/:id/export` dá o retrato completo |
| Analytics | `POST /v1/analytics/events` com `platform: "web"` ([analytics.md](analytics.md)) |
| CORS | `CORS_ORIGINS` (lista separada por vírgula) libera as origens do front; hoje vazio porque só existe cliente nativo |
| Documentação viva | `/docs` (Scalar) e `npm run openapi` para gerar tipos de cliente |

## Decisões de arquitetura para o front web

1. **Repositório**: novo workspace `web/` neste repositório (ao lado de
   `admin/`), com o mesmo toolchain (Vite + React + TypeScript + TanStack
   Query). Compartilhar tokens visuais, componentes básicos e o cliente HTTP
   extraindo-os para `packages/ui` e `packages/api-client` **quando** o
   segundo consumidor existir — não antes. Até lá, `admin/` é a referência.
2. **Hospedagem**: um serviço estático separado no Railway (ou o mesmo
   serviço servindo `web/dist` em `/app`, como o painel faz em `/admin`).
   Preferir separado: o app web é público e escala diferente do painel.
   Domínio sugerido `app.estoquesimples.com.br`, adicionado a `CORS_ORIGINS`.
3. **Autenticação**: Bearer + refresh como o Android, **não** o cookie do
   painel. Access token em memória, refresh token em `localStorage` com
   rotação (reuso derruba a sessão — a API já faz isso). `device.installId`
   é um UUID persistido no navegador.
4. **Offline-first no navegador**: mesma estratégia do Android — IndexedDB
   como fonte local (produtos, movimentações, outbox de operações) e o
   protocolo de sync existente para convergir. O `SyncEngine` do Android
   (`sync/SyncEngine.java`) é a especificação de referência da máquina de
   estados do cliente; portar a lógica, não reinventar. Se a primeira versão
   web for "somente online", ela ainda deve usar `push`/`pull` (nunca um CRUD
   direto novo), para que aparelhos e navegador vejam o mesmo histórico.
5. **Regras de negócio ficam na API**: direitos de assinatura, permissões,
   validação de nomes duplicados, conflitos. O front nunca decide acesso.
6. **Compra na web** (a fazer): hoje a assinatura só nasce do Google Play.
   Para vender na web será preciso um segundo provedor (ex.: Stripe) com o
   mesmo modelo: `subscriptions` ganha `provider`, `BillingService` ganha um
   cliente por provedor e a reconciliação consulta cada um. O restante
   (direitos por empresa, uma assinatura viva, estados) não muda.
7. **Analytics**: emitir os mesmos nomes de evento do catálogo com
   `platform: "web"`; o painel já separa por plataforma.

## Roteiro sugerido

1. `CORS_ORIGINS` com a origem de desenvolvimento; gerar tipos de cliente a
   partir de `npm run openapi`.
2. `web/` com login, lista de empresas, lista de produtos e histórico via
   `pull` (somente leitura). Já dá valor a quem usa no computador.
3. Registro de movimentações e cadastro de produtos via `push` com outbox em
   IndexedDB.
4. Equipe e convites (aceite de convite por link web: `GET/POST /v1/invites/:token`).
5. Compra na web (provedor novo) e paywall.

## O que não fazer

- Não criar endpoints "para a web" que dupliquem os do app; se a web precisa
  de algo, o Android também se beneficia.
- Não guardar access token em cookie sem repensar o CSRF da API.
- Não ler tabelas de estoque fora de `withTenant` em nome de um cliente.
