import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Icon, Logo } from '../components/Icon';
import { segmentContent } from '../lib/attribution';
import { landingTitleFor, PLAY_RATING } from './LandingPage';
import { RegisterForm, useRedirectIfAuthed } from './AuthPages';
import '../styles/comece.css';

/**
 * Página de destino dos anúncios (/comece). Diferente da página inicial, que
 * explica o produto para quem chega de qualquer lugar, esta tem um trabalho
 * só: levar quem clicou no anúncio a criar a conta. Sem menu e sem links que
 * tirem a pessoa daqui; título pelo segmento do anúncio (`utm_content`);
 * formulário de cadastro na própria página (um clique a menos que ir para
 * /criar-conta); provas e dúvidas comuns logo abaixo.
 *
 * A origem do anúncio é guardada como em qualquer página (`captureFirstTouch`
 * no App) e vai no cadastro com `landing=/comece`. Ver
 * docs/aquisicao-e-conversao.md §9.
 */
const BENEFITS = [
  { icon: 'box' as const, text: 'Cadastre os produtos e veja quanto tem de cada um, sem contar tudo de novo.' },
  { icon: 'bell' as const, text: 'Defina o estoque mínimo e saiba o que está acabando antes de faltar.' },
  { icon: 'phone' as const, text: 'No celular e no computador, com a mesma conta. Grátis para começar.' },
];

const FAQ = [
  { q: 'É grátis mesmo?', a: 'Sim. Uma pessoa usa grátis, com até 50 produtos na nuvem. O plano Equipe é para quem quer mais gente no mesmo estoque e produtos sem limite.' },
  { q: 'Preciso instalar alguma coisa?', a: 'Não. Funciona no navegador do celular ou do computador. Se preferir, há também o aplicativo Android, com a mesma conta.' },
  { q: 'Já tenho uma planilha. Perco tudo?', a: 'Não: depois de criar a conta, use "Importar planilha" e traga a lista inteira de uma vez.' },
];

export function ComecePage() {
  const redirect = useRedirectIfAuthed();
  // Título do segmento só depois do mount (a primeira pintura usa o padrão).
  const [title, setTitle] = useState('Controle de estoque simples, no celular e no computador.');
  useEffect(() => {
    const fromUrl = landingTitleFor(new URLSearchParams(window.location.search).get('utm_content'));
    const fromOrigin = landingTitleFor(segmentContent());
    if (fromUrl ?? fromOrigin) setTitle((fromUrl ?? fromOrigin) as string);
    document.title = 'Comece grátis · Estoque Simples';
    return () => {
      document.title = 'Estoque Simples';
    };
  }, []);

  if (redirect) return redirect;

  return (
    <div className="comece">
      <header className="comece__top">
        <span className="comece__brand">
          <Logo size={28} /> Estoque Simples
        </span>
        <Link to="/entrar" className="comece__login">
          Já tenho conta
        </Link>
      </header>

      <main className="comece__main">
        <section className="comece__pitch">
          <h1 className="comece__title">{title}</h1>
          <ul className="comece__benefits">
            {BENEFITS.map((item) => (
              <li key={item.text}>
                <Icon name={item.icon} size={20} />
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
          <p className="comece__proof" aria-label={`Nota ${PLAY_RATING.stars} de 5 na Google Play`}>
            <span aria-hidden="true">★★★★★</span> {PLAY_RATING.stars} na Google Play · {PLAY_RATING.users}
          </p>
        </section>

        <section className="comece__card" aria-labelledby="comece-form">
          <h2 id="comece-form" className="comece__card-title">
            Crie sua conta grátis
          </h2>
          <p className="comece__card-sub">Sem cartão de crédito. Leva menos de um minuto.</p>
          <RegisterForm autoFocus={false} submitLabel="Criar conta grátis" />
        </section>

        <section className="comece__shot" aria-hidden="true">
          <img src="/assets/video/apresentacao-capa.webp" alt="" width={1280} height={720} loading="lazy" decoding="async" />
        </section>

        <section className="comece__faq" aria-label="Dúvidas comuns">
          {FAQ.map((item) => (
            <details key={item.q}>
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </section>
      </main>

      <footer className="comece__foot">
        <Link to="/termos">Termos</Link> · <Link to="/privacidade">Privacidade</Link>
      </footer>
    </div>
  );
}
