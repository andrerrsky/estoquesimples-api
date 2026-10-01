# AGENTS.md — contexto do Estoque Simples (API, painel e base da versão web)

Leia este arquivo inteiro antes de alterar qualquer coisa. Ele descreve o que
o sistema é, por que foi construído assim e o que não pode ser quebrado. O
código está comentado em português e os comentários explicam decisões, não
sintaxe; eles são parte do contexto.

## 1. O produto

**Estoque Simples** é um aplicativo Android (`br.com.gameloop.estoquesimples`,
Java + XML, Material 2) de controle de estoque para pequenos negócios. Ele é
**offline-first**: tudo é gravado no SQLite do aparelho, e a nuvem é uma camada
adicional para assinantes. A API pode estar fora do ar ou desligada e o app
continua funcionando por completo.

Repositórios:

| Repositório | O que é |
| --- | --- |
| `estoquesimples-api` (este) | API Fastify + Postgres no Railway, painel administrativo em `/admin`, contrato de analytics |
| `estoquesimples/EstoqueSimples/Codigo/EstoqueSimples` | app Android; fala com `https://api.estoquesimples.com.br` (URL fixa em `app/build.gradle`) |

Produção: um serviço no Railway (Nixpacks, `npm run build` → `npm run start`,
healthcheck `/ready`), Postgres do Railway, domínio já cadastrado. Staging é
um projeto separado com banco separado.

## 2. Arquitetura da API

- **Runtime**: Node 22+, TypeScript ESM (`"type": "module"`, imports com
  `.js`), Fastify 5, Zod via `fastify-type-provider-zod`, Drizzle ORM sobre
  `pg`. Sem framework de injeção: `AppServices` (`src/platform/http/context.ts`)
  é o container explícito.
- **Módulos** (`src/modules/*`): cada um tem `*.service.ts` (regra de
  negócio), `*.routes.ts` (contrato HTTP) e, quando há corpo, `*.schemas.ts`
  (Zod, sempre `.strict()` para impedir mass assignment). Rotas registradas em
  `src/platform/http/server.ts`.
- **Plataforma** (`src/platform/*`): config (`env.ts` valida tudo no boot e
  recusa subir com valor inválido), banco, autenticação, e-mail, fila de jobs,
  observabilidade, criptografia.
- **Erros**: `AppError` com códigos estáveis (`ErrorCode` em
  `src/platform/http/errors.ts`). Códigos são contrato público com o app;
  mensagens podem mudar, códigos não. O envelope é sempre
  `{ error: { code, message, details?, correlationId, ...extra } }`.
- **Logs**: pino com redação de segredos (`observability/logger.ts`). Nunca
  logar token, senha, purchase token. Alertas saem como log `error` com
  `alerta: true`.
- **Métricas**: `/metrics` (Prometheus) e `/ops/*` atrás de `OPS_TOKEN`.
  Rótulos nunca carregam valor vindo do usuário.
- **Jobs**: fila na própria tabela `jobs` (`FOR UPDATE SKIP LOCKED`),
  handlers registrados por módulo (`*.jobs.ts`), reagendamento com
  `uniqueKey`. Não introduzir Redis/broker.

## 3. Banco de dados e isolamento multi-tenant

**A fonte da verdade do schema são as migrations SQL** em
`src/platform/db/migrations/NNNN_nome.up.sql` (+ `.down.sql`). Os arquivos
Drizzle em `src/platform/db/schema/*.ts` são apenas o modelo de leitura para o
query builder. **Nunca rode `drizzle-kit push/generate`**: o gerador não
expressa RLS, GRANTs por coluna, funções SECURITY DEFINER, índices parciais e
triggers — exatamente o que sustenta o isolamento.

Regras do migrator (`src/platform/db/migrate.ts`): uma migration aplicada
nunca é editada (checksum); numeração sempre no topo da sequência; cada uma
roda na própria transação com `lock_timeout` de 5s; `npm run start` migra
antes de abrir a porta, com advisory lock. Nunca remova uma coluna na mesma
versão que para de usá-la.

