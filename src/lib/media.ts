export function generateSixDigitId(): string {
  const min = 100000;
  const max = 999999;
  const array = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(array);
    return String(min + (array[0] % (max - min + 1)));
  }
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

export function formatSixDigitId(id: string): string {
  const clean = id.replace(/\D/g, '').slice(0, 6);
  if (clean.length === 6) {
    return `${clean.slice(0, 3)} ${clean.slice(3)}`;
  }
  return id;
}

export function generateUid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatChatListTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  if (isToday) return formatTime(timestamp);

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear();
  if (isYesterday) return 'Kemarin';

  return date.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
}

export function formatDateSeparator(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()
  ) {
    return 'Hari ini';
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear()
  ) {
    return 'Kemarin';
  }
  return date.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export const PRESET_AVATARS = [
  { id: 'preset:teal', bg: '#008069', fg: '#FFFFFF', label: 'Hijau' },
  { id: 'preset:blue', bg: '#1D4ED8', fg: '#FFFFFF', label: 'Biru' },
  { id: 'preset:purple', bg: '#7C3AED', fg: '#FFFFFF', label: 'Ungu' },
  { id: 'preset:amber', bg: '#D97706', fg: '#FFFFFF', label: 'Amber' },
  { id: 'preset:rose', bg: '#E11D48', fg: '#FFFFFF', label: 'Merah' },
  { id: 'preset:slate', bg: '#334155', fg: '#FFFFFF', label: 'Slate' },
];

export const STATUS_BG_COLORS = [
  '#008069',
  '#128C7E',
  '#075E54',
  '#1D4ED8',
  '#6D28D9',
  '#BE123C',
  '#B45309',
  '#1F2937',
];

export const GROUP_SENDER_COLORS = [
  '#0284C7',
  '#059669',
  '#D97706',
  '#9333EA',
  '#E11D48',
  '#0D9488',
  '#4F46E5',
];

export function getSenderColor(senderId: string): string {
  let hash = 0;
  for (let i = 0; i < senderId.length; i++) {
    hash = senderId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return GROUP_SENDER_COLORS[Math.abs(hash) % GROUP_SENDER_COLORS.length];
}

export function estimateDataUrlBytes(dataUrl: string): number {
  const commaIdx = dataUrl.indexOf(',');
  const base64Part = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const padding = base64Part.endsWith('==') ? 2 : base64Part.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64Part.length * 3) / 4) - padding);
}

const EXTENSION_MIME_MAP: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  pdf: 'application/pdf',
  txt: 'text/plain;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  json: 'application/json',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'audio/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

export function resolveMimeTypeForFile(fileName?: string, explicitMimeType?: string): string {
  const cleanExplicit = explicitMimeType?.trim();
  if (cleanExplicit && cleanExplicit !== 'application/octet-stream') {
    return cleanExplicit;
  }
  const ext = fileName?.split('.').pop()?.toLowerCase().trim() || '';
  if (ext && EXTENSION_MIME_MAP[ext]) {
    return EXTENSION_MIME_MAP[ext];
  }
  return cleanExplicit || 'application/octet-stream';
}

function decodeBase64ToBytes(base64Input: string): Uint8Array<ArrayBuffer> {
  const cleaned = base64Input.replace(/\s+/g, '');
  const binary = atob(cleaned);
  const len = binary.length;
  const buffer = new ArrayBuffer(len);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function dataUrlToBlob(dataUrl: string, fallbackMimeType?: string): Blob {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) {
    const bytes = decodeBase64ToBytes(dataUrl);
    return new Blob([bytes], { type: fallbackMimeType || 'application/octet-stream' });
  }

  const header = dataUrl.slice(0, commaIdx);
  const payload = dataUrl.slice(commaIdx + 1);
  const mimeMatch = header.match(/^data:([^;,]+)/i);
  const parsedMime = mimeMatch?.[1]?.trim();
  const mimeType =
    (parsedMime && parsedMime !== 'application/octet-stream' ? parsedMime : '') ||
    fallbackMimeType ||
    parsedMime ||
    'application/octet-stream';

  if (/;base64/i.test(header)) {
    const bytes = decodeBase64ToBytes(payload);
    return new Blob([bytes], { type: mimeType });
  }

  const decodedText = decodeURIComponent(payload);
  return new Blob([decodedText], { type: mimeType });
}

export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Kompresi canvas ke format image/jpeg kualitas awal 0.65 dengan target ukuran akhir sekitar 80–150 KB (maksimal 150 KB).
 */
