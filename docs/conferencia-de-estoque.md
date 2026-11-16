# Conferência de Estoque

Contagem física que compara o contado com o esperado e fecha com um número em
reais: *"faltam R$ 3.480 em mercadoria"*. É a primeira funcionalidade paga
desenhada para o **lojista que trabalha sozinho** — que é quem forma a base.

Decidida em 15/11/2026 a partir de pesquisa de concorrentes e, principalmente,
de três medições na nossa própria base.

## 1. Por que esta e não outra

As funções pagas de hoje (equipe, produtos sem limite, Análise Avançada,
identidade visual) pressupõem um negócio com funcionário e catálogo grande.
A base não é assim. Os números, medidos no painel em 15/11/2026:

| Medição | Valor | O que diz |
| --- | --- | --- |
| Empresas cadastradas | 32 | base nova: 39 das 40 contas nasceram em novembro |
| Empresas **com mais de uma pessoa** | **2** | **94% das empresas são de uma pessoa só** |
| Empresas pagantes | 3 | 9,4% das empresas — a régua de 8% estava certa |
| `paywall.viewed` com `trigger=team` | **2 de 176 (1,1%)** | **equipe é o gatilho que menos desperta interesse** |
| `paywall.viewed` com `trigger=analysis` | 41 de 176 (23%) | o que desperta interesse é **entender o estoque** |
| `paywall.viewed` com `trigger=product_limit` | 17 de 176 (10%) | o teto incomoda, mas menos que a análise |
| Produtos criados | 3.632 | há uso real; o problema não é abandono |

Lê-se assim: estamos cobrando por **colaboração** num produto usado por gente
**sozinha**, e a única coisa paga que atrai atenção é a que ajuda a
**entender o estoque**. A conferência está nessa trilha e vai além dela — em
vez de informar, ela **quantifica uma perda em dinheiro**, que é o que faz
alguém pagar.

O mercado confirma a demanda. Na Play brasileira, o **Contestoque** (229 mil
instalações) existe só para contagem, é gratuito e está quebrado — a
reclamação recorrente é que o arquivo que ele exporta o próprio app não
importa de volta. O **Mobile Inventory** (591 mil instalações, nota 4,7) é
elogiado justamente por servir de balanço — e **cobra por isso**. Demanda
provada, oferta ruim.

## 2. O que é, do ponto de vista de quem usa

1. A pessoa abre **Conferência** e escolhe o escopo: tudo, ou uma categoria,
   um local ou um fornecedor.
2. Vai bipando o código de barras ou buscando pelo nome e digitando **quanto
   tem de verdade**.
3. Ao fechar, vê item a item a diferença e o total em dinheiro:
   *"Faltam R$ 3.480 · Sobram R$ 210 · 14 itens divergentes de 86 conferidos"*.
4. Confirma e o app lança os ajustes.

Um produto que ela não contou fica **"não conferido"** e **nunca vira zero**.
Tratar não contado como zero é o erro que destrói estoque alheio e rende uma
estrela — é a regra mais importante deste documento.

## 3. Modelo de dados

Duas tabelas **apenas locais**, no `LocalDb` (versão 9 → **10**), aditivas
como todas as anteriores:

```sql
CREATE TABLE inventory_sessions (
  uuid TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  scope_type TEXT,          -- 'all' | 'category' | 'location' | 'supplier'
  scope_value TEXT,
  status TEXT NOT NULL      -- 'open' | 'finished' | 'discarded'
);

CREATE TABLE inventory_counts (
  session_uuid TEXT NOT NULL,
  product_uuid TEXT NOT NULL,
  expected NUMERIC,         -- congelado no momento da contagem
  counted NUMERIC,
  cost_at_count NUMERIC,    -- idem, para o total em reais não mudar depois
  counted_at INTEGER,
  PRIMARY KEY (session_uuid, product_uuid)
);
```

O esperado e o custo são **congelados na hora da contagem**: se o produto for
movimentado no meio da conferência, o resultado não muda retroativamente.

### O que NÃO muda

Nada na API, nada no protocolo de sincronização, nenhuma migration do
Postgres, nenhum campo novo no payload. É condição de projeto: a
sincronização teve um pós-mortem em novembro
([auditoria-sincronizacao-2026-11.md](auditoria-sincronizacao-2026-11.md)) e
não será tocada por uma funcionalidade de contagem.

O fechamento usa o que já existe: `MovementRepository.setAbsolute(productUuid,
AJUSTE, contado, nota)`. O `change_type` continua sendo um dos cinco valores
do contrato (`entrada`, `saida`, `ajuste`, `cadastro`, `importacao`,
`edicao`, `cancelamento`) — **não se cria tipo novo**. O motivo da divergência
vai no campo `note`, que já existe e já sincroniza:

```
conferência 15/11 · falta · quebra
```

As movimentações seguem imutáveis e sobem pela `sync_outbox` de sempre. Para a
nuvem e para a web, uma conferência é um punhado de ajustes com nota — que
elas já sabem exibir.

