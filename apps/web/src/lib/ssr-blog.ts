/**
 * O blog chega pronto da API (blog-ssr.ts) e o JSON em `#blog-data` não
 * repete o HTML do post, que já está na página. Só que o main.tsx limpa o
 * `#root` antes de desenhar o React por cima, e a página do post é carregada
 * sob demanda: quando ela ia ler o HTML, ele já tinha saído da tela e o post
 * aparecia sem o texto (só cabeçalho e perguntas frequentes) em todo acesso
 * direto — link compartilhado, busca, toque na notificação.
 *
 * Por isso o main.tsx guarda o HTML aqui antes de limpar.
 */
let kept: string | null = null;

export function keepSsrBlogContent(root: ParentNode): void {
  const content = root.querySelector('[data-ssr] .blog-post__content');
  if (content) kept = content.innerHTML;
}

export function ssrBlogContent(): string {
  return kept ?? document.querySelector('[data-ssr] .blog-post__content')?.innerHTML ?? '';
}