**Isolamento (migrations 0002, 0004, 0007)**: a aplicação conecta como dono
das tabelas. Requisições de tenant rodam em `withTenant(db, {workspaceId,
userId}, fn)` (`src/platform/db/client.ts`), que faz `set_config('app.workspace_id')`,
`set_config('app.user_id')` e `SET LOCAL ROLE app_user`. Todas as tabelas de
tenant têm `ENABLE + FORCE ROW LEVEL SECURITY` com duas políticas: a de tenant
(`workspace_id = app_current_workspace()`) e a de sistema
(`app_is_system_context()` = papel diferente de `app_user` **e** nenhum
workspace na transação). Consequências:

- Caminhos de sistema (jobs, reconciliação, autenticação, painel admin) rodam
  como dono **sem** workspace definido e enxergam tudo.
- Dentro de `withTenant`, `app_user` só tem os GRANTs listados nas migrations
  (por coluna em `users`, `sessions`, `subscriptions`, `workspaces`). Uma
  coluna nova exigida por um caminho de tenant precisa de GRANT explícito.
- Tabelas do painel e de analytics (`platform_admins`, `admin_sessions`,
  `admin_audit_log`, `admin_account_notes`, `analytics_events`) só têm a
  política de sistema e nenhum GRANT para `app_user`: **não as acesse de dentro
  de `withTenant`** — o insert falha. `trackServerEvent` roda fora da transação
  de tenant por isso.
- Chaves estrangeiras de estoque são compostas `(workspace_id, id)` porque a
  checagem de FK ignora RLS.

## 4. Entidades

| Tabela | Papel | Observações |
| --- | --- | --- |
| `users` | conta (e-mail único entre vivas, case-insensitive) | `status` ∈ active/suspended/pending_deletion; `permission_version` invalida access tokens quando muda; bloqueio progressivo por `failed_login_attempts`/`locked_until`; `deleted_at` (não existe hoje rotina que purgue `pending_deletion`) |
| `devices` | instalação do app por usuário (`install_id`) | o app envia `device` no register/login/aceite de convite; `last_seen_at` atualiza no refresh |
| `sessions` / `refresh_tokens` | login = sessão; refresh rotaciona com detecção de reuso | revogar sessão = logout imediato; só o hash do token é gravado |
| `workspaces` | empresa (tenant) | `owner_user_id`; `change_seq` é o cursor de sync (monotônico por tenant via `next_change_seq()`); `seeded_at` marca a carga inicial; `tombstone_horizon_seq`; `deleted_at` (exclusão lógica só pelo painel) |
| `roles` / `permissions` / `role_permissions` | RBAC como dados | papéis: proprietario(100) > administrador(80) > gerente(60) > operador(40) > consulta(20); cache por processo em `authorize.ts` |
| `workspace_members` | participação | `status` active/suspended/removed; uma linha por (workspace, user), readmissão reativa |
| `invites` | convite por e-mail com token `esinv_…` | um pendente por e-mail/empresa; aceite cria a conta se não existir |
| `plans` / `plan_features` | planos e recursos como dados | `gratuito` (sem sync) e `basico` (produto Google `assinatura`, base plan `plano-basico`) |
| `subscriptions` | assinatura **da empresa** | estados: pendente, ativa, carencia, suspensa, cancelada_mas_ativa, expirada, reembolsada, substituida; uma viva por empresa (índice parcial); purchase token só cifrado (AES-GCM) + hash |
| `subscription_events` | notificações RTDN do Google | idempotentes por `notification_id`; nunca fonte de verdade — disparam consulta à Play Developer API |
| `products` / `stock_movements` | estoque na nuvem | ids UUID gerados no aparelho; movimentações são fatos imutáveis com quantidade **com sinal**; cancelamento = movimento compensatório (`reverses_movement_id`); `quantity_cache` mantido por trigger (desligado na carga inicial); exclusão de produto é lógica (lápide) |
| `sync_operations` / `sync_cursors` / `initial_uploads(_batches)` / `conflict_log` | infraestrutura de sync | idempotência de operação, posição de cada aparelho, sessão de carga inicial retomável, três lados de cada conflito |
| `audit_log` | trilha dos clientes | `AuditAction` fechado em `modules/audit/audit.service.ts`; gravada na mesma transação da ação |
| `jobs` / `app_config` | fila e configuração dinâmica (`sync`, `backup_verificado`) | |
| `platform_admins` / `admin_sessions` / `admin_audit_log` / `admin_account_notes` | painel administrativo | ver §7 |
| `analytics_events` | eventos de uso | ver §8 |

