import React from 'react';
import {
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Trash2,
  Video,
} from 'lucide-react';
import { CallRecord, CallType } from '../types';
import { formatChatListTime, formatDuration, formatTime } from '../lib/media';
import { Avatar } from './Avatar';

interface CallsTabProps {
  calls: CallRecord[];
  searchQuery: string;
  onStartCall: (peerId: string, callType: CallType) => void;
  onClearCalls: () => void;
}

export const CallsTab: React.FC<CallsTabProps> = ({
  calls,
  searchQuery,
  onStartCall,
  onClearCalls,
}) => {
  const filtered = calls.filter((c) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return c.peerName.toLowerCase().includes(q) || c.peerId.includes(q);
  });

  if (calls.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-8 py-14 text-center">
        <div className="w-16 h-16 rounded-full bg-[#008069]/10 dark:bg-[#00A884]/15 flex items-center justify-center mb-4">
          <Phone className="w-7 h-7 text-[#008069] dark:text-[#00A884]" />
        </div>
        <h3 className="text-base font-semibold text-[#111B21] dark:text-[#E9EDEF]">
          Belum ada riwayat panggilan
        </h3>
        <p className="mt-1.5 text-sm text-[#667781] dark:text-[#8696A0] max-w-xs">
          Buka ruang chat teman dan ketuk ikon telepon atau video untuk memulai panggilan WebRTC gratis.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 text-xs font-semibold text-[#667781] dark:text-[#8696A0]">
        <span>Terbaru ({filtered.length})</span>
        <button
          type="button"
          onClick={onClearCalls}
          className="flex items-center gap-1 text-rose-600 dark:text-rose-400 hover:underline cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>Hapus riwayat</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto wa-scroll divide-y divide-black/5 dark:divide-white/5">
        {filtered.map((call) => {
          const isMissed = call.status === 'missed' || call.status === 'rejected';
          return (
            <div
              key={call.id}
              className="flex items-center gap-3 px-4 py-3 hover:bg-[#F5F6F6] dark:hover:bg-[#202C33] transition-colors"
            >
              <Avatar src={call.peerAvatar} name={call.peerName} size="lg" />

              <div className="flex-1 min-w-0">
                <div
                  className={`text-[15px] font-medium truncate ${
                    isMissed
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-[#111B21] dark:text-[#E9EDEF]'
                  }`}
                >
                  {call.peerName}
                </div>

                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-[#667781] dark:text-[#8696A0] tabular-nums">
                  {call.status === 'missed' ? (
                    <PhoneMissed className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                  ) : call.direction === 'incoming' ? (
                    <PhoneIncoming
                      className={`w-3.5 h-3.5 shrink-0 ${
                        isMissed ? 'text-rose-500' : 'text-[#00A884]'
                      }`}
                    />
                  ) : (
                    <PhoneOutgoing className="w-3.5 h-3.5 text-[#00A884] shrink-0" />
                  )}
                  <span className="truncate">
                    {formatChatListTime(call.timestamp)}, {formatTime(call.timestamp)}
                  </span>
                  {call.duration > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{formatDuration(call.duration)}</span>
                    </>
                  )}
                  {call.status === 'missed' && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>Tak terjawab</span>
                    </>
                  )}
                  {call.status === 'rejected' && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>Ditolak</span>
                    </>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={() => onStartCall(call.peerId, call.callType)}
                className="w-11 h-11 rounded-full flex items-center justify-center text-[#008069] dark:text-[#00A884] hover:bg-[#008069]/10 dark:hover:bg-[#00A884]/15 transition-colors cursor-pointer shrink-0"
                title={`Panggil balik (${call.callType === 'video' ? 'Video' : 'Suara'})`}
              >
                {call.callType === 'video' ? (
                  <Video className="w-5 h-5" />
                ) : (
                  <Phone className="w-5 h-5" />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
