self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

const CACHE_NAME = 'wattappsau-pwa-cache-v5';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => undefined)
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache sw.js itself so updates always take effect immediately
  if (url.pathname === '/sw.js') {
    return;
  }

  // Never intercept PeerJS signaling, WebSockets, or cross-origin API requests
  if (
    url.origin !== self.location.origin &&
    !url.hostname.includes('fonts.googleapis.com') &&
    !url.hostname.includes('fonts.gstatic.com')
  ) {
    return;
  }

  // Network-first for HTML navigation requests so deploys update promptly
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', cloned));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Stale-while-revalidate for static assets & fonts
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});

function buildNotificationTargetUrl(senderId, eventType, extra) {
  const action = eventType === 'call' ? 'call' : 'chat';
  if (!senderId) return '/';
  let url = '/?targetId=' + encodeURIComponent(senderId) + '&action=' + encodeURIComponent(action);
  if (extra && extra.callType) {
    url += '&callType=' + encodeURIComponent(extra.callType);
  }
  if (extra && extra.callId) {
    url += '&callId=' + encodeURIComponent(extra.callId);
  }
  if (extra && extra.fromName) {
    url += '&name=' + encodeURIComponent(extra.fromName);
  }
  return url;
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'SHOW_NOTIFICATION') return;

  const senderId = msg.senderId || (msg.data && (msg.data.chatId || msg.data.fromId)) || '';
  const eventType = msg.eventType === 'call' || msg.isCall ? 'call' : 'chat';
  const targetUrl =
    (msg.data && msg.data.url) || buildNotificationTargetUrl(senderId, eventType, msg.data);

  event.waitUntil(
    self.registration.showNotification(msg.title || 'WattappsAU', {
      body: msg.body || '',
      icon: '/icon-512.png',
      badge: '/icon-512.png',
      tag: msg.tag,
      requireInteraction: eventType === 'call',
      silent: false,
      data: Object.assign({}, msg.data || {}, {
        url: targetUrl,
        senderId,
        eventType,
      }),
    })
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const senderId = payload.senderId || payload.fromId || '';
  const eventType = payload.eventType === 'call' || payload.type === 'INCOMING_CALL' ? 'call' : 'chat';
  const targetUrl = buildNotificationTargetUrl(senderId, eventType, payload);

  event.waitUntil(
    self.registration.showNotification(
      payload.title || (eventType === 'call' ? 'Panggilan Masuk - WattappsAU' : 'WattappsAU'),
      {
        body: payload.body || (eventType === 'call' ? 'Ketuk untuk menjawab panggilan...' : 'Pesan baru masuk'),
        icon: '/icon-512.png',
        badge: '/icon-512.png',
        tag: payload.tag || ('push-' + eventType + '-' + senderId),
        requireInteraction: eventType === 'call',
        data: Object.assign({}, payload, {
          url: targetUrl,
          senderId,
          eventType,
        }),
      }
    )
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.postMessage({
            type: 'OPEN_TARGET',
            url: targetUrl,
            data: event.notification.data,
          });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});
