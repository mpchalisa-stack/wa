import Peer, { DataConnection, MediaConnection } from 'peerjs';
import {
  ChunkMessageMeta,
  ChunkStatusMeta,
  FileChunkPacket,
  PeerConnectionState,
  PeerPacket,
  UserProfile,
} from '../types';
import { dataUrlToBlob, fileToDataUrl } from './media';

export const PEER_PREFIX = 'WA6-';

/**
 * Ukuran potongan chunk Base64/DataURL: 8 KB (8192 karakter) per paket JSON string.
 * Mencegah overflow buffer SCTP/DataChannel WebRTC di perangkat mobile & desktop.
 */
export const FILE_CHUNK_SIZE = 8192;

/** Ambang batas bufferedAmount WebRTC DataChannel (64 KB = 65536 bytes) */
const MAX_BUFFERED_AMOUNT = 65536;

/** Jeda wajib antar-chunk (25 ms) agar browser penerima tidak membuang paket */
const CHUNK_DELAY_MS = 25;

/** Timeout menunggu koneksi DataChannel terbuka sebelum mulai chunking (8 detik) */
const CONNECTION_OPEN_TIMEOUT_MS = 8000;

/** Interval auto-retry jika belum menerima FILE_ACK setelah FILE_END (3 detik) */
const FILE_ACK_RETRY_MS = 3000;

/** Batas maksimal auto-retry FILE_END / missingChunks */
const MAX_ACK_RETRIES = 3;

/**
 * Konfigurasi ICE Servers untuk WebRTC (DataChannel & Panggilan Suara/Video).
 * Menggunakan server STUN publik Google secara default.
 *
 * Untuk menembus jaringan seluler 4G/5G dengan Symmetric NAT atau firewall ketat,
 * tambahkan server TURN (misal: Coturn, Metered.ca, Twilio, atau Cloudflare TURN)
 * di bawah komentar berikut:
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  /*
  // CONTOH KONFIGURASI TURN SERVER (hapus komentar & isi kredensial Anda):
  {
    urls: [
      'turn:standard.relay.metered.ca:80',
      'turn:standard.relay.metered.ca:443',
      'turns:standard.relay.metered.ca:443?transport=tcp'
    ],
    username: 'YOUR_TURN_USERNAME',
    credential: 'YOUR_TURN_PASSWORD',
  },
  */
];

export interface ReassembledFileTransfer {
  fileId: string;
  messageId?: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  dataUrl: string;
  blob: Blob;
  messageMeta?: ChunkMessageMeta;
  statusMeta?: ChunkStatusMeta;
}

export interface SendFileChunkedOptions {
  fileId: string;
  messageId?: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  dataUrl: string;
  messageMeta?: ChunkMessageMeta;
  statusMeta?: ChunkStatusMeta;
  onProgress?: (percent: number) => void;
  onQueued?: () => void;
  onComplete?: () => void;
  onAck?: (messageId?: string) => void;
  onError?: () => void;
}

interface IncomingFileBuffer {
  fileId: string;
  messageId?: string;
  fromId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  totalChunks: number;
  chunks: Map<number, string>;
  messageMeta?: ChunkMessageMeta;
  statusMeta?: ChunkStatusMeta;
  startedAt: number;
  finalized: boolean;
}

interface PendingAckTransfer {
  fileId: string;
  messageId?: string;
  targetSixDigitId: string;
  options: SendFileChunkedOptions;
  payload: string;
  totalChunks: number;
  retryCount: number;
  retryTimer: number | null;
  lastMissingChunks: number[];
  retrying: boolean;
}

export interface PeerManagerCallbacks {
  onStatusChange: (state: PeerConnectionState, errorMessage?: string) => void;
  onPacket: (fromSixDigitId: string, packet: PeerPacket) => void;
  onFileReceived: (
    fromSixDigitId: string,
    file: ReassembledFileTransfer
  ) => void | Promise<void>;
  onFileAck?: (fromSixDigitId: string, fileId: string, messageId?: string) => void;
  onPeerPresence: (sixDigitId: string, isOnline: boolean) => void;
  onPeerReady?: (sixDigitId: string) => void;
  onIncomingMediaCall: (call: MediaConnection) => void;
}

export function toFullPeerId(sixDigitId: string): string {
  const clean = sixDigitId.replace(/^WA6-/, '');
  return `${PEER_PREFIX}${clean}`;
}

export function fromFullPeerId(fullId: string): string {
  return fullId.replace(/^WA6-/, '');
}

function getDataChannel(conn?: DataConnection | null): RTCDataChannel | undefined {
  if (!conn) return undefined;
  return (conn as unknown as { dataChannel?: RTCDataChannel }).dataChannel;
}

