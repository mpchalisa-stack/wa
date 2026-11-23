import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  Auth,
  User,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  Firestore,
  Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

const PEER_ID_REGEX = /^[0-9]{6}$/;
const DOC_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

let firebaseApp: FirebaseApp | null = null;
let firestoreDb: Firestore | null = null;
let firebaseAuth: Auth | null = null;

function ensureFirebaseInitialized(): { app: FirebaseApp; db: Firestore; auth: Auth } | null {
  try {
    if (!firebaseConfig?.apiKey || !firebaseConfig?.projectId) {
      return null;
    }
    if (!firebaseApp) {
      firebaseApp = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
      firestoreDb = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);
      firebaseAuth = getAuth(firebaseApp);
    }
    return { app: firebaseApp, db: firestoreDb!, auth: firebaseAuth! };
  } catch (err) {
    console.error('[WattappsAU Firebase] Initialization failed:', err);
    return null;
  }
}

const initialized = ensureFirebaseInitialized();
export const app = initialized?.app ?? null;
export const db = initialized?.db ?? null;
export const auth = initialized?.auth ?? null;

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const currentUser = auth?.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentUser?.uid,
      email: currentUser?.email,
      emailVerified: currentUser?.emailVerified,
      isAnonymous: currentUser?.isAnonymous,
      tenantId: currentUser?.tenantId,
      providerInfo:
        currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Validate live connection to Firestore on startup
async function testConnection(): Promise<void> {
  if (!db) return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

export function isFirebaseReady(): boolean {
  return Boolean(db && auth);
}

export function subscribeFirebaseAuth(callback: (user: User | null) => void): Unsubscribe {
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}

export async function signInWithGoogleForCloudPush(): Promise<User | null> {
  if (!auth) return null;
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signOutCloudPush(): Promise<void> {
  if (!auth) return;
  await signOut(auth);
}

function sanitizePeerId(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 6);
  return PEER_ID_REGEX.test(digits) ? digits : '';
}

function sanitizeDisplayName(name: string, fallbackPeerId: string): string {
  const trimmed = name.trim().slice(0, 80);
  return trimmed.length >= 1 ? trimmed : `ID ${fallbackPeerId}`;
}

function sanitizeDocId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
  return DOC_ID_REGEX.test(cleaned) ? cleaned : `sig_${Date.now()}`;
}

export interface DeviceSyncInput {
  peerId: string;
  displayName: string;
  fcmToken: string;
  platform: 'android' | 'ios' | 'web';
  standbyEnabled: boolean;
}

/**
 * Syncs the authenticated user's FCM push token to /devices/{uid} (private)
 * and publishes a non-PII 6-digit lookup entry to /peerDirectory/{peerId}.
 */
