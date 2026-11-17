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
  `internal = true` é nota só do painel; `ai = true` marca o que a IA
  escreveu (resposta ao cliente ou nota de escalonamento); `notify_status`
  registra como o usuário foi avisado da resposta (`push`, `email`, `muted`,
  `none`, `failed`).
- `needs_human` (com `needs_human_at` e `needs_human_reason`): a resposta
  automática por IA passou a solicitação para uma pessoa. É estado do
  chamado, não de uma mensagem — é por ele que o painel filtra e que o aviso
  ao dono sai uma vez só.
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
com a OpenAI, mesma chave das avaliações), `settings` (GET/PUT da resposta
automática). A lista aceita `needsHuman=true|false` e põe o que precisa de
uma pessoa no topo da fila. Responder assume o atendimento
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

Com a **resposta automática ligada**, esse aviso nasce agendado para 2 minutos
à frente (`jobs.run_at`) em vez de sair na hora, e quando chega a hora a
tarefa desiste se a IA já resolveu: respondida pela IA, o dono não é
incomodado; escalonada, o e-mail de "precisa de você" já saiu no lugar. Uma
resposta de pessoa não cancela aviso nenhum. Com a IA desligada, nada muda: o
aviso sai imediatamente, como sempre.

## Resposta automática por IA

O chat de suporte pode responder sozinho as dúvidas básicas — quase sempre
plano, limite e preço — e passar para uma pessoa tudo o que depende de gente.
Ligada e desligada em **Painel › Atendimento**, no card "Resposta automática
por IA" (`admin_settings`, chave `support_settings`, campo
`aiAutoReplyEnabled`). É configuração de banco, não variável de ambiente: liga
e desliga sem deploy. **Desligada, nada muda** — nenhuma tarefa é enfileirada
e o atendimento segue só por pessoas. Nasce desligada.

Usa a **mesma chave e o mesmo modelo da OpenAI** do resto do painel
(`modules/reviews/openai-client.ts`, `completeJson`), configurados em
Inteligência artificial. Sem chave, a solicitação é marcada para humano em vez
de ficar sem resposta.

### Onde está

| Parte | Caminho |
| --- | --- |
| Prompt, contexto do produto e decisão | `apps/api/src/modules/support/support-ai.ts` |
| Travas, envio e escalonamento | `SupportService.autoReply`, `sendAiReply`, `markNeedsHuman` |
| Tarefas da fila | `support.ai_reply` · `support.notify_needs_human` (`support.jobs.ts`) |
| Migração | `0040_suporte_ia.{up,down}.sql` |
| Painel | `apps/admin/src/pages/SupportPage.tsx` (toggle, etiqueta "por IA", aviso e filtro) |
| Cadência no chat da web | `apps/web/src/components/SupportChatPanel.tsx` |

### O contexto que ela recebe

Nenhum número escrito à mão no prompt:

- **O que o produto faz**: `PRODUCT_FACT_LINES`
  (`modules/blog/product-facts.ts`), a mesma fonte única da IA do blog e do
  `llms.txt`. A IA só pode citar funcionalidade que esteja ali.
- **Planos, limites e preços**: lidos de `plans` e `plan_features` a cada
  resposta (`planFactsFor`) — as mesmas linhas de **Painel › Planos**, que é a
  fonte da verdade. Mudar o preço no painel muda o que a IA diz, sem deploy.
  `limit_value` nulo entra como "sem limite".
- **Central de ajuda**: os artigos de `packages/help/faq.json` com mais
  palavras em comum com a dúvida (`relatedHelpArticles`, o mesmo seletor que
  a IA do blog usa).
- **A conversa**: as 12 últimas mensagens não internas, o aparelho, o
  diagnóstico do app e o plano em vigor da empresa.
- Mais as duas frases que valem sempre: a assinatura é **da empresa** e vale
  nos dois clientes; **não se cobra por pessoa**.

### Tom e regras

São as da seção 4 do `CLAUDE.md`, iguais para a IA e para quem atende:
resposta curta e objetiva, resolver do nosso lado, **reembolso só se o cliente
pedir**, **sem cupom**, só o primeiro nome (nunca o e-mail), nada de prometer
o que o produto não faz. Diante de insatisfação ou cancelamento: apaziguar,
perguntar o motivo, tentar resolver. Teto de 700 caracteres por resposta.

### Resposta cadenciada

A tarefa roda na fila (a pessoa não espera a OpenAI) e o chat da web revela a
resposta no **ritmo de digitação** que já existia nas perguntas automáticas do
balão: o indicador "digitando" fica uma pausa fixa mais um tanto por
caractere, com teto de 6 s, e só então o texto aparece. O que já estava na
conversa quando o balão abriu aparece de uma vez — ninguém quer ver a IA
digitando de novo o que respondeu ontem. A marca `ai` da mensagem é o que
liga esse efeito.

### Escalonamento para humano

A IA responde em JSON e o valor combinado é `{"acao": "humano", "motivo": …}`.
Nesse caso **nada é enviado ao cliente**: a solicitação ganha
`needs_human = true`, uma nota interna com o motivo, o destaque "precisa de
você" no painel e um e-mail ao dono. Também escalona, em silêncio, quando:

- não há chave da OpenAI configurada;
- a OpenAI falha, estoura o tempo-limite ou devolve algo que não dá para
  enviar (na dúvida, escalona — responder errado é pior que demorar);
- a IA já respondeu 3 vezes no mesmo chamado e o cliente voltou a escrever.

E simplesmente **não fala** quando: o toggle está desligado, a solicitação
está resolvida ou já marcada para humano, a mensagem não é mais a última da
conversa, ou **uma pessoa do time já respondeu ali** — daí em diante a
conversa é dela.

A resposta da IA entra como resposta normal do suporte (push, caixa de
notificações, e-mail quando não há aparelho), com `author = admin`,
`ai = true` e sem nome de atendente: o cliente vê "Equipe Estoque Simples".
Ela conta como primeira resposta (`first_response_at`) — para o cliente, foi
respondido. Nenhum responsável é assumido.

### Aviso por e-mail ao dono

Tarefa `support.notify_needs_human`, pelo mesmo caminho de envio dos outros
avisos (`kind: support_needs_human`): número, assunto, categoria, primeiro
nome de quem escreveu, motivo, a última mensagem do cliente e o link do
painel. Destinatários iguais aos do aviso de solicitação nova
(`SUPPORT_NOTIFY_EMAILS` ou os donos ativos do painel). **Um por
solicitação**: quem garante isso é o `UPDATE … WHERE needs_human = false` —
não alterou linha, não enfileira aviso.

**Um e-mail por solicitação, no total.** Com a IA ligada, o aviso de
solicitação nova espera 2 minutos e desiste se a IA já respondeu ou já
escalonou (ver a seção anterior): o dono recebe o aviso de abertura, ou o de
"precisa de você", nunca os dois.
