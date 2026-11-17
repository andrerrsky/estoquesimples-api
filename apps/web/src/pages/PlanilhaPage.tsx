/**
 * Página da planilha gratuita (`/planilha-de-controle-de-estoque`).
 *
 * Existe por um motivo medido: no Planejador de palavras-chave, as variações
 * de "planilha de controle de estoque" somam mais de 10 mil buscas por mês
 * no Brasil, contra pouco mais de 1.400 de todos os termos com
 * "app/aplicativo" juntos (ver docs/pautas-blog-2026-11.md). Quem procura
 * planilha é exatamente quem controla estoque na mão e ainda não cogitou um
 * aplicativo.
 *
 * A regra desta página: **ela entrega a planilha**. Sem cadastro, sem e-mail,
 * sem "clique para receber no seu WhatsApp" — o botão baixa o arquivo. O
 * aplicativo aparece depois, como o passo seguinte de quem cansou da
 * planilha, e dizendo com todas as letras o que a planilha não faz. Isca
 * escondida queima o tráfego que custou a vir.
 *
 * Como a /video, é HTML estático gerado em scripts/prerender.mjs: não há
 * nada aqui que precise de JavaScript.
 */

/** O arquivo servido. Nome fixo: é a URL que o Google vai indexar. */
export const PLANILHA = {
  arquivo: '/assets/planilha/planilha-controle-de-estoque.xlsx',
  nome: 'planilha-controle-de-estoque.xlsx',
  tamanho: '51 KB',
};

const PLAY_URL = `https://play.google.com/store/apps/details?id=br.com.gameloop.estoquesimples&referrer=${encodeURIComponent('utm_source=site&utm_medium=planilha')}`;

/** Perguntas que também viram JSON-LD (FAQPage) no prerender. */
export const DUVIDAS = [
  {
    p: 'A planilha é gratuita mesmo?',
    r: 'É. O arquivo baixa direto, sem cadastro e sem informar e-mail. Pode usar no seu negócio, editar e compartilhar à vontade.',
  },
  {
    p: 'Funciona no Excel e no Google Planilhas?',
    r: 'Sim. O arquivo é .xlsx: abre no Excel, no Google Planilhas (Arquivo › Importar), no LibreOffice e no Numbers. As fórmulas e os avisos de estoque baixo funcionam nos quatro.',
  },
  {
    p: 'Preciso saber fórmulas de Excel para usar?',
    r: 'Não. Você preenche só as colunas amarelas: produto, estoque mínimo, custo, e o que entra e o que sai. O saldo, o aviso de reposição e o valor do estoque já vêm calculados.',
  },
  {
    p: 'Quantos produtos cabem?',
    r: 'Até 500 produtos e 500 lançamentos, que atende a maioria dos pequenos negócios. Acima disso a planilha fica lenta — é o ponto em que vale usar um aplicativo.',
  },
  {
    p: 'Qual a diferença para o aplicativo?',
    r: 'A planilha mostra o que você digitou. O aplicativo avisa no celular quando um produto chega ao mínimo, lê código de barras com a câmera, guarda quem lançou cada movimento e deixa várias pessoas usarem ao mesmo tempo, sem uma sobrescrever a outra.',
  },
];

const DENTRO = [
  ['Produtos', 'O cadastro: código, nome, categoria, unidade, estoque mínimo e custo. O saldo e o aviso saem sozinhos.'],
  ['Entradas e saídas', 'Uma linha por movimento, com o produto escolhido numa lista — sem risco de digitar o nome diferente e bagunçar a conta.'],
  ['Resumo', 'Quantos produtos, quantos para repor, quantos zerados e quanto dinheiro está parado no estoque.'],
  ['Começar aqui', 'As instruções, em três passos, na primeira aba.'],
];

