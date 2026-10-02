# Assinatura pela web (Asaas)

Na web, o plano Equipe é cobrado pelo [Asaas](https://www.asaas.com) (Pix,
boleto ou cartão, recorrência mensal ou anual). No Android continua sendo a
Google Play. As duas origens gravam na **mesma tabela `subscriptions`**
(`provider` = `google_play` | `asaas`) e produzem os **mesmos estados**; o
restante do sistema (direitos, limites, painel, app) não sabe nem precisa
saber de onde a assinatura veio.

## Desenho

```
navegador ──(1) POST /v1/workspaces/:id/billing/web/checkout──▶ API ──▶ Asaas: cliente + assinatura
navegador ◀─(2) invoiceUrl (fatura hospedada no Asaas)────────── API
navegador ──(3) paga na página do Asaas (Pix / boleto / cartão)
Asaas ─────(4) POST /v1/billing/webhooks/asaas (evento)────────▶ API ──▶ consulta o Asaas ──▶ estado
API ───────(5) reconciliação periódica (job) ──────────────────▶ Asaas (cobre webhook perdido e prazos)
```

- **Nenhuma credencial no front.** A chave do Asaas só existe no backend
  (`ASAAS_API_KEY`). Dados de cartão são digitados na página do Asaas
  (`invoiceUrl`); não passam pela nossa API.
- **O webhook nunca é a fonte da verdade.** Ele só avisa que algo mudou. O
  estado é derivado por uma função pura (`asaas-state.ts#deriveAsaasState`) a
  partir da assinatura e das cobranças *como estão agora* no Asaas. Por isso
  eventos duplicados, atrasados ou fora de ordem convergem para o mesmo
  resultado.
- **Idempotência.** Cada evento é gravado em `subscription_events` com
  `notification_id = 'asaas:<id do evento>'` (único). Repetição é reconhecida
  e ignorada. Depois de autenticado, o webhook **sempre responde 200**: se o
  processamento falhar, o evento fica pendente e a reconciliação retoma (o
  Asaas pausa a fila inteira após 15 respostas diferentes de 200).
- **Autenticação do webhook.** Cabeçalho `asaas-access-token` comparado em
  tempo constante com `ASAAS_WEBHOOK_TOKEN`. Sem o token configurado a rota
  responde 503; com token errado, 401.
- **Quem pode.** Ver: `assinatura.ver`. Contratar e cancelar:
  `assinatura.gerenciar` (proprietário). O `workspaceId` da URL é sempre
  conferido contra a participação do usuário.
- **Preço.** `plans.web_price_monthly_cents` / `web_price_yearly_cents`,
  editáveis no painel (Planos). `NULL` = ciclo não vendido. Sem chave do Asaas
  ou sem preço, `checkoutAvailable` é `false` e a web não oferece a compra.
- **Dados do pagador.** Vão para o Asaas nome, CPF/CNPJ, e-mail e telefone.
  No nosso banco (`billing_customers`) ficam nome, e-mail, tipo do documento e
  os dígitos finais — nunca o documento inteiro.

## Estados

| Situação no Asaas | Estado | Acesso ao plano |
| --- | --- | --- |
| assinatura criada, primeira cobrança em aberto | `pendente` | não |
| cobrança paga, dentro do período | `ativa` | sim |
| período pago acabou, cobrança seguinte vencida, dentro da tolerância (`ASAAS_GRACE_DAYS`) | `carencia` | sim |
| tolerância esgotada | `suspensa` | não (empresa volta ao gratuito) |
| assinatura cancelada com período pago em curso | `cancelada_mas_ativa` | sim, até o fim do período |
| cancelada/encerrada e período vencido | `expirada` | não |
| última cobrança estornada | `reembolsada` | não |
| contestação (chargeback) em andamento | `suspensa` | não, até o desfecho |

Prazos automáticos (reconciliação): `pendente` nunca paga é cancelada após
`ASAAS_PENDING_EXPIRE_DAYS`; `suspensa` é cancelada no Asaas após
`ASAAS_SUSPENDED_CANCEL_DAYS`. Cancelar (`POST .../billing/web/cancel`) remove
a assinatura no Asaas — o que cancela as cobranças em aberto — e mantém o
acesso até o fim do período pago. Mudanças de estado geram auditoria,
evento de analytics (`subscription.state_changed`) e notificação ao
proprietário ([notifications.md](notifications.md)).

## Rotas

| Rota | Uso |
| --- | --- |
| `GET /v1/workspaces/:id/billing/web` | visão da área Plano: preços, assinatura, cobrança em aberto, pagamentos, histórico |
| `POST /v1/workspaces/:id/billing/web/checkout` | cria (ou retoma) a assinatura e devolve a fatura a pagar |
| `POST /v1/workspaces/:id/billing/web/refresh` | reconsulta o Asaas agora ("já paguei") |
| `POST /v1/workspaces/:id/billing/web/cancel` | cancela a renovação |
| `POST /v1/billing/webhooks/asaas` | webhook (cabeçalho `asaas-access-token`) |