export function compressCanvasToJpeg(
  sourceCanvas: HTMLCanvasElement,
  initialQuality = 0.65,
  maxBytes = 150 * 1024
): { dataUrl: string; byteSize: number } {
  let quality = initialQuality;
  let canvas = sourceCanvas;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  let byteSize = estimateDataUrlBytes(dataUrl);

  // Turunkan kualitas secara bertahap bila ukuran masih > maxBytes (150 KB)
  while (byteSize > maxBytes && quality > 0.35) {
    quality = Math.max(0.35, Number((quality - 0.08).toFixed(2)));
    dataUrl = canvas.toDataURL('image/jpeg', quality);
    byteSize = estimateDataUrlBytes(dataUrl);
  }

  // Jika gambar sangat detail dan masih > maxBytes, perkecil dimensi proporsional
  let attempts = 0;
  while (byteSize > maxBytes && attempts < 3 && canvas.width > 420 && canvas.height > 420) {
    attempts++;
    const nextCanvas = document.createElement('canvas');
    nextCanvas.width = Math.round(canvas.width * 0.8);
    nextCanvas.height = Math.round(canvas.height * 0.8);
    const ctx = nextCanvas.getContext('2d');
    if (!ctx) break;
    ctx.drawImage(canvas, 0, 0, nextCanvas.width, nextCanvas.height);
    canvas = nextCanvas;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
    byteSize = estimateDataUrlBytes(dataUrl);
  }

  return { dataUrl, byteSize };
}

/**
 * Kompresi otomatis gambar dari Galeri menggunakan HTML5 <canvas>:
 * - Maksimal lebar/tinggi 800px (proporsional)
 * - Format image/jpeg kualitas 0.65
 * - Target ukuran akhir sekitar 80–150 KB agar pengiriman chunk 8 KB WebRTC sangat stabil & cepat
 */
export function compressImageFile(
  file: Blob,
  maxDimension = 800,
  quality = 0.65,
  maxBytes = 150 * 1024
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Gagal memproses gambar'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width >= height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(String(reader.result));
          return;
        }
        // Fill white background before drawing so transparent PNGs convert cleanly to JPEG
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        const { dataUrl } = compressCanvasToJpeg(canvas, quality, maxBytes);
        resolve(dataUrl);
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export async function toDownloadBlob(
  source: Blob | string,
  fileName?: string,
  explicitMimeType?: string
): Promise<Blob> {
  const targetMime = resolveMimeTypeForFile(fileName, explicitMimeType);

  if (source instanceof Blob) {
    if (!source.type || (source.type === 'application/octet-stream' && targetMime !== 'application/octet-stream')) {
      return new Blob([source], { type: targetMime });
    }
    return source;
  }

  const trimmed = source.trim();
  if (
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://')
  ) {
    const response = await fetch(trimmed);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const fetchedBlob = await response.blob();
    if (
      !fetchedBlob.type ||
      (fetchedBlob.type === 'application/octet-stream' && targetMime !== 'application/octet-stream')
    ) {
      return new Blob([fetchedBlob], { type: targetMime });
    }
    return fetchedBlob;
  }

  return dataUrlToBlob(trimmed, targetMime);
}

export async function triggerDownload(
  source: Blob | string,
  fileName: string,
  mimeType?: string
): Promise<{ ok: boolean; error?: string }> {
  const safeFileName = (fileName || 'file-wattappsau').trim();
  const resolvedMime = resolveMimeTypeForFile(safeFileName, mimeType);

  try {
    const blob = await toDownloadBlob(source, safeFileName, resolvedMime);

    // Jika APK Android WebView menyediakan bridge unduhan native, utamakan bridge tersebut
    if (typeof window !== 'undefined' && typeof window.AndroidBridge?.downloadFile === 'function') {
      try {
        const dataUrl =
          typeof source === 'string' && source.startsWith('data:')
            ? source
            : await fileToDataUrl(blob);
        const handled = window.AndroidBridge.downloadFile(dataUrl, safeFileName, resolvedMime);
        if (handled !== false) {
          return { ok: true };
        }
      } catch (bridgeErr) {
        console.warn('[Download] AndroidBridge.downloadFile fallback ke Blob URL:', bridgeErr);
      }
    }

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = safeFileName;
    link.rel = 'noopener noreferrer';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();

    window.setTimeout(() => {
      if (link.parentNode) {
        link.parentNode.removeChild(link);
      }
      URL.revokeObjectURL(objectUrl);
    }, 5000);

    return { ok: true };
  } catch (err) {
    console.error('[Download] Gagal mengunduh file:', err);
    return {
      ok: false,
      error: 'Berkas rusak atau gagal dikonversi untuk diunduh.',
    };
  }
}
