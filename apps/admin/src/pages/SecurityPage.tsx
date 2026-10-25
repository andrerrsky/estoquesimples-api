import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';

import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { Badge, Card, errorMessage, Notice, PageHeader, Skeleton, useToast } from '../components/ui';

interface MfaStatus {
  enabled: boolean;
  required: boolean;
  recoveryCodesLeft: number;
}

/**
 * Segundo fator do painel (TOTP). Com `forced`, é a única tela que abre:
 * o painel exige o autenticador e este administrador ainda não cadastrou.
 */
export function SecurityPage({ forced = false }: { forced?: boolean }) {
  const { admin, refresh, logout } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['mfa'], queryFn: () => api.get<MfaStatus>('/auth/mfa') });
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  useEffect(() => {
    if (!setup) return;
    QRCode.toDataURL(setup.otpauthUri, { margin: 1, width: 220, errorCorrectionLevel: 'M' })
      .then(setQr)
      .catch(() => setQr(null));
  }, [setup]);

  const start = useMutation({
    mutationFn: () => api.post<{ secret: string; otpauthUri: string }>('/auth/mfa/setup'),
    onSuccess: (data) => {
      setSetup(data);
      setCode('');
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const enable = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code: code.trim() }),
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes);
      setSetup(null);
      void queryClient.invalidateQueries({ queryKey: ['mfa'] });
      toast.push('Segundo fator ativado.', 'success');
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const disable = useMutation({
    mutationFn: () => api.post('/auth/mfa/disable', { password: disablePassword, code: disableCode.trim() }),
    onSuccess: async () => {
      setDisablePassword('');
      setDisableCode('');
      toast.push('Segundo fator desativado.', 'success');
      await queryClient.invalidateQueries({ queryKey: ['mfa'] });
      await refresh();
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const downloadCodes = () => {
    if (!recoveryCodes) return;
    const text = `Códigos de recuperação do painel Estoque Simples (${admin?.email ?? ''})\nCada código vale uma vez.\n\n${recoveryCodes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'estoque-simples-painel-codigos-de-recuperacao.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const finishForced = async () => {
    setRecoveryCodes(null);
    await refresh();
  };

  const submitEnable = (event: FormEvent) => {
    event.preventDefault();
    enable.mutate();
  };
  const submitDisable = (event: FormEvent) => {
    event.preventDefault();
    disable.mutate();
  };

  const body = (
    <div className="stack">
      {recoveryCodes ? (
        <Card title="Guarde seus códigos de recuperação" subtitle="Cada código entra uma vez no lugar do autenticador, se você perder o celular. Eles não aparecem de novo.">
          <div className="stack">
            <pre className="recovery-codes">{recoveryCodes.join('\n')}</pre>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn--secondary" onClick={downloadCodes}><Icon name="download" size={16} /> Baixar .txt</button>
              <button type="button" className="btn btn--secondary" onClick={() => void navigator.clipboard?.writeText(recoveryCodes.join('\n')).then(() => toast.push('Códigos copiados.', 'success'))}>Copiar</button>
              <button type="button" className="btn btn--primary" onClick={() => void finishForced()}>Já guardei</button>
            </div>
          </div>
        </Card>
      ) : status.isLoading ? (
        <Card><Skeleton /></Card>
      ) : status.data?.enabled ? (
        <>
          <Card title="Aplicativo autenticador" actions={<Badge tone="success">ativo</Badge>}>
            <p className="muted">Todo login no painel pede o código de 6 dígitos do aplicativo. Restam {status.data.recoveryCodesLeft} código(s) de recuperação.</p>
          </Card>
          <Card title="Desativar" subtitle={status.data.required ? 'O painel exige segundo fator: depois de desativar, você cadastra outro aparelho para continuar.' : 'Sem o segundo fator, só a senha protege seu acesso.'}>
            <form className="stack stack--tight" onSubmit={submitDisable} style={{ maxWidth: 420 }}>
              <label className="field">
                <span className="field__label">Senha</span>
                <input className="input" type="password" autoComplete="current-password" value={disablePassword} onChange={(event) => setDisablePassword(event.target.value)} required />
              </label>
              <label className="field">
                <span className="field__label">Código do autenticador ou de recuperação</span>
                <input className="input" inputMode="numeric" autoComplete="one-time-code" value={disableCode} onChange={(event) => setDisableCode(event.target.value)} maxLength={20} required />
              </label>
              <div><button type="submit" className="btn btn--danger" disabled={disable.isPending}>Desativar segundo fator</button></div>
            </form>
          </Card>
        </>
      ) : setup ? (
        <Card title="Leia o QR code no aplicativo autenticador" subtitle="Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden ou outro de sua preferência.">
          <form className="stack" onSubmit={submitEnable}>
            <div className="row" style={{ gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {qr ? <img src={qr} alt="QR code para o aplicativo autenticador" width={220} height={220} style={{ borderRadius: 8, background: '#fff' }} /> : <Skeleton lines={6} />}
              <div className="stack stack--tight" style={{ flex: '1 1 260px' }}>
                <span className="field__label">Sem câmera? Digite a chave no aplicativo:</span>
                <code className="mono" style={{ wordBreak: 'break-all', fontSize: 15 }}>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                <label className="field" style={{ marginTop: 12 }}>
                  <span className="field__label">Código que o aplicativo mostra</span>
                  <input className="input" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" value={code} onChange={(event) => setCode(event.target.value)} maxLength={10} autoFocus required />
                </label>
                <div className="row" style={{ gap: 8 }}>
                  <button type="submit" className="btn btn--primary" disabled={enable.isPending}>{enable.isPending ? 'Conferindo…' : 'Ativar'}</button>
                  <button type="button" className="btn btn--ghost" onClick={() => setSetup(null)}>Cancelar</button>
                </div>
              </div>
            </div>
          </form>
        </Card>
      ) : (
        <Card title="Aplicativo autenticador" actions={<Badge tone="warning">não cadastrado</Badge>}>
          <div className="stack">
            <p className="muted">Além da senha, cada login pede um código de 6 dígitos que muda a cada 30 segundos no seu celular. Quem descobrir sua senha não entra sem o aparelho.</p>
            <div><button type="button" className="btn btn--primary" onClick={() => start.mutate()} disabled={start.isPending}><Icon name="lock" size={16} /> Cadastrar autenticador</button></div>
          </div>
        </Card>
      )}
    </div>
  );

  if (forced) {
    return (
      <div className="page" style={{ maxWidth: 760, margin: '0 auto', padding: '32px 16px' }}>
        <PageHeader
          title="Proteja seu acesso ao painel"
          subtitle="O painel passou a exigir um segundo fator. Cadastre o aplicativo autenticador para continuar."
          actions={<button type="button" className="btn btn--ghost" onClick={() => void logout()}>Sair</button>}
        />
        <Notice tone="info">Leva um minuto: instale um aplicativo autenticador no celular, leia o QR code e digite o código que aparecer.</Notice>
        {body}
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="Segurança" subtitle="Segundo fator de autenticação do seu acesso ao painel." />
      {body}
    </div>
  );
}
