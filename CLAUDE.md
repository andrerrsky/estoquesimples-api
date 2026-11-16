# CLAUDE.md — leia isto antes de procurar no código

Este arquivo existe para responder rápido, sem varredura. **Antes de usar
grep, find ou abrir arquivos de código para responder uma pergunta, procure a
resposta aqui e no mapa da seção 3.** Quase toda pergunta de produto, plano,
preço ou atendimento já está escrita em algum documento; achar o documento
custa uma leitura, redescobrir no código custa dezenas.

Ordem de busca, sempre nesta ordem:

1. **Esta página** (fatos de bolso, seção 2).
2. **O mapa da seção 3** → abra o documento indicado.
3. **[AGENTS.md](AGENTS.md)** (504 linhas) para arquitetura, regras de negócio
   e decisões — a referência profunda, para quando se vai *alterar* o sistema.
4. Só então o código.

O caminho 1–3 responde a maioria das perguntas. Ir direto ao código é o
caminho mais caro e o mais sujeito a erro: o código mostra o mecanismo, não a
decisão nem o número em vigor.

Responda sempre em **português do Brasil**.

---

## 1. O que é o sistema, em cinco linhas

Controle de estoque para pequenos negócios. Monorepo com quatro aplicações
sobre uma API só: app **Android** (Java, offline-first, funciona inteiro sem
internet), aplicação **web** (React), **API** (Fastify + Postgres + Drizzle) e
**painel administrativo**. API, painel e web são um único serviço no Railway;
o app Android é independente e fala com `https://api.estoquesimples.com.br`.
As regras de negócio vivem **só** na API.

| | |
| --- | --- |
| Site | https://estoquesimples.com.br |
| API | https://api.estoquesimples.com.br |
| Painel | https://api.estoquesimples.com.br/admin |
| Play | `br.com.gameloop.estoquesimples` |
| Deploy | Railway, automático ao mesclar em `main` |

## 2. Fatos de bolso (conferidos em 15/11/2026)

Estes são os números que mais aparecem em pergunta de cliente. Se precisar de
detalhe ou da regra de aplicação, o documento é [docs/plans.md](docs/plans.md).

### Planos

São **dois**, e o pago chama-se **Equipe** (chave `basico`). **Não existe
"Pro"** — houve uma "Versão PRO" antiga, comprada uma vez dentro do app, que
hoje só libera a Análise Avançada no aparelho de quem já tinha. Clientes
costumam dizer "plano pró" querendo dizer Equipe.

| | Gratuito (com conta) | **Equipe** (assinatura) |
| --- | --- | --- |
| Nuvem | sim, **só o proprietário** | sim, toda a equipe |
| Produtos na nuvem | até **50** | **sem limite** |
| **Pessoas na empresa** | só o proprietário (1) | **sem limite, e não se cobra por pessoa** |
| Análise Avançada | não | sim |
| **Conferência de estoque** | **3 por mês**, completas | ilimitadas, com histórico |
| Fotos (por empresa) | 100 MB | 5.000 MB |
| Identidade visual | não | sim |
| Histórico, relatórios, importação, exportação, backup | iguais nos dois, no aparelho | |

> **Sem limite de pessoas** é o argumento comercial mais forte que temos e o
> menos divulgado. Vale dizer em toda conversa sobre equipe.

Os números não estão no código: são linhas de `plan_features`, editáveis em
**Painel › Planos** sem deploy. Para conferir o valor em vigor, a fonte da
verdade é essa tela — não o código.

### Preços

| Canal | Como se cobra | Valor |
| --- | --- | --- |
| App Android | Google Play (`assinatura` / `plano-basico`) | definido no Play Console; oferta de entrada R$ 19,99/mês nos 2 primeiros meses |
| Web (`/app/plano`) | Asaas (Pix, boleto, cartão) | Mensal **R$ 24,99** · Semestral **R$ 129,90** (R$ 21,65/mês) · Anual **R$ 199,90** (R$ 16,65/mês) |

A assinatura é **da empresa** e vale nos dois clientes, qualquer que seja o
canal de compra.

### Quem é a base (medido no painel em 15/11/2026)

32 empresas, 40 contas, 3 empresas pagantes (**9,4%**). O número que mais
importa para decidir produto: **apenas 2 empresas têm mais de uma pessoa** —
**94% são de um dono sozinho**. E `paywall.viewed` por gatilho, em 176
visualizações: `menu` 90, `analysis` 41, `product_limit` 17, `account` 11,
`about` 8, `web_plan` 7, **`team` 2**.

Ou seja: estamos cobrando por **colaboração** num produto usado por gente
**sozinha**, e equipe é o gatilho que menos desperta interesse. Qualquer
proposta de funcionalidade paga precisa passar por este teste antes de
qualquer outro: **serve ao lojista que trabalha sozinho?**

Cuidado com `hasActiveSubscription` em `/admin/api/users`: ele é por
**pessoa**, então uma empresa com 5 membros aparece como 5 "assinantes". Para
contar clientes de verdade, conte **empresas** com assinatura.

### Economia unitária (para decisões de mídia)

