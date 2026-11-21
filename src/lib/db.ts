import { CallRecord, ChatMessage, Contact, StatusItem, ThemeMode, UserProfile } from '../types';

const DB_NAME = 'WA6LocalDatabase';
const DB_VERSION = 1;

const STORES = {
  contacts: 'contacts',
  messages: 'messages',
  statuses: 'statuses',
  calls: 'calls',
} as const;

const PROFILE_KEY = 'wa6_user_profile_v1';
const THEME_KEY = 'wa6_theme_mode_v1';
const UNREAD_KEY = 'wa6_unread_counts_v1';

// Profile & Theme helpers in localStorage
export function getSavedProfile(): UserProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UserProfile;
    if (parsed && typeof parsed.id === 'string' && /^\d{6}$/.test(parsed.id)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveUserProfile(profile: UserProfile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch (err) {
    console.error('Failed to save profile:', err);
  }
}

export function getSavedTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch {
    // ignore
  }
  return 'light';
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

// IndexedDB for contacts, chat history (including base64 media/VN), statuses, and calls
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

export async function loadAllLocalData(): Promise<{
  contacts: Contact[];
  messages: ChatMessage[];
  statuses: StatusItem[];
  calls: CallRecord[];
}> {
  const now = Date.now();
  const [contacts, messages, rawStatuses, calls] = await Promise.all([
    getAllFromStore<Contact>(STORES.contacts),
    getAllFromStore<ChatMessage>(STORES.messages),
    getAllFromStore<StatusItem>(STORES.statuses),
    getAllFromStore<CallRecord>(STORES.calls),
  ]);

  // Filter out expired statuses (>24 hours) and delete them from IndexedDB
  const validStatuses: StatusItem[] = [];
  for (const s of rawStatuses) {
    if (s.expiresAt > now) {
      validStatuses.push(s);
    } else {
      void deleteFromStore(STORES.statuses, s.id);
    }
  }

  messages.sort((a, b) => a.timestamp - b.timestamp);
  validStatuses.sort((a, b) => b.timestamp - a.timestamp);
  calls.sort((a, b) => b.timestamp - a.timestamp);

  return { contacts, messages, statuses: validStatuses, calls };
}

export const dbSaveContact = (contact: Contact) => putInStore(STORES.contacts, contact);
export const dbDeleteContact = (id: string) => deleteFromStore(STORES.contacts, id);
export const dbSaveMessage = (msg: ChatMessage) => putInStore(STORES.messages, msg);
export const dbSaveStatus = (status: StatusItem) => putInStore(STORES.statuses, status);
export const dbDeleteStatus = (id: string) => deleteFromStore(STORES.statuses, id);
export const dbSaveCall = (call: CallRecord) => putInStore(STORES.calls, call);

export async function dbDeleteMessagesForChat(chatId: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORES.messages, 'readwrite');
      const store = tx.objectStore(STORES.messages);
      const idx = store.index('chatId');
      const req = idx.openCursor(IDBKeyRange.only(chatId));
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
    console.error('Failed to clear chat messages:', err);
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
    localStorage.removeItem(UNREAD_KEY);
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        [STORES.contacts, STORES.messages, STORES.statuses, STORES.calls],
        'readwrite'
      );
      tx.objectStore(STORES.contacts).clear();
      tx.objectStore(STORES.messages).clear();
      tx.objectStore(STORES.statuses).clear();
      tx.objectStore(STORES.calls).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('Failed to reset local data:', err);
  }
}