## 5. Autenticação e autorização

**App (Bearer/JWT)**: access token EdDSA (Ed25519, `kid`, 15 min) + refresh
token opaco (60 dias, rotação, reuso derruba a sessão). Cada requisição
confirma no banco que a sessão está viva e que `permission_version` bate
(`authenticate.ts`), o que torna revogação imediata. Login bloqueia
progressivamente; e-mail inexistente gasta o mesmo tempo (argon2 dummy).
Senha: argon2id (OWASP), política mínima de 10 caracteres.

**Empresa**: `requireWorkspace(permissao)` resolve a participação e as
permissões; o `workspaceId` da URL nunca vale por si só. Regras estruturais:
ninguém concede papel igual ou superior ao seu; proprietário só muda por
transferência (antigo dono vira administrador); remover/suspender derruba
sessões na mesma transação.

**Painel admin (cookie)**: identidade própria em `platform_admins` (owner >
support > viewer). Cookie httpOnly, `SameSite=Strict`, assinado
(`ADMIN_COOKIE_SECRET`), `path=/admin`; token opaco com hash em
`admin_sessions`; expira por inatividade (12h) e teto absoluto (7 dias). Toda
mutação exige o cabeçalho `x-requested-with: estoquesimples-admin` e
`Sec-Fetch-Site` same-origin (anti-CSRF). Rate limit estrito no login e
bloqueio progressivo. Nunca aceita o Bearer do app. Ver
`src/modules/admin/admin-auth.plugin.ts`.

**Ops (`OPS_TOKEN`)**: `/metrics`, `/ops/*` — usados por coletor e scripts;
sem o token configurado respondem 404.

## 6. Regras de negócio que não se quebram

1. O app funciona sem a API. Nada na nuvem apaga dado local; desligar a sync
   (`app_config.sync` ou `FEATURE_SYNC_ENABLED`) só pausa o envio.
2. Assinatura é da empresa; o dono paga e todos os membros sincronizam.
   Direito de acesso (`ENTITLED_STATES` = ativa, carencia, cancelada_mas_ativa)
   é sempre decidido no servidor a partir do que o Google diz. O app guarda o
   retrato por `ENTITLEMENT_OFFLINE_MAX_DAYS`.
3. `SUBSCRIPTION_STATE_CANCELED` do Google significa "renovação desligada",
   não "sem acesso" (→ `cancelada_mas_ativa`). `REVOKED` tira acesso na hora.
4. Um purchase token destrava uma empresa só. Compras não confirmadas
   (acknowledge) são reembolsadas pelo Google em 3 dias; a reconciliação
   (`billing.reconcile`) tenta de novo.
5. Sincronização: operações idempotentes por `opId`; conflitos nunca
   descartam dado sem rastro (`conflict_log` guarda base/mantido/descartado);
   cursor abaixo de `tombstone_horizon_seq` recebe `SYNC_RESYNC_REQUIRED`;
   versão de protocolo fora da janela recebe 426.
6. Movimentação é fato imutável; saldo pode ficar negativo de propósito
   (eventos chegam fora de ordem no modo offline).
7. Auditoria é gravada na mesma transação da ação (`recordAudit`); eventos
   fora do caminho crítico usam `recordAuditSafe`.
8. Nomes duplicados de produto são barrados no banco, não no app.

## 7. Painel administrativo (`/admin`)

Servido pela própria API na mesma origem (SPA em `admin/`, build em
`admin/dist`, fallback para `index.html`, CSP `default-src 'self'`). API em
`/admin/api/*` (`src/modules/admin/*`), toda rota com `requireAdmin(papel)`:

