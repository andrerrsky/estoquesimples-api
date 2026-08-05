# Operação da API

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
`JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` (gere com `npm run keys:generate`) e
`OPS_TOKEN` (`openssl rand -base64 32`). As demais têm padrão em
[`src/platform/config/env.ts`](src/platform/config/env.ts) e a aplicação recusa
subir se alguma estiver inválida — falhar no boot é preferível a descobrir o
erro na primeira requisição de um cliente.

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

A lista é curta de propósito. Alerta que dispara toda semana por algo que
ninguém trata deixa de ser lido, e o primeiro incidente de verdade passa
despercebido junto.

## Backups

O Railway faz o backup do Postgres; a garantia de que ele *serve* vem do
exercício de restauração:

- `.github/workflows/backup-drill.yml` roda toda segunda-feira, gera um dump,
  restaura num banco descartável e confere que as tabelas essenciais têm
  conteúdo e que o histórico de migrations veio junto.
- Com um dump real: `npm run backup:verify -- --dump arquivo.dump --target postgres://...`.
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
