import { triggerAlertVibration } from './audio';

/**
 * Generator Audio Sub-Audible (Bukan Zero-Byte Silence):
 * Menghasilkan file WAV 16-bit PCM berdurasi 10 detik (sample rate 44100 Hz, mono)
 * berisi gelombang sinus 18 Hz amplitudo kecil (Math.sin(...) * 150 dari skala 32767).
 * Tidak terdengar telinga manusia & speaker HP, namun terbaca sebagai aliran media aktif oleh Chrome Android.
 */
let cachedSubAudibleWavBlobUrl: string | null = null;

export function createSubAudibleWavBlobUrl(): string {
  if (cachedSubAudibleWavBlobUrl) return cachedSubAudibleWavBlobUrl;

  const sampleRate = 44100;
  const durationSeconds = 10;
  const numChannels = 1;
  const bitsPerSample = 16;
  const numSamples = sampleRate * durationSeconds; // 441.000 sampel (10 detik)
  const dataByteLength = numSamples * numChannels * (bitsPerSample / 8); // 882.000 bytes
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, numChannels, true); // Mono
  view.setUint32(24, sampleRate, true); // 44100 Hz
  view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true); // ByteRate
  view.setUint16(32, numChannels * (bitsPerSample / 8), true); // BlockAlign
  view.setUint16(34, bitsPerSample, true); // 16-bit
  writeStr(36, 'data');
  view.setUint32(40, dataByteLength, true);

  // Gelombang sinus sub-audible 18 Hz dengan amplitudo 150 (dari skala 32767)
  const freqHz = 18;
  const amplitude = 150;
  const twoPiFreqOverRate = (2 * Math.PI * freqHz) / sampleRate;
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin(twoPiFreqOverRate * i) * amplitude);
    view.setInt16(44 + i * 2, sample, true);
  }

  const blob = new Blob([buffer], { type: 'audio/wav' });
  cachedSubAudibleWavBlobUrl = URL.createObjectURL(blob);
  return cachedSubAudibleWavBlobUrl;
}

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: string, listener: () => void) => void;
}

type NavigatorWithOptionalWakeLock = {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinelLike>;
  };
};

const WATCHDOG_INTERVAL_MS = 15000;

let isStandbyActive = false;
let isPausedForCall = false;
let resumeTimer: number | null = null;
let watchdogTimer: number | null = null;
let wakeLockSentinel: WakeLockSentinelLike | null = null;
let keepAliveAudioEl: HTMLAudioElement | null = null;
let visibilityListenerAttached = false;
let pendingGestureUnlockAttached = false;
let standbyStateListener: ((active: boolean) => void) | null = null;

export function setStandbyExternalListener(listener: ((active: boolean) => void) | null): void {
  standbyStateListener = listener;
}

export function isKeepAliveActuallyPlaying(): boolean {
  return Boolean(keepAliveAudioEl && !keepAliveAudioEl.paused && !keepAliveAudioEl.ended);
}

async function requestScreenWakeLock(): Promise<boolean> {
  try {
    const nav = navigator as unknown as NavigatorWithOptionalWakeLock;
    if (!nav.wakeLock || typeof nav.wakeLock.request !== 'function') {
      return false;
    }
    if (wakeLockSentinel && !wakeLockSentinel.released) {
      return true;
    }
    const sentinel = await nav.wakeLock.request('screen');
    wakeLockSentinel = sentinel;
    sentinel.addEventListener?.('release', () => {
      if (wakeLockSentinel === sentinel) {
        wakeLockSentinel = null;
      }
    });
    return true;
  } catch {
    return false;
  }
}

async function releaseScreenWakeLock(): Promise<void> {
  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
    } catch {
      // ignore
    }
    wakeLockSentinel = null;
  }
}

function registerStandbyMediaSession(state: 'playing' | 'paused' | 'none'): void {
  try {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    if (state === 'none') {
      navigator.mediaSession.playbackState = 'none';
      try {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
      } catch {
        // ignore
      }
      return;
    }

    if (typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'WattappsAU — Saluran Siaga Aktif',
        artist: 'Komunikasi Taktis P2P',
        artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
    }

    // Chrome Android mewajibkan minimal satu action handler agar kartu Media Session muncul di layar kunci
    try {
      navigator.mediaSession.setActionHandler('play', () => {
        if (isPausedForCall) return;
        isStandbyActive = true;
        standbyStateListener?.(true);
        void startSilentAudioKeepAlive();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        // Pengguna menekan jeda langsung dari kartu layar kunci
        void disableStandbyMode();
        standbyStateListener?.(false);
      });
    } catch {
      // ignore unsupported action handlers
    }

    navigator.mediaSession.playbackState = state;
  } catch {
    // ignore on unsupported browsers
  }
}

