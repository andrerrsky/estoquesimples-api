/**
 * Página da planilha gratuita (`/planilha-de-controle-de-estoque`).
 *
 * Existe por um motivo medido: no Planejador de palavras-chave, as variações
 * de "planilha de controle de estoque" somam mais de 10 mil buscas por mês no
 * Brasil, contra pouco mais de 1.400 de todos os termos com "app/aplicativo"
 * juntos (ver docs/pautas-blog-2026-11.md).
 *
 * A regra desta página: **ela entrega a planilha**. Sem cadastro, sem e-mail.
 * O aplicativo aparece depois, dizendo o que a planilha não faz. Isca
 * escondida queima o tráfego que custou a vir.
 *
 * A prévia da aba Produtos é HTML, não uma imagem de print: fica legível no
 * celular, é indexável, funciona em leitor de tela e não desalinha quando a
 * planilha muda. As cores são as mesmas do arquivo (amarelo = você preenche,
 * cinza = calculado).
 *
 * Como a /video, é HTML estático gerado em scripts/prerender.mjs.
 */
import { PLAY_RATING } from './LandingPage';

/** O arquivo servido. Nome fixo: é a URL que o Google indexa. */
export const PLANILHA = {
  arquivo: '/assets/planilha/planilha-controle-de-estoque.xlsx',
  nome: 'planilha-controle-de-estoque.xlsx',
  tamanho: '52 KB',
  versao: '2',
  atualizada: 'novembro de 2026',
  atualizadaIso: '2026-11-16',
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
    r: 'Sim. O arquivo é .xlsx: abre no Excel, no Google Planilhas (Arquivo › Importar), no LibreOffice e no Numbers. É um controle de estoque no Excel pronto — você não precisa montar nenhuma fórmula.',
  },
  {
    p: 'Preciso saber fórmulas de Excel para usar?',
    r: 'Não. Você preenche só as colunas amarelas: produto, estoque mínimo, custo, e o que entra e o que sai. O saldo, o aviso de reposição e o valor do estoque já vêm calculados.',
  },
  {
    p: 'Quantos produtos cabem?',
    r: 'Até 500 produtos e 500 lançamentos, o que atende a maioria dos pequenos negócios. Acima disso qualquer planilha de estoque fica lenta — é o ponto em que vale usar um aplicativo.',
  },
  {
    p: 'Qual a diferença para o aplicativo?',
    r: 'A planilha mostra o que você digitou. O aplicativo avisa no celular quando um produto chega ao mínimo, lê código de barras com a câmera, guarda quem lançou cada movimento e deixa várias pessoas usarem ao mesmo tempo, sem uma sobrescrever a outra.',
  },
];

const FAZ = [
  ['Saldo automático', 'Lance o que entra e o que sai. A quantidade de cada produto se atualiza sozinha.'],
  ['Aviso de estoque baixo', 'Chegou no mínimo que você definiu, a planilha marca “Repor” em vermelho.'],
  ['Valor do estoque', 'Quanto dinheiro está parado em mercadoria, somado na hora.'],
  ['Lista de produtos pronta', 'O produto é escolhido numa lista, não digitado. Nome errado não quebra a conta.'],
];

/** As cinco abas do arquivo, com as colunas de cada uma. */
const ABAS = [
  ['Começar aqui', 'As instruções em três passos, para abrir e já saber o que fazer.'],
  ['Produtos', 'Código, Produto, Categoria, Unidade, Estoque mínimo, Custo — e, calculadas, Entradas, Saídas, Saldo atual, Situação e Valor em estoque.'],
  ['Entradas e saídas', 'Data, Produto, Tipo (entrada ou saída), Quantidade e Observação. Uma linha por movimento.'],
  ['Resumo', 'Produtos cadastrados, movimentações, quantos repor, quantos zerados e o dinheiro parado no estoque.'],
  ['Aplicativo grátis', 'O que o aplicativo faz além da planilha, se um dia ela ficar apertada.'],
];

