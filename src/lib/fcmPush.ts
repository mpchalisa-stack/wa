import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import {
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  setDoc,
  Firestore,
} from 'firebase/firestore';
import fcmFirebaseConfig from '../../firebase-fcm-config.json';
import { LOCKED_USER_ID_KEY, LOCKED_USER_NAME_KEY } from './db';

export interface AndroidBridgeInterface {
  getFcmToken?: () => string | null | undefined;
  showIncomingCall?: (callerName: string, callType?: string) => void;
  notifyAppReadyForCall?: () => void;
  answerCallAudioReady?: () => void;
  dismissIncomingCall?: () => void;
  showIncomingMessage?: (sender: string, body: string) => void;
  setCallAudioMode?: (inCall: boolean) => void;
  enterBatteryStandby?: () => void;
  saveBase64File?: (fileName: string, base64Data: string) => boolean | void;
  downloadFile?: (urlOrData: string, fileName: string, mimeType?: string) => boolean | void;
  requestGpsLocation?: () => void;
}

declare global {
  interface Window {
    AndroidBridge?: AndroidBridgeInterface;
    __wattappsAudioTracks?: MediaStreamTrack[];
  }
}

export type FcmPushType = 'message' | 'call';

export interface FcmPushRequest {
  targetUserId: string;
  type: FcmPushType;
  sender: string;
  body: string;
}

export interface FcmPushResult {
  success: boolean;
  reason?: 'invalid_target' | 'not_configured' | 'firestore_error' | 'token_not_found' | 'api_error';
  errorDetail?: string;
  statusCode?: number;
}

export interface FirestorePeerIdentity {
  userId: string;
  displayName: string;
  avatar?: string;
  updatedAt?: number;
}

const FCM_APP_NAME = 'wattapps-fcm';
const DEVICE_TOKENS_COLLECTION = 'device_tokens';
const USERS_COLLECTION = 'users';
const TOKEN_SYNC_INTERVAL_MS = 5000;
const IDENTITY_CACHE_TTL_MS = 60000;
const MAX_TOKEN_LENGTH = 512;
const MAX_SENDER_LENGTH = 120;
const MAX_BODY_LENGTH = 500;

let fcmAppInstance: FirebaseApp | null = null;
let fcmFirestoreInstance: Firestore | null = null;

interface CachedPeerIdentityEntry {
  identity: FirestorePeerIdentity | null;
  fetchedAt: number;
}

const peerIdentityCache = new Map<string, CachedPeerIdentityEntry>();
const inFlightIdentityLookups = new Map<string, Promise<FirestorePeerIdentity | null>>();

/**
 * Normalisasi ID dokumen Firestore untuk koleksi `device_tokens` & `users`:
 * menghapus prefix & spasi lalu mengubah ke lowercase (`id.trim().toLowerCase()`).
 */
export function normalizeFcmUserId(rawId: string): string {
  const cleaned = (rawId || '')
    .replace(/^WA6-/i, '')
    .replace(/^WattappsAU-/i, '')
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .trim()
    .toLowerCase();
  return cleaned.slice(0, 128);
}

function getFcmFirestore(): Firestore | null {
  if (fcmFirestoreInstance) return fcmFirestoreInstance;
  try {
    const projectId =
      (import.meta.env?.VITE_FCM_FIREBASE_PROJECT_ID as string | undefined)?.trim() ||
      fcmFirebaseConfig.projectId;
    const apiKey =
      (import.meta.env?.VITE_FCM_FIREBASE_API_KEY as string | undefined)?.trim() ||
      fcmFirebaseConfig.apiKey;

    if (!projectId || !apiKey) {
      return null;
    }

    const existing = getApps().find((a) => a.name === FCM_APP_NAME);
    fcmAppInstance =
      existing ||
      initializeApp(
        {
          ...fcmFirebaseConfig,
          projectId,
          apiKey,
        },
        FCM_APP_NAME
      );

    fcmFirestoreInstance = getFirestore(fcmAppInstance);
    return fcmFirestoreInstance;
  } catch (err) {
    console.error('[WattappsAU FCM] Inisialisasi Firebase Client gagal:', err);
    return null;
  }
}

