/**
 * Identidade desta instalação do navegador.
 *
 * O `installId` é o mesmo conceito do app: um identificador aleatório gerado
 * uma vez e guardado localmente. Liga a sessão ao "aparelho" (que aqui é o
 * navegador), aparece na lista de dispositivos da conta e identifica as
 * solicitações de suporte.
 */

export const APP_VERSION = __APP_VERSION__;

const INSTALL_KEY = 'es_web_install';

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Navegadores antigos em contexto não seguro (só em desenvolvimento).
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

export function newId(): string {
  return uuid();
}

export function installId(): string {
  try {
    const stored = localStorage.getItem(INSTALL_KEY);
    if (stored && stored.length >= 8) return stored;
    const created = uuid();
    localStorage.setItem(INSTALL_KEY, created);
    return created;
  } catch {
    // Armazenamento bloqueado (aba privada restrita): vale só nesta página.
    return memoryInstall;
  }
}
const memoryInstall = uuid();

function browserName(): string {
  const ua = navigator.userAgent;
  const match =
    ua.match(/(Edg|OPR|SamsungBrowser)\/(\d+)/) ??
    ua.match(/(Chrome|CriOS)\/(\d+)/) ??
    ua.match(/(Firefox|FxiOS)\/(\d+)/) ??
    ua.match(/Version\/(\d+).*(Safari)/);
  if (!match) return 'Navegador';
  const [name, version] = match[2] === 'Safari' ? ['Safari', match[1]] : [match[1], match[2]];
  const label: Record<string, string> = { Edg: 'Edge', OPR: 'Opera', CriOS: 'Chrome', FxiOS: 'Firefox', SamsungBrowser: 'Samsung Internet' };
  return `${label[name ?? ''] ?? name} ${version}`;
}

function osName(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X/i.test(ua)) return 'macOS';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Outro';
}

/** Enviado no login/cadastro: registra este navegador como dispositivo da conta. */
export function deviceInfo() {
  return {
    installId: installId(),
    platform: 'web' as const,
    model: browserName(),
    osVersion: osName(),
    appVersionName: APP_VERSION,
  };
}

/** Enviado nas solicitações de suporte. */
export function supportDevice() {
  return {
    platform: 'web' as const,
    model: browserName(),
    osVersion: osName(),
    appVersionName: APP_VERSION,
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
