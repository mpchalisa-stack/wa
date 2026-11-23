export type ThemeMode = 'light' | 'dark';

export type NavTab = 'chats' | 'status' | 'calls';

export type PeerConnectionState = 'connecting' | 'online' | 'disconnected' | 'error';

export interface UserProfile {
  id: string; // 6-digit numeric string, e.g. "482910"
  name: string;
  bio: string;
  avatar: string; // Data URL or preset avatar identifier
  createdAt: number;
}

export interface Contact {
  id: string; // 6-digit ID for 1:1 chats, or "GRP-xxxxxx" for groups
  name: string;
  bio: string;
  avatar: string;
  addedAt: number;
  isGroup?: boolean;
  members?: string[]; // List of 6-digit member IDs for groups
  memberNames?: Record<string, string>;
  adminId?: string;
  lastSeen?: number;
}

export type MessageType = 'text' | 'image' | 'video' | 'document' | 'voice' | 'call_log';
export type MessageStatus = 'pending' | 'sending' | 'sent' | 'delivered' | 'read';

export interface CallLogMeta {
  callId: string;
  callType: CallType;
  direction: CallDirection;
  status: CallRecordStatus;
  duration: number; // Seconds
}

export interface ReplyPreview {
  id: string;
  senderId: string;
  senderName: string;
  type: MessageType;
  text: string;
}

export interface ChatMessage {
  id: string;
  chatId: string; // Peer 6-digit ID or Group ID
  senderId: string; // 6-digit ID of sender
  senderName: string;
  type: MessageType;
  text?: string;
  mediaId?: string; // Reference key in IndexedDB `media` store
  mediaData?: string; // Base64 Data URL for image, video, document, or voice
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  duration?: number; // Seconds for voice note
  timestamp: number;
  status: MessageStatus;
  transferProgress?: number; // 0-100 while chunking/sending until Centang 2 (delivered/read)
  transferWaitingPeer?: boolean; // True when target peer is offline and transfer is queued
  replyTo?: ReplyPreview;
  deleted?: boolean;
  isGroup?: boolean;
  callLog?: CallLogMeta;
}

export interface StatusItem {
  id: string;
  userId: string;
  userName: string;
  userAvatar: string;
  type: 'text' | 'image';
  text?: string;
  bgColor?: string;
  fontClass?: string;
  mediaData?: string;
  caption?: string;
  timestamp: number;
  expiresAt: number;
  viewed: boolean;
}

export type CallType = 'audio' | 'video';
export type CallDirection = 'incoming' | 'outgoing';
export type CallRecordStatus = 'answered' | 'missed' | 'rejected';

export interface CallRecord {
  id: string;
  peerId: string;
  peerName: string;
  peerAvatar: string;
  callType: CallType;
  direction: CallDirection;
  status: CallRecordStatus;
  timestamp: number;
  duration: number; // Seconds
}

export interface GroupMeta {
  id: string;
  name: string;
  avatar: string;
  members: string[];
  memberNames: Record<string, string>;
  adminId: string;
}

export interface PendingOutboxMessage {
  id: string; // `${messageId}:${recipientId}`
  messageId: string;
  recipientId: string; // Target 6-digit peer ID
  chatId: string;
  createdAt: number;
  groupMeta?: GroupMeta;
}

export interface ChunkMessageMeta {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  msgType: 'image' | 'video' | 'document' | 'voice';
  text?: string;
  duration?: number;
  timestamp: number;
  replyTo?: ReplyPreview;
  isGroup?: boolean;
  groupMeta?: GroupMeta;
}

export interface ChunkStatusMeta {
  id: string;
  userId: string;
  userName: string;
  userAvatar: string;
  caption?: string;
  timestamp: number;
  expiresAt: number;
}

/**
 * Paket JSON Chunking WebRTC (8 KB / 8192 karakter per FILE_CHUNK, dikirim sebagai JSON string)
 * untuk seluruh pengiriman gambar, foto kamera, video, dokumen, voice note, dan foto status.
 */
export type FileChunkPacket =
  | {
      type: 'FILE_START';
      fileId: string;
      messageId?: string;
      fileName: string;
      fileType: string;
      fileSize: number;
      totalChunks: number;
      messageMeta?: ChunkMessageMeta;
      statusMeta?: ChunkStatusMeta;
    }
  | {
      type: 'FILE_CHUNK';
      fileId: string;
      chunkIndex: number;
      data: string;
    }
  | {
      type: 'FILE_END';
      fileId: string;
      messageId?: string;
      missingChunks?: number[];
    }
  | {
      type: 'FILE_ACK';
      fileId: string;
      messageId?: string;
    }
  | {
      type: 'FILE_MISSING_CHUNKS';
      fileId: string;
      messageId?: string;
      missingChunks: number[];
    };

export type PeerPacket =
  | {
      kind: 'HELLO';
      profile: { id: string; name: string; bio: string; avatar: string };
    }
  | {
      kind: 'MESSAGE';
      message: ChatMessage;
      groupMeta?: GroupMeta;
    }
  | {
      kind: 'MSG_ACK';
      messageId: string;
      chatId: string;
      fromId: string;
    }
  | {
      kind: 'DELIVERY_ACK';
      messageId: string;
      chatId: string;
      fromId: string;
    }
  | {
      kind: 'READ_ACK';
      chatId: string;
      messageIds: string[];
      fromId: string;
    }
  | {
      kind: 'PING';
      fromId: string;
      ts: number;
    }
  | {
      kind: 'PONG';
      fromId: string;
      ts: number;
    }
  | {
      kind: 'TYPING';
      chatId: string;
      fromId: string;
      fromName: string;
      isTyping: boolean;
    }
  | {
      kind: 'DELETE_MSG';
      chatId: string;
      messageId: string;
      fromId: string;
    }
  | {
      kind: 'STATUS_UPDATE';
      status: StatusItem;
    }
  | {
      kind: 'GROUP_INVITE';
      group: Contact;
    }
  | {
      kind: 'CALL_INVITE';
      callId: string;
      callType: CallType;
      fromId: string;
      fromName: string;
      fromAvatar: string;
    }
  | {
      kind: 'CALL_REQUEST';
      callId: string;
      callType: CallType;
      fromId: string;
      fromName: string;
      fromAvatar: string;
    }
  | {
      kind: 'CALL_SIGNAL';
      action: 'ringing' | 'accept' | 'reject' | 'end' | 'busy';
      callId: string;
      callType: CallType;
      fromId: string;
      fromName: string;
      fromAvatar: string;
    };

export type WirePacket = PeerPacket | FileChunkPacket;
