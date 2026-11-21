import Peer, { DataConnection, MediaConnection } from 'peerjs';
import { PeerConnectionState, PeerPacket, UserProfile } from '../types';

export const PEER_PREFIX = 'WA6-';

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

export interface PeerManagerCallbacks {
  onStatusChange: (state: PeerConnectionState, errorMessage?: string) => void;
  onPacket: (fromSixDigitId: string, packet: PeerPacket) => void;
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

export class WA6PeerManager {
  private peer: Peer | null = null;
  private profile: UserProfile;
  private callbacks: PeerManagerCallbacks;
  private connections = new Map<string, DataConnection>();
  private pendingQueues = new Map<string, PeerPacket[]>();
  private reconnectTimer: number | null = null;
  private destroyed = false;

  constructor(profile: UserProfile, callbacks: PeerManagerCallbacks) {
    this.profile = profile;
    this.callbacks = callbacks;
  }

  public updateProfile(profile: UserProfile): void {
    this.profile = profile;
    // Notify all currently connected peers of updated profile info
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
        // Target peer is simply offline; do not mark our own broker connection as failed
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

  private attachConnection(conn: DataConnection): void {
    const peerSixId = fromFullPeerId(conn.peer);

    const existing = this.connections.get(peerSixId);
    if (existing && existing !== conn && existing.open) {
      // Keep the already-open connection unless this one opens and replaces it
    }
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

      // Flush pending packets queued for this peer
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
    };

    if (conn.open) {
      onOpen();
    } else {
      conn.on('open', onOpen);
    }

    conn.on('data', (data) => {
      if (data && typeof data === 'object' && 'kind' in data) {
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

    // Queue non-ephemeral packets (skip typing indicators when offline)
    if (packet.kind !== 'TYPING') {
      const queue = this.pendingQueues.get(targetSixDigitId) || [];
      // Cap queue size per peer to prevent unbounded memory growth
      if (queue.length < 40) {
        queue.push(packet);
        this.pendingQueues.set(targetSixDigitId, queue);
      }
    }

    this.ensureConnection(targetSixDigitId);
    return false;
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
