# Lote, fabricação e validade

Recurso **opcional por empresa**, ligado em **Opções › Lote e validade**
(`/app/opcoes`). Nasceu da solicitação #1011, de quem trabalha numa empresa
de biscoitos: o mesmo produto chega em lotes diferentes, cada um com a sua
validade, e o app não tinha onde anotar isso.

Disponível nos **dois planos** — não é recurso de assinatura. A base é de
lojista sozinho (94%), e quem mais precisa de validade é justamente a
mercearia pequena.

**Nos dois clientes.** Na web o recurso está no ar desde 25/11/2026; no app
Android, a partir da **versão 40** (quem estiver em versão anterior
sincroniza as movimentações com lote sem perder nada — o protocolo aceita os
campos e os devolve no `pull` —, apenas não os vê). A versão 40 substitui a
39, que ainda não tinha sido enviada à Play.

## A decisão que importa: lote não é entidade

O caminho óbvio seria uma tabela de lotes com quantidade própria. Não foi o
escolhido, porque criaria **duas verdades** sobre o estoque — a soma das
movimentações e a soma dos lotes — que divergem na primeira sincronização com
conflito, e porque obrigaria toda saída a escolher um lote (uma pergunta a
mais em cada venda, para todo mundo).

Em vez disso, **lote é atributo da movimentação**:

| Coluna de `stock_movements` | O que guarda |
| --- | --- |
| `batch_code` | o lote como vem no pacote ou na nota (texto, até 60) |
| `manufactured_on` | fabricação (`date`: dia de calendário, sem fuso) |
| `expires_on` | validade (`date`) |

Preenchidas nas **entradas** (inclusive no cadastro com estoque inicial). A
saída não guarda lote — e a API ignora o que vier. O **estorno copia** o lote
da movimentação original: sem isso, cancelar uma entrada tiraria do saldo do
produto sem tirar do lote, e a validade continuaria contando mercadoria que
voltou para o fornecedor.

## O que está em estoque hoje: FEFO, calculado

`GET /v1/workspaces/:id/batches` (`InventoryService.listBatches`) agrupa as
movimentações por (produto, lote, fabricação, validade), soma as quantidades
com sinal e distribui o **saldo do produto** entre esses lotes pela regra da
prateleira: *first expired, first out* — o que vence antes sai antes. Na
prática a conta é feita de trás para frente, porque o que **sobrou** em
estoque é o de validade mais distante:

1. lotes ordenados por validade **decrescente** (os sem validade primeiro, já
   que não há motivo para supor que saíram);
2. cada um recebe o que ainda não foi reservado pelos de depois;
3. lote que não recebe nada está esgotado e não aparece.

Duas consequências de propósito:

- **a soma dos lotes nunca passa do saldo do produto** — não existe estado em
  que as duas telas discordem;
- o saldo que **não** está em lote nenhum (entradas de antes de ligar o
  recurso) aparece como `summary.withoutBatch`, em vez de ser inventado em
  algum lote.

`daysToExpire` vem calculado pela API no fuso `America/Sao_Paulo`: no
navegador de quem está em outro fuso, a meia-noite cairia em outro dia e o
lote venceria cedo ou tarde demais.

## Onde aparece

| Lugar | O que faz |
| --- | --- |
| Web: `/app/opcoes` | liga e desliga (`workspaces.settings.trackBatches`, permissão `workspace.configurar`) |
| Web: entrada de estoque, cadastro de produto | campos Lote, Fabricação e Validade (só com o recurso ligado) |
| Web: `/app/validades` | lotes em estoque, o que vence primeiro na frente; filtros de 7/30/90 dias; vencidos em destaque |
| Web: detalhe do produto | quanto há de cada lote, e quanto entrou sem lote |
| App: Configurações › Lote e validade | o mesmo interruptor (`CompanyOptions`: guarda no aparelho e manda para a nuvem por `PUT /v1/workspaces/:id`, que a rota aceita junto com `PATCH` porque o `HttpURLConnection` não faz `PATCH`) |
| App: diálogo de entrada | campos Lote, Fabricação e Validade |
| App: menu ⋮ › Validades | `ExpiryActivity`, a mesma lista, calculada no banco local (`BatchRepository`) para funcionar offline |

No app o cálculo é o mesmo, reescrito em Java: `BatchRepository.alocar` é
pura e tem teste (`BatchRepositoryTest`), porque errar essa conta some do
estoque mercadoria que existe. As colunas locais chegaram na versão 11 do
banco do aparelho (`LocalDb.upgradeToV11`).

Desligar **não apaga nada**: os campos desaparecem das telas e as
movimentações seguem com o que foi registrado.

## Nada aqui é editável

Lote não é cadastro: é o que as entradas contaram. Para corrigir, estorna-se
a entrada e lança-se de novo — a mesma regra do resto do estoque
(movimentação é fato, não campo).
