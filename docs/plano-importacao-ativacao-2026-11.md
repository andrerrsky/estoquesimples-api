# Plano: importação e ativação do primeiro uso (Estoque Simples) — v5

## O problema, medido

Painel próprio, 801 instalações, ~5 semanas:

- 63% das instalações usam o app num único dia e não voltam.
- Funil: 801 abriram → 497 abriram o cadastro → **321 salvaram um produto (40%)** → 267 movimentaram → **66 criaram conta (8,2%)**.
- Quem cadastra ≥1 produto volta no D1 em 40,2%; quem não cadastra, 9,5% (7 dias: 62,1% × 28,5%).
- 273 das 319 cadastraram no mesmo dia da instalação.
- Origem não é o problema: 337 instalações vêm de busca orgânica da Play e cadastram em 49,6%.
- Importação de planilha: **10 concluídas** no período inteiro.

A razão principal deste plano, porém, deixou de ser ativação: conferindo o código apareceu **perda de dado em quem já é cliente** (A0). Isso vem primeiro, independentemente de funil.

## Restrição do dono

**O formulário de produto não muda.** Os 13 campos ficam, nada é removido nem escondido. Nenhum item altera `activity_add.xml` nem a obrigatoriedade dos campos.

## Três envios, não um

| Envio | Conteúdo | Por quê |
| --- | --- | --- |
| **v39 — esta semana** | A0 + **A7** + telemetria (A8, D1) + catálogo dos eventos dela (A9 parcial) + B6 sob flag de 50%, desligável por `RemoteConfig` | A0 é perda de dado em produção: cada dia conta. A7 vai junto porque, sem o mapa canônico (que é v40), não existe "presença" no caminho posicional — recusar é a única regra defensável até lá. B6 é meio dia, não depende do parser e é o item de maior retorno; a flag de 50% dá a atribuição que um envio separado daria. |
| **v40** | A1-A6, A8-A9 (importação) + B1-B5 | O parser e as telas da importação, com rollout escalonado. |
| **v41 (condicionado)** | C1 | Só se a importação já estiver dando certo (ver "Como medir"). |

A0 não depende de A1-A9, não muda schema e não muda tela nenhuma — pode e deve sair isolado.

## Defeitos confirmados no código

**A0 — Importar planilha parcial destrói dados de quem já tem estoque.** `RowProduct.mapped` preenche **todos** os campos ausentes com valor neutro: números com `Quantities.parse(..., 0d)` e textos com `""`. Em `updateExisting` (`DataExchange.java:469-482`), `putIfNumberChanged` grava o zero em `value` e `min_stock`; `putIfChanged` grava a string vazia em `description`, `category`, `sku`, `barcode`, `supplier`, `location` e `unit`; e `qtyChanged` — com `skipQuantity` **sempre falso** na importação de CSV (`DataExchange.java:286`) — dispara `movements.setAbsolute(uuid, AJUSTE, 0, "Importação")`, movimentação que a regra 2 do `apps/android/AGENTS.md` torna imutável. Ou seja: importar uma lista de preços `Descrição;Preço` **zera quantidade, preço e estoque mínimo e apaga categoria, SKU, código de barras, fornecedor, localização, unidade e descrição** de todo produto casado — e apagar o SKU quebra o casamento da importação seguinte, gerando duplicata. Só o custo foi protegido (`DataExchange.java:472`); a mesma decisão nunca chegou aos outros 12 campos. `resolveExisting` casa até por **nome**, então alcança produto digitado à mão.

1. **A importação adivinha o cabeçalho e chama de sucesso.** `CsvCodec.looksLikeHeader` só aceita cabeçalho com a **primeira** coluna em `nome|name|produto|id|sku`; `Código;Descrição;Qtd;Preço` cai em `RowProduct.positional` (desalinhado de `PRODUCT_CSV_HEADER`) e o cabeçalho vira produto.
2. **Excel não é detectado.** O seletor já aceita `application/octet-stream`: o `.xlsx` do WhatsApp **é selecionável hoje** e entra no parser como lixo. Extensão não resolve.
3. **Excel brasileiro grava CSV em windows-1252**; `handlePortableImport` decodifica sempre em UTF-8.
4. **A falha é invisível**: `Toast` + `Log.e`, sem evento, e nenhum evento ao abrir o importador.
5. **`import.completed` dispara com 0 produtos e N falhas.**
6. **A tela de resultado é de desenvolvedor**: `LOG_PREFIX = "Log:\n\n"`.
7. **O caminho não aparece onde a decisão acontece**: o estado vazio oferece "Adicionar meu primeiro produto" e "Ver configurações do app".

