-- De onde veio quem se cadastrou pela web: UTMs, o identificador do clique no
-- anúncio (gclid/gbraid/wbraid) e a escolha sobre cookies. Serve para medir
-- campanhas no painel e, para quem aceitou, informar ao Google Ads que o
-- clique virou ativação (importação de conversões offline). Nulo para quem
-- não chegou por campanha e para cadastros pelo app.
ALTER TABLE users ADD COLUMN signup_attribution jsonb;
