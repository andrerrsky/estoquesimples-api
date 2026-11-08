# Entrar e criar conta com o Google (web)

Botão "Continuar com o Google" (Google Identity Services) em `/criar-conta`,
`/comece` e `/entrar`, e One Tap nas duas primeiras. Serve para entrar e para
criar conta: a API decide.

## Configuração

- Google Cloud, projeto **Estoque Simples** (`estoque-simples-f3604`), Google Auth
  Platform: público Externo, escopos básicos (openid, email, profile; sem
  verificação), cliente OAuth "Estoque Simples Web" (tipo Aplicativo da Web) com
  origens `https://estoquesimples.com.br`, `http://localhost:3000` e
  `http://localhost`. O app precisa estar **publicado** (Público-alvo › Publicar
  app); em "Teste" só usuários de teste entram.
- Railway: `GOOGLE_OAUTH_CLIENT_ID` (não é segredo; a página o recebe por
  `GET /v1/auth/web/config`). Sem a variável, o botão não aparece e
  `POST /v1/auth/web/google` responde 404. Não há client secret: o fluxo usa só o
  ID token.
- CSP da web libera `https://accounts.google.com` (script, estilo, iframe do
  botão/One Tap e conexões).

## Regras (sem conflito de dados)

`POST /v1/auth/web/google { credential, device, attribution? }`:

1. Confere o ID token com as chaves públicas do Google (`jose`): emissor,
   `aud` = Client ID, validade. Exige **e-mail confirmado pelo Google**.
2. Conta Google já ligada (`user_identities`) → entra.
3. Senão, conta viva com o mesmo e-mail (comparação em minúsculas) → **liga** o
   Google a ela (auditoria `user.google_linked`), confirma o e-mail e entra. O
   `signup_method` continua `email` e a senha continua valendo.
4. Senão, cria a conta **sem senha**, e-mail confirmado, `signup_method = google`,
   com a origem do anúncio (`signup_attribution`), a empresa automática e as
   boas-vindas (`isNew: true`).

Corrida (duas entradas simultâneas na primeira vez): as restrições únicas
`(provider, provider_user_id)` e `(user_id, provider)` barram a segunda, que tenta
de novo e cai no caso 2 ou 3. Vínculo de conta excluída é removido antes de ligar
de novo. Conta suspensa ou com exclusão pendente recebe a mesma recusa do login
por senha.

Conta sem senha:
- login por senha recebe a mesma resposta (e o mesmo custo) de senha errada; a
  tela sugere "Continuar com o Google";
- pode **criar senha** em Minha conta (sem senha atual) ou por "Esqueci minha
  senha";
- exclui a conta confirmando o próprio e-mail (no lugar da senha).

## Medição

- `users.signup_method` (`email` | `google`): coluna e filtro "Cadastro" em
  Painel › Usuários.
- Cards em Usuários (30 dias): cadastro normal, cadastro com Google, cliques no
  botão do Google (evento `signup.google_clicked`, por aparelho e dia) e entradas
  com Google (com contas vinculadas).
- Eventos: `user.registered` e `user.logged_in` com `method: google`; no GA,
  `sign_up` / `login` com `method: google`.
- `signup.started` continua sendo a primeira digitação no formulário; o clique no
  Google é medido à parte.