| Área | Rotas | Papel mínimo para alterar |
| --- | --- | --- |
| Sessão e administradores | `auth/*`, `admins/*` | owner |
| Visão geral | `overview` | — |
| Usuários | `users`, `users/:id`, `timeline`, `events`, `notes`, ações (`suspend`, `reactivate`, `unlock`, `verify-email`, `revoke-sessions`, `send-password-reset`, `cancel-deletion`, `devices/:id/revoke`, `PATCH`) | support |
| Empresas | `workspaces`, detalhe, `products`, `movements`, `conflicts`, `timeline`, `notes`, ações (`PATCH`, `delete`, `restore`, `transfer-ownership`, membros, convites) | support |
| Assinaturas | `billing/stats`, `subscriptions`, detalhe, `refresh`, `events`, `events/:id/retry`, `plans` | support (planos: owner) |
| Analytics | `analytics/summary`, `metrics`, `events`, `event-names`, `events/:name/series`, `funnel`, `retention` | — |
| Auditoria | `audit/users`, `audit/admins`, `audit/actions` | — |
| Operação | `ops/status`, `ops/sync` (owner), `ops/jobs`, `retry`, `cancel` | support |
| Avaliações da Play Store | `reviews/stats`, `reviews`, `reviews/sync`, `reviews/:id/reply`, `reviews/:id/draft`, `settings/openai` (GET/PUT/DELETE) | support (chave da OpenAI: owner) |
| Push (FCM) | `push/stats`, `push/screens`, `push/audience/preview`, `push/campaigns` (CRUD, `send`, `cancel`, `deliveries`), `push/test` | support |
| Atendimento (suporte pelo app) | `support/stats`, `support/tickets` (lista, detalhe, `messages`, `status`, `PATCH`, `draft`) | support |

Princípios do painel:

- **Toda ação que altera dado de cliente exige um `reason`** (min. 3
  caracteres) e grava em `admin_audit_log` (`recordAdminAudit`, dentro da
  transação). Quando a ação afeta a conta do cliente (sessões, papel,
  suspensão), também grava em `audit_log` com `origem: 'suporte'`, para a
  linha do tempo da conta continuar completa. Novas ações entram no
  `AdminAction` (lista fechada) e nos rótulos de `admin/src/lib/labels.ts`.
- Operações de leitura de estoque são somente leitura; o estoque é do cliente.
- Exclusão de empresa é lógica e reversível; não existe purga. Ações
  destrutivas na interface pedem palavra de confirmação (`ConfirmDialog`).
- O purchase token nunca é exposto (nem cifrado, nem hash). "Forçar" estado de
  assinatura = reconsultar o Google (`BillingService.refreshWorkspaceSubscription`).
- Primeiro admin: `ADMIN_BOOTSTRAP_EMAIL/PASSWORD` no boot (idempotente) ou
  `npm run admin:create`. Não há cadastro público.
- Listagens: `paginationQuerySchema` (`page`, `pageSize` ≤ 200), envelope
  `{items, page, pageSize, total}`; buscas usam `lower(...) LIKE` (bancos
  pequenos; se crescer, `pg_trgm`).
- Séries temporais: `admin-series.ts` (bucket no fuso `America/Sao_Paulo`,
  `fillSeries` completa zeros, intervalo aberto com folga de 5 min).

Interface (`admin/`): Vite + React 19 + React Router 7 + TanStack Query, sem
biblioteca de UI ou de gráficos. Tokens visuais em `admin/src/styles/app.css`
são os do app Android (`#1C679D`, `#F4F7FA`, raios 14/10/8, sem sombras).
Componentes compartilhados em `components/ui.tsx`, gráficos SVG em
`charts/charts.tsx` (paleta categórica validada para daltonismo; uma escala
por eixo; tooltip em toda superfície). Cliente HTTP em `api/client.ts`
(cookie + cabeçalho anti-CSRF; 401 derruba a sessão local). Estado de
listagem vive na URL (`lib/hooks.ts`). Rótulos e traduções de estados em
`lib/labels.ts`.

### Avaliações da Play Store (`src/modules/reviews/`)

`play_reviews` é a cópia local do que `reviews.list` devolve (só avaliações
com comentário alteradas nos últimos 7 dias; o job `play.reviews_sync` roda a
cada 6 h para não perder nada). Responder (`reviews.reply`) vai ao Google
primeiro e só depois atualiza a linha; limite de 350 caracteres. O rascunho
por IA usa a chave da OpenAI guardada cifrada em `admin_settings`
(`PurchaseTokenCipher`, mesma chave AES em repouso) e nunca devolve a chave ao
painel; modelo em `OPENAI_MODEL`. Exige a permissão "Responder a avaliações"
na conta de serviço do Play.

