# Black Friday 2026 — especificação

Aprovada pelo dono em 11/11/2026 (plano revisado do crítico de marketing, nota 9/10).

## Ofertas

| Onde | Oferta | Depois |
|---|---|---|
| Web (Asaas), principal | Plano Equipe **anual R$ 119,90** (de R$ 199,90; "equivale a R$ 9,99/mês") | renova por R$ 199,90/ano, com aviso antes |
| Web (Asaas), secundária | Plano Equipe **mensal, 1º mês R$ 12,49** (de R$ 24,99) | R$ 24,99/mês a partir da 2ª cobrança, com aviso antes |
| Android (Google Play) | Oferta da própria Play, **R$ 9,99/mês nos 2 primeiros meses**, só novos assinantes (tag `bf2026`) | preço normal da Play |

- Semestral fica fora da campanha.
- Âncoras são os preços reais vigentes (não mexer nos preços até 01/12). Nada de "de R$ 29" na web.
- Valor total sempre tão visível quanto o "equivale a R$ 9,99/mês".

## Cupom

- Código `BF26`. Também aplicado por link: `/black-friday?cupom=BF26` (o código fica guardado no navegador durante cadastro/login).
- Vigência: **20/11/2026 00:00 a 01/12/2026 23:59:59, horário de Brasília**.
- Quem pode: empresa **sem assinatura viva** (estados `pendente` com o mesmo cupom pode retomar; `ativa`, `carencia`, `suspensa`, `cancelada_mas_ativa` não). Assinantes da Play: não.
- Limite: **1 uso por empresa e 1 por CPF/CNPJ** (hash do documento). Sem limite global.
- O resgate só conta quando a 1ª cobrança é paga; uma tentativa pendente abandonada não queima o cupom.
- Validado sempre no servidor.

## Contrato da API (backend → web)

Todos em `/v1` como as demais rotas.

- `GET /public/promo` → campanha em destaque (para faixas e landing). Cache 60 s.
  ```json
  { "active": true, "code": "BF26", "label": "Black Friday", "startsAt": "2026-11-20T03:00:00.000Z", "endsAt": "2026-12-02T02:59:59.000Z",
    "upcoming": false,
    "yearly": { "fullCents": 19990, "promoCents": 11990, "monthlyEquivalentCents": 999 },
    "monthly": { "fullCents": 2499, "firstCents": 1249, "promoCycles": 1 } }
  ```
  Fora da vigência: `{ "active": false, "upcoming": true|false, "startsAt", "endsAt", ...mesmos preços }` (upcoming = ainda não começou). Sem campanha: `{ "active": false, "upcoming": false }`.
- `GET /public/coupons/:code` → `{ "valid": boolean, "reason": "invalido"|"expirado"|"ainda_nao_comecou"|null, ...mesmo formato de preços }`.
- `GET /workspaces/:workspaceId/billing/web` (já existe) ganha `promo: { ...campanha, eligible: boolean, ineligibleReason: string|null }` (null sem campanha ativa).
- `POST /workspaces/:workspaceId/billing/web/checkout` aceita `coupon?: string` (trim, maiúsculas, até 32). Ciclos aceitos com cupom: `MONTHLY` e `YEARLY`. Erros 409 com mensagem pronta em pt-BR (cupom inválido, expirado, já usado, empresa não elegível, ciclo fora da oferta).
- `GET /workspaces/:workspaceId/billing/web/pix` → `{ "paymentId", "valueCents", "encodedImage" (PNG base64), "payload" (copia e cola), "expirationDate" }` da cobrança PIX em aberto; 404 se não houver. A web mostra o QR na própria página e reconsulta com `POST .../refresh` a cada ~5 s até pagar.

## Eventos de analytics (registrados em `apps/api/src/modules/analytics/analytics.events.ts`)

- `promo.banner_viewed`, `promo.banner_clicked`, `promo.banner_dismissed` (props: `surface` = `web_topo`|`web_plano`|`web_limite`|`android_cartao`, `campaign`)
- `promo.landing_viewed` (props: `campaign`, `coupon`)
- `coupon.applied` (web, props: `code`, `cycle`) e `coupon.redeemed` (servidor, na 1ª cobrança paga; props: `code`, `cycle`, `valueCents`)

## Depois do desconto

- Ao confirmar o pagamento do último ciclo promocional, o servidor atualiza o valor da assinatura no Asaas para o preço cheio (`updatePendingPayments: true`).
- Aviso por e-mail: mensal 7 dias antes da 1ª cobrança cheia; anual 15 e 3 dias antes da renovação.

## Divulgação

- Web app: faixa fina no topo (fechável; volta uma vez em 01/12), cartão na página Plano, variante no aviso de limite de 50 produtos. Assinantes não veem.
- Landing pública `/black-friday` com as duas ofertas (anual em destaque), FAQ de renovação/cancelamento e contagem regressiva até a data real.
- Android: cartão discreto, fechável, que abre a compra da Play com a oferta `bf2026`; preços lidos do Billing (`pricingPhases`); **nenhuma menção ao site ou a outro preço** (política de pagamentos do Google Play, sem exceção para o Brasil).
- E-mail (só quem tem consentimento de marketing, nunca assinantes): 20/11, 27/11 e 01/12.
- Google Ads: extensão de promoção "Black Friday", 40% off, 20/11 a 01/12, para a landing.

## Metas