function isConnectionLive(conn?: DataConnection | null): boolean {
  if (!conn || !conn.open) return false;
  const dc = getDataChannel(conn);
  if (dc && dc.readyState !== 'open') return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function waitForDataChannelDrain(conn: DataConnection): Promise<void> {
  return new Promise((resolve) => {
    const dc = getDataChannel(conn);
    if (!dc || dc.readyState !== 'open' || dc.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
      resolve();
      return;
    }

    const lowTarget = Math.floor(MAX_BUFFERED_AMOUNT / 2); // 32768 bytes
    let settled = false;
    let pollTimer: number | null = null;

    const done = () => {
      if (settled) return;
      settled = true;
      try {
        dc.removeEventListener('bufferedamountlow', onLow);
      } catch {
        // ignore
      }
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      window.clearTimeout(safetyTimer);
      resolve();
    };

    const onLow = () => {
      if (dc.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
        done();
      }
    };

    try {
      dc.bufferedAmountLowThreshold = lowTarget;
      dc.addEventListener('bufferedamountlow', onLow);
    } catch {
      // Fallback ke polling timer di bawah
    }

    const poll = () => {
      if (settled) return;
      if (!conn.open || dc.readyState !== 'open' || dc.bufferedAmount <= lowTarget) {
        done();
      } else {
        pollTimer = window.setTimeout(poll, 20);
      }
    };

    pollTimer = window.setTimeout(poll, 20);
    // Safety timeout agar tidak pernah deadlock jika browser gagal memicu event
    const safetyTimer = window.setTimeout(done, 4000);
  });
}

function parseIncomingData(rawData: unknown): unknown {
  if (typeof rawData === 'string') {
    try {
      return JSON.parse(rawData);
    } catch {
      return null;
    }
  }
  if (rawData instanceof ArrayBuffer) {
    try {
      const decoded = new TextDecoder().decode(new Uint8Array(rawData));
      return JSON.parse(decoded);
    } catch {
      return null;
    }
  }
  if (rawData instanceof Uint8Array) {
    try {
      const decoded = new TextDecoder().decode(rawData);
      return JSON.parse(decoded);
    } catch {
      return null;
    }
  }
  if (rawData && typeof rawData === 'object') {
    return rawData;
  }
  return null;
}

function isFileChunkPacket(data: unknown): data is FileChunkPacket {
  if (!data || typeof data !== 'object' || !('type' in data)) return false;
  const t = (data as { type?: string }).type;
  return (
    t === 'FILE_START' ||
    t === 'FILE_CHUNK' ||
    t === 'FILE_END' ||
    t === 'FILE_ACK' ||
    t === 'FILE_MISSING_CHUNKS'
  );
}

export class WA6PeerManager {
  private peer: Peer | null = null;
  private profile: UserProfile;
  private callbacks: PeerManagerCallbacks;
  private connections = new Map<string, DataConnection>();
  private openWaiters = new Map<string, Array<(conn: DataConnection) => void>>();
  private pendingQueues = new Map<string, PeerPacket[]>();
  private pendingFileTransfers = new Map<string, SendFileChunkedOptions[]>();
  private activeFileSendChain = new Map<string, Promise<void>>();
  private incomingFileBuffers = new Map<string, IncomingFileBuffer>();
  private completedReceivedFiles = new Map<string, string>(); // fileId -> messageId
  private awaitingFileAcks = new Map<string, PendingAckTransfer>();
  private reconnectTimer: number | null = null;
  private destroyed = false;

  constructor(profile: UserProfile, callbacks: PeerManagerCallbacks) {
    this.profile = profile;
    this.callbacks = callbacks;

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  private handleVisibilityChange = (): void => {
    if (this.destroyed) return;
    if (document.visibilityState === 'visible') {
      // Saat kembali dari file picker / kamera Android, segera pulihkan broker PeerJS bila sempat terputus
      if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
        try {
          this.peer.reconnect();
        } catch {
          this.connect();
        }
      } else if (!this.peer || this.peer.destroyed) {
        this.connect();
      }
    }
  };

  public updateProfile(profile: UserProfile): void {
    this.profile = profile;
    const hello: PeerPacket = {
      kind: 'HELLO',
      profile: {
        id: profile.id,
        name: profile.name,
        bio: profile.bio,
        avatar: profile.avatar,
      },
    };
    this.connections.forEach((conn) => {
      if (isConnectionLive(conn)) {
        try {
          conn.send(hello);
        } catch {
          // ignore
        }
      }
    });
  }

  public connect(): void {
    if (this.destroyed) return;
    this.cleanupPeer();
    this.callbacks.onStatusChange('connecting');

    const fullId = toFullPeerId(this.profile.id);
    const peer = new Peer(fullId, {
      debug: 0,
      config: {
        iceServers: ICE_SERVERS,
      },
    });

    this.peer = peer;

    peer.on('open', () => {
      if (this.destroyed) return;
      this.callbacks.onStatusChange('online');
    });

    peer.on('connection', (conn) => {
      this.attachConnection(conn);
    });

    peer.on('call', (mediaCall) => {
      this.callbacks.onIncomingMediaCall(mediaCall);
    });

    peer.on('disconnected', () => {
      if (this.destroyed) return;
      this.callbacks.onStatusChange('connecting');
      this.scheduleReconnect();
    });

    peer.on('close', () => {
      if (this.destroyed) return;
      this.callbacks.onStatusChange('disconnected');
    });

    peer.on('error', (err) => {
      if (this.destroyed) return;
      const errType = (err as { type?: string }).type || '';
      if (errType === 'peer-unavailable') {
        const match = err.message?.match(/WA6-(\d{6})/);
        if (match && match[1]) {
          this.callbacks.onPeerPresence(match[1], false);
        }
        return;
      }
      if (errType === 'unavailable-id') {
        this.callbacks.onStatusChange(
          'error',
          'ID 6 digit sedang aktif di tab/perangkat lain.'
        );
        return;
      }
      if (errType === 'network' || errType === 'server-error' || errType === 'socket-error') {
        this.callbacks.onStatusChange('disconnected', 'Koneksi ke server PeerJS terputus.');
        this.scheduleReconnect();
        return;
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed) return;
      if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
        try {
          this.peer.reconnect();
        } catch {
          this.connect();
        }
      } else if (!this.peer || this.peer.destroyed) {
        this.connect();
      }
    }, 3000);
  }

  private waitForPeerOpen(timeoutMs = 3500): Promise<boolean> {
    if (this.destroyed) return Promise.resolve(false);
    if (this.peer && !this.peer.destroyed && this.peer.open && !this.peer.disconnected) {
      return Promise.resolve(true);
    }

    if (!this.peer || this.peer.destroyed) {
      this.connect();
    } else if (this.peer.disconnected) {
      try {
        this.peer.reconnect();
      } catch {
        this.connect();
      }
    }

    const peer = this.peer;
    if (!peer) return Promise.resolve(false);
    if (peer.open && !peer.disconnected) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        peer.off('open', onOpen);
        resolve(ok);
      };
      const onOpen = () => finish(true);
      const timer = window.setTimeout(() => {
        finish(Boolean(this.peer && !this.peer.destroyed && this.peer.open));
      }, timeoutMs);
      peer.on('open', onOpen);
    });
  }

  /**
   * Pastikan koneksi DataChannel WebRTC aktif & terbuka sebelum mengirim chunk file.
   * Jika conn belum ada atau !conn.open, panggil peer.connect('WA6-' + targetId, { reliable: true })
   * dan tunggu event conn.on('open') hingga timeout 8 detik.
   */
  public async ensureOpenConnection(
    targetSixDigitId: string,
    timeoutMs = CONNECTION_OPEN_TIMEOUT_MS
  ): Promise<DataConnection | null> {
    if (this.destroyed || targetSixDigitId === this.profile.id) return null;

    const existing = this.connections.get(targetSixDigitId);
    if (existing && isConnectionLive(existing)) {
      return existing;
    }

    // Pastikan koneksi signaling PeerJS lokal siap (penting setelah kembali dari file picker Android)
    const peerReady = await this.waitForPeerOpen(3500);
    if (!peerReady || !this.peer || this.peer.destroyed) {
      return null;
    }

    // Cek lagi siapa tahu peer tujuan baru saja terhubung masuk saat kita menunggu signaling
    const refreshed = this.connections.get(targetSixDigitId);
    if (refreshed && isConnectionLive(refreshed)) {
      return refreshed;
    }

    // Jika ada koneksi lama yang macet/tidak terbuka, tutup bersih agar tidak bentrok
    if (refreshed && !refreshed.open) {
      try {
        refreshed.close();
      } catch {
        // ignore
      }
      if (this.connections.get(targetSixDigitId) === refreshed) {
        this.connections.delete(targetSixDigitId);
      }
    }

    let conn: DataConnection;
    try {
      conn = this.peer.connect(toFullPeerId(targetSixDigitId), {
        reliable: true,
      });
      this.attachConnection(conn);
    } catch {
      return null;
    }

    if (isConnectionLive(conn)) {
      return conn;
    }

    return new Promise<DataConnection | null>((resolve) => {
      let settled = false;

      const finish = (openedConn: DataConnection | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        conn.off('open', onConnOpen);
        conn.off('error', onConnFail);
        conn.off('close', onConnFail);
        const list = this.openWaiters.get(targetSixDigitId);
        if (list) {
          const filtered = list.filter((fn) => fn !== onAnyOpen);
          if (filtered.length > 0) {
            this.openWaiters.set(targetSixDigitId, filtered);
          } else {
            this.openWaiters.delete(targetSixDigitId);
          }
        }
        resolve(openedConn);
      };

      const onConnOpen = () => finish(conn);
      const onAnyOpen = (liveConn: DataConnection) => finish(liveConn);
      const onConnFail = () => {
        // Jangan langsung menyerah bila ternyata ada koneksi masuk lain yang sedang terbuka
        const alt = this.connections.get(targetSixDigitId);
        if (alt && alt !== conn && isConnectionLive(alt)) {
          finish(alt);
        }
      };

      const waiters = this.openWaiters.get(targetSixDigitId) || [];
      waiters.push(onAnyOpen);
      this.openWaiters.set(targetSixDigitId, waiters);

      conn.on('open', onConnOpen);
      conn.on('error', onConnFail);
      conn.on('close', onConnFail);

      const timer = window.setTimeout(() => {
        const latest = this.connections.get(targetSixDigitId);
        if (latest && isConnectionLive(latest)) {
          finish(latest);
        } else {
          finish(null);
        }
      }, timeoutMs);
    });
  }

  private sendFilePacketJson(conn: DataConnection, packet: FileChunkPacket): void {
    conn.send(JSON.stringify(packet));
  }

  private async sendReplyFilePacket(
    targetSixDigitId: string,
    packet: FileChunkPacket,
    preferredConn?: DataConnection
  ): Promise<void> {
    if (preferredConn && isConnectionLive(preferredConn)) {
      try {
        this.sendFilePacketJson(preferredConn, packet);
        return;
      } catch {
        // Fallback ke koneksi aktif di map
      }
    }

    const current = this.connections.get(targetSixDigitId);
    if (current && isConnectionLive(current)) {
      try {
        this.sendFilePacketJson(current, packet);
        return;
      } catch {
        // Fallback buka koneksi baru
      }
    }

    const reopened = await this.ensureOpenConnection(targetSixDigitId, 5000);
    if (reopened && isConnectionLive(reopened)) {
      try {
        this.sendFilePacketJson(reopened, packet);
      } catch {
        // ignore
      }
    }
  }

  private rememberCompletedFile(fileId: string, messageId?: string): void {
    this.completedReceivedFiles.set(fileId, messageId || '');
    if (this.completedReceivedFiles.size > 200) {
      const oldestKey = this.completedReceivedFiles.keys().next().value;
      if (oldestKey) this.completedReceivedFiles.delete(oldestKey);
    }
  }

  private async finalizeIncomingFile(
    fromSixDigitId: string,
    buf: IncomingFileBuffer,
    replyConn: DataConnection
  ): Promise<void> {
    if (buf.finalized) return;
    buf.finalized = true;

    const orderedParts: string[] = new Array(buf.totalChunks);
    for (let i = 0; i < buf.totalChunks; i++) {
      orderedParts[i] = buf.chunks.get(i) ?? '';
    }
    const combinedRaw = orderedParts.join('');

    let blob: Blob;
    try {
      blob = dataUrlToBlob(combinedRaw);
    } catch {
      blob = new Blob([combinedRaw], { type: buf.fileType || 'application/octet-stream' });
    }

    const finalDataUrl = combinedRaw.startsWith('data:')
      ? combinedRaw
      : await fileToDataUrl(blob);

    const resolvedMessageId = buf.messageId || buf.messageMeta?.id;
    this.rememberCompletedFile(buf.fileId, resolvedMessageId);
    this.incomingFileBuffers.delete(buf.fileId);

    // Tampilkan di chat penerima & simpan ke IndexedDB terlebih dahulu
    try {
      await this.callbacks.onFileReceived(fromSixDigitId, {
        fileId: buf.fileId,
        messageId: resolvedMessageId,
        fileName: buf.fileName,
        fileType: buf.fileType,
        fileSize: buf.fileSize || blob.size,
        dataUrl: finalDataUrl,
        blob,
        messageMeta: buf.messageMeta,
        statusMeta: buf.statusMeta,
      });
    } catch (err) {
      console.error('Error handling reassembled file:', err);
    }

    // Langsung kirim balik konfirmasi FILE_ACK (JSON string) ke pengirim
    await this.sendReplyFilePacket(
      fromSixDigitId,
      {
        type: 'FILE_ACK',
        fileId: buf.fileId,
        messageId: resolvedMessageId,
      },
      replyConn
    );
  }

  private handleFileChunkPacket(
    fromSixDigitId: string,
    packet: FileChunkPacket,
    sourceConn: DataConnection
  ): void {
    if (packet.type === 'FILE_START') {
      const resolvedMessageId = packet.messageId || packet.messageMeta?.id;
      // Jika file ini sebelumnya sudah selesai diterima (pengirim retry), balas FILE_ACK langsung
      if (this.completedReceivedFiles.has(packet.fileId)) {
        void this.sendReplyFilePacket(
          fromSixDigitId,
          {
            type: 'FILE_ACK',
            fileId: packet.fileId,
            messageId: resolvedMessageId || this.completedReceivedFiles.get(packet.fileId) || undefined,
          },
          sourceConn
        );
        return;
      }

      const total = Math.max(1, packet.totalChunks);
      const existingBuf = this.incomingFileBuffers.get(packet.fileId);
      if (existingBuf && existingBuf.totalChunks === total && !existingBuf.finalized) {
        // Pertahankan chunk yang sudah terkumpul agar retry jauh lebih cepat
        existingBuf.messageId = resolvedMessageId || existingBuf.messageId;
        existingBuf.messageMeta = packet.messageMeta || existingBuf.messageMeta;
        existingBuf.statusMeta = packet.statusMeta || existingBuf.statusMeta;
        return;
      }

      this.incomingFileBuffers.set(packet.fileId, {
        fileId: packet.fileId,
        messageId: resolvedMessageId,
        fromId: fromSixDigitId,
        fileName: packet.fileName,
        fileType: packet.fileType,
        fileSize: packet.fileSize,
        totalChunks: total,
        chunks: new Map<number, string>(),
        messageMeta: packet.messageMeta,
        statusMeta: packet.statusMeta,
        startedAt: Date.now(),
        finalized: false,
      });
      return;
    }

    if (packet.type === 'FILE_CHUNK') {
      const buf = this.incomingFileBuffers.get(packet.fileId);
      if (!buf || buf.finalized) return;
      if (packet.chunkIndex >= 0 && packet.chunkIndex < buf.totalChunks) {
        buf.chunks.set(packet.chunkIndex, packet.data);
        // Segera gabungkan & kirim FILE_ACK bila seluruh index chunk sudah lengkap
        if (buf.chunks.size >= buf.totalChunks) {
          void this.finalizeIncomingFile(fromSixDigitId, buf, sourceConn);
        }
      }
      return;
    }

    if (packet.type === 'FILE_END') {
      // Jika sudah selesai sebelumnya, segera balas FILE_ACK ulang
      if (this.completedReceivedFiles.has(packet.fileId)) {
        void this.sendReplyFilePacket(
          fromSixDigitId,
          {
            type: 'FILE_ACK',
            fileId: packet.fileId,
            messageId:
              packet.messageId ||
              this.completedReceivedFiles.get(packet.fileId) ||
              undefined,
          },
          sourceConn
        );
        return;
      }

      const buf = this.incomingFileBuffers.get(packet.fileId);
      if (!buf) {
        // FILE_START belum pernah diterima: minta pengirim mengirim ulang dari awal (sentinel -1)
        void this.sendReplyFilePacket(
          fromSixDigitId,
          {
            type: 'FILE_MISSING_CHUNKS',
            fileId: packet.fileId,
            messageId: packet.messageId,
            missingChunks: [-1],
          },
          sourceConn
        );
        return;
      }

      if (buf.finalized) return;

      const missingChunks: number[] = [];
      for (let i = 0; i < buf.totalChunks; i++) {
        if (!buf.chunks.has(i)) {
          missingChunks.push(i);
        }
      }

      if (missingChunks.length === 0) {
        void this.finalizeIncomingFile(fromSixDigitId, buf, sourceConn);
      } else {
        // Jangan hapus buffer! Laporkan daftar chunk yang hilang agar pengirim langsung kirim ulang
        void this.sendReplyFilePacket(
          fromSixDigitId,
          {
            type: 'FILE_MISSING_CHUNKS',
            fileId: buf.fileId,
            messageId: buf.messageId || packet.messageId,
            missingChunks,
          },
          sourceConn
        );
      }
      return;
    }

    if (packet.type === 'FILE_ACK') {
      this.handleIncomingFileAck(fromSixDigitId, packet.fileId, packet.messageId);
      return;
    }

    if (packet.type === 'FILE_MISSING_CHUNKS') {
      this.handleIncomingMissingChunks(packet.fileId, packet.missingChunks);
    }
  }

  private handleIncomingFileAck(
    fromSixDigitId: string,
    fileId: string,
    messageId?: string
  ): void {
    let entry = this.awaitingFileAcks.get(fileId);
    if (!entry && messageId) {
      for (const candidate of this.awaitingFileAcks.values()) {
        if (candidate.messageId === messageId && candidate.targetSixDigitId === fromSixDigitId) {
          entry = candidate;
          break;
        }
      }
    }

    if (entry) {
      if (entry.retryTimer !== null) {
        window.clearTimeout(entry.retryTimer);
      }
      this.awaitingFileAcks.delete(entry.fileId);
      entry.options.onAck?.(messageId || entry.messageId);
    }

    this.callbacks.onFileAck?.(fromSixDigitId, fileId, messageId || entry?.messageId);
  }

  private handleIncomingMissingChunks(fileId: string, missingChunks: number[]): void {
    const entry = this.awaitingFileAcks.get(fileId);
    if (!entry || entry.retrying) return;
    if (entry.retryTimer !== null) {
      window.clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    entry.lastMissingChunks = missingChunks;
    this.enqueueAckRetry(fileId, missingChunks);
  }

  private scheduleFileAckRetry(fileId: string): void {
    const entry = this.awaitingFileAcks.get(fileId);
    if (!entry || this.destroyed) return;
    if (entry.retryTimer !== null) {
      window.clearTimeout(entry.retryTimer);
    }

    entry.retryTimer = window.setTimeout(() => {
      entry.retryTimer = null;
      if (this.destroyed || !this.awaitingFileAcks.has(fileId)) return;
      if (entry.retrying) return;

      entry.retryCount += 1;
      if (entry.retryCount > MAX_ACK_RETRIES) {
        this.awaitingFileAcks.delete(fileId);
        // Jika peer sedang terputus, masukkan ke antrean agar terkirim ulang saat online kembali
        if (!this.isPeerOnline(entry.targetSixDigitId)) {
          this.requeuePendingTransfer(entry.targetSixDigitId, entry.options);
        }
        return;
      }

      this.enqueueAckRetry(fileId, entry.lastMissingChunks);
    }, FILE_ACK_RETRY_MS);
  }

  private enqueueAckRetry(fileId: string, missingChunks: number[]): void {
    const entry = this.awaitingFileAcks.get(fileId);
    if (!entry || this.destroyed) return;

    const prevChain = this.activeFileSendChain.get(entry.targetSixDigitId) ?? Promise.resolve();
    const nextChain = prevChain
      .catch(() => {})
      .then(() => this.performAckRetry(fileId, missingChunks));
    this.activeFileSendChain.set(entry.targetSixDigitId, nextChain);
  }

  private async performAckRetry(fileId: string, missingChunks: number[]): Promise<void> {
    const entry = this.awaitingFileAcks.get(fileId);
    if (!entry || this.destroyed) return;
    entry.retrying = true;

    try {
      const conn = await this.ensureOpenConnection(
        entry.targetSixDigitId,
        CONNECTION_OPEN_TIMEOUT_MS
      );
      if (!conn) {
        // Peer belum tersedia: antrekan agar otomatis dikirim ulang saat tersambung
        this.awaitingFileAcks.delete(fileId);
        this.requeuePendingTransfer(entry.targetSixDigitId, entry.options);
        return;
      }

      // Cek apakah selama kita menunggu koneksi, FILE_ACK sudah keburu tiba
      if (!this.awaitingFileAcks.has(fileId)) return;

      const needsFullResend =
        missingChunks.includes(-1) ||
        (entry.retryCount === 2 && missingChunks.length === 0);

      if (needsFullResend) {
        // Kirim ulang FILE_START + seluruh chunk (jika penerima kehilangan FILE_START)
        const startPacket: FileChunkPacket = {
          type: 'FILE_START',
          fileId: entry.fileId,
          messageId: entry.messageId,
          fileName: entry.options.fileName,
          fileType: entry.options.fileType,
          fileSize: entry.options.fileSize,
          totalChunks: entry.totalChunks,
          messageMeta: entry.options.messageMeta,
          statusMeta: entry.options.statusMeta,
        };
        this.sendFilePacketJson(conn, startPacket);
        await sleep(CHUNK_DELAY_MS);

        const allIndices = Array.from({ length: entry.totalChunks }, (_, idx) => idx);
        await this.sendChunkIndices(conn, entry.fileId, entry.payload, allIndices);
      } else if (missingChunks.length > 0) {
        // Kirim ulang hanya chunk yang hilang sesuai laporan penerima
        const validMissing = missingChunks.filter(
          (idx) => idx >= 0 && idx < entry.totalChunks
        );
        if (validMissing.length > 0) {
          await this.sendChunkIndices(conn, entry.fileId, entry.payload, validMissing);
        }
      }

      if (!this.awaitingFileAcks.has(fileId)) return;

      // Kirim ulang sinyal FILE_END beserta info missingChunks
      await waitForDataChannelDrain(conn);
      const endPacket: FileChunkPacket = {
        type: 'FILE_END',
        fileId: entry.fileId,
        messageId: entry.messageId,
        missingChunks: missingChunks.filter((idx) => idx >= 0),
      };
      this.sendFilePacketJson(conn, endPacket);
    } catch (err) {
      console.warn('Auto-retry FILE_END error:', err);
    } finally {
      if (this.awaitingFileAcks.has(fileId)) {
        entry.retrying = false;
        this.scheduleFileAckRetry(fileId);
      }
    }
  }

  private async sendChunkIndices(
    conn: DataConnection,
    fileId: string,
    payload: string,
    indices: number[],
    onProgress?: (pct: number) => void
  ): Promise<void> {
    let lastReportedPct = 1;
    for (let i = 0; i < indices.length; i++) {
      if (this.destroyed || !isConnectionLive(conn)) {
        throw new Error('DataChannel terputus saat mengirim potongan file');
      }

      // Flow control: tunggu jika bufferedAmount > 65536 bytes
      const dc = getDataChannel(conn);
      if (dc && dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        await waitForDataChannelDrain(conn);
      }

      const chunkIndex = indices[i];
      const start = chunkIndex * FILE_CHUNK_SIZE;
      const data = payload.slice(start, start + FILE_CHUNK_SIZE);

      const chunkPacket: FileChunkPacket = {
        type: 'FILE_CHUNK',
        fileId,
        chunkIndex,
        data,
      };
      this.sendFilePacketJson(conn, chunkPacket);

      if (onProgress) {
        const pct = Math.min(99, Math.max(1, Math.round(((i + 1) / indices.length) * 100)));
        if (pct !== lastReportedPct) {
          lastReportedPct = pct;
          onProgress(pct);
        }
      }

      // Jeda wajib 25 ms antar-chunk untuk mencegah buffer overflow di browser penerima
      await sleep(CHUNK_DELAY_MS);
    }
  }

  private attachConnection(conn: DataConnection): void {
    const peerSixId = fromFullPeerId(conn.peer);

    // Jangan timpa koneksi lain yang sudah aktif sebelum koneksi baru ini benar-benar terbuka
    const existing = this.connections.get(peerSixId);
    if (!isConnectionLive(existing)) {
      this.connections.set(peerSixId, conn);
    }

    const onOpen = () => {
      this.connections.set(peerSixId, conn);
      this.callbacks.onPeerPresence(peerSixId, true);

      // Selesaikan semua waiter yang sedang menunggu ensureOpenConnection()
      const waiters = this.openWaiters.get(peerSixId);
      if (waiters && waiters.length > 0) {
        this.openWaiters.delete(peerSixId);
        waiters.forEach((resolveFn) => resolveFn(conn));
      }

      // Kirim handshake HELLO berisi profil kita
      try {
        conn.send({
          kind: 'HELLO',
          profile: {
            id: this.profile.id,
            name: this.profile.name,
            bio: this.profile.bio,
            avatar: this.profile.avatar,
          },
        } satisfies PeerPacket);
      } catch {
        // ignore
      }

      // Kirim antrean paket teks/sinyal reguler
      const queued = this.pendingQueues.get(peerSixId);
      if (queued && queued.length > 0) {
        this.pendingQueues.delete(peerSixId);
        for (const pkt of queued) {
          try {
            conn.send(pkt);
          } catch {
            // ignore
          }
        }
      }

      // Kirim antrean transfer file yang tertunda secara berurutan
      const queuedFiles = this.pendingFileTransfers.get(peerSixId);
      if (queuedFiles && queuedFiles.length > 0) {
        this.pendingFileTransfers.delete(peerSixId);
        for (const transfer of queuedFiles) {
          this.enqueueChunkedSend(peerSixId, transfer, true);
        }
      }

      // Beri tahu aplikasi agar segera menguras antrean pendingMessages untuk peer ini
      this.callbacks.onPeerReady?.(peerSixId);
    };

    if (isConnectionLive(conn)) {
      onOpen();
    } else {
      conn.on('open', onOpen);
    }

    conn.on('data', (rawData) => {
      const data = parseIncomingData(rawData);
      if (!data || typeof data !== 'object') return;

      // Pastikan koneksi pengirim tercatat aktif
      if (isConnectionLive(conn) && this.connections.get(peerSixId) !== conn) {
        this.connections.set(peerSixId, conn);
      }

      // Handle paket chunking & ACK file WebRTC (JSON string / object)
      if (isFileChunkPacket(data)) {
        this.callbacks.onPeerPresence(peerSixId, true);
        this.handleFileChunkPacket(peerSixId, data, conn);
        return;
      }

      // Handle paket signaling, PING/PONG keep-alive & pesan teks reguler
      if ('kind' in data) {
        const pkt = data as PeerPacket;
        this.callbacks.onPeerPresence(peerSixId, true);

        if (pkt.kind === 'PING') {
          try {
            conn.send({
              kind: 'PONG',
              fromId: this.profile.id,
              ts: Date.now(),
            } satisfies PeerPacket);
          } catch {
            // ignore
          }
          this.callbacks.onPeerReady?.(peerSixId);
          return;
        }

        if (pkt.kind === 'PONG') {
          this.callbacks.onPeerReady?.(peerSixId);
          return;
        }

        this.callbacks.onPacket(peerSixId, pkt);
      }
    });

    conn.on('close', () => {
      if (this.connections.get(peerSixId) === conn) {
        this.connections.delete(peerSixId);
        this.callbacks.onPeerPresence(peerSixId, false);
      }
    });

    conn.on('error', () => {
      if (this.connections.get(peerSixId) === conn) {
        this.connections.delete(peerSixId);
        this.callbacks.onPeerPresence(peerSixId, false);
      }
    });
  }

  public ensureConnection(targetSixDigitId: string): DataConnection | null {
    if (!this.peer || this.peer.destroyed || !this.peer.open) return null;
    if (targetSixDigitId === this.profile.id) return null;

    const existing = this.connections.get(targetSixDigitId);
    if (existing && isConnectionLive(existing)) {
      return existing;
    }

    try {
      const conn = this.peer.connect(toFullPeerId(targetSixDigitId), {
        reliable: true,
      });
      this.attachConnection(conn);
      return conn;
    } catch {
      return null;
    }
  }

  public sendPacket(targetSixDigitId: string, packet: PeerPacket): boolean {
    if (targetSixDigitId === this.profile.id) return false;
    const existing = this.connections.get(targetSixDigitId);

    if (existing && isConnectionLive(existing)) {
      try {
        existing.send(packet);
        return true;
      } catch {
        // Fall through to reconnect & queue
      }
    }

    if (packet.kind !== 'TYPING') {
      const queue = this.pendingQueues.get(targetSixDigitId) || [];
      if (queue.length < 40) {
        queue.push(packet);
        this.pendingQueues.set(targetSixDigitId, queue);
      }
    }

    this.ensureConnection(targetSixDigitId);
    return false;
  }

  private requeuePendingTransfer(
    targetSixDigitId: string,
    options: SendFileChunkedOptions
  ): void {
    const queue = this.pendingFileTransfers.get(targetSixDigitId) || [];
    if (!queue.some((q) => q.fileId === options.fileId) && queue.length < 15) {
      queue.push(options);
      this.pendingFileTransfers.set(targetSixDigitId, queue);
    }
    options.onQueued?.();
  }

  /**
   * Mengirim sinyal PING ke peer bila koneksi terbuka, atau mencoba menghubungkan ulang bila belum terbuka.
   * Mengembalikan true jika koneksi sedang aktif terbuka.
   */
  public pingPeer(targetSixDigitId: string): boolean {
    if (this.destroyed || targetSixDigitId === this.profile.id) return false;
    const existing = this.connections.get(targetSixDigitId);
    if (existing && isConnectionLive(existing)) {
      try {
        existing.send({
          kind: 'PING',
          fromId: this.profile.id,
          ts: Date.now(),
        } satisfies PeerPacket);
        return true;
      } catch {
        // Koneksi rusak — bersihkan dan coba sambung ulang
        try {
          existing.close();
        } catch {
          // ignore
        }
        this.connections.delete(targetSixDigitId);
        this.callbacks.onPeerPresence(targetSixDigitId, false);
      }
    }

    if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
      try {
        this.peer.reconnect();
      } catch {
        this.connect();
      }
    } else if (!this.peer || this.peer.destroyed) {
      this.connect();
    }

    this.ensureConnection(targetSixDigitId);
    return false;
  }

  /**
   * Mengirim gambar, foto kamera, video, dokumen, atau voice note dengan:
   * 1. Memastikan DataChannel aktif/terbuka (reconnect + await conn.on('open') maks 8 detik)
   * 2. Memecah Base64/DataURL menjadi potongan 8 KB (8192 karakter) dalam JSON.stringify(...)
   * 3. Flow control bufferedAmount > 65536 + jeda wajib 25 ms antar-chunk
   * 4. Konfirmasi FILE_ACK dari penerima + auto-retry 3 detik bila belum ada ACK
   */
  public sendFileChunked(targetSixDigitId: string, options: SendFileChunkedOptions): boolean {
    if (targetSixDigitId === this.profile.id) return false;
    // Langsung masuk antrean eksekusi async agar ensureOpenConnection (timeout 8 detik) berjalan dulu
    void this.enqueueChunkedSend(targetSixDigitId, options, true);
    return this.isPeerOnline(targetSixDigitId);
  }

  /**
   * Versi Promise/async untuk menguras antrean outbox secara berurutan (1 file selesai baru lanjut berikutnya).
   */
  public sendFileChunkedAsync(
    targetSixDigitId: string,
    options: SendFileChunkedOptions,
    requeueOnFail = false
  ): Promise<boolean> {
    if (targetSixDigitId === this.profile.id) return Promise.resolve(false);
    return this.enqueueChunkedSend(targetSixDigitId, options, requeueOnFail);
  }

  private enqueueChunkedSend(
    targetSixDigitId: string,
    options: SendFileChunkedOptions,
    requeueOnFail: boolean
  ): Promise<boolean> {
    const prevChain = this.activeFileSendChain.get(targetSixDigitId) ?? Promise.resolve();
    let resultPromise!: Promise<boolean>;
    resultPromise = prevChain
      .catch(() => {})
      .then(() => this.streamChunksOverConnection(targetSixDigitId, options, requeueOnFail));
    this.activeFileSendChain.set(
      targetSixDigitId,
      resultPromise.then(() => undefined, () => undefined)
    );
    return resultPromise;
  }

  private async streamChunksOverConnection(
    targetSixDigitId: string,
    options: SendFileChunkedOptions,
    requeueOnFail: boolean
  ): Promise<boolean> {
    // 1. Wajib pastikan koneksi aktif sebelum mulai chunking (anti-stuck 0% setelah kembali dari file picker Android)
    const conn = await this.ensureOpenConnection(
      targetSixDigitId,
      CONNECTION_OPEN_TIMEOUT_MS
    );
    if (!conn || !isConnectionLive(conn)) {
      if (requeueOnFail) {
        this.requeuePendingTransfer(targetSixDigitId, options);
      } else {
        options.onQueued?.();
      }
      return false;
    }

    const payload = options.dataUrl;
    const totalChunks = Math.max(1, Math.ceil(payload.length / FILE_CHUNK_SIZE));
    const resolvedMessageId = options.messageId || options.messageMeta?.id;

    try {
      // 2. Paket awal: FILE_START (JSON.stringify)
      const startPacket: FileChunkPacket = {
        type: 'FILE_START',
        fileId: options.fileId,
        messageId: resolvedMessageId,
        fileName: options.fileName,
        fileType: options.fileType,
        fileSize: options.fileSize,
        totalChunks,
        messageMeta: options.messageMeta,
        statusMeta: options.statusMeta,
      };
      this.sendFilePacketJson(conn, startPacket);
      options.onProgress?.(1);
      await sleep(CHUNK_DELAY_MS);

      // 3. Paket potongan: FILE_CHUNK (8192 karakter per paket, jeda 25ms + cek bufferedAmount > 65536)
      const allIndices = Array.from({ length: totalChunks }, (_, idx) => idx);
      await this.sendChunkIndices(conn, options.fileId, payload, allIndices, options.onProgress);

      // 4. Paket selesai: FILE_END (JSON.stringify)
      await waitForDataChannelDrain(conn);
      const endPacket: FileChunkPacket = {
        type: 'FILE_END',
        fileId: options.fileId,
        messageId: resolvedMessageId,
      };
      this.sendFilePacketJson(conn, endPacket);
      options.onProgress?.(100);
      options.onComplete?.();

      // 5. Daftarkan pelacakan FILE_ACK dengan auto-retry 3 detik
      const existingPending = this.awaitingFileAcks.get(options.fileId);
      if (existingPending?.retryTimer !== null && existingPending?.retryTimer !== undefined) {
        window.clearTimeout(existingPending.retryTimer);
      }

      this.awaitingFileAcks.set(options.fileId, {
        fileId: options.fileId,
        messageId: resolvedMessageId,
        targetSixDigitId,
        options,
        payload,
        totalChunks,
        retryCount: 0,
        retryTimer: null,
        lastMissingChunks: [],
        retrying: false,
      });
      this.scheduleFileAckRetry(options.fileId);
      return true;
    } catch (err) {
      console.error('Chunked transfer interrupted:', err);
      options.onError?.();
      if (!this.destroyed) {
        if (requeueOnFail) {
          this.requeuePendingTransfer(targetSixDigitId, options);
        } else {
          options.onQueued?.();
        }
        this.ensureConnection(targetSixDigitId);
      }
      return false;
    }
  }

  public startMediaCall(
    targetSixDigitId: string,
    stream: MediaStream,
    metadata: Record<string, unknown>
  ): MediaConnection | null {
    if (!this.peer || this.peer.destroyed || !this.peer.open) return null;
    try {
      return this.peer.call(toFullPeerId(targetSixDigitId), stream, { metadata });
    } catch (err) {
      console.error('Failed to initiate media call:', err);
      return null;
    }
  }

  public isPeerOnline(sixDigitId: string): boolean {
    return isConnectionLive(this.connections.get(sixDigitId));
  }

  private cleanupPeer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.awaitingFileAcks.forEach((entry) => {
      if (entry.retryTimer !== null) {
        window.clearTimeout(entry.retryTimer);
      }
    });
    this.awaitingFileAcks.clear();
    this.openWaiters.clear();
    this.connections.forEach((conn) => {
      try {
        conn.close();
      } catch {
        // ignore
      }
    });
    this.connections.clear();
    this.incomingFileBuffers.clear();
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        // ignore
      }
      this.peer = null;
    }
  }

  public destroy(): void {
    this.destroyed = true;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.cleanupPeer();
  }
}
