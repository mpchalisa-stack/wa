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

export interface AndroidBridgeInterface {
  getFcmToken?: () => string | null | undefined;
  showIncomingCall?: (sender: string, body?: string) => void;
  showIncomingMessage?: (sender: string, body: string) => void;
  setCallAudioMode?: (inCall: boolean) => void;
}

declare global {
  interface Window {
    AndroidBridge?: AndroidBridgeInterface;
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

const FCM_APP_NAME = 'wattapps-fcm';
const DEVICE_TOKENS_COLLECTION = 'device_tokens';
const TOKEN_SYNC_INTERVAL_MS = 5000;
const MAX_TOKEN_LENGTH = 512;
const MAX_SENDER_LENGTH = 120;
const MAX_BODY_LENGTH = 500;

let fcmAppInstance: FirebaseApp | null = null;
let fcmFirestoreInstance: Firestore | null = null;

/**
 * Normalisasi ID dokumen Firestore untuk koleksi `device_tokens`:
 * menghapus spasi dan karakter pembatas path lalu mengubah ke lowercase (`id.trim().toLowerCase()`).
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

// Verifikasi konektivitas Firestore FCM saat aplikasi pertama kali dimuat
async function testFcmFirestoreConnection(): Promise<void> {
  const db = getFcmFirestore();
  if (!db) return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('[WattappsAU FCM] Firestore tidak dapat dijangkau. Periksa konfigurasi Firebase.');
    }
  }
}
void testFcmFirestoreConnection();

/**
 * Mengambil token FCM native dari `window.AndroidBridge?.getFcmToken?.()` dan menyimpannya ke
 * Firestore `device_tokens/{cleanId}` dengan format `{ userId: cleanId, fcmToken: token, updatedAt: Date.now() }`.
 */
let lastSyncedSignature = '';

export async function syncFcmToken(myUserId: string, forceWrite = false): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const cleanId = normalizeFcmUserId(myUserId);
  if (!cleanId) return false;

  let rawToken: string | null | undefined;
  try {
    rawToken = window.AndroidBridge?.getFcmToken?.();
  } catch {
    return false;
  }

  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    return false;
  }

  const signature = `${cleanId}:${token}`;
  if (!forceWrite && signature === lastSyncedSignature) {
    return true;
  }

  const db = getFcmFirestore();
  if (!db) return false;

  const docPath = `${DEVICE_TOKENS_COLLECTION}/${cleanId}`;
  try {
    await setDoc(
      doc(db, DEVICE_TOKENS_COLLECTION, cleanId),
      {
        userId: cleanId,
        fcmToken: token,
        updatedAt: Date.now(),
      },
      { merge: true }
    );
    lastSyncedSignature = signature;
    return true;
  } catch (error) {
    logFcmFirestoreError('write', docPath, error);
    return false;
  }
}

/**
 * Menjalankan `syncFcmToken()` segera saat aplikasi dibuka dan setiap 5 detik
 * selama ID pengguna lokal tersedia agar token baru/rotasi dari Android selalu tersinkron.
 */
export function startFcmTokenSyncLoop(myUserId: string): () => void {
  const cleanId = normalizeFcmUserId(myUserId);
  if (!cleanId || typeof window === 'undefined') {
    return () => {};
  }

  let cancelled = false;
  const runSync = (forceWrite = false) => {
    if (cancelled) return;
    void syncFcmToken(cleanId, forceWrite);
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
    const data = snap.data() as { fcmToken?: unknown } | undefined;
    if (typeof data?.fcmToken === 'string') {
      targetToken = data.fcmToken.trim();
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
 * Memicu notifikasi panggilan masuk melalui AndroidBridge saat aplikasi aktif di latar depan.
 */
export function triggerAndroidBridgeIncomingCall(
  sender: string,
  body = 'Panggilan Masuk WattappsAU'
): void {
  if (typeof window === 'undefined') return;
  try {
    const fn = window.AndroidBridge?.showIncomingCall;
    if (typeof fn === 'function') {
      fn(
        (sender || 'WattappsAU').trim().slice(0, MAX_SENDER_LENGTH),
        (body || 'Panggilan Masuk WattappsAU').trim().slice(0, MAX_BODY_LENGTH)
      );
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
