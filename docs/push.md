# Push notifications (Firebase Cloud Messaging)

Como o painel envia notificações e como os clientes (Android hoje, web
amanhã) participam. O código do servidor está em `src/modules/push/`.

## Infraestrutura

- Projeto Firebase = projeto GCP `estoque-simples-f3604`, o mesmo da conta de
  serviço do Google Play. A API usa `GOOGLE_SERVICE_ACCOUNT_JSON` para o FCM
  (ou `FIREBASE_SERVICE_ACCOUNT_JSON`, se quiser separar).
- Pré-requisitos no Google Cloud: ativar a **Firebase Cloud Messaging API
  (V1)** e dar à conta de serviço o papel **Firebase Cloud Messaging API
  Admin** (IAM). Sem isso o envio falha com 403 e a campanha fica `failed`.
- `FIREBASE_PROJECT_ID` é opcional (vem do `project_id` do JSON).

## Contrato com o app

### Registrar o token

```http
PUT /v1/push/tokens
Authorization: Bearer <access token>   # opcional
{ "token": "<token FCM>", "installId": "<mesmo install_id do login>",
  "platform": "android", "appVersionCode": 25, "locale": "pt-BR",
  "notificationsEnabled": true }
```

Chame ao abrir o app, quando o Firebase renovar o token (`onNewToken`) e
logo após login/cadastro (para vincular o token à conta). A API mantém um
token vivo por `installId`; os anteriores são revogados. Sem Bearer o token
fica só com a instalação e recebe campanhas "para todos" e "sem conta".

### Mensagem de campanha

Mensagens são **só de dados** (sem `notification`), para que o app seja
chamado em qualquer estado e possa medir entrega e abertura:

```json
{ "type": "campaign", "campaignId": "<uuid>", "title": "…", "body": "…",
  "screen": "reports",          // opcional: main|history|reports|analysis|account|subscription|team|import
  "url": "https://…" }          // opcional: vale no lugar da tela
```

O app monta a notificação (canal `push_channel_id`), coloca `campaignId`,
`screen` e `url` no Intent de abertura e reporta os eventos.

### Reportar entrega e abertura

```http
POST /v1/push/events
{ "campaignId": "<uuid>", "installId": "<install_id>", "event": "delivered" | "opened" }
```

`delivered` ao receber a mensagem; `opened` quando a pessoa toca. Repetir é
inofensivo (`recorded: false`). Abrir sem ter reportado entrega conta as
duas coisas.

## Painel

- **Público**: todos, com conta, sem conta, por assinatura, inativos há N
  dias, versão antiga do app, e-mails específicos, membros de uma empresa;
  sempre limitado a aparelhos vistos nos últimos N dias (padrão 90). A
  prévia mostra a contagem de agora; o público real é resolvido no envio.
- **Fluxo**: rascunho → teste em um e-mail → "Enviar agora" com confirmação
  (palavra `enviar`) → fila → `sending` → `sent`. Cancelar interrompe o que
  ainda não saiu; o que o FCM já aceitou não volta.
- **Métricas**: alvo, aceitas pelo FCM, entregues, abertas (por campanha e
  agregado), falhas por motivo, entregas por hora, aparelhos alcançáveis.
- Tudo auditado em `admin_audit_log` (`push.*`).

## Versão web

Mesmo contrato com `platform: "web"` e tokens do Firebase JS SDK; o service
worker faz o papel do `FirebaseMessagingService`.
