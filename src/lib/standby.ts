import { triggerAlertVibration } from './audio';
import {
  cancelNativeCallNotifications,
  isNativeCapacitor,
  scheduleNativeLocalNotification,
  setNativeKeepAwake,
} from './nativeAndroid';

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

let cachedMinimalArtworkDataUrl: string | null = null;

/**
 * Menghasilkan ikon minimalis 192x192px (gelap netral transparan dengan gelombang sinyal halus)
 * dalam bentuk DataURL khusus untuk artwork Media Session layar kunci agar tidak mencolok.
 */
function createMinimalStandbyArtworkDataUrl(): string {
  if (cachedMinimalArtworkDataUrl) return cachedMinimalArtworkDataUrl;

  const fallbackSvg =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">` +
        `<rect width="192" height="192" rx="36" fill="#1e293b" fill-opacity="0.88"/>` +
        `<g fill="none" stroke="#94a3b8" stroke-width="6" stroke-linecap="round" stroke-opacity="0.65">` +
        `<path d="M68 68 A40 40 0 0 0 68 124"/>` +
        `<path d="M124 68 A40 40 0 0 1 124 124"/>` +
        `<path d="M50 50 A65 65 0 0 0 50 142" stroke-opacity="0.38"/>` +
        `<path d="M142 50 A65 65 0 0 1 142 142" stroke-opacity="0.38"/>` +
        `</g>` +
        `<circle cx="96" cy="96" r="10" fill="#94a3b8" fill-opacity="0.8"/>` +
        `</svg>`
    );

  if (typeof document === 'undefined') {
    cachedMinimalArtworkDataUrl = fallbackSvg;
    return cachedMinimalArtworkDataUrl;
  }

  try {
    const size = 192;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      cachedMinimalArtworkDataUrl = fallbackSvg;
      return cachedMinimalArtworkDataUrl;
    }

    // Latar belakang gelap abu-abu transparan netral
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(24, 34, 41, 0.88)';
    ctx.beginPath();
    ctx.roundRect(10, 10, size - 20, size - 20, 36);
    ctx.fill();

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const cx = size / 2;
    const cy = size / 2;

    // Gelombang sinyal netral minimalis (kiri & kanan)
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.65)';
    ctx.lineWidth = 5.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 32, Math.PI * 0.72, Math.PI * 1.28);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 32, -Math.PI * 0.28, Math.PI * 0.28);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.34)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, 54, Math.PI * 0.74, Math.PI * 1.26);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 54, -Math.PI * 0.26, Math.PI * 0.26);
    ctx.stroke();

    // Titik pusat sinyal netral
    ctx.fillStyle = 'rgba(148, 163, 184, 0.82)';
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.fill();

    cachedMinimalArtworkDataUrl = canvas.toDataURL('image/png');
    return cachedMinimalArtworkDataUrl;
  } catch {
    cachedMinimalArtworkDataUrl = fallbackSvg;
    return cachedMinimalArtworkDataUrl;
  }
}

