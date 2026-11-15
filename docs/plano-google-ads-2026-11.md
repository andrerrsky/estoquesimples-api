# Plano de eficiência — Google Ads

*Estoque Simples · 14/11/2026 · revisado em quatro rodadas com um especialista em mídia de performance (nota final 9,0/10)*

## 0. O número que decide o plano

A pergunta mais barata de responder era: **os 50 instaladores pagos de 12 e 13/11 viraram conta?**

| Dia | Semana | Instalações pagas | Contas via Android |
|---|---|---|---|
| 07/11 | sábado | 0 | 1 |
| 08/11 | domingo | 0 | 4 |
| 09/11 | segunda | 0 | 5 |
| 10/11 | terça | 0 | 5 |
| 11/11 | quarta | 0 | 4 |
| **12/11** | **quinta** | **17** | **1** |
| **13/11** | **sexta** | **33** | **2** |

A comparação tem de ser entre dias úteis: o teste caiu em quinta e sexta, e para um app de comércio dia útil converte melhor que fim de semana. Base de dias úteis (seg, ter, qua): 14 contas em 3 dias = **4,67/dia**. Esperado nos dois dias de teste: **9,3**. Observado: **3**.

- Poisson, P(X ≤ 3 | λ = 9,3) ≈ **1,7%** — a queda não é ruído.
- Limite superior de 95% para a taxa observada: 4,4 contas/dia, **abaixo** da linha de base de 4,67.

> **O limite superior de 95% para a contribuição incremental das 50 instalações pagas é zero.** O ponto estimado é negativo.

E a conta que fecha o raciocínio: mesmo no cenário frouxo em que o pago tivesse entregado 2,4% de install→cadastro, com cadastro→pagante de 10% isso daria **0,24% de install→pagante** contra os **1,36% necessários** (seção 1) — ainda **5,7x** de distância.

O CPA de R$ 0,56 é real e é irrelevante: compramos instalação barata de quem não abre conta, e sem conta não há nuvem, assinatura nem receita.

**Ressalva honesta:** isto é um pré/pós agregado por dia de calendário, não um acompanhamento dos 50 instaladores ao longo do tempo. Falta o **lag de cadastro** — um lojista pode instalar, usar offline alguns dias e só então criar conta. É justamente por isso que a decisão abaixo é pausar e **reler a mesma coorte depois**, em vez de empilhar tráfego novo por cima dela.

## 0.1 Onde o dinheiro foi parar — e por quê

Segmentando a campanha de App por rede:

| Rede | Custo | Instalações | CPA | Impressões |
|---|---|---|---|---|
| **Rede de Display** (banners dentro de apps e jogos) | R$ 32,08 | **47** | R$ 0,68 | 2.174 |
| **Pesquisa Google** (inclui a busca da Play) | R$ 5,05 | **4** | R$ 1,26 | 934 |
| Parceiros de pesquisa | R$ 0,00 | 0 | — | 29 |
| YouTube | R$ 0,20 | 0 | — | 7 |

**86% das instalações vieram da Rede de Display**, e isso não foi acidente: a campanha está configurada como *Volume de instalações (todos os usuários)* com **CPI desejado de R$ 0,90**. Pedimos ao Google a instalação mais barata possível, e ele foi buscá-la onde ela é mais barata — o banner dentro de um jogo, onde boa parte do clique é acidental.

A busca da Play entregou 4 instalações a R$ 1,26. É quase certo que as poucas contas criadas vieram daí.

> A campanha não falhou: ela fez exatamente o que foi pedida. O erro está no pedido.

As duas alavancas reais, e nenhuma delas é "pausar para sempre":
1. **Trocar o foco de "volume de instalações" para "ações no app"**, o que exige o evento de criação de conta medido no Firebase (item 3.1). Com o alvo certo, o Google abandona sozinho o inventário que não produz contas.
2. **Aceitar um CPI maior.** Uma instalação da busca da Play a R$ 3 que vira conta em 20% custa R$ 15 por conta; dez instalações de Display a R$ 0,68 que não viram conta nenhuma custam R$ 6,80 por nada.