## Fase A — parar a perda de dado

**A0. Escrever por presença, não por valor.** O mapa canônico passa a carregar `EnumSet<CampoCanonico> presentes`, e `updateExisting` só escreve coluna que está no conjunto — as outras nem entram no `ContentValues`. Isso cobre os 13 campos de uma vez, em vez de caso a caso. **No CSV, célula vazia em coluna presente também não apaga** (a prévia avisa: "células em branco são ignoradas"); apagar campo continua sendo pela tela de edição. Sem coluna de quantidade, nenhuma movimentação é gerada.

**A regra do CSV não vale para o JSON.** `RowProduct.fromJson` é o caminho de backup/restore, onde `"supplier": ""` significa "sem fornecedor" e o arquivo vem completo: ali presença é `json.has(k) && !json.isNull(k)` e **string vazia apaga**. Aplicar a semântica do CSV ao `importJson` faria a restauração deixar de reproduzir a cópia — regressão silenciosa no único caminho em que exatidão é o produto.

**A0.1. Separar os dois flags.** `applyProductRow(..., skipInitialMovement)` passa hoje o **mesmo** booleano a `updateExisting(..., skipQuantity)`, e na criação ele zera `amount` e troca `change_type` de `importacao` para `cadastro` (`DataExchange.java:424-427`). Ligar a opção "só os preços" (B2) nesse flag faria os produtos novos nascerem com quantidade 0. Viram dois: `manterQuantidadeExistente` (update) e `historicoNoArquivo` (criação a partir de JSON).

**A0.2. Extrair `ProductMerge.merge(atual, linha, presentes, flags) → Decisao{values, geraMovimentacao, quantidade}`**, função pura, no padrão que o repositório já usa (`PhotoRules`, `BalanceAudit`, `ConferenceSummary`). `updateExisting` passa a só aplicar a decisão. É isto que torna o teste do A0 possível em JVM — sem Robolectric, um teste que precise de `SQLiteDatabase` não roda, e o defeito mais grave do plano ficaria sem rede.

**A0.3. Quem já foi atingido.** O defeito está em produção. Não dá para saber **o que** foi apagado, mas dá para saber **quem importou**: `import.completed` existe desde antes (`ImportActivity.java:391`) e é de onde vieram as 10 importações do período. Para quem tem conta, compara-se com o retrato na nuvem anterior à importação; sem conta, a recuperação depende do `LocalBackup` no aparelho. Caminho de recuperação: `LocalBackup` no aparelho e, para quem tem conta, o retrato na nuvem anterior à importação. Entra uma entrada em `packages/help` e uma resposta pronta de suporte ("resolver do nosso lado", CLAUDE.md §4). E, como a base é pequena (35 empresas, 4 pagantes, 10 importações no período), **não se espera a reclamação** — e isso vale **antes de a v39 ir ao ar**, porque depois do conserto fica mais difícil separar "estava zerado" de "foi zerado pela importação": olha-se uma a uma quais empresas importaram CSV e confere-se o estoque delas. Com esse tamanho, esperar sai mais caro que a conferência.

**A1. Extrair `data/CsvSchema.java`** — classe pura, detecção e mapa canônico.

**A2. Atalho "arquivo nosso".** Cabeçalho igual a `PRODUCT_CSV_HEADER` ou `MOVEMENT_CSV_HEADER` → mapa fixo, heurística saltada. A comparação é sobre os nomes **normalizados** (`CsvCodec.normalizeHeader`) e **tolerante à ausência da última coluna**: `custo` foi acrescentado no fim para que planilhas de versões antigas continuassem válidas (`DataExchange.java:38-40`), e é esse acervo que o atalho existe para blindar. Blinda backup/restore.

