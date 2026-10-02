import { api } from '../api/client';
import { APP_VERSION, installId, newId } from './device';

/**
 * Eventos de uso, no mesmo catálogo e na mesma rota do app Android
 * (`POST /v1/analytics/events`), com `platform: "web"`. O painel separa por
 * plataforma. Só nomes de tela e contagens — nunca nome de produto, valores
 * ou e-mail. Falhas são silenciosas: analytics não pode atrapalhar o uso.
 */

interface PendingEvent {
  id: string;
  name: string;
  occurredAt: number;
  workspaceId?: string;
  sessionKey: string;
  properties?: Record<string, string | number | boolean | null>;
}

const sessionKey = newId().slice(0, 16);
const versionCode = Number(APP_VERSION.split('.').map((part) => part.padStart(2, '0')).join('')) || 0;
let queue: PendingEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let currentWorkspace: string | undefined;

export function setAnalyticsWorkspace(workspaceId: string | null): void {
  currentWorkspace = workspaceId ?? undefined;
}

async function flush(): Promise<void> {
  timer = null;
  if (queue.length === 0) return;
  const events = queue.slice(0, 50);
  queue = queue.slice(50);
  try {
    await api.post(
      '/v1/analytics/events',
      { device: { installId: installId(), platform: 'web', appVersionCode: versionCode }, events },
      { optionalAuth: true },
    );
  } catch {
    // Descartado de propósito: reter eventos indefinidamente não vale o risco.
  }
  if (queue.length > 0) schedule();
}

function schedule(): void {
  if (timer === null) timer = setTimeout(() => void flush(), 4000);
}

export function track(name: string, properties?: Record<string, string | number | boolean | null>): void {
  queue.push({
    id: newId(),
    name,
    occurredAt: Date.now(),
    ...(currentWorkspace ? { workspaceId: currentWorkspace } : {}),
    sessionKey,
    ...(properties ? { properties } : {}),
  });
  if (queue.length > 200) queue = queue.slice(-200);
  schedule();
}

export function trackScreen(screen: string): void {
  track('screen.viewed', { screen });
}

if (typeof window !== 'undefined') {
  // Fecha a aba sem perder o que estava na fila.
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
}
