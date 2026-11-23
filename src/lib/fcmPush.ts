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
import { normalizePeerId } from './peerManager';

export interface AndroidBridgeInterface {
  getFcmToken?: () => string | null | undefined;
  showIncomingCall?: (sender: string, body?: string) => void;
  showIncomingMessage?: (sender: string, body: string) => void;
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

const FCM_APP_NAME = 'wattapps-fcm';
const DEVICE_TOKENS_COLLECTION = 'device_tokens';
const TOKEN_RETRY_INTERVAL_MS = 5000;
const TOKEN_RETRY_DURATION_MS = 30000;
const MAX_TOKEN_LENGTH = 512;
const MAX_SENDER_LENGTH = 120;
const MAX_BODY_LENGTH = 500;

let fcmAppInstance: FirebaseApp | null = null;
let fcmFirestoreInstance: Firestore | null = null;

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

function readAndroidFcmToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    const fn = window.AndroidBridge?.getFcmToken;
    if (typeof fn !== 'function') return '';
    const raw = fn();
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_TOKEN_LENGTH || /\s/.test(trimmed)) {
      return '';
    }
    return trimmed;
  } catch {
    return '';
  }
}

/**
 * Memeriksa window.AndroidBridge?.getFcmToken saat aplikasi dibuka dan ID pengguna siap.
 * Jika token tersedia, simpan ke Firestore `device_tokens/{cleanUserId}`.
 * Melakukan pengecekan ulang setiap 5 detik selama 30 detik pertama jika token baru selesai
 * di-generate oleh Android.
 */
export function syncAndroidFcmTokenToFirestore(rawUserId: string): () => void {
  const cleanUserId = normalizePeerId(rawUserId);
  if (!cleanUserId || typeof window === 'undefined') {
    return () => {};
  }

  let cancelled = false;
  let lastSavedToken = '';
  let intervalId: number | null = null;
  let stopTimeoutId: number | null = null;

  const attemptSync = async (): Promise<void> => {
    if (cancelled) return;
    if (typeof window.AndroidBridge?.getFcmToken !== 'function') return;

    const fcmToken = readAndroidFcmToken();
    if (!fcmToken || fcmToken === lastSavedToken) return;

    const db = getFcmFirestore();
    if (!db) return;

    const docPath = `${DEVICE_TOKENS_COLLECTION}/${cleanUserId}`;
    try {
      await setDoc(
        doc(db, DEVICE_TOKENS_COLLECTION, cleanUserId),
        {
          userId: cleanUserId,
          fcmToken,
          updatedAt: Date.now(),
        },
        { merge: true }
      );
      lastSavedToken = fcmToken;
    } catch (error) {
      logFcmFirestoreError('write', docPath, error);
    }
  };

  // Cek langsung pada saat mount / ID tersedia
  void attemptSync();

  // Pengecekan ulang setiap 5 detik selama 30 detik pertama
  intervalId = window.setInterval(() => {
    void attemptSync();
  }, TOKEN_RETRY_INTERVAL_MS);

  stopTimeoutId = window.setTimeout(() => {
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
    stopTimeoutId = null;
  }, TOKEN_RETRY_DURATION_MS + 200);

  return () => {
    cancelled = true;
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
    if (stopTimeoutId !== null) {
      window.clearTimeout(stopTimeoutId);
      stopTimeoutId = null;
    }
  };
}

/**
 * Mengambil token FCM tujuan dari Firestore `device_tokens/{cleanTargetUserId}`
 * lalu mengirim High-Priority Data Message melalui endpoint Vercel Serverless `POST /api/push`.
 */
export async function sendFcmPushToUser(params: FcmPushRequest): Promise<boolean> {
  const cleanTargetUserId = normalizePeerId(params.targetUserId);
  if (!cleanTargetUserId) return false;

  const db = getFcmFirestore();
  if (!db) return false;

  const docPath = `${DEVICE_TOKENS_COLLECTION}/${cleanTargetUserId}`;
  let targetToken = '';

  try {
    const snap = await getDoc(doc(db, DEVICE_TOKENS_COLLECTION, cleanTargetUserId));
    if (!snap.exists()) return false;
    const data = snap.data() as { fcmToken?: unknown } | undefined;
    if (typeof data?.fcmToken === 'string') {
      targetToken = data.fcmToken.trim();
    }
  } catch (error) {
    logFcmFirestoreError('get', docPath, error);
    return false;
  }

  if (!targetToken || targetToken.length > MAX_TOKEN_LENGTH || /\s/.test(targetToken)) {
    return false;
  }

  const safeType: FcmPushType = params.type === 'call' ? 'call' : 'message';
  const safeSender = (params.sender || 'WattappsAU').trim().slice(0, MAX_SENDER_LENGTH) || 'WattappsAU';
  const safeBody =
    (params.body || (safeType === 'call' ? 'Panggilan masuk...' : 'Pesan baru masuk'))
      .trim()
      .slice(0, MAX_BODY_LENGTH) || (safeType === 'call' ? 'Panggilan masuk...' : 'Pesan baru masuk');

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
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Memicu notifikasi panggilan masuk melalui AndroidBridge saat aplikasi aktif di latar depan.
 */
export function triggerAndroidBridgeIncomingCall(sender: string, body = 'Panggilan masuk...'): void {
  if (typeof window === 'undefined') return;
  try {
    const fn = window.AndroidBridge?.showIncomingCall;
    if (typeof fn === 'function') {
      fn(
        (sender || 'WattappsAU').trim().slice(0, MAX_SENDER_LENGTH),
        (body || 'Panggilan masuk...').trim().slice(0, MAX_BODY_LENGTH)
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