**A3. Cabeçalho por limiar, com resultado tipado** (`Header{linha, mapa, confiança}` ou `SemCabecalho`). Ordem, para não ficar circular: **monta mapa candidato → valida numéricos → aceita ou rejeita**. Aceita com **sempre ≥2 colunas distintas** do vocabulário (o critério de 50% só reforça em 4+ colunas, porque em arquivo de 1-2 colunas uma coincidência já seria 50%) **e** a linha candidata passa nas duas metades da evidência: nenhuma célula numérica em coluna que o mapa trataria como **nome, SKU, código ou categoria**, e nenhuma célula **não numérica** em coluna que ele trataria como **quantidade ou preço** — é a segunda metade que separa cabeçalho de dado (`Caneta;un;10;2,50`). Procurar nas **3 primeiras linhas** (título + linha em branco cobre o caso real do contador). **Linha de total precisa de regra própria**: `applyProductRow` só pula quando o nome está vazio (`DataExchange.java:412`), e na planilha mais comum (`Descrição;Qtd;Preço`) o "TOTAL GERAL" está **na** coluna de nome — viraria um produto com o preço da soma. Descarta-se a linha cujo nome normalizado seja `total`, `total geral`, `subtotal` ou `soma` **e** que seja a última linha de dados do arquivo ou tenha a coluna de quantidade vazia (a condição "sem outro campo de texto" não protege nada em `Descrição;Qtd;Preço`, que não tem outro campo de texto); conta-se à parte e a prévia diz "1 linha de total que eu ignorei".

**A4. Vocabulário por união e prioridade explícita.** União de `PRODUCT_CSV_HEADER` + `MOVEMENT_CSV_HEADER` com os sinônimos de lojista (`descrição`, `item`, `mercadoria`, `qtd`, `qtde`, `estoque`, `saldo`, `preço`, `preco`, `custo`, `categoria`, `unidade`, `un`, `codigo`, `cod`, `ean`, `barras`, `fornecedor`). `change_type` avaliado **antes** de qualquer recusa. Mapa resolvido **uma vez** (hoje `DataExchange.cell()` escolhe por linha, conforme a célula esteja vazia): `preco_unitario > preço/preco > valor`; `quantidade > qtd/qtde > estoque > saldo`. **`valor` continua canônico sem concorrência** — só perde para `preço` na mesma planilha, senão o arquivo do próprio app deixaria de ser reimportável. Coluna ambígua (`codigo`, `cod`) preenche `sku` **só na criação**; no update **nunca** sobrescreve `sku` nem `barcode` já preenchidos (numa planilha de lojista `Código` costuma ser o EAN, e gravá-lo sobre o SKU embaralha o casamento futuro). Uma coluna nunca serve a dois campos; empate de mesma prioridade fica `UNKNOWN` e a prévia pergunta.

**A5. Encoding.** UTF-8 estrito (`CharsetDecoder` com `REPORT`); só na falha, `windows-1252`.

**A6. Formato por assinatura de bytes.** `PK\x03\x04` (xlsx/ods) e `D0 CF 11 E0` (xls) → `reason=formato_xlsx` antes de decodificar. Protege também quem renomeia `.xlsx` para `.csv`.

**A7. Recusar em vez de adivinhar.** Sem cabeçalho reconhecido: zero gravação e motivo nomeado. O caminho posicional morre.

**A8. Telemetria sem conteúdo do cliente.** `import.opened`, `import.preview_shown` (`rows`, `columns_matched`, `fields_mapped` = nomes canônicos, `delimiter`, `header_row` = o **índice** da linha, 0 a 2, nunca o conteúdo), `import.applied` (`created`, `updated`, `failed`), `import.failed` (`reason` ∈ `arquivo_ilegivel | encoding_invalido | formato_xlsx | cabecalho_nao_reconhecido | zero_linhas_validas | arquivo_grande`), `import.rejected` (motivo enumerado), `account_prompt.shown/accepted/dismissed` (`trigger`). Nenhuma prop carrega texto do arquivo (`docs/analytics.md` é explícito). A falha **não** vai ao Admin › Erros (fila de 30 do `ErrorReporter`).

**A9. Catálogo e ajuda no mesmo trabalho** (CLAUDE.md §6), **partido pelos envios**: a v39 leva A7, logo ela já emite `import.failed` com `reason=sem_cabecalho` no primeiro dia — então **todos** os nomes de A8 entram no catálogo na v39 (é um arquivo de constantes e uma tabela de documentação, risco zero). O painel não pode mostrar evento sem nome justamente no envio em que o motivo da recusa é o que se quer ler. Eventos novos em `apps/api/src/modules/analytics/analytics.events.ts` e `docs/analytics.md`; artigo `importar-planilha` reescrito em `packages/help` (fonte única, `npm run help:sync`). `import.completed` fica 90 dias só pelas séries antigas.

## Fase B — a pessoa entende o que vai acontecer

