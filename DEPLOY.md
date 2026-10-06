# Operação (API, painel e aplicação web)

Guia de plantão: como o serviço sobe, o que observar, o que fazer quando algo
sai do lugar e como voltar atrás. Escrito para ser lido às três da manhã.

## Ambientes

| Ambiente | Banco | Sincronização | Uso |
| --- | --- | --- | --- |
| `development` | Postgres local (`docker compose up`) | ligada | máquina do desenvolvedor |
| `test` | banco efêmero da suíte | ligada | `npm test` |
| `staging` | Postgres do Railway, projeto próprio | ligada | teste interno do Play |
| `production` | Postgres do Railway com backup diário | controlada por `/ops/config/sync` | clientes |

`staging` e `production` são projetos separados no Railway, com bancos
separados. Compartilhar o banco entre eles significaria que um teste de
migration destrutiva atingiria dados de clientes.

Variáveis obrigatórias fora de desenvolvimento: `DATABASE_URL`,
`JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` (gere com `npm run keys:generate`),
`OPS_TOKEN` (`openssl rand -base64 32`), `GOOGLE_PUBSUB_VERIFICATION_TOKEN`,
`PURCHASE_TOKEN_ENCRYPTION_KEY` e o e-mail (`EMAIL_PROVIDER=resend` +
`RESEND_API_KEY` + `EMAIL_FROM`). As demais têm padrão em
[`apps/api/src/platform/config/env.ts`](apps/api/src/platform/config/env.ts) e a aplicação recusa
subir se alguma estiver inválida — falhar no boot é preferível a descobrir o
erro na primeira requisição de um cliente.

### Painel administrativo

O painel (`/admin`) sobe junto com a API e é compilado no mesmo `npm run
build` (workspace `apps/admin` → `apps/admin/dist`). Para ele funcionar em produção:

| Variável | Para quê |
| --- | --- |
| `ADMIN_COOKIE_SECRET` | assina o cookie de sessão (`openssl rand -base64 48`). Sem ela a API sobe com um segredo efêmero e avisa no log: todo restart derruba as sessões do painel |
| `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` | cria o primeiro administrador (owner) na subida, se ainda não existir. Idempotente; remova após o primeiro acesso. Senha com no mínimo 12 caracteres |
| `ADMIN_PANEL_ENABLED=false` | desliga o painel inteiro (`/admin` e `/admin/api` respondem 404) |

Alternativa ao bootstrap: `railway run --service <api> -- sh -c
'ADMIN_PASSWORD=... npm run admin:create -- --email voce@... --role owner'`.
Depois do primeiro owner, novos administradores são criados pelo próprio
painel (menu Administradores). A trilha de tudo o que os administradores
fazem fica em `admin_audit_log` e é consultável em Auditoria › Administradores.

## Um serviço, dois endereços

API, painel e aplicação web são **um** serviço no Railway (projeto
`estoquesimples-api`, serviço `estoquesimples-api`) com o Postgres ao lado. O
processo escolhe o que responder pelo cabeçalho `Host`:

| Endereço | Responde |
| --- | --- |
| `api.estoquesimples.com.br` | API (`/v1`), painel (`/admin`), `/docs`, `/health`, `/ready`, `/metrics`, `/ops` |
| `estoquesimples.com.br` | aplicação web (`apps/web/dist`) + `/v1` na mesma origem |

Variáveis da web: `WEB_APP_HOSTS=estoquesimples.com.br,www.estoquesimples.com.br`
e `WEB_APP_URL=https://estoquesimples.com.br`. Sem `WEB_APP_HOSTS` a web fica
desligada e o domínio cairia na raiz da API. `WEB_APP_URL` é a que põe os
links da web nos e-mails de convite, confirmação e redefinição de senha e
informa ao Asaas para onde voltar depois do pagamento — num ambiente novo,
só a defina depois que o domínio estiver no ar. O app Android continua usando
`api.estoquesimples.com.br`; nada nele muda.

