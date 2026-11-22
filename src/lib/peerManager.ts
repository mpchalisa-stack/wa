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
 * Ukuran maksimum per potongan paket DataChannel WebRTC: 16 KB (16384 bytes).
 * Mencegah DataChannel macet/putus saat mengirim gambar, kamera, audio, atau dokumen.
 */
export const FILE_CHUNK_SIZE = 16384;

const MAX_BUFFERED_AMOUNT = 64 * 1024; // 64 KB backpressure threshold

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
  fileName: string;
  fileType: string;
  fileSize: number;
  dataUrl: string;
  messageMeta?: ChunkMessageMeta;
  statusMeta?: ChunkStatusMeta;
  onProgress?: (percent: number) => void;
  onQueued?: () => void;
  onComplete?: () => void;
  onError?: () => void;
}

interface IncomingFileBuffer {
  fileId: string;
  fromId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  totalChunks: number;
  chunks: Array<string | undefined>;
  receivedCount: number;
  messageMeta?: ChunkMessageMeta;
  statusMeta?: ChunkStatusMeta;
  startedAt: number;
}

export interface PeerManagerCallbacks {
  onStatusChange: (state: PeerConnectionState, errorMessage?: string) => void;
  onPacket: (fromSixDigitId: string, packet: PeerPacket) => void;
  onFileReceived: (fromSixDigitId: string, file: ReassembledFileTransfer) => void;
  onPeerPresence: (sixDigitId: string, isOnline: boolean) => void;
  onIncomingMediaCall: (call: MediaConnection) => void;
}

export function toFullPeerId(sixDigitId: string): string {
  const clean = sixDigitId.replace(/^WA6-/, '');
  return `${PEER_PREFIX}${clean}`;
}

export function fromFullPeerId(fullId: string): string {
  return fullId.replace(/^WA6-/, '');
}