**B1. Excel tem saída, e a instrução bate com a tela.** MIME do Excel no seletor e, na assinatura de bytes, uma frase por ferramenta — a genérica "Salvar como" **não existe** no Google Planilhas:
- *"No Excel do computador: Arquivo › Salvar como › CSV (separado por vírgulas)."*
- *"No Google Planilhas: Arquivo › Baixar › CSV."*
- *"Se a planilha veio do contador, peça a ele para mandar em CSV."*

Botões "Entendi" e **"Não consegui"** → abre `HelpActivity.open(this, "importar-planilha")` (o artigo já existe e funciona sem internet) e, no fim dele, "cadastre à mão" com o caminho. **Nenhum botão de recusa termina na mesma tela.** Sem anexo para o suporte: o suporte é o dono, e anexo abre atendimento manual sem teto num caminho que hoje é 5%.

**B1.1. Onde está o arquivo** — duas frases estáticas acima do botão, que é o que sobrou (barato) do `ACTION_SEND` cortado: *"O arquivo costuma estar em Downloads."* / *"Se chegou pelo WhatsApp, abra a conversa, toque no arquivo para baixar e depois procure em Downloads."*

**B2. Prévia antes de gravar.** `importCsv` se parte em `analisar(bytes) → Plano` e `aplicar(Plano)`; o arquivo já está em memória (`readCapped`), reparsear é de graça. O `Plano` **não é puro** (consulta sku/código/nome no banco) e roda fora da thread principal, com o lock por linha; `CsvSchema` e `ProductMerge` é que são puros. A aplicação **recalcula** — entre prévia e gravação pode entrar um ciclo de sync — e o resultado final (B4) é a verdade.

Tela cheia, não diálogo:
- **"Encontrei 128 produtos nessa planilha"**;
- **o primeiro produto, um do meio e o último** (o lixo de planilha vive nas pontas, e é o último que delata o arquivo torto), um por item, em duas linhas (nome em negrito; "12 un · R$ 12,90" embaixo) com `contentDescription` em frase ("Caneta azul, 12 unidades, 12 reais e 90"), porque o separador sozinho vira ruído no TalkBack e quebra com fonte em 130%;
- o aviso sobre os existentes, **escolhido pelo mapa**, porque a lista de preços (o arquivo que mais chega) não toca quantidade nenhuma e o texto fixo assustaria à toa: com coluna de quantidade, *"116 já estão no seu estoque. A quantidade deles vai ser trocada pela da planilha."*; sem ela, *"116 já estão no seu estoque. Vou atualizar só o preço; as quantidades ficam como estão."* Sempre: *"Células em branco são ignoradas — nada é apagado."*;
- opção **"Não quero mexer nas quantidades, só nos preços"** — **só aparece quando há coluna de quantidade**, senão é um controle que não faz nada — com a regra escrita: **produto existente não tem quantidade tocada; produto novo entra com a quantidade da planilha** — *"Os 12 novos entram com a quantidade da planilha; nos 116 que já existem eu não mexo."*;
- coluna não entendida vira pergunta: **"A coluna *Qtd* é a quantidade em estoque?"** · "Sim" / "Não, é outra coisa" (e aí, em palavras: quantidade, preço de venda, custo, código, ignorar esta coluna);
- **nada de preço nesta tela**;
- botões: **"Cadastrar 12 e atualizar 116"** — o rótulo descreve o ato, e "Cadastrar 128 produtos" só quando não houver atualização — e **"Não é isso"**, que pergunta o motivo, grava `import.rejected` e oferece dois destinos: "Ver como a planilha precisa estar" (mesmo artigo) e "Cadastrar à mão".

**B3. Desfazer, só o que é seguro.** Apenas os produtos **criados**, por **5 minutos** (tempo, não ciclo de vida de Activity — rotação e ligação recebida não podem encerrar a janela), com cartão no topo da lista de produtos. **Nada é condicionado ao sync**: adiar `syncAfterImport()` não seguraria nada, porque `ProductRepository.create` já enfileira o upsert no `sync_outbox` na hora e a rodada periódica, a volta da rede ou a abertura do app disparam igual. Desfazer é exclusão normal de produto, que a sincronização já propaga como lápide — e o texto diz isso: se já subiu, também sai da nuvem. Isso tira um acoplamento do caminho de sync, que é a parte do app com pós-mortem próprio. Texto honesto: *"Apaga os 12 produtos novos; os 116 que já existiam ficam como estão. O histórico guarda o registro da importação."* — a última frase existe porque `softDelete` não mexe em `EstoqueHistorico` (movimentação é imutável): sem ela, quem abrir o Histórico e vir as entradas de `importacao` conclui que o desfazer falhou. O desfazer completo (restaurar o estado anterior de 116) exige coluna de lote com migração, retrato do "antes", cancelamento compensatório de cada movimentação e regra de conflito com a web — é trabalho próprio. Se apertar o prazo da v40, **B3 é o primeiro item a sair**: a prévia já cobre o medo, e o custo de não ter é um pedido de suporte por mês.

