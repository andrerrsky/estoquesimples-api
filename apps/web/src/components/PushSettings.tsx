import { Icon } from './Icon';
import { useWebPush, type PushState } from '../lib/web-push';

import '../styles/push-settings.css';

/**
 * Ligar/desligar os avisos neste navegador. Mostra o que fazer em cada
 * situação em vez de esconder a opção: no iPhone numa aba do Safari, explica
 * que é preciso adicionar o web app à tela inicial; bloqueado, explica onde
 * liberar.
 */
const COPY: Record<PushState, { title: string; text: string }> = {
  on: { title: 'Avisos ligados neste aparelho', text: 'Você recebe aqui a resposta do suporte, avisos do plano e da equipe, novidades e, uma vez por dia, o que está acabando no estoque.' },
  off: { title: 'Receba avisos neste aparelho', text: 'Resposta do suporte, pagamento e assinatura, equipe, novidades e, uma vez por dia, os produtos que chegaram ao mínimo.' },
  denied: { title: 'Avisos bloqueados neste navegador', text: 'Para receber, libere as notificações de estoquesimples.com.br nas configurações do navegador (no cadeado ao lado do endereço) e volte aqui.' },
  install: { title: 'No iPhone e no iPad, os avisos chegam pelo web app', text: 'Toque em Compartilhar e em “Adicionar à Tela de Início”. Depois abra o Estoque Simples pelo ícone e ligue os avisos aqui.' },
  unsupported: { title: 'Este navegador não recebe avisos', text: 'Use o Chrome, o Edge ou o Firefox, ou o web app na tela inicial do iPhone ou do iPad. As notificações continuam aqui na lista.' },
};

export function PushSettings({ compact = false }: { compact?: boolean }) {
  const { state, busy, error, enable, disable } = useWebPush();
  if (!state) return null;
  // Na versão compacta (dentro de outras telas), só aparece quando há algo a fazer.
  if (compact && (state === 'on' || state === 'unsupported')) return null;
  const copy = COPY[state];
  return (
    <section className={`push-settings push-settings--${state} ${compact ? 'push-settings--compact' : ''}`} aria-live="polite">
      <span className="push-settings__icon" aria-hidden="true">
        <Icon name={state === 'on' ? 'check' : 'bell'} size={20} />
      </span>
      <div className="push-settings__text">
        <strong>{copy.title}</strong>
        <p>{copy.text}</p>
        {error && <p className="push-settings__error">{error}</p>}
      </div>
      <div className="push-settings__action">
        {state === 'off' && (
          <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void enable()}>
            {busy ? 'Ligando…' : 'Ligar avisos'}
          </button>
        )}
        {state === 'on' && !compact && (
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void disable()}>
            {busy ? 'Desligando…' : 'Desligar'}
          </button>
        )}
        {state === 'install' && (
          <a className="btn btn--secondary btn--sm" href="/plataformas#plat-instalar">
            Como instalar
          </a>
        )}
      </div>
    </section>
  );
}
