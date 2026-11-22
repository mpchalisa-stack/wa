import { CallType } from '../types';

const NTFY_BASE_URL = 'https://ntfy.sh';
const NTFY_TOPIC_PREFIX = 'wattappsau-signal-';
const ENC_TOKEN_PREFIX = 'WAAU1:';

export type NtfyWakeType = 'INCOMING_CALL' | 'NEW_MSG';

export interface NtfyWakePayload {
  type: NtfyWakeType;
  fromId: string;
  fromName: string;
  callType?: CallType;
  callId?: string;
  ts: number;
}

export function getNtfyTopic(sixDigitId: string): string {
  const clean = sixDigitId.replace(/\D/g, '');
  return `${NTFY_TOPIC_PREFIX}${clean}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveTopicAesKey(targetSixDigitId: string): Promise<CryptoKey | null> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null;
    const rawMaterial = new TextEncoder().encode(
      `WattappsAU-Diskomlekau-AES256GCM-v1:${getNtfyTopic(targetSixDigitId)}`
    );
    const hash = await crypto.subtle.digest('SHA-256', rawMaterial);
    return await crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  } catch {
    return null;
  }
}

async function encryptWakePayload(
  targetSixDigitId: string,
  payload: NtfyWakePayload
): Promise<string> {
  const json = JSON.stringify(payload);
  const key = await deriveTopicAesKey(targetSixDigitId);
  if (!key) {
    return payload.type;
  }
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(json);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    return `${ENC_TOKEN_PREFIX}${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
  } catch {
    return payload.type;
  }
}

async function decryptWakePayload(
  mySixDigitId: string,
  rawMessage: string
): Promise<NtfyWakePayload | null> {
  if (!rawMessage) return null;

  // Cari token terenkripsi WAAU1:<iv>.<ciphertext> di dalam body
  const tokenIdx = rawMessage.indexOf(ENC_TOKEN_PREFIX);
  if (tokenIdx >= 0) {
    const token = rawMessage.slice(tokenIdx + ENC_TOKEN_PREFIX.length).trim().split(/\s+/)[0];
    const dotIdx = token.indexOf('.');
    if (dotIdx > 0) {
      const key = await deriveTopicAesKey(mySixDigitId);
      if (key) {
        try {
          const iv = base64ToBytes(token.slice(0, dotIdx));
          const cipherBytes = base64ToBytes(token.slice(dotIdx + 1));
          const plainBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv as BufferSource },
            key,
            cipherBytes as BufferSource
          );
          const decoded = new TextDecoder().decode(plainBuf);
          const parsed = JSON.parse(decoded) as NtfyWakePayload;
          if (parsed && (parsed.type === 'INCOMING_CALL' || parsed.type === 'NEW_MSG')) {
            return parsed;
          }
        } catch {
          // Gagal dekripsi — abaikan pesan yang bukan milik topik ini
          return null;
        }
      }
    }
  }

  // Fallback sinyal bangun polos jika crypto.subtle tidak tersedia di perangkat pengirim
  if (rawMessage.includes('INCOMING_CALL')) {
    return {
      type: 'INCOMING_CALL',
      fromId: '',
      fromName: 'Kontak WattappsAU',
      callType: 'audio',
      ts: Date.now(),
    };
  }
  if (rawMessage.includes('NEW_MSG')) {
    return {
      type: 'NEW_MSG',
      fromId: '',
      fromName: 'Kontak WattappsAU',
      ts: Date.now(),
    };
  }
  return null;
}

/**
 * Mengirim sinyal bangun (wake signal) terenkripsi AES-256-GCM via HTTP POST ringan ke https://ntfy.sh
 * saat penerima sedang Offline / aplikasi tertutup.
 */
export async function sendNtfyWakeSignal(params: {
  targetId: string;
  type: NtfyWakeType;
  fromId: string;
  fromName: string;
  callType?: CallType;
  callId?: string;
}): Promise<boolean> {
  const cleanTarget = params.targetId.replace(/\D/g, '');
  if (cleanTarget.length !== 6) return false;

  const topic = getNtfyTopic(cleanTarget);
  const payload: NtfyWakePayload = {
    type: params.type,
    fromId: params.fromId,
    fromName: params.fromName,
    callType: params.callType,
    callId: params.callId,
    ts: Date.now(),
  };

  const encryptedToken = await encryptWakePayload(cleanTarget, payload);
  const humanLabel =
    params.type === 'INCOMING_CALL'
      ? `Panggilan ${params.callType === 'video' ? 'Video' : 'Suara'} Masuk — Ketuk buka WattappsAU`
      : 'Pesan Baru Masuk — Buka WattappsAU';

  const body = `${humanLabel}\n${encryptedToken}`;

  try {
    const resp = await fetch(`${NTFY_BASE_URL}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        Title: 'WattappsAU',
        Priority: 'urgent',
        Tags:
          params.type === 'INCOMING_CALL'
            ? 'telephone_receiver,rotating_light'
            : 'speech_balloon',
      },
      body,
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Membuka satu koneksi SSE ringan ke https://ntfy.sh/wattappsau-signal-{my6DigitId}/sse
 * untuk menerima sinyal bangun & notifikasi masuk secara hemat baterai.
 */
export function subscribeNtfySignal(
  mySixDigitId: string,
  onSignal: (signal: NtfyWakePayload) => void
): () => void {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
    return () => {};
  }
  const cleanId = mySixDigitId.replace(/\D/g, '');
  if (cleanId.length !== 6) return () => {};

  const topic = getNtfyTopic(cleanId);
  const sseUrl = `${NTFY_BASE_URL}/${encodeURIComponent(topic)}/sse`;
  let closed = false;
  let es: EventSource | null = null;
  const seenEventIds = new Set<string>();

  try {
    es = new EventSource(sseUrl);

    es.onmessage = (event) => {
      if (closed || !event.data) return;
      try {
        const parsed = JSON.parse(event.data) as {
          id?: string;
          event?: string;
          time?: number;
          message?: string;
        };
        if (parsed.event && parsed.event !== 'message') return;
        if (parsed.id) {
          if (seenEventIds.has(parsed.id)) return;
          seenEventIds.add(parsed.id);
          if (seenEventIds.size > 100) {
            const first = seenEventIds.values().next().value;
            if (first) seenEventIds.delete(first);
          }
        }
        // Abaikan event lama (> 90 detik) agar tidak memicu dering basi saat baru membuka aplikasi
        if (typeof parsed.time === 'number' && Date.now() - parsed.time * 1000 > 90_000) {
          return;
        }
        if (!parsed.message) return;

        void decryptWakePayload(cleanId, parsed.message).then((signal) => {
          if (!signal || closed) return;
          if (signal.fromId && signal.fromId === cleanId) return;
          if (Date.now() - signal.ts > 90_000) return;
          onSignal(signal);
        });
      } catch {
        // ignore non-JSON keepalive
      }
    };

    es.onerror = () => {
      // Browser EventSource otomatis melakukan reconnect backoff ringan tanpa loop manual
    };
  } catch {
    // ignore
  }

  return () => {
    closed = true;
    if (es) {
      try {
        es.close();
      } catch {
        // ignore
      }
      es = null;
    }
  };
}
