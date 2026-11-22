self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

const CACHE_NAME = 'wattappsau-pwa-cache-v6';
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
  if (!senderId) return '/';
  if (eventType === 'call') {
    const callerName = (extra && (extra.callerName || extra.fromName)) || ('ID: ' + senderId);
    let callUrl =
      '/?incomingCall=' +
      encodeURIComponent(senderId) +
      '&callerName=' +
      encodeURIComponent(callerName);
    if (extra && extra.callType) {
      callUrl += '&callType=' + encodeURIComponent(extra.callType);
    }
    if (extra && extra.callId) {
      callUrl += '&callId=' + encodeURIComponent(extra.callId);
    }
    return callUrl;
  }

  let url = '/?targetId=' + encodeURIComponent(senderId) + '&action=chat';
  if (extra && extra.fromName) {
    url += '&name=' + encodeURIComponent(extra.fromName);
  }
  return url;
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'SHOW_NOTIFICATION') return;

  const senderId =
    msg.senderId ||
    (msg.data && (msg.data.callerId || msg.data.chatId || msg.data.fromId)) ||
    '';
  const eventType =
    msg.eventType === 'call' ||
    msg.isCall ||
    (msg.data && msg.data.action === 'ANSWER_CALL')
      ? 'call'
      : 'chat';
  const callerName =
    (msg.data && (msg.data.callerName || msg.data.fromName)) ||
    (senderId ? 'ID: ' + senderId : 'WattappsAU');
  const targetUrl =
    (msg.data && msg.data.url) || buildNotificationTargetUrl(senderId, eventType, msg.data);

  event.waitUntil(
    self.registration.showNotification(
      msg.title || (eventType === 'call' ? 'Panggilan Masuk — ' + callerName : 'WattappsAU'),
      {
        body:
          msg.body ||
          (eventType === 'call' ? 'ID: ' + senderId + ' • Ketuk untuk menjawab' : ''),
        icon: '/icon-512.png',
        badge: '/icon-512.png',
        tag: eventType === 'call' ? 'wattappsau-call' : msg.tag,
        renotify: eventType === 'call',
        requireInteraction: eventType === 'call',
        silent: false,
        data: Object.assign({}, msg.data || {}, {
          action: eventType === 'call' ? 'ANSWER_CALL' : 'OPEN_CHAT',
          callerId: senderId,
          callerName,
          url: targetUrl,
          senderId,
          eventType,
        }),
      }
    )
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const senderId = payload.callerId || payload.senderId || payload.fromId || '';
  const eventType =
    payload.eventType === 'call' ||
    payload.type === 'INCOMING_CALL' ||
    payload.action === 'ANSWER_CALL'
      ? 'call'
      : 'chat';
  const callerName =
    payload.callerName || payload.fromName || (senderId ? 'ID: ' + senderId : 'Penelepon');
  const targetUrl = buildNotificationTargetUrl(senderId, eventType, payload);

  event.waitUntil(
    self.registration.showNotification(
      payload.title || (eventType === 'call' ? 'Panggilan Masuk — ' + callerName : 'WattappsAU'),
      {
        body:
          payload.body ||
          (eventType === 'call'
            ? 'ID: ' + senderId + ' • Ketuk untuk menjawab'
            : 'Pesan baru masuk'),
        icon: '/icon-512.png',
        badge: '/icon-512.png',
        tag: eventType === 'call' ? 'wattappsau-call' : payload.tag || 'push-chat-' + senderId,
        renotify: eventType === 'call',
        requireInteraction: eventType === 'call',
        data: Object.assign({}, payload, {
          action: eventType === 'call' ? 'ANSWER_CALL' : 'OPEN_CHAT',
          callerId: senderId,
          callerName,
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
  const data = event.notification.data || {};
  const isCallNotification =
    data.action === 'ANSWER_CALL' || data.eventType === 'call' || data.kind === 'call';

  const callerId = data.callerId || data.senderId || data.fromId || '';
  const callerName =
    data.callerName || data.fromName || (callerId ? 'ID: ' + callerId : 'Penelepon');

  const callOpenUrl =
    '/?incomingCall=' +
    encodeURIComponent(callerId) +
    '&callerName=' +
    encodeURIComponent(callerName) +
    (data.callType ? '&callType=' + encodeURIComponent(data.callType) : '') +
    (data.callId ? '&callId=' + encodeURIComponent(data.callId) : '');

  const targetUrl = isCallNotification ? callOpenUrl : data.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          if (isCallNotification) {
            client.postMessage({
              type: 'TRIGGER_INCOMING_CALL_UI',
              callerId,
              callerName,
              callId: data.callId,
              callType: data.callType,
              isVideo: Boolean(data.isVideo || data.callType === 'video'),
              data,
            });
          } else {
            client.postMessage({
              type: 'OPEN_TARGET',
              url: targetUrl,
              data,
            });
          }
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
