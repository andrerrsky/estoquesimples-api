# Aquisição e conversão (Google Ads + GA4)

Como o site mede quem vê e clica nos anúncios, chega ao site, cria conta e
começa a usar o produto, o que o código garante, o que depende de
configuração na interface do Google e como ler os números sem contar duas
vezes nem inventar atribuição. Contrato geral do analytics em
[analytics.md](analytics.md).

## 1. O funil e onde cada número mora

| Etapa | Onde se mede | Evento / métrica | Fonte da verdade |
| --- | --- | --- | --- |
| Anúncio exibido | Google Ads | Impressões | Google Ads |
| Clique no anúncio | Google Ads | Cliques, CTR, custo | Google Ads |
| Chegada ao site | GA4 (com consentimento) | `page_view` / sessões com origem `google / cpc` | GA4 |
| Clique em "Criar conta" | GA4 | `cta_criar_conta` com `location` (`menu`, `hero`, `plataformas`, `planos`, `cta_final`) e `page` | GA4 |
| Início do cadastro | GA4 + analytics próprio | `signup_started` (abriu /criar-conta) | GA4 |
| Cadastro concluído | GA4 → importado no Ads | `sign_up` (uma vez por cadastro confirmado pela API) | Contagem total: painel próprio (`user.registered`). Atribuído ao anúncio: Google Ads |
| Ativação (observação) | GA4 | `product_first_created` (primeiro produto que a empresa já teve) | GA4; não é conversão |

Conversão no Google Ads: **apenas** a ação importada
“estoque-simples-f3604 (web) sign_up” (Inscrição, principal, contagem
“Uma”). `signup_completed` é o espelho do evento próprio, representa o mesmo
cadastro e **não** deve virar evento principal no GA4 nem conversão no Ads.

## 2. Auditoria (novembro de 2026)

### Já funcionava

- **Google tag única**: `gtag.js` injetado por `apps/web/src/lib/ga.ts`
  (`G-V6S41QGPMS`), uma vez por página, nas duas entradas (página inicial
  `landing-main.tsx` e aplicação `App.tsx`). Não há GTM nem segunda tag.
- **Consentimento**: o script só é baixado depois de "Aceitar"
  (`CookieConsent`); sinais do Google e personalização de anúncios
  desligados; `ad_storage`, `ad_user_data` e `ad_personalization` negados.
- **`sign_up`**: sai de `register()` só depois de a API responder com
  sucesso; erro lança antes do evento; login (`auth.login` → `login`) e
  recarregar a página não emitem cadastro. O botão fica desabilitado durante o
  envio, então não há duplo envio.
- **Cliques nos CTAs** e vídeo da página inicial já eram medidos por um
  ouvinte único (`installGaClickTracking`).
- **Sem dados pessoais**: nada de e-mail, nome, ids de pessoa/empresa ou
  conteúdo de estoque nos parâmetros.

### O que estava errado e foi corrigido

1. **A origem dos anúncios se perdia.** O `page_location` enviado ao GA
   removia toda a query string (para não vazar `?token=` de links de e-mail),
   e com ela os UTMs e o `gclid`. O GA4 classificaria a visita sem a campanha,
   e o Google Ads não conseguiria ligar o `sign_up` ao clique. Agora vão
   **só** os parâmetros de uma lista fechada (UTMs, `gclid`, `gbraid`,
   `wbraid`), com valores curtos e sem `@`; o resto continua fora.
2. **Aceite depois de sair da página inicial.** A página inicial e a
   aplicação são páginas separadas: quem chegava pelo anúncio e só aceitava os
   cookies em /criar-conta perdia a campanha (a URL já não tinha os UTMs).
   Os parâmetros permitidos ficam guardados na aba (`sessionStorage`,
   `es_campanha`) e entram **uma vez** na primeira carga do GA. Nada é enviado
   sem aceite; recusar apaga; fechar a aba apaga.
3. **Revogação não parava o envio.** Depois de aceitar e recusar na mesma
   página, os eventos continuavam chegando ao gtag (e o gtag manda pings sem
   cookie com `analytics_storage` negado). Agora a recusa liga
   `ga-disable-G-V6S41QGPMS` e o `gaEvent` não chama mais o gtag.
