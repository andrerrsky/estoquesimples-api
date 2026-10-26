# Segurança, privacidade e backup

O que protege os dados do Estoque Simples, o que fazer quando algo dá errado
e o que depende de configuração fora do repositório (Railway, GitHub, Google
Cloud). Itens marcados **[dono]** são ações de quem administra as contas.

## Backup e restauração

### Objetivos

| | Valor | Como é cumprido |
| --- | --- | --- |
| **RPO** (quanto dado se pode perder) | 24 h | dump noturno externo (`backup-offsite.yml`) + backups diários do Railway |
| **RTO** (quanto tempo para voltar) | 4 h | roteiro abaixo; o procedimento é exercitado toda semana pelo `backup-drill.yml` (com a mesma receita do usuário de leitura) e, depois de ligado o backup externo, toda noite pela restauração de teste do dump real |
| Retenção das cópias | 35 dias (Railway: o que o plano permitir, mínimo 14) | regra de expiração no bucket de backup |

### Camadas

1. **Railway** **[dono]**: no serviço Postgres → *Backups*, ligar backups
   agendados (diário; semanal se o plano permitir) com retenção de pelo menos
   14 dias. É a restauração mais rápida (mesmo provedor, um clique).
2. **Cópia externa noturna** (`.github/workflows/backup-offsite.yml`):
   - `pg_dump` com um usuário **somente leitura**, por TLS (o workflow recusa
     URL sem `sslmode=require`);
   - **restauração de teste** do próprio dump num Postgres descartável do
     runner, com conferência das tabelas essenciais e do histórico de
     migrations (`backup:verify`);
   - só então o dump é cifrado com `age` (chave pública no GitHub; a privada
     **nunca** fica no GitHub nem no Railway), enviado para o **bucket dos
     dumps** em outro provedor (`db/AAAA/MM/DD/…dump.age`, com o SHA-256 ao
     lado e conferido de volta) e o resultado registrado em `/ops/backup`;
   - o bucket dos dumps tem **Object Lock**: nenhum dump pode ser apagado
     ou trocado antes de 35 dias, nem com a chave do workflow;
   - a lógica fica em `scripts/backup-offsite.sh`, exercitada em todo PR que
     mexe no backup por `backup-offsite-test.yml` (S3 local com Object Lock e
     versionamento: fluxo completo, decifrar e restaurar, restauração de foto
     no ponto anterior e cada trava);
   - as fotos são **espelhadas** (`rclone sync`) num **segundo bucket**, com
     versionamento: foto apagada na origem vira versão antiga e fica 35
     dias. O espelho só roda se o versionamento estiver ativo e a origem não
     estiver vazia, e para se mais de 200 fotos sumirem numa noite.
3. **Exercício de schema** (`backup-drill.yml`, segundas e em todo PR que mexe
   em migrations ou no backup): restaura um banco sintético, com o dump feito
   pela mesma receita do usuário de leitura.
4. **No aparelho**: o app Android funciona sem internet, guarda uma cópia do
   banco local antes da primeira sincronização e entra no backup do Android
   (só o banco do estoque; sessão e login lembrado ficam de fora).
5. **Alertas**: `backup_desatualizado` quando não há backup externo
   registrado nas últimas `BACKUP_MAX_AGE_HOURS` horas (48 h);
   `backup_schema_divergente` quando o último dump guardado está à frente da
   migration que a API roda, ou atrás mesmo tendo sido feito depois do deploy
   dela (banco errado ou parado); `backup_sem_fotos` quando o registro chega
   sem a contagem das fotos espelhadas.

### Ligar a cópia externa **[dono]**