/** Linhas da prévia. `situacao` controla a cor, como na planilha. */
const PREVIA = [
  { cod: '001', nome: 'Água de coco 1 L', min: 20, custo: 'R$ 3,50', ent: 120, sai: 48, saldo: 72, situacao: 'Tudo certo', valor: 'R$ 252,00' },
  { cod: '002', nome: 'Suco de laranja 1 L', min: 10, custo: 'R$ 4,20', ent: 40, sai: 30, saldo: 10, situacao: 'Repor', valor: 'R$ 42,00' },
  { cod: '003', nome: 'Tampas', min: 5, custo: 'R$ 12,00', ent: 8, sai: 8, saldo: 0, situacao: 'Sem estoque', valor: 'R$ 0,00' },
];

const BAIXAR = (
  <>
    <p className="pl-baixar">
      <a
        className="btn btn--on-brand btn--lg"
        href={PLANILHA.arquivo}
        download={PLANILHA.nome}
        data-ga="download_planilha"
        aria-describedby="pl-arquivo"
      >
        Baixar a planilha grátis
      </a>
    </p>
    <p className="pl-meta" id="pl-arquivo">Arquivo .xlsx · {PLANILHA.tamanho} · sem e-mail, sem cadastro</p>
  </>
);

/** O mesmo botão, nas seções do meio da página (fundo claro). */
function BaixarDeNovo({ id }: { id: string }) {
  return (
    <p className="pl-baixar pl-baixar--meio">
      <a className="btn btn--primary btn--lg" href={PLANILHA.arquivo} download={PLANILHA.nome} data-ga="download_planilha" aria-describedby={id}>
        Baixar a planilha grátis
      </a>
      <span className="pl-meta pl-meta--escuro" id={id}>Arquivo .xlsx · {PLANILHA.tamanho} · sem e-mail, sem cadastro</span>
    </p>
  );
}

