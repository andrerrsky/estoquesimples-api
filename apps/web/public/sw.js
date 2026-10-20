/* ==========================================================================
   Estoque Simples · service worker do web app
   Só para notificações (Web Push). Não guarda páginas nem arquivos em cache
   e não intercepta requisições: o web app continua precisando de internet,
   exatamente como antes. Registrado por src/lib/web-push.ts.
   ========================================================================== */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** Para onde o toque leva, pelos mesmos tipos da caixa de notificações. */
const SCREEN_ROUTE = {
  main: '/app/estoque',
  history: '/app/historico',
  reports: '/app/relatorios',
  analysis: '/app/analise',
  account: '/app/conta',
  subscription: '/app/plano',
  team: '/app/equipe',
  import: '/app/importar',
};

function destination(data) {
  const type = data.notificationType || data.type || '';
  if (type === 'support' || type.startsWith('support.')) return data.ticketId ? `/app/suporte/${data.ticketId}` : '/app/suporte';
  if (type.startsWith('billing.')) return '/app/plano';
  if (type.startsWith('team.')) return '/app/equipe';
  if (type === 'stock.low') return '/app/estoque?filtro=baixo';
  if (data.screen && SCREEN_ROUTE[data.screen]) return SCREEN_ROUTE[data.screen];
  if (data.url) {
    try {
      const url = new URL(data.url, self.location.origin);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch (_) {
      // endereço malformado: abre a caixa de notificações
    }
  }
  return '/app/notificacoes';
}

/** Entrega/abertura de campanha (o painel mede o funil). Sem conta, pela instalação. */
function report(data, event) {
  if (data.type !== 'campaign' || !data.campaignId || !data.installId) return Promise.resolve();
  return fetch('/v1/push/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ campaignId: data.campaignId, installId: data.installId, event }),
    credentials: 'omit',
    keepalive: true,
  }).catch(() => undefined);
}

let installIdCache = null;
async function installId() {
  if (installIdCache) return installIdCache;
  try {
    const cache = await caches.open('es-push-meta');
    const response = await cache.match('/__install-id');
    installIdCache = response ? await response.text() : null;
  } catch (_) {
    installIdCache = null;
  }
  return installIdCache;
}

self.addEventListener('message', (event) => {
  // A página informa o installId (para medir campanhas); fica guardado para os próximos pushes.
  if (event.data && event.data.type === 'install-id' && typeof event.data.installId === 'string') {
    installIdCache = event.data.installId;
    event.waitUntil(
      caches
        .open('es-push-meta')
        .then((cache) => cache.put('/__install-id', new Response(event.data.installId)))
        .catch(() => undefined),
    );
  }
});

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let payload = {};
      try {
        payload = event.data ? event.data.json() : {};
      } catch (_) {
        payload = { title: 'Estoque Simples', body: event.data ? event.data.text() : '' };
      }
      const data = Object.assign({}, payload.data || {});
      data.installId = await installId();
      const title = payload.title || 'Estoque Simples';
      await self.registration.showNotification(title, {
        body: payload.body || '',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        lang: 'pt-BR',
        // Avisos do mesmo assunto se substituem em vez de empilhar.
        tag: data.notificationId || data.campaignId || (data.ticketId ? `support-${data.ticketId}` : undefined),
        renotify: false,
        data,
      });
      await report(data, 'delivered');
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(destination(data), self.location.origin).href;
  event.waitUntil(
    (async () => {
      await report(data, 'opened');
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Já tem uma janela do app aberta: leva ela até o aviso, em vez de abrir outra.
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          await client.focus();
          if ('navigate' in client) {
            try {
              await client.navigate(target);
            } catch (_) {
              client.postMessage({ type: 'open', url: target });
            }
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

// O navegador trocou a inscrição (expirou, chaves novas): avisa a página para registrar de novo.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) client.postMessage({ type: 'resubscribe' });
    }),
  );
});
