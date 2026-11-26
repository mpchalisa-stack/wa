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
let isConnectionWakeLockDesired = false;
let activeMediaSessionMode: 'call' | 'vox' | null = null;
let lastPeerMediaSessionStatus: PeerMediaSessionStatus | null = null;
let wakeLockSentinel: WakeLockSentinelLike | null = null;
let visibilityListenerAttached = false;
let wakeLockGestureRetryAttached = false;
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
 * Menggunakan logo resmi yang diunggah (/assets/aistudio/1792503945296_954409ac.jpg) pada seluruh
 * ukuran standar agar Chromium/Android tidak memilih ikon lama saat seleksi ukuran ideal.
 */
function buildAppMediaArtwork(): MediaImage[] {
  const emblemUrl = resolvePublicAssetUrl('/assets/aistudio/1792503945296_954409ac.jpg');
  return [
    { src: emblemUrl, sizes: '96x96', type: 'image/jpeg' },
    { src: emblemUrl, sizes: '128x128', type: 'image/jpeg' },
    { src: emblemUrl, sizes: '192x192', type: 'image/jpeg' },
    { src: emblemUrl, sizes: '256x256', type: 'image/jpeg' },
    { src: emblemUrl, sizes: '384x384', type: 'image/jpeg' },
    { src: emblemUrl, sizes: '512x512', type: 'image/jpeg' },
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

export function isScreenWakeLockActive(): boolean {
  return Boolean(wakeLockSentinel && !wakeLockSentinel.released);
}

function detachWakeLockGestureRetry(): void {
  if (!wakeLockGestureRetryAttached || typeof window === 'undefined') return;
  window.removeEventListener('pointerdown', handleWakeLockGestureRetry);
  window.removeEventListener('touchstart', handleWakeLockGestureRetry);
  wakeLockGestureRetryAttached = false;
}

function handleWakeLockGestureRetry(): void {
  detachWakeLockGestureRetry();
  if (isConnectionWakeLockDesired) {
    void requestScreenWakeLock();
  }
}

function attachWakeLockGestureRetry(): void {
  if (wakeLockGestureRetryAttached || typeof window === 'undefined') return;
  wakeLockGestureRetryAttached = true;
  window.addEventListener('pointerdown', handleWakeLockGestureRetry, { passive: true, once: true });
  window.addEventListener('touchstart', handleWakeLockGestureRetry, { passive: true, once: true });
}

export async function requestScreenWakeLock(): Promise<boolean> {
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
    // Jika koneksi tidak aktif lagi saat promise selesai, segera lepaskan kembali
    if (!isConnectionWakeLockDesired) {
      try {
        await sentinel.release();
      } catch {
        // ignore
      }
      return false;
    }
    wakeLockSentinel = sentinel;
    detachWakeLockGestureRetry();
    sentinel.addEventListener?.('release', () => {
      if (wakeLockSentinel === sentinel) {
        wakeLockSentinel = null;
      }
    });
    return true;
  } catch {
    // Beberapa browser mobile mewajibkan sentuhan pengguna pertama sebelum mengizinkan wakeLock
    if (isConnectionWakeLockDesired) {
      attachWakeLockGestureRetry();
    }
    return false;
  }
}

export async function releaseScreenWakeLock(): Promise<void> {
  detachWakeLockGestureRetry();
  if (wakeLockSentinel) {
    const current = wakeLockSentinel;
    wakeLockSentinel = null;
    try {
      await current.release();
    } catch {
      // ignore
    }
  }
}

/**
 * Mengaktifkan Screen Wake Lock (navigator.wakeLock) saat koneksi PeerJS aktif agar layar
 * HP/tablet tidak mati otomatis selama aplikasi terbuka, dan melepaskannya saat koneksi berhenti.
 */
export async function syncConnectionWakeLock(connectionActive: boolean): Promise<boolean> {
  isConnectionWakeLockDesired = connectionActive;

  if (!visibilityListenerAttached && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleStandbyVisibilityChange);
    visibilityListenerAttached = true;
  }

  if (connectionActive) {
    return requestScreenWakeLock();
  }

  await releaseScreenWakeLock();
  return false;
}

/**
 * Mode standby hemat baterai otomatis (setelah 5 menit tanpa interaksi dan tidak sedang menelepon):
 * Melepas wakeLock dan menghentikan seluruh audio latar belakang / AudioContext idle
 * agar layar perangkat dapat mati otomatis tanpa mematikan koneksi penerima notifikasi.
 */
export async function enterBackgroundBatteryStandby(): Promise<void> {
  isConnectionWakeLockDesired = false;
  await releaseScreenWakeLock();
  purgeLegacyKeepAliveAudioElement();
  if (activeMediaSessionMode === null) {
    releaseActiveMediaSession();
    releaseAudioContextNow();
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
  const extraActions = ['hangup', 'togglemicrophone', 'togglecamera', 'skipad'];
  for (const extra of extraActions) {
    try {
      (
        navigator.mediaSession as MediaSession & {
          setActionHandler: (action: string, handler: (() => void) | null) => void;
        }
      ).setActionHandler(extra, null);
    } catch {
      // ignore unsupported actions
    }
  }
  // Hapus progress bar / scrubber durasi media agar tidak tampil seperti pemutar musik
  try {
    if (typeof navigator.mediaSession.setPositionState === 'function') {
      navigator.mediaSession.setPositionState();
    }
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
 * Memperbarui MediaMetadata selama panggilan aktif atau transmisi VOX berlangsung
 * tanpa mendaftarkan tombol kontrol pemutar audio HP (play/pause/skip/seek).
 */
export function activateActiveMediaSession(options: ActiveMediaSessionOptions): void {
  activeMediaSessionMode = options.mode;
  purgeLegacyKeepAliveAudioElement();

  try {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    // Pastikan seluruh kontrol pemutar audio HP (play/pause/stop/next/prev/seek) tetap kosong
    clearAllMediaSessionHandlers();

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

    navigator.mediaSession.playbackState = 'none';
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
    if (isConnectionWakeLockDesired) {
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
  if (isConnectionWakeLockDesired && typeof document !== 'undefined' && document.visibilityState === 'visible') {
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

  if (!isConnectionWakeLockDesired && visibilityListenerAttached && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleStandbyVisibilityChange);
    visibilityListenerAttached = false;
  }

  if (activeMediaSessionMode === null) {
    releaseActiveMediaSession();
    releaseAudioContextNow();
  }
  if (!isConnectionWakeLockDesired) {
    await releaseScreenWakeLock();
  }
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
  try {
    if (typeof window !== 'undefined') {
      window.AndroidBridge?.dismissIncomingCall?.();
    }
  } catch {
    // ignore bridge error
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