export function PlanilhaPage() {
  return (
    <div className="lp pl">
      <header className="landing__hero lp-on-brand">
        <div className="landing__nav">
          <a href="/" className="lp-brand">
            <img className="logo" src="/icon.svg" width="34" height="34" alt="" aria-hidden="true" /> Estoque Simples
          </a>
          <div className="lp-nav__actions">
            <a href="/criar-conta" className="btn btn--on-brand">Criar conta grátis</a>
          </div>
        </div>
        <div className="pl-hero">
          <p className="lp-eyebrow">Planilha gratuita · Excel e Google Planilhas</p>
          <h1 className="landing__title pl-title">Planilha de controle de estoque</h1>
          <p className="landing__lead pl-lead">
            Cadastre seus produtos, lance o que entra e o que sai, e veja o saldo, o aviso de reposição e o valor do
            estoque calculados sozinhos. Sem cadastro: o botão baixa o arquivo.
          </p>
          <p className="pl-baixar">
            <a className="btn btn--on-brand btn--lg" href={PLANILHA.arquivo} download={PLANILHA.nome}>
              Baixar a planilha grátis
            </a>
          </p>
          <p className="pl-meta">Arquivo .xlsx · {PLANILHA.tamanho} · sem e-mail, sem cadastro</p>
        </div>
      </header>

      <main id="conteudo" className="pl-main">
        <section className="pl-section" aria-labelledby="pl-dentro">
          <h2 className="landing__h2" id="pl-dentro">O que vem dentro</h2>
          <div className="pl-abas">
            {DENTRO.map(([nome, texto]) => (
              <div className="pl-aba" key={nome}>
                <h3 className="pl-aba__nome">{nome}</h3>
                <p>{texto}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="pl-section" aria-labelledby="pl-passos">
          <h2 className="landing__h2" id="pl-passos">Como usar, em três passos</h2>
          <ol className="pl-passos">
            <li>
              <strong>Cadastre os produtos.</strong> Na aba Produtos, preencha as colunas amarelas. O estoque mínimo é a
              quantidade que significa “está na hora de comprar”.
            </li>
            <li>
              <strong>Lance o que entra e o que sai.</strong> Uma linha por movimento, na hora em que acontece. É isso
              que faz a conta fechar no fim do mês.
            </li>
            <li>
              <strong>Acompanhe.</strong> A coluna Situação avisa “Repor” quando o produto chega ao mínimo, e o Resumo
              mostra quanto dinheiro está parado no estoque.
            </li>
          </ol>
        </section>

        <section className="pl-section pl-app" aria-labelledby="pl-app">
          <h2 className="landing__h2" id="pl-app">Quando a planilha começa a atrapalhar</h2>
          <p className="lp-lead">
            Planilha resolve bem no começo. Três coisas costumam marcar o limite:
          </p>
          <ul className="pl-limites">
            <li><strong>Ela não avisa.</strong> O produto acaba e você descobre quando o cliente pede.</li>
            <li><strong>Ela não vai para o balcão.</strong> Lançar no celular, no meio do atendimento, é desconfortável.</li>
            <li><strong>Ela briga com duas pessoas.</strong> Dois lançando ao mesmo tempo, uma sobrescreve a outra.</li>
          </ul>
          <p className="lp-lead">
            O Estoque Simples faz o que esta planilha faz e resolve esses três pontos: avisa no celular quando chega ao
            mínimo, lê código de barras com a câmera e guarda quem lançou cada movimento. É grátis para uma pessoa, com
            os produtos guardados na nuvem.
          </p>
          <p className="pl-cta">
            <a href="/criar-conta" className="btn btn--primary btn--lg">Criar conta grátis</a>
            <a href={PLAY_URL} className="btn btn--secondary btn--lg" rel="noopener">Baixar na Google Play</a>
          </p>
          <p className="pl-meta pl-meta--escuro">Dá para usar os dois: a planilha no computador e o aplicativo no balcão.</p>
        </section>

        <section className="pl-section" aria-labelledby="pl-duvidas">
          <h2 className="landing__h2" id="pl-duvidas">Dúvidas</h2>
          <dl className="pl-duvidas">
            {DUVIDAS.map((item) => (
              <div key={item.p}>
                <dt>{item.p}</dt>
                <dd>{item.r}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>

      <footer className="pl-footer">
        <p>
          <a href="/">Estoque Simples</a> · Controle de estoque para pequenos negócios ·{' '}
          <a href="/blog">Blog</a> · <a href="/ajuda">Ajuda</a> · <a href="/termos">Termos</a> ·{' '}
          <a href="/privacidade">Privacidade</a>
        </p>
      </footer>
    </div>
  );
}