function waitForDataChannelDrain(conn: DataConnection): Promise<void> {
  return new Promise((resolve) => {
    const dc = (conn as unknown as { dataChannel?: RTCDataChannel }).dataChannel;
    if (!dc || dc.readyState !== 'open' || dc.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
      resolve();
      return;
    }

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      dc.removeEventListener('bufferedamountlow', onLow);
      window.clearTimeout(fallbackTimer);
      resolve();
    };

    const onLow = () => done();

    try {
      dc.bufferedAmountLowThreshold = Math.floor(MAX_BUFFERED_AMOUNT / 2);
      dc.addEventListener('bufferedamountlow', onLow);
    } catch {
      // Fallback to timer polling below
    }

    const poll = () => {
      if (settled) return;
      if (!conn.open || dc.readyState !== 'open' || dc.bufferedAmount <= MAX_BUFFERED_AMOUNT / 2) {
        done();
      } else {
        window.setTimeout(poll, 20);
      }
    };

    const fallbackTimer = window.setTimeout(poll, 25);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class WA6PeerManager {
  private peer: Peer | null = null;
  private profile: UserProfile;
  private callbacks: PeerManagerCallbacks;
  private connections = new Map<string, DataConnection>();
  private pendingQueues = new Map<string, PeerPacket[]>();
  private pendingFileTransfers = new Map<string, SendFileChunkedOptions[]>();
  private activeFileSendChain = new Map<string, Promise<void>>();
  private incomingFileBuffers = new Map<string, IncomingFileBuffer>();
  private reconnectTimer: number | null = null;
  private destroyed = false;

  constructor(profile: UserProfile, callbacks: PeerManagerCallbacks) {
    this.profile = profile;
    this.callbacks = callbacks;
  }

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
      if (conn.open) {
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
    }, 3500);
  }

  private handleFileChunkPacket(fromSixDigitId: string, packet: FileChunkPacket): void {
    if (packet.type === 'FILE_START') {
      const total = Math.max(1, packet.totalChunks);
      this.incomingFileBuffers.set(packet.fileId, {
        fileId: packet.fileId,
        fromId: fromSixDigitId,
        fileName: packet.fileName,
        fileType: packet.fileType,
        fileSize: packet.fileSize,
        totalChunks: total,
        chunks: new Array<string | undefined>(total),
        receivedCount: 0,
        messageMeta: packet.messageMeta,
        statusMeta: packet.statusMeta,
        startedAt: Date.now(),
      });
      return;
    }

    if (packet.type === 'FILE_CHUNK') {
      const buf = this.incomingFileBuffers.get(packet.fileId);
      if (!buf) return;
      if (packet.chunkIndex >= 0 && packet.chunkIndex < buf.totalChunks) {
        if (buf.chunks[packet.chunkIndex] === undefined) {
          buf.receivedCount += 1;
        }
        buf.chunks[packet.chunkIndex] = packet.data;
      }
      return;
    }

    if (packet.type === 'FILE_END') {
      const buf = this.incomingFileBuffers.get(packet.fileId);
      if (!buf) return;
      this.incomingFileBuffers.delete(packet.fileId);

      // Pastikan seluruh chunk sudah terkumpul lengkap
      if (buf.receivedCount < buf.totalChunks) {
        console.warn(
          `Incomplete chunk transfer for ${packet.fileId}: ${buf.receivedCount}/${buf.totalChunks}`
        );
        return;
      }

      const combinedRaw = buf.chunks.join('');
      let blob: Blob;
      try {
        blob = dataUrlToBlob(combinedRaw);
      } catch {
        blob = new Blob([combinedRaw], { type: buf.fileType || 'application/octet-stream' });
      }

      // Gunakan DataURL utuh (atau hasil konversi Blob agar valid)
      const finalize = async () => {
        const finalDataUrl = combinedRaw.startsWith('data:')
          ? combinedRaw
          : await fileToDataUrl(blob);

        this.callbacks.onFileReceived(fromSixDigitId, {
          fileId: buf.fileId,
          fileName: buf.fileName,
          fileType: buf.fileType,
          fileSize: buf.fileSize || blob.size,
          dataUrl: finalDataUrl,
          blob,
          messageMeta: buf.messageMeta,
          statusMeta: buf.statusMeta,
        });
      };

      void finalize();
    }
  }

  private attachConnection(conn: DataConnection): void {
    const peerSixId = fromFullPeerId(conn.peer);
    this.connections.set(peerSixId, conn);

    const onOpen = () => {
      this.callbacks.onPeerPresence(peerSixId, true);
      // Send HELLO handshake with our profile
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

      // Flush queued regular packets
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

      // Flush queued chunked file transfers sequentially
      const queuedFiles = this.pendingFileTransfers.get(peerSixId);
      if (queuedFiles && queuedFiles.length > 0) {
        this.pendingFileTransfers.delete(peerSixId);
        for (const transfer of queuedFiles) {
          this.enqueueChunkedSend(peerSixId, transfer);
        }
      }
    };

    if (conn.open) {
      onOpen();
    } else {
      conn.on('open', onOpen);
    }

    conn.on('data', (data) => {
      if (!data || typeof data !== 'object') return;

      // Handle WebRTC chunked file transfer packets (FILE_START / FILE_CHUNK / FILE_END)
      if ('type' in data) {
        const t = (data as { type?: string }).type;
        if (t === 'FILE_START' || t === 'FILE_CHUNK' || t === 'FILE_END') {
          this.callbacks.onPeerPresence(peerSixId, true);
          this.handleFileChunkPacket(peerSixId, data as FileChunkPacket);
          return;
        }
      }

      // Handle regular signaling & text packets
      if ('kind' in data) {
        this.callbacks.onPeerPresence(peerSixId, true);
        this.callbacks.onPacket(peerSixId, data as PeerPacket);
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
    if (existing && existing.open) {
      return existing;
    }

    try {
      const conn = this.peer.connect(toFullPeerId(targetSixDigitId), {
        reliable: true,
        serialization: 'json',
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

    if (existing && existing.open) {
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

  /**
   * Mengirim gambar, foto kamera, video, dokumen, atau voice note dengan memecah data
   * menjadi potongan-potongan kecil (chunks) maksimal 16 KB (16384 bytes) per paket.
   */
  public sendFileChunked(targetSixDigitId: string, options: SendFileChunkedOptions): boolean {
    if (targetSixDigitId === this.profile.id) return false;
    const existing = this.connections.get(targetSixDigitId);

    if (existing && existing.open) {
      this.enqueueChunkedSend(targetSixDigitId, options);
      return true;
    }

    // Peer belum online: simpan di antrean transfer file dan sambungkan otomatis
    const queue = this.pendingFileTransfers.get(targetSixDigitId) || [];
    if (queue.length < 15) {
      queue.push(options);
      this.pendingFileTransfers.set(targetSixDigitId, queue);
    }
    options.onQueued?.();
    this.ensureConnection(targetSixDigitId);
    return false;
  }

  private enqueueChunkedSend(targetSixDigitId: string, options: SendFileChunkedOptions): void {
    const prevChain = this.activeFileSendChain.get(targetSixDigitId) ?? Promise.resolve();
    const nextChain = prevChain
      .catch(() => {})
      .then(() => this.streamChunksOverConnection(targetSixDigitId, options));
    this.activeFileSendChain.set(targetSixDigitId, nextChain);
  }

  private async streamChunksOverConnection(
    targetSixDigitId: string,
    options: SendFileChunkedOptions
  ): Promise<void> {
    const conn = this.connections.get(targetSixDigitId);
    if (!conn || !conn.open) {
      // Koneksi putus sebelum mulai: masukkan kembali ke antrean
      const queue = this.pendingFileTransfers.get(targetSixDigitId) || [];
      queue.push(options);
      this.pendingFileTransfers.set(targetSixDigitId, queue);
      options.onQueued?.();
      this.ensureConnection(targetSixDigitId);
      return;
    }

    const payload = options.dataUrl;
    const totalChunks = Math.max(1, Math.ceil(payload.length / FILE_CHUNK_SIZE));

    try {
      // 1. Paket awal: FILE_START
      const startPacket: FileChunkPacket = {
        type: 'FILE_START',
        fileId: options.fileId,
        fileName: options.fileName,
        fileType: options.fileType,
        fileSize: options.fileSize,
        totalChunks,
        messageMeta: options.messageMeta,
        statusMeta: options.statusMeta,
      };
      conn.send(startPacket);
      options.onProgress?.(1);

      // 2. Paket potongan: FILE_CHUNK (<= 16384 bytes per paket)
      let lastReportedPct = 1;
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        if (this.destroyed || !conn.open) {
          throw new Error('DataChannel terputus saat mengirim potongan file');
        }

        await waitForDataChannelDrain(conn);

        const start = chunkIndex * FILE_CHUNK_SIZE;
        const data = payload.slice(start, start + FILE_CHUNK_SIZE);

        const chunkPacket: FileChunkPacket = {
          type: 'FILE_CHUNK',
          fileId: options.fileId,
          chunkIndex,
          data,
        };
        conn.send(chunkPacket);

        const pct = Math.min(99, Math.max(1, Math.round(((chunkIndex + 1) / totalChunks) * 100)));
        if (pct !== lastReportedPct) {
          lastReportedPct = pct;
          options.onProgress?.(pct);
        }

        // Yield sejenak setiap 4 chunk agar UI progres tetap responsif & buffer WebRTC stabil
        if (chunkIndex % 4 === 3) {
          await sleep(4);
        }
      }

      // 3. Paket selesai: FILE_END
      await waitForDataChannelDrain(conn);
      const endPacket: FileChunkPacket = {
        type: 'FILE_END',
        fileId: options.fileId,
      };
      conn.send(endPacket);
      options.onProgress?.(100);
      options.onComplete?.();
    } catch (err) {
      console.error('Chunked transfer interrupted:', err);
      options.onError?.();
      // Coba sambungkan ulang dan antrekan ulang bila peer tidak sengaja terputus
      if (!this.destroyed) {
        const queue = this.pendingFileTransfers.get(targetSixDigitId) || [];
        queue.push(options);
        this.pendingFileTransfers.set(targetSixDigitId, queue);
        options.onQueued?.();
        this.ensureConnection(targetSixDigitId);
      }
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
    const conn = this.connections.get(sixDigitId);
    return Boolean(conn && conn.open);
  }

  private cleanupPeer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
    this.cleanupPeer();
  }
}
