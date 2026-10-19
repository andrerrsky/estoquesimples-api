import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { importPage } from '../lib/chunks';
import type { Decode } from '../lib/barcode-decode';
import { Icon } from './Icon';

import '../styles/barcode-scanner.css';

/**
 * Leitor de código de barras pela câmera, em qualquer navegador com câmera
 * (inclusive Safari no iPhone e no iPad, onde não há leitor nativo: a
 * decodificação vem de `lib/barcode-decode`, carregado só aqui). Sem câmera
 * ao vivo (permissão negada, navegador antigo) dá para tirar uma foto do
 * código. Leitores USB continuam funcionando sem isso: eles digitam no campo.
 */

type Status = 'starting' | 'scanning' | 'denied' | 'nocamera' | 'error' | 'reading-photo' | 'photo-miss';

const MESSAGES: Record<Exclude<Status, 'starting' | 'scanning' | 'reading-photo'>, string> = {
  denied: 'A câmera foi bloqueada. Libere o acesso nas configurações do navegador, ou tire uma foto do código.',
  nocamera: 'Não encontramos uma câmera neste aparelho. Você pode tirar uma foto do código ou digitá-lo no campo.',
  error: 'Não foi possível abrir a câmera agora. Tente de novo ou tire uma foto do código.',
  'photo-miss': 'Não deu para ler o código nesta foto. Tente de novo com o código inteiro, reto e bem iluminado.',
};

/** Recorte central do quadro (a área da moldura), que é onde a pessoa mira. */
function drawCrop(video: HTMLVideoElement, canvas: HTMLCanvasElement): boolean {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return false;
  const cropW = vw * 0.86;
  const cropH = Math.min(vh * 0.62, cropW * 0.75);
  const scale = Math.min(1, 960 / cropW);
  canvas.width = Math.round(cropW * scale);
  canvas.height = Math.round(cropH * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return false;
  context.drawImage(video, (vw - cropW) / 2, (vh - cropH) / 2, cropW, cropH, 0, 0, canvas.width, canvas.height);
  return true;
}

export function BarcodeScanner({ open, onClose, onDetected }: { open: boolean; onClose: () => void; onDetected: (code: string) => void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const photoInput = useRef<HTMLInputElement | null>(null);
  const decoderRef = useRef<Promise<Decode> | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const doneRef = useRef(false);
  const [status, setStatus] = useState<Status>('starting');
  const [torch, setTorch] = useState<{ available: boolean; on: boolean }>({ available: false, on: false });
  const [attempt, setAttempt] = useState(0);

  const getDecoder = useCallback((): Promise<Decode> => {
    if (!decoderRef.current) {
      decoderRef.current = importPage(() => import('../lib/barcode-decode')).then((module) => module.createDecoder().then((result) => result.decode));
      // Uma falha ao baixar o leitor não pode travar as próximas tentativas.
      decoderRef.current.catch(() => {
        decoderRef.current = null;
      });
    }
    return decoderRef.current;
  }, []);

  const finish = useCallback(
    (code: string) => {
      if (doneRef.current) return;
      doneRef.current = true;
      try {
        navigator.vibrate?.(60);
      } catch {
        // vibrar é só um agrado
      }
      onDetected(code.trim());
      onClose();
    },
    [onDetected, onClose],
  );

  // Câmera ao vivo + leitura contínua do recorte central.
  useEffect(() => {
    if (!open) return;
    doneRef.current = false;
    let stream: MediaStream | null = null;
    let cancelled = false;
    let timer: number | null = null;
    const canvas = document.createElement('canvas');
    setStatus('starting');
    setTorch({ available: false, on: false });

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('nocamera');
        return;
      }
      try {
        const decoderPromise = getDecoder();
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (cancelled || !video.current) return;
        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        const capabilities = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
        setTorch({ available: !!capabilities.torch, on: false });
        video.current.srcObject = stream;
        await video.current.play().catch(() => undefined);
        const decode = await decoderPromise;
        if (cancelled) return;
        setStatus('scanning');
        let busy = false;
        timer = window.setInterval(() => {
          const element = video.current;
          if (busy || cancelled || !element || element.readyState < 2) return;
          if (!drawCrop(element, canvas)) return;
          busy = true;
          decode(canvas)
            .then((value) => {
              if (value && !cancelled) finish(value);
            })
            .catch(() => undefined)
            .finally(() => {
              busy = false;
            });
        }, 160);
      } catch (error) {
        if (cancelled) return;
        const name = error instanceof DOMException ? error.name : '';
        setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'nocamera' : 'error');
      }
    };
    void start();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
      trackRef.current = null;
      if (video.current) video.current.srcObject = null;
    };
  }, [open, attempt, getDecoder, finish]);

  // Esc fecha; o fundo não rola enquanto o leitor está aberto.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorch({ available: true, on: next });
    } catch {
      setTorch({ available: false, on: false });
    }
  };

  const readPhoto = async (file: File | undefined) => {
    if (photoInput.current) photoInput.current.value = '';
    if (!file) return;
    setStatus('reading-photo');
    try {
      const [{ decodeImageFile }, decode] = await Promise.all([importPage(() => import('../lib/barcode-decode')), getDecoder()]);
      const value = await decodeImageFile(file, decode);
      if (value) finish(value);
      else setStatus('photo-miss');
    } catch {
      setStatus('photo-miss');
    }
  };

  if (!open) return null;

  const live = status === 'starting' || status === 'scanning';
  const message = status in MESSAGES ? MESSAGES[status as keyof typeof MESSAGES] : null;

  return createPortal(
    <div className="scanner" role="dialog" aria-modal="true" aria-label="Ler código de barras">
      <div className="scanner__panel">
        <div className="scanner__top">
          <div>
            <div className="scanner__title">Ler código de barras</div>
            <div className="scanner__hint" aria-live="polite">
              {status === 'starting' ? 'Abrindo a câmera…' : status === 'scanning' ? 'Aponte para o código, dentro da moldura.' : status === 'reading-photo' ? 'Lendo a foto…' : ' '}
            </div>
          </div>
          <button type="button" className="scanner__close" aria-label="Fechar o leitor" onClick={onClose}>
            <Icon name="x" size={22} />
          </button>
        </div>

        <div className={`scanner__view ${live ? '' : 'scanner__view--idle'}`}>
          <video ref={video} className="scanner__video" muted playsInline autoPlay aria-hidden="true" />
          {live && (
            <div className="scanner__frame" aria-hidden="true">
              <span className="scanner__laser" />
            </div>
          )}
          {message && (
            <div className="scanner__message" role="alert">
              <Icon name="info" size={22} />
              <p>{message}</p>
              {(status === 'error' || status === 'denied') && (
                <button type="button" className="btn btn--sm scanner__retry" onClick={() => setAttempt((count) => count + 1)}>
                  Tentar a câmera de novo
                </button>
              )}
            </div>
          )}
        </div>

        <div className="scanner__actions">
          <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={(event) => void readPhoto(event.target.files?.[0])} />
          <button type="button" className="scanner__action" onClick={() => photoInput.current?.click()}>
            <Icon name="camera" size={20} /> Tirar foto do código
          </button>
          {torch.available && (
            <button type="button" className={`scanner__action ${torch.on ? 'is-on' : ''}`} aria-pressed={torch.on} onClick={() => void toggleTorch()}>
              <Icon name="zap" size={20} /> Lanterna
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