**B4. Resultado em português de gente.** Fim do `"Log:"`: **"Pronto. 128 produtos entraram no seu estoque."** / "4 linhas eu não consegui ler (sem nome ou sem quantidade)" / botão **"Ver meu estoque"**, com `accessibilityLiveRegion="polite"`.

**B5. Gancho de conta e de plano, na tela de sucesso.** Oferta única de criar conta e, acima de 50 itens com conta gratuita, o gatilho `product_limit` com o texto **conferido no código**: ao bater o limite a sincronização inteira pausa (`SyncWorker` grava `SyncMeta.BLOQUEIO_PLANO`), não é "só o excedente não sobe" — *"Acima de 50 produtos a cópia na nuvem fica pausada até você assinar. Nada é perdido: o estoque no aparelho funciona normalmente."* **Enquanto a campanha de Black Friday estiver viva (até 01/12), o `product_limit` abre a compra com a oferta `bf2026` e lê os preços do Billing (`pricingPhases`)**, como já faz o cartão de BF — senão o mesmo usuário vê dois preços para a mesma coisa em duas telas, e a política do Play impede consertar isso mencionando o site.

**B6. Pedir a conta a quem cadastra à mão** — o item de maior alcance: 321 pessoas salvam o primeiro produto manualmente, contra ~46 que importam.
- **Forma, que é o que faltava**: **cartão no topo da lista, nunca diálogo** — modal logo depois de uma ação bem-sucedida atropela quem quer ver o produto que acabou de criar —, exibido depois do "Produto cadastrado", no lugar do `cloudBanner`, sem nunca cobrir o produto recém-criado. Uma linha de texto e dois botões: **"Criar conta"** e **"Agora não"** (fecha; não volta por 7 dias).
- **Sob flag de 50%** (hash do id de instalação, **no app** — o rollout da Play é por atualização de usuário e não dá para escolher quem), **desligável por `RemoteConfig`**: é isso que torna aceitável embarcar B6 no mesmo envio do A0, porque reverter não depende de revisão da Play.
- **Estado em `SharedPreferences`, nunca no banco do estoque**: importar um `.db` troca o banco e não pode zerar supressão nem variante. A variante vem do **mesmo hash** da flag, senão a pessoa troca de braço entre sessões e a leitura morre.
- **Métrica de proteção, não de observação: se o D1 do grupo exposto cair, reverte.** Um pedido de conta mal colocado pode interromper quem ia cadastrar o segundo produto.
- **Convive com o `cloudBanner` que já existe** (`activity_main.xml:163-212`, exibido a quem não tem conta): a oferta de B6 **substitui** o banner na primeira vez. A supressão de 7 dias vale para **os dois braços** (no controle, contada do primeiro fechamento do banner): se só o exposto ficasse sem banner, ele receberia menos pedidos no total e o critério de reversão dispararia por artefato do desenho, não por culpa do convite. Dois pedidos em sequência treinam a pessoa a ignorar os dois — e a projeção de ganho é **incremental sobre o banner atual**, não sobre zero.
- Dois momentos medidos pelo mesmo evento (`trigger` = `primeiro_produto` | `pos_movimentacao`), no máximo duas aparições.
- **Um argumento só**, não um A/B: *"Se o celular quebrar ou for roubado, seu estoque não vai com ele. Com conta, ele volta."* — concreto para quem trabalha sozinho, que é 94% da base. Testar dois textos com ~80 observações por célula não decidiria nada e fragmentaria a leitura do que importa (exposto × controle); o segundo argumento ("cadastre e consulte pelo computador") fica para um ciclo com volume. Em B5, onde o público veio de planilha, o texto do computador é usado direto, sem comparação.

## Fase C — o caminho ficar visível

