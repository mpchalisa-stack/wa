import { releaseAudioContextNow, triggerAlertVibration } from './audio';

/**
 * Manajemen Mode Siaga & Sesi Media WattappsAU (Non-Intrusive Audio Focus):
 * - TIDAK menjalankan loop audio keep-alive / generator sub-audible 18Hz terus-menerus saat idle
 *   agar tidak membajak fokus audio Android maupun perangkat audio eksternal (misal VIVAN Sport X3).
 * - Koneksi PeerJS dan notifikasi latar belakang mengandalkan Service Worker, sinyal bangun ntfy.sh,
 *   serta logika auto-reconnect jaringan.
 * - `navigator.mediaSession` hanya diaktifkan secara terkontrol ketika ada panggilan aktif atau
 *   transmisi VOX / pesan suara yang sedang berlangsung, lalu dibersihkan total saat selesai.
 */

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

export interface ActiveMediaSessionOptions {
  mode: 'call' | 'vox';
  statusText: string;
  peerName?: string;
  onEndOrPause?: () => void;
}

export interface PeerMediaSessionStatus {
  peerState: 'connecting' | 'online' | 'disconnected' | 'error';
  standbyEnabled: boolean;
  peerId?: string;
  onlineContactsCount?: number;
  isExited?: boolean;
}

const ALL_MEDIA_SESSION_ACTIONS: MediaSessionAction[] = [
  'play',
  'pause',
  'stop',
  'seekbackward',
  'seekforward',
  'previoustrack',
  'nexttrack',
  'seekto',
];

let isStandbyActive = false;
let activeMediaSessionMode: 'call' | 'vox' | null = null;
let lastPeerMediaSessionStatus: PeerMediaSessionStatus | null = null;
let wakeLockSentinel: WakeLockSentinelLike | null = null;
let visibilityListenerAttached = false;
let standbyStateListener: ((active: boolean) => void) | null = null;

function resolvePublicAssetUrl(assetPath: string): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    try {
      return new URL(assetPath, window.location.origin).href;
    } catch {
      return assetPath;
    }
  }
  return assetPath;
}

/**
 * Daftar artwork resmi WattappsAU dari folder /public untuk kartu MediaMetadata layar kunci.
 * Menggunakan logo SWA BHUWANA PAKSA & ikon aplikasi dari folder public dengan URL absolut.
 */
function buildAppMediaArtwork(): MediaImage[] {
  return [
    {
      src: resolvePublicAssetUrl('/assets/aistudio/1792503945296_954409ac.jpg'),
      sizes: '2048x2048',
      type: 'image/jpeg',
    },
    {
      src: resolvePublicAssetUrl('/icon-512.png'),
      sizes: '512x512',
      type: 'image/png',
    },
    {
      src: resolvePublicAssetUrl('/pwa-512x512.png'),
      sizes: '512x512',
      type: 'image/png',
    },
    {
      src: resolvePublicAssetUrl('/pwa-192x192.png'),
      sizes: '192x192',
      type: 'image/png',
    },
  ];
}

export function setStandbyExternalListener(listener: ((active: boolean) => void) | null): void {
  standbyStateListener = listener;
}

export function isKeepAliveActuallyPlaying(): boolean {
  return activeMediaSessionMode !== null;
}

export function isActiveMediaSessionRunning(): boolean {
  return activeMediaSessionMode !== null;
}

async function requestScreenWakeLock(): Promise<boolean> {
  try {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return false;
    }
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

/**
 * Membersihkan elemen audio legacy (keepalive-audio) jika masih ada di DOM
 * agar tidak pernah menahan audio focus Android.
 */
function purgeLegacyKeepAliveAudioElement(): void {
  if (typeof document === 'undefined') return;
  try {
    const legacyAudio = document.getElementById('keepalive-audio') as HTMLAudioElement | null;
    if (legacyAudio) {
      legacyAudio.pause();
      legacyAudio.currentTime = 0;
      legacyAudio.removeAttribute('src');
      legacyAudio.load();
      legacyAudio.remove();
    }
  } catch {
    // ignore
  }
}

function clearAllMediaSessionHandlers(): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  for (const action of ALL_MEDIA_SESSION_ACTIONS) {
    try {
      navigator.mediaSession.setActionHandler(action, null);
    } catch {
      // ignore unsupported actions
    }
  }
  try {
    // Beberapa versi Chromium mendukung action 'hangup' untuk panggilan WebRTC
    (
      navigator.mediaSession as MediaSession & {
        setActionHandler: (action: string, handler: (() => void) | null) => void;
      }
    ).setActionHandler('hangup', null);
  } catch {
    // ignore
  }
}

