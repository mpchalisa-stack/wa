import {
  CallRecord,
  ChatMessage,
  Contact,
  PendingOutboxMessage,
  StatusItem,
  ThemeMode,
  UserProfile,
} from '../types';
import { dataUrlToBlob, fileToDataUrl, resolveMimeTypeForFile } from './media';

const DB_NAME = 'WA6LocalDatabase';
const DB_VERSION = 3;

const STORES = {
  contacts: 'contacts',
  messages: 'messages',
  media: 'media', // Dedicated IndexedDB store for binary Blobs (images, videos, documents, voice notes)
  pendingMessages: 'pendingMessages', // Persistent Outbox Queue untuk pesan tertunda saat peer offline
  statuses: 'statuses',
  calls: 'calls',
} as const;

interface StoredMediaRecord {
  id: string;
  chatId: string;
  blob: Blob;
  mimeType: string;
  fileName?: string;
  fileSize?: number;
  createdAt: number;
}

export const LOCKED_USER_ID_KEY = 'wattapps_user_id';
export const LOCKED_USER_NAME_KEY = 'wattapps_user_name';

const PROFILE_KEY = 'wa6_user_profile_v1';
const THEME_KEY = 'wa6_theme_mode_v1';
const UNREAD_KEY = 'wa6_unread_counts_v1';
const OUTBOX_KEY = 'outboxMessages';

function sanitizeSixDigitId(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\D/g, '').trim();
  return /^\d{6}$/.test(cleaned) ? cleaned : null;
}

/**
 * Membaca ID permanen perangkat yang terkunci di localStorage (`wattapps_user_id`).
 * Sinkron agar selalu tersedia sebelum PeerJS, Firestore, atau FCM diinisialisasi.
 */