**C1. Condicionado**, não agendado: sai em **20%** das instalações novas, pela mesma flag da B6, com limiar único: se `abriu o importador → importou com sucesso` ficar abaixo de **50%** no grupo do estado vazio, o botão volta para dentro de "Backup e planilhas". (Um portão medido na população atual não serviria: quem acha o importador dentro de "Backup e planilhas" hoje é mais decidido que a pessoa recém-instalada que a C1 mandaria para lá.) No estado vazio, **substituir** "Ver configurações do app" por **"Já tenho uma planilha"** (não empilhar um terceiro botão: com o cartão da Black Friday aberto, ele cai fora da dobra).

Fora desta entrega, com motivo: **paridade na web** (`apps/web/src/lib/csv.ts` duplica a regra) entra depois que a Fase A estiver no ar e o vocabulário tiver sido corrigido pelo que `import.failed` mostrar. **`ACTION_SEND` do WhatsApp**: `ImportActivity` depende de `MainActivity.stock` estático e abriria com banco possivelmente nulo em partida a frio, e a Activity viraria `exported`. **"Enviar modelo de planilha"** idem. **Ficha da Play** (prints, texto, palavras-chave da busca orgânica): é o ativo mais alavancado que o produto tem — 337 instalações orgânicas cadastrando a 49,6% — e fica para logo depois da v40, quando os prints puderem mostrar o que o app realmente entrega.

## Fase D — o vazamento 17× maior

**D1. Medir, já na v39** (só evento): `product_form.opened` e `product_form.abandoned` com `fields_filled` (contagem) e `duration_ms`. **Sem** "campo em foco ao sair": `onPause` dispara em rotação, troca de app, seletor de foto e leitura de código de barras, e mediria ruído como abandono.

**D2. Decisão com data: 16/12**, com os dados de D1 na mesa. Proposta: barra de cadastro rápido no topo da lista e no estado vazio — *Nome* · *Quantidade* · **Cadastrar** — e, ao salvar, "Quer preencher preço, SKU e o resto agora?" com "Completar" (abre o formulário atual, intacto) e "Depois". **Não é simplificar o formulário**: é uma segunda porta; o formulário continua com os 13 campos e é para onde "Completar" leva. Se aprovado, entra em janeiro com flag de 20% **no app**.

## Como medir

**Controle, não "antes e depois":** coorte da versão nova × coorte ainda na anterior, na mesma semana. Isso **já é possível**: os eventos carregam `app_version_code` e o painel segmenta por versão. Rollout da v40: 20% por 3 dias, 50% por 3, depois 100%.

**Etapas relativas** (menos sensíveis a mix de aquisição e à sazonalidade de dezembro):
- `abriu o importador → importou com sucesso` (`import.applied` com `created ≥ 1` e `failed = 0` — não "40 importações", que se bate com 40 falhas);
- `abriu o cadastro → salvou` (hoje 321/497 = 64,6%);
- `import.failed` por motivo — hoje não existe, qualquer valor é ganho.

**A métrica principal é o experimento, não a taxa absoluta:** **conta criada em 7 dias, braço exposto × braço de controle**, com alvo de elevação relativa **≥ 20%** sobre o controle. `instalação → conta criada` (hoje 8,2%) fica como acompanhamento **sem meta**: é contaminada por Black Friday, cadastros pela web e mix de aquisição. (A meta "instalação → salvou produto 40% → 43%" saiu pelo mesmo motivo: o teto calculado de 5,8pp não sai do ruído.)

**Diferença mínima detectável, dita antes de medir:** são ~321 primeiros cadastros por 5 semanas, ou seja ~**160 por braço** em 6-8 semanas, sobre uma base de 20,6%. Isso separa diferenças da ordem de **+10pp**; +3 ou +4pp — que já seria bom negócio — é indistinguível de ruído. Regra de decisão para o empate estatístico, que é o desfecho provável: a **única** regra de decisão é a que o plano já tem certa — empate sem queda de D1 → **mantém** B6, não remove. A **taxa de dispensa** (`dismissed/shown`) serve para descrever, não para escolher: ela é mais sensível por ficar no topo do funil, com base maior, e não por qualquer virtude de ser intra-braço. Partir o braço exposto em variantes de texto **não** aumenta sensibilidade — divide ~160 em células de ~80 e convida a perseguir ruído.

