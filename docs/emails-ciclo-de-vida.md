# E-mails do ciclo de vida (ativação e recuperação)

Funil de e-mails **totalmente automático**, decidido a cada hora pela API a partir
dos dados do produto. Código em `apps/api/src/modules/lifecycle`; painel em
**Painel › E-mails automáticos** (`/admin/emails`). Plano aprovado com nota 9,4
na revisão crítica (7/11/2026).

## Ferramenta

O próprio backend, com o **Resend** que já envia os e-mails da conta. Sem
Brevo/Mailchimp: os gatilhos são dados do produto (sem integração nem
defasagem), nenhum dado pessoal novo vai a terceiro e o custo é zero no volume
atual (Resend grátis: 3 mil/mês, 100/dia). Se um dia houver newsletter ou
promoção editada por quem não programa, aí entra uma ferramenta de marketing,
só com quem optou.

## Sequências

| Tipo | Quem | Quando | O que pede |
| --- | --- | --- | --- |
| `activation_d1` | conta web sem nenhum produto | 24–72 h após o cadastro | cadastrar o 1º produto (P.S.: confirmar e-mail) |
| `activation_d4` | idem | 96–144 h | importar a planilha; pergunta "como você controla hoje?" |
| `activation_d8` | idem | 192–240 h | e-mail de despedida pessoal: "qual foi o seu caso?" |
| `confirm_email` | já ativou, e-mail não confirmado | 120–192 h | confirmar o e-mail (para chamar a equipe) |
| `reengage_14d` | dono com produtos, sem atividade própria há 14–21 dias | no máximo a cada 90 dias | conferir o estoque (contagem abaixo do mínimo, se houver) |
| `limit_40` / `limit_50` | dono, empresa no grátis com ≥ 40 / ≥ 50 produtos, sem assinatura viva nem pagamento pendente | uma vez por empresa | conhecer / assinar o plano Equipe |

Estilo de pré-vendas (SDR): assinado por uma pessoa ("André, do Estoque
Simples"), texto simples e curto, uma ação por e-mail e uma pergunta para
responder (as respostas vão para `LIFECYCLE_REPLY_TO` ou o primeiro de
`SUPPORT_NOTIFY_EMAILS`). Os textos ficam em `lifecycle.templates.ts` e o
painel mostra exemplos (aba Textos).

"Conta web" = só tem aparelho `web` (quem usa o app Android guarda produtos no
aparelho, e "sem produto na nuvem" seria falso). Cadastros antes de
`LIFECYCLE_ACTIVATION_START` (7/11/2026 21h UTC) não entram na ativação: sem
e-mails retroativos.

## Garantias (não afetar a plataforma)

- **Modo** `LIFECYCLE_EMAILS_MODE`: `dry_run` (padrão: decide e registra, não
  envia), `send` ou `off`. Ligar `send` só depois de conferir 2–3 dias de
  simulação no painel **e** com o webhook configurado.
- O que foi simulado conta como feito (`dedupe_key`): ligar o envio não manda
  atrasados. Cada passo tem janela de 2 dias; vencido, não sai.
- No máximo 1 e-mail do ciclo de vida a cada 48 h por pessoa e 1 por rodada
  (prioridade: D+8 > D+4 > D+1 > limite > confirmação > reengajamento).
- **Cota**: todo e-mail que sai, de qualquer tipo, é contado por dia de Brasília
  (`email_send_counts`, `CountingMailer`). O ciclo de vida para em
  `LIFECYCLE_DAILY_LIMIT` (50) ou quando o total do dia chega a
  `EMAIL_DAILY_TOTAL_LIMIT` (70), reservando a cota do Resend para redefinição de
  senha, verificação e convites (que nunca são bloqueados, só contados). Erro de
  limite do provedor (429/quota) encerra a rodada e devolve o passo.
  Upgrade para o Resend Pro quando o uso passar de 60% da cota em 3 dias.
- Nunca para quem descadastrou (`lifecycle_emails_opt_out_at`), teve bounce
  permanente ou marcou spam (`email_suppressed_at`), conta suspensa ou excluída.
- Só das 9 h às 20 h de Brasília. Falha de envio fica registrada (`failed`) e
  não repete.
- A antiga tarefa de 24 h (`onboarding.first_product_nudge`) terminou: o D+1
  substitui, com as mesmas regras.

## Descadastro, cliques e webhook

- Todo e-mail leva `List-Unsubscribe` + `List-Unsubscribe-Post` (1 clique no
  Gmail/Outlook) e o link no rodapé: `GET /v1/email/descadastrar?t=<id>` mostra
  um botão (leitores de link não descadastram ninguém); o `POST` efetiva.
- Links levam `utm_source=lifecycle&utm_medium=email&utm_campaign=ciclo_de_vida&utm_content=<tipo>`
  (GA) e `le=<id do envio>`: o web app avisa `POST /v1/email/clicked` e o clique
  aparece no painel, sem depender do provedor. A origem do cadastro
  (`signup_attribution`) não muda.
- **Webhook do Resend** `POST /v1/email/resend-webhook` (assinatura Svix com
  `RESEND_WEBHOOK_SECRET`; sem o segredo, 404): entregue, aberto, clicado,
  bounce e spam. Bounce permanente e spam suprimem o endereço para o ciclo de
  vida. Os e-mails são texto simples: aberturas não são rastreáveis (o painel
  mostra o que o Resend informar).

### Configurar o webhook (uma vez)

1. Resend › Webhooks › Add endpoint: `https://estoquesimples.com.br/v1/email/resend-webhook`,
   eventos `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`,
   `email.complained`.
2. Copiar o *signing secret* (`whsec_…`) para `RESEND_WEBHOOK_SECRET` no Railway.
3. Conferir no painel (aviso some) e, depois de 2–3 dias de simulação conferida,
   `LIFECYCLE_EMAILS_MODE=send`. Anotar a data aqui.

## Medição e limites de leitura

O painel mostra por tipo: decididos, enviados (e simulados), aberturas,
cliques, **ativou em 3 dias** (cadastrou produto até 3 dias depois), **voltou
em 3 dias** (atividade no app/web), descadastros, bounces e spam. "Ativou/voltou
em 3 dias" é indicador **otimista** (parte aconteceria de qualquer jeito); um
grupo de controle (10–20% sem e-mail) fica para quando houver ≥ 200
cadastros/mês. Alarmes: spam > 0,3% ou bounce > 5% dos enviados → `off` e
investigar.

## Histórico

- 7/11/2026: funil no ar em `dry_run`.