4. **Localização ambígua do clique em "Criar conta".** Os botões do topo da
   página e da chamada final saíam como `pagina`. Agora: `menu`, `hero` e
   `cta_final` (atributo `data-ga-local`).
5. **Referenciador com query string.** O gtag envia `document.referrer`
   inteiro (`dr`); um parâmetro da página anterior iria ao Google. Agora vai
   `page_referrer` com origem e caminho só.
6. **Evento ao montar a tela se perdia.** O React roda os efeitos dos filhos
   antes dos do pai: o `signup.started` de /criar-conta chegava ao `gaEvent`
   antes de o App carregar o GA e era descartado em toda carga direta da
   página. O `gaEvent` agora inicia o GA quando há aceite.
7. **Sem sinal de ativação.** A API passou a responder `firstProduct` no
   cadastro de produto pela web, e a web envia `product_first_created` só
   nesse caso.

### Configuração verificada na conta do Google Ads (271-634-1302)

Conferido em 6/11/2026, somente leitura:

- **Codificação automática: Sim** (Administrador › Configurações da conta).
- Ação “estoque-simples-f3604 (web) sign_up”: origem Site (GA4), principal,
  contagem “Uma”, janela de clique de 90 dias, “Não há conversões recentes”.
- **Atenção — “Incluídas nas metas da conta: Não”.** A ação é principal, mas
  a meta dela (Inscrições) não está entre as metas padrão da conta. Assim ela
  **só aparece na coluna “Conversões” e só orienta lances** se a campanha
  usar explicitamente essa meta (Configurações da campanha › Metas). Ao
  terminar o rascunho, confira que a campanha usa “Inscrições” (ou torne a
  meta padrão da conta, em Metas › Resumo). Decisão do proprietário; nada foi
  alterado.
- Também existem duas ações do YouTube marcadas como principais (inscrições
  no canal e visualizações seguintes), também fora das metas da conta. Se a
  campanha de vídeo usar essas metas, elas somam na coluna “Conversões” junto
  com cadastros. Para comparar custo por cadastro, segmente por ação de
  conversão (seção 6).
- **Fuso horário da conta: GMT-06:00 (Horário Central)**, não o de Brasília.
  Os dias no Ads e no GA4 não batem nas bordas (cadastro às 23h em Brasília já
  é outro dia em um dos dois). O fuso de uma conta do Ads não muda depois de
  criado; compare semanas, não dias.
- Rascunho “Estoque Simples | Display | 3 conceitos” (conferido em
  6/11/2026, sem alterar): meta **Inscrições**, lances **Maximizar
  conversões**, R$ 15,60/dia, Brasil, português, segmentação otimizada,
  6 anúncios responsivos. Está preparado para otimizar por cadastros; sem
  histórico de conversões, o lance passa por aprendizado. URLs finais dos
  anúncios não foram abertas.

## 3. Consentimento: o que ele custa nos números