1. Num provedor **e conta diferentes** de onde estão o banco e as fotos de
   produção — **AWS S3** (recomendado) ou **Backblaze B2**; Cloudflare R2 não
   serve (não tem versionamento S3 nem Object Lock com modos) —, crie dois
   buckets:
   - **dumps** (`BACKUP_S3_BUCKET`): **Object Lock** ligado na criação, retenção
     padrão de **35 dias** (modo *compliance*). Regras de ciclo de vida: objetos
     atuais expiram em 35 dias **e** versões não atuais são apagadas 1 dia
     depois (S3: `Expiration: 35` + `NoncurrentVersionExpiration: 1`; B2:
     `daysFromUploadingToHiding: 35`, `daysFromHidingToDeleting: 1`) — sem a
     segunda regra o arquivo expirado continua guardado para sempre. O Object
     Lock garante que nada sai antes dos 35 dias. Chave **só deste bucket**,
     com listar, ler e gravar (`s3:ListBucket`, `s3:GetObject`, `s3:PutObject`;
     B2: `listFiles`, `readFiles`, `writeFiles`) e **sem apagar**;
   - **cópia das fotos** (`BACKUP_IMAGES_BUCKET`): **S3**: versionamento ligado,
     sem expiração dos objetos atuais e `NoncurrentVersionExpiration: 35`; chave
     só deste bucket com `s3:ListBucket`, `s3:GetBucketVersioning`,
     `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` e **sem**
     `s3:DeleteObjectVersion` nem permissão de mudar o bucket. **B2**: as
     chaves do B2 que apagam também apagam versões, então ligue **Object Lock**
     com retenção padrão de 35 dias neste bucket também (apagar só esconde;
     `daysFromHidingToDeleting: 35`) e defina a variável do GitHub
     `BACKUP_IMAGES_VERSIONING_CONFIRMED=true` (o B2 não informa o
     versionamento pela API S3).

   Com isso, uma chave vazada do GitHub não destrói nada antes do prazo, e o
   dado de uma conta expurgada sai das cópias em até 36 dias. **Trimestralmente**,
   confira que não há objeto com mais de 36 dias em `db/` (`rclone lsl`).
2. Gere o par de chaves `age` num computador confiável:
   `age-keygen -o estoque-backup.key` — guarde o arquivo **no gerenciador de
   senhas** (e uma cópia offline); a linha `public key: age1…` vai para o GitHub.
3. No Postgres de produção, crie o usuário de leitura:
   ```sql
   CREATE ROLE backup_reader LOGIN PASSWORD '<gerada>';
   GRANT CONNECT ON DATABASE railway TO backup_reader;
   -- Papel embutido do Postgres 14+: lê tudo sem GRANT por tabela, então o
   -- dump não carrega permissões para backup_reader (que o banco restaurado
   -- não teria). O exercício semanal usa exatamente esta receita.
   GRANT pg_read_all_data TO backup_reader;
   ALTER ROLE backup_reader BYPASSRLS; -- o dump precisa ver todas as empresas
   ALTER ROLE backup_reader SET default_transaction_read_only = on;
   ALTER ROLE backup_reader CONNECTION LIMIT 2;
   ```
   O GitHub alcança o banco pelo **proxy TCP público** do Railway (a porta
   fica aberta à internet, protegida pela senha): use uma senha longa e
   gerada, e monte `BACKUP_DATABASE_URL` com **`?sslmode=require`** no fim —
   sem isso o cliente aceita conexão sem TLS e o dump inteiro (e a senha)
   podem passar em claro.
4. No Railway, crie `OPS_BACKUP_TOKEN` (`openssl rand -hex 32`): ele só
   registra restaurações de teste em `/ops/backup` — o `OPS_TOKEN` não vai
   para o GitHub.
5. No GitHub (*Settings → Secrets and variables → Actions*), cadastre os
   segredos listados no topo de `backup-offsite.yml` (com o mesmo
   `OPS_BACKUP_TOKEN`) e a variável `BACKUP_OFFSITE_ENABLED=true`. Rode o
   workflow manualmente uma vez e confira `/ops/backup` (`dentroDoPrazo:
   true`, com `objeto` e `sha256` do arquivo enviado).

### Restaurar (roteiro de incidente)

0. **Suspeita de exclusão ou adulteração?** Antes de tudo, no GitHub, mude
   a variável `BACKUP_OFFSITE_ENABLED` para `false`: o espelho da noite
   seguinte não pode levar o estrago para a cópia das fotos.
1. **Decidir a origem**: perda recente e Railway de pé → backup do Railway
   (painel do Postgres → *Restore*). Railway indisponível, conta comprometida
   ou backup do Railway inválido → cópia externa.