**A etapa que hoje ninguém enxerga:** `account_prompt.accepted → user.registered` (o evento de API já existe). Se muita gente aceita e não termina, o problema nunca foi o convite, e sim a tela de cadastro — e nenhuma variante de texto resolveria. É diagnóstico de meio dia que pode redirecionar o ciclo seguinte.

**Um pedido por sessão, com uma exceção que decide o experimento:** no gatilho `primeiro_produto` o cartão de B6 **vence** o da Black Friday (quem acabou de cadastrar o primeiro produto ainda não é público de compra, e o de BF volta na sessão seguinte). Fora desse gatilho, até 01/12 o cartão da Black Friday tem prioridade sobre o de B6, que fica para a sessão seguinte. Sem essa exceção o experimento nasceria suprimido: o primeiro produto acontece na primeira sessão, e para 63% das instalações não há sessão seguinte — dois pedidos competindo na mesma tela treinam a pessoa a ignorar os dois, e o de BF tem receita imediata. As coortes expostas ao cartão de BF ficam marcadas na leitura do experimento.

**Critério de fracasso declarado, na moeda nova:** B6 não entregou se a elevação relativa de conta criada em 7 dias ficar abaixo de 20% **e** a taxa de dispensa não melhorar entre as variantes. Sem queda de D1, mantém-se B6 e tenta-se outro argumento — porque, num app offline-first, quem nunca cria conta não aparece na nuvem, não recebe e-mail de ciclo de vida e não pode pagar. A janela de 7 dias conta a partir do `account_prompt.shown`, não da instalação: a prioridade do cartão de Black Friday atrasa a primeira exposição de parte das pessoas.

**Critério de reversão:** D1 do grupo exposto a B6 abaixo do grupo não exposto.

**Não anunciar** "importe sua planilha" na ficha da Play nem em anúncio antes de haver dado de importação bem-sucedida.

## Esforço

| Fase | Dias | O que entrega |
| --- | --- | --- |
| A0-A0.3 | 1,5 | Para de destruir 13 campos e o estoque de quem já é cliente; função pura testável; caminho de recuperação |
| A1-A9 | 3 | Parser correto, recusa honesta, telemetria, catálogo e ajuda |
| B1-B4 | 2,5 | Excel explicado com saída, prévia, desfazer dos criados, resultado legível |
| B5 | 0,5 | Conta e plano pedidos na tela de sucesso da importação |
| B6 | 1 | Conta pedida no primeiro produto à mão (cartão, flag, supressão, variantes, estado em preferências) |
| C1 | 0,5 | Caminho visível — condicionado a ≥70% de sucesso |
| D1 | 0,5 | Enxergar as 176 |

Total ≈ **9,5 dias**. A0 e A1-A9 são defeito: saem independentemente de retorno. Onde a comparação de alocação vale é B5-B6 — 1,5 dia, estimado em **+0,3 a 1 pagante/mês** (~R$ 170/ano cada), **incremental sobre o `cloudBanner` que já existe**; mesmo na ponta baixa da faixa, é o melhor retorno por dia do documento. C1 e D2 são opcionais.

## Testes