### Push notifications (`src/modules/push/`)

Firebase Cloud Messaging HTTP v1 com a mesma conta de serviço do Play
(`FIREBASE_SERVICE_ACCOUNT_JSON` opcional para separar); exige a API do FCM
ativada e o papel "Firebase Cloud Messaging API Admin". O app registra o
token em `PUT /v1/push/tokens` (auth opcional; um token vivo por
`install_id`) e reporta `delivered`/`opened` em `POST /v1/push/events`.
Campanhas (`push_campaigns`) têm público declarativo (`push.schemas.ts`,
resolvido no envio), estado `draft → queued → sending → sent|failed|cancelled`
e uma linha por token em `push_deliveries`, que forma o funil alvo → aceita
pelo FCM → entregue → aberta. O envio roda no job `push.send_campaign`
(concorrência `PUSH_SEND_CONCURRENCY`); mensagens são **só de dados**, o app
monta a notificação (por isso entrega e abertura são mensuráveis). Tokens
`UNREGISTERED`/`INVALID_ARGUMENT` são revogados. Detalhes para os clientes
em [docs/push.md](docs/push.md).

### Suporte pelo app (`src/modules/support/`)

Substitui o "mande um e-mail" da tela Sobre. O app abre solicitações em
`/v1/support/tickets` (auth opcional; sempre com `installId`), mandando
`device` e `diagnostics`; o painel responde em `/admin/api/support`. Quem
não tem conta é dono pelo `install_id`; ao ganhar Bearer, as solicitações
anônimas da instalação passam para a conta (claim). Estados `open →
answered → resolved`, e escrever reabre. Responder ou resolver manda push
**só de dados** `type=support` (`SupportService.notifyUser`) para os tokens
da instalação e da conta; sem aparelho, e-mail (`kind: support_reply`).
Notas internas (`internal`) não notificam. Rascunho por IA reutiliza a
chave da OpenAI das avaliações. Contrato em [docs/support.md](docs/support.md).

## 8. Analytics (eventos de uso)

Tabela `analytics_events`, uma linha por evento, sem pré-agregação; retenção
por job (`ANALYTICS_RETENTION_DAYS`, padrão 400). Duas entradas:

- **App → `POST /v1/analytics/events`** (`src/modules/analytics/`): lote de
  até `ANALYTICS_MAX_BATCH` eventos `{id (uuid), name, occurredAt (ms),
  workspaceId?, sessionKey?, properties?}` + `device {installId, platform,
  appVersionCode}`. Autenticação opcional: com Bearer o evento é atribuído ao
  usuário; sem, só à instalação. `id` é chave de idempotência. `workspaceId`
  só é aceito se o usuário participa da empresa. Contrato completo para os
  clientes em [docs/analytics.md](docs/analytics.md).
- **API → `trackServerEvent(services, {...})`**: marcos observados no servidor
  (`user.registered`, `user.logged_in`, `workspace.created`, `invite.*`,
  `subscription.linked/state_changed`, `sync.pushed/pulled/
  initial_upload_completed/conflict_resolved`, `export.completed`). Nunca
  lança; chamado **fora** da transação de tenant.

Catálogo e funil padrão em `analytics.events.ts`; nomes seguem
`dominio.acao` (`^[a-z0-9_]+(\.[a-z0-9_]+)*$`). Propriedades são planas, no
máximo 20 chaves e 4 KB, e **nunca** levam dado pessoal ou nome/valor de
produto do cliente. Métricas do painel são um registro extensível em
`admin-analytics.service.ts` (`METRICS`): acrescentar uma métrica é
acrescentar uma entrada com `key`, `label` e a consulta.

"Usuário ativo" = teve evento em `analytics_events` **ou** ação em
`audit_log` no período (`ACTIVITY_UNION`). Sessões e aparelhos só guardam o
último uso e por isso não servem para séries.

## 9. Padrões de código

- Português nos nomes de domínio, comentários e mensagens; inglês nas métricas
  Prometheus e em nomes de evento de analytics.
