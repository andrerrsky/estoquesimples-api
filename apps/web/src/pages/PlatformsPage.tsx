import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider';
import { Icon, Logo, type IconName } from '../components/Icon';
import { PageHeader, Tabs } from '../components/ui';
import { track } from '../lib/analytics';

import '../styles/pages-platforms.css';

const PLAY_URL = 'https://play.google.com/store/apps/details?id=br.com.gameloop.estoquesimples';

type Device = 'ios' | 'android' | 'desktop' | 'mac';

const DEVICES: Array<{ key: Device; label: string }> = [
  { key: 'ios', label: 'iPhone e iPad' },
  { key: 'android', label: 'Android' },
  { key: 'desktop', label: 'Windows, Linux e Chrome' },
  { key: 'mac', label: 'Mac (Safari)' },
];

/** Passos de cada aparelho. Os nomes dos botões são os que aparecem na tela do sistema. */
const STEPS: Record<Device, { intro: string; steps: ReactNode[]; note?: string }> = {
  ios: {
    intro: 'No iPhone e no iPad a instalação é feita pelo Safari, em 4 passos:',
    steps: [
      <>Abra <strong>estoquesimples.com.br</strong> no <strong>Safari</strong> e entre na sua conta.</>,
      <>Toque no botão <strong>Compartilhar</strong> <Icon name="share" size={16} className="plat-inline" /> (o quadrado com uma seta para cima), na barra de baixo ou no alto da tela.</>,
      <>Role a lista e toque em <strong>Adicionar à Tela de Início</strong>.</>,
      <>Confira o nome “Estoque Simples” e toque em <strong>Adicionar</strong>. O ícone aparece na tela inicial, como um aplicativo.</>,
    ],
    note: 'Se a opção não aparecer, confirme que está no Safari e não dentro de outro aplicativo (como o navegador interno do WhatsApp ou do Instagram).',
  },
  android: {
    intro: 'No Android o ideal é o aplicativo da Google Play, que funciona até sem internet. Se preferir instalar a versão web:',
    steps: [
      <>Abra <strong>estoquesimples.com.br</strong> no <strong>Chrome</strong> e entre na sua conta.</>,
      <>Toque nos <strong>três pontinhos</strong> <Icon name="more" size={16} className="plat-inline" /> no canto superior.</>,
      <>Toque em <strong>Instalar app</strong> (ou <strong>Adicionar à tela inicial</strong>) e confirme.</>,
    ],
  },
  desktop: {
    intro: 'No computador, o Chrome e o Edge instalam o Estoque Simples como um programa, com janela própria:',
    steps: [
      <>Abra <strong>estoquesimples.com.br</strong> no <strong>Chrome</strong> ou no <strong>Edge</strong> e entre na sua conta.</>,
      <>Clique no ícone de <strong>instalar</strong> <Icon name="download" size={16} className="plat-inline" /> no fim da barra de endereço. No Edge, é o ícone de aplicativo ao lado dele.</>,
      <>Se não houver o ícone: abra o menu <strong>⋮</strong> e escolha <strong>Instalar Estoque Simples</strong> (no Edge: <strong>Aplicativos › Instalar este site como um aplicativo</strong>).</>,
      <>Confirme em <strong>Instalar</strong>. Ele passa a abrir pelo menu Iniciar, pelo Launchpad ou pela barra de tarefas.</>,
    ],
  },
  mac: {
    intro: 'No Mac, o Safari (macOS Sonoma ou mais novo) adiciona o site ao Dock:',
    steps: [
      <>Abra <strong>estoquesimples.com.br</strong> no <strong>Safari</strong> e entre na sua conta.</>,
      <>No menu do alto da tela, clique em <strong>Arquivo › Adicionar ao Dock</strong>.</>,
      <>Confira o nome e clique em <strong>Adicionar</strong>.</>,
    ],
    note: 'Em versões mais antigas do macOS, use o Chrome ou o Edge (aba “Windows, Linux e Chrome”).',
  },
};

function detectDevice(): Device {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Macintosh/i.test(ua) && !/Chrome|Edg/i.test(ua)) return 'mac';
  return 'desktop';
}

/** Evento que o Chrome e o Edge disparam quando o site pode ser instalado com um clique. */
interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function PlatformCard({ icon, title, tag, children, action }: { icon: IconName; title: string; tag?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <article className="plat-card">
      <span className="plat-card__icon"><Icon name={icon} size={24} /></span>
      <h3 className="plat-card__title">
        {title} {tag && <span className="badge badge--brand">{tag}</span>}
      </h3>
      <p>{children}</p>
      {action && <div className="plat-card__action">{action}</div>}
    </article>
  );
}