## 1. Economia unitária: a régua

| | |
|---|---|
| Assinatura anual | R$ 199,90 − 15% Google Play ≈ **R$ 170 líquidos** |
| MRR atual | R$ 50,47 / 3 assinantes |
| **CAC máximo (payback 3:1)** | **R$ 55 por pagante** |

Ao CPI de R$ 0,75, o CAC de R$ 55 exige **install→pagante de 1,36%**. A taxa histórica da base é **0,15%** — e ela é *blended* (orgânico + web + vida inteira do app). Como tráfego pago costuma converter pior que orgânico, 1,36% é, se tanto, uma régua otimista.

**O alvo é 9x a taxa atual, e isso não é trabalho de mídia.** Nenhum ajuste de lance, criativo ou segmentação entrega 9x; quem entrega é o produto. Decompondo: com cadastro→pagante de 10%, seria preciso install→cadastro de 13,6%; com 5%, de 27%. O teto que os dados sustentam hoje para o pago é 0–2,4%.

**Custo máximo por ativação** = CAC máximo × (ativado→pagante): a 10% → **R$ 5,50**; a 20% → **R$ 11,00**. R$ 18 exigiria 33%, para o que não há dado.

### O gasto já quadruplicou

Antes da campanha de App: **R$ 4,44/dia**. Com ela: **R$ 18–20/dia ≈ R$ 540–600/mês**, contra MRR líquido de **R$ 50,47** — cerca de **11x o faturamento mensal em mídia**. Não houve decisão de escalar: a campanha nova simplesmente passou a consumir o orçamento que já estava configurado.

**Teto de mídia enquanto o funil não melhorar: R$ 250/mês.** O plano abaixo soma **R$ 132** (seção 7), com folga.

## 2. Estado da conta

Pontuação de otimização: **96,9%**.

| Campanha | Orç./dia | Estado | Custo | Conv | CPA |
|---|---|---|---|---|---|
| App \| Instalações Android | 18,00 | 2 dias, consumindo 100%+ | 37,32 | 50 | 0,75 |
| Pesquisa \| App e controle | 6,40 | 10 cliques no total | 27,64 | 0 | — |
| Pesquisa \| Planilha (teste) | 3,00 | **sufocada** (1 impressão) | 0,00 | 0 | — |
| Display \| 3 conceitos | 15,60 | pausada em 10/11 | 68,37 | 2 | 34,18 |
| Campanha no. 1 (vídeo) | 10,00 | pausada, sem grupos | 0 | 0 | — |

App dia a dia: 12/11 R$ 18,98 · 17 conv · CPA R$ 1,12 — 13/11 R$ 18,34 · 33 conv · CPA R$ 0,56. Consome 105% e 102% do orçamento: está limitada de verdade. O CPA pela metade tem duas leituras que preveem a mesma curva — saída do aprendizado, ou inventário mais barato e pior. A seção 0 favorece a segunda.

*(O CTR do Display aparece como 10,31% em 30 dias e 15,43% em 7 — mesma campanha, recortes diferentes. Alto demais para display nos dois casos, assinatura de clique acidental.)*

**Aviso antes que aconteça: pausar a campanha de App vai mexer na pontuação de otimização, provavelmente para baixo.** O score é ponderado por gasto e hoje a campanha de App domina o número. Isso é efeito contábil da pausa, não piora da conta — e é o preço de parar de gastar R$ 18/dia em instalação que não vira conta.

## 3. Medição, separada por funil

