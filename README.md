# estoquesimples-api

API de sincronização em nuvem do Estoque Simples: contas, empresas, equipe,
assinatura pelo Google Play e sincronização do estoque entre aparelhos.

O aplicativo Android continua funcionando por completo sem esta API. Tudo é
gravado primeiro no SQLite do aparelho; a nuvem é uma camada adicional para
assinantes, e desligá-la devolve o app ao modo em que ele sempre funcionou.

## Começando

```bash
docker compose up -d          # Postgres em localhost:5433
cp .env.example .env
npm ci
npm run keys:generate         # chaves Ed25519 dos tokens de acesso
# staging/produção: openssl rand -base64 32 → PURCHASE_TOKEN_ENCRYPTION_KEY
# staging/produção: EMAIL_PROVIDER=resend + RESEND_API_KEY + EMAIL_FROM
npm run migrate
npm run dev
```

Se o banco local já tinha migrations antigas e a `0008` falhar, reset:
`docker compose down -v && docker compose up -d && npm run migrate`.

A documentação interativa fica em `/docs` e o contrato OpenAPI sai com
`npm run openapi`.

## Comandos

| Comando | Para quê |
| --- | --- |
| `npm run dev` | servidor com recarga automática |
| `npm test` | suíte de integração contra Postgres real |
| `npm run typecheck` | verificação de tipos |
| `npm run migrate` / `migrate:down` / `migrate:status` | schema |
| `npm run backup:verify` | restaura um dump num banco descartável e confere |

## Estrutura

```
src/
  modules/      auth, workspaces, invites, billing, sync, ops, audit
  platform/     config, db, http, auth, email, jobs, observability
tests/          integração por módulo, com Postgres de verdade
```

Cada módulo tem serviço (regra de negócio), rotas (contrato HTTP) e schemas
Zod. As migrations são SQL escrito à mão porque RLS, índices únicos parciais e
gatilhos não sobrevivem à geração automática.

Operação, alertas, backups e lançamento gradual: [DEPLOY.md](DEPLOY.md).
