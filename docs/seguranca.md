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
   - `pg_dump` com um usuário **somente leitura**;
   - **restauração de teste** do próprio dump num Postgres descartável do
     runner, com conferência das tabelas essenciais e do histórico de
     migrations (`backup:verify`), registrada em `/ops/backup`;
   - só então o dump é cifrado com `age` (chave pública no GitHub; a privada
     **nunca** fica no GitHub nem no Railway) e enviado para um bucket de
     **outro provedor**, em `db/AAAA/MM/DD/…dump.age` com o SHA-256 ao lado;
   - as fotos dos produtos são copiadas com `rclone copy` (nunca apaga no
     destino) para `imagens/` no mesmo bucket.
3. **Exercício de schema** (`backup-drill.yml`, segundas): restaura um banco
   sintético para provar que o procedimento acompanha as migrations.
4. **No aparelho**: o app Android funciona sem internet, guarda uma cópia do
   banco local antes da primeira sincronização e entra no backup do Android
   (só o banco do estoque; sessão e login lembrado ficam de fora).
5. **Alerta**: `backup_desatualizado` (vigia de 15 em 15 minutos, painel e
   métrica `backup_verified_age_hours`) dispara quando não há restauração de
   teste registrada nas últimas `BACKUP_MAX_AGE_HOURS` horas (48 h).

### Ligar a cópia externa **[dono]**

1. Crie um bucket em outro provedor (Backblaze B2, Cloudflare R2 ou AWS S3)
   com **versionamento** (ou object lock em modo governança):
   - regra de expiração de 35 dias **só no prefixo `db/`** (os dumps);
   - em `imagens/`, nenhuma expiração por idade (a foto de hoje pode ter sido
     copiada há meses); só "versões não atuais expiram em 35 dias";
   - credencial restrita a esse bucket com listar, ler cabeçalho, ler e
     gravar objetos (`s3:ListBucket`, `s3:GetObject`, `s3:PutObject`; no B2:
     `listFiles`, `readFiles`, `writeFiles`), **sem apagar**. Ler é preciso
     para o `rclone copy` comparar e para conferir o hash do dump enviado.
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
   ```
4. No Railway, crie `OPS_BACKUP_TOKEN` (`openssl rand -hex 32`): ele só
   registra restaurações de teste em `/ops/backup` — o `OPS_TOKEN` não vai
   para o GitHub.
5. No GitHub (*Settings → Secrets and variables → Actions*), cadastre os
   segredos listados no topo de `backup-offsite.yml` (com o mesmo
   `OPS_BACKUP_TOKEN`) e a variável `BACKUP_OFFSITE_ENABLED=true`. Rode o
   workflow manualmente uma vez e confira `/ops/backup` (`dentroDoPrazo:
   true`, com `objeto` e `sha256` do arquivo enviado).

### Restaurar (roteiro de incidente)

1. **Decidir a origem**: perda recente e Railway de pé → backup do Railway
   (painel do Postgres → *Restore*). Railway indisponível, conta comprometida
   ou backup do Railway inválido → cópia externa.
2. **Baixar e decifrar** a cópia externa mais recente:
   ```bash
   rclone copy backup:<bucket>/db/AAAA/MM/DD/ ./restauracao/
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
   (`backup:verify` faz o mesmo automaticamente no banco descartável do passo 3.)
5. **Apontar a API**: troque `DATABASE_URL` do serviço da API para o banco
   novo; o deploy roda as migrations pendentes na subida. Confira `/ready`.
6. **Fotos**: `rclone copy backup:<bucket>/imagens imagens:<bucket-das-fotos>`.
7. **Chaves**: a API precisa das **mesmas** `PURCHASE_TOKEN_ENCRYPTION_KEY` /
   `SECRETS_ENCRYPTION_KEYS` e `JWT_*` de antes — sem elas os segredos
   cifrados (chave da OpenAI, segundo fator do painel, comprovantes do Google
   Play) não abrem e todas as sessões caem. Elas vêm do cofre (ver abaixo).
8. Registre data, origem, duração e perda de dados no histórico abaixo.

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
4. Só então a `k1` pode sair do chaveiro (guarde-a no cofre até o próximo
   backup externo expirar: dumps antigos ainda a usam).

`JWT_PRIVATE_KEY`: trocar invalida todos os tokens de acesso (15 min) e o
segredo derivado do cookie do painel (se `ADMIN_COOKIE_SECRET` não estiver
definido); as sessões de refresh continuam.

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
  notificações saem junto), as conversas de suporte dela, e desvincula
  analytics, erros e auditoria (sem IP). Cópias de backup expiram em 35 dias.

### Retenção

| Dado | Prazo | Onde |
| --- | --- | --- |
| Conta excluída | 30 dias após o pedido | `privacy.daily` |
| Sessões encerradas ou vencidas (IP, navegador) | 90 dias | `privacy.daily` |
| Tokens de uso único vencidos | 30 dias | `privacy.daily` |
| IP em registros de auditoria (cliente e painel) | 180 dias (o registro fica) | `privacy.daily` |
| Caixa de notificações | 365 dias | `privacy.daily` |
| Aparelhos para push sem uso | 180 dias | `privacy.daily` |
| Conversas de suporte resolvidas | 2 anos sem mensagem nova | `privacy.daily` |
| Tarefas da fila concluídas | 30 dias | `privacy.daily` |
| Convites aceitos, cancelados ou vencidos | 90 dias | `privacy.daily` |
| Erros registrados | 30 dias | `ops` (`error_events`) |
| Eventos de uso (analytics) | `ANALYTICS_RETENTION_DAYS` (400) | `analytics.retention` |
| Backups | 35 dias | regra do bucket / Railway |

## Riscos aceitos (revisar na data)

| Risco | Mitigação | Revisar |
| --- | --- | --- |
| Zod 3 sem correção para GHSA-mrhx-c7xc-m3w5 | corpo limitado (1 MB; 5 MB na sincronização), listas com `.max()`; aceite com prazo em `scripts/audit-gate.mjs` | 2027-01-31 (migrar para Zod 4) |
| Cadastro responde 409 para e-mail já usado | limite por IP e por e-mail (5/h); o cadastro devolve sessão na hora, então trocar por resposta neutra muda o fluxo dos apps | próxima revisão do cadastro |
| Google Analytics no painel (`script-src` com googletagmanager.com) | pedido do produto (medir o uso do painel); só carrega depois do aceite no aviso de cookies; o cookie de sessão é httpOnly e as mutações exigem cabeçalho anti-CSRF; segundo fator obrigatório. Para tirar: remover `lib/ga.ts` do painel e o domínio da CSP em `admin-static.ts` | se o painel ganhar ações mais sensíveis |
| Freio de tentativas em memória | instância única; um deploy só devolve tentativas a quem já estava bloqueado | se houver mais de uma instância |