function formatPeerDisplayId(peerId?: string): string {
  if (!peerId) return '';
  const digits = peerId.replace(/\D/g, '');
  return digits.length === 6 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : peerId;
}

function applyPeerMediaMetadata(status: PeerMediaSessionStatus): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

  try {
    // Selalu kosongkan seluruh handler tombol pemutar audio (play/pause/stop/next/prev/seek)
    // dan pastikan playbackState = 'none' agar tidak memicu kontrol pemutar audio HP di layar kunci.
    clearAllMediaSessionHandlers();

    if (status.isExited) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }

    if (typeof MediaMetadata !== 'undefined') {
      const artistText =
        status.peerState === 'online'
          ? 'Status: Online'
          : status.peerState === 'connecting'
          ? 'Status: Menghubungkan...'
          : 'Status: Menyambung Ulang...';

      const formattedId = formatPeerDisplayId(status.peerId);
      const onlineCount = status.onlineContactsCount ?? 0;
      const albumParts: string[] = [];

      if (status.peerState === 'online') {
        if (onlineCount > 0) {
          albumParts.push(`${onlineCount} Rekan Aktif`);
        } else if (status.standbyEnabled) {
          albumParts.push('Mode Siaga Aktif');
        } else {
          albumParts.push('Jaringan P2P Aktif');
        }
      } else {
        albumParts.push('Jaringan P2P WattappsAU');
      }

      if (formattedId) {
        albumParts.push(`ID ${formattedId}`);
      }

      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'WattappsAU',
        artist: artistText,
        album: albumParts.join(' · '),
        artwork: buildAppMediaArtwork(),
      });
    }

    navigator.mediaSession.playbackState = 'none';
  } catch {
    // ignore on unsupported browsers
  }
}

/**
 * Memperbarui navigator.mediaSession secara real-time sesuai status koneksi PeerJS
 * tanpa menyalakan pemutar audio maupun mendaftarkan tombol kontrol audio HP.
 */
export function syncPeerMediaSession(status: PeerMediaSessionStatus): void {
  lastPeerMediaSessionStatus = status;
  purgeLegacyKeepAliveAudioElement();

  // Jika sedang dalam panggilan atau memutar VOX, biarkan metadata sesi aktif tampil lebih dulu;
  // begitu sesi berakhir, releaseActiveMediaSession akan otomatis memulihkan metadata PeerJS terbaru.
  if (activeMediaSessionMode !== null && !status.isExited) {
    return;
  }

  applyPeerMediaMetadata(status);
}

/**
 * Membersihkan total metadata & state MediaSession saat pengguna memilih Exit.
 */
export function clearPeerMediaSession(): void {
  lastPeerMediaSessionStatus = null;
  activeMediaSessionMode = null;
  purgeLegacyKeepAliveAudioElement();

  try {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      clearAllMediaSessionHandlers();
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }
  } catch {
    // ignore
  }
}

/**
 * Mengaktifkan Media Session secara terkontrol HANYA saat panggilan aktif atau transmisi VOX berlangsung.
 */
export function activateActiveMediaSession(options: ActiveMediaSessionOptions): void {
  activeMediaSessionMode = options.mode;
  purgeLegacyKeepAliveAudioElement();

  try {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    if (typeof MediaMetadata !== 'undefined') {
      const albumText = options.peerName
        ? `${options.peerName} · Enkripsi DTLS/SRTP`
        : 'Tactical P2P Terenkripsi (AES-256)';

      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'WattappsAU',
        artist: options.statusText,
        album: albumText,
        artwork: buildAppMediaArtwork(),
      });
    }

    clearAllMediaSessionHandlers();

    if (options.onEndOrPause) {
      const handler = options.onEndOrPause;
      try {
        navigator.mediaSession.setActionHandler('pause', handler);
      } catch {
        // ignore
      }
      try {
        navigator.mediaSession.setActionHandler('stop', handler);
      } catch {
        // ignore
      }
      if (options.mode === 'call') {
        try {
          (
            navigator.mediaSession as MediaSession & {
              setActionHandler: (action: string, cb: (() => void) | null) => void;
            }
          ).setActionHandler('hangup', handler);
        } catch {
          // ignore
        }
      }
    }

    navigator.mediaSession.playbackState = 'playing';
  } catch {
    // ignore on unsupported browsers
  }
}