| Ação de conversão | Origem | Status | Metas da conta | Conv. |
|---|---|---|---|---|
| Assinatura (offline) | importar de cliques | Requer atenção | Sim | **0** |
| Ativação (offline) | importar de cliques | Requer atenção | Não | **0** |
| Downloads / Instalações | Google Play | Ativa | Sim | 50 |
| Inscrições (GA4 `sign_up`) | GA4 | Ativa (secundária) | Não | 2 |

Os CSVs de offline não estão quebrados: estão vazios porque **nenhum dos 38 cadastros tem identificador de clique** (`hasClickId: false`), mesmo com marcação automática ligada e com o app lendo `gclid`/`gbraid`/`wbraid` do Install Referrer desde a v34. São dois funis:

- **App** (anúncio → Play → instala → cadastra no app): **não existe gclid**; a medição correta é Firebase/GA4 ligado ao Ads.
- **Web** (anúncio → site → cadastra): gclid existe e a importação offline é o caminho. Volume pago hoje: 10 cliques.

**3.1 — parcialmente feito em 14/11.** O Firebase já está no app (projeto `estoque-simples-f3604`) e o `FirebaseMirror` já espelha `signup.completed` como `sign_up` e `product.created` como `product_created`; no GA4, `sign_up` já é evento principal nos dois fluxos. **Importadas como conversão:** `purchase`, `In-app purchase` e `app_store_subscription_renew` do app, todas principais e nas metas da conta — é a receita de assinatura da Play finalmente chegando ao Ads.

**Criada também a conversão do `sign_up` do fluxo Android** (`br.com.gameloop.estoquesimples`), categoria Inscrição, marcada como **principal** e deliberadamente **fora das metas da conta**: ela precisa existir como principal para poder ser escolhida como foco da campanha, e ficar fora das metas garante que não mexe na otimização de nada enquanto isso. Com ela, o pré-requisito do religamento (5.1) está cumprido — a campanha pode voltar mirando *conta criada* em vez de instalação.

**3.1 (original)** Vincular Firebase e importar `first_open`, criação de conta e primeiro produto. A compra via Play Billing chega sozinha com o app vinculado ao Play. *(É a recomendação de +1,1%; aqui não é cosmética — e continua valendo com a campanha pausada, porque é o que vai medir o religamento.)*
**3.2** Metas **no nível da campanha**, nunca nas metas da conta: `sign_up` tem 2 eventos/mês e, posto na conta, arriscaria travar entrega. *(Sob CPC manual isso vale só para relatório.)*
**3.3** Auditar o disparo do `sign_up`: 34 cadastros contra 2 eventos no GA4.
**3.4** Não valorar conversões: com 3 assinantes não há taxa, há ruído.

## 4. As recomendações do Google (3,1 pontos)

**Cláusula de segurança: nunca aplicar "aumentar orçamento" nem "mudar para Maximizar conversões".** São as que mais sobem a pontuação e as únicas que queimam caixa sozinhas.

| # | Recomendação | Ponto | Decisão |
|---|---|---|---|
| 4.1 | Remover negativas em conflito | +0,6% | **Aplicar** — conferindo antes se `planilha controle de estoque simples` está na campanha, no grupo ou em lista compartilhada |
| 4.2 | Eventos do Firebase nas metas | +1,1% | Aplicar via 3.1 |
| 4.3 | Títulos e descrições nos grupos de app | +0,2% | **Suspenso** com a campanha pausada |
| 4.4 | Grupo de anúncios adicional | +1,2% | **Suspenso** — só entra como parte do religamento |
| 4.5 | Logo da empresa | 0 | Fazer |
| 4.6 | Vídeos com orientações diferentes | 0 | **Suspenso** — guardados para o religamento |
| 4.7 | Google Ads Editor | 0 | **Dispensar** (dispensar também sobe o score) |

A pontuação é **ponderada por gasto**, **campanhas pausadas não entram** e **recomendações dispensadas reaparecem** — 100% é um instante, não um estado. Com a campanha de App pausada, boa parte dos pontos pendentes sai do cálculo junto com ela.