2. **Baixar e decifrar** a cópia externa mais recente. No computador de quem
   restaura: rclone 1.66 ou mais novo (o do apt é antigo para
   `version_at`) e um `rclone.conf` com os três remotos
   usados abaixo — `backup` (bucket dos dumps), `backupimg` (cópia das fotos)
   e `imagens` (bucket das fotos de produção, com a chave de **escrita** da
   API, `S3_*` do Railway):
   ```ini
   [backup]
   type = s3
   provider = AWS          # ou Other, com endpoint do B2
   access_key_id = ...
   secret_access_key = ...
   region = ...
   [backupimg]
   type = s3
   provider = AWS
   access_key_id = ...
   secret_access_key = ...
   region = ...
   [imagens]
   type = s3
   provider = Other
   endpoint = <S3_ENDPOINT>
   access_key_id = <S3_ACCESS_KEY_ID>
   secret_access_key = <S3_SECRET_ACCESS_KEY>
   ```
   ```bash
   rclone copy backup:<bucket-dos-dumps>/db/AAAA/MM/DD/ ./restauracao/
   sha256sum -c <(echo "$(cat arquivo.dump.age.sha256)  arquivo.dump.age")
   age --decrypt --identity estoque-backup.key --output backup.dump arquivo.dump.age
   ```
3. **Conferir antes de usar**, num banco descartável:
   `npm run backup:verify -w @estoquesimples/api -- --dump "$PWD/backup.dump" --target postgres://…/descartavel`
4. **Restaurar no Postgres novo** (crie um serviço Postgres novo no Railway,
   nunca sobre o banco suspeito). Os GRANTs do dump citam papéis do cluster
   (`app_user` e o dono das tabelas); crie os que faltarem antes:
   ```bash
   for papel in $(pg_restore --file=- --schema-only backup.dump \
       | grep -E '^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)' \
       | grep -oE '(TO|FROM|FOR ROLE) [a-z_][a-z0-9_]*' | awk '{print $NF}' | sort -u); do
     psql "$NOVO" -c "DO \$\$ BEGIN CREATE ROLE $papel NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$"
   done
   pg_restore --no-owner --single-transaction --dbname "$NOVO" backup.dump
   ```
   (`backup:verify` faz o mesmo automaticamente no banco descartável do passo 3;
   ele não registra nada em `/ops/backup` — isso é só do workflow, depois de a
   cópia estar guardada.)
5. **Apontar a API**: troque `DATABASE_URL` do serviço da API para o banco
   novo; o deploy roda as migrations pendentes na subida. Confira `/ready`.
6. **Fotos**: restaure o bucket como estava **antes** do incidente (as fotos
   apagadas desde então existem como versões antigas):
   ```bash
   # Estado da cópia no instante informado. O `version_at` vai só no remoto
   # de origem (como flag global --s3-version-at valeria também para o
   # destino, que então não aceitaria escrita). Exercitado no CI.
   rclone copy "backupimg,version_at='2026-10-20T00:00:00Z':<bucket-copia-das-fotos>" imagens:<bucket-das-fotos>
   ```
   (No B2 via API S3 o parâmetro é o mesmo; com o backend nativo `b2`, use
   `backupimg,version_at='…'` igualmente; as aspas simples protegem os `:` da data.)
   Depois volte `BACKUP_OFFSITE_ENABLED=true`.
7. **Chaves**: a API precisa das **mesmas** `PURCHASE_TOKEN_ENCRYPTION_KEY` /
   `SECRETS_ENCRYPTION_KEYS` e `JWT_*` de antes — sem elas os segredos
   cifrados (chave da OpenAI, segundo fator do painel, comprovantes do Google
   Play) não abrem e todas as sessões caem. Elas vêm do cofre (ver abaixo).
8. Registre data, origem, duração e perda de dados no histórico abaixo.

### Exercício a partir do bucket (trimestral) **[dono]**

O workflow prova toda noite que o dump restaura, mas não que a chave
privada `age` está guardada e funciona. A cada trimestre, siga os passos 2 e
3 do roteiro acima num computador confiável (baixar o dump mais recente,
conferir o SHA-256, decifrar com a chave do cofre, `backup:verify` num banco
descartável) e registre na tabela abaixo.

### Histórico de restaurações reais

| Data | Origem | Duração | Observações |
| --- | --- | --- | --- |
| — | — | — | nenhuma até agora; exercícios automáticos em `/ops/backup` |

## Chaves e segredos