/** Onde o Estoque Simples funciona e como instalar a versão web como aplicativo. */
function PlatformsGuide({ standalone }: { standalone: boolean }) {
  const [device, setDevice] = useState<Device>(detectDevice);
  const [installer, setInstaller] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstaller(event as InstallPrompt);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstaller(null);
      track('platform.web_app_installed');
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const running = window.matchMedia('(display-mode: standalone)').matches;
  const current = STEPS[device];

  const install = async () => {
    if (!installer) return;
    track('platform.install_clicked', { device });
    await installer.prompt();
    const choice = await installer.userChoice;
    if (choice.outcome === 'accepted') setInstaller(null);
  };

  return (
    <div className="plat">
      <div className="plat-grid">
        <PlatformCard
          icon="phone"
          title="Aplicativo Android"
          tag="Google Play"
          action={
            <a href={PLAY_URL} target="_blank" rel="noopener noreferrer" className="btn btn--primary" onClick={() => track('platform.play_clicked')}>
              Baixar na Google Play <Icon name="external" size={16} />
            </a>
          }
        >
          Funciona até sem internet: tudo fica guardado no celular e sincroniza quando a conexão volta. Tira foto dos produtos pela câmera, lê código de barras e avisa quando o estoque está baixo.
        </PlatformCard>
        <PlatformCard
          icon="monitor"
          title="Versão web"
          tag="Qualquer navegador"
          action={!standalone || running ? undefined : <Link to="/entrar" className="btn btn--secondary">Entrar na versão web</Link>}
        >
          Abre em qualquer navegador, no computador, no tablet ou no celular, sem instalar nada. É a mesma conta e o mesmo estoque do aplicativo. É também onde se assina o plano por Pix, boleto ou cartão.
        </PlatformCard>
        <PlatformCard icon="layers" title="Web app" tag="iPhone, iPad e computador">
          Instale a versão web na tela inicial e use como um aplicativo, com ícone próprio e sem a barra do navegador. É o caminho para quem usa iPhone ou iPad, que ainda não têm aplicativo.
        </PlatformCard>
      </div>

      <section className="plat-install" aria-labelledby="plat-instalar">
        <div className="plat-install__head">
          <span className="plat-install__logo"><Logo size={44} /></span>
          <div>
            <h2 id="plat-instalar">Instalar o web app</h2>
            <p>Escolha o seu aparelho. Os passos são feitos uma vez só.</p>
          </div>
        </div>

        {running || installed ? (
          <p className="plat-ok"><Icon name="check" size={18} /> Você já está usando o Estoque Simples como aplicativo.</p>
        ) : installer ? (
          <div className="plat-oneclick">
            <div>
              <strong>Este navegador instala com um clique.</strong>
              <span>Sem passo a passo: o próprio navegador cuida do resto.</span>
            </div>
            <button type="button" className="btn btn--primary" onClick={() => void install()}>
              <Icon name="download" size={17} /> Instalar agora
            </button>
          </div>
        ) : null}

        <Tabs value={device} onChange={(value) => { setDevice(value); track('platform.device_selected', { device: value }); }} items={DEVICES} />

        <p className="plat-intro">{current.intro}</p>
        <ol className="plat-steps">
          {current.steps.map((step, index) => (
            <li key={index}>
              <span className="plat-steps__n" aria-hidden="true">{index + 1}</span>
              <div>{step}</div>
            </li>
          ))}
        </ol>
        {current.note && <p className="plat-note"><Icon name="info" size={16} /> {current.note}</p>}
      </section>

      <section className="plat-compare" aria-labelledby="plat-diferencas">
        <h2 id="plat-diferencas">O que muda de um para o outro</h2>
        <div className="table-wrap">
          <table className="table plat-table">
            <thead>
              <tr><th scope="col">Recurso</th><th scope="col">Aplicativo Android</th><th scope="col">Versão web e web app</th></tr>
            </thead>
            <tbody>
              <tr><th scope="row">Mesma conta e mesmo estoque</th><td>Sim</td><td>Sim</td></tr>
              <tr><th scope="row">Funciona sem internet</th><td>Sim</td><td>Não</td></tr>
              <tr><th scope="row">Fotos dos produtos</th><td>Sim, pela câmera ou galeria</td><td>Sim, escolhendo um arquivo</td></tr>
              <tr><th scope="row">Identidade visual da empresa (plano Equipe)</th><td>Aplica as cores e o logotipo</td><td>Aplica e é onde se configura</td></tr>
              <tr><th scope="row">Leitor de código de barras</th><td>Câmera</td><td>Leitor USB (e câmera, em alguns navegadores)</td></tr>
              <tr><th scope="row">Aviso de estoque baixo no aparelho</th><td>Sim</td><td>Não (aparece destacado na lista e nos relatórios)</td></tr>
              <tr><th scope="row">Assinar o plano Equipe</th><td>Google Play</td><td>Pix, boleto ou cartão</td></tr>
              <tr><th scope="row">Telas grandes, relatórios e impressão</th><td>Básico</td><td>Completo</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <p className="plat-foot">
        Dúvidas? Veja a <Link to={standalone ? '/ajuda' : '/app/ajuda'}>central de ajuda</Link> ou fale com o suporte pelo botão no canto da tela.
      </p>
    </div>
  );
}

/** Dentro da aplicação (com o menu ao lado). */
export function PlatformsPage() {
  return (
    <div className="page page--narrow">
      <PageHeader title="Plataformas" subtitle="Onde o Estoque Simples funciona e como instalar no iPhone, no iPad e no computador." />
      <PlatformsGuide standalone={false} />
    </div>
  );
}

/** Pública (estoquesimples.com.br/plataformas): serve a quem ainda vai escolher onde usar. */
export function PublicPlatformsPage() {
  const { status } = useAuth();
  const authed = status === 'authed';

  useEffect(() => {
    document.title = 'Plataformas · Estoque Simples';
    return () => {
      document.title = 'Estoque Simples';
    };
  }, []);

  return (
    <div style={{ background: 'var(--surface)', minHeight: '100dvh' }}>
      <header className="landing__nav">
        <Link to="/" className="row strong" style={{ gap: 10, color: 'var(--text)' }}>
          <Logo size={28} /> Estoque Simples
        </Link>
        <span className="spacer" />
        <Link to={authed ? '/app' : '/entrar'} className="btn btn--secondary btn--sm">
          {authed ? 'Abrir meu estoque' : 'Entrar'}
        </Link>
      </header>
      <main className="page page--narrow" style={{ margin: '0 auto' }}>
        <PageHeader title="Plataformas" subtitle="O Estoque Simples funciona no Android e na web. No iPhone, no iPad e no computador, instale a versão web como aplicativo." />
        <PlatformsGuide standalone />
      </main>
    </div>
  );
}