## 5. Decisões sobre as campanhas

**5.1 App: pausar hoje.** Não é desistência, é a leitura mais barata. Continuar custaria R$ 126 até 21/11 e, pior, **contaminaria a medição**: 175 instalações novas por cima da coorte de 50 tornariam impossível separar quem veio de quando. Pausando, a mesma coorte continua sendo observada **de graça e limpa**.

> **O religamento tem alvo, não só data:** a campanha volta com o foco em *ações no app* (conta criada) em vez de volume de instalações, com exclusões de inventário e CPI desejado mais alto. Sem essas três mudanças, religar é repetir o mesmo pedido e esperar resposta diferente.
>
> **Critério de religamento, escrito agora:** reler em **21/11** quantas contas Android vieram dos instaladores de 12–13/11. Se, com o lag, install→cadastro passar de **5%** (≥ 3 contas incrementais sobre a base de 4,67/dia em dias úteis), religar com exclusões de inventário e os vídeos, por 10 dias e R$ 180. Abaixo disso, a mídia de instalação fica desligada até o produto mudar o primeiro degrau.
>
> **Como essa leitura será feita, para não repetir o método agregado.** Perseguir 3 contas incrementais dentro de uma janela de 8 dias que espera ~30 é procurar sinal dentro do ruído. A releitura precisa acompanhar *aquelas* instalações: pela coorte de `first_open` de 12–13/11 no Firebase (o que torna o item 3.1 pré-requisito de 21/11), ou pela data de primeira abertura no banco, se o app já a registrar — vale checar isso antes, porque resolveria sem depender do Firebase. **Se nenhuma das duas estiver de pé em 21/11, adiar a leitura em vez de fazê-la pelo método agregado:** adiar é grátis, a campanha está pausada.
>
> 21/11 é a **primeira** leitura, não a última. Com a campanha desligada, esticar o acompanhamento até 30 dias custa R$ 0 e responde com muito mais firmeza.
>
> **Um eventual religamento é de dezembro**, com o teto daquele mês — assim a decisão de 21/11 não disputa caixa com o que já está reservado e nada se decide sob pressão.

**5.2 Pesquisa "App e controle": antes de gastar, usar o Planejador de Palavras-Chave.** O CPC máximo sustentável é LTV × clique→pagante = R$ 170 × 0,5% ≈ **R$ 0,85** para empatar, R$ 0,28 para 3:1; paga-se R$ 2,50–3,19. O Planejador responde de graça se existe cauda longa com volume abaixo de R$ 0,70. Se não existir, **pausar sem comprar clique nenhum**. Se existir, teto de R$ 0,70, R$ 3/dia, 30 dias — com o desfecho esperado sendo ainda assim a pausa.

**5.3 Pesquisa "Planilha (teste)": desbloquear e passar pelo mesmo teste do 5.2.** Nunca foi testada — foi impedida pela negativa. Mas o rigor vale para as duas: rodar o Planejador também nas palavras de "planilha", nos mesmos 20 minutos. Se o CPC lá também for de R$ 2,50, não compra clique nenhum. Se houver cauda longa abaixo de R$ 0,70, 14 dias a R$ 3/dia. Público de "planilha" procura solução grátis: é topo de funil, avaliar por cadastro.

**5.4 Vídeo e Display: deixar pausadas.** Remover não muda pontuação nem gasto.

## 6. Produto — onde o 9x realmente se resolve

Com a campanha pausada, a semana volta para cá. **Esta é a parte do plano que pode mudar o resultado; o resto é higiene.**

**6.0 O denominador — medido, e ele inverte esta seção.** O Play Console registra **566 aquisições de dispositivos em 28 dias**. Tirando as 50 pagas, o orgânico roda a ~**18,4 instalações/dia**, contra **4,67 contas Android por dia útil**:

