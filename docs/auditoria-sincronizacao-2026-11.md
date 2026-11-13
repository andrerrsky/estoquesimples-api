# Auditoria da sincronização — novembro de 2026

Pós-mortem do chamado #1005/#1006 (AM PORTAS AUTOMÁTICAS) e varredura completa
do motor de sincronização em busca de defeitos da mesma família.

## O que aconteceu

Cliente novo assinou o plano Equipe (R$ 199,90/ano) e reclamou que o estoque do
tablet não aparecia no site. No tablet, CENTRAL INTELIGENTE mostrava 12; na
nuvem, 5. Nenhum erro, nenhuma operação presa na fila, aparelho "em dia". Ele
pediu reembolso.

**Causa estrutural**: no aparelho a quantidade é um campo da linha do produto
(`Estoque.amount`); na nuvem o saldo é a soma das movimentações (regra 9). Os
dois lados ficam internamente coerentes e **nada compara um com o outro**.
Qualquer movimentação que exista num lado e não no outro vira divergência
permanente e silenciosa.

**Causa imediata**, segundo a varredura: a movimentação existe no tablet e nunca
entrou na fila de envio. Os dois caminhos que produzem isso estão nos achados
A5 e A6 abaixo. Nenhum caminho do app altera a quantidade sem gravar a
movimentação junto — essa hipótese foi descartada.

## Tentativa de correção que foi retirada

