import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Ban,
  Camera,
  Check,
  CheckCheck,
  ChevronDown,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Hourglass,
  Image as ImageIcon,
  Loader2,
  MapPin,
  Mic,
  MoreVertical,
  Paperclip,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Play,
  Reply,
  SendHorizontal,
  Smile,
  Trash2,
  Users,
  Video,
  X,
} from 'lucide-react';
import { CallType, ChatMessage, Contact, LocationMeta, ReplyPreview, UserProfile } from '../types';
import {
  compressImageFile,
  estimateDataUrlBytes,
  fileToDataUrl,
  formatDateSeparator,
  formatDuration,
  formatFileSize,
  formatSixDigitId,
  formatTime,
  getSenderColor,
  resolveMimeTypeForFile,
  triggerDownload,
} from '../lib/media';
import { Avatar } from './Avatar';
import { VoiceNoteBubble } from './VoiceNoteBubble';
import { LightboxMedia } from './MediaLightbox';
import {
  LocationPickerModal,
  buildExternalMapUrl,
  buildOpenStreetMapEmbedUrl,
} from './LocationPickerModal';
import { activateActiveMediaSession, releaseActiveMediaSession } from '../lib/standby';
import type { PeerTransportMode } from '../lib/peerManager';

interface ChatRoomProps {
  profile: UserProfile;
  contact: Contact;
  messages: ChatMessage[];
  isPeerOnline: boolean;
  peerTransport?: PeerTransportMode | null;
  typingUserName?: string;
  onBack: () => void;
  onSendText: (text: string, replyTo?: ReplyPreview) => void;
  onSendMedia: (payload: {
    type: 'image' | 'video' | 'document' | 'voice';
    mediaData: string;
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
    text?: string;
    duration?: number;
    replyTo?: ReplyPreview;
  }) => void;
  onSendLocation: (location: LocationMeta, replyTo?: ReplyPreview) => void;
  onDeleteMessage: (messageId: string, forEveryone: boolean) => void;
  onClearChat: (chatId: string) => void;
  onDeleteContact: (chatId: string) => void;
  onTyping: (isTyping: boolean) => void;
  onStartCall: (peerId: string, callType: CallType) => void;
  onOpenCamera: () => void;
  onOpenLightbox: (media: LightboxMedia) => void;
  onToast: (msg: string) => void;
}

const EMOJI_CATEGORIES = [
  {
    name: 'Sering',
    emojis: ['😀', '😂', '🤣', '😊', '😍', '🥰', '😎', '🤔', '😭', '🙏', '👍', '❤️', '🔥', '✨', '🎉', '👏', '🤝', '👌', '💯', '😅'],
  },
  {
    name: 'Ekspresi',
    emojis: ['😁', '😉', '😌', '😋', '😜', '🤪', '🤩', '🥳', '😏', '😒', '😔', '😢', '😤', '🤯', '😱', '😴', '🤒', '🤗', '🤭', '🫡'],
  },
  {
    name: 'Simbol',
    emojis: ['✅', '❌', '⭐', '⚡', '💡', '📌', '📎', '📞', '📷', '🎥', '🎵', '☕', '🍕', '🚀', '🌍', '🏠', '💼', '🎁', '🏆', '💚'],
  },
];