export function getLockedUserId(): string | null {
  try {
    const direct = sanitizeSixDigitId(localStorage.getItem(LOCKED_USER_ID_KEY));
    if (direct) return direct;

    // Migrasi otomatis satu kali dari profil lama jika wattapps_user_id belum tertulis
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserProfile>;
      const legacyId = sanitizeSixDigitId(parsed?.id);
      if (legacyId) {
        localStorage.setItem(LOCKED_USER_ID_KEY, legacyId);
        if (typeof parsed?.name === 'string' && parsed.name.trim()) {
          localStorage.setItem(LOCKED_USER_NAME_KEY, parsed.name.trim());
        }
        return legacyId;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function getLockedUserName(): string | null {
  try {
    const direct = localStorage.getItem(LOCKED_USER_NAME_KEY)?.trim();
    if (direct) return direct;

    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserProfile>;
      const legacyName = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
      if (legacyName) {
        localStorage.setItem(LOCKED_USER_NAME_KEY, legacyName);
        return legacyName;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Lightweight preferences only in localStorage (NEVER store chat messages or media in localStorage)
export function getSavedProfile(): UserProfile | null {
  try {
    const lockedId = getLockedUserId();
    const lockedName = getLockedUserName();
    const raw = localStorage.getItem(PROFILE_KEY);

    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserProfile>;
      const resolvedId = lockedId || sanitizeSixDigitId(parsed?.id);
      const resolvedName =
        (typeof parsed?.name === 'string' ? parsed.name.trim() : '') || lockedName || '';

      if (resolvedId && resolvedName) {
        const syncedProfile: UserProfile = {
          id: resolvedId,
          name: resolvedName,
          bio: typeof parsed?.bio === 'string' && parsed.bio.trim() ? parsed.bio : 'Ada',
          avatar: typeof parsed?.avatar === 'string' && parsed.avatar ? parsed.avatar : 'preset-emerald',
          createdAt: typeof parsed?.createdAt === 'number' ? parsed.createdAt : Date.now(),
        };
        localStorage.setItem(LOCKED_USER_ID_KEY, syncedProfile.id);
        localStorage.setItem(LOCKED_USER_NAME_KEY, syncedProfile.name);
        if (parsed?.id !== syncedProfile.id || parsed?.name !== syncedProfile.name) {
          localStorage.setItem(PROFILE_KEY, JSON.stringify(syncedProfile));
        }
        return syncedProfile;
      }
    }

    // Jika PROFILE_KEY terhapus tetapi wattapps_user_id & wattapps_user_name masih terkunci,
    // pulihkan profil secara otomatis agar perangkat TIDAK pernah lupa identitas atau membuat ID acak baru.
    if (lockedId && lockedName) {
      const recoveredProfile: UserProfile = {
        id: lockedId,
        name: lockedName,
        bio: 'Ada',
        avatar: 'preset-emerald',
        createdAt: Date.now(),
      };
      localStorage.setItem(PROFILE_KEY, JSON.stringify(recoveredProfile));
      return recoveredProfile;
    }

    return null;
  } catch {
    return null;
  }
}

export function saveUserProfile(profile: UserProfile): UserProfile {
  try {
    const existingLockedId = getLockedUserId();
    const incomingId = sanitizeSixDigitId(profile.id);
    // Kunci permanen: jika wattapps_user_id sudah ada di perangkat ini, JANGAN pernah timpa dengan ID acak baru
    const authoritativeId = existingLockedId || incomingId || profile.id;
    const cleanName =
      profile.name.trim() || getLockedUserName() || `Pengguna ${authoritativeId}`;

    const lockedProfile: UserProfile = {
      ...profile,
      id: authoritativeId,
      name: cleanName,
    };

    localStorage.setItem(LOCKED_USER_ID_KEY, lockedProfile.id);
    localStorage.setItem(LOCKED_USER_NAME_KEY, lockedProfile.name);
    localStorage.setItem(PROFILE_KEY, JSON.stringify(lockedProfile));
    return lockedProfile;
  } catch (err) {
    console.error('Failed to save profile:', err);
    return profile;
  }
}

export function getSavedTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // ignore
  }
  return 'dark';
}

export function saveTheme(theme: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // ignore
  }
}

export function getSavedUnreadCounts(): Record<string, number> {
  try {
    const raw = localStorage.getItem(UNREAD_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function saveUnreadCounts(counts: Record<string, number>): void {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify(counts));
  } catch {
    // ignore
  }
}

export function getSavedOutboxMessages(): PendingOutboxMessage[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingOutboxMessage[]) : [];
  } catch {
    return [];
  }
}

export function saveOutboxMessages(items: PendingOutboxMessage[]): void {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  } catch {
    // ignore
  }
}

// IndexedDB for contacts, chat history, binary media Blobs, statuses, and calls
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.contacts)) {
        db.createObjectStore(STORES.contacts, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.messages)) {
        const msgStore = db.createObjectStore(STORES.messages, { keyPath: 'id' });
        msgStore.createIndex('chatId', 'chatId', { unique: false });
        msgStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.media)) {
        const mediaStore = db.createObjectStore(STORES.media, { keyPath: 'id' });
        mediaStore.createIndex('chatId', 'chatId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.pendingMessages)) {
        const pendingStore = db.createObjectStore(STORES.pendingMessages, { keyPath: 'id' });
        pendingStore.createIndex('recipientId', 'recipientId', { unique: false });
        pendingStore.createIndex('messageId', 'messageId', { unique: false });
        pendingStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.statuses)) {
        db.createObjectStore(STORES.statuses, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.calls)) {
        db.createObjectStore(STORES.calls, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllFromStore<T>(storeName: string): Promise<T[]> {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result as T[]);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error(`IndexedDB read error (${storeName}):`, err);
    return [];
  }
}

async function putInStore<T>(storeName: string, value: T): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error(`IndexedDB write error (${storeName}):`, err);
  }
}

async function deleteFromStore(storeName: string, key: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error(`IndexedDB delete error (${storeName}):`, err);
  }
}

/**
 * Menyimpan pesan chat ke IndexedDB.
 * Jika pesan memiliki gambar/video/dokumen/voice note, payload biner disimpan sebagai Blob
 * di object store `media` terpisah agar IndexedDB hemat memori & bebas batas 5 MB localStorage.
 */
