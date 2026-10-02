# Suporte pelo app (solicitações)

Como o app abre e acompanha solicitações de suporte, e como o painel
responde. Código do servidor em `src/modules/support/`; painel em
`admin/src/pages/SupportPage.tsx` (`/admin/suporte`).

## Modelo

- `support_tickets`: uma solicitação. `number` é o identificador curto que
  a pessoa cita (#1042). `user_id` (quando há conta) e `install_id` (sempre)
  dizem de quem é. `device` guarda modelo, Android e versão do app;
  `diagnostics`, o estado local no momento da abertura (sessão, empresa,
  assinatura, última sincronização, operações pendentes, contagens).
- `support_messages`: a conversa. `author` é `user`, `admin` ou `system`;
  `internal = true` é nota só do painel; `notify_status` registra como o
  usuário foi avisado da resposta (`push`, `email`, `muted`, `none`,
  `failed`).
- Estados: `open` (aguardando equipe) → `answered` (equipe respondeu) →
  `resolved`. O usuário escrever de novo volta para `open`, inclusive de
  `resolved`. `priority` (`low|normal|high`) e `assigned_to` são triagem do
  painel.

## Identidade

Toda chamada do app leva `installId` (o mesmo da sincronização e do push).
Com `Authorization: Bearer`, a solicitação é da conta; sem, é da instalação.
Uma solicitação é visível se `user_id = eu` ou (`user_id` nulo e
`install_id = esta instalação`). Quando uma instalação com solicitações
anônimas passa a mandar Bearer, elas são **atribuídas à conta** (claim),
então a lista não some após o login. Token presente e inválido é 401; nunca
é rebaixado para anônimo.

## Contrato com o app (`/v1/support`)

```http
GET  /v1/support/categories
POST /v1/support/tickets
     { installId, subject (≤120), message (≤4000), category,
       contactEmail?, contactName?,            # só fazem sentido sem conta
       device { platform? (android|web; ausente = android), model,
                manufacturer, osVersion, sdkInt, appVersionCode,
                appVersionName, locale, timezone },
       diagnostics { chave: string|number|boolean|null, ... (≤40) } }
     → 201 ticket
GET  /v1/support/tickets?installId=…          → { tickets: [ticket] }
GET  /v1/support/tickets/:id?installId=…      → { ticket, messages }   # marca como lida (e lê os avisos da conversa na caixa de notificações)
POST /v1/support/tickets/:id/messages { installId, message } → 201 { ticket, message }
POST /v1/support/tickets/:id/resolve  { installId }          → ticket
```

`ticket`: `{ id, number, subject, category, categoryLabel, status,
messageCount, lastMessageAt, lastMessageBy, unread, createdAt, resolvedAt }`.
`unread` é verdadeiro quando a última mensagem não é do usuário e ele ainda
não abriu a conversa depois dela. `message`: `{ id, author
(user|support|system), authorName, body, createdAt }` — notas internas nunca
saem. Limites: 10 solicitações não resolvidas por identidade (409),
10 aberturas por janela de rate limit, 30 mensagens.

## Notificação ao usuário

Ao responder (mensagem não interna) ou resolver, a API manda um push
**só de dados** para os tokens vivos da instalação e da conta:

```json
{ "type": "support", "ticketId": "<uuid>", "ticketNumber": "1042",
  "event": "reply" | "resolved", "title": "…", "body": "…" }
```

O app monta a notificação (uma por solicitação; a nova substitui a
anterior) e, ao tocar, abre a conversa (`SupportTicketActivity`). Sem
aparelho alcançável (ou Firebase não configurado), a resposta vai por
e-mail para o e-mail da conta ou o `contactEmail` informado (`kind:
support_reply`); sem nenhum dos dois, fica só no app. Tokens que o FCM diz
não existirem são revogados, como nas campanhas.

## Painel (`/admin/api/support`, papel `support` para alterar)

`stats`, `tickets` (filtros `status|unresolved`, `category`, `priority`,
`assigned=me|none`, `q` por assunto, e-mail, #número, instalação ou texto
da conversa), `tickets/:id` (conversa completa, aparelho, diagnóstico, conta
e empresas, outros chamados, aparelhos alcançáveis), `tickets/:id/messages`
(`internal` opcional), `tickets/:id/status`, `PATCH tickets/:id`
(`priority`, `category`, `assign: me|none`), `tickets/:id/draft` (rascunho
com a OpenAI, mesma chave das avaliações). Responder assume o atendimento
se ninguém assumiu. Tudo é auditado (`support.*`).

## Eventos de analytics

`support.ticket_opened` (API, com `category` e `signedIn`),
`support.message_sent` (API), `support.ticket_resolved` (API, `by`),
`support.ticket_submitted` (app, intenção), `notification.opened` com
`kind=support` (app).

## Chat da web

Na versão web há um botão flutuante no canto inferior direito (só em telas a
partir de 900 px; fica oculto em `/app/suporte`, onde a conversa já está). Ele
abre um balão de conversa (`apps/web/src/components/SupportChat.tsx` e
`SupportChatPanel.tsx`). **Não é um canal novo**: usa as rotas acima, e o que
nasce ali é uma solicitação comum, marcada com `diagnostics.channel = "chat"`.

- **Com sessão**: a primeira mensagem abre a solicitação ligada à conta
  (assunto = primeira linha do texto). Se a pessoa já tem uma solicitação não
  resolvida, o chat continua nela.
- **Sem sessão**: três perguntas automáticas — nome, e-mail, dúvida — e a
  solicitação nasce da instalação (`installId` do navegador), com
  `contactName`/`contactEmail`. O balão avisa que as primeiras perguntas são
  automáticas e que quem responde é uma pessoa. Nome e e-mail ficam só na
  memória da página até o envio; no navegador fica guardado apenas o id da
  conversa (`es_web_chat_ticket`).
- **Respostas**: o balão consulta a conversa a cada 8 s enquanto está aberto;
  fechado, o botão consulta a lista a cada 60 s e mostra um ponto quando há
  resposta não lida. Fora da página, valem os avisos de sempre (caixa de
  notificações para quem tem conta; e-mail para o contato informado).
- Não há presença nem "digitando" de verdade: o efeito de digitação é só das
  perguntas automáticas.

## Aviso por e-mail de solicitação nova

Toda solicitação nova (app, web ou chat) enfileira a tarefa
`support.notify_team` na mesma transação. Ela envia um e-mail
(`kind: support_new_ticket`) com número, assunto, quem escreveu, origem, a
primeira mensagem e o link do painel.

| Variável | Efeito |
| --- | --- |
| `SUPPORT_NOTIFY_EMAILS` | destinatários, separados por vírgula. Vazia = administradores ativos de papel owner do painel |
| `ADMIN_PANEL_URL` | base do link "responder no painel" (produção: `https://api.estoquesimples.com.br/admin`) |

Mensagens seguintes na mesma solicitação não geram e-mail. Falha de envio é
repetida pela fila (até 5 tentativas) e aparece em Operação › Jobs.
