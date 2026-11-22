import { getSharedAudioContext, triggerAlertVibration } from './audio';

/**
 * Menghasilkan WAV PCM 16-bit mono 1 detik yang hampir hening (tanpa dependensi file eksternal)
 * untuk diputar melingkar pada elemen <audio> dengan volume 0.001 saat Mode Siaga aktif.
 */
function createSilentLoopWavDataUrl(): string {
  const sampleRate = 8000;
  const numSamples = sampleRate; // 1 detik
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, i % 2 === 0 ? 1 : -1, true);
  }

  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
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
let keepAliveOsc: OscillatorNode | null = null;
let keepAliveGain: GainNode | null = null;
let visibilityListenerAttached = false;

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

function startSilentAudioKeepAlive(): boolean {
  // Jangan pernah menyalakan silent keep-alive saat sedang ada panggilan aktif atau Mode Siaga mati
  if (!isStandbyActive || isPausedForCall) return false;
  let started = false;

  // 1. Silent Web Audio API Oscillator (volume 0.001) agar AudioContext tetap hidup
  try {
    const ctx = getSharedAudioContext();
    if (ctx && !keepAliveOsc) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(20, ctx.currentTime);
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      keepAliveOsc = osc;
      keepAliveGain = gain;
      started = true;
    }
  } catch {
    // ignore
  }

  // 2. Looping HTML5 <audio> volume 0.001
  try {
    if (!keepAliveAudioEl) {
      const audio = document.createElement('audio');
      audio.src = createSilentLoopWavDataUrl();
      audio.loop = true;
      audio.volume = 0.001;
      audio.setAttribute('playsinline', 'true');
      keepAliveAudioEl = audio;
    }
    keepAliveAudioEl.volume = 0.001;
    const playPromise = keepAliveAudioEl.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.catch(() => {});
    }
    started = true;

    if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'WattappsAU — Mode Siaga Aktif',
        artist: 'Koneksi P2P Diskomlekau',
        artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
      navigator.mediaSession.playbackState = 'playing';
    }
  } catch {
    // ignore
  }

  return started;
}

function stopSilentAudioKeepAlive(): void {
  if (keepAliveOsc) {
    try {
      keepAliveOsc.stop();
      keepAliveOsc.disconnect();
    } catch {
      // ignore
    }
    keepAliveOsc = null;
  }
  if (keepAliveGain) {
    try {
      keepAliveGain.disconnect();
    } catch {
      // ignore
    }
    keepAliveGain = null;
  }
  if (keepAliveAudioEl) {
    try {
      keepAliveAudioEl.pause();
      keepAliveAudioEl.currentTime = 0;
    } catch {
      // ignore
    }
  }
  try {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
    }
  } catch {
    // ignore
  }
}

const handleStandbyVisibilityChange = () => {
  if (!isStandbyActive) return;
  if (document.visibilityState === 'visible') {
    void requestScreenWakeLock();
    if (!isPausedForCall) {
      const ctx = getSharedAudioContext();
      if (ctx && ctx.state === 'suspended') {
        void ctx.resume();
      }
      if (keepAliveAudioEl && keepAliveAudioEl.paused) {
        keepAliveAudioEl.play().catch(() => {});
      }
    }
  }
};

/**
 * Hentikan otomatis Silent Audio Keep-Alive saat panggilan masuk/keluar dimulai
 * agar tidak membentrokkan AudioContext mikrofon & speaker pada perangkat Android (Poco X8 Pro, Galaxy Tab S8, dll).
 */
export function pauseKeepAliveForCall(): void {
  if (resumeTimer !== null) {
    window.clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  isPausedForCall = true;
  stopSilentAudioKeepAlive();
}

/**
 * Lanjutkan Silent Audio Keep-Alive setelah panggilan berakhir jika Mode Siaga masih menyala.
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
      startSilentAudioKeepAlive();
    }
  }, 700);
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

  const audioKeepAliveActive = !isPausedForCall ? startSilentAudioKeepAlive() : false;
  const [wakeLockActive, notificationPermission] = await Promise.all([
    requestScreenWakeLock(),
    requestNotificationPermission(),
  ]);

  return { wakeLockActive, audioKeepAliveActive, notificationPermission };
}

export async function disableStandbyMode(): Promise<void> {
  isStandbyActive = false;
  if (resumeTimer !== null) {
    window.clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  if (visibilityListenerAttached && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleStandbyVisibilityChange);
    visibilityListenerAttached = false;
  }
  stopSilentAudioKeepAlive();
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

  // Untuk panggilan masuk, selalu tampilkan banner mengambang; untuk pesan, tampilkan jika tab tidak fokus/latar belakang atau Mode Siaga aktif
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
    // Fallback melalui ServiceWorkerRegistration untuk Android PWA
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