A versão 35 (PR #95) comparava, no aparelho, o saldo do produto com a soma do
histórico **local** e gravava o ajuste da diferença. Foi retirada da revisão da
Play antes de ser aprovada, por dois motivos descobertos na varredura:

1. A carga inicial grava `quantity_cache` com o valor declarado pelo aparelho
   (`initial-upload.service.ts:356`), com o gatilho desligado. Para uma empresa
   que migrou com o saldo certo e histórico incompleto — há uma cliente com
   1.190 produtos e 296 movimentações nessa situação — o ajuste seria somado
   por cima e **dobraria o estoque**.
2. Mesmo numa carga nova, o ajuste criado antes do envio pode cair na cauda que
   a paginação não envia (achado A6) e subir depois pela fila, agora com o
   gatilho ligado: saldo em dobro, recriando o defeito que a migration 0014
   corrigiu.

A correção certa compara o saldo local com **o que a nuvem informa**, não com a
soma local, e roda sempre que o servidor sinalizar divergência, não uma única
vez por instalação.

---

## Achados

Ordenados por gravidade. Todos foram sustentados por leitura de código; onde há
dúvida, está marcado como suspeita a testar.

### Grupo A — perda de dado do cliente

**A1. Trocar de empresa não reinicia o estado local; a fila de uma empresa é
enviada para a outra.**
`sync/SessionManager.java:290`, `AccountActivity.java:706`, `sync/SyncEngine.java:212`
O cursor, a marca de carga concluída e a fila moram no SQLite; a sessão mora nas
preferências, e só ela é limpa no logout. `SyncMeta.WORKSPACE_ID` nunca é
comparado com a empresa da sessão. Operações pendentes da empresa A sobem para a
B, e o aparelho passa a mostrar o estoque de A misturado com parte de B. O
próprio app instrui o usuário a fazer isso no aviso de convite ("saia da conta e
entre de novo escolhendo essa empresa"). **Confirmado.**

**A2. Recarga completa interrompida apaga o estoque local.**
`sync/SyncEngine.java:526-531`, `data/RemoteChanges.java:138-168`
A leitura para quando encontra um produto com operação pendente, mas a limpeza
de "produtos ausentes" roda sobre o catálogo inteiro mesmo assim. Basta um
produto em espera de nova tentativa para o aparelho marcar como excluídos os
centenas que ainda não foram lidos, com histórico junto. **Confirmado.**

**A3. Na mescla, produto local com nome igual ao da nuvem é descartado inteiro e
depois apagado do aparelho.**
`data/LocalMerge.java:99-104`, `data/RemoteChanges.java:368-409`
Nem o produto nem o histórico são enfileirados, e em seguida a limpeza os
exclui. Não há registro em `conflict_log`. A normalização ignora acentos, então
"Café" e "Cafe" — produtos legítimos diferentes — são tratados como repetidos.
Se a mescla falhar no meio, o chamador ignora o fracasso e apaga assim mesmo
(`LocalMerge.java:121-126`). **Confirmado.**

**A4. A compactação da fila reordena uma edição para antes de uma exclusão
pendente.**
`data/OutboxRepository.java:190-283`
Excluir um produto por engano e tocar em "Desfazer", tudo offline, faz a nuvem
receber edição e depois exclusão. O produto é excluído na nuvem e, no pull
seguinte, some também do aparelho. **Confirmado.**

### Grupo B — divergência silenciosa de saldo (a família do incidente)

**A5. Janela de abertura do app: movimentação gravada sem entrar na fila.**
`sync/SyncBootstrap.java:49-61`, `data/SyncGate.java:103`
A fila só é ligada depois de uma chamada HTTP a `/v1/config` (15 s de conexão +
30 s de leitura). Em rede ruim, tudo que o cliente registra nos primeiros
segundos fica fora da fila. O javadoc afirma que isso "é recuperável porque a
sincronização seguinte reenvia o estado atual do registro" — **isso é falso para
movimentações**, que nunca são revarridas. **Confirmado** (a frequência depende
da latência).

**A6. A carga inicial pagina por posição, não por keyset, e perde a cauda.**
`sync/InitialUpload.java:106-116, 191-208`
O total de lotes é fixado no início, mas o total de produtos é recalculado a
cada lote, e a fatia de movimentações é um `OFFSET` sobre a tabela viva.
Cadastrar um produto durante o envio desloca a fronteira e as últimas
movimentações nunca sobem. Elas são anteriores ao login, então não estão na fila
e ninguém as envia depois. Apontado de forma independente por três das cinco
frentes. **Confirmado.**

**A7. `seeded_at` é gravado sem conferir que tudo chegou.**
`apps/api/src/modules/sync/initial-upload.service.ts:243-280`
Só se verifica que os índices de lote são contíguos. A divergência de contagem é
calculada, devolvida na resposta e **ignorada pelo app**. A empresa é selada em
silêncio e `start()` passa a recusar nova carga. **Confirmado.**

**A8. Movimentação recusada pelo servidor fica aplicada no aparelho, para
sempre.**
`sync/SyncEngine.java:376-379`, `data/OutboxRepository.java:163-168`
Qualquer status que o app não reconheça vira falha permanente: a operação sai da
fila e a gravação local fica. Para produto é recuperável; para movimentação não
há reenvio nem reparo. Dois gatilhos reais:
- um **operador** tem `produtos.editar` mas não `movimentacoes.ajuste`; ao
  mudar a quantidade pela tela de edição, o produto é aceito e a movimentação
  recusada. O app não esconde o campo por papel;
- o servidor devolve "esta operação ainda está sendo processada, tente
  novamente" quando duas rodadas se cruzam — e o app mata a operação na hora.
**Confirmado.**

**A9. Restauração de cópia não envia movimentações de produto que a nuvem já
conhece.**
`data/LocalMerge.java:64-86`, `sync/SyncEngine.java:182-186`
A reconciliação só enfileira produtos ausentes da nuvem. O que a equipe fez pela
web sobrevive; o que só existe na cópia não sobe. **Confirmado.**

**A10. Ajuste absoluto da web contra fila offline do app produz um terceiro
valor.**
`apps/api/src/modules/inventory/inventory.service.ts` (`updateProduct`)
A web converte "o saldo agora é 94" numa diferença contra o saldo do momento. Se
o app tem lançamentos offline na fila, os dois se somam: ninguém quis o
resultado, e não há conflito registrado. **Confirmado.**

**A11. Ninguém confere `quantity_cache` contra a soma real.**
Migrations `0005:66-84`, `0007:414-430`
O gatilho é só `AFTER INSERT`: não há recálculo, rotina de conferência nem teste
que verifique essa invariante. É essa ausência que torna todos os outros
achados silenciosos — e a razão de o cliente ter descoberto antes de nós.
**Confirmado.**

### Grupo C — travamentos

**A12. Perder a resposta do `complete` trava o aparelho para sempre.**
`sync/SyncWorker.java:136-155`, `initial-upload.service.ts:508-523`
O app não conhece `SYNC_UPLOAD_ALREADY_COMPLETED`: reenvia todos os lotes a cada
15 minutos, recebe 409, nunca grava o cursor e nunca envia a fila. Só sai com
logout ou reinstalação. **Confirmado.**

**A13. Um produto preso na fila congela o cursor da empresa inteira.**
`data/RemoteChanges.java:195-197`, `data/OutboxRepository.java:363-365`
Qualquer pendência, inclusive em espera exponencial de horas, interrompe a
página. Nada mais desce, e a tela mostra "sincronizado". **Confirmado.**

**A14. Sessão de carga inicial nunca expira e bloqueia a escrita pela web.**
`inventory.service.ts:500-517`, migration `0004:152-160`
O status `abandonada` existe no CHECK e nunca é gravado. Combinado com A12, o
"tente de novo em instantes" pode ser para sempre. **Confirmado.**

### Grupo D — correções pontuais

**A15. Produtos homônimos são endereçados por nome.** `data/ProductRepository.java:45-56`
A busca devolve o mais antigo. A saída registrada em um é gravada no outro; no
ajuste em massa, um recebe o dobro e o outro nada. **Confirmado.**

**A16. Reimportar a planilha exportada funde homônimos.** `data/DataExchange.java:418-508`
A exportação não leva o identificador. Duas linhas resolvem para o mesmo
produto, e o segundo ajuste apaga o saldo do primeiro — de forma coerente nos
dois lados, portanto invisível. **Confirmado.**

**A17. Edição em massa da web não é idempotente.** `inventory.service.ts` (`bulk`)
Identificadores sorteados a cada requisição: um duplo clique aplica o ajuste
duas vezes. **Confirmado.**

**A18. O push não limita a data da movimentação.** `sync.service.ts:942`
A web limita, o push não. Um celular com a data adiantada estraga a coluna
"estoque depois" de todo o histórico do produto e tira a movimentação dos
relatórios por período. **Confirmado.**

**A19. `products.updated_at` nunca é atualizado na nuvem.** `schema/inventory.ts:56`
A coluna "Atualizado" mostra a data de criação, e o pull empurra esse valor por
cima da data local do aparelho. **Confirmado.**

**A20. Estorno duplo entre aparelhos.** `data/MovementRepository.java:404-451`
A proteção é a coluna `cancelled_at`, que não viaja, e não há índice único em
`reverses_movement_id`. Dois aparelhos podem estornar a mesma movimentação.
**Confirmado.**

**A21. Carga inicial não grava `intended_product_id`.** `initial-upload.service.ts:420-440`
A adoção de movimentação órfã que o push ganhou na migration 0025 não existe
aqui. Já houve incidente desse tipo: existe
`apps/api/scripts/reparar-movimentacoes-orfas.ts`. **Confirmado.**

**A22. A web monta o payload com todos os campos, sempre.** `inventory.service.ts:571-589`
O preço de custo sobrevive hoje porque o valor vem da linha travada dentro da
transação — a proteção é o lock, não a convenção "ausente = não mexi". Qualquer
caminho futuro que monte o payload a partir do formulário apaga o custo em
silêncio. A guarda de campo ausente em `mesclarProduto:589` existe só para
`unitCost`, não para `photoHash`. **Confirmado.**

**A23. Arredondamento assimétrico do ajuste absoluto.** `MovementRepository.java:211`
O app manda a diferença em precisão dupla cheia; a web arredonda a 4 casas. Em
unidades fracionárias, os dois lados se afastam uma casa por ajuste.
**Confirmado.**

**A24. Inconsistência entre as três consultas de saldo do app.**
`OpeningBalance.java:81-87` soma movimentações excluídas; `Diagnostics.java:163`
e `LocalMerge.java:144` filtram. Dão números diferentes para o mesmo aparelho.
**Confirmado.**

---

## Por que ninguém percebeu

Não existe, em nenhum lugar, uma comparação entre o saldo guardado e a soma das
movimentações. Dentro da nuvem a coerência é total: lista, detalhe, relatórios,
análise, exportação e painel leem todos `quantity_cache`. Quando o cache erra,
todos erram junto e nada contradiz nada. O app tem
`Diagnostics.collectBalanceMismatches`, que detecta isso — mas só alimenta o
diagnóstico anexado a um chamado, ou seja, depois da reclamação.

## Plano de correção

### Onda 0 — enxergar o problema (servidor, sem depender da loja)

1. Job diário `sync.balance_audit`: compara `quantity_cache` com a soma real por
   produto, ignorando o que veio da carga inicial (mesmo critério da migration
   0014), e grava o resultado por empresa.
2. Faixa na página da empresa do painel, aba Sincronização: "N produtos com
   saldo divergente do histórico", com coluna "histórico" ao lado de
   "quantidade" na aba Estoque.
3. Alerta de operações recusadas nas últimas 24 h: recusa de **movimentação**
   significa, sem exceção, que algum aparelho mostra um saldo que a nuvem não
   tem. O dado já existe em `sync_operations`.
4. Evento `sync.balance_mismatch` para a série temporal, que diz se a
   divergência é resíduo histórico ou se continua nascendo.

### Onda 1 — parar a perda de dado (app)

A1 (troca de empresa), A2 (recarga interrompida), A3 (mescla que descarta),
A4 (compactação × exclusão). São os quatro caminhos em que o cliente perde
estoque sem aviso.

### Onda 2 — fechar a divergência de saldo

A5 (ligar a fila sem depender de rede), A6 e A7 (paginação por keyset e
conferência no `complete`), A8 (tratar recusa de movimentação), A9
(reconciliação completa), A10 (ajuste absoluto com saldo de base), e a v35
refeita: comparar com o saldo que a nuvem informa, sempre que o servidor
sinalizar divergência.

### Onda 3 — destravar

A12, A13, A14.

### Onda 4 — pontuais e testes

A15 a A24, mais as lacunas de teste abaixo.

## Lacunas de teste

1. **Nenhum teste verifica que `quantity_cache` bate com a soma das
   movimentações** — a invariante central nunca é checada como invariante.
2. Carga inicial e fila incremental não são testadas juntas.
3. Movimentação órfã adotada num lote posterior.
4. Paginação com produto numa página e movimentações na seguinte.
5. Reenvio depois da limpeza de `sync_operations`.
6. Data retroativa ou futura: efeito no saldo, no extrato e nos relatórios.
7. Concorrência real (dois pushes com o mesmo `opId`, push e pull cruzados).
8. **Nada testa o motor do lado Android** — não há cobertura de `LocalMerge`,
   `RemoteChanges`, `SyncEngine` nem `OutboxRepository`, e é justamente onde
   moram os achados mais graves.
9. Duplo clique na edição em massa da web.

## O que já está bem resolvido

Vale registrar, porque reduz o escopo do medo:

- Idempotência por `opId`, com o resultado original preservado no replay, e uma
  segunda camada pelo identificador da movimentação que sobrevive à limpeza.
- A operação de fila é gravada na mesma transação da alteração local, e os
  repositórios desfazem tudo se o enfileiramento falhar.
- A conta do saldo no pull (`posteriores`) está correta, inclusive com produto
  criado e movimentado no mesmo lote.
- O contrato de campos protege o preço de custo contra apps antigos, nos dois
  caminhos (rápido e de mescla).
- A conversão de sinal acontece no aparelho e o servidor só soma; não há o caso
  "12,5 virar 125".
- Exclusão é sempre lógica, com cópia de segurança antes de qualquer remoção em
  massa.
- A fila não trava com uma operação recusada: o lote seguinte anda.
