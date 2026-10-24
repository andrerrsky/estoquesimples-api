import { useEffect, useState } from 'react';

import { readConsent, setConsent } from '../lib/ga';
import '../styles/cookie-consent.css';

/**
 * Aviso de cookies de análise. Aparece até a pessoa escolher; "Aceitar"
 * carrega o Google Analytics, "Recusar" não carrega nada. A escolha fica
 * neste navegador e pode ser mudada em "Preferências de cookies".
 *
 * Só no navegador (depois de montar): a página inicial é pré-renderizada e o
 * aviso não pode entrar no HTML do build.
 */
export function CookieConsent() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (readConsent() === null) setOpen(true);
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
    <div className="cookie-consent" role="dialog" aria-live="polite" aria-label="Cookies de análise">
      <p className="cookie-consent__text">
        Usamos cookies do Google Analytics para entender como o site é usado e melhorá-lo. Nada é usado para publicidade.{' '}
        <a href="/privacidade#cookies">Saiba mais</a>
      </p>
      <div className="cookie-consent__actions">
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => choose('denied')}>
          Recusar
        </button>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => choose('granted')}>
          Aceitar
        </button>
      </div>
    </div>
  );
}