function ensureKeepAliveAudioElement(): HTMLAudioElement {
  if (!keepAliveAudioEl) {
    const existing = document.getElementById('keepalive-audio') as HTMLAudioElement | null;
    if (existing) {
      keepAliveAudioEl = existing;
    } else {
      const audio = document.createElement('audio');
      audio.id = 'keepalive-audio';
      audio.style.display = 'none';
      audio.setAttribute('aria-hidden', 'true');
      document.body.appendChild(audio);
      keepAliveAudioEl = audio;
    }
  }

  const blobUrl = createSubAudibleWavBlobUrl();
  if (keepAliveAudioEl.src !== blobUrl) {
    keepAliveAudioEl.src = blobUrl;
  }
  keepAliveAudioEl.loop = true;
  keepAliveAudioEl.setAttribute('loop', '');
  keepAliveAudioEl.setAttribute('playsinline', 'true');
  keepAliveAudioEl.setAttribute('webkit-playsinline', 'true');
  keepAliveAudioEl.preload = 'auto';
  // Pengaturan wajib agar Chrome Android mengakui aliran audio aktif
  keepAliveAudioEl.muted = false;
  keepAliveAudioEl.volume = 0.5;
  return keepAliveAudioEl;
}

function startStandbyWatchdog(): void {
  if (watchdogTimer !== null) return;
  watchdogTimer = window.setInterval(() => {
    if (isStandbyActive && !isPausedForCall) {
      const audio = keepAliveAudioEl;
      if (!audio || audio.paused) {
        void startSilentAudioKeepAlive();
      }
    }
  }, WATCHDOG_INTERVAL_MS);
}

