import { getSharedAudioContext, triggerAlertVibration } from './audio';

/**
 * Menghasilkan WAV PCM 16-bit mono 1 detik yang hampir hening (tanpa dependensi file eksternal)
 * untuk diputar melingkar pada elemen <audio> dengan volume 0.001.
 * Ini menjaga tab browser Android tetap dianggap aktif memutar media saat layar redup/terkunci.
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
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // 1 channel (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  // Isi nilai sangat kecil (±1 LSB) agar decoder audio tidak menganggap stream kosong
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

  // 2. Looping HTML5 <audio> volume 0.001 agar Android OS mempertahankan tab & WebRTC di background
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
      playPromise.catch(() => {
        // ignore if autoplay restricted
      });
    }
    started = true;

    // Daftarkan MediaSession agar Android mengenali sesi aktif WattappsAU Mode Siaga
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
    // Sesuai spesifikasi W3C, Wake Lock dilepas saat tab tersembunyi -> minta ulang saat kembali
    void requestScreenWakeLock();
    const ctx = getSharedAudioContext();
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume();
    }
    if (keepAliveAudioEl && keepAliveAudioEl.paused) {
      keepAliveAudioEl.play().catch(() => {});
    }
  }
};

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

  const audioKeepAliveActive = startSilentAudioKeepAlive();
  const [wakeLockActive, notificationPermission] = await Promise.all([
    requestScreenWakeLock(),
    requestNotificationPermission(),
  ]);

  return { wakeLockActive, audioKeepAliveActive, notificationPermission };
}

export async function disableStandbyMode(): Promise<void> {
  isStandbyActive = false;
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
  triggerAlertVibration([500, 200, 500]);

  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  // Tampilkan notifikasi sistem bila layar/tab tidak aktif, sedang panggilan masuk, atau Mode Siaga aktif
  const shouldNotify =
    options.isCall ||
    isStandbyActive ||
    document.visibilityState !== 'visible' ||
    !document.hasFocus();

  if (!shouldNotify) return;

  try {
    const notif = new Notification(options.title, {
      body: options.body,
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
    // Fallback melalui ServiceWorkerRegistration bila Notification constructor dibatasi (Android PWA)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready
        .then((reg) => {
          void reg.showNotification(options.title, {
            body: options.body,
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