**[dono]** Guarde num cofre separado do Railway (gerenciador de senhas da
empresa, com acesso de duas pessoas): `PURCHASE_TOKEN_ENCRYPTION_KEY` e
`SECRETS_ENCRYPTION_KEYS`, `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY`,
`ADMIN_COOKIE_SECRET`, `OPS_TOKEN`, a chave privada `age` do backup, os
tokens de webhook (Asaas, Pub/Sub) e as credenciais dos buckets. Perder a
chave de cifra torna os segredos cifrados irrecuperáveis mesmo com o backup.

### Rotação da chave de cifra

Os segredos em repouso são cifrados com AES-256-GCM e um **chaveiro**
(`platform/crypto/purchase-token.ts`): cada valor guarda o `kid` da chave que
o cifrou e é amarrado ao lugar onde mora (AAD), então um valor copiado para
outra linha não abre.

1. Gere a chave nova: `openssl rand -base64 32`.
2. No Railway, acrescente-a: `SECRETS_ENCRYPTION_KEYS=k2:<nova>` (a
   `PURCHASE_TOKEN_ENCRYPTION_KEY` continua sendo a `k1`) e
   `SECRETS_ACTIVE_KID=k2`. Faça o deploy: o que for gravado daqui em diante
   usa a `k2`; o antigo continua abrindo com a `k1`.
3. Recifre o que já existe: `railway run npm run secrets:reencrypt -w @estoquesimples/api`
   (simulação) e depois com `-- --apply`. Rodar de novo deve mostrar 0.
   Na primeira vez, depois disso defina **`SECRETS_ALLOW_LEGACY=false`** e
   faça o deploy: a partir daí valor em formato antigo (inclusive texto em
   claro plantado por quem tenha escrita no banco) é recusado.
4. Só então a `k1` pode sair do chaveiro (guarde-a no cofre até o próximo
   backup externo expirar: dumps antigos ainda a usam).

`JWT_PRIVATE_KEY`: trocar invalida todos os tokens de acesso (15 min) e o
segredo derivado do cookie do painel (se `ADMIN_COOKIE_SECRET` não estiver
definido); as sessões de refresh continuam.

### Acesso de emergência ao painel (sem e-mail ou sem celular)

O cadastro do autenticador pede um código enviado por e-mail. Se o envio de
e-mail estiver fora e um administrador precisar entrar, um owner com acesso
ao Railway pode, pelo terminal do serviço:

1. `railway run npm run admin:create -w @estoquesimples/api -- --email <owner> --role owner`
   com `ADMIN_PASSWORD=<senha nova>` redefine a senha;
2. `railway run -- psql "$DATABASE_URL" -c "UPDATE platform_admins SET totp_secret = NULL, totp_enabled_at = NULL, recovery_codes = '[]' WHERE lower(email) = '<email>'"`
   zera o segundo fator;
3. com `ADMIN_MFA_REQUIRED=false` temporariamente (deploy), a pessoa entra só
   com a senha; volte para o padrão logo depois e cadastre o autenticador.

Cada passo fica no histórico de deploys e variáveis do Railway; anote no
histórico de incidentes.

## Contas e acesso

- **Clientes**: argon2id, política de senha (10+ caracteres, lista de senhas
  comuns), access token de 15 min conferido no banco a cada requisição,
  refresh opaco rotativo com detecção de reuso. A web guarda o refresh num
  cookie httpOnly; "Lembrar meu e-mail" guarda só o e-mail (nunca a senha).
- **Freio de tentativas**: bloqueio progressivo por (e-mail, IP) — ninguém
  tranca a conta de outra pessoa só sabendo o e-mail —, teto por conta para
  força bruta distribuída, e limite por e-mail em cadastro e "esqueci a
  senha". O IP real vem de `X-Forwarded-For` só quando o par é um proxy de
  rede privada (`TRUST_PROXY`, padrão `private` em produção).
- **Painel**: cookie httpOnly/Strict assinado, cabeçalho anti-CSRF e
  **segundo fator TOTP obrigatório** em produção (`ADMIN_MFA_REQUIRED`):
  quem não cadastrou só vê a tela de cadastro (QR code + 10 códigos de
  recuperação de uso único). Um owner pode zerar o segundo fator de outro
  administrador (as sessões dele caem). Toda ação fica na auditoria.
- **Webhooks**: Asaas com token em comparação de tempo constante; Google
  Play com token e, se configurado, JWT OIDC do Pub/Sub
  (`GOOGLE_PUBSUB_OIDC_AUDIENCE`/`_EMAIL`) **[dono: ativar a autenticação na
  assinatura push]**.

