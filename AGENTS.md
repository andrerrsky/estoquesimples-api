# AGENTS.md — app Android do Estoque Simples

Contexto para quem for mexer neste código. O contexto completo do sistema
(backend, regras de negócio, painel administrativo, analytics) está em
`estoquesimples-api/AGENTS.md`; este arquivo cobre o que é específico do
aplicativo.

## O que é

App Android de controle de estoque, **offline-first**: tudo é gravado no
SQLite do aparelho (`data/LocalDb.java`, banco `estoque`) e a nuvem é uma
camada opcional para assinantes. O app precisa continuar funcionando por
completo com a API fora do ar.

- Pacote `br.com.gameloop.estoquesimples`, `versionCode 24`, minSdk 24,
  targetSdk 36, Java 17 (sem Kotlin, sem Compose), UI em XML com ViewBinding,
  Material Components 1.13 (tema `CustomActionBarTheme`, só claro).
- API: `https://api.estoquesimples.com.br` (`API_BASE_URL` em
  `app/build.gradle`), cliente próprio sobre `HttpURLConnection`
  (`sync/ApiClient.java`), `PUT` no lugar de `PATCH`, cabeçalhos
  `X-Sync-Protocol: 1`, `X-App-Version`, `Idempotency-Key`.
- Sessão em `EncryptedSharedPreferences` (`sync/SessionManager.java`).
- Billing: Play Billing 8, assinatura `assinatura` / base plan `plano-basico`
  (`billing/PlayBilling.java`); produto legado `pro`.

## Identidade visual (fonte: `res/values/colors.xml`, `dimens.xml`, `styles.xml`)

Marca `#1C679D` (escura `#15537E`), fundo `#F4F7FA`, cartões brancos com
borda `#E3E8EE` e raio 14dp, texto `#1A2330` / secundário `#5C6B7A`, sucesso
`#1B7A3D`, aviso `#E65100`, erro `#C62828`. Sem elevação. Bottom nav azul com
cinco abas (Início, Novo, Histórico, Relatórios, Imp/Exp). O painel
administrativo e a futura versão web usam estes mesmos tokens.

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
3. Direito de sincronizar vem de `GET /entitlement` e vale offline até
   `offlineValidUntil`; o app não decide sozinho.
4. Códigos de erro da API são contrato (`error.code`); nunca decidir pelo
   texto da mensagem. `426` = atualizar o app; `SYNC_RESYNC_REQUIRED` =
   recarregar do servidor.

## Pendências combinadas com a API

- **Analytics**: o app ainda não emite eventos de uso. O contrato e o
  catálogo estão em `estoquesimples-api/docs/analytics.md`
  (`POST /v1/analytics/events`, lote idempotente, sem dado pessoal). Sugestão:
  outbox em `LocalDb` + `Worker` que envia em lote. O Firebase Analytics atual
  não alimenta o painel.
- **Push**: `EstoqueFirebaseMessagingService.onNewToken` é no-op; a API ainda
  não guarda tokens.