function logFcmFirestoreError(operationType: 'get' | 'write', path: string, error: unknown): void {
  const details = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
    projectId: fcmFirebaseConfig.projectId,
  };
  console.warn('[WattappsAU FCM Firestore]', JSON.stringify(details));
}

// Inisialisasi Firestore FCM (siaga offline / P2P mandiri tanpa timeout backend)

function extractRealDisplayName(data: Record<string, unknown> | undefined): string {
  if (!data) return '';
  const candidates = [data.displayName, data.name, data.userName, data.username];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (
        trimmed &&
        !/^teman\s+\d+$/i.test(trimmed) &&
        !/^id[:\s]+\d+$/i.test(trimmed) &&
        !/^\d{6}$/.test(trimmed)
      ) {
        return trimmed.slice(0, MAX_SENDER_LENGTH);
      }
    }
  }
  return '';
}

/**
 * Mengambil cache identitas lawan bicara dari Firestore secara sinkron (jika sudah pernah dimuat).
 */
export function getCachedPeerIdentity(rawPeerId: string): FirestorePeerIdentity | null {
  const cleanId = normalizeFcmUserId(rawPeerId);
  if (!cleanId) return null;
  const entry = peerIdentityCache.get(cleanId);
  return entry?.identity || null;
}

/**
 * Mencocokkan identitas asli lawan bicara langsung dari koleksi Firestore `device_tokens` / `users`
 * agar layar panggilan masuk/keluar dan chat selalu menampilkan nama asli pemilik ID tersebut.
 */
export async function fetchPeerIdentityFromFirestore(
  rawPeerId: string,
  options?: { forceRefresh?: boolean }
): Promise<FirestorePeerIdentity | null> {
  const cleanId = normalizeFcmUserId(rawPeerId);
  if (!cleanId) return null;

  const forceRefresh = Boolean(options?.forceRefresh);
  const cached = peerIdentityCache.get(cleanId);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < IDENTITY_CACHE_TTL_MS) {
    return cached.identity;
  }

  const existingFlight = inFlightIdentityLookups.get(cleanId);
  if (existingFlight) {
    return existingFlight;
  }

  const lookupPromise = (async (): Promise<FirestorePeerIdentity | null> => {
    const db = getFcmFirestore();
    if (!db) return cached?.identity || null;

    let resolved: FirestorePeerIdentity | null = null;

    // 1. Cek koleksi utama `device_tokens/{cleanId}`
    try {
      const tokenSnap = await getDoc(doc(db, DEVICE_TOKENS_COLLECTION, cleanId));
      if (tokenSnap.exists()) {
        const data = tokenSnap.data() as Record<string, unknown>;
        const displayName = extractRealDisplayName(data);
        if (displayName) {
          resolved = {
            userId: cleanId,
            displayName,
            avatar: typeof data.avatar === 'string' ? data.avatar : undefined,
            updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : undefined,
          };
        }
      }
    } catch (error) {
      logFcmFirestoreError('get', `${DEVICE_TOKENS_COLLECTION}/${cleanId}`, error);
    }

    // 2. Fallback cek koleksi `users/{cleanId}` jika nama belum ada di `device_tokens`
    if (!resolved) {
      try {
        const userSnap = await getDoc(doc(db, USERS_COLLECTION, cleanId));
        if (userSnap.exists()) {
          const data = userSnap.data() as Record<string, unknown>;
          const displayName = extractRealDisplayName(data);
          if (displayName) {
            resolved = {
              userId: cleanId,
              displayName,
              avatar: typeof data.avatar === 'string' ? data.avatar : undefined,
              updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : undefined,
            };
          }
        }
      } catch (error) {
        logFcmFirestoreError('get', `${USERS_COLLECTION}/${cleanId}`, error);
      }
    }

    peerIdentityCache.set(cleanId, {
      identity: resolved,
      fetchedAt: Date.now(),
    });
    return resolved;
  })().finally(() => {
    inFlightIdentityLookups.delete(cleanId);
  });

  inFlightIdentityLookups.set(cleanId, lookupPromise);
  return lookupPromise;
}

