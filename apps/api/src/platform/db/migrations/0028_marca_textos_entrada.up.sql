-- Textos da página de entrada da empresa (/<slug>/entrar). Nulos = padrão:
-- o nome da empresa como título e "Painel de controle de estoque" embaixo.
ALTER TABLE workspace_brandings ADD COLUMN login_title text;
ALTER TABLE workspace_brandings ADD COLUMN login_subtitle text;