/**
 * Melepas sesi media aktif (panggilan/VOX), membersihkan seluruh handler pemutar audio,
 * dan langsung memulihkan identitas MediaMetadata WattappsAU sesuai status PeerJS real-time
 * dengan playbackState = 'none' agar kontrol pemutar audio HP tetap bebas.
 */
export function releaseActiveMediaSession(mode?: 'call' | 'vox'): void {
  // Jika mode diberikan dan tidak cocok dengan sesi aktif saat ini, jangan ganggu sesi yang lebih prioritas
  if (mode && activeMediaSessionMode && activeMediaSessionMode !== mode) {
    return;
  }

  activeMediaSessionMode = null;
  purgeLegacyKeepAliveAudioElement();

  try {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      clearAllMediaSessionHandlers();
      if (lastPeerMediaSessionStatus && !lastPeerMediaSessionStatus.isExited) {
        applyPeerMediaMetadata(lastPeerMediaSessionStatus);
      } else {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
      }
    }
  } catch {
    // ignore
  }
}

const handleStandbyVisibilityChange = () => {
  if (document.visibilityState === 'visible') {
    if (isStandbyActive) {
      void requestScreenWakeLock();
    }
    if (activeMediaSessionMode === null && lastPeerMediaSessionStatus && !lastPeerMediaSessionStatus.isExited) {
      applyPeerMediaMetadata(lastPeerMediaSessionStatus);
    }
  } else if (activeMediaSessionMode === null) {
    // Saat berpindah ke latar belakang tanpa panggilan/VOX aktif, lepas fokus audio & pertahankan identitas metadata pasif
    releaseActiveMediaSession();
    releaseAudioContextNow();
  }
};

/**
 * Dipanggil saat panggilan mulai masuk/keluar: bersihkan audio idle apa pun sebelum WebRTC mengambil alih.
 */
export function pauseKeepAliveForCall(): void {
  purgeLegacyKeepAliveAudioElement();
}

/**
 * Dipanggil setelah panggilan selesai: lepas total MediaSession & AudioContext agar fokus audio perangkat kembali normal.
 */
export function resumeKeepAliveAfterCall(): void {
  releaseActiveMediaSession('call');
  releaseAudioContextNow();
  if (isStandbyActive && typeof document !== 'undefined' && document.visibilityState === 'visible') {
    void requestScreenWakeLock();
  }
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

/**
 * Mode Siaga (Non-Intrusive):
 * Menjaga notifikasi Service Worker, sinyal bangun ntfy.sh, auto-reconnect PeerJS, dan Screen Wake Lock (saat terlihat)
 * TANPA menjalankan loop audio keep-alive 18Hz dan TANPA membajak Media Session Android saat idle.
 */
export async function enableStandbyMode(): Promise<{
  wakeLockActive: boolean;
  audioKeepAliveActive: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
}> {
  isStandbyActive = true;
  standbyStateListener?.(true);

  if (!visibilityListenerAttached && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleStandbyVisibilityChange);
    visibilityListenerAttached = true;
  }

  // Pastikan tidak ada audio keep-alive 18Hz atau widget MediaSession idle yang tertinggal
  if (activeMediaSessionMode === null) {
    releaseActiveMediaSession();
  }

  const [wakeLockActive, notificationPermission] = await Promise.all([
    requestScreenWakeLock(),
    requestNotificationPermission(),
  ]);

  return { wakeLockActive, audioKeepAliveActive: false, notificationPermission };
}

export async function disableStandbyMode(): Promise<void> {
  isStandbyActive = false;
  standbyStateListener?.(false);

  if (visibilityListenerAttached && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleStandbyVisibilityChange);
    visibilityListenerAttached = false;
  }

  if (activeMediaSessionMode === null) {
    releaseActiveMediaSession();
    releaseAudioContextNow();
  }
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

  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const shouldNotify =
    isCall ||
    isStandbyActive ||
    document.visibilityState !== 'visible' ||
    !document.hasFocus();

  if (!shouldNotify) return;

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