export function PlanilhaPage() {
  return (
    <div className="lp pl">
      <a className="lp-skip" href="#conteudo">Pular para o conteúdo</a>
      <header className="landing__hero lp-on-brand">
        <nav className="landing__nav" aria-label="Principal">
          <a href="/" className="lp-brand">
            <img className="logo" src="/icon.svg" width="34" height="34" alt="" aria-hidden="true" /> Estoque Simples
          </a>
          <div className="lp-nav__actions">
            <a href="/" className="lp-nav__link">Conheça o aplicativo</a>
          </div>
        </nav>
        <div className="pl-hero">
          <p className="lp-eyebrow">Planilha gratuita · Excel e Google Planilhas</p>
          <h1 className="landing__title pl-title">Planilha de controle de estoque</h1>
          <p className="landing__lead pl-lead">
            Registre entrada e saída de produtos; o saldo, o aviso de reposição e o valor do estoque se calculam
            sozinhos.
          </p>
          {BAIXAR}
        </div>
      </header>

      <main id="conteudo" className="pl-main">
        <section className="pl-section" aria-labelledby="pl-faz">
          <h2 className="landing__h2" id="pl-faz">O que a planilha faz por você</h2>
          <div className="pl-abas">
            {FAZ.map(([nome, texto]) => (
              <div className="pl-aba" key={nome}>
                <h3 className="pl-aba__nome">{nome}</h3>
                <p>{texto}</p>
              </div>
            ))}
          </div>

          {/* Prévia da aba Produtos, com as cores do arquivo. */}
          <figure className="pl-previa">
            <figcaption className="pl-previa__legenda">
              A aba <strong>Produtos</strong>, como ela abre: você preenche as colunas amarelas, as cinzas são
              calculadas.
            </figcaption>
            <div className="pl-previa__rolagem">
              <table className="pl-tabela">
                <caption className="sr-only">Exemplo da aba Produtos com três itens cadastrados</caption>
                <thead>
                  <tr>
                    <th scope="col" className="pl-th--entrada">Código</th>
                    <th scope="col" className="pl-th--entrada">Produto</th>
                    <th scope="col" className="pl-th--entrada">Estoque mínimo</th>
                    <th scope="col" className="pl-th--entrada">Custo</th>
                    <th scope="col">Entradas</th>
                    <th scope="col">Saídas</th>
                    <th scope="col">Saldo atual</th>
                    <th scope="col">Situação</th>
                    <th scope="col">Valor em estoque</th>
                  </tr>
                </thead>
                <tbody>
                  {PREVIA.map((l) => (
                    <tr key={l.cod}>
                      <td className="pl-td--entrada">{l.cod}</td>
                      <td className="pl-td--entrada">{l.nome}</td>
                      <td className="pl-td--entrada pl-num">{l.min}</td>
                      <td className="pl-td--entrada pl-num">{l.custo}</td>
                      <td className="pl-num">{l.ent}</td>
                      <td className="pl-num">{l.sai}</td>
                      <td className="pl-num"><strong>{l.saldo}</strong></td>
                      <td>
                        <span className={`pl-situacao pl-situacao--${l.situacao === 'Repor' ? 'repor' : l.situacao === 'Sem estoque' ? 'zerado' : 'ok'}`}>
                          {l.situacao}
                        </span>
                      </td>
                      <td className="pl-num">{l.valor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </figure>
        </section>

        <section className="pl-section" aria-labelledby="pl-abas-titulo">
          <h2 className="landing__h2" id="pl-abas-titulo">O que vem dentro: entrada e saída, saldo e resumo</h2>
          <p className="lp-lead">O arquivo tem cinco abas, nesta ordem:</p>
          <dl className="pl-lista-abas">
            {ABAS.map(([nome, texto]) => (
              <div key={nome}>
                <dt>{nome}</dt>
                <dd>{texto}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="pl-section" aria-labelledby="pl-passos">
          <h2 className="landing__h2" id="pl-passos">Como usar, em três passos</h2>
          <ol className="pl-passos">
            <li>
              <strong>Cadastre os produtos.</strong> Na aba Produtos, preencha as colunas amarelas. O estoque mínimo é
              a quantidade que significa “está na hora de comprar” — se não souber qual é a sua, veja{' '}
              <a href="/blog/estoque-minimo-como-definir-para-nunca-faltar-produto">como definir o estoque mínimo de cada produto</a>.
            </li>
            <li>
              <strong>Lance entrada e saída de produtos.</strong> Uma linha por movimento, na hora em que acontece. É
              isso que faz a conta fechar no fim do mês — e é o que o{' '}
              <a href="/blog/historico-de-estoque-por-que-registrar-entradas-e-saidas">histórico de entradas e saídas</a> resolve.
            </li>
            <li>
              <strong>Acompanhe.</strong> A coluna Situação avisa “Repor” quando o produto chega ao mínimo, e o Resumo
              mostra quanto dinheiro está parado no estoque.
            </li>
          </ol>
          <BaixarDeNovo id="pl-arquivo-passos" />
        </section>

        <section className="pl-section" aria-labelledby="pl-minimo">
          <h2 className="landing__h2" id="pl-minimo">Como definir o estoque mínimo de cada produto</h2>
          <p>
            O estoque mínimo é quanto precisa sobrar na prateleira para você comprar sem correr o risco de faltar. A
            conta é simples: <strong>quanto sai por dia × quantos dias o fornecedor demora para entregar</strong>, com
            uma folga.
          </p>
          <p>
            Numa mercearia que vende 8 águas de coco por dia e recebe do fornecedor a cada 3 dias, o mínimo fica em
            torno de 24 unidades — 8 × 3. Some a folga para o fim de semana e use 30. Esse é o número que vai na coluna
            Estoque mínimo. Produto que sai pouco mas demora a chegar precisa de mínimo alto; produto que você compra
            na esquina pode ter mínimo baixo.
          </p>
          <p>
            <a href="/blog/estoque-minimo-como-definir-para-nunca-faltar-produto">Veja o passo a passo completo, com mais exemplos</a>.
          </p>
        </section>

        <section className="pl-section" aria-labelledby="pl-google">
          <h2 className="landing__h2" id="pl-google">Como usar a planilha no Google Planilhas</h2>
          <p>Não precisa ter o Excel pago. Para abrir no Google Planilhas, de graça:</p>
          <ol className="pl-passos">
            <li>Baixe o arquivo no botão acima.</li>
            <li>Abra <strong>planilhas.google.com</strong> e entre com sua conta do Google.</li>
            <li>Clique em <strong>Arquivo › Importar › Fazer upload</strong> e escolha o arquivo baixado.</li>
            <li>Em “Importar arquivo”, escolha <strong>Criar nova planilha</strong> e confirme.</li>
          </ol>
          <p>
            As fórmulas, as listas de produto e as cores de aviso continuam funcionando. A partir daí ela fica salva na
            sua conta e abre do celular pelo app do Google Planilhas.
          </p>
        </section>

        <section className="pl-section" aria-labelledby="pl-contagem">
          <h2 className="landing__h2" id="pl-contagem">Como conferir se a planilha bate com a prateleira</h2>
          <p>
            De tempos em tempos vale contar o que existe de verdade e comparar com o Saldo atual. Quando os dois números
            não batem, a diferença tem nome: compra que não foi lançada, venda esquecida, perda ou quebra.
          </p>
          <p>
            Não precisa fechar a loja para isso: conte por categoria, um pedaço por dia, e corrija na planilha lançando
            a diferença como entrada ou saída, com a observação do motivo.{' '}
            <a href="/blog/como-fazer-contagem-de-estoque-sem-fechar-a-loja">Veja como fazer a contagem sem fechar a loja</a> e{' '}
            <a href="/blog/perdas-no-estoque-como-medir-e-reduzir-em-mercadinhos">como medir as perdas</a>.
          </p>
        </section>

        <section className="pl-section pl-app" aria-labelledby="pl-app">
          <h2 className="landing__h2" id="pl-app">Quando vale trocar por um aplicativo de controle de estoque</h2>
          <p className="lp-lead">Planilha resolve bem no começo. Três coisas costumam marcar o limite:</p>
          <ul className="pl-limites">
            <li><strong>Ela não avisa.</strong> O produto acaba e você descobre quando o cliente pede.</li>
            <li><strong>Ela não vai para o balcão.</strong> Lançar no celular, no meio do atendimento, é desconfortável.</li>
            <li><strong>Ela briga com duas pessoas.</strong> Dois lançando ao mesmo tempo, uma sobrescreve a outra.</li>
          </ul>
          <p>
            O Estoque Simples faz o que esta planilha faz e resolve esses três pontos: avisa no celular quando chega ao
            mínimo, lê código de barras com a câmera e guarda quem lançou cada movimento.
          </p>
          <p className="pl-prova">
            <strong>{PLAY_RATING.stars} na Google Play</strong>, com {PLAY_RATING.count} e {PLAY_RATING.users}.
          </p>
          <p className="pl-cta">
            <a href="/criar-conta" className="btn btn--primary btn--lg">Criar conta grátis</a>
            <a href={PLAY_URL} className="btn btn--secondary btn--lg" rel="noopener">Baixar na Google Play</a>
          </p>
          <p className="pl-meta pl-meta--escuro">
            Grátis para uma pessoa, sem cartão. Para a equipe toda lançar junto, o plano Equipe custa R$ 24,99 por mês —{' '}
            <a href="/#planos">veja o que muda</a>. Dá para usar os dois: a planilha no computador e o aplicativo no balcão.
          </p>
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
          <BaixarDeNovo id="pl-arquivo-duvidas" />
          <p className="pl-versao">
            Planilha criada e mantida pela equipe do Estoque Simples · versão {PLANILHA.versao}, atualizada em{' '}
            {PLANILHA.atualizada}.
          </p>
        </section>

        <section className="pl-section" aria-labelledby="pl-depois">
          <h2 className="landing__h2" id="pl-depois">Para ler depois do download</h2>
          <ul className="pl-links">
            <li><a href="/blog/estoque-minimo-como-definir-para-nunca-faltar-produto">Estoque mínimo: como definir para nunca faltar produto</a></li>
            <li><a href="/blog/como-fazer-contagem-de-estoque-sem-fechar-a-loja">Como fazer contagem de estoque sem fechar a loja</a></li>
            <li><a href="/blog/giro-de-estoque-como-calcular-e-o-que-significa">Giro de estoque: como calcular e o que significa</a></li>
            <li><a href="/blog/estoque-parado-como-identificar-e-evitar-compras-erradas">Estoque parado: como identificar e evitar compras erradas</a></li>
          </ul>
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
