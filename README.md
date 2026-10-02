# Estoque Simples

Controle de estoque para pequenos negócios: aplicativo Android, aplicação web,
API e painel administrativo, num repositório só.

| Pasta | O que é | Onde roda |
| --- | --- | --- |
| [`apps/android`](apps/android) | app Android (Java + XML), offline-first | Google Play (`br.com.gameloop.estoquesimples`) |
| [`apps/web`](apps/web) | aplicação web (Vite + React) | https://estoquesimples.com.br |
| [`apps/api`](apps/api) | API (Fastify + Postgres): contas, empresas, equipe, estoque, sincronização, assinaturas, suporte, notificações | https://api.estoquesimples.com.br |
| [`apps/admin`](apps/admin) | painel administrativo (Vite + React) | https://api.estoquesimples.com.br/admin |
| [`packages/design`](packages/design) | tokens visuais (os do app) usados pela web e pelo painel | — |
| [`packages/legal`](packages/legal) | Termos de Uso e Política de Privacidade: fonte única da web e do app | — |

API, painel e web são um **único serviço** no Railway: a API serve o painel em
`/admin` e, nos hosts da web, a aplicação web (ver
[docs/web-app.md](docs/web-app.md)). O app Android é independente: funciona
por completo sem a API e fala com ela quando há conta.

O que cada parte compartilha: a API é a única dona das regras de negócio
(permissões, planos, estoque, assinatura); web e Android são clientes dela;
web e painel compartilham só os tokens visuais; web e Android compartilham os
documentos legais.

## Começando (API, painel e web)

Requisitos: Node 22+, Docker (ou Colima) para o Postgres local.

```bash
docker compose up -d                       # Postgres em localhost:5433
cp apps/api/.env.example apps/api/.env
npm ci                                     # instala todos os workspaces
npm run keys:generate                      # chaves Ed25519 dos tokens → cole no .env
npm run migrate
npm run dev                                # API em http://localhost:3000
```

Em outro terminal, conforme o que for mexer:

```bash
npm run dev:web      # aplicação web em http://localhost:5173 (proxy de /v1 para a API)
npm run dev:admin    # painel em http://localhost:5174/admin/ (proxy de /admin/api)
npm run seed:dev     # dados de demonstração (só em development)
```

Primeiro administrador do painel (uma vez):

```bash
ADMIN_PASSWORD='uma-senha-longa' npm run admin:create -- --email voce@exemplo.com --name "Seu Nome"
```

A documentação interativa da API fica em `/docs` e o contrato OpenAPI sai com
`npm run openapi`.

## App Android

Abra `apps/android` no Android Studio (ou `cd apps/android && ./gradlew
:app:assembleDebug`). Precisa de `local.properties` com `sdk.dir` (o Android
Studio cria). A URL da API é fixa em `app/build.gradle`. A chave de
assinatura está em `apps/android/signing/` (ver o README de lá); as senhas
não ficam no repositório. Contexto do app: [apps/android/AGENTS.md](apps/android/AGENTS.md).

## Comandos (na raiz)

| Comando | Para quê |
| --- | --- |
| `npm run dev` / `dev:web` / `dev:admin` | API, web e painel com recarga automática |
| `npm run build` | API + painel + web — o que o Railway roda |
| `npm run start` | sobe a API já compilada (migra antes de abrir a porta) |
| `npm test` | suíte de integração da API contra Postgres real |
| `npm run typecheck` | verificação de tipos de todos os workspaces |
| `npm run migrate` / `migrate:down` / `migrate:status` | schema |
| `npm run admin:create` | cria ou redefine a senha de um administrador do painel |
| `npm run seed:dev` | dados de demonstração |
| `npm run legal:sync` / `legal:check` | copia (ou confere) os documentos legais nos assets do app |
| `npm run openapi` | imprime o contrato OpenAPI |

## Estrutura

```
apps/
  api/        src/modules (auth, users, workspaces, invites, billing, sync,
              inventory, export, notifications, support, push, analytics,
              admin, ops, audit) · src/platform (config, db, http, auth,
              email, jobs, observability, crypto) · tests (integração)
  admin/      interface do painel
  web/        aplicação web
  android/    app Android
packages/
  design/     tokens.css, icon.svg
  legal/      termos.html, privacidade.html, style.css
docs/         contratos e decisões (web, Asaas, notificações, analytics,
              push, suporte, planos)
```

## Documentação

| Documento | Assunto |
| --- | --- |
| [AGENTS.md](AGENTS.md) | arquitetura, entidades, regras de negócio e como estender — leia antes de alterar |
| [DEPLOY.md](DEPLOY.md) | Railway, domínios, variáveis, alertas, backups, rollback |
| [docs/web-app.md](docs/web-app.md) | aplicação web: como é servida, sessão, estoque |
| [docs/billing-asaas.md](docs/billing-asaas.md) | assinatura pela web e passo a passo de produção do Asaas |
| [docs/plans.md](docs/plans.md) | planos e limites |
| [docs/notifications.md](docs/notifications.md) | caixa de notificações e push |
| [docs/support.md](docs/support.md) · [docs/push.md](docs/push.md) · [docs/analytics.md](docs/analytics.md) | contratos para os clientes |

Segredos nunca entram no repositório: `.env` local é ignorado e a produção
usa as variáveis do Railway. A única exceção deliberada é a chave de
assinatura do app em `apps/android/signing/` (repositório privado), sem as
senhas.
