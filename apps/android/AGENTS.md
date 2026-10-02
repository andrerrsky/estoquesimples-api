# AGENTS.md — app Android do Estoque Simples

Contexto para quem for mexer neste código. O app mora em `apps/android` do
monorepo; o contexto completo do sistema (API, regras de negócio, aplicação
web, painel administrativo, analytics) está no [AGENTS.md da raiz](../../AGENTS.md).
Este arquivo cobre o que é específico do aplicativo.

O app é um projeto Gradle independente: não participa dos workspaces npm e
não entra no deploy do Railway. Para trabalhar nele, abra `apps/android` no
Android Studio ou rode `./gradlew :app:assembleDebug` nesta pasta
(`local.properties` com `sdk.dir` não é versionado).

## O que é

App Android de controle de estoque, **offline-first**: tudo é gravado no
SQLite do aparelho (`data/LocalDb.java`, banco `estoque`) e a nuvem é uma
camada opcional para quem cria conta. O app precisa continuar funcionando por
completo com a API fora do ar. A mesma conta abre a aplicação web
(estoquesimples.com.br), que trabalha direto sobre os dados da nuvem: o que
é feito lá chega ao aparelho na sincronização seguinte, pelas mesmas regras
de conflito.

- Pacote `br.com.gameloop.estoquesimples`, `versionCode 24`, minSdk 24,
  targetSdk 36, Java 17 (sem Kotlin, sem Compose), UI em XML com ViewBinding,
  Material Components 1.13 (tema `CustomActionBarTheme`, só claro).
- API: `https://api.estoquesimples.com.br` (`API_BASE_URL` em
  `app/build.gradle`), cliente próprio sobre `HttpURLConnection`
  (`sync/ApiClient.java`), `PUT` no lugar de `PATCH`, cabeçalhos
  `X-Sync-Protocol: 1`, `X-App-Version`, `Idempotency-Key`.
- Sessão em `EncryptedSharedPreferences` (`sync/SessionManager.java`).
- Billing: Play Billing 8, assinatura `assinatura` / base plan `plano-basico`
  (`billing/PlayBilling.java`), exibida como **plano Equipe**; produto legado
  `pro` (Versão PRO antiga: só recursos premium no aparelho).
- Planos (desde 1º/10/2026): a nuvem é **grátis com conta** — só o
  proprietário sincroniza, até o teto de produtos (`limits.products`, hoje 50)
  que a API informa em `GET /entitlement`. O plano Equipe libera equipe,
  produtos sem teto e Análise Avançada. `EntitlementManager` separa
  `canSync()` (nuvem), `isPaid()` (assinatura), `teamEnabled()`,
  `productLimit()/productsUsed()`. `PLAN_LIMIT_REACHED` e
  `SUBSCRIPTION_REQUIRED` (403) pausam a fila sem perder nada; o worker grava
  `SyncMeta.BLOQUEIO_PLANO` e a tela inicial mostra o aviso com atalho ao
  plano. Convidar na Equipe passa pelo `teamEnabled()` antes do servidor.

## Identidade visual (fonte: `res/values/colors.xml`, `dimens.xml`, `styles.xml`)

Marca `#1C679D` (escura `#15537E`), fundo `#F4F7FA`, cartões brancos com
borda `#E3E8EE` e raio 14dp, texto `#1A2330` / secundário `#5C6B7A`, sucesso
`#1B7A3D`, aviso `#E65100`, erro `#C62828`. Sem elevação. Bottom nav azul com
cinco abas (Início, Novo, Histórico, Relatórios, Imp/Exp). O painel
administrativo e a aplicação web usam estes mesmos tokens, copiados em
`packages/design/tokens.css` — mudou aqui, mude lá.

## Modelo local

- `Estoque` (produtos): `uuid`, `name`, `amount`/`value`/`min_stock`
  **armazenados como texto** (podem ter vírgula; use `data/Quantities.java`),
  `deleted_at`, `rev`.
- `EstoqueHistorico` (movimentações): `uuid`, `product_uuid`, `change_type`
  (`entrada`, `saida`, `ajuste`, `cadastro`, `importacao`, `edicao`,
  `cancelamento`; legados `venda`/`compra`), `quantity` **sem sinal** (a
  direção vem do tipo; `SIGNED_QUANTITY_SQL` em `data/MovementRepository.java`),
  `reverses_uuid` para cancelamentos.
