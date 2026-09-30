# estoquesimples-api

API de sincronização em nuvem do Estoque Simples: contas, empresas, equipe,
assinatura pelo Google Play, sincronização do estoque entre aparelhos,
eventos de uso do produto e o painel administrativo de suporte.

O aplicativo Android continua funcionando por completo sem esta API. Tudo é
gravado primeiro no SQLite do aparelho; a nuvem é uma camada adicional para
assinantes, e desligá-la devolve o app ao modo em que ele sempre funcionou.

## Começando

```bash
docker compose up -d          # Postgres em localhost:5433
cp .env.example .env
npm ci                        # instala a API e o workspace admin/
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

## Painel administrativo

Servido pela própria API em `/admin` (interface) e `/admin/api` (JSON), com
sessão própria em cookie httpOnly — nada a ver com o login do aplicativo.

```bash
# primeiro administrador (uma vez), depois entre em http://localhost:3000/admin
ADMIN_PASSWORD='uma-senha-longa' npm run admin:create -- --email voce@exemplo.com --name "Seu Nome"
# ou defina ADMIN_BOOTSTRAP_EMAIL / ADMIN_BOOTSTRAP_PASSWORD e suba a API

npm run seed:dev              # dados de demonstração (só em development)
npm run dev:admin             # Vite com hot reload em http://localhost:5174/admin/
npm run build                 # API + interface (admin/dist), o que o Railway roda
```

Em `npm run dev` a API serve a última build de `admin/dist`; para trabalhar
na interface use `npm run dev:admin`, que repassa `/admin/api` para a API
local. Detalhes de papéis, auditoria e analytics em [AGENTS.md](AGENTS.md).

## Comandos

| Comando | Para quê |
| --- | --- |
| `npm run dev` | servidor com recarga automática |
| `npm run dev:admin` | interface do painel com hot reload |
| `npm test` | suíte de integração contra Postgres real |
| `npm run typecheck` | verificação de tipos (API e painel) |
| `npm run migrate` / `migrate:down` / `migrate:status` | schema |
| `npm run admin:create` | cria ou redefine a senha de um administrador do painel |
| `npm run seed:dev` | dados de demonstração para desenvolvimento |
| `npm run backup:verify` | restaura um dump num banco descartável e confere |

## Estrutura

```
src/
  modules/      auth, users, workspaces, invites, billing, sync, export,
                analytics (eventos de uso), admin (painel), ops, audit
  platform/     config, db, http, auth, email, jobs, observability, crypto
admin/          interface do painel (Vite + React), publicada em admin/dist
tests/          integração por módulo, com Postgres de verdade
docs/           contrato de analytics para os clientes e base da versão web
```

Cada módulo tem serviço (regra de negócio), rotas (contrato HTTP) e schemas
Zod. As migrations são SQL escrito à mão porque RLS, índices únicos parciais e
gatilhos não sobrevivem à geração automática.

Operação, alertas, backups e lançamento gradual: [DEPLOY.md](DEPLOY.md).
Arquitetura, entidades, regras de negócio e orientações para quem for mexer no
código: [AGENTS.md](AGENTS.md).