- Toda rota declara `schema` (Zod) com `response` por status e `tags`; rotas
  do painel usam `hide: true` no OpenAPI. Corpos com `.strict()`.
- Regra de negócio vive no serviço; a rota traduz HTTP. Mutação com auditoria
  roda numa única transação (`db.transaction` / `withTenant`).
- Datas saem como ISO string; contagens como `::int` no SQL cru.
- SQL cru (`sql\`\``) é usado quando o builder atrapalha (agregações,
  UNION); parâmetros sempre interpolados via template, nunca `sql.raw` com
  entrada do usuário (`sql.raw` só com constantes do código, como a coluna de
  ordenação escolhida de um mapa fechado).
- Testes de integração (`tests/`) rodam contra Postgres real (`docker compose
  up -d`; sem Docker Desktop use Colima). `npm test`, `npm run typecheck`,
  `npm run build` precisam passar antes de um PR (CI faz os três).
- Segredos: nunca no repositório; `.env` local ignorado; Railway para produção.

## 10. Como estender

- **Nova rota do app**: schema Zod → serviço → rota com `preHandler:
  [app.authenticate, requireWorkspace('permissao')]` → auditoria se muda
  estado → (opcional) `trackServerEvent` fora da transação → teste em
  `tests/<modulo>/`.
- **Nova permissão/papel**: migration inserindo em `permissions` /
  `role_permissions`; o cache é por processo (deploy).
- **Nova coluna de tenant**: migration com GRANT explícito se `app_user`
  precisa ler/escrever; atualizar o arquivo Drizzle correspondente.
- **Nova tela do painel**: rota em `src/modules/admin/*` (com `requireAdmin`),
  página em `admin/src/pages/`, entrada em `admin/src/App.tsx` e no `NAV` de
  `components/Shell.tsx`; toda mutação com `reason` + `AdminAction` +
  rótulo em `labels.ts`.
- **Novo evento de analytics**: adicionar ao catálogo em
  `analytics.events.ts` e a `docs/analytics.md`; o app pode emitir antes de a
  API conhecer o nome.
- **Nova métrica**: entrada em `METRICS` (`admin-analytics.service.ts`).

## 11. Base para a versão web do Estoque Simples

A API já foi desenhada para mais de um cliente: `devices.platform` aceita
`web`, o JWT tem `aud` fixo por produto, `CORS_ORIGINS` existe para liberar
origens de navegador, o contrato de sync é o mesmo para qualquer cliente
(`docs/`), e o painel prova que um front React consegue viver ao lado da API.
O roteiro e as decisões já tomadas para a versão web estão em
[docs/web-app.md](docs/web-app.md). Resumo do que **não** fazer: não
duplicar regras de negócio no front (direitos, permissões e estados vêm da
API); não criar uma segunda API; não reutilizar o cookie do painel para
clientes finais (o app web usa Bearer + refresh, como o Android).

## 12. Operação

Deploy, alertas, backups, lançamento gradual e rollback: [DEPLOY.md](DEPLOY.md).
Variáveis novas do painel/analytics: `ADMIN_PANEL_ENABLED`,
`ADMIN_COOKIE_SECRET`, `ADMIN_BOOTSTRAP_EMAIL/PASSWORD/NAME`,
`ADMIN_SESSION_IDLE_HOURS`, `ADMIN_SESSION_MAX_DAYS`, `ADMIN_COOKIE_NAME`,
`ANALYTICS_RETENTION_DAYS`, `ANALYTICS_MAX_BATCH`, `ANALYTICS_RATE_LIMIT_MAX`
(todas com padrão; ver `.env.example`).

## 13. Pendências conhecidas (não são bugs a "corrigir" sem decidir)

- Não existe rotina que apague definitivamente contas em `pending_deletion`
  após os 30 dias prometidos na resposta de `DELETE /v1/me`.
- A versão do app Android com analytics, push e suporte pelo app ainda não
  foi publicada na Play Store; até lá o painel mostra só o que a API observa
  e nenhuma solicitação de suporte real chega.
- `trustProxy: false` no Fastify: atrás da borda do Railway, o rate limit por
  IP de rotas anônimas agrupa clientes; trocar por `trustProxy: '<cidr>'`
  quando o endereço da borda for conhecido.