- `sync_outbox` / `sync_meta`: fila de operações e cursor. No fio
  (`data/SyncPayloads.java`) a quantidade vai **com sinal**.

## Regras que não se quebram

1. Nunca apagar dado local por causa de resposta da API; desligar a sync só
   pausa o envio.
2. Movimentação é imutável; erro se corrige com `cancelamento` compensatório.
3. Direito de sincronizar (e o teto de produtos) vem de `GET /entitlement` e
   vale offline até `offlineValidUntil`; o app não decide sozinho.
4. Códigos de erro da API são contrato (`error.code`); nunca decidir pelo
   texto da mensagem. `426` = atualizar o app; `SYNC_RESYNC_REQUIRED` =
   recarregar do servidor.

## Documentos legais e assinatura do app

- **Termos e Política**: a fonte é `packages/legal` (raiz do monorepo),
  compartilhada com a aplicação web. Os arquivos em
  `app/src/main/assets/legal/` são **cópia**: não edite aqui. Altere em
  `packages/legal` e rode `npm run legal:sync` na raiz (o CI reprova cópia
  defasada com `npm run legal:check`).
- **Chave de assinatura**: `signing/key.jks` é a única chave versionada
  (repositório privado). Senhas ficam fora do repositório; ver
  [signing/README.md](signing/README.md). Não há `signingConfig` no Gradle: o
  `.aab` é assinado pelo assistente do Android Studio.
- **Assinatura do plano**: no app a compra é sempre pela Google Play. A
  empresa também pode ter assinado pela web (Asaas); para o app não muda
  nada — `GET /entitlement` devolve o mesmo retrato, qualquer que seja o
  provedor. Não ofereça gerenciar pela Play uma assinatura que não veio dela.

## Integrações com a API

- **Analytics (implementado)**: pacote `analytics/` — `Analytics.track(context,
  nome, props)` grava na fila local (`analytics.db`, separado do banco do
  estoque para não ser sobrescrito por restauração/importação),
  `AnalyticsWorker` envia lotes de até 200 para `POST /v1/analytics/events`
  (com Bearer quando há sessão), `AnalyticsScheduler` agenda o envio (1 min
  após o evento, e a cada 6 h). `BaseActivity.onResume` emite `screen.viewed`;
  `MainActivity.onCreate` emite `app.opened`. Os demais pontos (produto,
  movimentação, estorno, edição em massa, busca, filtro, relatório, análise,
  importação/exportação, backup, paywall com `trigger`, compra, notificação)
  estão anotados com `Analytics.track(...)` junto da ação. Catálogo e regras
  de privacidade: [docs/analytics.md](../../docs/analytics.md). O Firebase
  Analytics continua só com os eventos automáticos; o painel lê estes.
- **Push (implementado)**: pacote `push/` — `PushRegistrar.register(context)`
  pede o token ao Firebase e envia a `PUT /v1/push/tokens` (chamado em
  `MainActivity.onCreate`, em `onNewToken` e após login/cadastro em
  `AccountService`); `PushEvents.report(context, campaignId, evento)` manda
  `delivered`/`opened` a `POST /v1/push/events`. As campanhas do painel chegam
  como mensagens só de dados (`type=campaign`, `campaignId`, `title`, `body`,
  `screen?`, `url?`); `EstoqueFirebaseMessagingService` monta a notificação e
  reporta a entrega; `MainActivity.handlePushIntent` reporta a abertura e
  abre a tela/link pedidos (`pushScreenTarget`). Contrato em
  [docs/push.md](../../docs/push.md).
- **Suporte pelo app (implementado)**: `SupportActivity` (lista, menu ⋮
  "Ajuda e suporte" e botão "Falar com o suporte" na tela Sobre),
  `SupportNewActivity` (categoria em chips, assunto, mensagem; nome/e-mail
  opcionais só sem conta) e `SupportTicketActivity` (conversa, responder,
  marcar como resolvida). `sync/SupportClient` fala com `/v1/support` com
  ou sem Bearer, sempre com o `installId`, e envia `deviceInfo()` +
  `diagnostics()` (lê SyncMeta/Outbox/Diagnostics — fora da main thread).
  A resposta do painel chega como push `type=support` com `ticketId`:
  `EstoqueFirebaseMessagingService` põe `EXTRA_TICKET_ID` no Intent e
  `MainActivity.handlePushIntent` abre a conversa. Contrato em
  [docs/support.md](../../docs/support.md). O e-mail de contato não é mais
  oferecido na tela Sobre.
