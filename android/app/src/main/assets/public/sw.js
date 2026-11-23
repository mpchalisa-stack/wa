self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

const CACHE_NAME = 'wattappsau-pwa-cache-v7';
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
    const callType =
      (extra && extra.callType) || (extra && extra.isVideo ? 'video' : 'audio');
    let callUrl =
      '/?incomingCall=' +
      encodeURIComponent(senderId) +
      '&callerName=' +
      encodeURIComponent(callerName) +
      '&callType=' +
      encodeURIComponent(callType);
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
    (msg.data && (msg.data.action === 'ANSWER_CALL' || msg.data.kind === 'call'))
      ? 'call'
      : 'chat';
  const isVideo = Boolean(
    msg.isVideo || (msg.data && (msg.data.isVideo || msg.data.callType === 'video'))
  );
  const callerName =
    (msg.data && (msg.data.callerName || msg.data.fromName)) ||
    (senderId ? 'ID: ' + senderId : 'WattappsAU');
  const icon = msg.icon || (msg.data && msg.data.callerAvatar) || '/icon-512.png';
  const targetUrl =
    (msg.data && msg.data.url) || buildNotificationTargetUrl(senderId, eventType, msg.data);

  const notifTitle =
    eventType === 'call' ? callerName : msg.title || callerName || 'WattappsAU';
  const notifBody =
    eventType === 'call'
      ? isVideo
        ? 'Panggilan video WattappsAU'
        : 'Panggilan suara WattappsAU'
      : msg.body || 'Pesan baru masuk';

  event.waitUntil(
    self.registration.showNotification(notifTitle, {
      body: notifBody,
      icon,
      badge: '/icon-512.png',
      tag:
        eventType === 'call'
          ? 'wattapps-call-' + (senderId || 'active')
          : msg.tag || 'wattapps-chat-' + (senderId || Date.now()),
      renotify: eventType === 'call',
      requireInteraction: eventType === 'call',
      vibrate: eventType === 'call' ? [1000, 500, 1000, 500, 1000] : [200, 100, 200],
      silent: false,
      actions:
        eventType === 'call'
          ? [
              { action: 'reject_call', title: 'Tolak' },
              { action: 'accept_call', title: 'Jawab' },
            ]
          : [{ action: 'open_chat', title: 'Balas / Buka Chat' }],
      data: Object.assign({}, msg.data || {}, {
        action: eventType === 'call' ? 'ANSWER_CALL' : 'OPEN_CHAT',
        kind: eventType === 'call' ? 'call' : 'message',
        callerId: senderId,
        callerName,
        callType: isVideo ? 'video' : 'audio',
        isVideo,
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

  const senderId = payload.callerId || payload.senderId || payload.fromId || '';
  const eventType =
    payload.eventType === 'call' ||
    payload.type === 'INCOMING_CALL' ||
    payload.action === 'ANSWER_CALL'
      ? 'call'
      : 'chat';
  const isVideo = Boolean(payload.isVideo || payload.callType === 'video');
  const callerName =
    payload.callerName || payload.fromName || (senderId ? 'ID: ' + senderId : 'WattappsAU');
  const icon = payload.icon || payload.callerAvatar || '/icon-512.png';
  const targetUrl = buildNotificationTargetUrl(senderId, eventType, payload);

  const notifTitle =
    eventType === 'call' ? callerName : payload.title || callerName || 'WattappsAU';
  const notifBody =
    eventType === 'call'
      ? isVideo
        ? 'Panggilan video WattappsAU'
        : 'Panggilan suara WattappsAU'
      : payload.body || 'Pesan baru masuk';

  event.waitUntil(
    self.registration.showNotification(notifTitle, {
      body: notifBody,
      icon,
      badge: '/icon-512.png',
      tag:
        eventType === 'call'
          ? 'wattapps-call-' + (senderId || 'active')
          : payload.tag || 'push-chat-' + senderId,
      renotify: eventType === 'call',
      requireInteraction: eventType === 'call',
      vibrate: eventType === 'call' ? [1000, 500, 1000, 500, 1000] : [200, 100, 200],
      actions:
        eventType === 'call'
          ? [
              { action: 'reject_call', title: 'Tolak' },
              { action: 'accept_call', title: 'Jawab' },
            ]
          : [{ action: 'open_chat', title: 'Balas / Buka Chat' }],
      data: Object.assign({}, payload, {
        action: eventType === 'call' ? 'ANSWER_CALL' : 'OPEN_CHAT',
        kind: eventType === 'call' ? 'call' : 'message',
        callerId: senderId,
        callerName,
        callType: isVideo ? 'video' : 'audio',
        isVideo,
        url: targetUrl,
        senderId,
        eventType,
      }),
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action || '';
  const data = event.notification.data || {};
  const isCallNotification =
    action === 'reject_call' ||
    action === 'accept_call' ||
    data.action === 'ANSWER_CALL' ||
    data.eventType === 'call' ||
    data.kind === 'call';

  const callerId = data.callerId || data.senderId || data.fromId || '';
  const callerName =
    data.callerName || data.fromName || (callerId ? 'ID: ' + callerId : 'Penelepon');
  const isVideo = Boolean(data.isVideo || data.callType === 'video');
  const callType = isVideo ? 'video' : 'audio';

  // 1. Tombol "Tolak" pada notifikasi panggilan: tolak panggilan langsung tanpa membuka kunci / memfokuskan jendela
  if (action === 'reject_call') {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
        for (const client of windowClients) {
          client.postMessage({
            type: 'REJECT_INCOMING_CALL_FROM_NOTIFICATION',
            callerId,
            callerName,
            callId: data.callId,
            callType,
            isVideo,
            data,
          });
        }
      })
    );
    return;
  }

  const callOpenUrl =
    '/?incomingCall=' +
    encodeURIComponent(callerId) +
    '&callerName=' +
    encodeURIComponent(callerName) +
    '&callType=' +
    encodeURIComponent(callType) +
    (data.callId ? '&callId=' + encodeURIComponent(data.callId) : '');

  // 2. Tombol "Jawab" pada notifikasi panggilan: buka/fokuskan aplikasi & angkat jika izin sudah siap
  if (action === 'accept_call') {
    const autoAcceptUrl = callOpenUrl + '&autoAccept=1';
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
        for (const client of windowClients) {
          if ('focus' in client) {
            client.postMessage({
              type: 'ACCEPT_INCOMING_CALL_FROM_NOTIFICATION',
              callerId,
              callerName,
              callId: data.callId,
              callType,
              isVideo,
              data,
            });
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(autoAcceptUrl);
        }
        return undefined;
      })
    );
    return;
  }

  // 3. Ketuk badan notifikasi panggilan atau tombol "Balas / Buka Chat" / badan notifikasi pesan
  const targetUrl =
    action === 'open_chat'
      ? data.url || buildNotificationTargetUrl(callerId, 'chat', data)
      : isCallNotification
      ? callOpenUrl
      : data.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          if (isCallNotification && action !== 'open_chat') {
            client.postMessage({
              type: 'TRIGGER_INCOMING_CALL_UI',
              callerId,
              callerName,
              callId: data.callId,
              callType,
              isVideo,
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