export async function syncDeviceTokenToFirestore(input: DeviceSyncInput): Promise<boolean> {
  if (!db || !auth?.currentUser || !auth.currentUser.emailVerified) {
    return false;
  }

  const uid = auth.currentUser.uid;
  const peerId = sanitizePeerId(input.peerId);
  if (!peerId || !DOC_ID_REGEX.test(uid)) return false;

  const fcmToken = (input.fcmToken || '').trim().slice(0, 512);
  const displayName = sanitizeDisplayName(input.displayName, peerId);
  const platform: 'android' | 'ios' | 'web' =
    input.platform === 'android' || input.platform === 'ios' ? input.platform : 'web';

  const devicePath = `devices/${uid}`;
  const directoryPath = `peerDirectory/${peerId}`;

  try {
    const deviceRef = doc(db, 'devices', uid);
    const existingDevice = await getDoc(deviceRef);
    if (existingDevice.exists()) {
      await updateDoc(deviceRef, {
        peerId,
        fcmToken,
        platform,
        standbyEnabled: Boolean(input.standbyEnabled),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(deviceRef, {
        userId: uid,
        peerId,
        fcmToken,
        platform,
        standbyEnabled: Boolean(input.standbyEnabled),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, devicePath);
  }

  try {
    const dirRef = doc(db, 'peerDirectory', peerId);
    const existingDir = await getDoc(dirRef);
    const pushReady = Boolean(fcmToken.length > 0 || input.standbyEnabled);
    if (existingDir.exists()) {
      if (existingDir.data()?.ownerUid === uid) {
        await updateDoc(dirRef, {
          displayName,
          pushReady,
          updatedAt: serverTimestamp(),
        });
      }
    } else {
      await setDoc(dirRef, {
        peerId,
        ownerUid: uid,
        displayName,
        pushReady,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, directoryPath);
  }
}

export interface FirestoreWakeSignal {
  signalId: string;
  senderUid: string;
  senderPeerId: string;
  senderName: string;
  recipientUid: string;
  recipientPeerId: string;
  type: 'INCOMING_CALL' | 'NEW_MSG' | 'PING';
  callType: 'audio' | 'video' | 'none';
  callId: string;
  status: 'pending' | 'acknowledged';
}

/**
 * Enqueues a realtime wake signal in /wakeSignals/{signalId} for a target 6-digit peer ID
 * if both sender and target peer are registered in Cloud Push / Firestore.
 */
export async function sendFirestoreWakeSignal(params: {
  recipientPeerId: string;
  senderPeerId: string;
  senderName: string;
  type: 'INCOMING_CALL' | 'NEW_MSG' | 'PING';
  callType?: 'audio' | 'video';
  callId?: string;
}): Promise<boolean> {
  if (!db || !auth?.currentUser || !auth.currentUser.emailVerified) {
    return false;
  }

  const senderUid = auth.currentUser.uid;
  const senderPeerId = sanitizePeerId(params.senderPeerId);
  const recipientPeerId = sanitizePeerId(params.recipientPeerId);
  if (!senderPeerId || !recipientPeerId || !DOC_ID_REGEX.test(senderUid)) {
    return false;
  }

  const lookupPath = `peerDirectory/${recipientPeerId}`;
  let recipientUid = '';
  try {
    const dirSnap = await getDoc(doc(db, 'peerDirectory', recipientPeerId));
    if (!dirSnap.exists()) return false;
    const data = dirSnap.data();
    recipientUid = typeof data?.ownerUid === 'string' ? data.ownerUid : '';
    if (!DOC_ID_REGEX.test(recipientUid)) return false;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, lookupPath);
  }

  const signalId = sanitizeDocId(
    `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  const signalPath = `wakeSignals/${signalId}`;

  try {
    await setDoc(doc(db, 'wakeSignals', signalId), {
      signalId,
      senderUid,
      senderPeerId,
      senderName: sanitizeDisplayName(params.senderName, senderPeerId),
      recipientUid,
      recipientPeerId,
      type: params.type,
      callType: params.type === 'INCOMING_CALL' ? params.callType || 'audio' : 'none',
      callId: (params.callId || '').slice(0, 128),
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, signalPath);
  }
}

export async function acknowledgeFirestoreWakeSignal(signalId: string): Promise<void> {
  if (!db || !auth?.currentUser || !auth.currentUser.emailVerified) return;
  const cleanId = sanitizeDocId(signalId);
  const path = `wakeSignals/${cleanId}`;
  try {
    await updateDoc(doc(db, 'wakeSignals', cleanId), {
      status: 'acknowledged',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

/**
 * Listens for pending incoming wake signals targeted at the authenticated user's UID.
 */
export function subscribeFirestoreWakeSignals(
  onSignal: (signal: FirestoreWakeSignal) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) {
    return () => {};
  }

  const uid = auth.currentUser.uid;
  const path = 'wakeSignals';
  const q = query(
    collection(db, 'wakeSignals'),
    where('recipientUid', '==', uid),
    where('status', '==', 'pending')
  );

  const seen = new Set<string>();

  return onSnapshot(
    q,
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== 'added') return;
        const data = change.doc.data() as Partial<FirestoreWakeSignal>;
        const id = data.signalId || change.doc.id;
        if (seen.has(id)) return;
        seen.add(id);

        if (
          data.senderPeerId &&
          data.recipientPeerId &&
          data.type &&
          data.recipientUid === uid
        ) {
          onSignal({
            signalId: id,
            senderUid: data.senderUid || '',
            senderPeerId: data.senderPeerId,
            senderName: data.senderName || `ID: ${data.senderPeerId}`,
            recipientUid: data.recipientUid,
            recipientPeerId: data.recipientPeerId,
            type: data.type,
            callType: data.callType || 'none',
            callId: data.callId || '',
            status: 'pending',
          });
        }
      });
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}
