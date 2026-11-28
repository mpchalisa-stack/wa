import Peer, { DataConnection, MediaConnection } from 'peerjs';
import {
  ChunkMessageMeta,
  ChunkStatusMeta,
  FileChunkPacket,
  PeerConnectionState,
  PeerPacket,
  UserProfile,
} from '../types';
import { dataUrlToBlob, fileToDataUrl, resolveMimeTypeForFile } from './media';

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

/** Jeda minimal 10 detik sebelum mencoba reconnect peer.connect() lagi untuk kontak offline */
const RECONNECT_COOLDOWN_MS = 10000;

/** Batas waktu 6 detik: jika DataConnection gagal terbuka / ICE failed, fallback paksa ke TURN relay */
const OPEN_RELAY_FALLBACK_MS = 6000;

/** Interval PING kehadiran & heartbeat ringan setiap 5 detik agar status Online/Offline sinkron real-time */
const HEARTBEAT_INTERVAL_MS = 5000;

/** Jeda anti-spam minimal 3 detik saat menjalankan wakeAndSyncPeer() pada visibilitychange / focus */
const WAKE_SYNC_COOLDOWN_MS = 3000;

/** Timeout tunggu balasan PONG (2 detik) untuk mendeteksi zombie socket saat kembali dari latar belakang */
const ZOMBIE_PING_TIMEOUT_MS = 2000;

/** Batas waktu tanpa balasan PONG/aktivitas pada DataChannel (18 detik = >3 siklus ping 5 detik) sebelum dianggap offline */
const STALE_CONNECTION_MS = 18000;

export type PeerTransportMode = 'p2p' | 'relay';

/**
 * Konfigurasi ICE / STUN standar & cepat untuk WebRTC (DataChannel & Panggilan Suara/Video).
 * Menggunakan iceTransportPolicy: 'all' tanpa pemaksaan relay yang memperlambat koneksi di Android WebView.
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

export function createCallRTCConfiguration(): RTCConfiguration {
  return {
    iceServers: ICE_SERVERS,
    iceCandidatePoolSize: 10,
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  };
}

export function getMediaCallPeerConnection(mediaCall: MediaConnection | null | undefined): RTCPeerConnection | null {
  if (!mediaCall) return null;
  const internal = mediaCall as unknown as {
    peerConnection?: RTCPeerConnection;
    _pc?: RTCPeerConnection;
  };
  return internal.peerConnection || internal._pc || null;
}

export function syncWindowAudioTracks(tracks: MediaStreamTrack[]): void {
  if (typeof window === 'undefined') return;
  try {
    const win = window as Window & { __wattappsAudioTracks?: MediaStreamTrack[] };
    const existing = Array.isArray(win.__wattappsAudioTracks) ? win.__wattappsAudioTracks : [];
    const mergedMap = new Map<string, MediaStreamTrack>();
    for (const t of existing) {
      if (t && t.kind === 'audio' && t.readyState === 'live') {
        mergedMap.set(t.id, t);
      }
    }
    for (const t of tracks) {
      if (t && t.kind === 'audio' && t.readyState === 'live') {
        mergedMap.set(t.id, t);
      }
    }
    win.__wattappsAudioTracks = Array.from(mergedMap.values());
  } catch {
    // ignore
  }
}

export function ensureLocalAudioTracksAttached(
  mediaCall: MediaConnection | null | undefined,
  localStream: MediaStream | null | undefined,
  keepMuted = false
): void {
  if (!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  if (!keepMuted) {
    audioTracks.forEach((track) => {
      if (track.readyState === 'live') {
        track.enabled = true;
      }
    });
  }
  syncWindowAudioTracks(audioTracks);

  const pc = getMediaCallPeerConnection(mediaCall);
  if (!pc) return;

  try {
    if (typeof pc.getTransceivers === 'function') {
      pc.getTransceivers().forEach((transceiver) => {
        const isAudio =
          transceiver.sender?.track?.kind === 'audio' ||
          transceiver.receiver?.track?.kind === 'audio';
        if (isAudio && (transceiver.direction === 'recvonly' || transceiver.direction === 'inactive')) {
          try {
            transceiver.direction = 'sendrecv';
          } catch {
            // ignore if browser locks transceiver direction
          }
        }
      });
    }

    if (typeof pc.getSenders === 'function') {
      const existingSenders = pc.getSenders();
      const liveAudioTracks = audioTracks.filter((t) => t.readyState === 'live');
      const primaryAudioTrack = liveAudioTracks[0] || audioTracks[0];

      if (!keepMuted) {
        existingSenders.forEach((sender) => {
          if (sender.track && sender.track.kind === 'audio' && sender.track.readyState === 'live') {
            sender.track.enabled = true;
          }
        });
      }

      if (primaryAudioTrack) {
        const audioSenders = existingSenders.filter(
          (sender) =>
            sender.track?.kind === 'audio' ||
            (!sender.track &&
              typeof pc.getTransceivers === 'function' &&
              pc
                .getTransceivers()
                .some((tr) => tr.sender === sender && tr.receiver?.track?.kind === 'audio'))
        );

        if (audioSenders.length > 0) {
          audioSenders.forEach((sender) => {
            if (
              (!sender.track || sender.track.readyState === 'ended') &&
              typeof sender.replaceTrack === 'function'
            ) {
              void sender.replaceTrack(primaryAudioTrack).catch(() => {});
            }
          });
        } else if (typeof pc.addTrack === 'function') {
          liveAudioTracks.forEach((audioTrack) => {
            try {
              pc.addTrack(audioTrack, localStream);
            } catch {
              // ignore duplicate track errors
            }
          });
        }
      }
    }
  } catch {
    // PeerJS may have already added transceivers/tracks during offer/answer creation
  }
}

export async function inspectMediaCallTransport(
  mediaCall: MediaConnection,
  fallbackRelay = false
): Promise<'direct' | 'relay' | null> {
  const pc = getMediaCallPeerConnection(mediaCall);
  if (!pc) return fallbackRelay ? 'relay' : null;

  let detected: 'direct' | 'relay' = fallbackRelay ? 'relay' : 'direct';
  if (typeof pc.getStats === 'function') {
    try {
      const stats = await pc.getStats();
      const candidates = new Map<string, string>();
      let selectedPair: { localCandidateId?: string; remoteCandidateId?: string } | null = null;

      stats.forEach((report) => {
        const r = report as Record<string, unknown>;
        if (r.type === 'local-candidate' || r.type === 'remote-candidate') {
          if (typeof r.id === 'string' && typeof r.candidateType === 'string') {
            candidates.set(r.id, r.candidateType);
          }
        } else if (r.type === 'candidate-pair') {
          const isSelected =
            r.selected === true ||
            (r.nominated === true && r.state === 'succeeded') ||
            r.state === 'succeeded';
          if (isSelected) {
            selectedPair = {
              localCandidateId:
                typeof r.localCandidateId === 'string' ? r.localCandidateId : undefined,
              remoteCandidateId:
                typeof r.remoteCandidateId === 'string' ? r.remoteCandidateId : undefined,
            };
          }
        }
      });

      if (selectedPair) {
        const pair = selectedPair as { localCandidateId?: string; remoteCandidateId?: string };
        const localType = pair.localCandidateId ? candidates.get(pair.localCandidateId) : undefined;
        const remoteType = pair.remoteCandidateId ? candidates.get(pair.remoteCandidateId) : undefined;
        if (localType === 'relay' || remoteType === 'relay') {
          detected = 'relay';
        } else if (localType || remoteType) {
          detected = 'direct';
        }
      }
    } catch {
      // fallback to policy-based value
    }
  }
  return detected;
}

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
  onPeerTransport?: (sixDigitId: string, transport: PeerTransportMode | null) => void;
  onPeerReady?: (sixDigitId: string) => void;
  onIncomingMediaCall: (call: MediaConnection) => void;
}

/**
 * Normalisasi ID kontak & PeerJS: hapus seluruh spasi dan karakter non-alfanumerik
 * (mis. "564 009" / "564-009" / "WA6-564 009" -> "564009", tetap mempertahankan prefix grup "GRP-...").
 */
