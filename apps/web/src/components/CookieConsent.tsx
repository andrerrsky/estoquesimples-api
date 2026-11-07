import { useEffect, useState } from 'react';

import { consentNeedsPrompt, setConsent } from '../lib/ga';
import '../styles/cookie-consent.css';

/**
 * Aviso de cookies do Google. Aparece até a pessoa escolher — e de novo para
 * quem aceitou o texto antigo, que dizia "nada é usado para publicidade"
 * (`consentNeedsPrompt`). "Aceitar" carrega o Google Analytics e deixa o
 * Google saber quais anúncios trazem cadastros, sem personalizar anúncios;
 * "Recusar" não carrega nada. Os dois botões têm o mesmo peso. A escolha fica
 * neste navegador e pode ser mudada em "Preferências de cookies".
 *
 * Só no navegador (depois de montar): a página inicial é pré-renderizada e o
 * aviso não pode entrar no HTML do build.
 */
export function CookieConsent() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (consentNeedsPrompt()) setOpen(true);
    const reopen = () => setOpen(true);
    window.addEventListener('es:cookie-preferences', reopen);
    return () => window.removeEventListener('es:cookie-preferences', reopen);
  }, []);

  if (!open) return null;

  const choose = (consent: 'granted' | 'denied') => {
    setConsent(consent);
    setOpen(false);
  };

  return (
    <div className="cookie-consent" role="dialog" aria-live="polite" aria-label="Cookies do Google">
      <p className="cookie-consent__text">
        Usamos cookies do Google para medir as visitas e saber quais anúncios trazem cadastros. Não usamos para personalizar anúncios.{' '}
        <a href="/privacidade#cookies">Saiba mais</a>
      </p>
      <div className="cookie-consent__actions">
        <button type="button" className="btn btn--primary btn--sm" onClick={() => choose('denied')}>
          Recusar
        </button>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => choose('granted')}>
          Aceitar
        </button>
      </div>
    </div>
  );
}
