import { useEffect, useState } from 'react';

import { readConsent, setConsent } from '../lib/ga';

/** Aviso de cookies de análise do painel: "Aceitar" carrega o Google Analytics, "Recusar" não carrega nada. */
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
        O painel usa o Google Analytics para medir quais telas e ações a equipe usa. Nenhum dado de cliente é enviado e o uso
        fica marcado como tráfego interno.
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