export function normalizePeerId(rawId: string): string {
  if (!rawId) return '';
  const trimmed = rawId.trim();
  if (/^GRP-/i.test(trimmed)) {
    const suffix = trimmed.slice(4).replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '');
    return `GRP-${suffix}`;
  }
  const withoutPrefix = trimmed.replace(/^(WA6-|WattappsAU-)/i, '');
  return withoutPrefix.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '');
}

export function toFullPeerId(sixDigitId: string): string {
  const clean = normalizePeerId(sixDigitId);
  return `${PEER_PREFIX}${clean}`;
}

export function fromFullPeerId(fullId: string): string {
  return normalizePeerId(fullId);
}

function getPeerConnection(conn?: DataConnection | null): RTCPeerConnection | undefined {
  if (!conn) return undefined;
  return (conn as unknown as { peerConnection?: RTCPeerConnection }).peerConnection;
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
  private pongWaiters = new Map<string, Array<() => void>>();
  private pendingQueues = new Map<string, PeerPacket[]>();
  private pendingFileTransfers = new Map<string, SendFileChunkedOptions[]>();
  private activeFileSendChain = new Map<string, Promise<void>>();
  private incomingFileBuffers = new Map<string, IncomingFileBuffer>();
  private completedReceivedFiles = new Map<string, string>(); // fileId -> messageId
  private awaitingFileAcks = new Map<string, PendingAckTransfer>();
  private lastConnectAttempt = new Map<string, number>();
  private lastPeerActivity = new Map<string, number>();
  private verifiedOnlinePeers = new Set<string>();
  private peerTransports = new Map<string, PeerTransportMode>();
  private relayPreferredPeers = new Set<string>();
  private relayFallbackAttempted = new Set<string>();
  private openWatchdogs = new Map<string, number>();
  private savedContactIds = new Set<string>();
  private lastWakeSyncAt = 0;
  private wakeSyncInFlight = false;
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private batteryStandby = false;
  private destroyed = false;

  constructor(profile: UserProfile, callbacks: PeerManagerCallbacks) {
    this.profile = { ...profile, id: normalizePeerId(profile.id) };
    this.callbacks = callbacks;
  }

  /**
   * Menghentikan interval polling heartbeat/presence berat saat mode standby hemat baterai aktif,
   * tanpa memutus instance PeerJS maupun listener pesan/panggilan masuk.
   */
  public setBatteryStandby(enabled: boolean): void {
    if (this.batteryStandby === enabled) return;
    this.batteryStandby = enabled;
    if (enabled) {
      if (this.heartbeatTimer !== null) {
        window.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      return;
    }
    if (!this.destroyed && this.peer && !this.peer.destroyed && this.peer.open) {
      this.startHeartbeatLoop();
    }
  }

  /**
   * Menyimpan daftar ID kontak 1:1 tersimpan (ternormalisasi) agar siklus PING 5 detik
   * selalu memeriksa kehadiran seluruh kontak dan memicu pengiriman ulang chat pending.
   */
  public setSavedContactIds(contactIds: string[]): void {
    const nextSet = new Set<string>();
    for (const rawId of contactIds) {
      const id = normalizePeerId(rawId);
      if (id && id !== this.profile.id && !id.startsWith('GRP-')) {
        nextSet.add(id);
      }
    }
    this.savedContactIds = nextSet;

    // Jika PeerJS sudah online, segera buka/ping kontak baru yang belum tersambung
    if (!this.destroyed && this.peer && !this.peer.destroyed && this.peer.open) {
      this.savedContactIds.forEach((contactId) => {
        const conn = this.connections.get(contactId);
        if (conn && isConnectionLive(conn)) {
          this.sendSimplePing(conn);
        } else {
          this.ensureConnection(contactId, false);
        }
      });
    }
  }

  private applyPeerIcePolicy(_forceRelay = false): void {
    if (!this.peer) return;
    try {
      const peerAny = this.peer as unknown as {
        options?: { config?: RTCConfiguration & { sdpSemantics?: string } };
      };
      if (peerAny.options?.config) {
        // Selalu gunakan default 'all' (tanpa pemaksaan relay yang lambat)
        peerAny.options.config.iceTransportPolicy = 'all';
      }
    } catch {
      // ignore
    }
  }

  private clearOpenWatchdog(peerSixId: string): void {
    const timer = this.openWatchdogs.get(peerSixId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.openWatchdogs.delete(peerSixId);
    }
  }

  private sendSimplePing(conn: DataConnection): boolean {
    if (!isConnectionLive(conn)) return false;
    try {
      conn.send({
        type: 'PING',
        status: 'online',
        fromId: this.profile.id,
        ts: Date.now(),
      });
      return true;
    } catch {
      return false;
    }
  }

  private sendSimplePong(conn: DataConnection): boolean {
    if (!isConnectionLive(conn)) return false;
    try {
      conn.send({
        type: 'PONG',
        status: 'online',
        fromId: this.profile.id,
        ts: Date.now(),
      });
      return true;
    } catch {
      return false;
    }
  }

  private markPeerVerifiedOffline(peerSixId: string): void {
    this.clearOpenWatchdog(peerSixId);
    this.verifiedOnlinePeers.delete(peerSixId);
    this.lastPeerActivity.delete(peerSixId);
    if (this.peerTransports.has(peerSixId)) {
      this.peerTransports.delete(peerSixId);
      this.callbacks.onPeerTransport?.(peerSixId, null);
    }
    this.callbacks.onPeerPresence(peerSixId, false);
  }

  private markPeerVerifiedOnline(peerSixId: string, conn: DataConnection): void {
    if (!isConnectionLive(conn)) return;
    this.connections.set(peerSixId, conn);
    this.lastPeerActivity.set(peerSixId, Date.now());
    this.verifiedOnlinePeers.add(peerSixId);
    this.relayFallbackAttempted.delete(peerSixId);
    this.callbacks.onPeerPresence(peerSixId, true);
    void this.inspectAndEmitTransport(peerSixId, conn);
    this.callbacks.onPeerReady?.(peerSixId);
  }

  /**
   * Memeriksa statistik ICE candidate-pair aktif untuk membedakan jalur:
   * - 'p2p'   ("Terhubung P2P")   jika melewati STUN / koneksi langsung (host/srflx/prflx)
   * - 'relay' ("Terhubung Relay") jika melewati TURN server (relay)
   */
  private async inspectAndEmitTransport(peerSixId: string, conn: DataConnection): Promise<void> {
    if (this.destroyed || !isConnectionLive(conn)) return;

    const pc = getPeerConnection(conn);
    let detected: PeerTransportMode = this.relayPreferredPeers.has(peerSixId) ? 'relay' : 'p2p';

    if (pc && typeof pc.getStats === 'function') {
      try {
        const stats = await pc.getStats();
        let selectedPairId: string | undefined;
        let activePair: { localCandidateId?: string; remoteCandidateId?: string } | null = null;
        const candidates = new Map<string, string>();

        stats.forEach((report) => {
          const r = report as unknown as Record<string, unknown>;
          if (r.type === 'transport' && typeof r.selectedCandidatePairId === 'string') {
            selectedPairId = r.selectedCandidatePairId;
          } else if (r.type === 'local-candidate' || r.type === 'remote-candidate') {
            if (typeof r.id === 'string' && typeof r.candidateType === 'string') {
              candidates.set(r.id, r.candidateType);
            }
          }
        });

        stats.forEach((report) => {
          const r = report as unknown as Record<string, unknown>;
          if (r.type !== 'candidate-pair') return;
          const isSelected =
            (selectedPairId && r.id === selectedPairId) ||
            (r.state === 'succeeded' && (r.nominated === true || r.selected === true));
          if (isSelected) {
            activePair = {
              localCandidateId:
                typeof r.localCandidateId === 'string' ? r.localCandidateId : undefined,
              remoteCandidateId:
                typeof r.remoteCandidateId === 'string' ? r.remoteCandidateId : undefined,
            };
          }
        });

        if (activePair) {
          const pair = activePair as { localCandidateId?: string; remoteCandidateId?: string };
          const localType = pair.localCandidateId ? candidates.get(pair.localCandidateId) : undefined;
          const remoteType = pair.remoteCandidateId ? candidates.get(pair.remoteCandidateId) : undefined;
          if (localType === 'relay' || remoteType === 'relay') {
            detected = 'relay';
          } else if (localType || remoteType) {
            detected = 'p2p';
          }
        }
      } catch {
        // fallback to policy-based detection
      }
    }

    if (this.destroyed || this.connections.get(peerSixId) !== conn) return;
    if (this.peerTransports.get(peerSixId) !== detected) {
      this.peerTransports.set(peerSixId, detected);
      this.callbacks.onPeerTransport?.(peerSixId, detected);
    }
  }

  private resolvePongWaiters(peerSixId: string): void {
    const waiters = this.pongWaiters.get(peerSixId);
    if (!waiters || waiters.length === 0) return;
    this.pongWaiters.delete(peerSixId);
    waiters.forEach((fn) => fn());
  }

  private waitForPong(peerSixId: string, timeoutMs = ZOMBIE_PING_TIMEOUT_MS): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (received: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        const list = this.pongWaiters.get(peerSixId);
        if (list) {
          const filtered = list.filter((fn) => fn !== onPong);
          if (filtered.length > 0) {
            this.pongWaiters.set(peerSixId, filtered);
          } else {
            this.pongWaiters.delete(peerSixId);
          }
        }
        resolve(received);
      };

      const onPong = () => done(true);
      const list = this.pongWaiters.get(peerSixId) || [];
      list.push(onPong);
      this.pongWaiters.set(peerSixId, list);

      const timer = window.setTimeout(() => done(false), timeoutMs);
    });
  }

  private forceReconnectPeer(
    rawTargetId: string,
    staleConn?: DataConnection,
    forceRelay = false
  ): DataConnection | null {
    const targetSixDigitId = normalizePeerId(rawTargetId);
    if (this.destroyed || !this.peer || this.peer.destroyed || !this.peer.open) {
      return null;
    }
    if (!targetSixDigitId || targetSixDigitId === this.profile.id) return null;

    this.clearOpenWatchdog(targetSixDigitId);

    const current = staleConn || this.connections.get(targetSixDigitId);
    if (current) {
      try {
        current.close();
      } catch {
        // ignore
      }
      if (this.connections.get(targetSixDigitId) === current) {
        this.connections.delete(targetSixDigitId);
      }
    }

    this.markPeerVerifiedOffline(targetSixDigitId);
    this.lastConnectAttempt.set(targetSixDigitId, Date.now());

    if (forceRelay) {
      this.relayPreferredPeers.add(targetSixDigitId);
    }

    const useRelay = forceRelay || this.relayPreferredPeers.has(targetSixDigitId);
    this.applyPeerIcePolicy(useRelay);

    try {
      const freshConn = this.peer.connect(toFullPeerId(targetSixDigitId), {
        reliable: true,
      });
      this.attachConnection(freshConn, false, useRelay);
      return freshConn;
    } catch {
      return null;
    } finally {
      // Kembalikan default ke 'all' agar kontak lain tetap dapat mencoba P2P langsung lebih dulu
      this.applyPeerIcePolicy(false);
    }
  }

  /**
   * Pemulihan koneksi otomatis saat aplikasi kembali aktif dari latar belakang (visibilitychange / focus):
   * - Anti-spam minimal 3 detik.
   * - Cek status PeerJS (reconnect jika disconnected, buat new Peer baru jika destroyed).
   * - Uji seluruh koneksi kontak aktif dengan PING; jika tidak ada PONG dalam 2 detik, tutup paksa zombie socket
   *   dan buat peer.connect(...) baru agar jalur chat dan panggilan langsung segar kembali.
   */
  public async wakeAndSyncPeer(priorityContactIds: string[] = [], force = false): Promise<boolean> {
    if (this.destroyed) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return false;
    }
    const now = Date.now();
    if (this.wakeSyncInFlight || (!force && now - this.lastWakeSyncAt < WAKE_SYNC_COOLDOWN_MS)) {
      return false;
    }

    this.wakeSyncInFlight = true;
    this.lastWakeSyncAt = now;

    // Bersihkan timer reconnect tertunda agar pemulihan langsung berjalan
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      // (a) Pulihkan signaling PeerJS terlebih dahulu
      if (!this.peer || this.peer.destroyed) {
        this.connect();
        await this.waitForPeerOpen(4000);
      } else if (this.peer.disconnected) {
        try {
          this.peer.reconnect();
        } catch {
          this.connect();
        }
        const reopened = await this.waitForPeerOpen(4000);
        if (!reopened && !this.destroyed) {
          // Jika socket signaling lama tersangkut total, buat instance new Peer baru
          this.connect();
          await this.waitForPeerOpen(4000);
        }
      } else if (!this.peer.open) {
        await this.waitForPeerOpen(3000);
      }

      if (this.destroyed || !this.peer || this.peer.destroyed || !this.peer.open) {
        return false;
      }

      // (b) Uji seluruh koneksi kontak aktif dengan PING (timeout PONG 2 detik)
      const activeEntries = Array.from(this.connections.entries());
      const probedIds = new Set<string>();

      await Promise.all(
        activeEntries.map(async ([peerSixId, conn]) => {
          probedIds.add(peerSixId);
          if (this.destroyed) return;

          if (!isConnectionLive(conn)) {
            this.forceReconnectPeer(peerSixId, conn);
            return;
          }

          const pongPromise = this.waitForPong(peerSixId, ZOMBIE_PING_TIMEOUT_MS);
          const pingSent = this.sendSimplePing(conn);
          if (pingSent) {
            try {
              conn.send({
                kind: 'PING',
                fromId: this.profile.id,
                ts: Date.now(),
              } satisfies PeerPacket);
            } catch {
              // ignore legacy ping failure if simple ping already sent
            }
          }

          if (!pingSent) {
            this.forceReconnectPeer(peerSixId, conn);
            return;
          }

          const gotPong = await pongPromise;
          if (this.destroyed) return;

          if (gotPong) {
            this.markPeerVerifiedOnline(peerSixId, conn);
            this.callbacks.onPeerReady?.(peerSixId);
          } else {
            // Tidak ada balasan PONG dalam 2 detik -> zombie socket! Tutup paksa & buat koneksi baru
            const latestConn = this.connections.get(peerSixId);
            if (!latestConn || latestConn === conn) {
              this.forceReconnectPeer(peerSixId, conn);
            }
          }
        })
      );

      // Sambungkan juga kontak prioritas (chat aktif, outbox tertunda, pendingCall, atau kontak 1:1) yang belum ada koneksi
      const uniquePriority = Array.from(
        new Set(priorityContactIds.map((id) => normalizePeerId(id)))
      ).filter((id) => id && id !== this.profile.id && !probedIds.has(id));
      for (const peerSixId of uniquePriority) {
        if (this.destroyed) break;
        const current = this.connections.get(peerSixId);
        if (!current || !isConnectionLive(current)) {
          this.ensureConnection(peerSixId, true);
        }
      }

      return true;
    } finally {
      this.wakeSyncInFlight = false;
    }
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
    const peerConfig = {
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 10,
      sdpSemantics: 'unified-plan',
      iceTransportPolicy: 'all',
      // Enkripsi end-to-end bawaan WebRTC (DTLS/SRTP) untuk seluruh aliran audio/video & DataChannel
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    } as RTCConfiguration;

    const peer = new Peer(fullId, {
      debug: 0,
      config: peerConfig,
    });

    this.peer = peer;

    peer.on('open', () => {
      if (this.destroyed) return;
      this.callbacks.onStatusChange('online');
      this.startHeartbeatLoop();
      // Langsung sambungkan seluruh kontak tersimpan saat broker signaling siap
      this.savedContactIds.forEach((contactId) => {
        this.ensureConnection(contactId, false);
      });
    });

    peer.on('connection', (conn) => {
      // Koneksi masuk dua arah: simpan conn & tunggu conn.on('open') + pertukaran PING/PONG sebelum menandai Online
      this.attachConnection(conn, true, false);
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
      this.scheduleReconnect();
    });

    peer.on('error', (err) => {
      if (this.destroyed) return;
      const errType = (err as { type?: string }).type || '';
      if (errType === 'peer-unavailable') {
        const match = err.message?.match(/WA6-(\d{6})/);
        if (match && match[1]) {
          const unavailableId = match[1];
          // Simpan timestamp kegagalan agar tidak mencoba connect lagi sebelum 15 detik
          this.lastConnectAttempt.set(unavailableId, Date.now());
          const stale = this.connections.get(unavailableId);
          if (stale && !isConnectionLive(stale)) {
            this.connections.delete(unavailableId);
          }
          this.callbacks.onPeerPresence(unavailableId, false);
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

  /**
   * Siklus PRESENCE_PING & heartbeat ringan setiap 5 detik:
   * 1. Menjaga WebSocket signaling PeerJS tetap hidup (anti-idle timeout NAT/operator seluler).
   * 2. Mengirim PRESENCE_PING ke seluruh koneksi aktif & mencoba menyambungkan kontak tersimpan yang belum terbuka.
   * 3. Jika koneksi terbuka atau menerima balasan, tandai Online dan picu onPeerReady untuk menguras pesan pending.
   * 4. Mendeteksi koneksi macet/zombie (> 18 detik tanpa balasan) lalu menandai Offline & menyambung ulang.
   */
  private startHeartbeatLoop(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.batteryStandby || this.destroyed) return;
    this.heartbeatTimer = window.setInterval(() => {
      if (this.destroyed || this.batteryStandby) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

      // (1) Jaga WebSocket signaling PeerJS tetap hidup (anti-idle timeout NAT/operator seluler)
      if (!this.peer || this.peer.destroyed) {
        this.scheduleReconnect();
      } else if (this.peer.disconnected) {
        try {
          this.peer.reconnect();
        } catch {
          this.scheduleReconnect();
        }
      } else if (this.peer.open) {
        try {
          const internalPeer = this.peer as unknown as {
            socket?: {
              _socket?: WebSocket;
              send?: (data: { type: string }) => void;
            };
          };
          const ws = internalPeer.socket?._socket;
          if (ws && ws.readyState === WebSocket.OPEN && typeof internalPeer.socket?.send === 'function') {
            internalPeer.socket.send({ type: 'HEARTBEAT' });
          } else if (ws && ws.readyState === WebSocket.CLOSED) {
            this.peer.reconnect();
          }
        } catch {
          // ignore if internal PeerJS socket structure differs
        }
      }

      // (2) Kirim PING ke seluruh DataConnection WebRTC yang benar-benar terbuka (conn.open)
      const now = Date.now();
      const checkedPeers = new Set<string>();

      this.connections.forEach((conn, peerSixId) => {
        checkedPeers.add(peerSixId);
        if (!isConnectionLive(conn)) {
          // Jangan hapus bila masih dalam masa handshake awal (< 6 detik)
          const lastTry = this.lastConnectAttempt.get(peerSixId) ?? 0;
          if (!conn.open && now - lastTry < OPEN_RELAY_FALLBACK_MS) {
            return;
          }
          this.connections.delete(peerSixId);
          this.markPeerVerifiedOffline(peerSixId);
          return;
        }

        const lastSeen = this.lastPeerActivity.get(peerSixId);
        if (lastSeen && now - lastSeen > STALE_CONNECTION_MS) {
          // Koneksi tidak membalas beberapa siklus PING -> tutup & sambung ulang dengan fallback TURN relay
          this.forceReconnectPeer(peerSixId, conn, true);
          return;
        }

        const sent = this.sendSimplePing(conn);
        if (!sent) {
          this.connections.delete(peerSixId);
          this.markPeerVerifiedOffline(peerSixId);
        } else if (this.verifiedOnlinePeers.has(peerSixId)) {
          // Re-inspeksi jalur P2P/Relay secara berkala & pastikan antrean pending terus terkirim
          void this.inspectAndEmitTransport(peerSixId, conn);
          this.callbacks.onPeerReady?.(peerSixId);
        }
      });

      // (3) Untuk seluruh kontak tersimpan yang belum memiliki koneksi aktif, coba sambungkan berkala
      if (this.peer && !this.peer.destroyed && this.peer.open) {
        this.savedContactIds.forEach((contactId) => {
          if (!checkedPeers.has(contactId)) {
            this.ensureConnection(contactId, false);
          }
        });
      }
    }, HEARTBEAT_INTERVAL_MS);
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
    }, RECONNECT_COOLDOWN_MS);
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
    rawTargetId: string,
    timeoutMs = CONNECTION_OPEN_TIMEOUT_MS
  ): Promise<DataConnection | null> {
    const targetSixDigitId = normalizePeerId(rawTargetId);
    if (this.destroyed || !targetSixDigitId || targetSixDigitId === this.profile.id) return null;

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

    const lastTry = this.lastConnectAttempt.get(targetSixDigitId) ?? 0;
    let conn: DataConnection;

    // Jika sudah ada satu jalur DataConnection yang sedang proses handshake (< 6 detik), tunggu jalur itu (jangan gandakan)
    if (refreshed && !refreshed.open && Date.now() - lastTry < OPEN_RELAY_FALLBACK_MS) {
      conn = refreshed;
    } else {
      // Jika ada koneksi lama yang benar-benar macet/kedaluwarsa, tutup bersih sebelum buat jalur tunggal baru
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

      const useRelay = this.relayPreferredPeers.has(targetSixDigitId);
      this.applyPeerIcePolicy(useRelay);
      try {
        this.lastConnectAttempt.set(targetSixDigitId, Date.now());
        conn = this.peer.connect(toFullPeerId(targetSixDigitId), {
          reliable: true,
        });
        this.attachConnection(conn, false, useRelay);
      } catch {
        return null;
      } finally {
        this.applyPeerIcePolicy(false);
      }
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

    const resolvedMime = resolveMimeTypeForFile(buf.fileName, buf.fileType);
    let blob: Blob;
    try {
      blob = dataUrlToBlob(combinedRaw, resolvedMime);
    } catch {
      blob = new Blob([combinedRaw], { type: resolvedMime });
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
        fileType: resolvedMime,
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

  private attachConnection(
    conn: DataConnection,
    isIncoming = false,
    startedWithRelay = false
  ): void {
    const peerSixId = fromFullPeerId(conn.peer);
    if (!peerSixId || peerSixId === this.profile.id) return;

    // Simpan conn sebagai kandidat aktif jika koneksi masuk baru atau belum ada jalur terbuka
    const existing = this.connections.get(peerSixId);
    if (isIncoming || !isConnectionLive(existing)) {
      this.connections.set(peerSixId, conn);
    }

    const bindIceMonitor = () => {
      const pc = getPeerConnection(conn);
      if (!pc) return;
      const handleIceChange = () => {
        if (this.destroyed || this.connections.get(peerSixId) !== conn) {
          pc.removeEventListener('iceconnectionstatechange', handleIceChange);
          return;
        }
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          if (this.verifiedOnlinePeers.has(peerSixId)) {
            void this.inspectAndEmitTransport(peerSixId, conn);
          }
        }
      };
      pc.addEventListener('iceconnectionstatechange', handleIceChange);
    };

    bindIceMonitor();

    const onOpen = () => {
      this.clearOpenWatchdog(peerSixId);
      this.connections.set(peerSixId, conn);
      this.lastPeerActivity.set(peerSixId, Date.now());
      bindIceMonitor();

      // Selesaikan semua waiter yang sedang menunggu ensureOpenConnection()
      const waiters = this.openWaiters.get(peerSixId);
      if (waiters && waiters.length > 0) {
        this.openWaiters.delete(peerSixId);
        waiters.forEach((resolveFn) => resolveFn(conn));
      }

      // PENTING: Jangan ubah status menjadi "Online" sebelum pertukaran PING / PONG berhasil
      // pada DataChannel terbuka ini! Langsung kirim { type: 'PING' } segera setelah conn.on('open').
      this.sendSimplePing(conn);

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

      // Beri tahu aplikasi untuk mulai menguras antrean pendingMessages pada koneksi terbuka ini
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
      if (!isConnectionLive(conn)) return;

      // Pastikan koneksi pengirim tercatat sebagai jalur aktif dua arah
      if (this.connections.get(peerSixId) !== conn) {
        this.connections.set(peerSixId, conn);
      }

      this.lastPeerActivity.set(peerSixId, Date.now());

      // Handle pertukaran resmi { type: 'PING' } / { type: 'PONG' } (plus kompatibilitas PRESENCE_PING/ACK)
      if ('type' in data) {
        const msgType = (data as { type?: string }).type;
        if (msgType === 'PING' || msgType === 'PRESENCE_PING') {
          this.sendSimplePong(conn);
          this.markPeerVerifiedOnline(peerSixId, conn);
          return;
        }
        if (msgType === 'PONG' || msgType === 'PRESENCE_ACK') {
          this.resolvePongWaiters(peerSixId);
          this.markPeerVerifiedOnline(peerSixId, conn);
          return;
        }
      }

      // Handle paket chunking & ACK file WebRTC (JSON string / object)
      if (isFileChunkPacket(data)) {
        this.markPeerVerifiedOnline(peerSixId, conn);
        this.handleFileChunkPacket(peerSixId, data, conn);
        return;
      }

      // Handle paket signaling, PING/PONG legacy & pesan teks reguler
      if ('kind' in data) {
        const pkt = data as PeerPacket;

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
          this.sendSimplePong(conn);
          this.markPeerVerifiedOnline(peerSixId, conn);
          return;
        }

        if (pkt.kind === 'PONG') {
          this.resolvePongWaiters(peerSixId);
          this.markPeerVerifiedOnline(peerSixId, conn);
          return;
        }

        // Paket data valid di DataChannel terbuka juga mengonfirmasi jalur aktif bila sudah melalui HELLO/MESSAGE
        this.callbacks.onPacket(peerSixId, pkt);
        if (pkt.kind === 'HELLO' || pkt.kind === 'MESSAGE') {
          this.sendSimplePing(conn);
          this.callbacks.onPeerReady?.(peerSixId);
        }
      }
    });

    conn.on('close', () => {
      if (this.connections.get(peerSixId) === conn) {
        this.connections.delete(peerSixId);
        this.markPeerVerifiedOffline(peerSixId);
      }
    });

    conn.on('error', () => {
      if (this.connections.get(peerSixId) === conn) {
        this.connections.delete(peerSixId);
        this.markPeerVerifiedOffline(peerSixId);
      }
    });
  }

  /**
   * Pastikan hanya ada SATU jalur koneksi DataConnection per kontak (ID otomatis dinormalisasi).
   * Menggunakan iceTransportPolicy: 'relay' otomatis bila kontak tersebut sebelumnya butuh TURN fallback.
   */
  public ensureConnection(rawTargetId: string, force = false): DataConnection | null {
    const targetSixDigitId = normalizePeerId(rawTargetId);
    if (!this.peer || this.peer.destroyed || !this.peer.open) return null;
    if (!targetSixDigitId || targetSixDigitId === this.profile.id) return null;

    const existing = this.connections.get(targetSixDigitId);
    if (existing && isConnectionLive(existing)) {
      return existing;
    }

    const now = Date.now();
    const lastAttempt = this.lastConnectAttempt.get(targetSixDigitId) ?? 0;

    // Jika koneksi tunggal masih dalam tahap membuka (< 6 detik), tunggu jalur itu
    if (existing && !existing.open && now - lastAttempt < OPEN_RELAY_FALLBACK_MS) {
      return existing;
    }
    if (!force && now - lastAttempt < RECONNECT_COOLDOWN_MS) {
      return null;
    }

    this.lastConnectAttempt.set(targetSixDigitId, now);
    const useRelay = this.relayPreferredPeers.has(targetSixDigitId);
    this.applyPeerIcePolicy(useRelay);

    try {
      const conn = this.peer.connect(toFullPeerId(targetSixDigitId), {
        reliable: true,
      });
      this.attachConnection(conn, false, useRelay);
      return conn;
    } catch {
      return null;
    } finally {
      this.applyPeerIcePolicy(false);
    }
  }

  public sendPacket(rawTargetId: string, packet: PeerPacket): boolean {
    const targetSixDigitId = normalizePeerId(rawTargetId);
    if (!targetSixDigitId || targetSixDigitId === this.profile.id) return false;
    const existing = this.connections.get(targetSixDigitId);

    if (existing && isConnectionLive(existing)) {
      try {
        existing.send(packet);
        return true;
      } catch {
        // Fall through to queue
      }
    }

    if (packet.kind !== 'TYPING' && packet.kind !== 'PING' && packet.kind !== 'PONG') {
      const queue = this.pendingQueues.get(targetSixDigitId) || [];
      if (queue.length < 40) {
        queue.push(packet);
        this.pendingQueues.set(targetSixDigitId, queue);
      }
    }

    this.ensureConnection(targetSixDigitId, false);
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
   * Mengirim sinyal PING ringan HANYA pada koneksi DataConnection yang sudah terbuka (tanpa polling reconnect).
   */
  public pingPeer(rawTargetId: string): boolean {
    const targetSixDigitId = normalizePeerId(rawTargetId);
    if (this.destroyed || !targetSixDigitId || targetSixDigitId === this.profile.id) return false;
    const existing = this.connections.get(targetSixDigitId);
    if (existing && isConnectionLive(existing)) {
      const sent = this.sendSimplePing(existing);
      if (sent) {
        try {
          existing.send({
            kind: 'PING',
            fromId: this.profile.id,
            ts: Date.now(),
          } satisfies PeerPacket);
        } catch {
          // ignore legacy ping error if simple ping succeeded
        }
        return true;
      }
      this.connections.delete(targetSixDigitId);
      this.markPeerVerifiedOffline(targetSixDigitId);
    }
    return false;
  }

  /**
   * Mengirim gambar, foto kamera, video, dokumen, atau voice note dengan:
   * 1. Memastikan DataChannel aktif/terbuka (reconnect + await conn.on('open') maks 8 detik)
   * 2. Memecah Base64/DataURL menjadi potongan 8 KB (8192 karakter) dalam JSON.stringify(...)
   * 3. Flow control bufferedAmount > 65536 + jeda wajib 25 ms antar-chunk
   * 4. Konfirmasi FILE_ACK dari penerima + auto-retry 3 detik bila belum ada ACK
   */
  public sendFileChunked(rawTargetId: string, options: SendFileChunkedOptions): boolean {
    const targetSixDigitId = normalizePeerId(rawTargetId);
    if (!targetSixDigitId || targetSixDigitId === this.profile.id) return false;
    // Langsung masuk antrean eksekusi async agar ensureOpenConnection (timeout 8 detik) berjalan dulu
    void this.enqueueChunkedSend(targetSixDigitId, options, true);
    return this.isPeerOnline(targetSixDigitId);
  }

  /**
   * Versi Promise/async untuk menguras antrean outbox secara berurutan (1 file selesai baru lanjut berikutnya).
   */
  public sendFileChunkedAsync(
    rawTargetId: string,
    options: SendFileChunkedOptions,
    requeueOnFail = false
  ): Promise<boolean> {
    const targetSixDigitId = normalizePeerId(rawTargetId);
    if (!targetSixDigitId || targetSixDigitId === this.profile.id) return Promise.resolve(false);
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

  public markPeerRelayPreferred(rawTargetId: string): void {
    const cleanId = normalizePeerId(rawTargetId);
    if (cleanId) {
      this.relayPreferredPeers.add(cleanId);
    }
  }

  public isPeerRelayPreferred(rawTargetId: string): boolean {
    const cleanId = normalizePeerId(rawTargetId);
    return cleanId ? this.relayPreferredPeers.has(cleanId) : false;
  }

  public startMediaCall(
    rawTargetId: string,
    stream: MediaStream,
    metadata: Record<string, unknown>
  ): MediaConnection | null {
    const targetSixDigitId = normalizePeerId(rawTargetId);
    if (!this.peer || this.peer.destroyed || !this.peer.open || !targetSixDigitId) return null;

    // Pastikan localStream sudah siap dan memiliki minimal 1 track audio aktif sebelum peer.call()
    const audioTracks = stream?.getAudioTracks?.() || [];
    if (audioTracks.length === 0) {
      console.error('[WattappsAU WebRTC] startMediaCall dibatalkan: localStream tidak memiliki track audio.');
      return null;
    }
    audioTracks.forEach((track) => {
      track.enabled = true;
    });

    try {
      this.applyPeerIcePolicy(false);
    } catch {
      // ignore config patch error
    }
    try {
      const mediaCall = this.peer.call(toFullPeerId(targetSixDigitId), stream, {
        metadata,
      });
      if (mediaCall) {
        ensureLocalAudioTracksAttached(mediaCall, stream);
      }
      return mediaCall;
    } catch (err) {
      console.error('Failed to initiate media call:', err);
      return null;
    }
  }

  public answerMediaCall(
    mediaCall: MediaConnection,
    stream: MediaStream
  ): void {
    // Pastikan localStream sudah siap dan seluruh track audio mikrofon aktif sebelum call.answer()
    const audioTracks = stream?.getAudioTracks?.() || [];
    if (audioTracks.length === 0) {
      console.error('[WattappsAU WebRTC] answerMediaCall dibatalkan: localStream tidak memiliki track audio.');
      return;
    }
    audioTracks.forEach((track) => {
      track.enabled = true;
    });

    try {
      this.applyPeerIcePolicy(false);
    } catch {
      // ignore config patch error
    }
    mediaCall.answer(stream);
    ensureLocalAudioTracksAttached(mediaCall, stream);
  }

  public isPeerOnline(rawSixDigitId: string): boolean {
    const sixDigitId = normalizePeerId(rawSixDigitId);
    if (!sixDigitId) return false;
    return (
      this.verifiedOnlinePeers.has(sixDigitId) &&
      isConnectionLive(this.connections.get(sixDigitId))
    );
  }

  private cleanupPeer(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.openWatchdogs.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    this.openWatchdogs.clear();
    this.verifiedOnlinePeers.clear();
    this.peerTransports.clear();
    this.relayPreferredPeers.clear();
    this.relayFallbackAttempted.clear();
    this.lastConnectAttempt.clear();
    this.awaitingFileAcks.forEach((entry) => {
      if (entry.retryTimer !== null) {
        window.clearTimeout(entry.retryTimer);
      }
    });
    this.awaitingFileAcks.clear();
    this.openWaiters.clear();
    this.pongWaiters.clear();
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
