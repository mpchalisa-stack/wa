/**
 * Generator Audio Sub-Audible 18 Hz (Web Audio API Pure Oscillator):
 * Menghasilkan gelombang sinus kontinu 18 Hz dengan amplitudo sangat kecil (Gain 0.0015)
 * langsung melalui AudioContext tanpa elemen <audio> dan tanpa Media Session API.
 *
 * Keunggulan:
 * 1. Tidak terdengar oleh telinga manusia (< 20 Hz) maupun speaker HP/earphone.
 * 2. Menjaga utas audio & koneksi PeerJS/WebRTC tetap aktif di latar belakang.
 * 3. TIDAK memicu widget pemutar media di layar kunci maupun panel notifikasi Android/OS.
 */
const SUB_AUDIBLE_FREQ_HZ = 18;
const SUB_AUDIBLE_GAIN = 0.0015;
const WATCHDOG_INTERVAL_MS = 12000;

let cachedSubAudibleWavBlobUrl: string | null = null;

export function createSubAudibleWavBlobUrl(): string {
  if (cachedSubAudibleWavBlobUrl) return cachedSubAudibleWavBlobUrl;

  const sampleRate = 44100;
  const durationSeconds = 10;
  const numChannels = 1;
  const bitsPerSample = 16;
  const numSamples = sampleRate * durationSeconds;
  const dataByteLength = numSamples * numChannels * (bitsPerSample / 8);
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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
  view.setUint16(32, numChannels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataByteLength, true);

  const amplitude = 150;
  const twoPiFreqOverRate = (2 * Math.PI * SUB_AUDIBLE_FREQ_HZ) / sampleRate;
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

let isStandbyActive = false;
let isPausedForCall = false;
let resumeTimer: number | null = null;
let watchdogTimer: number | null = null;
let wakeLockSentinel: WakeLockSentinelLike | null = null;
let subAudibleCtx: AudioContext | null = null;
let subAudibleOsc: OscillatorNode | null = null;
let subAudibleGain: GainNode | null = null;
let visibilityListenerAttached = false;
let pendingGestureUnlockAttached = false;
let standbyStateListener: ((active: boolean) => void) | null = null;

export function setStandbyExternalListener(listener: ((active: boolean) => void) | null): void {
  standbyStateListener = listener;
}

export function isKeepAliveActuallyPlaying(): boolean {
  return Boolean(
    subAudibleCtx &&
      subAudibleCtx.state === 'running' &&
      subAudibleOsc &&
      subAudibleGain
  );
}

/**
 * Pastikan Media Session dan elemen <audio> lama benar-benar dibersihkan
 * sehingga sistem operasi TIDAK pernah menampilkan widget pemutar media di layar kunci.
 */
function suppressLockScreenMediaWidget(): void {
  try {
    if (typeof document !== 'undefined') {
      const legacyEl = document.getElementById('keepalive-audio') as HTMLAudioElement | null;
      if (legacyEl) {
        legacyEl.pause();
        legacyEl.removeAttribute('src');
        legacyEl.load();
        legacyEl.remove();
      }
    }
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
      const actions: MediaSessionAction[] = ['play', 'pause', 'stop', 'seekbackward', 'seekforward'];
      for (const act of actions) {
        try {
          navigator.mediaSession.setActionHandler(act, null);
        } catch {
          // ignore unsupported action
        }
      }
    }
  } catch {
    // ignore
  }
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

function createOrEnsureSubAudibleNodes(): AudioContext | null {
  if (typeof window === 'undefined') return null;

  const AudioCtxCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtxCtor) return null;

  if (!subAudibleCtx || subAudibleCtx.state === 'closed') {
    subAudibleCtx = new AudioCtxCtor({ latencyHint: 'playback' });
    subAudibleOsc = null;
    subAudibleGain = null;
  }

  if (!subAudibleOsc || !subAudibleGain) {
    const ctx = subAudibleCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(SUB_AUDIBLE_FREQ_HZ, ctx.currentTime);

    gain.gain.setValueAtTime(0.00001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(SUB_AUDIBLE_GAIN, ctx.currentTime + 0.04);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();

    subAudibleOsc = osc;
    subAudibleGain = gain;
  }

  return subAudibleCtx;
}

function teardownSubAudibleOscillator(closeContext: boolean): void {
  try {
    if (subAudibleGain && subAudibleCtx && subAudibleCtx.state === 'running') {
      const now = subAudibleCtx.currentTime;
      subAudibleGain.gain.cancelScheduledValues(now);
      subAudibleGain.gain.setValueAtTime(Math.max(subAudibleGain.gain.value, 0.00001), now);
      subAudibleGain.gain.linearRampToValueAtTime(0.00001, now + 0.03);
    }
  } catch {
    // ignore
  }

  if (closeContext) {
    try {
      subAudibleOsc?.stop();
    } catch {
      // ignore
    }
    try {
      subAudibleOsc?.disconnect();
      subAudibleGain?.disconnect();
    } catch {
      // ignore
    }
    subAudibleOsc = null;
    subAudibleGain = null;

    if (subAudibleCtx && subAudibleCtx.state !== 'closed') {
      void subAudibleCtx.close().catch(() => {});
    }
    subAudibleCtx = null;
  } else if (subAudibleCtx && subAudibleCtx.state === 'running') {
    void subAudibleCtx.suspend().catch(() => {});
  }

  suppressLockScreenMediaWidget();
}

function startStandbyWatchdog(): void {
  if (watchdogTimer !== null) return;
  watchdogTimer = window.setInterval(() => {
    if (isStandbyActive && !isPausedForCall) {
      if (!isKeepAliveActuallyPlaying()) {
        void startSubAudible18HzKeepAlive();
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
  void startSubAudible18HzKeepAlive();
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

async function startSubAudible18HzKeepAlive(): Promise<boolean> {
  if (!isStandbyActive || isPausedForCall) return false;
  if (typeof window === 'undefined') return false;

  suppressLockScreenMediaWidget();

  try {
    const ctx = createOrEnsureSubAudibleNodes();
    if (!ctx) return false;

    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    if (subAudibleGain && ctx.state === 'running') {
      const now = ctx.currentTime;
      subAudibleGain.gain.cancelScheduledValues(now);
      subAudibleGain.gain.setValueAtTime(Math.max(subAudibleGain.gain.value, 0.00001), now);
      subAudibleGain.gain.linearRampToValueAtTime(SUB_AUDIBLE_GAIN, now + 0.04);
    }

    const running = ctx.state === 'running';
    if (running) {
      disarmPendingGestureUnlock();
      startStandbyWatchdog();
      standbyStateListener?.(true);
      return true;
    }

    armPendingGestureUnlock();
    return false;
  } catch {
    armPendingGestureUnlock();
    return false;
  }
}

const handleStandbyVisibilityChange = () => {
  if (!isStandbyActive) return;
  if (document.visibilityState === 'visible') {
    void requestScreenWakeLock();
    if (!isPausedForCall && !isKeepAliveActuallyPlaying()) {
      void startSubAudible18HzKeepAlive();
    }
  }
};

/**
 * Jeda sementara generator audio sub-audible 18 Hz selama panggilan aktif
 * agar tidak mengganggu saluran mikrofon/speaker WebRTC.
 */
export function pauseKeepAliveForCall(): void {
  if (resumeTimer !== null) {
    window.clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  isPausedForCall = true;
  teardownSubAudibleOscillator(false);
}

/**
 * Setelah panggilan selesai, hidupkan kembali generator sub-audible 18 Hz
 * agar PeerJS kembali terjaga di latar belakang tanpa widget media layar kunci.
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
      void startSubAudible18HzKeepAlive();
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

  const audioPlayPromise = !isPausedForCall
    ? startSubAudible18HzKeepAlive()
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
  teardownSubAudibleOscillator(true);
  standbyStateListener?.(false);
  await releaseScreenWakeLock();
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
  timestamp?: number;
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

  const senderId =
    options.data?.callerId || options.data?.chatId || options.data?.fromId || '';
  const callerName =
    options.data?.callerName ||
    options.data?.fromName ||
    (senderId ? `ID: ${senderId}` : 'Penelepon');
  const isVideo = Boolean(options.data?.isVideo || options.data?.callType === 'video');

  const notifTitle = isCall ? callerName : options.title;
  const notifBody = isCall
    ? isVideo
      ? 'Panggilan video WattappsAU'
      : 'Panggilan suara WattappsAU'
    : options.body;

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

  // Notifikasi berprioritas tinggi untuk panggilan masuk (heads-up & tetap tampil hingga ditanggapi)
  // dan notifikasi senyap yang nyaman untuk pesan chat masuk.
  const swNotifOptions: ExtendedSWNotificationOptions = {
    body: notifBody,
    icon: notifIcon,
    badge: '/icon-512.png',
    tag: notifTag,
    timestamp: Date.now(),
    renotify: isCall,
    requireInteraction: isCall,
    silent: !isCall,
    actions: isCall
      ? [
          { action: 'reject_call', title: 'Tolak' },
          { action: 'accept_call', title: 'Jawab' },
        ]
      : [{ action: 'open_chat', title: 'Balas / Buka Chat' }],
    data: enrichedData,
  };

  const windowNotifOptions: NotificationOptions = {
    body: notifBody,
    icon: notifIcon,
    badge: '/icon-512.png',
    tag: notifTag,
    requireInteraction: isCall,
    silent: !isCall,
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

  // Utamakan Service Worker agar notifikasi berprioritas tinggi & klik notifikasi otomatis membuka halaman panggilan
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
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'SHOW_NOTIFICATION',
            title: notifTitle,
            body: notifBody,
            icon: notifIcon,
            tag: notifTag,
            isCall,
            isVideo,
            senderId,
            eventType,
            data: enrichedData,
          });
          return;
        }
        showWindowNotificationFallback();
      });
    return;
  }

  showWindowNotificationFallback();
}

export function dismissIncomingCallNotification(peerId?: string): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  try {
    navigator.serviceWorker.controller?.postMessage({
      type: 'DISMISS_CALL_NOTIFICATIONS',
      peerId: peerId || '',
    });
  } catch {
    // ignore
  }

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
