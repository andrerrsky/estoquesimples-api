-- Post exclusivo para quem tem conta: no site público aparece só o começo, com convite para se cadastrar.
ALTER TABLE blog_posts ADD COLUMN members_only boolean NOT NULL DEFAULT false;