function stopStandbyWatchdog(): void {
  if (watchdogTimer !== null) {
    window.clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

const handleGestureAutoplayResume = () => {
  disarmPendingGestureUnlock();
  if (!isStandbyActive || isPausedForCall) return;
  void startSilentAudioKeepAlive();
  void requestScreenWakeLock();
};

function armPendingGestureUnlock(): void {
  if (pendingGestureUnlockAttached || typeof window === 'undefined') return;
  pendingGestureUnlockAttached = true;
  window.addEventListener('pointerdown', handleGestureAutoplayResume, { passive: true });
  window.addEventListener('touchstart', handleGestureAutoplayResume, { passive: true });
  window.addEventListener('keydown', handleGestureAutoplayResume, { passive: true });
}

function disarmPendingGestureUnlock(): void {
  if (!pendingGestureUnlockAttached || typeof window === 'undefined') return;
  pendingGestureUnlockAttached = false;
  window.removeEventListener('pointerdown', handleGestureAutoplayResume);
  window.removeEventListener('touchstart', handleGestureAutoplayResume);
  window.removeEventListener('keydown', handleGestureAutoplayResume);
}

async function startSilentAudioKeepAlive(): Promise<boolean> {
  if (!isStandbyActive || isPausedForCall) return false;
  if (typeof document === 'undefined') return false;

  try {
    const audio = ensureKeepAliveAudioElement();
    // Jalankan audio.play() langsung tanpa await lain di depannya agar tetap dalam user gesture
    await audio.play();
    disarmPendingGestureUnlock();
    registerStandbyMediaSession('playing');
    startStandbyWatchdog();
    return true;
  } catch {
    // Jika browser menahan autoplay sebelum interaksi pertama, tunggu sentuhan pertama di layar
    armPendingGestureUnlock();
    return false;
  }
}

function stopSilentAudioKeepAlive(playbackState: 'paused' | 'none' = 'none'): void {
  if (keepAliveAudioEl) {
    try {
      keepAliveAudioEl.pause();
    } catch {
      // ignore
    }
  }
  registerStandbyMediaSession(playbackState);
}

const handleStandbyVisibilityChange = () => {
  if (!isStandbyActive) return;
  if (document.visibilityState === 'visible') {
    void requestScreenWakeLock();
    if (!isPausedForCall && keepAliveAudioEl && keepAliveAudioEl.paused) {
      void startSilentAudioKeepAlive();
    }
  }
};

/**
 * Transisi Saat Panggilan Masuk & Keluar:
 * Jeda sementara (audio.pause()) audio sub-audible penjaga agar mikrofon & speaker panggilan tidak bentrok.
 */
export function pauseKeepAliveForCall(): void {
  if (resumeTimer !== null) {
    window.clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  isPausedForCall = true;
  stopSilentAudioKeepAlive('paused');
}

/**
 * Setelah panggilan selesai (call.on('close')), jika Mode Siaga masih aktif,
 * jalankan kembali audio.play() dan Media Session agar perangkat kembali siaga di layar kunci.
 */
export function resumeKeepAliveAfterCall(): void {
  isPausedForCall = false;
  if (!isStandbyActive) return;
  if (resumeTimer !== null) {
    window.clearTimeout(resumeTimer);
  }
  resumeTimer = window.setTimeout(() => {
    resumeTimer = null;
    if (isStandbyActive && !isPausedForCall) {
      void startSilentAudioKeepAlive();
      void requestScreenWakeLock();
    }
  }, 500);
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function getNotificationPermissionState(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export async function enableStandbyMode(): Promise<{
  wakeLockActive: boolean;
  audioKeepAliveActive: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
}> {
  isStandbyActive = true;

  if (!visibilityListenerAttached && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleStandbyVisibilityChange);
    visibilityListenerAttached = true;
  }

  // WAJIB panggil audio.play() terlebih dahulu secara sinkron di dalam event klik user
  const audioPlayPromise = !isPausedForCall
    ? startSilentAudioKeepAlive()
    : Promise.resolve(false);
  startStandbyWatchdog();

  const [audioKeepAliveActive, wakeLockActive, notificationPermission] = await Promise.all([
    audioPlayPromise,
    requestScreenWakeLock(),
    requestNotificationPermission(),
  ]);

  return { wakeLockActive, audioKeepAliveActive, notificationPermission };
}

export async function disableStandbyMode(): Promise<void> {
  isStandbyActive = false;
  disarmPendingGestureUnlock();
  stopStandbyWatchdog();
  if (resumeTimer !== null) {
    window.clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  if (visibilityListenerAttached && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleStandbyVisibilityChange);
    visibilityListenerAttached = false;
  }
  stopSilentAudioKeepAlive('none');
  await releaseScreenWakeLock();
}

export interface NotificationClickData {
  kind: 'message' | 'call';
  url?: string;
  chatId?: string;
  fromId?: string;
  fromName?: string;
  callId?: string;
  callType?: 'audio' | 'video';
}

export function buildNotificationUrl(options: {
  senderId?: string;
  eventType: 'call' | 'chat';
  callType?: 'audio' | 'video';
  callId?: string;
  fromName?: string;
}): string {
  const senderId = options.senderId?.trim();
  if (!senderId) return '/';
  let url = `/?targetId=${encodeURIComponent(senderId)}&action=${encodeURIComponent(options.eventType)}`;
  if (options.callType) {
    url += `&callType=${encodeURIComponent(options.callType)}`;
  }
  if (options.callId) {
    url += `&callId=${encodeURIComponent(options.callId)}`;
  }
  if (options.fromName) {
    url += `&name=${encodeURIComponent(options.fromName)}`;
  }
  return url;
}

export function showIncomingWebNotification(options: {
  title: string;
  body: string;
  tag: string;
  isCall?: boolean;
  data?: NotificationClickData;
  onClick?: () => void;
}): void {
  triggerAlertVibration(options.isCall ? [1000, 300, 1000] : [500, 200, 500]);

  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const shouldNotify =
    options.isCall ||
    isStandbyActive ||
    document.visibilityState !== 'visible' ||
    !document.hasFocus();

  if (!shouldNotify) return;

  const notifTitle = options.isCall ? 'Panggilan Masuk - WattappsAU' : options.title;
  const notifBody = options.isCall
    ? options.body || 'Ketuk untuk menjawab panggilan...'
    : options.body;

  const senderId = options.data?.chatId || options.data?.fromId || '';
  const eventType: 'call' | 'chat' =
    options.isCall || options.data?.kind === 'call' ? 'call' : 'chat';
  const targetUrl =
    options.data?.url ||
    buildNotificationUrl({
      senderId,
      eventType,
      callType: options.data?.callType,
      callId: options.data?.callId,
      fromName: options.data?.fromName,
    });

  const enrichedData: NotificationClickData = {
    ...(options.data || { kind: eventType === 'call' ? 'call' : 'message' }),
    url: targetUrl,
  };

  const showWindowNotificationFallback = () => {
    try {
      const notif = new Notification(notifTitle, {
        body: notifBody,
        icon: '/icon-512.png',
        badge: '/icon-512.png',
        tag: options.tag,
        requireInteraction: Boolean(options.isCall),
        silent: false,
        data: enrichedData,
      });

      notif.onclick = () => {
        try {
          window.focus();
        } catch {
          // ignore
        }
        options.onClick?.();
        notif.close();
      };
    } catch {
      // ignore if browser only supports ServiceWorkerRegistration.showNotification
    }
  };

  // Utamakan Service Worker showNotification dengan data: { url: '/?targetId=...&action=...' }
  // agar event notificationclick di sw.js selalu memfokuskan/membuka aplikasi di Android & PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .getRegistration()
      .then((reg) => {
        if (reg && reg.active) {
          return reg.showNotification(notifTitle, {
            body: notifBody,
            icon: '/icon-512.png',
            badge: '/icon-512.png',
            tag: options.tag,
            requireInteraction: Boolean(options.isCall),
            silent: false,
            data: enrichedData,
          });
        }
        return navigator.serviceWorker.ready.then((readyReg) =>
          readyReg.showNotification(notifTitle, {
            body: notifBody,
            icon: '/icon-512.png',
            badge: '/icon-512.png',
            tag: options.tag,
            requireInteraction: Boolean(options.isCall),
            silent: false,
            data: enrichedData,
          })
        );
      })
      .catch(() => {
        showWindowNotificationFallback();
      });
    return;
  }

  showWindowNotificationFallback();
}