## Dados pessoais (LGPD)

- **Acesso e portabilidade**: Minha conta → *Baixar meus dados*
  (`GET /v1/me/export`): perfil, empresas, sessões, aparelhos, notificações,
  conversas de suporte, registros de atividade e de uso. O estoque de cada
  empresa sai pela exportação da empresa.
- **Exclusão**: o pedido bloqueia a conta na hora; depois de 30 dias o job
  `privacy.daily` apaga a conta (sessões, tokens, aparelhos, vínculos e
  notificações saem junto), as conversas de suporte dela, as fotos das
  empresas já excluídas que ela possuía, o e-mail dela em públicos de
  campanha e na trilha do painel, e desvincula analytics, erros e auditoria
  (sem IP). Nas cópias de backup (dumps e fotos), o dado some em até 35 dias
  pelas regras de versão do bucket.

### Retenção

| Dado | Prazo | Onde |
| --- | --- | --- |
| Conta excluída | 30 dias após o pedido | `privacy.daily` |
| Conversas de suporte de quem não tinha conta, com o e-mail da conta excluída | junto com a conta | `privacy.daily` |
| Avisos do Google Play/Asaas (`subscription_events`, processados ou não) | 400 dias do recebimento | `privacy.daily` |
| Conversas de suporte de quem nunca teve conta (qualquer estado) | 2 anos sem mensagem nova | `privacy.daily` |
| Sessões encerradas ou vencidas (IP, navegador) | 90 dias | `privacy.daily` |
| Tokens de uso único vencidos | 30 dias | `privacy.daily` |
| IP em registros de auditoria (cliente e painel) | 180 dias (o registro fica) | `privacy.daily` |
| Caixa de notificações | 365 dias | `privacy.daily` |
| Aparelhos para push sem uso | 180 dias | `privacy.daily` |
| Conversas de suporte resolvidas | 2 anos sem mensagem nova | `privacy.daily` |
| Tarefas da fila concluídas | 30 dias | `privacy.daily` |
| Convites aceitos, cancelados ou vencidos | 90 dias | `privacy.daily` |
| E-mails do público de campanhas (tipo "usuários") | 180 dias após o envio | `privacy.daily` |
| Erros registrados | 30 dias | `ops` (`error_events`) |
| Eventos de uso (analytics) | `ANALYTICS_RETENTION_DAYS` (400) | `analytics.retention` |
| Backups externos (dumps e versões antigas de fotos) | 35 dias (+1 de limpeza) | Object Lock e regras do bucket |
| Backups do Railway | conforme o plano (mínimo 14 dias) | Railway |

## Riscos aceitos (revisar na data)

| Risco | Mitigação | Revisar |
| --- | --- | --- |
| Zod 3 sem correção para GHSA-mrhx-c7xc-m3w5 | corpo limitado (1 MB; 5 MB na sincronização), listas com `.max()`; aceite com prazo em `scripts/audit-gate.mjs` | 2027-01-31 (migrar para Zod 4) |
| Cadastro responde 409 para e-mail já usado | limite por IP e por e-mail (5/h); o cadastro devolve sessão na hora, então trocar por resposta neutra muda o fluxo dos apps | próxima revisão do cadastro |
| Google Analytics no painel (`script-src` com googletagmanager.com) | pedido do produto (medir o uso do painel); só carrega depois do aceite no aviso de cookies; o cookie de sessão é httpOnly e as mutações exigem cabeçalho anti-CSRF; segundo fator obrigatório. Para tirar: remover `lib/ga.ts` do painel e o domínio da CSP em `admin-static.ts` | se o painel ganhar ações mais sensíveis |
| Texto livre (motivo, nota) na trilha do painel pode citar dado pessoal | o expurgo tira e-mail e nome dos campos estruturados; o painel orienta a não escrever dado pessoal no motivo | revisão anual |
| Dados do pagador da empresa (`billing_customers`) ficam enquanto a empresa existir | ligados à empresa, não à pessoa; saem com a empresa (decisão de produto pendente em AGENTS.md §13) | com a decisão de purga de empresas |
| Freio de tentativas em memória | instância única; um deploy só devolve tentativas a quem já estava bloqueado | se houver mais de uma instância |