- **Quem recusa ou não escolhe não aparece no GA4**: nem visita, nem clique,
  nem `sign_up`. Etapas anteriores ao aceite também não (quem clica em "Criar
  conta" antes de responder o aviso não tem esse clique registrado). O total
  real de cadastros está no painel administrativo (`user.registered`), que é
  o analytics próprio, dentro da Política.
- **Conversões no Google Ads ficavam em zero.** Até 7/11/2026 o site negava
  `ad_storage` e `ad_user_data` mesmo para quem aceitava os cookies, e o GA4
  respeita esse sinal: não repassa a conversão ao Ads. Foi a causa do aviso
  “A configuração do acompanhamento de conversões está incompleta” no
  primeiro dia do Display. Desde o aviso **v2** (seção 9), quem aceita libera
  `ad_storage` e `ad_user_data`; `ad_personalization` e Google Signals
  continuam desligados. Quem aceitou o texto antigo continua só com análise e
  vê o aviso de novo.
- **Bloqueadores** (uBlock, Brave, Safari com proteção avançada) impedem o
  `gtag.js` mesmo com aceite. Não há coleta alternativa, de propósito.
- **Janelas de atribuição**: o Ads credita o cadastro ao clique se ele
  acontecer em até 90 dias (janela da ação) e lança a conversão **na data do
  clique**; números de dias passados podem subir depois. O GA4 usa o modelo e
  a janela de Administrador › Atribuição (padrão: baseado em dados; 30 dias
  para eventos de aquisição).
- **Atrasos**: DebugView e Tempo real em segundos; relatórios padrão do GA4
  em até 24–48 h; conversões importadas no Ads costumam levar algumas horas e
  podem levar mais de um dia para aparecer.

### Política de Privacidade

Atualizada em 7/11/2026 (seção 5): medição de anúncios com aceite e origem
do cadastro por legítimo interesse. Ver a seção 9.

## 4. Separar testes e equipe sem tirar ninguém de verdade

- **Estado verificado em 6/11/2026**: existe só o filtro “Internal Traffic”,
  em **Teste** (eventos internos entram nos relatórios, marcados).
- **Navegadores da equipe**: abra uma vez `https://estoquesimples.com.br/?es_interno=1`
  em cada navegador da equipe. Todos os eventos dele passam a sair com
  `traffic_type: internal` (o painel administrativo já faz isso sempre).
  `?es_interno=0` desfaz. Não depende de IP, então funciona em casa e no 4G.
- **No GA4** (configuração manual): Administrador › Coleta e modificação de
  dados › Filtros de dados › “Internal Traffic”. Deixe em **Em teste**
  primeiro (aparece a dimensão “Nome do filtro de teste” para comparar) e só
  depois mude para **Ativo** — filtro ativo descarta os dados de vez.
  Opcionalmente defina também regras de IP fixo em Fluxos de dados › Web ›
  Configurar definições da tag › Definir tráfego interno.
- **Testes**: `?es_debug=1` (fica na aba, `sessionStorage`) manda
  `debug_mode: true` na configuração. **Verificado em 6/11/2026: na versão
  atual do gtag isso sai como parâmetro comum (`ep.debug_mode=true`), sem o
  sinal `_dbg=1`, e o aparelho não aparece no DebugView.** Para ver no
  DebugView use o [Tag Assistant](https://tagassistant.google.com) (ele liga
  o modo de depuração sozinho). A propriedade não tem filtro “Developer
  Traffic”, então eventos de teste entram nos relatórios; o que os separa é o
  `traffic_type: internal` (`?es_interno=1`).
- **Contas de teste**: use e-mails de teste próprios (ex.:
  `teste+ads1@seu-dominio`) e anote-os; no painel administrativo dá para
  excluir a conta depois. Nunca use dados de clientes.
- Nada disso filtra usuários reais: só navegadores marcados de propósito.

## 5. Roteiro de validação manual (Tag Assistant + DebugView)

Não clique em anúncios reais nem gere tráfego pago. Use UTMs fictícias.

1. Abra o [Tag Assistant](https://tagassistant.google.com), “Adicionar
   domínio”, e informe:
   `https://estoquesimples.com.br/?utm_source=google&utm_medium=cpc&utm_campaign=teste_validacao&utm_content=anuncio_teste&es_interno=1&es_debug=1`
   (sem `gclid`: um `gclid` inventado não corresponde a clique nenhum).
2. **Antes de aceitar**: no Tag Assistant não deve aparecer a tag
   `G-V6S41QGPMS` nem hits. Em DevTools › Rede, filtro `google`: nada.
3. Clique em **Aceitar** no aviso. A tag aparece; o primeiro `page_view`
   mostra `page_location` com os UTMs e **sem** `es_interno`, `es_debug` ou
   qualquer outro parâmetro.
4. Clique em **Criar conta grátis** no topo da página: evento
   `cta_criar_conta` com `location = hero` (ou `menu`, no botão do cabeçalho).
5. Em /criar-conta: `page_view` e `signup_started`.
6. Crie a conta com um e-mail de teste: exatamente **um** `sign_up`
   (`method = email`) e um `signup_completed`. Nenhum parâmetro com nome ou
   e-mail.
7. Crie a empresa e cadastre o primeiro produto: `product_created` e
   `product_first_created`. Cadastre um segundo: só `product_created`.
8. No GA4 › Administrador › DebugView, escolha o aparelho e confira a mesma
   sequência e os parâmetros (`traffic_type = internal`, `debug_mode`).
9. Saia, entre de novo: `login`, nunca `sign_up`. Recarregue a página: nada
   de `sign_up`.
10. **Recusado**: janela anônima, mesma URL, **Recusar**. Nenhuma tag, nenhum
    hit, nenhum pedido a `google-analytics.com`; o cadastro funciona igual.
11. **Revogado**: com a sessão aceita, abra “Preferências de cookies” (rodapé
    ou Minha conta), **Recusar**, e continue navegando: nenhum hit novo.
12. **Aceite tardio**: janela anônima, URL com UTMs, clique em “Criar conta”
    **sem** responder o aviso, e só aceite em /criar-conta: o `page_view` de
    /criar-conta leva os UTMs da página de entrada.

Tempo real × DebugView: a propriedade `estoque-simples-f3604` recebe também
o **app Android** (Firebase), que envia o próprio `sign_up` (e `first_open`,
também evento principal). Um `sign_up` no Tempo real pode ser do app ou de
outra pessoa; filtre por fluxo/plataforma “Web”. A conversão do Ads
“(web) sign_up” só conta o fluxo web.

O que isso prova e o que não prova: ver o evento no DebugView confirma que
ele chegou ao GA4 com os parâmetros certos. **Não** prova que um cadastro
será atribuído a um clique real no Ads: isso só se vê com cliques reais
(com `gclid` gerado pelo Google), dentro da janela de atribuição e depois do
atraso da importação.

### Conferir a conversão no GA4 e no Ads

- GA4 › Administrador › Eventos (ou “Eventos principais”): `sign_up` marcado
  como evento principal; `signup_completed` e `product_first_created`
  **não** marcados.
- Google Ads › Metas › Conversões › Resumo › “Ver todas as ações de
  conversão”: linha “estoque-simples-f3604 (web) sign_up”, origem Site (GA4),
  principal, contagem “Uma”. O status passa de “Não há conversões recentes”
  para “Gravando conversões” só depois de cadastros vindos de cliques reais
  (pode levar mais de um dia). Confira também “Incluídas nas metas da conta”
  ou as metas da campanha (seção 2).

## 6. Como consultar os números

### Google Ads (anúncio, clique, custo, conversão)

1. **Campanhas**: escolha o período no canto superior direito. Colunas:
   Impr., Cliques, CTR, Custo, Conversões, Custo/conv. Se faltar alguma,
   Colunas › Modificar colunas › Desempenho e Conversões.
2. **Os seis anúncios**: entre na campanha › **Anúncios**. Cada linha é um
   anúncio, com as mesmas colunas. Compare CTR (atração) e Custo/conv.
   (eficiência); com poucas conversões, prefira olhar CTR e cliques até
   juntar volume.
3. **Só cadastros**: Segmentar › Conversões › Ação de conversão. Mostra a
   coluna Conversões separada por ação, para o `sign_up` não se misturar com
   ações do YouTube.
4. “Conversões” = só ações principais nas metas usadas pela campanha. “Todas
   as conv.” inclui secundárias. Conversões entram na data do clique.

### GA4 (visita e comportamento no site)

1. Relatórios › Aquisição › **Aquisição de tráfego**. Dimensão principal
   “Origem/mídia da sessão”; procure `google / cpc`. Troque para
   “Campanha da sessão” para comparar campanhas e, no “+”, adicione
   “Conteúdo do anúncio manual da sessão” (o `utm_content`) para comparar os
   seis anúncios. Colunas úteis: Sessões, Usuários, Eventos principais
   (`sign_up`), Taxa de eventos principais.
2. Relatórios › Engajamento › **Eventos**: contagem de `cta_criar_conta`,
   `signup_started`, `sign_up`, `product_first_created`. Clique no evento
   para ver parâmetros (`location` do CTA).
3. Funil: Explorar › **Exploração de funil**, etapas `page_view` (página `/`)
   → `cta_criar_conta` → `signup_started` → `sign_up` →
   `product_first_created`, com segmento “Origem/mídia da sessão =
   google / cpc”.
4. Para tirar a equipe: filtro “Internal Traffic” ativo (seção 4) ou, antes
   disso, compare com a dimensão de filtro de teste.

### Por que os números não batem (e não devem bater)

- **Cliques no anúncio (Ads) > sessões google / cpc (GA4)**: quem fecha a
  página antes de carregar, quem recusa cookies, bloqueadores, cliques
  inválidos filtrados pelo Google.
- **Cadastros totais (painel próprio) > `sign_up` no GA4**: o painel conta
  todo cadastro (web e app); o GA4 só os de quem aceitou cookies no site.
- **`sign_up` em google / cpc (GA4) ≠ Conversões (Ads)**: modelos e janelas
  de atribuição diferentes, data do clique × data do cadastro, fuso diferente
  e possível limitação pelos sinais de anúncios negados (seção 3).
- Nunca some `sign_up` com `signup_completed`: são o mesmo cadastro.

## 7. Primeiro produto como meta

> Substituído pela seção 9: a ativação vai ao Ads por importação offline
> (lida do banco, vale para web e app), não pelo evento do GA4.



`product_first_created` é um bom indicador de ativação (a pessoa passou do
cadastro ao uso). Proposta: deixá-lo como evento de **observação** por
algumas semanas, compará-lo por campanha e anúncio no GA4 e só então, se o
proprietário decidir, marcá-lo como evento principal no GA4 e importá-lo no
Ads como ação **secundária** (não entra em lances). Torná-lo meta de lance é
decisão posterior, com volume suficiente. Limitações: produtos importados
por planilha e produtos criados no app Android não disparam o evento na web
(o primeiro cadastro pela web depois deles já não é o primeiro).

## 8. Passos manuais pendentes (interface do Google)

- [ ] Conferir as metas da campanha nova (Inscrições) ou a inclusão da ação
      `sign_up` nas metas da conta.
- [ ] GA4: `signup_completed` e `product_first_created` não marcados como
      eventos principais.
- [ ] GA4: medição otimizada ligada (visualizações de página por histórico).
- [ ] GA4: filtro “Internal Traffic” em teste → ativo; abrir
      `?es_interno=1` nos navegadores da equipe.
- [ ] URLs finais dos seis anúncios com `utm_source=google&utm_medium=cpc`,
      `utm_campaign` e `utm_content` distintos; sem modelo de acompanhamento
      que remova o `gclid`.
- [ ] Depois dos primeiros cliques reais: comparar GA4 × Ads (seção 3).

Não alterado: publicidade personalizada, faturamento, orçamento, estado de
publicação da campanha, ações de conversão.

## 9. Plano depois do primeiro dia do Display (7/11/2026)

### Diagnóstico

1. **Medição.** O Ads recebia conversão só pelo GA4, e o GA4 não repassava
   nada (seção 3). Com 0 conversões, "Maximizar conversões" otimizava no
   escuro.
2. **Tráfego.** Num dia: 115 cliques, CTR de 7,6% e CPC de R$ 0,14. 98% dos
   cliques vieram de celular, em 97 posicionamentos de apps e sites de
   APK/jogos (CTR de até 300%), ou seja, cliques acidentais. A campanha não
   tinha nenhum segmento de público.
3. **Funil.** Na janela logo após o início: 13 aberturas de /criar-conta,
   3 cadastros, 1 empresa e 0 produtos. Com n=3 não se calcula taxa; serve só
   para achar atrito. Dois dos três pararam em "dê um nome à sua empresa".

Já feito no Ads (reversível, sem mexer em orçamento):
- exclusões de conteúdo na campanha (abaixo da dobra, não classificado,
  sensível);
- na conta (Adequação do conteúdo), 204 canais excluídos: as 140 categorias
  de apps do Google Play e da App Store, além de 64 sites do relatório.

### Medição: fonte única da ação principal

- **Ação principal no Ads: "Ativação (offline)"** (importação de cliques,
  contagem Uma, janela de 30 dias, modelo baseado em dados).
  - Origem: Painel › Usuários › "Ativações para o Google Ads (CSV)"
    (`GET /admin/api/ads/offline-conversions.csv?days=7`, só owner).
  - Entra no CSV quem tem `gclid` gravado no cadastro, aceitou o aviso
    **v2** (`consent = v2_accepted`, atualizado se a pessoa mudar a escolha
    logada) e criou o primeiro produto há mais de 6 horas.
  - Horário: o do produto, em `-03:00`. Valor: R$ 12.
- **`sign_up` (GA4):** vira ação **secundária**.
- **`product_first_created`:** **não** vira ação no Ads, para não contar a
  mesma ativação duas vezes.
- **Origem própria (sem cookie):** `lib/attribution.ts` guarda na aba a
  primeira campanha e a envia no cadastro.
  - A API grava em `users.signup_attribution`, que aparece no painel
    (coluna Origem) e nas UTMs de `user.registered`.
  - `landing.viewed` registra a chegada ao site sem depender do aviso de
    cookies.
  - O gclid nunca vai para eventos nem logs.

Checklist da importação offline:
- [ ] Criar a ação "Ativação (offline)" **≥ 24 h antes** de publicar a
      Pesquisa (cliques anteriores à ação são rejeitados).
- [ ] **Upload programado** (sem trabalho manual): Ferramentas › Uploads ›
      Programações › origem **HTTPS**, URL
      `https://api.estoquesimples.com.br/v1/ads/offline-conversions.csv`,
      usuário `googleads`, senha = `ADS_UPLOAD_PASSWORD` do Railway (sem a
      variável o endereço responde 404), 1×/dia. O arquivo traz os últimos
      7 dias; o Google ignora a conversão repetida (mesmo gclid e ação).
      Alternativa manual: o botão do painel. No dia seguinte ao primeiro
      upload real, conferir os erros nos detalhes do upload.
- [ ] gbraid/wbraid ficam fora do CSV (exigem a API); a limitação está
      declarada e eles ficam gravados para depois.
- [ ] A conta está em GMT-06:00 e o fuso não muda. O CSV leva offset
      explícito, mas o relatório diário do Ads fica 3 h deslocado do painel.

### Funil (no mesmo PR, antes do lançamento da Pesquisa)

- **Empresa automática** no cadastro web ("Minha empresa", renomeável); a
  pessoa cai direto no estoque.
- **Um e-mail** depois de 24 h para quem não tem produto
  (`onboarding.first_product_nudge`, evento `onboarding.nudge_sent`).
- **Textos por segmento** (`utm_content`): título da página inicial e dica do
  estoque vazio para salao, roupas, mercearia, cosmeticos e planilha.
- **Congelamento:** depois do lançamento, nada muda no funil até o dia 30
  (login com Google etc. ficam para depois). Toda exceção é anotada aqui, com
  data.
- **CTA no celular durante o teste:** cadastro web, que é medido. A Play Store
  segue como secundária.

### Economia e critérios de decisão

Premissas (a revisar no dia 30):
- Plano Equipe: ~R$ 22/mês líquido; vida média de 8 meses, então LTV ≈ R$ 175.
- 5–8% dos ativados assinam. Uma ativação vale ≈ R$ 9–14.

Metas:
- CAC por pagante ≤ R$ 175.
- CPA de ativação: alvo ≤ R$ 15, aceito até R$ 30 nos primeiros 30 dias.

Regras:
- **CPA e contagem de ativações saem do painel**, por `utm_campaign`.
  - O Ads só vê quem aceitou o aviso v2, então mostra menos ativações.
  - Registre a cobertura (Ads ÷ painel) a partir do dia 7.
- **Lance da Pesquisa:**
  - Maximizar cliques com CPC máximo de R$ 2,50.
  - Passar para Maximizar conversões quando houver ~15 ativações em 30 dias
    no painel **e** ≥ 10–15 recebidas pelo Ads.
  - tCPA fica fora do horizonte.
- **Dia 7** (só com ≥ 50 cliques):
  - CTR ≥ 5%;
  - ≥ 70% dos termos de pesquisa relevantes;
  - landing.viewed → signup.started ≥ 15%;
  - cadastro → empresa ≥ 80%.
- **Dia 14:** cadastro → 1º produto ≥ 30%. Se falhar, mexer em landing ou
  onboarding antes do lance.
- **Dia 30 ou R$ 450:** decidir por CPA de ativação e qualidade (% de
  ativados com ≥ 10 produtos ou ativos em 3+ dias).
  - CPA ≤ R$ 30: seguir.
  - R$ 30–60: revisar por 15 dias.
  - Acima de R$ 60 ou 0 ativações: pausar.
- **Assinaturas:** por coorte de origem em 60 e 90 dias (CAC por pagante ×
  R$ 175). Não decidem nada no dia 30.

### Campanha de Pesquisa (rascunho; publicar só depois do QA)

- **Configuração:**
  - só Rede de Pesquisa, sem parceiros e sem Display;
  - Brasil por **presença**, português;
  - públicos em **Observação**: pequenas empresas, varejo, beleza.
- **Grupos (frase/exata):**
  - *Genérico:* app controle de estoque, aplicativo controle de estoque,
    controle de estoque grátis, controle de estoque pelo celular, sistema de
    estoque simples, programa de estoque para pequena empresa.
  - *Nichos:* estoque para salão de beleza, loja de roupas,
    mercearia/mercadinho, loja de cosméticos.
  - *Planilha:* planilha controle de estoque, planilha de estoque grátis.
    - CPC máximo R$ 1,20 e `utm_content=planilha`.
    - Pausar se o CPA do grupo no dia 14 for maior que o dobro da média.
- **Negativas:** curso, aula, apostila, tcc, vaga, emprego, sap, totvs, erp,
  sped, nota fiscal, contabilidade, almoxarifado, farmácia hospitalar, o que
  é, conceito, crack, pirata, modelo pdf, gratis download ("excel" em
  observação). Revisar os termos a cada 2–3 dias na 1ª semana.
- **Anúncios RSA:**
  - 12–15 títulos, com 2–3 variantes fixadas por posição;
  - URL com `utm_source=google&utm_medium=cpc&utm_campaign=pesquisa_estoque`
    e `utm_content` por grupo.
- **Recursos de anúncio:**
  - sitelinks: Comece grátis, App Android, Importar planilha, Plano Equipe;
  - frases de destaque;
  - snippets de tipos de negócio.
- **Antes de publicar:**
  - Planejador de palavras-chave (volume e CPC);
  - SPF/DKIM/DMARC do remetente de e-mail;
  - ação offline criada há ≥ 24 h.

### QA de ponta a ponta (antes de publicar)

1. No celular, abrir
   `/?gclid=TESTE_QA&utm_source=google&utm_medium=cpc&utm_campaign=qa&utm_content=salao`
   **sem aceitar** cookies: o título fala de salão e `landing.viewed`
   aparece no painel com `has_click_id=true`.
2. Cadastrar: a empresa é criada sozinha, a pessoa cai no estoque com a dica
   de salão e o painel mostra a Origem `google / cpc · qa · salao`.
3. Recusar cookies → cadastrar → criar produto: **não** aparece no CSV.
   Aceitar → cadastrar → criar produto → esperar 6 h: aparece; validar no Ads
   com "pré-visualizar", sem aplicar.
4. E-mail de 24 h: testar localmente adiantando `run_at` do job.
5. GA4 DebugView: depois de aceitar, `gcs` com `ad_storage` concedido.
   Diagnóstico de conversões do Ads em 48 h.

### Follow-ups (fora deste PR)

- App Android: ler a Install Referrer API e enviar UTMs e gclid no cadastro
  do app para o mesmo `signup_attribution`.
- Login com Google (depois do dia 30).
- Página "modelo de planilha" para o grupo Planilha.
- Envio automático do CSV (Sheets agendado ou API do Google Ads, que cobre
  gbraid/wbraid).
