import { EncryptedTextPayload } from '../types';

export interface ConversationScopeInput {
  isGroup: boolean;
  chatId: string;
  peerA: string;
  peerB: string;
}

export interface TextEnvelopeContent {
  text?: string;
  replyText?: string;
}

const E2EE_DOMAIN_PREFIX = 'WA6-WATTAPPSAU-AES256GCM-V1::';
const keyCache = new Map<string, Promise<CryptoKey>>();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function buildConversationScope(input: ConversationScopeInput): string {
  if (input.isGroup) {
    return `group:${input.chatId.trim()}`;
  }
  const participants = [input.peerA.trim(), input.peerB.trim()].sort();
  return `dm:${participants[0]}:${participants[1]}`;
}

async function deriveAes256Key(scope: string): Promise<CryptoKey> {
  const existing = keyCache.get(scope);
  if (existing) return existing;

  const keyPromise = (async () => {
    const encoder = new TextEncoder();
    const material = encoder.encode(`${E2EE_DOMAIN_PREFIX}${scope}`);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', material);
    return globalThis.crypto.subtle.importKey(
      'raw',
      digest,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  })();

  keyCache.set(scope, keyPromise);
  keyPromise.catch(() => {
    keyCache.delete(scope);
  });
  return keyPromise;
}

export async function encryptTextEnvelope(
  content: TextEnvelopeContent,
  scope: string
): Promise<EncryptedTextPayload | null> {
  if (typeof content.text !== 'string' && typeof content.replyText !== 'string') {
    return null;
  }
  if (typeof globalThis === 'undefined' || !globalThis.crypto?.subtle) {
    return null;
  }

  try {
    const key = await deriveAes256Key(scope);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(content));
    const encryptedBuffer = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoded
    );

    return {
      alg: 'AES-256-GCM',
      v: 1,
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(encryptedBuffer)),
    };
  } catch {
    return null;
  }
}

export async function decryptTextEnvelope(
  envelope: EncryptedTextPayload,
  scope: string
): Promise<TextEnvelopeContent | null> {
  if (
    !envelope ||
    envelope.alg !== 'AES-256-GCM' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.ct !== 'string'
  ) {
    return null;
  }
  if (typeof globalThis === 'undefined' || !globalThis.crypto?.subtle) {
    return null;
  }

  try {
    const key = await deriveAes256Key(scope);
    const iv = base64ToBytes(envelope.iv);
    const cipherBytes = base64ToBytes(envelope.ct);
    const decryptedBuffer = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      cipherBytes as BufferSource
    );
    const decoded = new TextDecoder().decode(decryptedBuffer);
    const parsed = JSON.parse(decoded) as TextEnvelopeContent;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : undefined,
      replyText: typeof parsed.replyText === 'string' ? parsed.replyText : undefined,
    };
  } catch {
    return null;
  }
}