**Puros (JVM), em `CsvSchemaTest` e `ProductMergeTest`:**
- `Descrição;Preço` sobre 20 produtos existentes → 20 atualizados, **0 movimentações**, quantidades e mínimos intactos **e categoria, SKU, código de barras, fornecedor, localização, unidade e descrição intactos**;
- coluna presente com célula vazia (`Fornecedor` em branco) → fornecedor preservado, 0 movimentações;
- "só os preços" marcado, planilha com 12 novos → os 12 nascem com a quantidade da planilha e `change_type = importacao` (impede a colisão dos flags);
- existente com `sku = "ABC-1"` e planilha com `Código = 7891234567895` → `sku` preservado; produto novo recebe o código;
- `merge` com atual idêntico à linha → `values` vazio, sem movimentação, contado como `skipped`;
- `Código;Descrição;Qtd;Preço` → mapa `sku,nome,quantidade,valor`;
- `Caneta;un;10;2,50` sem cabeçalho → não é cabeçalho, 1 produto;
- 1 coluna (`Item`) e 2 colunas (`Item;10`) → não é cabeçalho (brecha do ≥50%);
- `PRODUCT_CSV_HEADER` exato → mapa fixo, ida e volta idêntica, `valor` como preço;
- `MOVEMENT_CSV_HEADER` exato → mapa fixo, desvia para movimentações;
- `Preço` + `Valor` juntos → preço vem de `Preço`; `Quantidade` + `Saldo` → linha com `Quantidade` vazia não cai em `Saldo`;
- título e linha em branco acima do cabeçalho → encontrado na busca das 3 primeiras linhas;
- `PK\x03\x04` com nome `.csv` → `formato_xlsx`, zero gravação; `D0 CF 11 E0` idem;
- cabeçalho em windows-1252 → reconhecido após o fallback; UTF-8 válido com `\xE7` isolado → **não** cai no fallback;
- `1.234,56`, `R$ 12,90`, `12,5`, `1,234.56`, `(5)`, `12%`, vazio → valores esperados;
- nenhuma coluna reconhecida → recusa, zero gravação; só cabeçalho → `zero_linhas_validas`;
- `;` com campo entre aspas contendo `;` e quebra de linha → colunas preservadas;
- `Qtd` e `QTD.` → a primeira vence (`indexHeader` usa `Map.put` e hoje sobrescreve);
- linha com menos e com mais células que o cabeçalho → sem `IndexOutOfBounds`;
- casa 1 produto por nome e outro por SKU → ambos `updated`, nenhuma duplicata;
- linha que casa por nome com produto digitado à mão → `updated` na prévia e **fora** do desfazer;
- `import.applied` com `created=0, failed=12` → não conta como sucesso;
- props de `import.failed`, `import.preview_shown` e `account_prompt.*` → nenhuma contém texto do arquivo nem dado pessoal;
- `Descrição;Qtd;Preço` com `TOTAL GERAL;;1.234,56` no fim → nenhum produto criado a partir dessa linha, contada à parte; e um produto legitimamente chamado "Soma" **no meio** do arquivo → importado normalmente;
- cabeçalho exportado por versão antiga (`PRODUCT_CSV_HEADER` **sem** a coluna `custo`) → atalho "arquivo nosso" reconhece, `custo` ausente e preservado nos existentes;
- B6 no gatilho `primeiro_produto` com o cartão de BF elegível na mesma sessão → aparece o de B6;
- restaurar JSON portátil com `fornecedor: ""` → fornecedor **limpo** no destino; CSV com coluna `Fornecedor` em branco → fornecedor **preservado** (as duas semânticas, lado a lado);
- v39, arquivo `Código;Descrição;Qtd;Preço` → recusa com motivo, **zero gravação** (A7 já na v39);
- `merge` com `manterQuantidadeExistente = true` e produto novo → quantidade da planilha e `change_type = importacao`; com `historicoNoArquivo = true` → `amount = 0` e `cadastro` (os dois flags em separado).

**Verificação de tela antes do envio:** alvos de 48dp; fonte do sistema em 130% sem quebrar os itens da prévia; os dois botões visíveis em tela de 5" com o cartão da Black Friday aberto; resultado de B4 anunciado pelo TalkBack; importar e desfazer dentro de 5 min **com um ciclo de sync no meio** → os novos somem no aparelho e na nuvem, os atualizados ficam; desfazer depois de 5 min → cartão sumiu; rotação e ligação recebida durante a janela → cartão ainda lá; mesmo id de instalação em duas sessões → mesma variante e mesmo lado da flag; importar `.db` depois de dispensar B6 → supressão e variante preservadas.

## Decisões contra as críticas

- **Desfazer completo (7 dias)**: fora — schema, migração, imutabilidade de movimentação e conflito com a web. Fica o desfazer dos criados, por tempo.
- **`venda` como sinônimo de preço**: fora (costuma ser total da linha). **`valor` continua canônico** sem concorrência, senão o arquivo do próprio app não se reimporta.
- **Falha no Admin › Erros**: fora (teto de 30 da fila).
- **`ACTION_SEND`, modelo de planilha, paridade na web, heurística de código de barras por 8/12/13/14 dígitos, busca de cabeçalho em 10 linhas**: fora, cada um com o motivo no texto.
- **"Campo em foco ao sair" em D1**: fora, mediria ruído.
- **Meta de ativação 40% → 43%**: fora, não sai do ruído.
- **Linha de total: entrou** (v5). O corte da v4 estava errado — `name.isEmpty()` não pega "TOTAL GERAL" quando ele está na coluna de nome.
- **Cartão de três produtos**: substituído, não cortado — a prévia usa item de duas linhas com `contentDescription` em frase.
- **Mexer no formulário de produto**: fora, por decisão do dono. D2 propõe uma segunda porta, e mesmo assim só com aprovação.
