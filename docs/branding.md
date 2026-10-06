# Identidade visual por empresa (white-label leve)

Cada empresa assinante do plano Equipe pode aplicar **a sua identidade visual**
ao Estoque Simples: cor principal, cor de destaque, cor do texto, fonte e
logotipo, mais uma página de entrada própria (`/<identificador>/entrar`).

> **Princípio:** mesma aplicação, mesma estrutura, mesmos fluxos. A
> personalização é uma camada de *tokens* sobre a interface única. Não existe
> layout, componente ou tela por empresa, e nenhuma regra de negócio muda.

## Quem decide o quê

| | Decide |
| --- | --- |
| A empresa tem direito? | **a API**, pelo plano em vigor (`plan_features` → `marca.personalizada`), a cada leitura. Nunca uma coluna, nunca o cliente |
| As cores são aceitáveis? | a API (contraste WCAG) — a tela de edição só pré-visualiza pela rota `POST …/branding/preview` |
| Quem configura? | permissão `marca.gerenciar` (proprietário e administrador) |
| O que é aplicado | `entitlement.branding` (retrato de direitos): `active`, `theme`, `logo` |

Sem plano, sem configuração, bloqueada pelo painel, configuração que deixou
de passar nas regras ou qualquer falha ao carregar → `active=false` → os
clientes usam o visual padrão. A configuração **não é apagada** quando a
assinatura acaba: reassinar restaura.

## Modelo de dados (migration 0017)

- `workspace_brandings` (1 por empresa, RLS): `slug` (único), `primary_color`,
  `accent_color`, `text_color` (`#rrggbb` ou NULL = padrão), `font`
  (`default` | `serif`), metadados do logotipo, `blocked_at/blocked_reason`
  (painel), `version` (sobe a cada alteração).
- `brand_slug_reservations`: identificador abandonado fica reservado à empresa
  de origem por 90 dias (evita que outra empresa ocupe o endereço antigo).
- Permissão `marca.gerenciar`; recurso `marca.personalizada` (gratuito: não;
  `basico`/Equipe: sim — editável em Planos).
- O logotipo é um objeto no bucket (`workspaces/<id>/brand/<hash>.webp`), fora
  da cota de fotos. Nenhum binário no banco.

## Regras

**Identificador (slug)** — `brand-rules.ts`: normalizado (minúsculas, sem
acentos, `a-z0-9-`), 3 a 32 caracteres, sem hífen nas pontas/repetido, não só
números, fora da lista de reservados (rotas do produto, `admin`, `api`,
`suporte`, `oficial`…), único. Nunca é o nome da empresa cru (a tela sugere a
versão normalizada). Trocar: o antigo fica reservado e redireciona.

**Cores** — só `#RRGGBB`. Contraste mínimo (WCAG 2.x): principal **4,5:1**
com branco (é fundo de texto branco *e* cor de texto), destaque **4,5:1**,
texto **7:1** (contra branco e contra o fundo `#f4f7fa`). Reprovada → 422
`BRAND_INVALID` com `suggestions` (versão escurecida). A API deriva a paleta
(escura, pressionada, suave, tinta, texto secundário ≥ 4,5:1): clientes só
aplicam. Cores semânticas (sucesso, alerta, erro) **não** são personalizáveis.

**Fonte** — `default` ou `serif`, sempre fontes já instaladas no aparelho
(a CSP não admite fonte de terceiros, e isso evita rastreio).

**Logotipo** — mesma pipeline de imagens da API (`image-processing.ts`):
tipo pelo conteúdo, decodificação real, sem animação, reduzido a **640 px**,
WebP com transparência de até **256 KiB**; envio de até 1 MiB.

## Superfícies da API