| | instalações/dia | contas/dia | install→cadastro |
|---|---|---|---|
| **Orgânico** | ~18,4 | 4,67 | **~20,6%** |
| **Pago (12–13/11)** | 25 | 1,5 | **0 a 6%** |

E o degrau seguinte, medido na base: 3 pagantes / 38 contas ≈ **7,9%** de cadastro→pagante.

> Orgânico: 20,6% × 7,9% = **1,63% de install→pagante**, acima dos **1,36%** que o CAC de R$ 55 exige.

**O produto não é o gargalo do primeiro degrau — o tráfego pago é.** Quem chega pela busca da Play cria conta em uma de cada cinco instalações; quem chegou pelo anúncio, praticamente ninguém. A conclusão desta seção muda de "o funil precisa de 9x" para **"não comprar instalação de campanha de App sem exclusões apertadas de inventário"**: ao CPI de R$ 0,75, o pago fecharia a conta se convertesse como o orgânico.

Isso **fortalece** o critério de religamento do 5.1 e dá a ele um alvo concreto: a campanha volta quando houver razão para crer que o inventário mudou — e o que precisa ser batido é 20,6%, não uma meta abstrata.

**6.1 Entender por que o instalador *pago* não vira conta (esta semana).** Com o orgânico em 20,6%, a pergunta deixa de ser "por que o app não converte" e passa a ser "quem são essas pessoas". Olhar a primeira sessão de quem instalou em 12–13/11 — se abriram o app, quanto tempo ficaram, se chegaram à tela de criar conta — diz se foi clique acidental em jogo, se o app sequer foi aberto, ou se há um problema real de primeira tela para esse público.

**6.2 Exclusões de inventário (15 min, guardadas para o religamento).** Já há ~3.100 impressões: dá para ver onde os anúncios apareceram e excluir jogos e apps de baixa intenção.

**Régua, agora que o orgânico é conhecido:** o tráfego pago tem de chegar perto dos **20,6%** de install→cadastro do orgânico. Abaixo de ~13,6% ele não paga o CAC de R$ 55 nem com os 7,9% de cadastro→pagante medidos.

**6.3 Experimentos de ficha na Play — depois.** Não é custo zero: exige ícone e capturas alternativas (horas de design) e, a ~50 instalações/dia, o teste leva semanas para concluir.

## 7. Ordem de execução e orçamento

Duas regras, porque o recurso escasso é hora, não dinheiro: **nenhum item desta semana exige criar asset novo**, e **no máximo um item de Ads por dia**.

| Quando | O quê | Tempo |
|---|---|---|
| **Já feito** | A leitura da seção 0 | — |
| **Próximos 30 min** | **5.1 pausar o App** · 4.1 desbloquear a Planilha · 4.7 dispensar o Editor · 4.5 logo | 30 min |
| **Hoje** | 5.2 e 5.3 Planejador de Palavras-Chave, para "controle de estoque" e "planilha" · 6.0 instalações orgânicas por dia no Play Console | 20 min |
| **Esta semana** | **6.1 primeira sessão de quem instalou** · 3.1 e 3.2 Firebase e metas por campanha · 3.3 auditar `sign_up` | 3 h |
| **21/11** | Reler a coorte e aplicar o critério de religamento (5.1) | 20 min |
| **Depois** | 6.3 ficha da Play · 4.4 e 4.6 se houver religamento | — |
| **Não fazer** | Mexer em orçamento · valorar conversões · aceitar recomendação de lance automático | — |

| Orçamento do mês | |
|---|---|
| App (pausado hoje) | R$ 0 |
| Pesquisa "App e controle" (se o Planejador aprovar) | até R$ 90 |
| Pesquisa "Planilha", 14 dias | R$ 42 |
| **Total** | **R$ 132** — dentro do teto de R$ 250 |
| Reserva do mês | R$ 118 |
| Religamento, se o gate de 21/11 disparar | **dezembro**, R$ 180 no teto daquele mês |
