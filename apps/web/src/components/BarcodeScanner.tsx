import { useEffect, useRef, useState } from 'react';

import { Modal, Notice } from './ui';

/**
 * Leitor de código de barras pela câmera, onde o navegador oferece
 * `BarcodeDetector` (Chrome no Android e no desktop). Onde não há, o botão
 * nem aparece — leitores USB continuam funcionando, porque digitam no campo.
 */

interface DetectorLike {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>;
}

export function barcodeScanningSupported(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
}

export function BarcodeScanner({ open, onClose, onDetected }: { open: boolean; onClose: () => void; onDetected: (code: string) => void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    setError(null);

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (cancelled || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const Detector = (window as unknown as { BarcodeDetector: new () => DetectorLike }).BarcodeDetector;
        const detector = new Detector();
        timer = setInterval(async () => {
          if (!video.current || video.current.readyState < 2) return;
          try {
            const codes = await detector.detect(video.current);
            const value = codes[0]?.rawValue;
            if (value) {
              onDetected(value);
              onClose();
            }
          } catch {
            // quadro ilegível: tenta o próximo
          }
        }, 350);
      } catch {
        setError('Não foi possível abrir a câmera. Verifique a permissão do navegador.');
      }
    };
    void start();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [open, onClose, onDetected]);

  return (
    <Modal open={open} onClose={onClose} title="Ler código de barras" description="Aponte a câmera para o código.">
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : (
        <video ref={video} muted playsInline style={{ width: '100%', borderRadius: 'var(--radius-panel)', background: '#000', aspectRatio: '4 / 3', objectFit: 'cover' }} />
      )}
    </Modal>
  );
}