Código: `apps/api/src/modules/billing/asaas/` (`asaas-client.ts`,
`asaas-billing.service.ts`, `asaas-state.ts`, `asaas.jobs.ts`,
`asaas.routes.ts`, `document.ts`).

## Colocar em produção (passo a passo)

Valores entre `<...>` são seus; nada aqui é credencial real.

### 1. Conta no Asaas

1. Crie e **aprove** a conta em https://www.asaas.com (envio de documentos e
   dados comerciais). Só conta aprovada gera chave de produção.
2. Nos dados comerciais da conta (menu **Minha Conta**), confira que o site
   cadastrado é `https://estoquesimples.com.br`. O Asaas só aceita redirecionar
   o pagador de volta (`successUrl`) para o domínio cadastrado na conta; com
   domínio diferente a criação da assinatura é recusada.

### 2. Chave da API

1. No Asaas: **Integrações › Chaves de API › Gerar nova chave**.
2. Copie a chave na hora (ela só é exibida uma vez). Formato:
   `$aact_prod_<...>`.

### 3. Token do webhook

Gere um segredo seu, de 32 a 255 caracteres, e guarde-o:

```bash
openssl rand -hex 32      # → <ASAAS_WEBHOOK_TOKEN>
```

### 4. Variáveis no Railway

Projeto `estoquesimples-api` › serviço `estoquesimples-api` › **Variables**:

| Variável | Valor |
| --- | --- |
| `ASAAS_API_KEY` | `<chave $aact_prod_... do passo 2>` |
| `ASAAS_ENVIRONMENT` | `production` |
| `ASAAS_WEBHOOK_TOKEN` | `<segredo do passo 3>` |
| `WEB_APP_URL` | `https://estoquesimples.com.br` (já definida) |

Opcionais (têm padrão): `ASAAS_GRACE_DAYS=5`, `ASAAS_PENDING_EXPIRE_DAYS=7`,
`ASAAS_SUSPENDED_CANCEL_DAYS=30`, `ASAAS_RECONCILE_INTERVAL_MINUTES=60`.

Pela CLI (o `$` da chave precisa de aspas simples):

```bash
railway variables --set 'ASAAS_API_KEY=<chave>' --set 'ASAAS_ENVIRONMENT=production' --set 'ASAAS_WEBHOOK_TOKEN=<segredo>'
```

A API recusa subir se a chave e o ambiente não combinarem ou se houver chave
sem token de webhook — o erro aparece no log do deploy.

### 5. Webhook no Asaas

**Integrações › Webhooks › Criar webhook**:

| Campo | Valor |
| --- | --- |
| Nome | `Estoque Simples` |
| URL | `https://api.estoquesimples.com.br/v1/billing/webhooks/asaas` |
| E-mail | `<seu e-mail, para avisos de fila pausada>` |
| Versão da API | `v3` |
| Token de autenticação | `<o mesmo segredo do passo 3>` |
| Fila de sincronização | ativada |
| Tipo de envio | **Sequencial** |
| Eventos | todos de **Cobranças** (`PAYMENT_*`) e de **Assinaturas** (`SUBSCRIPTION_*`) |

O ambiente de testes (sandbox) tem webhooks e chaves próprios, cadastrados em
https://sandbox.asaas.com.

### 6. Preço

No painel (`https://api.estoquesimples.com.br/admin` › **Planos** › plano
Equipe), informe o **preço mensal** e/ou **anual** da web. Enquanto os dois
estiverem vazios, a web não oferece a contratação.

### 7. Conferir

1. `https://estoquesimples.com.br/app/plano` passa a mostrar os preços e o
   botão de contratar.
2. Faça uma contratação real de teste (Pix é o mais rápido). A área Plano
   deve ir de "Aguardando pagamento" para "Ativa" em instantes; em
   **Integrações › Webhooks › Logs** do Asaas os envios devem estar com 200.
3. No painel: **Assinaturas** mostra a assinatura com origem Asaas, as
   cobranças e os eventos recebidos.
4. Estorne/cancele o teste pelo Asaas se não quiser mantê-lo.

Para ensaiar antes, use o sandbox: chave `$aact_hmlg_<...>`,
`ASAAS_ENVIRONMENT=sandbox`, webhook cadastrado no sandbox; a cobrança pode
ser confirmada sem dinheiro com `POST /v3/sandbox/payment/<id>/confirm` na
API do sandbox.

### Se algo der errado

| Sintoma | Onde olhar |
| --- | --- |
| Web diz que a contratação não está disponível | falta `ASAAS_API_KEY` ou o preço do plano |
| Erro ao contratar citando domínio/URL | site da conta Asaas diferente de `WEB_APP_URL` (passo 1.2) |
| Pagou e continua "Aguardando pagamento" | botão "Já paguei" (reconsulta); logs do webhook no Asaas; job `billing.asaas_reconcile` em Operação › Jobs |
| Webhook com 401 no Asaas | token do webhook diferente de `ASAAS_WEBHOOK_TOKEN` |
| Fila do webhook pausada | corrija a causa e reative a fila em Integrações › Webhooks; os eventos acumulados são reenviados e a reconciliação cobre o intervalo |