/**
 * Mengambil token FCM native dari `window.AndroidBridge?.getFcmToken?.()` dan menyimpannya ke
 * Firestore `device_tokens/{cleanId}` beserta nama tampilan pengguna.
 * WAJIB memvalidasi kecocokan ID terhadap `localStorage.getItem('wattapps_user_id')` agar token
 * perangkat ini tidak pernah menimpa dokumen milik pengguna/perangkat lain.
 */
let lastSyncedSignature = '';

export async function syncFcmToken(
  myUserId: string,
  displayName?: string,
  forceWrite = false
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const cleanId = normalizeFcmUserId(myUserId);
  if (!cleanId) return false;

  // VALIDASI KETAT ANTI-TERTUKAR: pastikan ID sinkronisasi 100% cocok dengan wattapps_user_id di localStorage
  let lockedLocalId = '';
  let lockedLocalName = '';
  try {
    lockedLocalId = normalizeFcmUserId(localStorage.getItem(LOCKED_USER_ID_KEY) || '');
    lockedLocalName = (localStorage.getItem(LOCKED_USER_NAME_KEY) || '').trim();
  } catch {
    return false;
  }

  if (!lockedLocalId || cleanId !== lockedLocalId) {
    console.warn(
      `[WattappsAU FCM] Sinkronisasi dibatalkan: ID "${cleanId}" tidak cocok dengan wattapps_user_id ("${lockedLocalId}").`
    );
    return false;
  }

  const resolvedName = ((displayName || lockedLocalName || '').trim()).slice(0, MAX_SENDER_LENGTH);

  let rawToken: string | null | undefined;
  try {
    rawToken = window.AndroidBridge?.getFcmToken?.();
  } catch {
    rawToken = undefined;
  }

  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  const hasValidToken = Boolean(token && token.length <= MAX_TOKEN_LENGTH && !/\s/.test(token));

  // Jika tidak ada token native DAN tidak ada nama tampilan untuk disinkronkan, lewati penulisan
  if (!hasValidToken && !resolvedName) {
    return false;
  }

  const signature = `${cleanId}:${hasValidToken ? token : 'no-token'}:${resolvedName}`;
  if (!forceWrite && signature === lastSyncedSignature) {
    return true;
  }

  const db = getFcmFirestore();
  if (!db) return false;

  const now = Date.now();
  const tokenPayload: Record<string, unknown> = {
    userId: cleanId,
    updatedAt: now,
  };
  if (hasValidToken) {
    tokenPayload.fcmToken = token;
  }
  if (resolvedName) {
    tokenPayload.displayName = resolvedName;
    tokenPayload.name = resolvedName;
  }

  const docPath = `${DEVICE_TOKENS_COLLECTION}/${cleanId}`;
  try {
    await setDoc(doc(db, DEVICE_TOKENS_COLLECTION, cleanId), tokenPayload, { merge: true });
    lastSyncedSignature = signature;

    // Sinkronkan juga profil nama ke koleksi `users/{cleanId}` (best-effort) agar pencocokan identitas selalu konsisten
    if (resolvedName) {
      peerIdentityCache.set(cleanId, {
        identity: { userId: cleanId, displayName: resolvedName, updatedAt: now },
        fetchedAt: now,
      });
      void setDoc(
        doc(db, USERS_COLLECTION, cleanId),
        {
          userId: cleanId,
          displayName: resolvedName,
          name: resolvedName,
          updatedAt: now,
        },
        { merge: true }
      ).catch(() => {
        // Abaikan jika rules koleksi users bersifat opsional di proyek eksternal
      });
    }

    return true;
  } catch (error) {
    logFcmFirestoreError('write', docPath, error);
    return false;
  }
}

/**
 * Menjalankan `syncFcmToken()` segera saat aplikasi dibuka dan setiap 5 detik
 * selama ID pengguna lokal tersedia agar token baru/rotasi & nama tampilan selalu tersinkron.
 */
export function startFcmTokenSyncLoop(myUserId: string, displayName?: string): () => void {
  const cleanId = normalizeFcmUserId(myUserId);
  if (!cleanId || typeof window === 'undefined') {
    return () => {};
  }

  let cancelled = false;
  const runSync = (forceWrite = false) => {
    if (cancelled) return;
    void syncFcmToken(cleanId, displayName, forceWrite);
  };

  // Sinkronisasi segera saat aplikasi dibuka & ID pengguna tersedia
  runSync(true);

  // Periksa ulang setiap 5 detik selama aplikasi aktif
  const intervalId = window.setInterval(() => {
    runSync(false);
  }, TOKEN_SYNC_INTERVAL_MS);

  return () => {
    cancelled = true;
    window.clearInterval(intervalId);
  };
}