export const ChatRoom: React.FC<ChatRoomProps> = ({
  profile,
  contact,
  messages,
  isPeerOnline,
  peerTransport,
  typingUserName,
  onBack,
  onSendText,
  onSendMedia,
  onSendLocation,
  onDeleteMessage,
  onClearChat,
  onDeleteContact,
  onTyping,
  onStartCall,
  onOpenCamera,
  onOpenLightbox,
  onToast,
}) => {
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<ReplyPreview | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [emojiTab, setEmojiTab] = useState(0);
  const [showAttach, setShowAttach] = useState(false);
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [showInfoSheet, setShowInfoSheet] = useState(false);
  const [activeMsgMenuId, setActiveMsgMenuId] = useState<string | null>(null);
  const [downloadingMsgId, setDownloadingMsgId] = useState<string | null>(null);

  // Voice Note Recorder state
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [waveLevels, setWaveLevels] = useState<number[]>(Array(18).fill(20));

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recordAudioCtxRef = useRef<AudioContext | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const waveRafRef = useRef<number | null>(null);
  const recordSecondsRef = useRef(0);
  const cancelRecordingFlagRef = useRef(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, contact.id]);

  // Reset UI popovers when switching chat
  useEffect(() => {
    setReplyTo(null);
    setShowEmoji(false);
    setShowAttach(false);
    setShowHeaderMenu(false);
    setActiveMsgMenuId(null);
  }, [contact.id]);

  // Clean up voice recording on unmount
  useEffect(() => {
    return () => {
      cleanupRecorderResources();
    };
  }, []);

  const cleanupRecorderResources = () => {
    if (recordTimerRef.current !== null) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (waveRafRef.current !== null) {
      cancelAnimationFrame(waveRafRef.current);
      waveRafRef.current = null;
    }
    if (recordAudioCtxRef.current) {
      const ctx = recordAudioCtxRef.current;
      recordAudioCtxRef.current = null;
      try {
        if (ctx.state !== 'closed') {
          void ctx.close().catch(() => {});
        }
      } catch {
        // ignore
      }
    }
    if (recordStreamRef.current) {
      recordStreamRef.current.getTracks().forEach((t) => t.stop());
      recordStreamRef.current = null;
    }
    releaseActiveMediaSession('vox');
  };

  const handleTextChange = (val: string) => {
    setText(val);
    onTyping(val.trim().length > 0);
    if (typingTimeoutRef.current !== null) {
      window.clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = window.setTimeout(() => {
      onTyping(false);
    }, 2200);
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSendText(trimmed, replyTo ?? undefined);
    setText('');
    setReplyTo(null);
    setShowEmoji(false);
    onTyping(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleGallerySelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setShowAttach(false);
    if (!file) return;

    if (file.size > 12 * 1024 * 1024) {
      onToast('Ukuran file maksimal 12 MB untuk transfer langsung.');
      return;
    }

    try {
      if (file.type.startsWith('image/')) {
        const compressed = await compressImageFile(file, 900, 0.7, 200 * 1024);
        const compressedBytes = estimateDataUrlBytes(compressed);
        onSendMedia({
          type: 'image',
          mediaData: compressed,
          fileName: file.name.replace(/\.[^.]+$/, '') + '.jpg',
          fileSize: compressedBytes,
          mimeType: 'image/jpeg',
          replyTo: replyTo ?? undefined,
        });
      } else if (file.type.startsWith('video/')) {
        const dataUrl = await fileToDataUrl(file);
        onSendMedia({
          type: 'video',
          mediaData: dataUrl,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          replyTo: replyTo ?? undefined,
        });
      } else {
        const dataUrl = await fileToDataUrl(file);
        onSendMedia({
          type: 'document',
          mediaData: dataUrl,
          fileName: file.name,
          fileSize: file.size,
          mimeType: resolveMimeTypeForFile(file.name, file.type),
          replyTo: replyTo ?? undefined,
        });
      }
      setReplyTo(null);
    } catch {
      onToast('Gagal memproses file galeri.');
    }
  };



  const handleDocumentSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setShowAttach(false);
    if (!file) return;

    if (file.size > 12 * 1024 * 1024) {
      onToast('Ukuran dokumen maksimal 12 MB agar lancar dikirim.');
      return;
    }

    try {
      const dataUrl = await fileToDataUrl(file);
      onSendMedia({
        type: 'document',
        mediaData: dataUrl,
        fileName: file.name,
        fileSize: file.size,
        mimeType: resolveMimeTypeForFile(file.name, file.type),
        replyTo: replyTo ?? undefined,
      });
      setReplyTo(null);
    } catch {
      onToast('Gagal membaca dokumen.');
    }
  };

  const startVoiceRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordStreamRef.current = stream;
      cancelRecordingFlagRef.current = false;
      audioChunksRef.current = [];
      recordSecondsRef.current = 0;
      setRecordSeconds(0);
      setIsRecording(true);
      setShowAttach(false);
      setShowEmoji(false);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : '';

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };

      recorder.onstop = async () => {
        cleanupRecorderResources();
        setIsRecording(false);
        if (cancelRecordingFlagRef.current || audioChunksRef.current.length === 0) return;
        const blob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        try {
          const dataUrl = await fileToDataUrl(blob);
          onSendMedia({
            type: 'voice',
            mediaData: dataUrl,
            mimeType: blob.type,
            fileSize: blob.size,
            duration: Math.max(1, recordSecondsRef.current),
            replyTo: replyTo ?? undefined,
          });
          setReplyTo(null);
        } catch {
          onToast('Gagal menyimpan pesan suara.');
        }
      };

      recorder.start();
      activateActiveMediaSession({
        mode: 'vox',
        statusText: 'Transmisi VOX Aktif',
        peerName: contact.name,
        onEndOrPause: () => stopVoiceRecording(false),
      });

      // Timer
      recordTimerRef.current = window.setInterval(() => {
        recordSecondsRef.current += 1;
        setRecordSeconds(recordSecondsRef.current);
      }, 1000);

      // Live Web Audio Waveform Visualizer (ditutup penuh di cleanupRecorderResources agar tidak menahan fokus audio)
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx();
        recordAudioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);
        const dataArr = new Uint8Array(analyser.frequencyBinCount);

        const updateWave = () => {
          if (!recordAudioCtxRef.current) return;
          analyser.getByteFrequencyData(dataArr);
          const avg = dataArr.reduce((acc, v) => acc + v, 0) / Math.max(1, dataArr.length);
          const barVal = Math.min(100, Math.max(16, Math.round((avg / 140) * 100)));
          setWaveLevels((prev) => [...prev.slice(1), barVal]);
          waveRafRef.current = requestAnimationFrame(updateWave);
        };
        waveRafRef.current = requestAnimationFrame(updateWave);
      } catch {
        // Fallback gentle wave animation if AudioContext unavailable
      }
    } catch {
      onToast('Izin mikrofon diperlukan untuk merekam pesan suara.');
    }
  };

  const stopVoiceRecording = (cancel: boolean) => {
    cancelRecordingFlagRef.current = cancel;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      cleanupRecorderResources();
      setIsRecording(false);
    }
  };

  // Group messages with date dividers
  const renderedItems = useMemo(() => {
    const out: Array<
      | { kind: 'date'; label: string; key: string }
      | { kind: 'msg'; msg: ChatMessage; showTail: boolean }
    > = [];
    let lastDateStr = '';
    let prevSender = '';

    for (const m of messages) {
      const dateStr = formatDateSeparator(m.timestamp);
      if (dateStr !== lastDateStr) {
        out.push({ kind: 'date', label: dateStr, key: `date-${m.id}` });
        lastDateStr = dateStr;
        prevSender = '';
      }
      const showTail = m.type !== 'call_log' && m.senderId !== prevSender;
      out.push({ kind: 'msg', msg: m, showTail });
      prevSender = m.type === 'call_log' ? '' : m.senderId;
    }
    return out;
  }, [messages]);

  const statusSubtitle = typingUserName
    ? contact.isGroup
      ? `${typingUserName} sedang mengetik...`
      : 'Sedang mengetik...'
    : contact.isGroup
    ? `${contact.members?.length || 1} anggota · Grup P2P`
    : isPeerOnline
    ? 'Online'
    : 'Offline';

  const handleDownloadDocument = async (msg: ChatMessage) => {
    if (!msg.mediaData || downloadingMsgId === msg.id) return;
    const targetName = msg.fileName || 'dokumen-wattappsau';
    setDownloadingMsgId(msg.id);
    try {
      const result = await triggerDownload(msg.mediaData, targetName, msg.mimeType);
      if (result.ok) {
        if (result.method === 'android_bridge') {
          onToast(`Tersimpan di folder Download: ${targetName}`);
        } else if (result.method === 'web_share') {
          onToast(`Membuka opsi simpan/buka untuk ${targetName}`);
        } else {
          onToast(`Unduhan dimulai: ${targetName}`);
        }
      } else {
        onToast(result.error || `Gagal mengunduh ${targetName}`);
      }
    } catch {
      onToast(`Gagal mengunduh ${targetName}`);
    } finally {
      window.setTimeout(() => {
        setDownloadingMsgId((prev) => (prev === msg.id ? null : prev));
      }, 600);
    }
  };

  const handleOpenDocumentCard = (msg: ChatMessage) => {
    if (!msg.mediaData) return;
    const lowerName = (msg.fileName || '').toLowerCase();
    const mime = (msg.mimeType || '').toLowerCase();
    const isImageDoc =
      mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(lowerName);
    const isVideoDoc =
      mime.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(lowerName);

    if (isImageDoc || isVideoDoc) {
      onOpenLightbox({
        type: isVideoDoc ? 'video' : 'image',
        src: msg.mediaData,
        senderName: msg.senderId === profile.id ? 'Anda' : msg.senderName,
        timestamp: msg.timestamp,
        caption: msg.fileName,
        fileName: msg.fileName,
      });
      return;
    }

    void handleDownloadDocument(msg);
  };

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 relative overflow-hidden">
      {/* Chat Room Header (WhatsApp Authentic) */}
      <header
        className="min-h-[calc(60px+max(36px,env(safe-area-inset-top,0px)))] bg-[#008069] dark:bg-[#202C33] text-white md:bg-[#F0F2F5] md:text-[#111B21] md:dark:bg-[#202C33] md:dark:text-[#E9EDEF] px-2 sm:px-4 pb-1.5 flex items-center justify-between gap-2 border-b border-black/5 dark:border-white/5 shrink-0 relative z-30 pt-safe-header"
        style={{ paddingTop: 'max(36px, env(safe-area-inset-top, 0px))' }}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1 relative z-30">
          <button
            type="button"
            onClick={onBack}
            className="md:hidden relative z-30 pointer-events-auto w-10 h-10 rounded-full flex items-center justify-center hover:bg-white/10 shrink-0 cursor-pointer"
            aria-label="Kembali ke daftar chat"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => setShowInfoSheet(true)}
            className="flex items-center gap-3 min-w-0 flex-1 text-left py-1 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
          >
            <Avatar
              src={contact.avatar}
              name={contact.name}
              size="md"
              isGroup={contact.isGroup}
              isOnline={!contact.isGroup && isPeerOnline}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-[15px] font-semibold truncate leading-tight">{contact.name}</h2>
                {!contact.isGroup && (
                  <span className="hidden sm:inline font-mono-id text-[11px] opacity-70 shrink-0">
                    {formatSixDigitId(contact.id)}
                  </span>
                )}
              </div>
              <div
                className={`text-xs truncate leading-tight ${
                  typingUserName
                    ? 'text-[#D9FDD3] md:text-[#00A884] font-medium'
                    : 'text-white/80 md:text-[#667781] md:dark:text-[#8696A0]'
                }`}
              >
                {statusSubtitle}
              </div>
              {!contact.isGroup && isPeerOnline && peerTransport && (
                <div
                  className={`text-[10px] font-medium truncate leading-tight ${
                    peerTransport === 'relay'
                      ? 'text-amber-200 md:text-amber-600 md:dark:text-amber-400'
                      : 'text-emerald-200 md:text-[#008069] md:dark:text-[#00A884]'
                  }`}
                >
                  {peerTransport === 'relay' ? 'Terhubung Relay' : 'Terhubung P2P'}
                </div>
              )}
            </div>
          </button>
        </div>

        {/* Right Call & Menu Controls */}
        <div className="relative z-30 pointer-events-auto flex items-center gap-0.5 shrink-0">
          {!contact.isGroup && (
            <>
              <button
                type="button"
                onClick={() => onStartCall(contact.id, 'video')}
                className="relative z-30 pointer-events-auto w-10 h-10 rounded-full flex items-center justify-center hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer"
                title="Panggilan Video"
              >
                <Video className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => onStartCall(contact.id, 'audio')}
                className="relative z-30 pointer-events-auto w-10 h-10 rounded-full flex items-center justify-center hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer"
                title="Panggilan Suara"
              >
                <Phone className="w-5 h-5" />
              </button>
            </>
          )}

          <div className="relative z-30 pointer-events-auto">
            <button
              type="button"
              onClick={() => setShowHeaderMenu((prev) => !prev)}
              className="relative z-30 pointer-events-auto w-10 h-10 rounded-full flex items-center justify-center hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer"
              aria-label="Menu obrolan"
            >
              <MoreVertical className="w-5 h-5" />
            </button>

            {showHeaderMenu && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setShowHeaderMenu(false)} />
                <div className="absolute right-0 mt-1 w-48 rounded-xl bg-white dark:bg-[#233138] shadow-xl border border-black/10 dark:border-white/10 py-1.5 z-40 text-[#111B21] dark:text-[#E9EDEF]">
                  <button
                    type="button"
                    onClick={() => {
                      setShowHeaderMenu(false);
                      setShowInfoSheet(true);
                    }}
                    className="w-full px-4 py-2.5 text-left text-sm hover:bg-[#F5F6F6] dark:hover:bg-[#182229] cursor-pointer"
                  >
                    {contact.isGroup ? 'Info Grup' : 'Info Kontak'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowHeaderMenu(false);
                      onClearChat(contact.id);
                    }}
                    className="w-full px-4 py-2.5 text-left text-sm hover:bg-[#F5F6F6] dark:hover:bg-[#182229] cursor-pointer"
                  >
                    Bersihkan chat
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowHeaderMenu(false);
                      onDeleteContact(contact.id);
                    }}
                    className="w-full px-4 py-2.5 text-left text-sm text-rose-600 dark:text-rose-400 hover:bg-[#F5F6F6] dark:hover:bg-[#182229] cursor-pointer"
                  >
                    {contact.isGroup ? 'Hapus grup' : 'Hapus kontak'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Message Feed with Tactical Military (Komlek / Diskomlekau) Background */}
      <div
        className="flex-1 overflow-y-auto wa-scroll chat-bg-tactical px-3 sm:px-8 lg:px-14 py-4 space-y-1.5"
        onClick={() => {
          setActiveMsgMenuId(null);
          setShowAttach(false);
        }}
      >
        {/* P2P Encryption Notice */}
        <div className="flex justify-center mb-3">
          <div className="max-w-md text-center px-3.5 py-1.5 rounded-lg bg-[#182229]/95 border border-[#38bdf8]/15 text-[#E9EDEF]/90 dark:text-[#FFD279] text-[11.5px] shadow-xs">
            Pesan dan panggilan dikirim langsung antar perangkat (WebRTC Peer-to-Peer) dan hanya disimpan secara lokal di perangkat Anda.
          </div>
        </div>

        {renderedItems.map((entry) => {
          if (entry.kind === 'date') {
            return (
              <div key={entry.key} className="flex justify-center my-3">
                <span className="px-3 py-1 rounded-lg bg-[#182229]/95 border border-[#38bdf8]/12 text-[#CBD5E1] dark:text-[#8696A0] text-[11.5px] font-medium shadow-xs">
                  {entry.label}
                </span>
              </div>
            );
          }

          const { msg, showTail } = entry;

          // Gelembung Log Riwayat Panggilan Sistem di Dalam Ruang Chat
          if (msg.type === 'call_log' && msg.callLog) {
            const { callLog } = msg;
            const isVideoCall = callLog.callType === 'video';
            const isMissedOrRejected =
              callLog.status === 'missed' || callLog.status === 'rejected';
            const isOutgoingAnswered =
              callLog.status === 'answered' && callLog.direction === 'outgoing';

            const callTitle = isMissedOrRejected
              ? isVideoCall
                ? 'Panggilan video tak terjawab'
                : 'Panggilan suara tak terjawab'
              : isOutgoingAnswered
              ? isVideoCall
                ? 'Panggilan video keluar'
                : 'Panggilan suara keluar'
              : isVideoCall
              ? 'Panggilan video masuk'
              : 'Panggilan suara masuk';

            const iconToneClass = isMissedOrRejected
              ? 'bg-rose-500/15 border-rose-500/35 text-rose-400'
              : isOutgoingAnswered
              ? 'bg-emerald-500/15 border-emerald-500/35 text-[#25D366]'
              : 'bg-sky-500/15 border-sky-500/35 text-[#38bdf8]';

            const titleToneClass = isMissedOrRejected
              ? 'text-rose-300'
              : isOutgoingAnswered
              ? 'text-[#D9FDD3]'
              : 'text-sky-200';

            return (
              <div key={msg.id} className="flex justify-center my-2.5">
                <div className="w-full max-w-[320px] rounded-xl bg-[#182229]/95 border border-[#38bdf8]/15 shadow-md px-3 py-2.5 flex items-center gap-3 text-[#E9EDEF]">
                  <div
                    className={`w-10 h-10 rounded-full border flex items-center justify-center shrink-0 ${iconToneClass}`}
                  >
                    {isVideoCall ? (
                      <Video className="w-4 h-4" />
                    ) : isMissedOrRejected ? (
                      <PhoneMissed className="w-4 h-4" />
                    ) : isOutgoingAnswered ? (
                      <PhoneOutgoing className="w-4 h-4" />
                    ) : (
                      <PhoneIncoming className="w-4 h-4" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className={`text-[13px] font-semibold leading-tight truncate ${titleToneClass}`}>
                      {callTitle}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#8696A0] tabular-nums">
                      {!isMissedOrRejected && callLog.duration > 0 && (
                        <>
                          <span className="font-mono-id text-[#CBD5E1]">
                            {formatDuration(callLog.duration)}
                          </span>
                          <span>·</span>
                        </>
                      )}
                      <span>{formatTime(msg.timestamp)}</span>
                    </div>
                  </div>

                  {!contact.isGroup && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onStartCall(contact.id, callLog.callType);
                      }}
                      className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#00A884]/15 hover:bg-[#00A884]/25 border border-[#00A884]/40 text-[#25D366] text-[11px] font-semibold transition-colors cursor-pointer"
                      title={`Panggil lagi (${isVideoCall ? 'Video' : 'Suara'})`}
                    >
                      {isVideoCall ? (
                        <Video className="w-3.5 h-3.5" />
                      ) : (
                        <Phone className="w-3.5 h-3.5" />
                      )}
                      <span>Panggil Lagi</span>
                    </button>
                  )}
                </div>
              </div>
            );
          }

          const isMine = msg.senderId === profile.id;

          return (
            <div
              key={msg.id}
              className={`flex ${isMine ? 'justify-end' : 'justify-start'} ${
                showTail ? 'mt-2' : 'mt-0.5'
              }`}
            >
              <div
                className={`group relative max-w-[85%] sm:max-w-[70%] lg:max-w-[60%] rounded-lg px-2.5 pt-1.5 pb-1.5 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] ${
                  isMine
                    ? 'bg-[#D9FDD3] dark:bg-[#005C4B] text-[#111B21] dark:text-[#E9EDEF]'
                    : 'bg-white dark:bg-[#202C33] text-[#111B21] dark:text-[#E9EDEF]'
                } ${showTail ? (isMine ? 'rounded-tr-none' : 'rounded-tl-none') : ''}`}
              >
                {/* Authentic WhatsApp Bubble Tail SVG */}
                {showTail && (
                  <svg
                    viewBox="0 0 8 13"
                    width="8"
                    height="13"
                    className={`absolute top-0 ${
                      isMine
                        ? '-right-[7px] text-[#D9FDD3] dark:text-[#005C4B]'
                        : '-left-[7px] -scale-x-100 text-white dark:text-[#202C33]'
                    }`}
                  >
                    <path fill="currentColor" d="M1.533 3.568L8 12.193V1H2.812C1.042 1 .474 2.156 1.533 3.568z" />
                  </svg>
                )}

                {/* Hover / Tap Action Chevron */}
                {!msg.deleted && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveMsgMenuId((prev) => (prev === msg.id ? null : msg.id));
                    }}
                    className={`absolute top-1 right-1 z-10 w-7 h-7 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity cursor-pointer ${
                      activeMsgMenuId === msg.id ? 'opacity-100' : ''
                    } ${
                      isMine
                        ? 'bg-[#D9FDD3]/90 dark:bg-[#005C4B]/90 text-[#54656F] dark:text-[#AEBAC1]'
                        : 'bg-white/90 dark:bg-[#202C33]/90 text-[#54656F] dark:text-[#AEBAC1]'
                    }`}
                    aria-label="Opsi pesan"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                )}

                {/* Message Context Dropdown */}
                {activeMsgMenuId === msg.id && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className={`absolute top-8 ${
                      isMine ? 'right-0' : 'left-0'
                    } z-30 w-44 rounded-xl bg-white dark:bg-[#233138] shadow-xl border border-black/10 dark:border-white/10 py-1 text-sm text-[#111B21] dark:text-[#E9EDEF]`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setReplyTo({
                          id: msg.id,
                          senderId: msg.senderId,
                          senderName: isMine ? 'Anda' : msg.senderName,
                          type: msg.type,
                          text:
                            msg.text ||
                            (msg.type === 'image'
                              ? 'Foto'
                              : msg.type === 'video'
                              ? 'Video'
                              : msg.type === 'voice'
                              ? 'Pesan suara'
                              : msg.type === 'location'
                              ? msg.location?.label || 'Lokasi GPS'
                              : msg.fileName || 'Dokumen'),
                        });
                        setActiveMsgMenuId(null);
                        textareaRef.current?.focus();
                      }}
                      className="w-full px-3.5 py-2 flex items-center gap-2.5 hover:bg-[#F5F6F6] dark:hover:bg-[#182229] cursor-pointer"
                    >
                      <Reply className="w-4 h-4" />
                      <span>Balas</span>
                    </button>

                    {msg.text && (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(msg.text || '');
                            onToast('Teks disalin');
                          } catch {
                            // ignore
                          }
                          setActiveMsgMenuId(null);
                        }}
                        className="w-full px-3.5 py-2 flex items-center gap-2.5 hover:bg-[#F5F6F6] dark:hover:bg-[#182229] cursor-pointer"
                      >
                        <Copy className="w-4 h-4" />
                        <span>Salin teks</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        onDeleteMessage(msg.id, isMine);
                        setActiveMsgMenuId(null);
                      }}
                      className="w-full px-3.5 py-2 flex items-center gap-2.5 text-rose-600 dark:text-rose-400 hover:bg-[#F5F6F6] dark:hover:bg-[#182229] cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>{isMine ? 'Hapus untuk semua' : 'Hapus pesan'}</span>
                    </button>
                  </div>
                )}

                {/* Group Sender Name */}
                {contact.isGroup && !isMine && showTail && !msg.deleted && (
                  <div
                    style={{ color: getSenderColor(msg.senderId) }}
                    className="text-xs font-semibold mb-0.5 pr-6 truncate"
                  >
                    {msg.senderName}
                  </div>
                )}

                {/* Quoted Reply Preview Inside Bubble */}
                {msg.replyTo && !msg.deleted && (
                  <div className="mb-1.5 rounded-md bg-black/[0.06] dark:bg-black/25 px-2.5 py-1.5 border-l-3 border-[#00A884] text-xs">
                    <div className="font-semibold text-[#008069] dark:text-[#06CF9C] truncate">
                      {msg.replyTo.senderName}
                    </div>
                    <div className="text-[#54656F] dark:text-[#AEBAC1] truncate">
                      {msg.replyTo.text}
                    </div>
                  </div>
                )}

                {/* Message Content by Type */}
                {msg.deleted ? (
                  <div className="flex items-center gap-1.5 text-[13.5px] italic text-[#667781] dark:text-[#AEBAC1] pr-12 py-0.5">
                    <Ban className="w-4 h-4 shrink-0" />
                    <span>Pesan ini telah dihapus</span>
                  </div>
                ) : msg.type === 'image' && msg.mediaData ? (
                  <div className="space-y-1">
                    <button
                      type="button"
                      onClick={() =>
                        onOpenLightbox({
                          type: 'image',
                          src: msg.mediaData!,
                          senderName: isMine ? 'Anda' : msg.senderName,
                          timestamp: msg.timestamp,
                          caption: msg.text,
                          fileName: msg.fileName,
                        })
                      }
                      className="block rounded-md overflow-hidden max-w-[280px] sm:max-w-[320px] cursor-pointer"
                    >
                      <img
                        src={msg.mediaData}
                        alt={msg.text || 'Foto'}
                        referrerPolicy="no-referrer"
                        className="w-full max-h-[300px] object-cover"
                      />
                    </button>
                    {msg.text && (
                      <p className="text-[14.2px] leading-snug whitespace-pre-wrap break-words pr-12">
                        {msg.text}
                      </p>
                    )}
                  </div>
                ) : msg.type === 'video' && msg.mediaData ? (
                  <div className="space-y-1">
                    <button
                      type="button"
                      onClick={() =>
                        onOpenLightbox({
                          type: 'video',
                          src: msg.mediaData!,
                          senderName: isMine ? 'Anda' : msg.senderName,
                          timestamp: msg.timestamp,
                          caption: msg.text,
                          fileName: msg.fileName,
                        })
                      }
                      className="relative block rounded-md overflow-hidden max-w-[280px] sm:max-w-[320px] bg-black cursor-pointer"
                    >
                      <video
                        src={msg.mediaData}
                        className="w-full max-h-[260px] object-cover opacity-85"
                      />
                      <span className="absolute inset-0 flex items-center justify-center">
                        <span className="w-12 h-12 rounded-full bg-black/60 text-white flex items-center justify-center">
                          <Play className="w-6 h-6 fill-current ml-0.5" />
                        </span>
                      </span>
                    </button>
                    {msg.text && (
                      <p className="text-[14.2px] leading-snug whitespace-pre-wrap break-words pr-12">
                        {msg.text}
                      </p>
                    )}
                  </div>
                ) : msg.type === 'document' && msg.mediaData ? (
                  <div className="flex items-center gap-3 rounded-lg bg-black/[0.05] dark:bg-black/25 p-2.5 min-w-[220px] sm:min-w-[260px]">
                    <button
                      type="button"
                      onClick={() => handleOpenDocumentCard(msg)}
                      className="flex-1 flex items-center gap-3 min-w-0 text-left cursor-pointer"
                      title="Buka atau unduh dokumen"
                    >
                      <div className="w-10 h-10 rounded-lg bg-[#008069]/15 dark:bg-[#00A884]/20 text-[#008069] dark:text-[#00A884] flex items-center justify-center shrink-0">
                        <FileText className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {msg.fileName || 'Dokumen'}
                        </div>
                        <div className="text-[11px] text-[#667781] dark:text-[#AEBAC1] tabular-nums">
                          {formatFileSize(msg.fileSize)} ·{' '}
                          {(msg.fileName?.split('.').pop() || 'FILE').toUpperCase()}
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      disabled={downloadingMsgId === msg.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDownloadDocument(msg);
                      }}
                      className="w-9 h-9 rounded-full bg-white/80 dark:bg-white/10 hover:bg-white dark:hover:bg-white/20 disabled:opacity-60 text-[#008069] dark:text-[#00A884] flex items-center justify-center shrink-0 transition-colors cursor-pointer"
                      title="Unduh Dokumen"
                    >
                      {downloadingMsgId === msg.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Download className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                ) : msg.type === 'location' && msg.location ? (
                  <div className="space-y-2 min-w-[230px] sm:min-w-[265px]">
                    <div className="relative h-36 w-full rounded-lg overflow-hidden bg-[#0B141A] border border-black/10 dark:border-white/10">
                      <iframe
                        title="Peta Lokasi GPS"
                        src={buildOpenStreetMapEmbedUrl(msg.location.lat, msg.location.lng)}
                        className="w-full h-full border-0 pointer-events-none"
                        loading="lazy"
                      />
                      <span className="absolute top-2 left-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#111B21]/85 text-white text-[10px] font-semibold">
                        <MapPin className="w-3 h-3 text-emerald-400" />
                        <span>Lokasi GPS</span>
                      </span>
                    </div>
                    <div className="px-0.5 space-y-1">
                      {(msg.location.label || msg.text) && (
                        <div className="text-[13.5px] font-semibold leading-snug break-words">
                          {msg.location.label || msg.text}
                        </div>
                      )}
                      <div className="font-mono-id text-[11px] text-[#008069] dark:text-[#00A884]">
                        {msg.location.lat.toFixed(6)}, {msg.location.lng.toFixed(6)}
                        {typeof msg.location.accuracy === 'number'
                          ? ` · ±${msg.location.accuracy} m`
                          : ''}
                      </div>
                      <div className="pt-1 flex items-center gap-2">
                        <a
                          href={buildExternalMapUrl(msg.location.lat, msg.location.lng)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1 inline-flex items-center justify-center gap-1.5 h-8 px-2.5 rounded-lg bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] text-white dark:text-[#111B21] text-xs font-semibold transition-colors"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>Buka Peta</span>
                        </a>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(
                                `${msg.location!.lat.toFixed(6)}, ${msg.location!.lng.toFixed(6)}`
                              );
                              onToast('Koordinat GPS disalin');
                            } catch {
                              onToast('Gagal menyalin koordinat');
                            }
                          }}
                          className="inline-flex items-center justify-center gap-1 h-8 px-2.5 rounded-lg bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 text-xs font-medium cursor-pointer"
                          title="Salin koordinat"
                        >
                          <Copy className="w-3.5 h-3.5" />
                          <span>Salin</span>
                        </button>
                      </div>
                    </div>
                  </div>
                ) : msg.type === 'voice' && msg.mediaData ? (
                  <VoiceNoteBubble
                    audioSrc={msg.mediaData}
                    duration={msg.duration}
                    isMine={isMine}
                    senderName={isMine ? profile.name : msg.senderName}
                    senderAvatar={isMine ? profile.avatar : contact.avatar}
                  />
                ) : (
                  <p className="text-[14.2px] leading-[1.38] whitespace-pre-wrap break-words pr-14">
                    {msg.text}
                  </p>
                )}

                {/* Indikator Progres Pengiriman Chunk WebRTC sampai Centang 2 aktif */}
                {isMine &&
                  !msg.deleted &&
                  msg.type !== 'text' &&
                  msg.status !== 'delivered' &&
                  msg.status !== 'read' &&
                  (msg.status === 'pending' ||
                    msg.status === 'sending' ||
                    msg.transferWaitingPeer ||
                    typeof msg.transferProgress === 'number') && (
                    <div className="mt-1.5 rounded-md bg-black/[0.06] dark:bg-black/30 px-2.5 py-1.5 space-y-1">
                      <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-[#008069] dark:text-[#06CF9C] tabular-nums">
                        <span className="inline-flex items-center gap-1.5 truncate">
                          {msg.status === 'pending' || msg.transferWaitingPeer ? (
                            <Hourglass className="w-3 h-3 text-amber-500 dark:text-amber-400 shrink-0" />
                          ) : (
                            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                          )}
                          <span>
                            {msg.status === 'pending' || msg.transferWaitingPeer
                              ? 'Menunggu teman online...'
                              : (msg.transferProgress ?? 0) >= 100
                              ? 'Menunggu konfirmasi diterima...'
                              : (msg.transferProgress ?? 0) === 0
                              ? 'Menghubungkan & mengirim...'
                              : `Mengirim ${
                                  msg.type === 'image'
                                    ? 'gambar'
                                    : msg.type === 'video'
                                    ? 'video'
                                    : msg.type === 'voice'
                                    ? 'pesan suara'
                                    : 'file'
                                } ${msg.transferProgress ?? 0}%...`}
                          </span>
                        </span>
                        {msg.status !== 'pending' && !msg.transferWaitingPeer && (
                          <span className="shrink-0 font-mono-id">
                            {msg.transferProgress ?? 0}%
                          </span>
                        )}
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-black/10 dark:bg-white/15 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-[width] duration-150 ${
                            msg.status === 'pending' || msg.transferWaitingPeer
                              ? 'bg-amber-400'
                              : 'bg-[#00A884]'
                          }`}
                          style={{
                            width: `${
                              msg.status === 'pending' || msg.transferWaitingPeer
                                ? 16
                                : Math.max(4, msg.transferProgress ?? 0)
                            }%`,
                          }}
                        />
                      </div>
                    </div>
                  )}

                {/* Timestamp & Double-Check Ticks */}
                <div className="mt-0.5 flex items-center justify-end gap-1 text-[10.5px] text-[#667781] dark:text-[#AEBAC1] tabular-nums select-none">
                  <span>{formatTime(msg.timestamp)}</span>
                  {isMine && !msg.deleted && (
                    <span
                      className="inline-flex items-center"
                      title={
                        msg.status === 'pending'
                          ? 'Menunggu kontak online (antrean tertunda)'
                          : msg.status === 'read'
                          ? 'Diterima & dibaca'
                          : msg.status === 'delivered'
                          ? 'Terkirim ke perangkat penerima'
                          : msg.status === 'sending'
                          ? 'Sedang mengirim...'
                          : 'Terkirim'
                      }
                    >
                      {msg.status === 'read' ? (
                        <CheckCheck className="w-4 h-4 text-[#53BDEB]" />
                      ) : msg.status === 'delivered' ? (
                        <CheckCheck className="w-4 h-4 text-[#8696A0]" />
                      ) : msg.status === 'pending' ? (
                        <Hourglass className="w-3 h-3 text-amber-600 dark:text-amber-400" />
                      ) : msg.status === 'sending' ? (
                        <Clock className="w-3 h-3 text-[#8696A0]" />
                      ) : (
                        <Check className="w-3.5 h-3.5 text-[#8696A0]" />
                      )}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        <div ref={messagesEndRef} />
      </div>

      {/* Quoted Reply Bar Above Input */}
      {replyTo && (
        <div className="bg-[#F0F2F5] dark:bg-[#202C33] px-3 pt-2 pb-1 border-t border-black/5 dark:border-white/5 flex items-center gap-2 shrink-0">
          <div className="flex-1 min-w-0 rounded-lg bg-white dark:bg-[#111B21] px-3 py-2 border-l-4 border-[#00A884]">
            <div className="text-xs font-semibold text-[#008069] dark:text-[#00A884] truncate">
              {replyTo.senderName}
            </div>
            <div className="text-xs text-[#54656F] dark:text-[#8696A0] truncate">
              {replyTo.text}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            className="w-9 h-9 rounded-full flex items-center justify-center text-[#54656F] dark:text-[#8696A0] hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* Emoji Picker Panel */}
      {showEmoji && (
        <div className="bg-[#F0F2F5] dark:bg-[#202C33] border-t border-black/10 dark:border-white/10 px-3 py-2.5 shrink-0">
          <div className="flex items-center gap-2 mb-2">
            {EMOJI_CATEGORIES.map((cat, idx) => (
              <button
                key={cat.name}
                type="button"
                onClick={() => setEmojiTab(idx)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                  emojiTab === idx
                    ? 'bg-[#008069] dark:bg-[#00A884] text-white dark:text-[#111B21]'
                    : 'text-[#54656F] dark:text-[#8696A0] hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-10 gap-1 max-h-36 overflow-y-auto wa-scroll">
            {EMOJI_CATEGORIES[emojiTab].emojis.map((em) => (
              <button
                key={em}
                type="button"
                onClick={() => handleTextChange(text + em)}
                className="h-9 rounded-lg text-xl flex items-center justify-center hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer"
              >
                {em}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Floating WhatsApp Attachment Pop-Up */}
      {showAttach && (
        <div className="absolute bottom-[74px] left-3 sm:left-6 z-30 rounded-2xl bg-white dark:bg-[#233138] shadow-2xl border border-black/10 dark:border-white/10 p-4 grid grid-cols-4 gap-3 w-[312px] max-w-[calc(100vw-1.5rem)]">
          <label
            htmlFor="wattapps-gallery-input"
            onClick={() => {
              window.setTimeout(() => setShowAttach(false), 300);
            }}
            className="flex flex-col items-center gap-1.5 group cursor-pointer"
          >
            <span className="w-12 h-12 rounded-full bg-purple-600 text-white flex items-center justify-center shadow-md group-hover:scale-105 transition-transform">
              <ImageIcon className="w-5 h-5" />
            </span>
            <span className="text-xs font-medium text-[#3B4A54] dark:text-[#D1D7DB]">Galeri</span>
          </label>

          <button
            type="button"
            onClick={() => {
              setShowAttach(false);
              onOpenCamera();
            }}
            className="flex flex-col items-center gap-1.5 group cursor-pointer"
          >
            <span className="w-12 h-12 rounded-full bg-rose-500 text-white flex items-center justify-center shadow-md group-hover:scale-105 transition-transform">
              <Camera className="w-5 h-5" />
            </span>
            <span className="text-xs font-medium text-[#3B4A54] dark:text-[#D1D7DB]">Kamera</span>
          </button>

          <label
            htmlFor="wattapps-doc-input"
            onClick={() => {
              window.setTimeout(() => setShowAttach(false), 300);
            }}
            className="flex flex-col items-center gap-1.5 group cursor-pointer"
          >
            <span className="w-12 h-12 rounded-full bg-indigo-600 text-white flex items-center justify-center shadow-md group-hover:scale-105 transition-transform">
              <FileText className="w-5 h-5" />
            </span>
            <span className="text-xs font-medium text-[#3B4A54] dark:text-[#D1D7DB]">Dokumen</span>
          </label>

          <button
            type="button"
            onClick={() => {
              setShowAttach(false);
              setShowLocationPicker(true);
            }}
            className="flex flex-col items-center gap-1.5 group cursor-pointer"
          >
            <span className="w-12 h-12 rounded-full bg-emerald-600 text-white flex items-center justify-center shadow-md group-hover:scale-105 transition-transform">
              <MapPin className="w-5 h-5" />
            </span>
            <span className="text-xs font-medium text-[#3B4A54] dark:text-[#D1D7DB]">Lokasi</span>
          </button>
        </div>
      )}

      {/* Hidden File Inputs Outside Popup (Persistent in DOM) */}
      <input
        id="wattapps-gallery-input"
        type="file"
        accept="image/*,video/*"
        onChange={handleGallerySelect}
        style={{ position: 'fixed', width: 1, height: 1, opacity: 0.001, zIndex: -1 }}
      />
      <input
        id="wattapps-doc-input"
        type="file"
        accept="*/*"
        onChange={handleDocumentSelect}
        style={{ position: 'fixed', width: 1, height: 1, opacity: 0.001, zIndex: -1 }}
      />

      {/* Bottom Input Bar / Live Voice Note Recorder */}
      <div className="bg-[#F0F2F5] dark:bg-[#202C33] px-2.5 sm:px-4 py-2 pb-safe flex items-end gap-2 shrink-0 z-20">
        {isRecording ? (
          <div className="flex-1 flex items-center gap-3 bg-white dark:bg-[#2A3942] rounded-full px-3 py-1.5 shadow-xs min-h-[48px]">
            <button
              type="button"
              onClick={() => stopVoiceRecording(true)}
              className="w-10 h-10 rounded-full flex items-center justify-center text-rose-500 hover:bg-rose-500/10 cursor-pointer shrink-0"
              title="Batal rekaman"
            >
              <Trash2 className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2 shrink-0">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse" />
              <span className="font-mono-id text-sm font-semibold text-[#111B21] dark:text-[#E9EDEF] tabular-nums">
                {formatDuration(recordSeconds)}
              </span>
            </div>

            {/* Real-time Audio Waveform Visualizer */}
            <div className="flex-1 flex items-center justify-center gap-[3px] h-7 overflow-hidden">
              {waveLevels.map((lvl, idx) => (
                <span
                  key={idx}
                  style={{ height: `${Math.max(4, Math.round(lvl * 0.26))}px` }}
                  className="w-1 rounded-full bg-[#00A884] transition-[height] duration-75"
                />
              ))}
            </div>

            <button
              type="button"
              onClick={() => stopVoiceRecording(false)}
              className="w-11 h-11 rounded-full bg-[#00A884] hover:bg-[#06CF9C] text-white flex items-center justify-center shadow-sm cursor-pointer shrink-0"
              title="Kirim Voice Note"
            >
              <SendHorizontal className="w-5 h-5" />
            </button>
          </div>
        ) : (
          <>
            <div className="flex-1 flex items-end gap-1 bg-white dark:bg-[#2A3942] rounded-3xl px-2 py-1 shadow-xs min-h-[46px]">
              <button
                type="button"
                onClick={() => {
                  setShowEmoji((prev) => !prev);
                  setShowAttach(false);
                }}
                className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                  showEmoji
                    ? 'text-[#008069] dark:text-[#00A884]'
                    : 'text-[#54656F] dark:text-[#8696A0] hover:text-[#111B21] dark:hover:text-white'
                }`}
                aria-label="Emoji"
              >
                <Smile className="w-5 h-5" />
              </button>

              <textarea
                ref={textareaRef}
                rows={1}
                value={text}
                onChange={(e) => {
                  handleTextChange(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`;
                }}
                onKeyDown={handleKeyDown}
                placeholder="Ketik pesan"
                className="flex-1 max-h-[120px] py-2.5 px-1 bg-transparent text-[15px] text-[#111B21] dark:text-[#E9EDEF] placeholder:text-[#667781] dark:placeholder:text-[#8696A0] resize-none focus:outline-none leading-snug"
              />

              <button
                type="button"
                onClick={() => {
                  setShowAttach((prev) => !prev);
                  setShowEmoji(false);
                }}
                className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                  showAttach
                    ? 'text-[#008069] dark:text-[#00A884]'
                    : 'text-[#54656F] dark:text-[#8696A0] hover:text-[#111B21] dark:hover:text-white'
                }`}
                aria-label="Lampirkan file atau lokasi"
                title="Lampirkan (Galeri, Kamera, Dokumen, Lokasi)"
              >
                <Paperclip className="w-5 h-5 -rotate-45" />
              </button>

              {!text.trim() && (
                <button
                  type="button"
                  onClick={onOpenCamera}
                  className="hidden sm:flex w-10 h-10 rounded-full items-center justify-center text-[#54656F] dark:text-[#8696A0] hover:text-[#111B21] dark:hover:text-white shrink-0 cursor-pointer"
                  aria-label="Kamera"
                  title="Ambil Foto"
                >
                  <Camera className="w-5 h-5" />
                </button>
              )}
            </div>

            {/* Dynamic Green Mic / Send Button */}
            {text.trim().length > 0 ? (
              <button
                type="button"
                onClick={handleSend}
                className="w-12 h-12 rounded-full bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] text-white dark:text-[#111B21] flex items-center justify-center shadow-sm active:scale-95 transition-transform shrink-0 cursor-pointer"
                aria-label="Kirim pesan"
              >
                <SendHorizontal className="w-5 h-5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={startVoiceRecording}
                className="w-12 h-12 rounded-full bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] text-white dark:text-[#111B21] flex items-center justify-center shadow-sm active:scale-95 transition-transform shrink-0 cursor-pointer"
                aria-label="Rekam pesan suara"
                title="Rekam Voice Note"
              >
                <Mic className="w-5 h-5" />
              </button>
            )}
          </>
        )}
      </div>

      {/* Contact / Group Info Modal */}
      {showInfoSheet && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowInfoSheet(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#233138] p-6 shadow-2xl border border-black/5 dark:border-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowInfoSheet(false)}
                className="w-9 h-9 rounded-full flex items-center justify-center text-[#54656F] dark:text-[#8696A0] hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex flex-col items-center text-center -mt-3">
              <Avatar
                src={contact.avatar}
                name={contact.name}
                size="2xl"
                isGroup={contact.isGroup}
                isOnline={!contact.isGroup && isPeerOnline}
              />
              <h3 className="mt-3 text-lg font-bold text-[#111B21] dark:text-[#E9EDEF]">
                {contact.name}
              </h3>
              {!contact.isGroup ? (
                <div className="mt-1 font-mono-id text-sm text-[#008069] dark:text-[#00A884] font-semibold">
                  ID: {formatSixDigitId(contact.id)}
                </div>
              ) : (
                <div className="mt-1 text-xs text-[#667781] dark:text-[#8696A0] flex items-center gap-1">
                  <Users className="w-3.5 h-3.5" />
                  <span>Grup P2P · {contact.members?.length || 1} anggota</span>
                </div>
              )}
              <p className="mt-2 text-sm text-[#54656F] dark:text-[#AEBAC1]">{contact.bio}</p>

              {contact.isGroup && contact.members && (
                <div className="mt-4 w-full text-left border-t border-black/5 dark:border-white/10 pt-3">
                  <div className="text-xs font-semibold text-[#008069] dark:text-[#00A884] mb-2">
                    Daftar Anggota
                  </div>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto wa-scroll">
                    {contact.members.map((mId) => (
                      <div
                        key={mId}
                        className="flex items-center justify-between text-xs py-1 px-2 rounded-lg bg-[#F0F2F5] dark:bg-[#111B21]"
                      >
                        <span className="font-medium text-[#111B21] dark:text-[#E9EDEF] truncate">
                          {mId === profile.id
                            ? `${profile.name} (Anda)`
                            : contact.memberNames?.[mId] || `Teman ${mId}`}
                        </span>
                        <span className="font-mono-id text-[#667781] dark:text-[#8696A0]">
                          {formatSixDigitId(mId)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* GPS Location Picker Modal */}
      <LocationPickerModal
        open={showLocationPicker}
        onClose={() => setShowLocationPicker(false)}
        onSendLocation={(loc) => {
          onSendLocation(loc, replyTo ?? undefined);
          setReplyTo(null);
        }}
      />
    </div>
  );
};
