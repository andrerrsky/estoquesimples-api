/**
 * Página de exibição do vídeo de apresentação (`/video`).
 *
 * Existe por um motivo específico de busca: o Search Console recusava
 * indexar o vídeo da página inicial com "o vídeo não está em uma página de
 * exibição — é um conteúdo complementar na página". O Google só indexa um
 * vídeo quando ele é o **conteúdo principal** de uma página, e na home ele
 * é uma seção entre várias. Esta página existe para ser esse lugar: o
 * player é a primeira coisa, e o resto do texto fala do vídeo.
 *
 * É renderizada só no build (`scripts/prerender.mjs`), em HTML estático,
 * sem bundle e sem hidratação: `<video controls>` é nativo e os links são
 * `<a>` comuns, então não há nada para o JavaScript fazer aqui. O JSON-LD
 * `VideoObject` acompanha a página — saiu da home junto com esta mudança,
 * para o Google ter uma página de exibição só.
 *
 * A transcrição vem da própria legenda (`public/video/apresentacao.vtt`),
 * lida no build: não há um segundo texto para manter em dia, e a página
 * deixa de ser só um player (o que o Google trata como conteúdo raso).
 */
import { VIDEO } from './LandingPage';

/**
 * Link da Play com a origem própria desta página: quem baixa depois de
 * assistir entra como `utm_medium=video`, não misturado com a home.
 */
const PLAY_URL = `https://play.google.com/store/apps/details?id=br.com.gameloop.estoquesimples&referrer=${encodeURIComponent('utm_source=site&utm_medium=video')}`;

/** Um trecho da transcrição: o minuto em que começa e o que é dito. */
export type TranscriptBlock = { time: string; text: string };

export function VideoPage({ transcript }: { transcript: TranscriptBlock[] }) {
  return (
    <div className="lp vp">
      <header className="landing__hero lp-on-brand">
        <div className="landing__nav">
          <a href="/" className="lp-brand">
            <img className="logo" src="/icon.svg" width="34" height="34" alt="" aria-hidden="true" /> Estoque Simples
          </a>
          {/* Um botão só: no celular a barra não comporta dois, e a marca
              à esquerda já é o caminho de volta para a página inicial. */}
          <div className="lp-nav__actions">
            <a href="/criar-conta" className="btn btn--on-brand">Criar conta grátis</a>
          </div>
        </div>
      </header>

      <main id="conteudo" className="vp-main">
        <div className="vp-head">
          <p className="lp-kicker">Vídeo · 1 min 40 s · com legenda</p>
          <h1 className="landing__title vp-title">Como o Estoque Simples funciona no dia a dia</h1>
          <p className="lp-lead">
            Cadastro de produtos, entradas e saídas, aviso de estoque baixo, relatórios, a conta grátis e o plano
            Equipe — tudo nas telas reais do aplicativo, sem simulação.
          </p>
        </div>

        <div className="lp-video__frame vp-frame">
          <video
            className="lp-video__player"
            controls
            playsInline
            preload="metadata"
            poster={VIDEO.poster}
            aria-label="Vídeo de apresentação do Estoque Simples, com narração e legendas"
          >
            <source src={VIDEO.src} type="video/mp4" />
            <track kind="captions" src="/video/apresentacao.vtt" srcLang="pt-BR" label="Português" default />
            Seu navegador não toca vídeos. <a href={VIDEO.src}>Baixe o vídeo</a>.
          </video>
        </div>

        <div className="vp-cta">
          <a href="/criar-conta" className="btn btn--primary btn--lg">Criar conta grátis</a>
          <a href={PLAY_URL} className="btn btn--secondary btn--lg" rel="noopener">Baixar na Google Play</a>
        </div>

        <section className="vp-section" aria-labelledby="vp-transcricao">
          <h2 className="landing__h2" id="vp-transcricao">Transcrição do vídeo</h2>
          <p className="lp-lead">
            O mesmo texto da narração, para quem prefere ler ou assiste sem som. O tempo é onde cada trecho começa.
          </p>
          <ol className="vp-transcript">
            {transcript.map((block) => (
              <li key={block.time}>
                <span className="vp-transcript__time">{block.time}</span>
                <span className="vp-transcript__text">{block.text}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="vp-section" aria-labelledby="vp-depois">
          <h2 className="landing__h2" id="vp-depois">Depois do vídeo</h2>
          <p className="lp-lead">
            A conta é grátis para uma pessoa, com os produtos guardados na nuvem e acesso pelo computador. O plano
            Equipe coloca todo mundo no mesmo estoque, sem cobrar por pessoa.
          </p>
          <ul className="vp-links">
            <li><a href="/">Ver tudo o que o aplicativo faz</a></li>
            <li><a href="/plataformas">Celular, computador e tablet</a></li>
            <li><a href="/ajuda">Central de ajuda</a></li>
            <li><a href="/blog">Blog: como organizar o estoque da loja</a></li>
          </ul>
        </section>
      </main>

      <footer className="vp-footer">
        <p>
          <a href="/">Estoque Simples</a> · Controle de estoque para pequenos negócios ·{' '}
          <a href="/termos">Termos</a> · <a href="/privacidade">Privacidade</a>
        </p>
      </footer>
    </div>
  );
}
