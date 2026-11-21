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

export type MessageType = 'text' | 'image' | 'video' | 'document' | 'voice';
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read';

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
  mediaData?: string; // Base64 Data URL for image, video, document, or voice
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  duration?: number; // Seconds for voice note
  timestamp: number;
  status: MessageStatus;
  replyTo?: ReplyPreview;
  deleted?: boolean;
  isGroup?: boolean;
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

export type PeerPacket =
  | {
      kind: 'HELLO';
      profile: { id: string; name: string; bio: string; avatar: string };
    }
  | {
      kind: 'MESSAGE';
      message: ChatMessage;
      groupMeta?: {
        id: string;
        name: string;
        avatar: string;
        members: string[];
        memberNames: Record<string, string>;
        adminId: string;
      };
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
      kind: 'CALL_SIGNAL';
      action: 'ringing' | 'accept' | 'reject' | 'end' | 'busy';
      callId: string;
      callType: CallType;
      fromId: string;
      fromName: string;
      fromAvatar: string;
    };
