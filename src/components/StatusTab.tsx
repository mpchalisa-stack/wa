import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Palette,
  Pencil,
  Plus,
  SendHorizontal,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import { StatusItem, UserProfile } from '../types';
import {
  STATUS_BG_COLORS,
  compressImageFile,
  formatChatListTime,
  formatTime,
} from '../lib/media';
import { Avatar } from './Avatar';

interface StatusTabProps {
  profile: UserProfile;
  statuses: StatusItem[];
  onPostTextStatus: (text: string, bgColor: string, fontClass: string) => void;
  onPostImageStatus: (mediaData: string, caption: string) => void;
  onMarkStatusViewed: (statusId: string) => void;
  onDeleteStatus: (statusId: string) => void;
  onReplyToStatus: (userId: string, statusText: string, replyText: string) => void;
  onOpenCameraForStatus: () => void;
}

const STATUS_FONTS = [
  { label: 'Normal', cls: 'font-sans font-semibold' },
  { label: 'Serif', cls: 'font-serif italic font-medium' },
  { label: 'Mono', cls: 'font-mono-id font-bold' },
];

export const StatusTab: React.FC<StatusTabProps> = ({
  profile,
  statuses,
  onPostTextStatus,
  onPostImageStatus,
  onMarkStatusViewed,
  onDeleteStatus,
  onReplyToStatus,
  onOpenCameraForStatus,
}) => {
  const [showTextComposer, setShowTextComposer] = useState(false);
  const [textDraft, setTextDraft] = useState('');
  const [bgIndex, setBgIndex] = useState(0);
  const [fontIndex, setFontIndex] = useState(0);

  // Story viewer state
  const [viewerGroupUserId, setViewerGroupUserId] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [replyText, setReplyText] = useState('');
  const [progress, setProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const now = Date.now();
  const activeStatuses = useMemo(
    () => statuses.filter((s) => s.expiresAt > now),
    [statuses, now]
  );

  const myStatuses = useMemo(
    () =>
      activeStatuses
        .filter((s) => s.userId === profile.id)
        .sort((a, b) => a.timestamp - b.timestamp),
    [activeStatuses, profile.id]
  );

  // Group contact statuses by userId
  const contactGroups = useMemo(() => {
    const map = new Map<string, StatusItem[]>();
    for (const s of activeStatuses) {
      if (s.userId === profile.id) continue;
      const arr = map.get(s.userId) || [];
      arr.push(s);
      map.set(s.userId, arr);
    }
    return Array.from(map.entries())
      .map(([userId, items]) => {
        items.sort((a, b) => a.timestamp - b.timestamp);
        const latest = items[items.length - 1];
        const hasUnviewed = items.some((i) => !i.viewed);
        return {
          userId,
          userName: latest.userName,
          userAvatar: latest.userAvatar,
          items,
          latestTimestamp: latest.timestamp,
          hasUnviewed,
        };
      })
      .sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  }, [activeStatuses, profile.id]);

  const viewingItems = useMemo(() => {
    if (!viewerGroupUserId) return [];
    if (viewerGroupUserId === profile.id) return myStatuses;
    return contactGroups.find((g) => g.userId === viewerGroupUserId)?.items || [];
  }, [viewerGroupUserId, profile.id, myStatuses, contactGroups]);

  const currentStory = viewingItems[viewerIndex];

  // Mark story viewed when shown
  useEffect(() => {
    if (currentStory && !currentStory.viewed && currentStory.userId !== profile.id) {
      onMarkStatusViewed(currentStory.id);
    }
  }, [currentStory, profile.id, onMarkStatusViewed]);

  // Auto-advance timer for story viewer
  useEffect(() => {
    if (!viewerGroupUserId || !currentStory || isPaused) return;
    setProgress(0);
    const stepMs = 50;
    const durationMs = 5500;
    const timer = window.setInterval(() => {
      setProgress((prev) => {
        const next = prev + (stepMs / durationMs) * 100;
        if (next >= 100) {
          if (viewerIndex < viewingItems.length - 1) {
            setViewerIndex((i) => i + 1);
          } else {
            setViewerGroupUserId(null);
          }
          return 0;
        }
        return next;
      });
    }, stepMs);

    return () => window.clearInterval(timer);
  }, [viewerGroupUserId, viewerIndex, viewingItems.length, currentStory, isPaused]);

  const handleGalleryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const dataUrl = await compressImageFile(file, 800, 0.65, 150 * 1024);
      onPostImageStatus(dataUrl, '');
    } catch {
      // ignore
    }
  };

  const handlePublishText = () => {
    const trimmed = textDraft.trim();
    if (!trimmed) return;
    onPostTextStatus(trimmed, STATUS_BG_COLORS[bgIndex], STATUS_FONTS[fontIndex].cls);
    setTextDraft('');
    setShowTextComposer(false);
  };

  const handleSendReply = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentStory || !replyText.trim()) return;
    onReplyToStatus(
      currentStory.userId,
      currentStory.text || currentStory.caption || 'Status foto',
      replyText.trim()
    );
    setReplyText('');
    setViewerGroupUserId(null);
  };

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto wa-scroll pb-28">
        {/* Status Saya */}
        <div className="px-4 py-3 flex items-center gap-3.5 hover:bg-[#F5F6F6] dark:hover:bg-[#202C33] transition-colors">
          <button
            type="button"
            onClick={() => {
              if (myStatuses.length > 0) {
                setViewerGroupUserId(profile.id);
                setViewerIndex(0);
              } else {
                fileInputRef.current?.click();
              }
            }}
            className="relative shrink-0 cursor-pointer"
          >
            <div
              className={`p-[2.5px] rounded-full ${
                myStatuses.length > 0
                  ? 'ring-2 ring-[#00A884]'
                  : 'ring-0'
              }`}
            >
              <Avatar src={profile.avatar} name={profile.name} size="lg" />
            </div>
            {myStatuses.length === 0 && (
              <span className="absolute -bottom-0.5 -right-0.5 w-6 h-6 rounded-full bg-[#00A884] text-white ring-2 ring-white dark:ring-[#111B21] flex items-center justify-center">
                <Plus className="w-3.5 h-3.5" strokeWidth={3} />
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              if (myStatuses.length > 0) {
                setViewerGroupUserId(profile.id);
                setViewerIndex(0);
              } else {
                setShowTextComposer(true);
              }
            }}
            className="flex-1 min-w-0 text-left cursor-pointer"
          >
            <div className="text-[15px] font-semibold text-[#111B21] dark:text-[#E9EDEF]">
              Status saya
            </div>
            <div className="text-xs text-[#667781] dark:text-[#8696A0] truncate">
              {myStatuses.length > 0
                ? `${myStatuses.length} pembaruan · ${formatTime(myStatuses[myStatuses.length - 1].timestamp)}`
                : 'Ketuk untuk menambahkan pembaruan status (24 jam)'}
            </div>
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-10 h-10 rounded-full flex items-center justify-center text-[#008069] dark:text-[#00A884] hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
            title="Unggah foto dari galeri"
          >
            <ImageIcon className="w-5 h-5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleGalleryUpload}
            className="hidden"
          />
        </div>

        {/* Pembaruan Kontak */}
        <div className="px-4 py-2 text-xs font-semibold text-[#667781] dark:text-[#8696A0] bg-[#F7F8FA] dark:bg-[#111B21] border-y border-black/5 dark:border-white/5">
          Pembaruan terkini
        </div>

        {contactGroups.length === 0 ? (
          <div className="px-8 py-12 text-center">
            <p className="text-sm text-[#667781] dark:text-[#8696A0]">
              Belum ada pembaruan status dari kontak yang terhubung. Status yang Anda buat akan otomatis disiarkan ke teman yang sedang online dan hilang setelah 24 jam.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-black/5 dark:divide-white/5">
            {contactGroups.map((group) => (
              <button
                key={group.userId}
                type="button"
                onClick={() => {
                  setViewerGroupUserId(group.userId);
                  setViewerIndex(0);
                }}
                className="w-full flex items-center gap-3.5 px-4 py-3 hover:bg-[#F5F6F6] dark:hover:bg-[#202C33] transition-colors text-left cursor-pointer"
              >
                <div
                  className={`p-[2.5px] rounded-full border-2 ${
                    group.hasUnviewed
                      ? 'border-[#25D366] dark:border-[#00A884]'
                      : 'border-[#8696A0]/45'
                  }`}
                >
                  <Avatar src={group.userAvatar} name={group.userName} size="md" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] font-semibold text-[#111B21] dark:text-[#E9EDEF] truncate">
                    {group.userName}
                  </div>
                  <div className="text-xs text-[#667781] dark:text-[#8696A0] tabular-nums">
                    {formatChatListTime(group.latestTimestamp)}, {formatTime(group.latestTimestamp)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Dual WhatsApp Status FABs: Pencil (Text Status) & Camera (Photo Status) */}
      <div className="absolute bottom-5 right-5 flex flex-col items-center gap-3 z-10">
        <button
          type="button"
          onClick={() => setShowTextComposer(true)}
          className="w-11 h-11 rounded-xl bg-[#E9EDEF] dark:bg-[#233138] hover:bg-[#DFE5E7] dark:hover:bg-[#2A3942] text-[#54656F] dark:text-[#E9EDEF] shadow-md flex items-center justify-center transition-transform active:scale-95 cursor-pointer"
          title="Buat status teks"
        >
          <Pencil className="w-5 h-5" />
        </button>
        <button
          type="button"
          onClick={onOpenCameraForStatus}
          className="w-14 h-14 rounded-2xl bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] text-white dark:text-[#111B21] shadow-lg flex items-center justify-center transition-transform active:scale-95 cursor-pointer"
          title="Status kamera"
        >
          <Camera className="w-6 h-6" />
        </button>
      </div>

      {/* Full-Screen WhatsApp Text Status Composer */}
      {showTextComposer && (
        <div
          style={{ backgroundColor: STATUS_BG_COLORS[bgIndex] }}
          className="fixed inset-0 z-[105] flex flex-col transition-colors duration-200"
        >
          <div className="flex items-center justify-between px-4 py-3 text-white">
            <button
              type="button"
              onClick={() => setShowTextComposer(false)}
              className="w-11 h-11 rounded-full flex items-center justify-center hover:bg-white/15 cursor-pointer"
            >
              <X className="w-6 h-6" />
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setFontIndex((i) => (i + 1) % STATUS_FONTS.length)}
                className="w-11 h-11 rounded-full flex items-center justify-center hover:bg-white/15 cursor-pointer"
                title="Ganti huruf"
              >
                <Type className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => setBgIndex((i) => (i + 1) % STATUS_BG_COLORS.length)}
                className="w-11 h-11 rounded-full flex items-center justify-center hover:bg-white/15 cursor-pointer"
                title="Ganti warna latar"
              >
                <Palette className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="flex-1 flex items-center justify-center px-6">
            <textarea
              value={textDraft}
              onChange={(e) => setTextDraft(e.target.value)}
              maxLength={300}
              placeholder="Ketik status..."
              autoFocus
              rows={4}
              className={`w-full max-w-lg bg-transparent text-white placeholder:text-white/55 text-center text-2xl sm:text-3xl resize-none focus:outline-none ${STATUS_FONTS[fontIndex].cls}`}
            />
          </div>

          <div className="px-6 py-5 pb-safe flex items-center justify-between">
            <span className="text-xs text-white/75">Bertahan 24 jam · Disiarkan ke kontak online</span>
            <button
              type="button"
              disabled={!textDraft.trim()}
              onClick={handlePublishText}
              className="w-14 h-14 rounded-full bg-[#00A884] hover:bg-[#06CF9C] disabled:opacity-40 text-white shadow-xl flex items-center justify-center cursor-pointer"
              aria-label="Kirim status"
            >
              <SendHorizontal className="w-6 h-6" />
            </button>
          </div>
        </div>
      )}

      {/* Full-Screen Story Viewer */}
      {viewerGroupUserId && currentStory && (
        <div
          className="fixed inset-0 z-[115] bg-black flex flex-col select-none"
          onMouseDown={() => setIsPaused(true)}
          onMouseUp={() => setIsPaused(false)}
          onTouchStart={() => setIsPaused(true)}
          onTouchEnd={() => setIsPaused(false)}
        >
          {/* Progress bars */}
          <div className="flex items-center gap-1.5 px-3 pt-3 z-20">
            {viewingItems.map((item, idx) => (
              <div key={item.id} className="flex-1 h-1 rounded-full bg-white/25 overflow-hidden">
                <div
                  className="h-full bg-white transition-[width] duration-75"
                  style={{
                    width:
                      idx < viewerIndex
                        ? '100%'
                        : idx === viewerIndex
                        ? `${progress}%`
                        : '0%',
                  }}
                />
              </div>
            ))}
          </div>

          {/* Story Header */}
          <div className="flex items-center justify-between px-4 py-3 text-white z-20">
            <div className="flex items-center gap-3 min-w-0">
              <Avatar src={currentStory.userAvatar} name={currentStory.userName} size="sm" />
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">
                  {currentStory.userId === profile.id ? 'Status saya' : currentStory.userName}
                </div>
                <div className="text-xs text-white/70 tabular-nums">
                  {formatChatListTime(currentStory.timestamp)}, {formatTime(currentStory.timestamp)}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {currentStory.userId === profile.id && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteStatus(currentStory.id);
                    if (viewingItems.length <= 1) {
                      setViewerGroupUserId(null);
                    } else {
                      setViewerIndex(0);
                    }
                  }}
                  className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-white/15 cursor-pointer"
                  title="Hapus status"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setViewerGroupUserId(null);
                }}
                className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-white/15 cursor-pointer"
                title="Tutup"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
          </div>

          {/* Story Body */}
          <div
            style={{
              backgroundColor:
                currentStory.type === 'text' ? currentStory.bgColor || '#008069' : '#000000',
            }}
            className="flex-1 relative flex items-center justify-center overflow-hidden px-6"
          >
            {currentStory.type === 'text' ? (
              <p
                className={`text-white text-center text-2xl sm:text-3xl max-w-lg leading-relaxed break-words ${
                  currentStory.fontClass || 'font-semibold'
                }`}
              >
                {currentStory.text}
              </p>
            ) : (
              <img
                src={currentStory.mediaData}
                alt={currentStory.caption || 'Status foto'}
                referrerPolicy="no-referrer"
                className="max-w-full max-h-full object-contain"
              />
            )}

            {/* Prev / Next Navigation Buttons */}
            {viewerIndex > 0 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setViewerIndex((i) => Math.max(0, i - 1));
                }}
                className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/35 text-white flex items-center justify-center hover:bg-black/55 cursor-pointer"
              >
                <ChevronLeft className="w-6 h-6" />
              </button>
            )}
            {viewerIndex < viewingItems.length - 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setViewerIndex((i) => Math.min(viewingItems.length - 1, i + 1));
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/35 text-white flex items-center justify-center hover:bg-black/55 cursor-pointer"
              >
                <ChevronRight className="w-6 h-6" />
              </button>
            )}
          </div>

          {/* Caption / Reply Bar */}
          <div
            className="px-4 py-4 pb-safe bg-black/70 z-20"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            {currentStory.caption && (
              <p className="text-center text-sm text-white mb-3">{currentStory.caption}</p>
            )}
            {currentStory.userId !== profile.id && (
              <form onSubmit={handleSendReply} className="max-w-md mx-auto flex items-center gap-2">
                <input
                  type="text"
                  value={replyText}
                  onFocus={() => setIsPaused(true)}
                  onBlur={() => setIsPaused(false)}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Balas status..."
                  className="flex-1 h-11 px-4 rounded-full bg-white/15 text-white placeholder:text-white/60 text-sm focus:outline-none focus:bg-white/20"
                />
                <button
                  type="submit"
                  disabled={!replyText.trim()}
                  className="w-11 h-11 rounded-full bg-[#00A884] text-white disabled:opacity-40 flex items-center justify-center cursor-pointer"
                >
                  <SendHorizontal className="w-5 h-5" />
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
