import { triggerAlertVibration } from './audio';

/**
 * Generator Audio Hening (Silent Audio Loop):
 * Menghasilkan file audio WAV sunyi (8000Hz, mono, 16-bit PCM, 1 detik berisi byte nol/hening)
 * dalam bentuk Blob URL agar dapat diputar loop pada elemen <audio loop playsInline> volume 0.01.
 */
let cachedSilentWavBlobUrl: string | null = null;

export function createSilentWavBlobUrl(): string {
  if (cachedSilentWavBlobUrl) return cachedSilentWavBlobUrl;

  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const numSamples = sampleRate; // 1 detik
  const dataByteLength = numSamples * numChannels * (bitsPerSample / 8); // 16000 bytes bernilai nol (hening)
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
  view.setUint32(24, sampleRate, true); // 8000 Hz
  view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true); // ByteRate
  view.setUint16(32, numChannels * (bitsPerSample / 8), true); // BlockAlign
  view.setUint16(34, bitsPerSample, true); // 16-bit
  writeStr(36, 'data');
  view.setUint32(40, dataByteLength, true);
  // Byte data 44..(44+dataByteLength) otomatis terisi nol (0x00 = hening total) oleh ArrayBuffer

  const blob = new Blob([buffer], { type: 'audio/wav' });
  cachedSilentWavBlobUrl = URL.createObjectURL(blob);
  return cachedSilentWavBlobUrl;
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

let isStandbyActive = false;
let isPausedForCall = false;
let resumeTimer: number | null = null;
let wakeLockSentinel: WakeLockSentinelLike | null = null;
let keepAliveAudioEl: HTMLAudioElement | null = null;
let visibilityListenerAttached = false;
let pendingGestureUnlockAttached = false;

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
      return;
    }
    if (typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'WattappsAU — Mode Siaga Aktif',
        artist: 'Saluran Taktis P2P Terenkripsi',
        album: 'Diskomlekau',
        artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
    }
    navigator.mediaSession.playbackState = state;
  } catch {
    // ignore on unsupported browsers
  }
}

function ensureKeepAliveAudioElement(): HTMLAudioElement {
  if (!keepAliveAudioEl) {
    const audio = document.createElement('audio');
    audio.src = createSilentWavBlobUrl();
    audio.loop = true;
    audio.setAttribute('playsinline', 'true');
    audio.setAttribute('webkit-playsinline', 'true');
    audio.preload = 'auto';
    audio.volume = 0.01;
    keepAliveAudioEl = audio;
  }
  keepAliveAudioEl.loop = true;
  keepAliveAudioEl.volume = 0.01;
  return keepAliveAudioEl;
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
  // Jangan pernah menyalakan silent keep-alive saat panggilan aktif atau Mode Siaga mati
  if (!isStandbyActive || isPausedForCall) return false;
  if (typeof document === 'undefined') return false;

  try {
    const audio = ensureKeepAliveAudioElement();
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.then === 'function') {
      await playPromise;
    }
    disarmPendingGestureUnlock();
    registerStandbyMediaSession('playing');
    return true;
  } catch {
    // Jika browser memblokir autoplay sebelum interaksi pertama (default Mode Siaga saat baru dibuka),
    // tunggu sentuhan/klik pertama di layar untuk otomatis menyalakan audio loop & Media Session
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
 * Transisi Otomatis Saat Panggilan Masuk / Keluar (Anti-Bentrok Audio):
 * Jeda sementara (audio.pause()) silent audio loop agar mikrofon & speaker panggilan tidak bentrok.
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
 * otomatis jalankan kembali audio.play() dan Media Session agar HP kembali siaga saat layar dikunci.
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
  }, 600);
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

  const [audioKeepAliveActive, wakeLockActive, notificationPermission] = await Promise.all([
    !isPausedForCall ? startSilentAudioKeepAlive() : Promise.resolve(false),
    requestScreenWakeLock(),
    requestNotificationPermission(),
  ]);

  return { wakeLockActive, audioKeepAliveActive, notificationPermission };
}

export async function disableStandbyMode(): Promise<void> {
  isStandbyActive = false;
  disarmPendingGestureUnlock();
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

export function showIncomingWebNotification(options: {
  title: string;
  body: string;
  tag: string;
  isCall?: boolean;
  onClick?: () => void;
}): void {
  triggerAlertVibration(options.isCall ? [800, 400, 800] : [500, 200, 500]);

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

  try {
    const notif = new Notification(notifTitle, {
      body: notifBody,
      icon: '/icon-512.png',
      badge: '/icon-512.png',
      tag: options.tag,
      requireInteraction: Boolean(options.isCall),
      silent: false,
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
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready
        .then((reg) => {
          void reg.showNotification(notifTitle, {
            body: notifBody,
            icon: '/icon-512.png',
            badge: '/icon-512.png',
            tag: options.tag,
            requireInteraction: Boolean(options.isCall),
          });
        })
        .catch(() => {});
    }
  }
}