| Rota | Quem | Para quê |
| --- | --- | --- |
| `GET/PUT/DELETE /v1/workspaces/:id/branding` | `marca.gerenciar` | ler, salvar (substitui), voltar ao padrão |
| `POST …/branding/preview` | `marca.gerenciar` | valida e devolve a paleta derivada, sem salvar |
| `PUT/DELETE …/branding/logo` | `marca.gerenciar` | enviar (corpo = bytes) / remover |
| `GET /v1/workspaces/:id/entitlement` → `branding` | qualquer membro | o que aplicar. Sai junto com o plano e some junto com ele |
| `GET /v1/public/brand/:slug` | público | marca ativa para a tela de entrada; `{active:false}` para inexistente/sem plano/bloqueada (indistinguíveis: não serve para descobrir clientes). Cache 60 s |
| `GET /v1/public/brand/:slug/logo?v=<hash>` | público | logotipo; `?v` igual ao atual = imutável 1 ano; `nosniff`, CSP `sandbox` |

Isolamento: escrita sempre em `inWorkspace` (RLS) e conferência de slug em
contexto de sistema. Auditoria: `brand.updated|logo_changed|logo_removed|reset|blocked|unblocked`.
Analytics: `brand.updated`, `brand.logo_uploaded`, `brand.logo_removed`,
`brand.reset` (API) e `brand.login_viewed`, `brand.applied` (clientes).

## Web (`apps/web`)

- `lib/brand.ts`: aplica a paleta como variáveis CSS inline em `:root`
  (`--brand`, `--accent`, `--text`, `--font`…) e `theme-color`. Sair do
  provedor/logout remove tudo e volta aos tokens de `packages/design`. A
  última marca fica em `localStorage` (`es_web_brand`) só para abrir sem piscar
  o azul padrão; é apagada ao sair.
- `components/BrandMark.tsx`: único ponto do logotipo (no lugar do símbolo do
  produto).
- `/app/marca` (`BrandPage`): editor com pré-visualização ao vivo (a interface
  inteira já aparece com a paleta) — só visível a `marca.gerenciar`.
- `/:slug/entrar` (`BrandedLoginPage`): **a mesma** `LoginPage`, com tema e
  logotipo por cima. Depois de entrar, abre a empresa daquele identificador se
  a pessoa participa dela (`brandSlug` na lista de empresas).

## Android

- O retrato de direitos já traz `branding`; `EntitlementManager` o entrega a
  `branding/BrandStore` (vale pelo mesmo prazo offline do plano) e baixa o
  logotipo (`BrandLogo`, arquivo nomeado pelo hash).
- `BrandApplier.apply` (em `BaseActivity`, antes de inflar): a partir do
  **Android 11** usa a sobreposição de recursos do Material
  (`ColorResourcesOverride`) para trocar os `@color/…` do tema — layouts,
  ícones vetoriais e estilos mudam sem editar nenhum. Abaixo disso, aplica o que
  o código controla (barra superior/inferior, destaques em texto, logotipo).
  Fonte com serifa via `LayoutInflater.Factory2`.
- Novo recurso `color_accent` (= cor principal por padrão) para links e valores
  em destaque. Código que lê cor fora de uma Activity usa `BrandStore.color()`.
- A splash screen do sistema continua azul (o sistema a desenha antes do app).
- A edição é feita na web; o Android só exibe.

## Painel administrativo

Detalhe da empresa → cartão **Identidade visual** (situação, endereço, cores,
logotipo) e ações **Bloquear/Liberar** (com motivo, auditado). O recurso é
ligado/desligado por plano em **Planos** (`marca.personalizada`).

## Variáveis

| Variável | Para quê |
| --- | --- |
| `BRAND_PUBLIC_CACHE_MS` | cache em memória da marca pública (padrão 30000; 0 desliga) |

O logotipo usa o mesmo bucket (`S3_*`) das fotos ([images.md](images.md)).

## Como validar

1. Com uma empresa assinante: `/app/marca` → identificador, cores, logotipo →
   Salvar. A web muda na hora; o Android muda na próxima sincronização/abertura.
2. `/<identificador>/entrar` (janela anônima): mesma tela de entrada, com marca.
3. Identificador inexistente ou empresa sem plano: tela padrão.
4. Expirar a assinatura (ou desligar `marca.personalizada` em Planos): web e
   Android voltam ao padrão sem apagar a configuração.