8+ novos pagantes; 15%+ da base grátis ativa convertida; 60%+ das vendas web no anual; 60%+ dos mensais com desconto ativos no 3º mês; zero reclamação de preço.

## Implementação no backend (decisões, 11/11/2026)

- **Tabelas** (migration 0036): `coupons` (código único, rótulo, vigência inclusiva, ativo, anual promocional, valor da mensalidade promocional e quantos ciclos) e `coupon_redemptions` (`reservado` no checkout → `resgatado` com a 1ª cobrança paga; únicos parciais de 1 resgatado por empresa e por documento em cada cupom). Seed do `BF26`. A assinatura guarda `coupon_id` e `promo_restored_at`. Tabelas de sistema, sem GRANT para `app_user`. Código em `apps/api/src/modules/promotions`.
- **Hash do documento**: SHA-256 hex do CPF/CNPJ só com dígitos, sem pepper (o projeto não tem segredo para hashes; tokens e purchase tokens também são SHA-256 puro). CPF tem pouca entropia, então o hash é pseudonimização, não anonimização: a tabela fica só no servidor. O resgate sobrevive à exclusão da empresa (`workspace_id` vira nulo) para o limite por documento continuar valendo.
- **Erros do checkout**: 409 `CONFLICT` com mensagem pronta e `couponReason` estável no envelope (`invalido`, `expirado`, `ainda_nao_comecou`, `ciclo_fora_da_oferta`, `empresa_nao_elegivel`, `ja_usado`). `promo.ineligibleReason` na visão da empresa: `assinatura_ativa`, `google_play`, `cupom_ja_usado` (o uso por documento só é conferido no checkout, quando o documento chega).
- **Retomada**: a pendente com o mesmo cupom, ciclo e forma de pagamento é devolvida mesmo depois do fim da vigência (o valor já está na fatura). Trocar ciclo, forma de pagamento ou cupom cancela a pendente e cria outra, como antes. Uma assinatura que sobrou no Asaas com valor ou ciclo diferente do pedido é cancelada em vez de reaproveitada.
- **Ponto de restauração do preço**: em `refreshSubscription` (webhook, `refresh`, reconciliação). Na 1ª cobrança paga o resgate vira `resgatado` e sai `coupon.redeemed`; quando as cobranças pagas chegam aos ciclos promocionais (anual 1, mensal `monthly_promo_cycles`), `POST /subscriptions/{id}` no Asaas com o preço cheio vigente em `plans` e `updatePendingPayments: true`, `price_cents` local passa ao cheio e `promo_restored_at` marca a idempotência. Falha fica no log (`alerta`) e é refeita na próxima reconsulta; a reconciliação revisita assinaturas ativas a cada 6 h. Assinatura cancelada ou estornada não é restaurada.
- **Corrida rara**: o mesmo documento com faturas abertas em duas empresas e as duas pagas: a segunda cobrança vale, o resgate dela fica `reservado` e sai um log de alerta para o suporte.
- **PIX na página**: `GET .../billing/web/pix` usa a cobrança mais antiga `PENDING`/`OVERDUE` com forma `PIX` ou `UNDEFINED` (a fatura "pergunte ao cliente" também aceita PIX); `paymentId` é o id local (o mesmo de `openPayment.id`). A confirmação continua vindo do webhook (`PAYMENT_RECEIVED`/`PAYMENT_CONFIRMED` disparam a reconsulta na hora); `refresh` aceita `RATE_LIMIT_AUTH_MAX` (10) por minuto por usuário, e a visão (`GET .../billing/web`) só o limite global.
- **Consentimento de marketing**: o projeto não registra consentimento explícito para e-mail de marketing (o `consent` de `signup_attribution` é dos cookies/anúncios). Decisão: a campanha vai só para quem **não se descadastrou** dos e-mails do ciclo de vida (`lifecycle_emails_opt_out_at` nulo), sem bounce/spam e com conta ativa. Todo envio da campanha leva descadastro em 1 clique.
- **E-mails** (`modules/lifecycle`, mesmo `LIFECYCLE_EMAILS_MODE`, cota e painel):
  - `promo_renewal_monthly_d7`, `promo_renewal_yearly_d15`, `promo_renewal_yearly_d3`: transacionais, para o dono da empresa, mesmo com descadastro das dicas (não com conta suspensa nem endereço suprimido); só enquanto a próxima cobrança é a 1ª cheia; uma vez por marco e vencimento; sem `List-Unsubscribe`.
  - `bf2026_launch` (20/11), `bf2026_today` (27/11), `bf2026_last_day` (01/12): a partir das 10 h de Brasília, só com o `BF26` ativo e vigente; dono de ao menos uma empresa e sem assinatura viva (inclusive pendente) em nenhuma empresa de que participa; um por pessoa por data. Ignora o intervalo de 48 h do funil; continua 1 e-mail por pessoa por rodada.
  - **Pendente operacional**: a cota diária (`LIFECYCLE_DAILY_LIMIT` 50, `EMAIL_DAILY_TOTAL_LIMIT` 70, Resend grátis 100/dia) limita o alcance. Se a base grátis passar de ~50 pessoas, subir os tetos e o plano do Resend antes de 20/11; o que não couber no dia não sai (a janela da campanha é o próprio dia). E o modo precisa estar em `send`.
- **Landing**: `/black-friday` tem cabeçalho próprio e é indexável (`public-pages.ts`).
