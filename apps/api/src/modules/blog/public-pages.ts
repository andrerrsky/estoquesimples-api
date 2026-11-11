import { applyHead, breadcrumb, organization } from './blog-ssr.js';
import { answerText, helpContent } from './help-content.js';

/**
 * Cabeçalho certo para as páginas públicas que a aplicação React desenha
 * (central de ajuda, onde usar, termos, privacidade, entrar, criar conta).
 *
 * Sem isto, o servidor mandava o index.html com o título, a descrição e o
 * canonical da PÁGINA INICIAL: para o Google e para os robôs de IA (que não
 * executam JavaScript) essas páginas eram cópias da home. Agora cada uma sai
 * com o próprio título, descrição e canonical, e a ajuda leva as perguntas e
 * respostas como FAQ estruturado — o texto que um assistente consegue citar.
 *
 * As demais rotas da aplicação (área logada, convite, redefinir senha,
 * entrada de empresa) saem sem canonical e com `noindex`.
 */

const SITE = 'https://estoquesimples.com.br';
const IMAGE = `${SITE}/og.jpg`;

interface PublicPage {
  title: string;
  description: string;
  crumb: string;
  jsonLd?: () => unknown[];
}

const PAGES: Record<string, PublicPage> = {
  '/ajuda': {
    title: 'Central de ajuda do Estoque Simples: perguntas e respostas',
    description: 'Respostas sobre o Estoque Simples: primeiros passos, produtos e movimentações, celular e computador, sincronização, equipe, plano e pagamento.',
    crumb: 'Central de ajuda',
    jsonLd: () => {
      const articles = helpContent().articles.filter((article) => !article.platforms || article.platforms.includes('web'));
      if (articles.length === 0) return [];
      return [
        {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          '@id': `${SITE}/ajuda#faq`,
          url: `${SITE}/ajuda`,
          inLanguage: 'pt-BR',
          publisher: organization(),
          mainEntity: articles.map((article) => ({ '@type': 'Question', name: article.question, acceptedAnswer: { '@type': 'Answer', text: answerText(article) } })),
        },
      ];
    },
  },
  '/plataformas': {
    title: 'Onde usar o Estoque Simples: Android, computador, iPhone e iPad',
    description: 'O mesmo estoque no app Android, no navegador do computador e no iPhone ou iPad como web app na tela inicial. Veja como instalar e usar em cada um.',
    crumb: 'Onde usar',
  },
  '/termos': {
    title: 'Termos de Uso | Estoque Simples',
    description: 'Termos de Uso do Estoque Simples: regras do serviço, planos, pagamento, cancelamento e responsabilidades.',
    crumb: 'Termos de Uso',
  },
  '/privacidade': {
    title: 'Política de Privacidade | Estoque Simples',
    description: 'Como o Estoque Simples trata os seus dados: o que é coletado, para quê, por quanto tempo e como exercer os seus direitos pela LGPD.',
    crumb: 'Política de Privacidade',
  },
  '/criar-conta': {
    title: 'Criar conta grátis | Estoque Simples',
    description: 'Crie a sua conta grátis no Estoque Simples, sem cartão. A mesma conta vale no app Android e na versão web.',
    crumb: 'Criar conta',
  },
  // Landing da campanha (docs/black-friday-2026.md). Indexável durante e
  // depois da campanha: a página diz se a oferta está vigente, terminou ou vai começar.
  '/black-friday': {
    title: 'Black Friday Estoque Simples: plano anual com 40% off',
    description: 'Black Friday do Estoque Simples: plano Equipe anual de R$ 199,90 por R$ 119,90 (equivale a R$ 9,99/mês) ou 1º mês por R$ 12,49. De 20/11 a 01/12/2026.',
    crumb: 'Black Friday',
  },
  '/entrar': {
    title: 'Entrar | Estoque Simples',
    description: 'Entre no Estoque Simples com a mesma conta do aplicativo Android para ver e movimentar o seu estoque no navegador.',
    crumb: 'Entrar',
  },
};

/** Caminhos com cabeçalho próprio (indexáveis); o servidor monta o HTML de cada um no boot. */
export const PUBLIC_APP_PATHS: readonly string[] = Object.keys(PAGES);

export function isPublicAppPage(path: string): boolean {
  return Object.hasOwn(PAGES, path);
}

/** O index.html com o cabeçalho da página pública (ou `null` se não for uma delas). */
export function publicPageHtml(template: string, path: string): string | null {
  const page = PAGES[path];
  if (!page) return null;
  const url = `${SITE}${path}`;
  return applyHead(template, {
    title: page.title,
    description: page.description,
    canonical: url,
    type: 'website',
    image: IMAGE,
    imageAlt: 'Estoque Simples',
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        '@id': `${url}#page`,
        url,
        name: page.title,
        description: page.description,
        inLanguage: 'pt-BR',
        isPartOf: { '@type': 'WebSite', '@id': `${SITE}/#site`, name: 'Estoque Simples', url: SITE },
        publisher: organization(),
      },
      breadcrumb([
        { name: 'Início', url: `${SITE}/` },
        { name: page.crumb, url },
      ]),
      ...(page.jsonLd?.() ?? []),
    ],
  });
}

/** O index.html para as rotas que não devem ir para buscadores: sem canonical da home e com noindex. */
export function privateAppHtml(template: string): string {
  return template.replace(/<link rel="canonical" href="[^"]*" \/>\n?/, '').replace('</head>', '    <meta name="robots" content="noindex, follow" />\n  </head>');
}
