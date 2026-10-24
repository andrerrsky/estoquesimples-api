/**
 * Categorias do blog. Fixas no código (e não numa tabela) de propósito: são
 * poucas, aparecem na navegação do site, nos filtros e no prompt da IA, e
 * uma categoria nova é uma decisão editorial que merece um deploy.
 */
export interface BlogCategory {
  slug: string;
  label: string;
  /** Uma linha, usada como descrição da listagem por categoria (SEO). */
  description: string;
}

export const BLOG_CATEGORIES: readonly BlogCategory[] = [
  {
    slug: 'controle-de-estoque',
    label: 'Controle de estoque',
    description: 'Como organizar, contar e manter o estoque em dia, sem planilha bagunçada e sem produto faltando.',
  },
  {
    slug: 'gestao-do-negocio',
    label: 'Gestão do negócio',
    description: 'Rotinas, decisões e números para quem toca um pequeno negócio com estoque: mercearia, loja, pet shop, distribuidora.',
  },
  {
    slug: 'vendas',
    label: 'Vendas e atendimento',
    description: 'Vender mais na loja física e online com o estoque certo, do balcão ao WhatsApp e aos marketplaces.',
  },
  {
    slug: 'financas',
    label: 'Finanças e compras',
    description: 'Capital parado, margem, reposição e compras: o lado financeiro do estoque explicado de forma simples.',
  },
  {
    slug: 'como-fazer',
    label: 'Como fazer no app',
    description: 'Passo a passo das funcionalidades do Estoque Simples no celular e na web.',
  },
  {
    slug: 'novidades',
    label: 'Novidades',
    description: 'O que mudou no Estoque Simples: recursos novos, melhorias e avisos para quem usa.',
  },
] as const;

export const BLOG_CATEGORY_SLUGS = BLOG_CATEGORIES.map((category) => category.slug) as [string, ...string[]];

export function blogCategory(slug: string): BlogCategory | null {
  return BLOG_CATEGORIES.find((category) => category.slug === slug) ?? null;
}
