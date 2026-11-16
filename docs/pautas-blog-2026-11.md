# Pautas do blog a partir da busca real (nov/2026)

O que as pessoas digitam no Google, com volume medido, e o que disso o blog
ainda não cobre. Levantado em 16/11/2026.

## Como isto foi levantado (e como refazer)

**Planejador de palavras-chave** do Google Ads (conta 271-634-1302) ›
*Descobrir novas palavras-chave*, com os termos semente `controle de
estoque`, `aplicativo de controle de estoque` e `planilha de controle de
estoque`. Brasil, português, média dos últimos 12 meses. Deu **1.854 ideias**;
as 99 primeiras por relevância estão resumidas aqui.

> **Por que não pelo Search Console.** Existe uma técnica conhecida de
> filtrar lá as consultas longas (regex `^(?:\S+\s+){7,}\S+$`) e responder as
> de muita impressão e pouco clique. Ela é boa, mas lê os dados **do nosso
> site**: em 16/11 o site tinha **0 impressões em 16 meses**, então o filtro
> volta vazio. O Planejador lê os dados **do Google** e funciona desde o dia
> zero. Quando houver impressões, as duas se complementam.

Também não existe "cadastrar palavras-chave": a meta tag `keywords` foi
abandonada pelo Google em 2009, e o site não a usa (certo assim). O que
coloca a página na busca é responder à pergunta.

## O achado: o concorrente não é um app, é a planilha

Somando as variações, **"planilha de estoque" passa de 10 mil buscas por
mês** — muito acima de qualquer termo de aplicativo:

| Termo | Buscas/mês |
| --- | --- |
| planilha de controle de estoque | **2.900** |
| planilha controle de estoque / planilha para controle de estoque / controle de estoque planilha | **2.400** cada |
| planilha de estoque | 1.600 |
| planilha para controle de estoque grátis excel | 1.000 |
| controle de estoque excel · planilha de controle de estoque excel · planilha excel controle de estoque | 720 cada |
| planilha estoque | 480 |
| planilha de estoque excel · planilha de controle de estoque entrada e saída | 390 cada |

Compare com o lado "aplicativo": `aplicativo para controle de estoque` 320,
`aplicativo controle de estoque` 320, `app controle de estoque` 210,
`controle de estoque app` 210, `app para controle de estoque` 170,
`aplicativo de controle de estoque` 140, `app de estoque` 90.

**Quem procura planilha é exatamente o nosso público**: a pessoa que controla
estoque na mão e ainda não cogitou um aplicativo. É um público dez vezes
maior, e que chega com o problema já formulado.

## Prioridade 1 — a planilha como porta de entrada

Uma página que **entrega a planilha de verdade** (sem pedir cadastro) e,
depois de resolver o problema, mostra o que a planilha não faz: não avisa
quando está acabando, não funciona no balcão pelo celular, não guarda quem
lançou, e quebra quando duas pessoas mexem juntas.

| Pauta | Termo-alvo | Buscas/mês |
| --- | --- | --- |
| Planilha de controle de estoque em Excel para baixar grátis | planilha de controle de estoque | 2.900 |
| Planilha de entrada e saída de produtos: como montar e quando ela não basta | planilha de controle de estoque entrada e saída | 390 |
| Controle de estoque no Excel: as fórmulas que resolvem (e os limites) | controle de estoque excel | 720 |

**Armadilha a evitar:** escrever só para ranquear e empurrar o app. Quem
chegou quer a planilha. A página entrega a planilha; o app aparece como o
passo seguinte de quem cansou dela. Sem isca escondida.

## Prioridade 2 — termos de produto ainda descobertos

| Pauta | Termo-alvo | Buscas/mês |
| --- | --- | --- |
| Controle de estoque simples: como fazer sem complicar | **controle de estoque simples** | **720** |
| Controle de estoque grátis: o que dá para fazer sem pagar nada | controle de estoque gratis | 320 |
| Controle de entrada e saída de mercadoria, passo a passo | controle de estoque entrada e saida | 480 |

`controle de estoque simples` com 720 buscas/mês é o próprio nome do produto,
e hoje o site não tem página para ele.

## Prioridade 3 — nichos que pagam caro no anúncio

O lance de topo em `sistema para loja de roupas` chega a **R$ 83,82**: é
mercado disputado, e conteúdo orgânico sai muito mais barato que o clique.

| Pauta | Termo-alvo | Buscas/mês |
| --- | --- | --- |
| Controle de estoque para loja de roupas: grade, numeração e o que muda | sistema para loja de roupas | 1.300 |
| Controle de almoxarifado: o que é e como organizar | controle de almoxarifado · sistema de almoxarifado | 170 cada |
| Controle de estoque para restaurante: insumos, fichas e perdas | controle de estoque restaurante | 70 |

## O que o blog já cobre (não repetir)

| Post publicado | Termo que ele atende | Buscas/mês |
| --- | --- | --- |
| Como fazer contagem de estoque sem fechar a loja | contagem de estoque | 590 |
| Como organizar o estoque da loja | organização de estoque | 390 |
| Histórico de estoque: entradas e saídas | (parcial) controle de estoque entrada e saida | 480 |
| Estoque mínimo · Estoque parado · Perdas · Giro · WhatsApp | cauda longa, sem volume medido isolado | — |

O post de histórico cobre o assunto por outro ângulo; vale revisar se ele
responde à busca por "controle de entrada e saída" logo no começo, em vez de
abrir um post novo.

## Medição

Nenhum destes termos tem impressão hoje. O sinal de que funcionou aparece no
Search Console, em **Desempenho › Consultas**, algumas semanas depois de cada
post ser indexado. Quando as primeiras impressões chegarem, aí sim vale o
filtro de consultas longas descrito no começo.