function registerStandbyMediaSession(state: 'playing' | 'paused' | 'none'): void {
  try {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    if (state === 'none') {
      navigator.mediaSession.playbackState = 'none';
      try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
      } catch {
        // ignore
      }
      return;
    }

    if (typeof MediaMetadata !== 'undefined') {
      const minimalArtwork = createMinimalStandbyArtworkDataUrl();
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Layanan Siaga Aktif',
        artist: 'Terhubung',
        album: '',
        artwork: [
          {
            src: minimalArtwork,
            sizes: '192x192',
            type: minimalArtwork.startsWith('data:image/png') ? 'image/png' : 'image/svg+xml',
          },
        ],
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
  const audio =
    keepAliveAudioEl ||
    (typeof document !== 'undefined'
      ? (document.getElementById('keepalive-audio') as HTMLAudioElement | null)
      : null);
  if (audio) {
    try {
      audio.pause();
      if (playbackState === 'none') {
        audio.currentTime = 0;
      }
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
    setNativeKeepAwake(true),
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
  await Promise.all([releaseScreenWakeLock(), setNativeKeepAwake(false)]);
}

export interface NotificationClickData {
  kind: 'message' | 'call';
  action?: 'ANSWER_CALL' | 'OPEN_CHAT';
  url?: string;
  chatId?: string;
  fromId?: string;
  fromName?: string;
  callerId?: string;
  callerName?: string;
  callerAvatar?: string;
  callId?: string;
  callType?: 'audio' | 'video';
  isVideo?: boolean;
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
  if (options.eventType === 'call') {
    const callerName = options.fromName?.trim() || `ID: ${senderId}`;
    let url = `/?incomingCall=${encodeURIComponent(senderId)}&callerName=${encodeURIComponent(callerName)}`;
    if (options.callType) {
      url += `&callType=${encodeURIComponent(options.callType)}`;
    }
    if (options.callId) {
      url += `&callId=${encodeURIComponent(options.callId)}`;
    }
    return url;
  }

  let url = `/?targetId=${encodeURIComponent(senderId)}&action=chat`;
  if (options.fromName) {
    url += `&name=${encodeURIComponent(options.fromName)}`;
  }
  return url;
}

interface NotificationActionOption {
  action: string;
  title: string;
  icon?: string;
}

type ExtendedSWNotificationOptions = NotificationOptions & {
  renotify?: boolean;
  vibrate?: number[];
  actions?: NotificationActionOption[];
};

export function showIncomingWebNotification(options: {
  title: string;
  body: string;
  tag: string;
  icon?: string;
  isCall?: boolean;
  data?: NotificationClickData;
  onClick?: () => void;
}): void {
  const isCall = Boolean(options.isCall || options.data?.kind === 'call');
  triggerAlertVibration(isCall ? [1000, 500, 1000, 500, 1000] : [250, 120, 250]);

  const senderId =
    options.data?.callerId || options.data?.chatId || options.data?.fromId || '';
  const callerName =
    options.data?.callerName ||
    options.data?.fromName ||
    (senderId ? `ID: ${senderId}` : 'Penelepon');
  const isVideo = Boolean(options.data?.isVideo || options.data?.callType === 'video');

  // Format notifikasi khas WhatsApp:
  // Panggilan: Title = Nama Penelepon (atau "ID: ..."), Body = "Panggilan suara/video WattappsAU"
  // Pesan: Title = Nama Pengirim, Body = Isi teks / "📷 Foto"
  const notifTitle = isCall ? callerName : options.title;
  const notifBody = isCall
    ? isVideo
      ? 'Panggilan video WattappsAU'
      : 'Panggilan suara WattappsAU'
    : options.body;

  // Pada aplikasi Android Native (Capacitor APK), kirim melalui LocalNotifications berprioritas tinggi di layar kunci
  if (isNativeCapacitor()) {
    void scheduleNativeLocalNotification({
      title: notifTitle,
      body: notifBody,
      isCall,
      callerId: senderId,
      callerName,
      callId: options.data?.callId,
      callType: isVideo ? 'video' : 'audio',
      chatId: options.data?.chatId || senderId,
    });
    return;
  }

  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const shouldNotify =
    isCall ||
    isStandbyActive ||
    document.visibilityState !== 'visible' ||
    !document.hasFocus();

  if (!shouldNotify) return;

  const notifIcon =
    options.icon?.trim() || options.data?.callerAvatar?.trim() || '/icon-512.png';
  const notifTag = isCall ? `wattapps-call-${senderId || 'active'}` : options.tag;

  const eventType: 'call' | 'chat' = isCall ? 'call' : 'chat';
  const targetUrl =
    options.data?.url ||
    buildNotificationUrl({
      senderId,
      eventType,
      callType: isVideo ? 'video' : 'audio',
      callId: options.data?.callId,
      fromName: callerName,
    });

  const enrichedData: NotificationClickData = {
    ...(options.data || { kind: isCall ? 'call' : 'message' }),
    kind: isCall ? 'call' : 'message',
    action: isCall ? 'ANSWER_CALL' : 'OPEN_CHAT',
    callerId: senderId,
    callerName,
    callType: isVideo ? 'video' : 'audio',
    isVideo,
    url: targetUrl,
  };

  // Opsi lengkap khusus ServiceWorkerRegistration.showNotification (mendukung actions, vibrate, renotify)
  const swNotifOptions: ExtendedSWNotificationOptions = {
    body: notifBody,
    icon: notifIcon,
    badge: '/icon-512.png',
    tag: notifTag,
    renotify: isCall,
    requireInteraction: isCall,
    vibrate: isCall ? [1000, 500, 1000, 500, 1000] : [200, 100, 200],
    silent: false,
    actions: isCall
      ? [
          { action: 'reject_call', title: 'Tolak' },
          { action: 'accept_call', title: 'Jawab' },
        ]
      : [{ action: 'open_chat', title: 'Balas / Buka Chat' }],
    data: enrichedData,
  };

  // Fallback window.Notification tanpa properti `actions` agar tidak memicu TypeError
  const windowNotifOptions: NotificationOptions = {
    body: notifBody,
    icon: notifIcon,
    badge: '/icon-512.png',
    tag: notifTag,
    requireInteraction: isCall,
    silent: false,
    data: enrichedData,
  };

  const showWindowNotificationFallback = () => {
    try {
      const notif = new Notification(notifTitle, windowNotifOptions);

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

  // Utamakan Service Worker reg.showNotification agar tombol aksi Tolak/Jawab/Balas tampil di layar kunci Android
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .getRegistration()
      .then((reg) => {
        if (reg && reg.active) {
          return reg.showNotification(notifTitle, swNotifOptions);
        }
        return navigator.serviceWorker.ready.then((readyReg) =>
          readyReg.showNotification(notifTitle, swNotifOptions)
        );
      })
      .catch(() => {
        showWindowNotificationFallback();
      });
    return;
  }

  showWindowNotificationFallback();
}

export function dismissIncomingCallNotification(peerId?: string): void {
  if (isNativeCapacitor()) {
    void cancelNativeCallNotifications();
  }
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .getRegistration()
    .then((reg) => {
      if (!reg || !reg.getNotifications) return;
      return reg.getNotifications().then((list) => {
        for (const notif of list) {
          const matchesPeer = peerId && notif.tag === `wattapps-call-${peerId}`;
          const isAnyCall =
            notif.tag?.startsWith('wattapps-call-') || notif.tag === 'wattappsau-call';
          if (matchesPeer || (!peerId && isAnyCall) || isAnyCall) {
            notif.close();
          }
        }
      });
    })
    .catch(() => {});
}