export async function dbSaveMessage(msg: ChatMessage): Promise<void> {
  try {
    const db = await openDB();
    let recordToStore: ChatMessage = { ...msg };
    // Jangan simpan progres sementara ke storage permanen jika sudah terkirim/diterima
    if (recordToStore.status === 'delivered' || recordToStore.status === 'read') {
      delete recordToStore.transferProgress;
      delete recordToStore.transferWaitingPeer;
    }

    let mediaRecord: StoredMediaRecord | null = null;
    if (recordToStore.mediaData && !recordToStore.deleted) {
      const mediaId = recordToStore.mediaId || `media-${recordToStore.id}`;
      try {
        const resolvedMime = resolveMimeTypeForFile(recordToStore.fileName, recordToStore.mimeType);
        const blob = dataUrlToBlob(recordToStore.mediaData, resolvedMime);
        mediaRecord = {
          id: mediaId,
          chatId: recordToStore.chatId,
          blob,
          mimeType: resolvedMime,
          fileName: recordToStore.fileName,
          fileSize: recordToStore.fileSize || blob.size,
          createdAt: recordToStore.timestamp,
        };
        // Simpan referensi mediaId pada pesan dan kosongkan base64 duplikat di store messages
        recordToStore = { ...recordToStore, mimeType: resolvedMime, mediaId, mediaData: undefined };
      } catch {
        // Fallback tetap simpan di IndexedDB messages store jika bukan data URL standar
      }
    }

    await new Promise<void>((resolve, reject) => {
      const storeNames = mediaRecord ? [STORES.messages, STORES.media] : [STORES.messages];
      const tx = db.transaction(storeNames, 'readwrite');
      tx.objectStore(STORES.messages).put(recordToStore);
      if (mediaRecord) {
        tx.objectStore(STORES.media).put(mediaRecord);
      }
      if (recordToStore.deleted && recordToStore.mediaId) {
        try {
          db.transaction(STORES.media, 'readwrite').objectStore(STORES.media).delete(recordToStore.mediaId);
        } catch {
          // ignore
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('IndexedDB save message error:', err);
  }
}

export async function loadAllLocalData(): Promise<{
  contacts: Contact[];
  messages: ChatMessage[];
  pendingMessages: PendingOutboxMessage[];
  statuses: StatusItem[];
  calls: CallRecord[];
}> {
  const now = Date.now();
  const [contacts, rawMessages, mediaRecords, pendingMessages, rawStatuses, calls] = await Promise.all([
    getAllFromStore<Contact>(STORES.contacts),
    getAllFromStore<ChatMessage>(STORES.messages),
    getAllFromStore<StoredMediaRecord>(STORES.media),
    getAllFromStore<PendingOutboxMessage>(STORES.pendingMessages),
    getAllFromStore<StatusItem>(STORES.statuses),
    getAllFromStore<CallRecord>(STORES.calls),
  ]);

  // Rehydrate media Blobs from IndexedDB `media` store back into DataURLs for UI & download
  const mediaMap = new Map<string, StoredMediaRecord>();
  for (const m of mediaRecords) {
    mediaMap.set(m.id, m);
  }

  const messages: ChatMessage[] = await Promise.all(
    rawMessages.map(async (msg) => {
      if (msg.mediaId && !msg.mediaData && !msg.deleted) {
        const mediaRec = mediaMap.get(msg.mediaId);
        if (mediaRec?.blob) {
          try {
            const resolvedMime = resolveMimeTypeForFile(
              msg.fileName || mediaRec.fileName,
              msg.mimeType || mediaRec.mimeType || mediaRec.blob.type
            );
            const normalizedBlob =
              !mediaRec.blob.type ||
              (mediaRec.blob.type === 'application/octet-stream' &&
                resolvedMime !== 'application/octet-stream')
                ? new Blob([mediaRec.blob], { type: resolvedMime })
                : mediaRec.blob;
            const dataUrl = await fileToDataUrl(normalizedBlob);
            return { ...msg, mimeType: resolvedMime, mediaData: dataUrl };
          } catch {
            return msg;
          }
        }
      }
      return msg;
    })
  );

  // Filter out expired statuses (>24 hours) and delete them from IndexedDB
  const validStatuses: StatusItem[] = [];
  for (const s of rawStatuses) {
    if (s.expiresAt > now) {
      validStatuses.push(s);
    } else {
      void deleteFromStore(STORES.statuses, s.id);
    }
  }

  // Gabungkan outboxMessages dari localStorage & IndexedDB tanpa duplikasi
  const mergedOutboxMap = new Map<string, PendingOutboxMessage>();
  for (const item of getSavedOutboxMessages()) {
    mergedOutboxMap.set(item.id, item);
  }
  for (const item of pendingMessages) {
    mergedOutboxMap.set(item.id, item);
  }
  const mergedPending = Array.from(mergedOutboxMap.values()).sort(
    (a, b) => a.createdAt - b.createdAt
  );

  messages.sort((a, b) => a.timestamp - b.timestamp);
  validStatuses.sort((a, b) => b.timestamp - a.timestamp);
  calls.sort((a, b) => b.timestamp - a.timestamp);

  return { contacts, messages, pendingMessages: mergedPending, statuses: validStatuses, calls };
}

export const dbSaveContact = (contact: Contact) => putInStore(STORES.contacts, contact);
export const dbDeleteContact = (id: string) => deleteFromStore(STORES.contacts, id);
export const dbSavePendingMessage = (item: PendingOutboxMessage) =>
  putInStore(STORES.pendingMessages, item);
export const dbDeletePendingMessage = (id: string) =>
  deleteFromStore(STORES.pendingMessages, id);
export const dbSaveStatus = (status: StatusItem) => putInStore(STORES.statuses, status);
export const dbDeleteStatus = (id: string) => deleteFromStore(STORES.statuses, id);
export const dbSaveCall = (call: CallRecord) => putInStore(STORES.calls, call);

export async function dbDeletePendingByMessageId(messageId: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORES.pendingMessages, 'readwrite');
      const idx = tx.objectStore(STORES.pendingMessages).index('messageId');
      const req = idx.openCursor(IDBKeyRange.only(messageId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('Failed to delete pending messages by messageId:', err);
  }
}

export async function dbDeleteMessagesForChat(chatId: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORES.messages, STORES.media], 'readwrite');
      const msgIdx = tx.objectStore(STORES.messages).index('chatId');
      const msgReq = msgIdx.openCursor(IDBKeyRange.only(chatId));
      msgReq.onsuccess = () => {
        const cursor = msgReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      const mediaIdx = tx.objectStore(STORES.media).index('chatId');
      const mediaReq = mediaIdx.openCursor(IDBKeyRange.only(chatId));
      mediaReq.onsuccess = () => {
        const cursor = mediaReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('Failed to clear chat messages & media:', err);
  }
}

export async function dbClearCalls(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORES.calls, 'readwrite');
      tx.objectStore(STORES.calls).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('Failed to clear calls:', err);
  }
}

export async function resetAllLocalData(): Promise<void> {
  try {
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(LOCKED_USER_ID_KEY);
    localStorage.removeItem(LOCKED_USER_NAME_KEY);
    localStorage.removeItem(UNREAD_KEY);
    localStorage.removeItem(OUTBOX_KEY);
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        [
          STORES.contacts,
          STORES.messages,
          STORES.media,
          STORES.pendingMessages,
          STORES.statuses,
          STORES.calls,
        ],
        'readwrite'
      );
      tx.objectStore(STORES.contacts).clear();
      tx.objectStore(STORES.messages).clear();
      tx.objectStore(STORES.media).clear();
      tx.objectStore(STORES.pendingMessages).clear();
      tx.objectStore(STORES.statuses).clear();
      tx.objectStore(STORES.calls).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('Failed to reset local data:', err);
  }
}