/**
 * Mengambil dokumen `device_tokens/{targetId.trim().toLowerCase()}` dari Firestore,
 * lalu mengirim High-Priority Data Message FCM melalui `POST /api/push`.
 */
export async function sendFcmPushToUser(params: FcmPushRequest): Promise<FcmPushResult> {
  const cleanTargetUserId = normalizeFcmUserId(params.targetUserId);
  if (!cleanTargetUserId) {
    return {
      success: false,
      reason: 'invalid_target',
      errorDetail: 'ID tujuan tidak valid',
    };
  }

  const db = getFcmFirestore();
  if (!db) {
    return {
      success: false,
      reason: 'not_configured',
      errorDetail: 'Konfigurasi Firebase belum aktif',
    };
  }

  const docPath = `${DEVICE_TOKENS_COLLECTION}/${cleanTargetUserId}`;
  let targetToken = '';

  try {
    const snap = await getDoc(doc(db, DEVICE_TOKENS_COLLECTION, cleanTargetUserId));
    if (!snap.exists()) {
      return {
        success: false,
        reason: 'token_not_found',
        errorDetail: `Token perangkat ${cleanTargetUserId} belum terdaftar`,
      };
    }
    const data = snap.data() as Record<string, unknown> | undefined;
    if (typeof data?.fcmToken === 'string') {
      targetToken = data.fcmToken.trim();
    }
    // Sekalian perbarui cache identitas asli jika tersedia di dokumen device_tokens
    const remoteDisplayName = extractRealDisplayName(data);
    if (remoteDisplayName) {
      peerIdentityCache.set(cleanTargetUserId, {
        identity: {
          userId: cleanTargetUserId,
          displayName: remoteDisplayName,
          avatar: typeof data?.avatar === 'string' ? data.avatar : undefined,
          updatedAt: typeof data?.updatedAt === 'number' ? data.updatedAt : undefined,
        },
        fetchedAt: Date.now(),
      });
    }
  } catch (error) {
    logFcmFirestoreError('get', docPath, error);
    return {
      success: false,
      reason: 'firestore_error',
      errorDetail: error instanceof Error ? error.message : 'Gagal membaca token tujuan dari Firestore',
    };
  }

  if (!targetToken || targetToken.length > MAX_TOKEN_LENGTH || /\s/.test(targetToken)) {
    return {
      success: false,
      reason: 'token_not_found',
      errorDetail: `Token FCM perangkat ${cleanTargetUserId} kosong atau tidak valid`,
    };
  }

  const safeType: FcmPushType = params.type === 'call' ? 'call' : 'message';
  const safeSender =
    (params.sender || 'WattappsAU').trim().slice(0, MAX_SENDER_LENGTH) || 'WattappsAU';
  const defaultBody =
    safeType === 'call' ? 'Panggilan Masuk WattappsAU' : 'Pesan baru masuk';
  const safeBody =
    (params.body || defaultBody).trim().slice(0, MAX_BODY_LENGTH) || defaultBody;

  try {
    const response = await fetch('/api/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'WattappsAU',
      },
      body: JSON.stringify({
        targetToken,
        type: safeType,
        sender: safeSender,
        body: safeBody,
      }),
    });

    let responseData: { success?: boolean; ok?: boolean; error?: string; code?: string } | null =
      null;
    try {
      responseData = (await response.json()) as {
        success?: boolean;
        ok?: boolean;
        error?: string;
        code?: string;
      };
    } catch {
      responseData = null;
    }

    if (response.ok && (responseData?.success === true || responseData?.ok === true)) {
      return { success: true, statusCode: response.status };
    }

    return {
      success: false,
      reason: 'api_error',
      statusCode: response.status,
      errorDetail:
        responseData?.error ||
        responseData?.code ||
        `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      success: false,
      reason: 'api_error',
      errorDetail: err instanceof Error ? err.message : 'Koneksi ke /api/push gagal',
    };
  }
}

/**
 * Memicu notifikasi panggilan masuk melalui AndroidBridge (gunakan "voice" atau "video").
 */
export function triggerAndroidBridgeIncomingCall(
  callerName: string,
  callType: 'voice' | 'video' = 'voice'
): void {
  if (typeof window === 'undefined') return;
  try {
    const fn = window.AndroidBridge?.showIncomingCall;
    if (typeof fn === 'function') {
      const safeName =
        (callerName || 'WattappsAU').trim().slice(0, MAX_SENDER_LENGTH) || 'WattappsAU';
      const safeType: 'voice' | 'video' = callType === 'video' ? 'video' : 'voice';
      fn(safeName, safeType);
    }
  } catch {
    // ignore bridge error
  }
}

/**
 * Memberi tahu Android WebView bahwa layar panggilan masuk sudah tampil & aplikasi siap menerima panggilan
 * agar nada dering dan getar berbunyi sinkron.
 */
export function notifyAndroidBridgeAppReadyForCall(): void {
  if (typeof window === 'undefined') return;
  try {
    const fn = window.AndroidBridge?.notifyAppReadyForCall;
    if (typeof fn === 'function') {
      fn();
    }
  } catch {
    // ignore bridge error
  }
}

/**
 * Memberi tahu Android WebView bahwa panggilan baru saja diangkat & audio siap agar dering/getar langsung berhenti total.
 */
export function notifyAndroidBridgeAnswerCallAudioReady(): void {
  if (typeof window === 'undefined') return;
  try {
    const fn = window.AndroidBridge?.answerCallAudioReady;
    if (typeof fn === 'function') {
      fn();
    }
  } catch {
    // ignore bridge error
  }
}

/**
 * Menutup notifikasi / dering panggilan masuk native di Android WebView saat panggilan dijawab, ditutup, atau tidak terjawab.
 */
export function dismissAndroidBridgeIncomingCall(): void {
  if (typeof window === 'undefined') return;
  try {
    const fn = window.AndroidBridge?.dismissIncomingCall;
    if (typeof fn === 'function') {
      fn();
    }
  } catch {
    // ignore bridge error
  }
}

/**
 * Memicu notifikasi pesan masuk melalui AndroidBridge saat aplikasi aktif di latar depan.
 */
export function triggerAndroidBridgeIncomingMessage(sender: string, body: string): void {
  if (typeof window === 'undefined') return;
  try {
    const fn = window.AndroidBridge?.showIncomingMessage;
    if (typeof fn === 'function') {
      fn(
        (sender || 'WattappsAU').trim().slice(0, MAX_SENDER_LENGTH),
        (body || 'Pesan baru masuk').trim().slice(0, MAX_BODY_LENGTH)
      );
    }
  } catch {
    // ignore bridge error
  }
}

/**
 * Mengaktifkan atau menonaktifkan mode audio panggilan native Android WebView
 * (AudioManager MODE_IN_COMMUNICATION + speaker routing) melalui `window.AndroidBridge?.setCallAudioMode?.(inCall)`.
 */
export function setAndroidBridgeCallAudioMode(inCall: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.AndroidBridge?.setCallAudioMode?.(inCall);
  } catch {
    // ignore bridge error
  }
}

/**
 * Meminta aplikasi Android WebView untuk masuk ke mode standby hemat baterai secara halus
 * di latar belakang tanpa mematikan layanan penerima notifikasi FCM.
 */
export function enterAndroidBridgeBatteryStandby(): void {
  if (typeof window === 'undefined') return;
  try {
    window.AndroidBridge?.enterBatteryStandby?.();
  } catch {
    // ignore bridge error
  }
}

/**
 * Meminta koordinat GPS native dari Android WebView (`window.AndroidBridge?.requestGpsLocation()`).
 * Mengembalikan `true` jika metode bridge tersedia dan berhasil dipanggil.
 */
export function requestAndroidBridgeGpsLocation(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const fn = window.AndroidBridge?.requestGpsLocation;
    if (typeof fn === 'function') {
      fn();
      return true;
    }
  } catch {
    // ignore bridge error
  }
  return false;
}

