import { vi } from 'vitest';

/** Armazenamento em memória com a interface do `Storage`. */
export class MemoryStorage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

export interface FakeBrowser {
  window: Record<string, unknown> & { dataLayer?: unknown[]; location: { origin: string; pathname: string; search: string; href: string } };
  local: MemoryStorage;
  session: MemoryStorage;
  /** Scripts injetados no <head> (o gtag.js é baixado por aqui). */
  scripts: Array<{ src?: string }>;
  /** Chamadas ao gtag, na ordem: ['event', 'sign_up', {...}], ['config', id, {...}]... */
  calls(): unknown[][];
  /** Eventos enviados ao GA com este nome. */
  events(name: string): Array<Record<string, unknown>>;
  /** Abre outra página na mesma aba (referenciador = a atual): o armazenamento continua, o script não. */
  open(url: string, referrer?: string): void;
}

/**
 * Um navegador mínimo para `lib/ga.ts`: endereço, localStorage e
 * sessionStorage (que sobrevivem a `open()`, como numa aba de verdade) e o
 * <head> onde o gtag.js seria injetado. Nada sai da máquina: o que iria ao
 * Google fica em `window.dataLayer`.
 */
export function installBrowser(url: string, referrer = ''): FakeBrowser {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  let scripts: Array<{ src?: string }> = [];
  let currentReferrer = referrer;
  const makeWindow = (address: string) => {
    const parsed = new URL(address);
    return {
      location: { origin: parsed.origin, pathname: parsed.pathname, search: parsed.search, href: parsed.href },
      localStorage: local,
      sessionStorage: session,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    } as FakeBrowser['window'];
  };
  const browser: FakeBrowser = {
    window: makeWindow(url),
    local,
    session,
    get scripts() {
      return scripts;
    },
    calls() {
      return (browser.window.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
    },
    events(name) {
      return browser
        .calls()
        .filter((call) => call[0] === 'event' && call[1] === name)
        .map((call) => (call[2] ?? {}) as Record<string, unknown>);
    },
    open(address, from = browser.window.location.href) {
      currentReferrer = from;
      browser.window = makeWindow(address);
      scripts = [];
      stub();
    },
  };
  const stub = () => {
    vi.stubGlobal('window', browser.window);
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', {
      referrer: currentReferrer,
      createElement: () => ({}),
      head: { appendChild: (element: { src?: string }) => scripts.push(element) },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
  };
  stub();
  return browser;
}