Configuração de build e deploy versionada: `railway.json` (comandos,
healthcheck e `watchPatterns` — commits que só tocam `apps/android` ou `docs`
não disparam deploy), `nixpacks.toml` (instala devDependencies para o build)
e `.dockerignore` (o app Android e a documentação não entram na imagem).
O formato `railway.json` foi marcado como obsoleto pela Railway e funciona
até **1º/12/2026**; antes disso, migrar com `railway config migrate`.

### DNS

O domínio é registrado no registro.br, mas a zona DNS fica no **Cloudflare**
(servidores `thea.ns.cloudflare.com` e `wilson.ns.cloudflare.com`) desde
02/10/2026: a raiz de um domínio não aceita CNAME comum, o DNS do registro.br
não tem ALIAS e o Cloudflare resolve isso com *CNAME flattening*. Registros
da zona, todos como **Somente DNS** (com o proxy ligado o Railway não emite
certificado e o e-mail quebra):

| Tipo | Nome | Valor | Para quê |
| --- | --- | --- | --- |
| CNAME | `@` | `tpvf0p43.up.railway.app` | aplicação web |
| TXT | `_railway-verify` | `railway-verify=b92e59bf…` | verificação do Railway (raiz) |
| CNAME | `api` | `5fm3slen.up.railway.app` | API e painel |
| TXT | `_railway-verify.api` | `railway-verify=2d72ec8d…` | verificação do Railway (api) |
| CNAME | `send`, `rsend` | `send.forge.rmta.net`, `rsend.forge.rmta.net` | envio de e-mail (Resend) |
| TXT | `resend._domainkey` | chave DKIM | envio de e-mail (Resend) |

`railway domain status estoquesimples.com.br` mostra a verificação e o
certificado. O DNSSEC está ativo: o Cloudflare assina a zona e o DS
(keytag 2371) está cadastrado no registro.br. Se a zona mudar de provedor,
retire o DS no registro.br **antes** de trocar os servidores — DS que não
corresponde à chave em uso faz o domínio parar de resolver.

O plano atual do Railway permite dois domínios próprios por serviço (`api.` e
a raiz), então `www.` é atendido no Cloudflare: registro `A` `www` →
`192.0.2.1` com o proxy **ligado** (o único registro com proxy), uma Redirect
Rule de `www` para `https://estoquesimples.com.br` (301) e "Sempre usar
HTTPS" ativado, para que `http://www…` também chegue à regra.

## Imagens (bucket)

As fotos dos produtos ficam num **bucket do Railway** (`estoquesimples-imagens`,
região `iad`), configurado no serviço pelas variáveis `S3_*` — passo a passo,
validação e custo em [docs/images.md](docs/images.md). Sem `S3_BUCKET` o envio
de fotos responde 503 e o resto do sistema funciona normalmente. O bucket não
está no backup do Postgres. Staging precisa do próprio bucket.

## Deploy

O `startCommand` roda as migrations antes de abrir a porta, com advisory lock:
subir duas instâncias ao mesmo tempo é seguro, apenas uma aplica. O Railway só
direciona tráfego quando `/ready` passa, e `/ready` exige schema em dia.

Regra que não se quebra: **nunca remover uma coluna na mesma versão que para de
usá-la.** Durante o deploy convivem código novo e antigo; uma coluna removida
cedo demais derruba as instâncias que ainda não trocaram.

## O que observar

`/metrics` (formato Prometheus) e `/ops/status`, ambos protegidos por
`OPS_TOKEN` via `Authorization: Bearer`. Sem o token configurado os endereços
respondem 404 — aberto seria pior do que ausente, porque `/metrics` entrega
volume de clientes e ritmo de uso.

Métricas que respondem às perguntas do plantão:

| Métrica | Pergunta |
| --- | --- |
| `http_requests_total{status}` | está devolvendo erro? |
| `http_request_duration_seconds` | está lento? |
| `sync_operations_total{result}` | os aparelhos conseguem enviar? |
| `sync_conflicts_pending` | há decisões acumulando sem ninguém? |
| `jobs_pending` / `jobs_overdue` / `jobs_failed` | a fila está andando? |
| `subscriptions_unverified` | estamos concedendo acesso sem confirmar pagamento? |
| `billing_notifications_total{result}` | o webhook do Google está sendo processado? |

