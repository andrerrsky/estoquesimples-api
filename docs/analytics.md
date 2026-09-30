# Contrato de analytics para os clientes (Android e web)

A API recebe eventos de uso em `POST /v1/analytics/events`. Este documento é
o que um cliente precisa para emitir eventos que o painel administrativo saiba
ler. O catálogo canônico está em `src/modules/analytics/analytics.events.ts`
e pode ser consultado em `GET /v1/analytics/catalog`.

## Princípios

1. **Privacidade**: propriedades nunca levam dado pessoal (e-mail, nome,
   telefone) nem conteúdo do estoque do cliente (nome de produto, valores em
   dinheiro, observações). Leve tipo, quantidade de itens, nome de tela,
   formato, resultado — o suficiente para entender o uso, nada para
   identificar o negócio de alguém.
2. **Fila local, nunca bloqueio**: o app grava o evento numa fila (SQLite) e
   envia em lote quando puder (ao abrir, ao sincronizar, a cada N minutos).
   Falha de rede não pode afetar a experiência. Reenvio é seguro: o `id` é a
   chave de idempotência.
3. **Um evento por fato**, no momento em que acontece, com o relógio do
   aparelho em `occurredAt` (ms). O servidor corrige relógios muito
   adiantados/atrasados e guarda também `receivedAt`.

## Requisição

```http
POST /v1/analytics/events
Authorization: Bearer <access token>      # opcional: sem ele, evento só da instalação
Content-Type: application/json
```

```json
{
  "device": { "installId": "uuid-da-instalação", "platform": "android", "appVersionCode": 24 },
  "events": [
    { "id": "uuid-v4", "name": "app.opened", "occurredAt": 1780000000000, "sessionKey": "abc123",
      "properties": { "coldStart": true } },
    { "id": "uuid-v4", "name": "movement.created", "occurredAt": 1780000005000, "sessionKey": "abc123",
      "workspaceId": "uuid-da-empresa", "properties": { "type": "saida" } }
  ]
}
```

Resposta `202 { accepted, duplicated, rejected }`. `400` para lote inválido;
`401` se o Bearer enviado for inválido (então envie sem Bearer). Limites:
`ANALYTICS_MAX_BATCH` eventos por lote (padrão 200), 60 lotes por minuto por
usuário/IP, 20 propriedades e 4 KB por evento, nome com no máximo 80
caracteres no formato `dominio.acao` (`^[a-z0-9_]+(\.[a-z0-9_]+)*$`).

- `workspaceId` só é gravado se o usuário autenticado participa da empresa.
- `sessionKey` agrupa os eventos de uma mesma abertura do app (gere um valor
  curto ao abrir; troque após 30 min de inatividade).
- `installId` é o mesmo `install_id` enviado no `device` do login.

## Catálogo (o que emitir e quando)

| Evento | Origem | Quando | Propriedades |
| --- | --- | --- | --- |
| `app.opened` | app | app ganhou foco (cold ou warm start) | `coldStart: boolean` |
| `screen.viewed` | app | Activity/tela exibida | `screen: "MainActivity"` |
| `signup.started` | app | abriu o formulário de cadastro | — |
| `product.created` / `product.updated` / `product.deleted` | app | CRUD de produto no aparelho | `withPhoto`, `withBarcode` (created) |
| `movement.created` | app | entrada, saída ou ajuste registrado | `type: entrada \| saida \| ajuste` |
| `movement.cancelled` | app | cancelamento (evento compensatório) | — |
| `bulk_edit.applied` | app | edição em massa aplicada | `count` |
| `barcode.scanned` | app | leitura de código | `found: boolean` |
| `search.performed` | app | busca na lista (debounce; não por tecla) | `results` |
| `low_stock.filter_used` | app | chip "Estoque baixo" | — |
| `report.generated` | app | relatório gerado | `format: pdf \| texto` |
| `analysis.viewed` | app | Análise de Estoque aberta | — |
| `import.completed` / `export.completed` | app | importação/exportação concluída | `format`, `count` |
| `backup.created` / `backup.restored` | app | backup local | — |
| `paywall.viewed` | app | tela de assinatura exibida | `trigger` (de onde veio) |
| `purchase.started` / `purchase.failed` | app | fluxo do Play Billing | `reason` (código do Billing) |
| `low_stock.notified` / `notification.opened` | app | notificação exibida/tocada | `count` |
| `user.registered` / `user.logged_in` / `user.email_verified` / `user.deletion_requested` | API | ciclo de vida da conta | `origin` |
| `workspace.created` / `invite.sent` / `invite.accepted` | API | empresa e equipe | `roleKey`, `newAccount` |
| `sync.initial_upload_completed` / `sync.pushed` / `sync.pulled` / `sync.conflict_resolved` | API | sincronização | `products`, `movements`, `operations`, `rejected`, `conflicts`, `changes`, `choice` |
| `subscription.linked` / `subscription.state_changed` | API | assinatura | `planKey`, `state`, `from`, `to` |

Os eventos marcados "API" já são emitidos pelo servidor: o app **não** deve
duplicá-los. Um evento novo pode ser emitido antes de entrar no catálogo; o
painel o mostra como "fora do catálogo" até alguém documentá-lo.

## Implementação no Android (feita)

Pacote `br.com.gameloop.estoquesimples.analytics` no app:

- `AnalyticsDb`: fila `analytics_outbox` num banco próprio (`analytics.db`),
  separado do banco do estoque para não ser sobrescrito por restauração ou
  importação nem sair numa exportação.
- `Analytics.track(context, nome, props)` grava na fila e agenda o envio;
  `Analytics.screen(activity)` em `BaseActivity.onResume`;
  `Analytics.appOpened(context)` em `MainActivity.onCreate` (cold start e
  retorno após 30 min parado). `sessionKey` rotaciona após 30 min sem evento.
- `AnalyticsWorker` (WorkManager, rede obrigatória) envia lotes de até 200
  com Bearer quando há sessão; 401 invalida o token e tenta de novo sem ele;
  erro transitório repete com backoff; outro 4xx descarta o lote. Eventos com
  mais de 30 dias ou 8 tentativas são descartados.
- `AnalyticsScheduler`: envio 1 minuto após o primeiro evento novo e a cada
  6 horas.
- O Firebase Analytics continua só com os eventos automáticos; o painel lê
  **estes** eventos.

Para a versão web, o mesmo desenho vale com IndexedDB no lugar do SQLite.
