import { useState } from 'react';

import { api, errorMessage } from '../api/client';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { Icon } from './Icon';
import { Card, Notice } from './ui';

function isStandalone(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true)
  );
}

/**
 * Só no web app instalado (tela inicial): abre a versão completa no
 * navegador já conectado. No iPhone o web app instalado não divide a sessão
 * com o Safari, e sem isto a pessoa teria de digitar e-mail e senha de novo.
 * Usa o mesmo código de uso único do app Android (2 minutos, uma vez).
 */
export function OpenInBrowserCard() {
  const workspace = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!isStandalone()) return null;

  const open = async () => {
    setError(null);
    // A janela abre já no toque (depois de um await o navegador a bloquearia).
    const popup = window.open('about:blank', '_blank');
    setBusy(true);
    try {
      const { code } = await api.post<{ code: string; expiresIn: number }>('/v1/auth/web-handoff', {});
      const params = new URLSearchParams({ codigo: code, para: '/app' });
      if (workspace.workspaceId) params.set('empresa', workspace.workspaceId);
      const url = `${window.location.origin}/entrar/app#${params.toString()}`;
      if (popup) popup.location.href = url;
      else window.location.href = url;
    } catch (reason) {
      popup?.close();
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Abrir no navegador" subtitle="A versão completa, com tela grande, já conectada na sua conta.">
      <div className="stack stack--tight">
        {error && <Notice tone="error">{error}</Notice>}
        <div>
          <button type="button" className="btn btn--secondary" onClick={() => void open()} disabled={busy}>
            <Icon name="external" />
            {busy ? 'Abrindo…' : 'Abrir no navegador'}
          </button>
        </div>
      </div>
    </Card>
  );
}