Anual R$ 199,90 − 15% da Play ≈ **R$ 170 líquidos**. CAC máximo a 3:1 =
**R$ 55**. Cadastro→pagante ≈ 8%, logo custo por cadastro saudável ≤ **R$ 4,35**
e empate em **R$ 13,40**. Linha de base orgânica ≈ **3,8 cadastros Android/dia**
sem campanha.

## 3. Mapa: a pergunta e o arquivo que a responde

### Produto e código

| A pergunta é sobre | Abra |
| --- | --- |
| Planos, limites, o que cada um libera, por que a nuvem é grátis | [docs/plans.md](docs/plans.md) |
| Cobrança pela web, Pix/boleto/cartão, recorrência | [docs/billing-asaas.md](docs/billing-asaas.md) |
| Aplicação web: rotas, telas, SEO, pré-renderização | [docs/web-app.md](docs/web-app.md) |
| Sincronização: como funciona, falhas conhecidas, pós-mortem | [docs/auditoria-sincronizacao-2026-11.md](docs/auditoria-sincronizacao-2026-11.md) |
| Fotos de produto, cota, S3, redimensionamento | [docs/images.md](docs/images.md) |
| Eventos de uso, o que o painel entende | [docs/analytics.md](docs/analytics.md) |
| Conferência de estoque (contagem física, limite do gratuito) | [docs/conferencia-de-estoque.md](docs/conferencia-de-estoque.md) |
| Suporte pelo app: como abre, como o painel responde | [docs/support.md](docs/support.md) |
| Notificações e push (FCM) | [docs/notifications.md](docs/notifications.md) · [docs/push.md](docs/push.md) |
| E-mails automáticos de ativação e recuperação | [docs/emails-ciclo-de-vida.md](docs/emails-ciclo-de-vida.md) |
| Central de ajuda (FAQ), fonte única | [docs/help.md](docs/help.md) |
| Identidade visual por empresa (white-label) | [docs/branding.md](docs/branding.md) |
| Blog | [docs/blog.md](docs/blog.md) |
| Login com Google na web | [docs/login-google.md](docs/login-google.md) |
| Erros de produção (Admin › Erros) | [docs/erros.md](docs/erros.md) |
| Segurança, privacidade, backup, chaves | [docs/seguranca.md](docs/seguranca.md) |
| Arquitetura, entidades, autorização, regras invioláveis | [AGENTS.md](AGENTS.md) |
| App Android por dentro | [apps/android/AGENTS.md](apps/android/AGENTS.md) |
| Como rodar local, comandos, primeiro admin | [README.md](README.md) |
| Deploy | [DEPLOY.md](DEPLOY.md) |

### Aquisição, marketing e operação do negócio

| A pergunta é sobre | Abra |
| --- | --- |
| Medição do funil, GA4, gclid, o que o código garante | [docs/aquisicao-e-conversao.md](docs/aquisicao-e-conversao.md) |
| Google Ads: estratégia, régua, gatilho de parada | [docs/plano-google-ads-2026-11.md](docs/plano-google-ads-2026-11.md) |
| Google Ads: o que foi feito em cada dia, decisões já tomadas | `~/Downloads/EstoqueSimples-PlayStore/google-ads-otimizacao/diario.md` |
| Black Friday 2026 | [docs/black-friday-2026.md](docs/black-friday-2026.md) |
| Imagens da ficha da Play, vídeos, criativos, .aab | `~/Downloads/EstoqueSimples-PlayStore/` |

### Fora do repositório

| O quê | Onde |
| --- | --- |
| Rotinas automáticas (Ads, Play, ofertas) | `~/.claude/scheduled-tasks/<nome>/SKILL.md` |
| Preferências do dono e fatos entre sessões | `~/.claude/projects/-Users-andrefortunato-Documents-Repos/memory/` |
| Conta Google Ads | 271-634-1302 |

## 4. Atendimento ao cliente

O padrão, já acordado com o dono:

- Resposta **curta e objetiva**. Nada de passo a passo longo quando uma frase
  resolve.
- **Resolver do nosso lado** sempre que possível, em vez de pedir que o
  cliente faça coisas ou mande prints.
- **Reembolso só se o cliente pedir.** Não oferecer antes.
- **Não oferecer cupom.**
- No painel e nos relatórios, usar **só o primeiro nome** do cliente,
  **nunca o e-mail**.
- Conferir a pergunta contra a seção 2 antes de responder: a maior parte das
  dúvidas é sobre plano e limite.

## 5. Convenções do repositório

- Código, variáveis, commits e PRs seguem o idioma que o repositório já usa;
  os comentários são em português e explicam **decisões**, não sintaxe.
- Commits terminam com `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Descrições de PR terminam com
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Deploy sai ao mesclar em `main`; nunca commitar direto na `main`.

## 6. Manutenção deste arquivo

Ele só serve enquanto estiver certo. **Um número daqui que mudar precisa ser
corrigido aqui no mesmo trabalho que o mudou** — preço, limite, nome de plano,
documento novo em `docs/`. Se a informação for longa, ela não mora aqui: mora
num documento de `docs/` e ganha uma linha no mapa da seção 3.

Quando houver dúvida entre este arquivo e o **Painel › Planos**, o painel
vence: os limites são dados, não código.