## 4. O limite do plano gratuito

**Três conferências por mês civil**, de qualquer escopo, **completas**: lista
de divergências, total em reais e ajustes aplicados. Nada é escondido, nada é
borrado, nada leva marca d'água.

No plano **Equipe**: ilimitadas, mais histórico com comparação entre
contagens (a perda está subindo ou caindo?), PDF da conferência, e o registro
de quem contou cada item.

O contador não é um número guardado à parte: é `SELECT count(*) FROM
inventory_sessions WHERE status='finished'` no mês corrente. Auditável, e
imune a ficar fora de sincronia com a realidade.

### Por que três, e por que isso converte

A primeira conferência entrega o choque inteiro, de graça — o produto prova
que vale dinheiro **antes** de pedir dinheiro. O que ela cria é um hábito:
ninguém recontra a loja toda, reconta *a prateleira dos parafusos na terça*.
Esse hábito consome três por mês na primeira semana de uso sério. O limite
morde depois que o valor ficou óbvio, e o que ele bloqueia é **frequência**,
não funcionalidade.

Há um efeito de segunda ordem que importa mais que o limite: quem descobre
que falta mercadoria quer saber **quem** deu baixa errada (equipe e
auditoria), quer a nuvem para não perder o histórico e quer a Análise
Avançada para entender o giro. A conferência é o que faz as funções pagas que
já existem finalmente fazerem sentido.

### O aviso vem antes, nunca depois

Na terceira conferência do mês o app avisa **ao iniciar**:
*"Esta é a sua 3ª conferência de novembro. No plano gratuito são três por
mês."* Na quarta, o convite aparece **antes de contar o primeiro item**.

Isto não é detalhe de texto, é a diferença entre converter e tomar uma
estrela. A reclamação nº 1 contra os concorrentes diretos é paywall surpresa
— "cadastrei tudo e só então bloquearam" aparece no Estoque Fácil 2.0, no
SmartPOS e no Kontro. Cobrar depois do trabalho feito é o caminho mais curto
para a avaliação de uma estrela.

## 5. Telas

| Tela | O que faz |
| --- | --- |
| `ConferenceActivity` | escolhe o escopo, mostra o andamento ("23 de 86 conferidos") e recebe a contagem item a item, por busca ou leitor de código de barras |
| `ConferenceResultActivity` | fechamento: divergências, total em reais, motivo por item e o botão que aplica os ajustes |

Reaproveita o `ScannerActivity` (ZXing, com lanterna) e o gerador de PDF do
`ReportsActivity`. Entra no menu principal perto de Relatórios.

### Motivo da divergência

Ao fechar, cada item divergente aceita um motivo em chip: **quebra**,
**furto/perda**, **erro de lançamento**, **achado**. Vai no `note` e permite
uma linha "perdas do mês" em Relatórios. É o que transforma um susto único em
métrica recorrente — e custa um ou dois dias.

## 6. Riscos e o que os contém

| Risco | Contenção |
| --- | --- |
| Ajuste em massa errado apaga estoque real | confirmação com resumo antes de aplicar; não contado nunca vira zero; tudo entra como `ajuste`, cancelável pelo mecanismo compensatório que já existe |
| App fechar no meio de uma contagem longa | cada item é gravado **na hora**, não ao fechar; a sessão fica `open` e é retomável |
| O limite é burlável reinstalando | aceito: quem reinstala para fugir de três por mês não ia pagar |
| A hipótese estar errada | `paywall.viewed` já carrega `trigger`; se `conference` não dominar em 30 dias, a hipótese cai cedo e barato |

## 7. Medição

Eventos novos, no contrato de [analytics.md](analytics.md):

- `conference.started` — com `scope_type` e `items_in_scope`
- `conference.finished` — com `counted`, `divergent`, `delta_value` e `duration_ms`
- `conference.blocked` — quando o limite gratuito barra (vira `paywall.viewed`
  com `trigger=conference`)

A pergunta que eles respondem em 30 dias: **a conferência virou o maior
gatilho de paywall?** Se não virou, esta aposta estava errada.

## 8. Fases

**v1 (Android, 2 a 3 semanas):** escopo, contagem, fechamento com total em
reais, motivo da divergência, limite de três por mês, eventos.

**v2 (web e API, outro ciclo):** iniciar e acompanhar conferência pela web,
duas pessoas contando setores diferentes, histórico comparado. Exige tabelas
na API com RLS e extensão do protocolo de sincronização — e é justamente
parte do que se vende no Equipe. **Só depois de ver a conversão da v1.**

## 9. O que ficou por verificar

- Se o Contestoque ou o Mobile Inventory já têm contagem atrás de paywall, com
  que escopo e que limite. Vale instalar os dois antes de escrever a v2.
- Nenhuma conversa com os 3 pagantes nem com quem criou conta e não pagou.
  Seis entrevistas custam uma tarde e valem mais que toda a pesquisa que
  originou este documento.
