import React from 'react';
import {
  Camera,
  Check,
  CheckCheck,
  FileText,
  Film,
  MessageSquarePlus,
  Mic,
  Ban,
} from 'lucide-react';
import { ChatMessage, Contact } from '../types';
import { formatChatListTime, formatSixDigitId } from '../lib/media';
import { Avatar } from './Avatar';

interface ChatListProps {
  contacts: Contact[];
  messages: ChatMessage[];
  myId: string;
  activeChatId: string | null;
  unreadCounts: Record<string, number>;
  onlinePeers: Record<string, boolean>;
  typingMap: Record<string, string>;
  searchQuery: string;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
}

export const ChatList: React.FC<ChatListProps> = ({
  contacts,
  messages,
  myId,
  activeChatId,
  unreadCounts,
  onlinePeers,
  typingMap,
  searchQuery,
  onSelectChat,
  onNewChat,
}) => {
  // Compute latest message per chat
  const lastMsgByChat = new Map<string, ChatMessage>();
  for (const m of messages) {
    const prev = lastMsgByChat.get(m.chatId);
    if (!prev || m.timestamp >= prev.timestamp) {
      lastMsgByChat.set(m.chatId, m);
    }
  }

  // Sort contacts by latest message timestamp (fallback to addedAt)
  const sortedContacts = [...contacts].sort((a, b) => {
    const timeA = lastMsgByChat.get(a.id)?.timestamp ?? a.addedAt;
    const timeB = lastMsgByChat.get(b.id)?.timestamp ?? b.addedAt;
    return timeB - timeA;
  });

  const query = searchQuery.trim().toLowerCase();
  const filteredContacts = sortedContacts.filter((c) => {
    if (!query) return true;
    if (c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query)) return true;
    const last = lastMsgByChat.get(c.id);
    if (last?.text?.toLowerCase().includes(query)) return true;
    if (last?.fileName?.toLowerCase().includes(query)) return true;
    return false;
  });

  const renderPreview = (chat: Contact, last?: ChatMessage) => {
    const typingWho = typingMap[chat.id];
    if (typingWho) {
      return (
        <span className="text-[#00A884] font-medium truncate">
          {chat.isGroup ? `${typingWho} sedang mengetik...` : 'Sedang mengetik...'}
        </span>
      );
    }

    if (!last) {
      return (
        <span className="text-[#667781] dark:text-[#8696A0] truncate">
          {chat.isGroup
            ? `Grup · ${chat.members?.length ?? 1} anggota`
            : `ID ${formatSixDigitId(chat.id)} · Ketuk untuk mengobrol`}
        </span>
      );
    }

    const isMine = last.senderId === myId;
    const prefix = chat.isGroup && !isMine ? `${last.senderName}: ` : '';

    return (
      <div className="flex items-center gap-1 min-w-0 text-[13px] text-[#667781] dark:text-[#8696A0]">
        {isMine && !last.deleted && (
          <span className="shrink-0 flex items-center">
            {last.status === 'read' ? (
              <CheckCheck className="w-4 h-4 text-[#53BDEB]" />
            ) : last.status === 'delivered' ? (
              <CheckCheck className="w-4 h-4 text-[#8696A0]" />
            ) : (
              <Check className="w-4 h-4 text-[#8696A0]" />
            )}
          </span>
        )}

        {last.deleted ? (
          <span className="inline-flex items-center gap-1 italic truncate">
            <Ban className="w-3.5 h-3.5 shrink-0" />
            Pesan ini telah dihapus
          </span>
        ) : last.type === 'image' ? (
          <span className="inline-flex items-center gap-1 truncate">
            <Camera className="w-3.5 h-3.5 shrink-0" />
            {prefix}
            {last.text || 'Foto'}
          </span>
        ) : last.type === 'video' ? (
          <span className="inline-flex items-center gap-1 truncate">
            <Film className="w-3.5 h-3.5 shrink-0" />
            {prefix}
            {last.text || 'Video'}
          </span>
        ) : last.type === 'document' ? (
          <span className="inline-flex items-center gap-1 truncate">
            <FileText className="w-3.5 h-3.5 shrink-0" />
            {prefix}
            {last.fileName || 'Dokumen'}
          </span>
        ) : last.type === 'voice' ? (
          <span className="inline-flex items-center gap-1 truncate">
            <Mic className="w-3.5 h-3.5 text-[#00A884] shrink-0" />
            {prefix}Pesan suara
          </span>
        ) : (
          <span className="truncate">
            {prefix}
            {last.text}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden">
      {filteredContacts.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center px-8 py-12 text-center">
          <div className="w-16 h-16 rounded-full bg-[#008069]/10 dark:bg-[#00A884]/15 flex items-center justify-center mb-4">
            <MessageSquarePlus className="w-7 h-7 text-[#008069] dark:text-[#00A884]" />
          </div>
          <h3 className="text-base font-semibold text-[#111B21] dark:text-[#E9EDEF]">
            {query ? 'Tidak ada hasil pencarian' : 'Mulai obrolan pertama Anda'}
          </h3>
          <p className="mt-1.5 text-sm text-[#667781] dark:text-[#8696A0] max-w-xs">
            {query
              ? `Tidak ditemukan chat yang cocok dengan "${searchQuery}".`
              : 'Tambahkan teman dengan memasukkan ID 6 digit mereka atau pindai kode QR.'}
          </p>
          {!query && (
            <button
              type="button"
              onClick={onNewChat}
              className="mt-5 h-11 px-5 rounded-full bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] text-white dark:text-[#111B21] text-sm font-semibold transition-colors cursor-pointer"
            >
              + Tambah Kontak / Chat Baru
            </button>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto wa-scroll pb-24">
          {filteredContacts.map((chat) => {
            const last = lastMsgByChat.get(chat.id);
            const unread = unreadCounts[chat.id] || 0;
            const isSelected = activeChatId === chat.id;
            const isOnline = !chat.isGroup && Boolean(onlinePeers[chat.id]);

            return (
              <button
                key={chat.id}
                type="button"
                onClick={() => onSelectChat(chat.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors cursor-pointer border-b border-black/[0.04] dark:border-white/[0.04] ${
                  isSelected
                    ? 'bg-[#F0F2F5] dark:bg-[#2A3942]'
                    : 'hover:bg-[#F5F6F6] dark:hover:bg-[#202C33]'
                }`}
              >
                <Avatar
                  src={chat.avatar}
                  name={chat.name}
                  size="lg"
                  isGroup={chat.isGroup}
                  isOnline={isOnline}
                />

                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[15px] font-semibold text-[#111B21] dark:text-[#E9EDEF] truncate">
                      {chat.name}
                    </span>
                    <span
                      className={`text-[11px] shrink-0 tabular-nums ${
                        unread > 0
                          ? 'text-[#00A884] font-semibold'
                          : 'text-[#667781] dark:text-[#8696A0]'
                      }`}
                    >
                      {last ? formatChatListTime(last.timestamp) : formatChatListTime(chat.addedAt)}
                    </span>
                  </div>

                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">{renderPreview(chat, last)}</div>
                    {unread > 0 && (
                      <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-[#25D366] dark:bg-[#00A884] text-white dark:text-[#111B21] text-[11px] font-bold flex items-center justify-center shrink-0 tabular-nums">
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* WhatsApp Floating Action Button (FAB) — Chat Baru */}
      <button
        type="button"
        onClick={onNewChat}
        className="absolute bottom-5 right-5 w-14 h-14 rounded-2xl bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] text-white dark:text-[#111B21] shadow-lg flex items-center justify-center active:scale-95 transition-transform cursor-pointer z-10"
        title="Chat Baru"
        aria-label="Chat Baru"
      >
        <MessageSquarePlus className="w-6 h-6" />
      </button>
    </div>
  );
};