O rótulo de rota é sempre o padrão registrado (`/v1/workspaces/:workspaceId`),
nunca a URL concreta: com a URL, cada empresa criaria uma série temporal e a
coleta ficaria inutilizável em dias.

## Alertas

O vigia (`ops.watchdog`) roda a cada 15 minutos e emite log de nível `error`
com o campo `alerta: true`. A regra de alerta da coleta de logs deve disparar
nesse campo, e não em texto da mensagem.

| Alerta | Significa | Primeira ação |
| --- | --- | --- |
| `jobs_falhos` | tarefa esgotou as tentativas e não repete | ler `last_error` na tabela `jobs` |
| `fila_atrasada` | mais de 20 tarefas vencidas | conferir se alguma instância está viva com `JOBS_ENABLED=true` |
| `assinaturas_sem_verificacao` | assinatura ativa sem confirmação do Google há 48h | verificar credenciais da service account |
| `conflitos_esquecidos` | conflitos pendentes há mais de 7 dias | avisar os clientes envolvidos; os aparelhos seguem divergentes |

Os mesmos alertas aparecem na visão geral e na tela Operação do painel, que
também permite repetir tarefas falhas, reprocessar notificações do Google
Play pendentes e alternar o interruptor de sincronização (papel owner, com
motivo registrado).

A lista é curta de propósito. Alerta que dispara toda semana por algo que
ninguém trata deixa de ser lido, e o primeiro incidente de verdade passa
despercebido junto.

## Backups

O Railway faz o backup do Postgres; a garantia de que ele *serve* vem do
exercício de restauração:

- `.github/workflows/backup-drill.yml` roda toda segunda-feira, gera um dump,
  restaura num banco descartável e confere que as tabelas essenciais têm
  conteúdo e que o histórico de migrations veio junto.
- Com um dump real: `npm run backup:verify -w @estoquesimples/api -- --dump /caminho/absoluto/arquivo.dump --target postgres://...`.
  O alvo é apagado e recriado; nunca aponte para produção.
- O resultado fica em `/ops/backup`. `dentroDoPrazo: false` significa que
  ninguém verificou nas últimas `BACKUP_MAX_AGE_HOURS` horas — o backup voltou
  a ser suposição.

## Lançamento gradual

A sincronização é controlada em tempo real, sem redeploy e sem nova versão na
loja:

```bash
# Pausar a sincronização de todos os aparelhos (incidente em andamento)
curl -X PUT https://api.exemplo/ops/config/sync \
  -H "Authorization: Bearer $OPS_TOKEN" -H 'content-type: application/json' \
  -d '{"enabled": false, "minAppVersionCode": 0}'

# Liberar apenas para versões novas do app
curl -X PUT https://api.exemplo/ops/config/sync \
  -H "Authorization: Bearer $OPS_TOKEN" -H 'content-type: application/json' \
  -d '{"enabled": true, "minAppVersionCode": 23}'
```

Com a sincronização desligada, o aplicativo se comporta exatamente como a
versão sem nuvem: continua lendo e gravando no SQLite do aparelho e acumula as
alterações na fila local. Nada é perdido e nada é apagado — a flag nunca toca
no banco do dispositivo.

Sequência de lançamento: `local → CI → staging → conta interna → teste interno
do Play → 5% → 20% → 50% → 100%`, usando o rollout gradual do Google Play.
Entre cada etapa, observar `sync_operations_total{result="rejeitada"}` e
`sync_conflicts_pending`.

## Rollback

| Camada | Como voltar |
| --- | --- |
| API | redeploy da versão anterior no Railway; migrations são compatíveis com a versão anterior por um release |
| Aplicativo | interromper o rollout no Play Console (não remove quem já atualizou) |
| Sincronização | `PUT /ops/config/sync` com `enabled: false` — vale em segundos, sem deploy |

O terceiro caminho é o mais rápido e o mais reversível, e é o primeiro a usar
quando não se sabe ainda de onde vem o problema.
