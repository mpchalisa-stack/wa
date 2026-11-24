import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaConnection } from 'peerjs';
import {
  Camera,
  Copy,
  Lock,
  LogOut,
  Moon,
  MoreVertical,
  Power,
  QrCode,
  RefreshCw,
  Search,
  Share2,
  Shield,
  ShieldCheck,
  Sun,
  Trash2,
  User,
  Users,
  X,
} from 'lucide-react';
import {
  CallRecord,
  CallType,
  ChatMessage,
  Contact,
  NavTab,
  PeerConnectionState,
  PeerPacket,
  PendingOutboxMessage,
  ReplyPreview,
  StatusItem,
  ThemeMode,
  UserProfile,
} from './types';
import {
  dbClearCalls,
  dbDeleteContact,
  dbDeleteMessagesForChat,
  dbDeletePendingByMessageId,
  dbDeletePendingMessage,
  dbDeleteStatus,
  dbSaveCall,
  dbSaveContact,
  dbSaveMessage,
  dbSavePendingMessage,
  dbSaveStatus,
  getLockedUserId,
  getSavedProfile,
  getSavedTheme,
  getSavedUnreadCounts,
  loadAllLocalData,
  resetAllLocalData,
  saveOutboxMessages,
  saveTheme,
  saveUnreadCounts,
  saveUserProfile,
} from './lib/db';
import {
  PeerTransportMode,
  ReassembledFileTransfer,
  WA6PeerManager,
  ensureLocalAudioTracksAttached,
  fromFullPeerId,
  getMediaCallPeerConnection,
  inspectMediaCallTransport,
  normalizePeerId,
} from './lib/peerManager';
import {
  initGlobalAudioUnlock,
  playMessagePop,
  registerRingtoneAudioElement,
  releaseAudioContextNow,
  resumeWebAudioContext,
  startIncomingRingtone,
  startOutgoingRingback,
  stopAllRingtones,
} from './lib/audio';
import {
  NotificationClickData,
  clearPeerMediaSession,
  disableStandbyMode,
  dismissIncomingCallNotification,
  enableStandbyMode,
  enterBackgroundBatteryStandby,
  pauseKeepAliveForCall,
  releaseActiveMediaSession,
  requestNotificationPermission,
  resumeKeepAliveAfterCall,
  setStandbyExternalListener,
  showIncomingWebNotification,
  syncConnectionWakeLock,
  syncPeerMediaSession,
} from './lib/standby';
import {
  buildConversationScope,
  decryptTextEnvelope,
  encryptTextEnvelope,
} from './lib/crypto';
import { sendNtfyWakeSignal, subscribeNtfySignal } from './lib/ntfy';
import {
  enterAndroidBridgeBatteryStandby,
  fetchPeerIdentityFromFirestore,
  getCachedPeerIdentity,
  sendFcmPushToUser,
  setAndroidBridgeCallAudioMode,
  startFcmTokenSyncLoop,
  syncFcmToken,
  triggerAndroidBridgeIncomingCall,
  triggerAndroidBridgeIncomingMessage,
} from './lib/fcmPush';
import { estimateDataUrlBytes, formatSixDigitId, generateUid } from './lib/media';
import { OnboardingScreen } from './components/OnboardingScreen';
import { ChatList } from './components/ChatList';
import { ChatRoom } from './components/ChatRoom';
import { StatusTab } from './components/StatusTab';
import { CallsTab } from './components/CallsTab';
import { ProfileDrawer } from './components/ProfileDrawer';
import { NewChatModal } from './components/NewChatModal';
import { NewGroupModal } from './components/NewGroupModal';
import { CameraModal } from './components/CameraModal';
import { CallOverlay, ActiveCallUIState } from './components/CallOverlay';
import { MediaLightbox, LightboxMedia } from './components/MediaLightbox';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { ShareAppModal } from './components/ShareAppModal';
import { AppLogo } from './components/AppLogo';

interface ActiveCallRuntime {
  callId: string;
  peerId: string;
  peerName: string;
  peerAvatar: string;
  callType: CallType;
  direction: 'incoming' | 'outgoing';
  mediaCall: MediaConnection;
  localStream: MediaStream | null;
  remoteStream?: MediaStream | null;
  startedAt: number;
  connectedAt: number | null;
  facingMode: 'user' | 'environment';
}

interface PendingIncomingCall {
  callId: string;
  peerId: string;
  peerName: string;
  peerAvatar: string;
  callType: CallType;
  receivedAt: number;
}

interface IncomingCallState {
  call: MediaConnection | null;
  callId: string;
  callerId: string;
  callerName: string;
  callerAvatar: string;
  isVideo: boolean;
  timestamp: number;
}

interface AwaitingMediaCallAnswer {
  callId: string;
  peerId: string;
  peerName: string;
  peerAvatar: string;
  callType: CallType;
  localStream: MediaStream;
  timeoutId: number;
}

const PENDING_CALL_TTL_MS = 45000;
const APP_WAKE_SYNC_COOLDOWN_MS = 3000;
const BATTERY_STANDBY_IDLE_MS = 5 * 60 * 1000; // 5 menit (300.000 ms)

let isHistoryTrapped = false;

export default function App() {
  const [profile, setProfile] = useState<UserProfile | null>(() => getSavedProfile());
  const [theme, setTheme] = useState<ThemeMode>(() => getSavedTheme());
  const [dataLoaded, setDataLoaded] = useState(false);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statuses, setStatuses] = useState<StatusItem[]>([]);
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [pendingMessages, setPendingMessages] = useState<PendingOutboxMessage[]>([]);
  const [standbyMode, setStandbyMode] = useState(true);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>(() =>
    getSavedUnreadCounts()
  );

  // Navigation & UI state
  const [activeTab, setActiveTab] = useState<NavTab>('chats');
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showMainMenu, setShowMainMenu] = useState(false);
  const [showProfileDrawer, setShowProfileDrawer] = useState(false);
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [showNewGroupModal, setShowNewGroupModal] = useState(false);
  const [showShareAppModal, setShowShareAppModal] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isExited, setIsExited] = useState(false);
  const [pendingInvite, setPendingInvite] = useState<{ id: string; name?: string } | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const params = new URLSearchParams(window.location.search);
      const addId = params.get('add')?.replace(/\D/g, '');
      if (addId && addId.length === 6) {
        return { id: addId, name: params.get('name')?.trim() || undefined };
      }
    } catch {
      // ignore
    }
    return null;
  });
  const [pendingNotificationTargetUrl, setPendingNotificationTargetUrl] = useState<string | null>(
    () => {
      if (typeof window === 'undefined') return null;
      try {
        const params = new URLSearchParams(window.location.search);
        const targetId = params.get('targetId')?.trim();
        const action = params.get('action')?.trim();
        const incomingCallId = params.get('incomingCall')?.trim();
        if (incomingCallId || targetId || action === 'call' || action === 'chat') {
          return window.location.search;
        }
      } catch {
        // ignore
      }
      return null;
    }
  );
  const [cameraPurpose, setCameraPurpose] = useState<'chat' | 'status' | null>(null);
  const [lightboxMedia, setLightboxMedia] = useState<LightboxMedia | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [toastTone, setToastTone] = useState<'default' | 'warning'>('default');

  // PeerJS real-time state
  const [peerState, setPeerState] = useState<PeerConnectionState>('connecting');
  const [peerError, setPeerError] = useState<string | undefined>();
  const [onlinePeers, setOnlinePeers] = useState<Record<string, boolean>>({});
  const [peerTransports, setPeerTransports] = useState<Record<string, PeerTransportMode | null>>({});
  const [typingMap, setTypingMap] = useState<Record<string, string>>({});

  // Call UI & persistent Incoming Call state
  const [activeCallUI, setActiveCallUI] = useState<ActiveCallUIState | null>(null);
  const [incomingCall, setIncomingCall] = useState<IncomingCallState | null>(null);
  const [incomingCallModalForceTick, setIncomingCallModalForceTick] = useState(0);
  // State internal mode standby hemat baterai (tanpa elemen UI)
  const [isBatteryStandby, setIsBatteryStandby] = useState(false);

  // Refs for fresh state inside PeerJS callbacks
  const peerManagerRef = useRef<WA6PeerManager | null>(null);
  const isBatteryStandbyRef = useRef(false);
  const batteryIdleTimerRef = useRef<number | null>(null);
  const profileRef = useRef<UserProfile | null>(profile);
  const contactsRef = useRef<Contact[]>(contacts);
  const messagesRef = useRef<ChatMessage[]>(messages);
  const pendingMessagesRef = useRef<PendingOutboxMessage[]>(pendingMessages);
  const standbyModeRef = useRef<boolean>(standbyMode);
  const flushingPeersRef = useRef<Set<string>>(new Set());
  const pendingLastAttemptRef = useRef<Map<string, number>>(new Map());
  const activeChatIdRef = useRef<string | null>(activeChatId);
  const callRuntimeRef = useRef<ActiveCallRuntime | null>(null);
  const pendingCallRef = useRef<PendingIncomingCall | null>(null);
  const incomingCallRef = useRef<IncomingCallState | null>(null);
  const awaitingMediaCallAnswerRef = useRef<AwaitingMediaCallAnswer | null>(null);
  const lastAppWakeSyncRef = useRef<number>(0);
  const callTimerRef = useRef<number | null>(null);
  const unansweredCallTimerRef = useRef<number | null>(null);
  const wakeRingtoneTimerRef = useRef<number | null>(null);
  const typingClearTimersRef = useRef<Record<string, number>>({});
  const toastTimerRef = useRef<number | null>(null);
  const handleAcceptCallRef = useRef<(isAutoAccept?: boolean) => Promise<void>>(async () => {});
  const handleRejectCallRef = useRef<
    (fallback?: { callerId?: string; callerName?: string; callId?: string; callType?: CallType }) => void
  >(() => {});
  const remoteCallAudioRef = useRef<HTMLAudioElement | null>(null);
  const ringtoneAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const callAudioCtxRef = useRef<AudioContext | null>(null);
  const callRemoteSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const callRemoteGainRef = useRef<GainNode | null>(null);
  const boundStreamCallsRef = useRef<WeakSet<MediaConnection>>(new WeakSet());
  const boundPcRef = useRef<WeakSet<RTCPeerConnection>>(new WeakSet());
  const isSpeakerOnRef = useRef<boolean>(true);

  const LOADING_IDENTITY_LABEL = 'Memuat identitas...';

  const isPlaceholderPeerName = useCallback((name?: string | null): boolean => {
    const trimmed = (name || '').trim();
    if (!trimmed) return true;
    return (
      trimmed === 'Memuat identitas...' ||
      /^teman\s+\d+$/i.test(trimmed) ||
      /^id[:\s]+\d+$/i.test(trimmed) ||
      /^pengguna\s*\(?[\d\s]+\)?$/i.test(trimmed) ||
      /^\d{6}$/.test(trimmed)
    );
  }, []);

  /**
   * Fungsi terpusat untuk mematikan TOTAL seluruh sumber suara dering secara sinkron:
   * HTMLAudioElement ref, OscillatorNode, setInterval, wakeRingtoneTimer, dan AudioContext dering.
   */
  const stopAllCallRingtones = useCallback(() => {
    if (wakeRingtoneTimerRef.current !== null) {
      try {
        window.clearTimeout(wakeRingtoneTimerRef.current);
      } catch {
        // ignore
      }
      wakeRingtoneTimerRef.current = null;
    }

    const ringtoneEl = ringtoneAudioRef.current;
    if (ringtoneEl) {
      try {
        ringtoneEl.pause();
        ringtoneEl.currentTime = 0;
        ringtoneEl.src = '';
        ringtoneEl.load();
      } catch {
        // ignore
      }
    }

    try {
      stopAllRingtones();
    } catch {
      // ignore
    }
  }, []);

  const getTrustedPeerName = useCallback(
    (rawPeerId: string, candidateName?: string | null): string => {
      const cleanId = fromFullPeerId(rawPeerId);
      const cached = cleanId ? getCachedPeerIdentity(cleanId) : null;
      if (cached?.displayName && !isPlaceholderPeerName(cached.displayName)) {
        return cached.displayName;
      }

      const existing = cleanId
        ? contactsRef.current.find((c) => normalizePeerId(c.id) === cleanId)
        : undefined;
      if (existing?.name && !isPlaceholderPeerName(existing.name)) {
        return existing.name.trim();
      }

      if (candidateName && !isPlaceholderPeerName(candidateName)) {
        return candidateName.trim();
      }

      return LOADING_IDENTITY_LABEL;
    },
    [isPlaceholderPeerName]
  );

  const closeCallAudioContext = useCallback(() => {
    try {
      callRemoteSourceRef.current?.disconnect();
    } catch {
      // ignore
    }
    callRemoteSourceRef.current = null;

    try {
      callRemoteGainRef.current?.disconnect();
    } catch {
      // ignore
    }
    callRemoteGainRef.current = null;

    const ctx = callAudioCtxRef.current;
    callAudioCtxRef.current = null;
    if (ctx && ctx.state !== 'closed') {
      try {
        void ctx.close().catch(() => {});
      } catch {
        // ignore
      }
    }
  }, []);

  const ensureCallAudioContext = useCallback(
    (forceReset = false): AudioContext | null => {
      if (forceReset) {
        closeCallAudioContext();
      }
      try {
        if (!callAudioCtxRef.current || callAudioCtxRef.current.state === 'closed') {
          const AudioCtxCtor =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (!AudioCtxCtor) return null;
          callAudioCtxRef.current = new AudioCtxCtor();
        }
        const ctx = callAudioCtxRef.current;
        if (ctx.state === 'suspended') {
          void ctx.resume().catch(() => {});
        }
        return ctx;
      } catch {
        return null;
      }
    },
    [closeCallAudioContext]
  );

  const connectRemoteStreamToAudioContext = useCallback(
    (remoteStream: MediaStream) => {
      if (remoteStream.getAudioTracks().length === 0) return;
      const ctx = ensureCallAudioContext(false);
      if (!ctx) return;

      try {
        callRemoteSourceRef.current?.disconnect();
      } catch {
        // ignore
      }
      callRemoteSourceRef.current = null;

      try {
        callRemoteGainRef.current?.disconnect();
      } catch {
        // ignore
      }
      callRemoteGainRef.current = null;

      try {
        const source = ctx.createMediaStreamSource(remoteStream);
        const gain = ctx.createGain();
        gain.gain.value = isSpeakerOnRef.current ? 1.0 : 0.0;
        source.connect(gain);
        gain.connect(ctx.destination);
        callRemoteSourceRef.current = source;
        callRemoteGainRef.current = gain;

        if (ctx.state === 'suspended') {
          void ctx.resume().catch(() => {});
        }
      } catch (err) {
        console.warn('[WattappsAU WebRTC Audio] Gagal menyambungkan remoteStream ke AudioContext:', err);
      }
    },
    [ensureCallAudioContext]
  );

  const getCallLocalStream = useCallback(async (callType: CallType): Promise<MediaStream> => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callType === 'video' ? { facingMode: 'user' } : false,
      });
    } catch (err) {
      if (callType === 'video') {
        console.warn(
          '[WattappsAU Call] Gagal mengakses kamera untuk panggilan video, fallback ke audio saja:',
          err
        );
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
      } else {
        throw err;
      }
    }
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Mikrofon tidak menyediakan track audio aktif.');
    }
    audioTracks.forEach((track) => {
      track.enabled = true;
    });
    return stream;
  }, []);

  // Buka kunci autoplay elemen <audio id="remoteAudio"> tepat di dalam klik tombol Panggil/Jawab (User Gesture Android WebView)
  const unlockRemoteAudioElement = useCallback(() => {
    try {
      const audioEl =
        remoteCallAudioRef.current ||
        (document.getElementById('remoteAudio') as HTMLAudioElement | null);
      if (!audioEl) return;
      audioEl.muted = false;
      audioEl.volume = 1.0;
      const playPromise = audioEl.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {});
      }
    } catch {
      // Abaikan jika srcObject belum tersedia; izin gesture WebView tetap terbuka
    }
  }, []);

  const attachRemoteCallAudioStream = useCallback(
    (remoteStream: MediaStream | null, forceRebind = false) => {
      remoteStreamRef.current = remoteStream;

      const audioEl =
        remoteCallAudioRef.current ||
        (document.getElementById('remoteAudio') as HTMLAudioElement | null);

      if (!remoteStream) {
        try {
          if (audioEl) {
            audioEl.pause();
            audioEl.srcObject = null;
          }
        } catch {
          // ignore
        }
        try {
          closeCallAudioContext();
        } catch {
          // ignore
        }
        return;
      }

      try {
        // Pastikan seluruh track audio lawan dalam keadaan aktif
        remoteStream.getAudioTracks().forEach((track) => {
          track.enabled = true;
        });
      } catch {
        // ignore
      }

      if (callRuntimeRef.current) {
        callRuntimeRef.current.remoteStream = remoteStream;
      }

      const tryPlayRemoteAudio = () => {
        try {
          const el =
            remoteCallAudioRef.current ||
            (document.getElementById('remoteAudio') as HTMLAudioElement | null);
          if (!el || !el.srcObject) return;
          el.volume = 1.0;
          el.muted = !isSpeakerOnRef.current;
          el.play().catch((err) => {
            console.warn(
              '[WattappsAU WebRTC Audio] Autoplay diblokir, mencoba ulang saat sentuhan:',
              err
            );
            const unlockOnGesture = () => {
              try {
                const currentEl =
                  remoteCallAudioRef.current ||
                  (document.getElementById('remoteAudio') as HTMLAudioElement | null);
                if (currentEl && currentEl.srcObject) {
                  currentEl.volume = 1.0;
                  currentEl.muted = !isSpeakerOnRef.current;
                  void currentEl.play().catch(() => {});
                }
              } catch {
                // ignore
              }
              try {
                const activeCtx = callAudioCtxRef.current;
                if (activeCtx && activeCtx.state === 'suspended') {
                  void activeCtx.resume().catch(() => {});
                }
              } catch {
                // ignore
              }
            };
            window.addEventListener('pointerdown', unlockOnGesture, { once: true, passive: true });
            window.addEventListener('touchstart', unlockOnGesture, { once: true, passive: true });
          });
        } catch (err) {
          console.warn('[WattappsAU WebRTC Audio] Gagal memutar remoteAudio:', err);
        }
      };

      // 1. Blok try/catch terpisah: tempelkan remoteStream ke <audio id="remoteAudio"> lalu putar segera
      try {
        if (audioEl) {
          if (forceRebind) {
            audioEl.pause();
            audioEl.srcObject = null;
          }
          if (audioEl.srcObject !== remoteStream) {
            audioEl.srcObject = remoteStream;
          }
          audioEl.volume = 1.0;
          audioEl.muted = !isSpeakerOnRef.current;
        }
        tryPlayRemoteAudio();
      } catch (err) {
        console.warn('[WattappsAU WebRTC Audio] Gagal menempelkan remoteAudio.srcObject:', err);
      }

      // 2. Blok try/catch terpisah: hubungkan remoteStream ke Web Audio API (AudioContext) tanpa mengganggu handshake panggilan
      try {
        connectRemoteStreamToAudioContext(remoteStream);
        const ctx = callAudioCtxRef.current;
        if (ctx && ctx.state === 'suspended') {
          void ctx.resume().catch(() => {});
        }
      } catch (err) {
        console.warn('[WattappsAU WebRTC Audio] AudioContext backup gagal:', err);
      }

      // Paksa pemutaran & sambung ulang AudioContext secara aman jika track audio masuk belakangan atau baru unmute
      remoteStream.onaddtrack = () => {
        try {
          remoteStream.getAudioTracks().forEach((track) => {
            track.enabled = true;
          });
        } catch {
          // ignore
        }
        tryPlayRemoteAudio();
        try {
          connectRemoteStreamToAudioContext(remoteStream);
        } catch {
          // ignore
        }
      };
      remoteStream.getAudioTracks().forEach((track) => {
        track.onunmute = () => {
          tryPlayRemoteAudio();
          try {
            connectRemoteStreamToAudioContext(remoteStream);
          } catch {
            // ignore
          }
        };
      });
    },
    [closeCallAudioContext, connectRemoteStreamToAudioContext]
  );

  const isExitedRef = useRef<boolean>(isExited);
  const backGuardStateRef = useRef({
    activeTab,
    activeChatId,
    searchOpen,
    showMainMenu,
    showProfileDrawer,
    showNewChatModal,
    showNewGroupModal,
    showShareAppModal,
    showResetConfirm,
    cameraPurpose,
    lightboxMedia,
    hasCallModal: Boolean(activeCallUI || incomingCall),
  });

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);
  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    pendingMessagesRef.current = pendingMessages;
  }, [pendingMessages]);
  useEffect(() => {
    standbyModeRef.current = standbyMode;
  }, [standbyMode]);
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);
  useEffect(() => {
    isExitedRef.current = isExited;
  }, [isExited]);
  useEffect(() => {
    backGuardStateRef.current = {
      activeTab,
      activeChatId,
      searchOpen,
      showMainMenu,
      showProfileDrawer,
      showNewChatModal,
      showNewGroupModal,
      showShareAppModal,
      showResetConfirm,
      cameraPurpose,
      lightboxMedia,
      hasCallModal: Boolean(activeCallUI || incomingCall),
    };
  }, [
    activeTab,
    activeChatId,
    searchOpen,
    showMainMenu,
    showProfileDrawer,
    showNewChatModal,
    showNewGroupModal,
    showShareAppModal,
    showResetConfirm,
    cameraPurpose,
    lightboxMedia,
    activeCallUI,
    incomingCall,
  ]);

  // Sync Tailwind dark class & browser theme-color
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    saveTheme(theme);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', theme === 'dark' ? '#1F2C34' : '#008069');
    }
  }, [theme]);

  // Sync unread counts to localStorage
  useEffect(() => {
    saveUnreadCounts(unreadCounts);
  }, [unreadCounts]);

  // Sync outboxMessages metadata to localStorage
  useEffect(() => {
    if (!dataLoaded) return;
    saveOutboxMessages(pendingMessages);
  }, [pendingMessages, dataLoaded]);

  // Unlock global AudioContext on first user touch/click anywhere on screen
  useEffect(() => {
    return initGlobalAudioUnlock();
  }, []);

  const showToast = useCallback(
    (message: string, durationMs = 2800, tone: 'default' | 'warning' = 'default') => {
      setToastTone(tone);
      setToast(message);
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = window.setTimeout(() => {
        setToast(null);
      }, durationMs);
    },
    []
  );

  // Load IndexedDB data on startup
  useEffect(() => {
    let active = true;
    loadAllLocalData().then((data) => {
      if (!active) return;
      const normalizedContacts = data.contacts.map((c) => {
        if (c.isGroup) return c;
        const cleanId = normalizePeerId(c.id);
        if (cleanId && cleanId !== c.id) {
          const updated = { ...c, id: cleanId };
          void dbSaveContact(updated);
          return updated;
        }
        return c;
      });
      setContacts(normalizedContacts);
      setMessages(data.messages);
      setStatuses(data.statuses);
      setCalls(data.calls);
      setPendingMessages(data.pendingMessages);
      setDataLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  // Aktifkan Mode Siaga secara default saat aplikasi pertama kali aktif dengan profil
  useEffect(() => {
    if (isExited) return;
    setStandbyExternalListener((active) => {
      setStandbyMode(active);
    });
    if (profile && standbyModeRef.current) {
      void enableStandbyMode();
    }
    return () => {
      setStandbyExternalListener(null);
    };
  }, [profile?.id, isExited]);

  // Daftarkan elemen ringtoneAudioRef agar ikut dihancurkan oleh stopAllRingtones()
  useEffect(() => {
    return registerRingtoneAudioElement(ringtoneAudioRef.current);
  }, []);

  // Pastikan suara dering mati total setiap kali status panggilan berubah menjadi connected atau ended (null)
  useEffect(() => {
    if (
      activeCallUI?.phase === 'connected' ||
      (!activeCallUI && !incomingCall && !callRuntimeRef.current && !pendingCallRef.current)
    ) {
      stopAllCallRingtones();
    }
  }, [activeCallUI?.phase, activeCallUI, incomingCall, stopAllCallRingtones]);

  // Jalankan syncFcmToken() segera saat aplikasi dibuka dan setiap 5 detik setelah ID terkunci tersedia
  useEffect(() => {
    if (!profile?.id || isExited) return;
    const lockedId = getLockedUserId();
    if (!lockedId || lockedId !== profile.id) {
      // Pastikan kunci wattapps_user_id sinkron sebelum sinkronisasi Firestore berjalan
      saveUserProfile(profile);
    }
    return startFcmTokenSyncLoop(profile.id, profile.name);
  }, [profile?.id, profile?.name, isExited]);

  // Release Wake Lock & silent audio on unmount
  useEffect(() => {
    return () => {
      stopAllCallRingtones();
      if (unansweredCallTimerRef.current !== null) {
        window.clearTimeout(unansweredCallTimerRef.current);
      }
      void disableStandbyMode();
    };
  }, [stopAllCallRingtones]);

  // Helper to upsert contact
  const upsertContact = useCallback((contact: Contact) => {
    setContacts((prev) => {
      const idx = prev.findIndex((c) => c.id === contact.id);
      if (idx >= 0) {
        const merged = { ...prev[idx], ...contact };
        void dbSaveContact(merged);
        const copy = [...prev];
        copy[idx] = merged;
        return copy;
      }
      void dbSaveContact(contact);
      return [contact, ...prev];
    });
  }, []);

  /**
   * Cocokkan identitas asli lawan bicara langsung dari Firestore (`device_tokens` / `users`)
   * lalu sinkronkan seketika ke daftar kontak, layar panggilan aktif, panggilan masuk, dan riwayat panggilan.
   */
  const resolvePeerIdentity = useCallback(
    async (rawPeerId: string, fallbackName?: string, forceRefresh = false): Promise<string | null> => {
      const cleanId = fromFullPeerId(rawPeerId);
      if (!cleanId || cleanId.startsWith('GRP-')) return null;

      const remoteIdentity = await fetchPeerIdentityFromFirestore(cleanId, { forceRefresh });
      const resolvedName =
        remoteIdentity?.displayName ||
        (fallbackName && !isPlaceholderPeerName(fallbackName) ? fallbackName.trim() : null);

      const finalDisplayName = resolvedName || `Pengguna (${formatSixDigitId(cleanId)})`;

      // Perbarui daftar kontak jika nama sebelumnya masih placeholder / memuat identitas atau Firestore punya nama resmi
      setContacts((prev) => {
        let changed = false;
        const next = prev.map((c) => {
          if (c.isGroup || normalizePeerId(c.id) !== cleanId) return c;
          const shouldReplace =
            Boolean(resolvedName && c.name !== resolvedName) ||
            isPlaceholderPeerName(c.name);
          if (!shouldReplace) return c;
          changed = true;
          const updated: Contact = {
            ...c,
            name: resolvedName || (isPlaceholderPeerName(c.name) ? finalDisplayName : c.name),
            avatar: c.avatar || remoteIdentity?.avatar || '',
          };
          void dbSaveContact(updated);
          return updated;
        });
        return changed ? next : prev;
      });

      // Perbarui layar panggilan aktif / panggilan masuk secara real-time
      setActiveCallUI((prev) => {
        if (!prev || normalizePeerId(prev.peerId) !== cleanId) return prev;
        if (!resolvedName && !isPlaceholderPeerName(prev.peerName)) return prev;
        const nextName = resolvedName || finalDisplayName;
        if (prev.peerName === nextName) return prev;
        return { ...prev, peerName: nextName };
      });

      if (callRuntimeRef.current && normalizePeerId(callRuntimeRef.current.peerId) === cleanId) {
        if (resolvedName || isPlaceholderPeerName(callRuntimeRef.current.peerName)) {
          callRuntimeRef.current.peerName = resolvedName || finalDisplayName;
        }
      }

      if (pendingCallRef.current && normalizePeerId(pendingCallRef.current.peerId) === cleanId) {
        if (resolvedName || isPlaceholderPeerName(pendingCallRef.current.peerName)) {
          pendingCallRef.current.peerName = resolvedName || finalDisplayName;
        }
      }

      if (incomingCallRef.current && normalizePeerId(incomingCallRef.current.callerId) === cleanId) {
        if (resolvedName || isPlaceholderPeerName(incomingCallRef.current.callerName)) {
          const updatedIncoming = {
            ...incomingCallRef.current,
            callerName: resolvedName || finalDisplayName,
          };
          incomingCallRef.current = updatedIncoming;
          setIncomingCall(updatedIncoming);
        }
      }

      if (resolvedName) {
        setCalls((prev) => {
          let changed = false;
          const next = prev.map((rec) => {
            if (normalizePeerId(rec.peerId) === cleanId && isPlaceholderPeerName(rec.peerName)) {
              changed = true;
              const updated = { ...rec, peerName: resolvedName };
              void dbSaveCall(updated);
              return updated;
            }
            return rec;
          });
          return changed ? next : prev;
        });
      }

      return resolvedName;
    },
    [isPlaceholderPeerName]
  );

  // Sinkronkan identitas asli semua kontak tersimpan dari Firestore saat data lokal selesai dimuat
  useEffect(() => {
    if (!dataLoaded || !profile?.id || isExited) return;
    contactsRef.current
      .filter((c) => !c.isGroup)
      .forEach((c) => {
        void resolvePeerIdentity(c.id, c.name);
      });
  }, [dataLoaded, profile?.id, isExited, resolvePeerIdentity]);

  // Setiap kali membuka ruang chat, pastikan identitas lawan bicara dicocokkan langsung dengan Firestore
  useEffect(() => {
    if (!activeChatId || activeChatId.startsWith('GRP-')) return;
    void resolvePeerIdentity(activeChatId);
  }, [activeChatId, resolvePeerIdentity]);

  // Hapus satu entri dari antrean outbox tertunda
  const removePendingEntry = useCallback((messageId: string, recipientId: string) => {
    const entryId = `${messageId}:${recipientId}`;
    pendingLastAttemptRef.current.delete(entryId);
    setPendingMessages((prev) => {
      if (!prev.some((p) => p.id === entryId)) return prev;
      return prev.filter((p) => p.id !== entryId);
    });
    void dbDeletePendingMessage(entryId);
  }, []);

  // Konfirmasi MSG_ACK / FILE_ACK dari penerima -> hapus dari outbox & ubah jadi Centang 2 biru
  const markMessageConfirmedBlueTick = useCallback(
    (messageId: string, fromId: string) => {
      removePendingEntry(messageId, fromId);
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === messageId) {
            const updated: ChatMessage = {
              ...m,
              status: 'read',
              transferProgress: undefined,
              transferWaitingPeer: undefined,
            };
            void dbSaveMessage(updated);
            return updated;
          }
          return m;
        })
      );
    },
    [removePendingEntry]
  );

  // Helper to send READ_ACK for unread messages in a chat
  const sendReadAcksForChat = useCallback((chatId: string) => {
    const me = profileRef.current;
    const manager = peerManagerRef.current;
    if (!me || !manager) return;

    const unreadFromPeer = messagesRef.current.filter(
      (m) =>
        m.chatId === chatId &&
        m.type !== 'call_log' &&
        m.senderId !== me.id &&
        m.status !== 'read'
    );
    if (unreadFromPeer.length === 0) return;

    // Group message IDs by senderId (works for both 1:1 and group chats)
    const bySender = new Map<string, string[]>();
    for (const m of unreadFromPeer) {
      const arr = bySender.get(m.senderId) || [];
      arr.push(m.id);
      bySender.set(m.senderId, arr);
    }

    bySender.forEach((messageIds, senderId) => {
      manager.sendPacket(senderId, {
        kind: 'READ_ACK',
        chatId,
        messageIds,
        fromId: me.id,
      });
    });

    // Mark locally as read
    const idSet = new Set(unreadFromPeer.map((m) => m.id));
    setMessages((prev) =>
      prev.map((m) => {
        if (idSet.has(m.id)) {
          const updated: ChatMessage = { ...m, status: 'read' };
          void dbSaveMessage(updated);
          return updated;
        }
        return m;
      })
    );
  }, []);

  // Simpan gelembung Log Riwayat Panggilan otomatis ke ruang chat kontak & IndexedDB
  const appendCallLogToChat = useCallback(
    (record: CallRecord) => {
      const me = profileRef.current;
      if (!me) return;

      if (!contactsRef.current.some((c) => c.id === record.peerId)) {
        upsertContact({
          id: record.peerId,
          name: getTrustedPeerName(record.peerId, record.peerName),
          bio: 'Ada',
          avatar: record.peerAvatar || '',
          addedAt: Date.now(),
        });
        void resolvePeerIdentity(record.peerId, record.peerName);
      }

      const isVideo = record.callType === 'video';
      const label =
        record.status === 'rejected'
          ? isVideo
            ? 'Panggilan video tak terjawab / ditolak'
            : 'Panggilan suara tak terjawab / ditolak'
          : record.status === 'missed'
          ? isVideo
            ? 'Panggilan video tak terjawab'
            : 'Panggilan suara tak terjawab'
          : record.direction === 'outgoing'
          ? isVideo
            ? 'Panggilan video keluar'
            : 'Panggilan suara keluar'
          : isVideo
          ? 'Panggilan video masuk'
          : 'Panggilan suara masuk';

      const callLogMsg: ChatMessage = {
        id: `calllog-${record.id}`,
        chatId: record.peerId,
        senderId: record.direction === 'outgoing' ? me.id : record.peerId,
        senderName: record.direction === 'outgoing' ? me.name : record.peerName,
        type: 'call_log',
        text: label,
        timestamp: record.timestamp,
        status: 'read',
        callLog: {
          callId: record.id,
          callType: record.callType,
          direction: record.direction,
          status: record.status,
          duration: record.duration,
        },
      };

      setMessages((prev) => {
        if (prev.some((m) => m.id === callLogMsg.id)) return prev;
        return [...prev, callLogMsg];
      });
      void dbSaveMessage(callLogMsg);
    },
    [upsertContact]
  );

  const setPersistentIncomingCall = useCallback((next: IncomingCallState | null) => {
    incomingCallRef.current = next;
    setIncomingCall(next);
  }, []);

  const isIncomingCallStillActive = useCallback((ic: IncomingCallState | null): boolean => {
    if (!ic) return false;
    if (ic.call) {
      if (ic.call.open) return true;
      const pc = (ic.call as unknown as { peerConnection?: RTCPeerConnection }).peerConnection;
      if (pc && (pc.connectionState === 'closed' || pc.connectionState === 'failed')) {
        return false;
      }
      return true;
    }
    return Date.now() - ic.timestamp <= PENDING_CALL_TTL_MS;
  }, []);

  // Clean up any active or pending call & record call history + chat call log bubble
  const finalizeCall = useCallback(
    (statusOverride?: 'answered' | 'missed' | 'rejected') => {
      // BARIS PERTAMA: hentikan & hancurkan seluruh suara dering secara sinkron
      stopAllCallRingtones();
      if (unansweredCallTimerRef.current !== null) {
        window.clearTimeout(unansweredCallTimerRef.current);
        unansweredCallTimerRef.current = null;
      }
      if (callTimerRef.current !== null) {
        window.clearInterval(callTimerRef.current);
        callTimerRef.current = null;
      }

      const pendingWait = awaitingMediaCallAnswerRef.current;
      if (pendingWait) {
        window.clearTimeout(pendingWait.timeoutId);
        pendingWait.localStream.getTracks().forEach((t) => t.stop());
        awaitingMediaCallAnswerRef.current = null;
      }

      const pendingCall = pendingCallRef.current;
      pendingCallRef.current = null;

      const currentIncoming = incomingCallRef.current;
      setPersistentIncomingCall(null);

      const rt = callRuntimeRef.current;
      callRuntimeRef.current = null;
      remoteStreamRef.current = null;
      isSpeakerOnRef.current = true;
      attachRemoteCallAudioStream(null);
      setAndroidBridgeCallAudioMode(false);
      setActiveCallUI(null);
      dismissIncomingCallNotification(rt?.peerId || pendingCall?.peerId || currentIncoming?.callerId);

      // Lanjutkan kembali silent keep-alive jika Mode Siaga masih aktif setelah panggilan selesai
      resumeKeepAliveAfterCall();

      if (!rt) {
        if (currentIncoming?.call) {
          try {
            currentIncoming.call.close();
          } catch {
            // ignore
          }
        }
        if (pendingCall && statusOverride) {
          const record: CallRecord = {
            id: pendingCall.callId,
            peerId: pendingCall.peerId,
            peerName: pendingCall.peerName,
            peerAvatar: pendingCall.peerAvatar,
            callType: pendingCall.callType,
            direction: 'incoming',
            status: statusOverride,
            timestamp: pendingCall.receivedAt,
            duration: 0,
          };
          setCalls((prev) => (prev.some((c) => c.id === record.id) ? prev : [record, ...prev]));
          void dbSaveCall(record);
          appendCallLogToChat(record);
        }
        return;
      }

      try {
        rt.mediaCall.close();
      } catch {
        // ignore
      }
      if (rt.localStream) {
        rt.localStream.getTracks().forEach((t) => t.stop());
      }

      const duration = rt.connectedAt
        ? Math.max(1, Math.floor((Date.now() - rt.connectedAt) / 1000))
        : 0;
      const finalStatus: CallRecord['status'] =
        statusOverride ?? (rt.connectedAt ? 'answered' : 'missed');

      const record: CallRecord = {
        id: rt.callId,
        peerId: rt.peerId,
        peerName: rt.peerName,
        peerAvatar: rt.peerAvatar,
        callType: rt.callType,
        direction: rt.direction,
        status: finalStatus,
        timestamp: rt.startedAt,
        duration,
      };
      setCalls((prev) => (prev.some((c) => c.id === record.id) ? prev : [record, ...prev]));
      void dbSaveCall(record);
      appendCallLogToChat(record);
    },
    [appendCallLogToChat, setPersistentIncomingCall, stopAllCallRingtones]
  );

  // Tampilkan paksa Modal Layar Penuh Panggilan Masuk (saat notifikasi diketuk / kembali dari latar belakang)
  const forceShowIncomingCallModal = useCallback(
    (override?: {
      callerId?: string;
      callerName?: string;
      callId?: string;
      callType?: CallType;
      isVideo?: boolean;
    }) => {
      // Jika sudah tersambung dalam panggilan aktif, jangan timpa layar connected
      if (callRuntimeRef.current?.connectedAt) return;

      const dismissBlockingOverlays = () => {
        setShowMainMenu(false);
        setShowProfileDrawer(false);
        setShowShareAppModal(false);
        setShowNewChatModal(false);
        setShowNewGroupModal(false);
        setShowResetConfirm(false);
        setCameraPurpose(null);
        setLightboxMedia(null);
      };

      const activeIncoming = incomingCallRef.current;
      if (activeIncoming && isIncomingCallStillActive(activeIncoming)) {
        dismissBlockingOverlays();
        setIncomingCall({ ...activeIncoming });
        const callType: CallType = activeIncoming.isVideo ? 'video' : 'audio';
        setActiveCallUI({
          callId: activeIncoming.callId,
          peerId: activeIncoming.callerId,
          peerName: activeIncoming.callerName,
          peerAvatar: activeIncoming.callerAvatar,
          callType,
          phase: 'incoming',
          duration: 0,
          isMuted: false,
          isCameraOff: !activeIncoming.isVideo,
          isSpeakerOn: true,
          localStream: null,
          remoteStream: null,
        });
        setIncomingCallModalForceTick((n) => n + 1);
        return;
      }

      if (activeIncoming && !isIncomingCallStillActive(activeIncoming)) {
        setPersistentIncomingCall(null);
      }

      if (override?.callerId) {
        const cleanId = fromFullPeerId(override.callerId.trim());
        if (!cleanId) return;
        const existingContact = contactsRef.current.find((c) => c.id === cleanId);
        const callerName = getTrustedPeerName(cleanId, override.callerName);
        const callerAvatar = existingContact?.avatar || '';
        const isVideo = Boolean(override.isVideo ?? override.callType === 'video');
        const callType: CallType = isVideo ? 'video' : 'audio';
        const callId = override.callId || generateUid('call');
        void resolvePeerIdentity(cleanId, override.callerName, true);

        const pending: PendingIncomingCall = {
          callId,
          peerId: cleanId,
          peerName: callerName,
          peerAvatar: callerAvatar,
          callType,
          receivedAt: Date.now(),
        };
        pendingCallRef.current = pending;
        setPersistentIncomingCall({
          call: null,
          callId,
          callerId: cleanId,
          callerName,
          callerAvatar,
          isVideo,
          timestamp: Date.now(),
        });

        dismissBlockingOverlays();
        setActiveCallUI({
          callId,
          peerId: cleanId,
          peerName: callerName,
          peerAvatar: callerAvatar,
          callType,
          phase: 'incoming',
          duration: 0,
          isMuted: false,
          isCameraOff: !isVideo,
          isSpeakerOn: true,
          localStream: null,
          remoteStream: null,
        });
        setIncomingCallModalForceTick((n) => n + 1);
      }
    },
    [getTrustedPeerName, isIncomingCallStillActive, resolvePeerIdentity, setPersistentIncomingCall]
  );

  // Tampilkan pop-up panggilan masuk untuk pendingCall (misal saat kembali dari latar belakang / klik notifikasi)
  const presentPendingCallModal = useCallback(
    (pending: PendingIncomingCall) => {
      if (callRuntimeRef.current) return;
      if (Date.now() - pending.receivedAt > PENDING_CALL_TTL_MS) {
        if (pendingCallRef.current?.callId === pending.callId) {
          pendingCallRef.current = null;
        }
        return;
      }

      setPersistentIncomingCall({
        call: incomingCallRef.current?.callerId === pending.peerId ? incomingCallRef.current.call : null,
        callId: pending.callId,
        callerId: pending.peerId,
        callerName: pending.peerName,
        callerAvatar: pending.peerAvatar,
        isVideo: pending.callType === 'video',
        timestamp: pending.receivedAt,
      });

      setShowMainMenu(false);
      setShowProfileDrawer(false);
      setShowShareAppModal(false);
      setShowNewChatModal(false);
      setShowNewGroupModal(false);
      setShowResetConfirm(false);
      setCameraPurpose(null);
      setLightboxMedia(null);

      setActiveCallUI((prev) => {
        if (prev && prev.callId === pending.callId && prev.phase === 'incoming') return prev;
        return {
          callId: pending.callId,
          peerId: pending.peerId,
          peerName: pending.peerName,
          peerAvatar: pending.peerAvatar,
          callType: pending.callType,
          phase: 'incoming',
          duration: 0,
          isMuted: false,
          isCameraOff: pending.callType !== 'video',
          isSpeakerOn: true,
          localStream: null,
          remoteStream: null,
        };
      });
      setIncomingCallModalForceTick((n) => n + 1);
    },
    [setPersistentIncomingCall]
  );

  // Daftarkan listener call.on('stream'), pc.ontrack, & status ICE SEGERA saat panggilan masuk/keluar dibuat
  // agar event stream tidak pernah terlewat dan selalu di-buffer ke remoteStreamRef + <audio id="remoteAudio">
  const bindMediaCallDiagnostics = useCallback(
    (callId: string, mediaCall: MediaConnection) => {
      const handleRemoteStreamArrived = (remoteStream: MediaStream) => {
        const rt = callRuntimeRef.current;
        const ic = incomingCallRef.current;
        const matchesRuntime = Boolean(rt && (rt.mediaCall === mediaCall || rt.callId === callId));
        const matchesIncoming = Boolean(ic && (ic.call === mediaCall || ic.callId === callId));
        if (!matchesRuntime && !matchesIncoming) return;

        // Selalu buffer ke remoteStreamRef & langsung tempelkan ke <audio id="remoteAudio"> secara aman
        remoteStreamRef.current = remoteStream;
        if (rt && matchesRuntime) {
          rt.remoteStream = remoteStream;
        }
        try {
          attachRemoteCallAudioStream(remoteStream);
        } catch (err) {
          console.error('[WattappsAU Call] Gagal memasang remoteStream:', err);
        }

        const isCallAnsweredOrOutgoing = Boolean(
          rt && matchesRuntime && (rt.direction === 'outgoing' || Boolean(rt.connectedAt))
        );
        if (isCallAnsweredOrOutgoing && rt) {
          if (unansweredCallTimerRef.current !== null) {
            window.clearTimeout(unansweredCallTimerRef.current);
            unansweredCallTimerRef.current = null;
          }

          stopAllCallRingtones();
          isSpeakerOnRef.current = true;

          if (!rt.connectedAt) {
            rt.connectedAt = Date.now();
            if (callTimerRef.current !== null) {
              window.clearInterval(callTimerRef.current);
            }
            callTimerRef.current = window.setInterval(() => {
              if (!callRuntimeRef.current?.connectedAt) return;
              const secs = Math.floor((Date.now() - callRuntimeRef.current.connectedAt) / 1000);
              setActiveCallUI((prev) => (prev ? { ...prev, duration: secs } : null));
            }, 1000);
          }
        }

        const pc = getMediaCallPeerConnection(mediaCall);
        setActiveCallUI((prev) =>
          prev
            ? {
                ...prev,
                phase: isCallAnsweredOrOutgoing ? 'connected' : prev.phase,
                isSpeakerOn: true,
                remoteStream,
                iceState: pc?.iceConnectionState || prev.iceState || 'checking',
              }
            : null
        );

        void inspectMediaCallTransport(mediaCall, false).then((mode) => {
          if (
            mode &&
            callRuntimeRef.current?.callId === callId &&
            callRuntimeRef.current.mediaCall === mediaCall
          ) {
            setActiveCallUI((prev) => (prev ? { ...prev, connectionMode: mode } : null));
          }
        });
      };

      // 1. Daftarkan call.on('stream') tepat sekali SEGERA saat MediaConnection tersedia (termasuk sebelum tombol Jawab ditekan)
      if (!boundStreamCallsRef.current.has(mediaCall)) {
        boundStreamCallsRef.current.add(mediaCall);
        mediaCall.on('stream', (remoteStream) => {
          handleRemoteStreamArrived(remoteStream);
        });
      }

      // 2. Daftarkan listener RTCPeerConnection (pc.ontrack & iceconnectionstatechange) secara idempoten
      const attachPcListeners = (): boolean => {
        const pc = getMediaCallPeerConnection(mediaCall);
        if (!pc) return false;

        if (!boundPcRef.current.has(pc)) {
          boundPcRef.current.add(pc);

          const syncIceState = () => {
            const rt = callRuntimeRef.current;
            if (!rt || rt.callId !== callId || rt.mediaCall !== mediaCall) {
              pc.removeEventListener('iceconnectionstatechange', syncIceState);
              pc.removeEventListener('track', handleTrackEvent);
              return;
            }
            const state = pc.iceConnectionState || 'checking';
            setActiveCallUI((prev) => (prev ? { ...prev, iceState: state } : null));
            if (state === 'connected' || state === 'completed') {
              void inspectMediaCallTransport(mediaCall, false).then((mode) => {
                if (
                  mode &&
                  callRuntimeRef.current?.callId === callId &&
                  callRuntimeRef.current.mediaCall === mediaCall
                ) {
                  setActiveCallUI((prev) => (prev ? { ...prev, connectionMode: mode } : null));
                }
              });
            }
          };

          const handleTrackEvent = (event: RTCTrackEvent) => {
            const rt = callRuntimeRef.current;
            if (!rt || rt.callId !== callId || rt.mediaCall !== mediaCall) return;
            const incomingStream =
              event.streams && event.streams[0]
                ? event.streams[0]
                : new MediaStream([event.track]);
            handleRemoteStreamArrived(incomingStream);
          };

          pc.addEventListener('iceconnectionstatechange', syncIceState);
          pc.addEventListener('track', handleTrackEvent);
          syncIceState();
        } else {
          const state = pc.iceConnectionState || 'checking';
          setActiveCallUI((prev) => (prev ? { ...prev, iceState: state } : null));
        }

        // Jika track remote sudah masuk lebih awal sebelum listener dipasang, langsung buffer & tempelkan ke remoteAudio
        const existingTracks = pc
          .getReceivers()
          .map((receiver) => receiver.track)
          .filter((track): track is MediaStreamTrack => Boolean(track && track.readyState === 'live'));
        if (existingTracks.length > 0 && !remoteStreamRef.current) {
          handleRemoteStreamArrived(new MediaStream(existingTracks));
        }

        return true;
      };

      if (!attachPcListeners()) {
        // PeerJS kadang menginisialisasi mediaCall.peerConnection pada microtask berikutnya
        window.setTimeout(() => {
          if (callRuntimeRef.current?.callId === callId && callRuntimeRef.current.mediaCall === mediaCall) {
            attachPcListeners();
          }
        }, 80);
      }
    },
    [attachRemoteCallAudioStream]
  );

  // Pasang listener stream/close/error segera setelah peer.call()
  const bindOutgoingMediaCall = useCallback(
    (callId: string, mediaCall: MediaConnection) => {
      bindMediaCallDiagnostics(callId, mediaCall);

      mediaCall.on('close', () => {
        if (
          callRuntimeRef.current?.callId === callId &&
          callRuntimeRef.current.mediaCall === mediaCall
        ) {
          finalizeCall();
        }
      });

      mediaCall.on('error', () => {
        if (
          callRuntimeRef.current?.callId === callId &&
          callRuntimeRef.current.mediaCall === mediaCall
        ) {
          showToast('Panggilan tidak dapat tersambung.');
          finalizeCall('missed');
        }
      });
    },
    [bindMediaCallDiagnostics, finalizeCall, showToast]
  );

  // Incoming PeerJS DataChannel packet handler
  const handleIncomingPacket = useCallback(
    (fromId: string, packet: PeerPacket) => {
      const me = profileRef.current;
      if (!me) return;

      switch (packet.kind) {
        case 'HELLO': {
          const existing = contactsRef.current.find((c) => c.id === fromId);
          if (existing) {
            upsertContact({
              ...existing,
              name: packet.profile.name || existing.name,
              bio: packet.profile.bio || existing.bio,
              avatar: packet.profile.avatar || existing.avatar,
              lastSeen: Date.now(),
            });
          }
          break;
        }

        case 'MESSAGE': {
          const incomingMsg = packet.message;
          // Determine local chatId: for 1:1, chatId is sender's 6-digit ID; for groups, keep groupId
          const localChatId = incomingMsg.isGroup ? incomingMsg.chatId : fromId;

          // Ensure contact / group exists locally
          if (incomingMsg.isGroup && packet.groupMeta) {
            const existingGroup = contactsRef.current.find((c) => c.id === localChatId);
            if (!existingGroup) {
              upsertContact({
                id: packet.groupMeta.id,
                name: packet.groupMeta.name,
                bio: 'Grup P2P WattappsAU',
                avatar: packet.groupMeta.avatar,
                addedAt: Date.now(),
                isGroup: true,
                members: packet.groupMeta.members,
                memberNames: packet.groupMeta.memberNames,
                adminId: packet.groupMeta.adminId,
              });
            }
          } else {
            const existingContact = contactsRef.current.find((c) => c.id === fromId);
            if (!existingContact) {
              upsertContact({
                id: fromId,
                name: getTrustedPeerName(fromId, incomingMsg.senderName),
                bio: 'Ada',
                avatar: '',
                addedAt: Date.now(),
              });
            }
            void resolvePeerIdentity(fromId, incomingMsg.senderName);
          }

          // Dekripsi payload teks AES-256-GCM (transparan & kompatibel mundur) sebelum disimpan & ditampilkan
          void (async () => {
            let resolvedText = incomingMsg.text;
            let resolvedReplyTo = incomingMsg.replyTo;
            let isE2EE = Boolean(incomingMsg.e2ee);

            if (packet.encrypted) {
              const scope = buildConversationScope({
                isGroup: Boolean(incomingMsg.isGroup),
                chatId: localChatId,
                peerA: me.id,
                peerB: fromId,
              });
              const decrypted = await decryptTextEnvelope(packet.encrypted, scope);
              if (decrypted) {
                if (typeof decrypted.text === 'string') {
                  resolvedText = decrypted.text;
                }
                if (resolvedReplyTo && typeof decrypted.replyText === 'string') {
                  resolvedReplyTo = { ...resolvedReplyTo, text: decrypted.replyText };
                }
                isE2EE = true;
              } else if (!resolvedText) {
                resolvedText = '[Pesan terenkripsi AES-256 tidak dapat didekripsi]';
              }
            }

            // Idempotent insert (guard duplicates)
            const alreadyExists = messagesRef.current.some((m) => m.id === incomingMsg.id);
            if (!alreadyExists) {
              const isViewingChat = activeChatIdRef.current === localChatId;
              const savedMsg: ChatMessage = {
                ...incomingMsg,
                chatId: localChatId,
                text: resolvedText,
                replyTo: resolvedReplyTo,
                e2ee: isE2EE,
                status: isViewingChat ? 'read' : 'delivered',
              };

              setMessages((prev) => {
                if (prev.some((m) => m.id === savedMsg.id)) return prev;
                return [...prev, savedMsg];
              });
              void dbSaveMessage(savedMsg);

              if (isViewingChat) {
                peerManagerRef.current?.sendPacket(fromId, {
                  kind: 'READ_ACK',
                  chatId: incomingMsg.isGroup ? localChatId : me.id,
                  messageIds: [incomingMsg.id],
                  fromId: me.id,
                });
              } else {
                setUnreadCounts((prev) => ({
                  ...prev,
                  [localChatId]: (prev[localChatId] || 0) + 1,
                }));
              }

              // Putar nada notifikasi ringan (saat terlihat) + getar tanpa menahan fokus audio
              playMessagePop(true);

              // Tampilkan Web Notification ala WhatsApp (penting saat tab/layar di latar belakang atau Mode Siaga)
              if (!isViewingChat || document.hidden || standbyModeRef.current) {
                const senderContact = contactsRef.current.find((c) => c.id === fromId);
                const senderTitle =
                  incomingMsg.isGroup && packet.groupMeta
                    ? `${packet.groupMeta.name} · ${incomingMsg.senderName}`
                    : senderContact?.name?.trim() || incomingMsg.senderName || `ID: ${fromId}`;
                const senderAvatar = senderContact?.avatar || '';
                const incomingMsgBody =
                  savedMsg.type === 'image'
                    ? savedMsg.text
                      ? `📷 Foto: ${savedMsg.text}`
                      : '📷 Foto'
                    : savedMsg.text || 'Pesan baru masuk';
                triggerAndroidBridgeIncomingMessage(senderTitle, incomingMsgBody);
                void showIncomingWebNotification({
                  title: senderTitle,
                  body: incomingMsgBody,
                  icon: senderAvatar || '/icon-512.png',
                  tag: `msg-${savedMsg.id}`,
                  data: {
                    kind: 'message',
                    chatId: localChatId,
                    fromId,
                    fromName: senderTitle,
                    callerAvatar: senderAvatar,
                  },
                  onClick: () => {
                    setActiveTab('chats');
                    setActiveChatId(localChatId);
                  },
                });
              }
            }

            // Selalu kirim balik MSG_ACK & DELIVERY_ACK (termasuk jika retry duplikat) agar outbox pengirim bersih & Centang 2 biru
            peerManagerRef.current?.sendPacket(fromId, {
              kind: 'MSG_ACK',
              messageId: incomingMsg.id,
              chatId: incomingMsg.isGroup ? localChatId : me.id,
              fromId: me.id,
            });
            peerManagerRef.current?.sendPacket(fromId, {
              kind: 'DELIVERY_ACK',
              messageId: incomingMsg.id,
              chatId: incomingMsg.isGroup ? localChatId : me.id,
              fromId: me.id,
            });
          })();
          break;
        }

        case 'MSG_ACK': {
          markMessageConfirmedBlueTick(packet.messageId, fromId);
          break;
        }

        case 'DELIVERY_ACK': {
          removePendingEntry(packet.messageId, fromId);
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id === packet.messageId && m.status !== 'read') {
                const updated: ChatMessage = {
                  ...m,
                  status: 'delivered',
                  transferProgress: undefined,
                  transferWaitingPeer: undefined,
                };
                void dbSaveMessage(updated);
                return updated;
              }
              return m;
            })
          );
          break;
        }

        case 'READ_ACK': {
          const idSet = new Set(packet.messageIds);
          packet.messageIds.forEach((mId) => removePendingEntry(mId, fromId));
          setMessages((prev) =>
            prev.map((m) => {
              if (idSet.has(m.id) && m.status !== 'read') {
                const updated: ChatMessage = {
                  ...m,
                  status: 'read',
                  transferProgress: undefined,
                  transferWaitingPeer: undefined,
                };
                void dbSaveMessage(updated);
                return updated;
              }
              return m;
            })
          );
          break;
        }

        case 'TYPING': {
          const targetChat = packet.chatId === me.id ? fromId : packet.chatId;
          if (typingClearTimersRef.current[targetChat]) {
            window.clearTimeout(typingClearTimersRef.current[targetChat]);
          }
          if (packet.isTyping) {
            setTypingMap((prev) => ({ ...prev, [targetChat]: packet.fromName }));
            typingClearTimersRef.current[targetChat] = window.setTimeout(() => {
              setTypingMap((prev) => {
                const next = { ...prev };
                delete next[targetChat];
                return next;
              });
            }, 3500);
          } else {
            setTypingMap((prev) => {
              const next = { ...prev };
              delete next[targetChat];
              return next;
            });
          }
          break;
        }

        case 'DELETE_MSG': {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id === packet.messageId) {
                const updated: ChatMessage = {
                  ...m,
                  deleted: true,
                  text: undefined,
                  mediaData: undefined,
                };
                void dbSaveMessage(updated);
                return updated;
              }
              return m;
            })
          );
          break;
        }

        case 'STATUS_UPDATE': {
          const s = packet.status;
          if (s.expiresAt <= Date.now()) return;
          setStatuses((prev) => {
            if (prev.some((item) => item.id === s.id)) return prev;
            const stored: StatusItem = { ...s, viewed: false };
            void dbSaveStatus(stored);
            return [stored, ...prev];
          });
          break;
        }

        case 'GROUP_INVITE': {
          upsertContact({ ...packet.group, isGroup: true });
          showToast(`Anda ditambahkan ke grup "${packet.group.name}"`);
          break;
        }

        case 'CALL_REQUEST': {
          // Simpan sebagai incomingCall & pendingCall, tampilkan pop-up panggilan masuk & mulai nada dering 440Hz+480Hz
          if (!callRuntimeRef.current && pendingCallRef.current?.callId !== packet.callId) {
            pauseKeepAliveForCall();
            startIncomingRingtone();
            const cleanId = fromFullPeerId(fromId);
            const existingContact = contactsRef.current.find((c) => c.id === cleanId);
            const callerName = getTrustedPeerName(cleanId, packet.fromName);
            const callerAvatar = existingContact?.avatar || packet.fromAvatar || '';
            const isVideo = packet.callType === 'video';
            const pending: PendingIncomingCall = {
              callId: packet.callId,
              peerId: cleanId,
              peerName: callerName,
              peerAvatar: callerAvatar,
              callType: packet.callType,
              receivedAt: Date.now(),
            };
            pendingCallRef.current = pending;
            presentPendingCallModal(pending);
            void resolvePeerIdentity(cleanId, packet.fromName, true);
            triggerAndroidBridgeIncomingCall(
              callerName,
              isVideo ? 'Panggilan video masuk...' : 'Panggilan masuk...'
            );
            showIncomingWebNotification({
              title: callerName,
              body: isVideo ? 'Panggilan video WattappsAU' : 'Panggilan suara WattappsAU',
              icon: callerAvatar || '/icon-512.png',
              tag: `wattapps-call-${cleanId}`,
              isCall: true,
              data: {
                action: 'ANSWER_CALL',
                kind: 'call',
                callerId: cleanId,
                callerName,
                callerAvatar,
                fromId: cleanId,
                fromName: callerName,
                callId: packet.callId,
                callType: packet.callType,
                isVideo,
              },
              onClick: () => {
                forceShowIncomingCallModal({
                  callerId: cleanId,
                  callerName,
                  callId: packet.callId,
                  callType: packet.callType,
                  isVideo,
                });
              },
            });
            if (wakeRingtoneTimerRef.current !== null) {
              window.clearTimeout(wakeRingtoneTimerRef.current);
            }
            wakeRingtoneTimerRef.current = window.setTimeout(() => {
              wakeRingtoneTimerRef.current = null;
              if (!callRuntimeRef.current && pendingCallRef.current?.callId === packet.callId) {
                finalizeCall('missed');
              }
            }, 30000);
          }
          break;
        }

        case 'CALL_SIGNAL': {
          const rt = callRuntimeRef.current;
          const pending = pendingCallRef.current;
          if (packet.action === 'reject') {
            if (rt && rt.peerId === fromId) {
              showToast(`${rt.peerName} menolak panggilan`);
              finalizeCall('rejected');
            } else if (pending && pending.peerId === fromId) {
              finalizeCall('rejected');
            }
          } else if (packet.action === 'end') {
            if (rt && rt.peerId === fromId) {
              showToast('Panggilan berakhir');
              finalizeCall();
            } else if (pending && pending.peerId === fromId) {
              finalizeCall('missed');
            }
          } else if (packet.action === 'busy' && rt && rt.peerId === fromId) {
            showToast(`${rt.peerName} sedang dalam panggilan lain`);
            finalizeCall('missed');
          } else if (
            (packet.action === 'ringing' || packet.action === 'accept') &&
            rt &&
            rt.direction === 'outgoing' &&
            !rt.connectedAt &&
            rt.peerId === fromId &&
            rt.localStream
          ) {
            // Penerima baru bangun dari latar belakang / zombie socket: kirim ulang MediaConnection segar
            const freshCall = peerManagerRef.current?.startMediaCall(
              fromId,
              rt.localStream,
              {
                callId: rt.callId,
                callType: rt.callType,
                isVideo: rt.callType === 'video',
                callerName: me.name,
                callerAvatar: me.avatar,
              }
            );
            if (freshCall) {
              const oldCall = rt.mediaCall;
              rt.mediaCall = freshCall;
              try {
                oldCall.close();
              } catch {
                // ignore
              }
              bindOutgoingMediaCall(rt.callId, freshCall);
            }
          }
          break;
        }
      }
    },
    [
      upsertContact,
      finalizeCall,
      presentPendingCallModal,
      forceShowIncomingCallModal,
      bindOutgoingMediaCall,
      showToast,
      markMessageConfirmedBlueTick,
      removePendingEntry,
    ]
  );

  // Incoming WebRTC Media Call handler (peer.on('call'))
  const handleIncomingMediaCall = useCallback(
    (mediaCall: MediaConnection) => {
      const me = profileRef.current;
      if (!me) return;
      // Ekstrak ID 6 digit murni (hilangkan prefix 'WA6-' atau 'WattappsAU-')
      const cleanId = fromFullPeerId(mediaCall.peer);

      const meta = (mediaCall.metadata || {}) as {
        callId?: string;
        callType?: CallType;
        isVideo?: boolean;
        callerName?: string;
        callerAvatar?: string;
      };

      // If already in a call, reply busy
      if (callRuntimeRef.current) {
        peerManagerRef.current?.sendPacket(cleanId, {
          kind: 'CALL_SIGNAL',
          action: 'busy',
          callId: generateUid('call'),
          callType: 'audio',
          fromId: me.id,
          fromName: me.name,
          fromAvatar: me.avatar,
        });
        mediaCall.close();
        return;
      }

      if (wakeRingtoneTimerRef.current !== null) {
        window.clearTimeout(wakeRingtoneTimerRef.current);
        wakeRingtoneTimerRef.current = null;
      }

      // Hentikan otomatis Silent Audio Keep-Alive agar tidak bentrok dengan audio mikrofon/speaker panggilan
      pauseKeepAliveForCall();
      pendingCallRef.current = null;

      const existingContact = contactsRef.current.find((c) => c.id === cleanId);
      const callerName = getTrustedPeerName(cleanId, meta.callerName);
      const callerAvatar = existingContact?.avatar || meta.callerAvatar || '';
      const isVideo = Boolean(meta.isVideo ?? meta.callType === 'video');
      const callType: CallType = isVideo ? 'video' : 'audio';
      const callId = meta.callId || generateUid('call');
      void resolvePeerIdentity(cleanId, meta.callerName, true);

      // Jika pengguna sudah menekan "Angkat" pada pop-up pendingCall saat kembali dari latar belakang, langsung jawab!
      const awaitingAnswer = awaitingMediaCallAnswerRef.current;
      if (awaitingAnswer && awaitingAnswer.peerId === cleanId) {
        stopAllCallRingtones();
        window.clearTimeout(awaitingAnswer.timeoutId);
        awaitingMediaCallAnswerRef.current = null;
        setPersistentIncomingCall(null);
        isSpeakerOnRef.current = true;

        awaitingAnswer.localStream.getAudioTracks().forEach((track) => {
          track.enabled = true;
        });

        callRuntimeRef.current = {
          callId,
          peerId: cleanId,
          peerName: callerName,
          peerAvatar: callerAvatar,
          callType,
          direction: 'incoming',
          mediaCall,
          localStream: awaitingAnswer.localStream,
          startedAt: Date.now(),
          connectedAt: Date.now(),
          facingMode: 'user',
        };

        // 1. Daftarkan listener stream SEGERA lalu EKSEKUSI answer(stream) PERTAMA sebelum pengaturan AudioContext/AndroidBridge/UI
        bindMediaCallDiagnostics(callId, mediaCall);

        mediaCall.on('close', () => {
          if (
            callRuntimeRef.current?.callId === callId &&
            callRuntimeRef.current.mediaCall === mediaCall
          ) {
            finalizeCall();
          }
        });

        mediaCall.on('error', () => {
          if (
            callRuntimeRef.current?.callId === callId &&
            callRuntimeRef.current.mediaCall === mediaCall
          ) {
            finalizeCall();
          }
        });

        try {
          if (peerManagerRef.current) {
            peerManagerRef.current.answerMediaCall(mediaCall, awaitingAnswer.localStream);
          } else {
            mediaCall.answer(awaitingAnswer.localStream);
            ensureLocalAudioTracksAttached(mediaCall, awaitingAnswer.localStream);
          }
        } catch (answerErr) {
          console.error('[WattappsAU Call] Gagal mengeksekusi answer() pada awaitingAnswer:', answerErr);
        }

        bindMediaCallDiagnostics(callId, mediaCall);

        // 2. Pengaturan audio native & remoteAudio dijalankan dalam try/catch terpisah setelah handshake answer
        try {
          setAndroidBridgeCallAudioMode(true);
        } catch {
          // ignore
        }
        try {
          const bufferedRemote = remoteStreamRef.current || callRuntimeRef.current?.remoteStream || null;
          if (bufferedRemote) {
            attachRemoteCallAudioStream(bufferedRemote);
          }
        } catch {
          // ignore
        }

        const bufferedRemote = remoteStreamRef.current || callRuntimeRef.current?.remoteStream || null;

        setActiveCallUI({
          callId,
          peerId: cleanId,
          peerName: callerName,
          peerAvatar: callerAvatar,
          callType,
          phase: 'connected',
          duration: 0,
          isMuted: false,
          isCameraOff: !isVideo,
          isSpeakerOn: true,
          connectionMode: 'connecting',
          iceState: getMediaCallPeerConnection(mediaCall)?.iceConnectionState || 'checking',
          localStream: awaitingAnswer.localStream,
          remoteStream: bufferedRemote,
        });

        if (callTimerRef.current !== null) {
          window.clearInterval(callTimerRef.current);
        }
        callTimerRef.current = window.setInterval(() => {
          if (!callRuntimeRef.current?.connectedAt) return;
          const secs = Math.floor((Date.now() - callRuntimeRef.current.connectedAt) / 1000);
          setActiveCallUI((prev) => (prev ? { ...prev, duration: secs } : null));
        }, 1000);
        return;
      }

      // Simpan state panggilan masuk secara persisten di incomingCall (state React) DAN incomingCallRef.current
      remoteStreamRef.current = null;
      setPersistentIncomingCall({
        call: mediaCall,
        callId,
        callerId: cleanId,
        callerName,
        callerAvatar,
        isVideo,
        timestamp: Date.now(),
      });

      callRuntimeRef.current = {
        callId,
        peerId: cleanId,
        peerName: callerName,
        peerAvatar: callerAvatar,
        callType,
        direction: 'incoming',
        mediaCall,
        localStream: null,
        startedAt: Date.now(),
        connectedAt: null,
        facingMode: 'user',
      };

      // SEGERA daftarkan listener call.on('stream') & pc.ontrack SEBELUM pengguna menekan tombol Jawab agar remoteStream ter-buffer aman
      bindMediaCallDiagnostics(callId, mediaCall);

      setShowMainMenu(false);
      setShowProfileDrawer(false);
      setShowShareAppModal(false);
      setShowNewChatModal(false);
      setShowNewGroupModal(false);
      setShowResetConfirm(false);
      setCameraPurpose(null);
      setLightboxMedia(null);

      setActiveCallUI({
        callId,
        peerId: cleanId,
        peerName: callerName,
        peerAvatar: callerAvatar,
        callType,
        phase: 'incoming',
        duration: 0,
        isMuted: false,
        isCameraOff: !isVideo,
        isSpeakerOn: true,
        iceState: getMediaCallPeerConnection(mediaCall)?.iceConnectionState || 'new',
        localStream: null,
        remoteStream: remoteStreamRef.current,
      });
      setIncomingCallModalForceTick((n) => n + 1);

      startIncomingRingtone();
      if (unansweredCallTimerRef.current !== null) {
        window.clearTimeout(unansweredCallTimerRef.current);
      }
      // Jika penerima tidak mengangkat dalam 30 detik, akhiri sebagai Panggilan tak terjawab
      unansweredCallTimerRef.current = window.setTimeout(() => {
        unansweredCallTimerRef.current = null;
        if (
          callRuntimeRef.current?.callId === callId &&
          !callRuntimeRef.current.connectedAt
        ) {
          finalizeCall('missed');
        }
      }, 30000);

      triggerAndroidBridgeIncomingCall(
        callerName,
        isVideo ? 'Panggilan video masuk...' : 'Panggilan masuk...'
      );
      showIncomingWebNotification({
        title: callerName,
        body: isVideo ? 'Panggilan video WattappsAU' : 'Panggilan suara WattappsAU',
        icon: callerAvatar || '/icon-512.png',
        tag: `wattapps-call-${cleanId}`,
        isCall: true,
        data: {
          action: 'ANSWER_CALL',
          kind: 'call',
          callerId: cleanId,
          callerName,
          callerAvatar,
          fromId: cleanId,
          fromName: callerName,
          callId,
          callType,
          isVideo,
        },
        onClick: () => {
          forceShowIncomingCallModal({
            callerId: cleanId,
            callerName,
            callId,
            callType,
            isVideo,
          });
        },
      });

      mediaCall.on('close', () => {
        if (
          callRuntimeRef.current?.callId === callId &&
          callRuntimeRef.current.mediaCall === mediaCall
        ) {
          finalizeCall();
        } else if (incomingCallRef.current?.call === mediaCall) {
          setPersistentIncomingCall(null);
        }
      });

      mediaCall.on('error', () => {
        if (
          callRuntimeRef.current?.callId === callId &&
          callRuntimeRef.current.mediaCall === mediaCall
        ) {
          finalizeCall();
        } else if (incomingCallRef.current?.call === mediaCall) {
          setPersistentIncomingCall(null);
        }
      });
    },
    [
      attachRemoteCallAudioStream,
      bindMediaCallDiagnostics,
      finalizeCall,
      forceShowIncomingCallModal,
      setPersistentIncomingCall,
    ]
  );

  // Reassembled chunked file/image/video/voice/status handler on receiver side
  const handleFileReceived = useCallback(
    async (fromId: string, transfer: ReassembledFileTransfer) => {
      const me = profileRef.current;
      if (!me) return;

      // 1. Jika paket chunk adalah foto Status 24 jam
      if (transfer.statusMeta) {
        const sm = transfer.statusMeta;
        if (sm.expiresAt <= Date.now()) return;
        const incomingStatus: StatusItem = {
          id: sm.id,
          userId: sm.userId,
          userName: sm.userName,
          userAvatar: sm.userAvatar,
          type: 'image',
          mediaData: transfer.dataUrl,
          caption: sm.caption,
          timestamp: sm.timestamp,
          expiresAt: sm.expiresAt,
          viewed: false,
        };
        setStatuses((prev) => {
          if (prev.some((item) => item.id === incomingStatus.id)) return prev;
          return [incomingStatus, ...prev];
        });
        await dbSaveStatus(incomingStatus);
        return;
      }

      // 2. Jika paket chunk adalah pesan chat (gambar, kamera, video, dokumen, voice note)
      const meta = transfer.messageMeta;
      if (!meta) return;

      const localChatId = meta.isGroup ? meta.chatId : fromId;

      if (meta.isGroup && meta.groupMeta) {
        const existingGroup = contactsRef.current.find((c) => c.id === localChatId);
        if (!existingGroup) {
          upsertContact({
            id: meta.groupMeta.id,
            name: meta.groupMeta.name,
            bio: 'Grup P2P WattappsAU',
            avatar: meta.groupMeta.avatar,
            addedAt: Date.now(),
            isGroup: true,
            members: meta.groupMeta.members,
            memberNames: meta.groupMeta.memberNames,
            adminId: meta.groupMeta.adminId,
          });
        }
      } else {
        const existingContact = contactsRef.current.find((c) => c.id === fromId);
        if (!existingContact) {
          upsertContact({
            id: fromId,
            name: getTrustedPeerName(fromId, meta.senderName),
            bio: 'Ada',
            avatar: '',
            addedAt: Date.now(),
          });
        }
        void resolvePeerIdentity(fromId, meta.senderName);
      }

      if (messagesRef.current.some((m) => m.id === meta.id)) {
        // Tetap balas MSG_ACK jika retry agar antrean pengirim bersih
        peerManagerRef.current?.sendPacket(fromId, {
          kind: 'MSG_ACK',
          messageId: meta.id,
          chatId: meta.isGroup ? localChatId : me.id,
          fromId: me.id,
        });
        return;
      }

      let resolvedCaption = meta.text;
      let resolvedReplyTo = meta.replyTo;
      if (meta.encrypted) {
        const scope = buildConversationScope({
          isGroup: Boolean(meta.isGroup),
          chatId: localChatId,
          peerA: me.id,
          peerB: fromId,
        });
        const decrypted = await decryptTextEnvelope(meta.encrypted, scope);
        if (decrypted) {
          if (typeof decrypted.text === 'string') {
            resolvedCaption = decrypted.text;
          }
          if (resolvedReplyTo && typeof decrypted.replyText === 'string') {
            resolvedReplyTo = { ...resolvedReplyTo, text: decrypted.replyText };
          }
        }
      }

      const isViewingChat = activeChatIdRef.current === localChatId;
      const savedMsg: ChatMessage = {
        id: meta.id,
        chatId: localChatId,
        senderId: meta.senderId,
        senderName: meta.senderName,
        type: meta.msgType,
        text: resolvedCaption,
        e2ee: Boolean(meta.encrypted || true),
        mediaData: transfer.dataUrl,
        fileName: transfer.fileName,
        fileSize: transfer.fileSize,
        mimeType: transfer.fileType,
        duration: meta.duration,
        timestamp: meta.timestamp,
        status: isViewingChat ? 'read' : 'delivered',
        replyTo: resolvedReplyTo,
        isGroup: meta.isGroup,
      };

      setMessages((prev) => {
        if (prev.some((m) => m.id === savedMsg.id)) return prev;
        return [...prev, savedMsg];
      });

      // Simpan ke IndexedDB (media Blob tersimpan di object store `media`) sebelum FILE_ACK dikirim balik
      await dbSaveMessage(savedMsg);

      // Kirim MSG_ACK & DELIVERY_ACK agar pengirim segera mendapat Centang 2 biru & membersihkan outbox
      peerManagerRef.current?.sendPacket(fromId, {
        kind: 'MSG_ACK',
        messageId: savedMsg.id,
        chatId: savedMsg.isGroup ? localChatId : me.id,
        fromId: me.id,
      });
      peerManagerRef.current?.sendPacket(fromId, {
        kind: 'DELIVERY_ACK',
        messageId: savedMsg.id,
        chatId: savedMsg.isGroup ? localChatId : me.id,
        fromId: me.id,
      });

      if (isViewingChat) {
        peerManagerRef.current?.sendPacket(fromId, {
          kind: 'READ_ACK',
          chatId: savedMsg.isGroup ? localChatId : me.id,
          messageIds: [savedMsg.id],
          fromId: me.id,
        });
      } else {
        setUnreadCounts((prev) => ({
          ...prev,
          [localChatId]: (prev[localChatId] || 0) + 1,
        }));
      }

      playMessagePop(true);

      if (!isViewingChat || document.hidden || standbyModeRef.current) {
        const mediaLabel =
          savedMsg.type === 'image'
            ? '📷 Foto'
            : savedMsg.type === 'video'
            ? '🎥 Video'
            : savedMsg.type === 'voice'
            ? '🎤 Pesan suara'
            : `📄 ${savedMsg.fileName || 'Dokumen'}`;
        const senderContact = contactsRef.current.find((c) => c.id === fromId);
        const senderTitle =
          meta.isGroup && meta.groupMeta
            ? `${meta.groupMeta.name} · ${meta.senderName}`
            : senderContact?.name?.trim() || meta.senderName || `ID: ${fromId}`;
        const senderAvatar = senderContact?.avatar || '';
        const incomingFileBody = savedMsg.text ? `${mediaLabel}: ${savedMsg.text}` : mediaLabel;
        triggerAndroidBridgeIncomingMessage(senderTitle, incomingFileBody);
        void showIncomingWebNotification({
          title: senderTitle,
          body: incomingFileBody,
          icon: senderAvatar || '/icon-512.png',
          tag: `msg-${savedMsg.id}`,
          data: {
            kind: 'message',
            chatId: localChatId,
            fromId,
            fromName: senderTitle,
            callerAvatar: senderAvatar,
          },
          onClick: () => {
            setActiveTab('chats');
            setActiveChatId(localChatId);
          },
        });
      }
    },
    [upsertContact]
  );

  // Konfirmasi FILE_ACK dari penerima: hilangkan bar tunggu, bersihkan antrean, ubah ke Centang 2 biru
  const handleFileAck = useCallback(
    (fromId: string, _fileId: string, messageId?: string) => {
      if (!messageId) return;
      markMessageConfirmedBlueTick(messageId, fromId);
    },
    [markMessageConfirmedBlueTick]
  );

  // Helper enkripsi AES-256-GCM & pengiriman satu paket pesan teks via PeerJS DataChannel
  const sendEncryptedMessageToPeer = useCallback(
    async (
      msg: ChatMessage,
      recipientId: string,
      groupMeta?: PendingOutboxMessage['groupMeta']
    ): Promise<boolean> => {
      const manager = peerManagerRef.current;
      const me = profileRef.current;
      if (!manager || !me) return false;

      const scope = buildConversationScope({
        isGroup: Boolean(msg.isGroup),
        chatId: msg.chatId,
        peerA: me.id,
        peerB: recipientId,
      });

      const encrypted = await encryptTextEnvelope(
        {
          text: msg.text,
          replyText: msg.replyTo?.text,
        },
        scope
      );

      // Jika AES-256-GCM berhasil, jangan kirim plaintext pada wire packet
      const wireMessage: ChatMessage = encrypted
        ? {
            ...msg,
            text: undefined,
            replyTo: msg.replyTo ? { ...msg.replyTo, text: '' } : undefined,
            e2ee: true,
          }
        : { ...msg, e2ee: Boolean(msg.e2ee) };

      return manager.sendPacket(recipientId, {
        kind: 'MESSAGE',
        message: wireMessage,
        encrypted: encrypted ?? undefined,
        groupMeta,
      });
    },
    []
  );

  // Helper pengiriman satu pesan media via chunked WebRTC (caption ikut dienkripsi AES-256-GCM)
  const sendMediaMessageToPeer = useCallback(
    async (
      msg: ChatMessage,
      recipientId: string,
      groupMeta?: PendingOutboxMessage['groupMeta']
    ): Promise<boolean> => {
      const manager = peerManagerRef.current;
      const me = profileRef.current;
      if (!manager || !me || !msg.mediaData || msg.type === 'text') return false;

      const scope = buildConversationScope({
        isGroup: Boolean(msg.isGroup),
        chatId: msg.chatId,
        peerA: me.id,
        peerB: recipientId,
      });
      const encryptedCaption = await encryptTextEnvelope(
        {
          text: msg.text,
          replyText: msg.replyTo?.text,
        },
        scope
      );

      return manager.sendFileChunkedAsync(
        recipientId,
        {
          fileId: `${msg.id}-${recipientId}`,
          messageId: msg.id,
          fileName: msg.fileName || `${msg.type}-${msg.timestamp}`,
          fileType: msg.mimeType || 'application/octet-stream',
          fileSize: msg.fileSize || estimateDataUrlBytes(msg.mediaData),
          dataUrl: msg.mediaData,
          messageMeta: {
            id: msg.id,
            chatId: msg.chatId,
            senderId: msg.senderId,
            senderName: msg.senderName,
            msgType: msg.type as 'image' | 'video' | 'document' | 'voice',
            text: encryptedCaption ? undefined : msg.text,
            encrypted: encryptedCaption ?? undefined,
            duration: msg.duration,
            timestamp: msg.timestamp,
            replyTo:
              encryptedCaption && msg.replyTo
                ? { ...msg.replyTo, text: '' }
                : msg.replyTo,
            isGroup: msg.isGroup,
            groupMeta,
          },
          onQueued: () => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msg.id && m.status !== 'delivered' && m.status !== 'read'
                  ? { ...m, status: 'pending', transferWaitingPeer: true }
                  : m
              )
            );
          },
          onProgress: (pct) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msg.id && m.status !== 'delivered' && m.status !== 'read'
                  ? {
                      ...m,
                      transferProgress: pct,
                      transferWaitingPeer: false,
                      status: pct >= 100 ? 'sent' : 'sending',
                    }
                  : m
              )
            );
          },
          onComplete: () => {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id === msg.id && m.status !== 'delivered' && m.status !== 'read') {
                  const updated: ChatMessage = {
                    ...m,
                    status: 'sent',
                    transferProgress: 100,
                    transferWaitingPeer: false,
                  };
                  void dbSaveMessage(updated);
                  return updated;
                }
                return m;
              })
            );
          },
          onAck: () => {
            markMessageConfirmedBlueTick(msg.id, recipientId);
          },
        },
        false
      );
    },
    [markMessageConfirmedBlueTick]
  );

  // Kuras seluruh antrean pendingMessages secara berurutan begitu peer target terdeteksi Online
  const flushPendingForPeer = useCallback(
    async (recipientId: string) => {
      const manager = peerManagerRef.current;
      if (!manager || !manager.isPeerOnline(recipientId)) return;
      if (flushingPeersRef.current.has(recipientId)) return;

      const queueForPeer = pendingMessagesRef.current
        .filter((item) => item.recipientId === recipientId)
        .sort((a, b) => a.createdAt - b.createdAt);

      if (queueForPeer.length === 0) return;

      flushingPeersRef.current.add(recipientId);
      try {
        for (const item of queueForPeer) {
          if (!peerManagerRef.current?.isPeerOnline(recipientId)) break;

          // Pastikan entri masih ada di antrean (belum terkonfirmasi MSG_ACK di tengah jalan)
          if (!pendingMessagesRef.current.some((p) => p.id === item.id)) {
            continue;
          }

          const msg = messagesRef.current.find((m) => m.id === item.messageId);
          if (!msg || msg.deleted) {
            removePendingEntry(item.messageId, recipientId);
            continue;
          }

          // Hindari spam pengiriman ulang dalam 5 detik terakhir selagi menunggu MSG_ACK
          const lastTry = pendingLastAttemptRef.current.get(item.id) ?? 0;
          if (Date.now() - lastTry < 5000) {
            continue;
          }
          pendingLastAttemptRef.current.set(item.id, Date.now());

          if (msg.type !== 'text' && msg.mediaData) {
            const ok = await sendMediaMessageToPeer(msg, recipientId, item.groupMeta);
            if (!ok) {
              // Hentikan sementara untuk peer ini jika koneksi terputus; loop 4 detik akan mencoba lagi
              pendingLastAttemptRef.current.delete(item.id);
              break;
            }
          } else {
            const sentNow = await sendEncryptedMessageToPeer(msg, recipientId, item.groupMeta);
            if (!sentNow) {
              pendingLastAttemptRef.current.delete(item.id);
              break;
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msg.id && m.status === 'pending' ? { ...m, status: 'sent' } : m
              )
            );
            // Jeda singkat 60 ms agar urutan pesan teks masuk rapi di penerima
            await new Promise<void>((resolve) => window.setTimeout(resolve, 60));
          }
        }
      } finally {
        flushingPeersRef.current.delete(recipientId);
      }
    },
    [removePendingEntry, sendMediaMessageToPeer, sendEncryptedMessageToPeer]
  );

  // Initialize PeerJS whenever locked profile is ready and app is active
  useEffect(() => {
    if (!profile || isExited) return;
    const lockedId = getLockedUserId();
    if (!lockedId || lockedId !== profile.id) {
      saveUserProfile(profile);
    }

    const manager = new WA6PeerManager(profile, {
      onStatusChange: (state, errMsg) => {
        setPeerState(state);
        setPeerError(errMsg);
        syncPeerMediaSession({
          peerState: state,
          standbyEnabled: standbyModeRef.current,
          peerId: profileRef.current?.id || profile.id,
          isExited: isExitedRef.current,
        });
        if (state === 'online') {
          // Proactively handshake known 1:1 contacts to establish presence
          contactsRef.current
            .filter((c) => !c.isGroup)
            .forEach((c) => manager.ensureConnection(c.id));
        }
      },
      onPacket: handleIncomingPacket,
      onFileReceived: handleFileReceived,
      onFileAck: handleFileAck,
      onPeerPresence: (sixId, isOnline) => {
        setOnlinePeers((prev) => {
          if (prev[sixId] === isOnline) return prev;
          return { ...prev, [sixId]: isOnline };
        });
      },
      onPeerTransport: (sixId, transport) => {
        setPeerTransports((prev) => {
          if (prev[sixId] === transport) return prev;
          return { ...prev, [sixId]: transport };
        });
      },
      onPeerReady: (sixId) => {
        void flushPendingForPeer(sixId);
      },
      onIncomingMediaCall: handleIncomingMediaCall,
    });

    peerManagerRef.current = manager;
    manager.setSavedContactIds(
      contactsRef.current.filter((c) => !c.isGroup).map((c) => c.id)
    );
    manager.connect();

    return () => {
      manager.destroy();
      peerManagerRef.current = null;
    };
    // Re-init only when user ID or exited state changes (login/reset/exit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, isExited]);

  // Sinkronkan daftar kontak tersimpan ke PeerManager untuk siklus PRESENCE_PING setiap 5 detik
  useEffect(() => {
    const manager = peerManagerRef.current;
    if (!manager || !profile || isExited) return;
    manager.setSavedContactIds(
      contacts.filter((c) => !c.isGroup).map((c) => c.id)
    );
  }, [contacts, profile?.id, isExited]);

  // Segera kirim ulang semua pesan chat pending (ikon jam pasir) begitu penerima berstatus Online
  useEffect(() => {
    if (!profile || isExited || pendingMessages.length === 0) return;
    const recipientIds = new Set(pendingMessages.map((p) => p.recipientId));
    recipientIds.forEach((recipientId) => {
      if (onlinePeers[recipientId] || peerManagerRef.current?.isPeerOnline(recipientId)) {
        void flushPendingForPeer(recipientId);
      }
    });
  }, [onlinePeers, pendingMessages, profile?.id, isExited, flushPendingForPeer]);

  // Sinkronisasi real-time navigator.mediaSession dengan status koneksi PeerJS & logo resmi WattappsAU
  // tanpa mendaftarkan pemicu kontrol pemutar audio HP di layar kunci
  const onlineContactsCount = useMemo(
    () => Object.values(onlinePeers).filter(Boolean).length,
    [onlinePeers]
  );

  useEffect(() => {
    if (!profile || isExited) {
      clearPeerMediaSession();
      return;
    }

    const pushCurrentMediaMetadata = () => {
      syncPeerMediaSession({
        peerState,
        standbyEnabled: standbyMode,
        peerId: profile.id,
        onlineContactsCount,
        isExited,
      });
    };

    pushCurrentMediaMetadata();

    const handleVisibilityOrNetworkRefresh = () => {
      pushCurrentMediaMetadata();
    };

    document.addEventListener('visibilitychange', handleVisibilityOrNetworkRefresh);
    window.addEventListener('online', handleVisibilityOrNetworkRefresh);
    window.addEventListener('offline', handleVisibilityOrNetworkRefresh);
    window.addEventListener('focus', handleVisibilityOrNetworkRefresh);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityOrNetworkRefresh);
      window.removeEventListener('online', handleVisibilityOrNetworkRefresh);
      window.removeEventListener('offline', handleVisibilityOrNetworkRefresh);
      window.removeEventListener('focus', handleVisibilityOrNetworkRefresh);
    };
  }, [profile?.id, peerState, standbyMode, isExited, onlineContactsCount]);

  // Screen Wake Lock API (navigator.wakeLock): aktif saat koneksi PeerJS online agar layar
  // HP/tablet tidak mati otomatis selama aplikasi terbuka, dan dilepas saat koneksi terhenti atau mode standby hemat baterai aktif
  useEffect(() => {
    const isConnectionActive = Boolean(
      profile && !isExited && peerState === 'online' && !isBatteryStandby
    );
    void syncConnectionWakeLock(isConnectionActive);

    return () => {
      void syncConnectionWakeLock(false);
    };
  }, [profile?.id, isExited, peerState, isBatteryStandby]);

  // Mode Standby Hemat Baterai Otomatis (tanpa elemen UI):
  // Pantau touchstart, touchmove, click, keydown, scroll serta status panggilan (isInCall / isRinging).
  // Setelah tepat 5 menit (300.000 ms) tanpa aktivitas & tidak menelepon/berdering:
  // lepaskan wakeLock, hentikan audio latar & polling berat, pertahankan listener Firestore/ntfy + FCM device_tokens,
  // lalu panggil window.AndroidBridge?.enterBatteryStandby?.().
  const isInCallOrRinging = Boolean(activeCallUI || incomingCall);

  useEffect(() => {
    if (!profile?.id || isExited) {
      if (batteryIdleTimerRef.current !== null) {
        window.clearTimeout(batteryIdleTimerRef.current);
        batteryIdleTimerRef.current = null;
      }
      if (isBatteryStandbyRef.current) {
        isBatteryStandbyRef.current = false;
        setIsBatteryStandby(false);
      }
      return;
    }

    const clearIdleTimer = () => {
      if (batteryIdleTimerRef.current !== null) {
        window.clearTimeout(batteryIdleTimerRef.current);
        batteryIdleTimerRef.current = null;
      }
    };

    const wakeFromBatteryStandby = () => {
      if (!isBatteryStandbyRef.current) return;
      isBatteryStandbyRef.current = false;
      setIsBatteryStandby(false);
      peerManagerRef.current?.setBatteryStandby(false);
    };

    const scheduleBatteryStandby = () => {
      clearIdleTimer();
      const isCallBusy = Boolean(
        isInCallOrRinging ||
          callRuntimeRef.current ||
          pendingCallRef.current ||
          incomingCallRef.current
      );
      if (isCallBusy) {
        wakeFromBatteryStandby();
        return;
      }

      batteryIdleTimerRef.current = window.setTimeout(() => {
        batteryIdleTimerRef.current = null;
        // Verifikasi ulang tepat di titik 5 menit: jangan masuk standby bila panggilan sedang berlangsung/berdering
        if (
          callRuntimeRef.current ||
          pendingCallRef.current ||
          incomingCallRef.current
        ) {
          return;
        }
        if (isBatteryStandbyRef.current) return;

        isBatteryStandbyRef.current = true;
        setIsBatteryStandby(true);

        // 1. Lepaskan wakeLock & hentikan audio loop latar belakang agar layar bisa mati otomatis
        void enterBackgroundBatteryStandby();
        // 2. Hentikan interval polling PeerJS yang berat (pertahankan listener Firestore/ntfy & token FCM device_tokens tetap aktif)
        peerManagerRef.current?.setBatteryStandby(true);
        const currentProfile = profileRef.current;
        if (currentProfile?.id) {
          void syncFcmToken(currentProfile.id, currentProfile.name, false);
        }
        // 3. Minimize halus ke latar belakang di Android WebView tanpa mematikan penerima notifikasi FCM
        enterAndroidBridgeBatteryStandby();
      }, BATTERY_STANDBY_IDLE_MS);
    };

    let lastResetAt = 0;
    const handleUserActivity = () => {
      const wasStandby = isBatteryStandbyRef.current;
      wakeFromBatteryStandby();
      const now = Date.now();
      if (wasStandby || now - lastResetAt >= 1000) {
        lastResetAt = now;
        scheduleBatteryStandby();
      }
    };

    // Jika sedang menelepon atau berdering, segera bangun dari standby dan tahan timer hingga panggilan berakhir
    if (isInCallOrRinging) {
      wakeFromBatteryStandby();
      clearIdleTimer();
    } else {
      scheduleBatteryStandby();
    }

    const activityEvents: Array<keyof WindowEventMap> = [
      'touchstart',
      'touchmove',
      'click',
      'keydown',
      'scroll',
    ];
    activityEvents.forEach((evt) => {
      window.addEventListener(evt, handleUserActivity, { passive: true, capture: true });
    });

    return () => {
      clearIdleTimer();
      activityEvents.forEach((evt) => {
        window.removeEventListener(evt, handleUserActivity, true);
      });
    };
  }, [profile?.id, isExited, isInCallOrRinging]);

  // Stream SSE tunggal & hemat baterai ke https://ntfy.sh/wattappsau-signal-{my6DigitId}/sse
  // Menggantikan polling timer agresif agar broker PeerJS stabil & bebas rate-limit
  useEffect(() => {
    if (!profile || isExited) return;
    void requestNotificationPermission();

    const unsubscribe = subscribeNtfySignal(profile.id, (signal) => {
      const senderLabel =
        (signal.fromId
          ? contactsRef.current.find((c) => c.id === signal.fromId)?.name
          : undefined) ||
        signal.fromName ||
        (signal.fromId ? `ID ${signal.fromId}` : 'Kontak WattappsAU');

      if (signal.type === 'INCOMING_CALL') {
        const callId = signal.callId || `ntfy-call-${signal.ts}`;
        if (
          !callRuntimeRef.current &&
          pendingCallRef.current?.callId !== callId &&
          signal.fromId
        ) {
          pauseKeepAliveForCall();
          startIncomingRingtone();
          const cleanId = fromFullPeerId(signal.fromId);
          const existingContact = contactsRef.current.find((c) => c.id === cleanId);
          const callerName = getTrustedPeerName(cleanId, signal.fromName);
          const isVideo = signal.callType === 'video';
          const callerAvatar = existingContact?.avatar || '';
          const pending: PendingIncomingCall = {
            callId,
            peerId: cleanId,
            peerName: callerName,
            peerAvatar: callerAvatar,
            callType: isVideo ? 'video' : 'audio',
            receivedAt: Date.now(),
          };
          pendingCallRef.current = pending;
          presentPendingCallModal(pending);
          void resolvePeerIdentity(cleanId, signal.fromName, true);
          triggerAndroidBridgeIncomingCall(
            callerName,
            isVideo ? 'Panggilan video masuk...' : 'Panggilan masuk...'
          );
          showIncomingWebNotification({
            title: callerName,
            body: isVideo ? 'Panggilan video WattappsAU' : 'Panggilan suara WattappsAU',
            icon: callerAvatar || '/icon-512.png',
            tag: `wattapps-call-${cleanId}`,
            isCall: true,
            data: {
              action: 'ANSWER_CALL',
              kind: 'call',
              callerId: cleanId,
              callerName,
              callerAvatar,
              fromId: cleanId,
              fromName: callerName,
              callId,
              callType: pending.callType,
              isVideo,
            },
            onClick: () => {
              forceShowIncomingCallModal({
                callerId: cleanId,
                callerName,
                callId,
                callType: pending.callType,
                isVideo,
              });
            },
          });
          if (wakeRingtoneTimerRef.current !== null) {
            window.clearTimeout(wakeRingtoneTimerRef.current);
          }
          wakeRingtoneTimerRef.current = window.setTimeout(() => {
            wakeRingtoneTimerRef.current = null;
            if (!callRuntimeRef.current && pendingCallRef.current?.callId === callId) {
              finalizeCall('missed');
            }
          }, 30000);
        }
        if (signal.fromId) {
          peerManagerRef.current?.ensureConnection(fromFullPeerId(signal.fromId), true);
        }
      } else if (signal.type === 'NEW_MSG') {
        const isViewing = Boolean(signal.fromId && activeChatIdRef.current === signal.fromId);
        if (!isViewing || document.hidden || standbyModeRef.current) {
          playMessagePop(true);
          const cleanSenderId = signal.fromId ? fromFullPeerId(signal.fromId) : '';
          const senderContact = cleanSenderId
            ? contactsRef.current.find((c) => c.id === cleanSenderId)
            : undefined;
          const senderAvatar = senderContact?.avatar || '';
          const ntfySenderTitle = senderContact?.name?.trim() || senderLabel;
          triggerAndroidBridgeIncomingMessage(ntfySenderTitle, 'Pesan baru masuk');
          showIncomingWebNotification({
            title: ntfySenderTitle,
            body: 'Pesan baru masuk',
            icon: senderAvatar || '/icon-512.png',
            tag: `ntfy-msg-${cleanSenderId || signal.ts}`,
            data: {
              kind: 'message',
              chatId: cleanSenderId || signal.fromId,
              fromId: cleanSenderId || signal.fromId,
              fromName: senderContact?.name?.trim() || senderLabel,
              callerAvatar: senderAvatar,
            },
            onClick: () => {
              if (cleanSenderId) {
                setActiveTab('chats');
                setActiveChatId(cleanSenderId);
              }
            },
          });
        }
        // Sambungkan satu jalur secara alami agar outboxMessages lawan langsung tersinkron
        if (signal.fromId) {
          peerManagerRef.current?.ensureConnection(signal.fromId, false);
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [profile?.id, isExited, finalizeCall, presentPendingCallModal]);

  // Pemulihan koneksi otomatis (anti zombie socket) saat aplikasi kembali dari latar belakang (visibilitychange, focus, online)
  const wakeAndSyncPeer = useCallback(
    async (force = false) => {
      const me = profileRef.current;
      const manager = peerManagerRef.current;
      if (!me || !manager) return;

      const now = Date.now();
      if (!force && now - lastAppWakeSyncRef.current < APP_WAKE_SYNC_COOLDOWN_MS) {
        return;
      }
      lastAppWakeSyncRef.current = now;

      // Kumpulkan kontak prioritas: ruang chat aktif, penerima pesan tertunda, penelpon pendingCall, & kontak 1:1
      const priorityIds = new Set<string>();
      const currentChat = activeChatIdRef.current;
      if (currentChat) {
        const chatContact = contactsRef.current.find((c) => c.id === currentChat);
        if (chatContact?.isGroup && chatContact.members) {
          chatContact.members.forEach((mId) => {
            if (mId !== me.id) priorityIds.add(mId);
          });
        } else {
          priorityIds.add(currentChat);
        }
      }
      pendingMessagesRef.current.forEach((p) => {
        if (p.recipientId && p.recipientId !== me.id) {
          priorityIds.add(p.recipientId);
        }
      });
      if (pendingCallRef.current?.peerId) {
        priorityIds.add(pendingCallRef.current.peerId);
      }
      contactsRef.current
        .filter((c) => !c.isGroup)
        .forEach((c) => priorityIds.add(c.id));

      await manager.wakeAndSyncPeer(Array.from(priorityIds), force);

      // (c) Segera tarik/kirim antrean pesan tertunda untuk semua peer yang sudah online
      const pendingRecipients = new Set(
        pendingMessagesRef.current.map((item) => item.recipientId)
      );
      pendingRecipients.forEach((recipientId) => {
        if (peerManagerRef.current?.isPeerOnline(recipientId)) {
          void flushPendingForPeer(recipientId);
        }
      });

      // Tampilkan pop-up panggilan masuk jika ada permintaan panggilan yang masih menunggu (pendingCall)
      const pendingCall = pendingCallRef.current;
      if (pendingCall && !callRuntimeRef.current) {
        if (Date.now() - pendingCall.receivedAt <= PENDING_CALL_TTL_MS) {
          presentPendingCallModal(pendingCall);
          peerManagerRef.current?.sendPacket(pendingCall.peerId, {
            kind: 'CALL_SIGNAL',
            action: 'ringing',
            callId: pendingCall.callId,
            callType: pendingCall.callType,
            fromId: me.id,
            fromName: me.name,
            fromAvatar: me.avatar,
          });
        } else {
          pendingCallRef.current = null;
        }
      }
    },
    [flushPendingForPeer, presentPendingCallModal]
  );

  // Dengarkan visibilitychange, online, pageshow & window.focus untuk auto-reconnect PeerJS/WebRTC
  useEffect(() => {
    if (!profile || isExited) return;

    const checkIncomingCallOnResume = () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const incomingId = params.get('incomingCall')?.trim();
        if (incomingId) {
          const callerName = params.get('callerName')?.trim() || undefined;
          const callTypeParam = params.get('callType')?.trim();
          const callIdParam = params.get('callId')?.trim() || undefined;
          forceShowIncomingCallModal({
            callerId: incomingId,
            callerName,
            callId: callIdParam,
            callType: callTypeParam === 'video' ? 'video' : 'audio',
            isVideo: callTypeParam === 'video',
          });
          window.history.replaceState({ wattappsGuard: true }, '', '/');
          return;
        }
      } catch {
        // ignore
      }

      if (incomingCallRef.current && isIncomingCallStillActive(incomingCallRef.current)) {
        forceShowIncomingCallModal();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkIncomingCallOnResume();
        void wakeAndSyncPeer(true);
      }
    };

    const handleNetworkOnline = () => {
      checkIncomingCallOnResume();
      void wakeAndSyncPeer(true);
    };

    const handleWindowFocus = () => {
      checkIncomingCallOnResume();
      void wakeAndSyncPeer(false);
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted || document.visibilityState === 'visible') {
        checkIncomingCallOnResume();
        void wakeAndSyncPeer(true);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleNetworkOnline);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleNetworkOnline);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [
    profile?.id,
    isExited,
    wakeAndSyncPeer,
    forceShowIncomingCallModal,
    isIncomingCallStillActive,
  ]);

  // Cegah tombol Back sistem Android (tombol segitiga) menutup aplikasi & mematikan Mode Siaga
  // Suntikkan 2x history.pushState setelah sentuhan pengguna pertama (User Activation) agar tidak diabaikan Chrome Android
  useEffect(() => {
    if (isExited || typeof window === 'undefined') return;

    const trapBackButton = () => {
      if (isExitedRef.current) return;
      if (!isHistoryTrapped) {
        try {
          window.history.pushState({ wattappsGuard: true }, '', window.location.href);
          window.history.pushState({ wattappsGuard: true }, '', window.location.href);
          isHistoryTrapped = true;
        } catch {
          // ignore history errors in restricted frames
        }
      }
    };

    const handlePopState = () => {
      if (isExitedRef.current || !isHistoryTrapped) return;

      // (a) Segera dorong kembali state baru agar jebakan riwayat tidak pernah habis
      try {
        window.history.pushState({ wattappsGuard: true }, '', window.location.href);
      } catch {
        // ignore
      }

      const ui = backGuardStateRef.current;

      // (b) Jika sedang membuka modal panggilan, lightbox, kamera, menu dropdown, modal profil, pencarian, atau ruang chat aktif, tutup tampilan tersebut
      if (ui.hasCallModal || callRuntimeRef.current || incomingCallRef.current || pendingCallRef.current) {
        const rt = callRuntimeRef.current;
        const pending = pendingCallRef.current;
        const ic = incomingCallRef.current;
        const me = profileRef.current;
        const isIncomingPhase = Boolean((rt && !rt.connectedAt && rt.direction === 'incoming') || pending || ic);
        const targetPeerId = rt?.peerId || pending?.peerId || ic?.callerId;
        const targetCallId = rt?.callId || pending?.callId || ic?.callId;
        const targetCallType: CallType =
          rt?.callType || pending?.callType || (ic?.isVideo ? 'video' : 'audio');

        if (targetPeerId && targetCallId && me) {
          peerManagerRef.current?.sendPacket(targetPeerId, {
            kind: 'CALL_SIGNAL',
            action: isIncomingPhase ? 'reject' : 'end',
            callId: targetCallId,
            callType: targetCallType,
            fromId: me.id,
            fromName: me.name,
            fromAvatar: me.avatar,
          });
        }
        finalizeCall(isIncomingPhase ? 'rejected' : undefined);
      } else if (ui.lightboxMedia) {
        setLightboxMedia(null);
      } else if (ui.cameraPurpose) {
        setCameraPurpose(null);
      } else if (ui.showResetConfirm) {
        setShowResetConfirm(false);
      } else if (ui.showMainMenu) {
        setShowMainMenu(false);
      } else if (ui.showProfileDrawer) {
        setShowProfileDrawer(false);
      } else if (ui.showShareAppModal) {
        setShowShareAppModal(false);
      } else if (ui.showNewChatModal) {
        setShowNewChatModal(false);
      } else if (ui.showNewGroupModal) {
        setShowNewGroupModal(false);
      } else if (ui.searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
      } else if (ui.activeChatId) {
        setActiveChatId(null);
      } else if (ui.activeTab !== 'chats') {
        setActiveTab('chats');
      } else {
        // (c) Sudah di halaman utama daftar chat: JANGAN keluar & JANGAN hentikan audio latar belakang Mode Siaga
        showToast(
          'Tombol Back dikunci agar Mode Siaga tetap aktif. Tekan tombol Home (bulat) untuk ke layar utama HP, atau pilih menu ⋮ > Exit untuk keluar.',
          4500,
          'warning'
        );
      }
    };

    window.addEventListener('pointerdown', trapBackButton, { passive: true });
    window.addEventListener('touchstart', trapBackButton, { passive: true });
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('pointerdown', trapBackButton);
      window.removeEventListener('touchstart', trapBackButton);
      window.removeEventListener('popstate', handlePopState);
    };
  }, [isExited, showToast, finalizeCall]);

  // Buka ruang chat targetId & tampilkan modal Panggilan Masuk (Angkat/Tolak) dari URL parameter atau postMessage SW
  const applyNotificationTarget = useCallback(
    (targetUrl?: string, extraData?: NotificationClickData) => {
      let params: URLSearchParams;
      try {
        if (targetUrl) {
          const parsed = targetUrl.startsWith('?')
            ? new URL(`/${targetUrl}`, window.location.origin)
            : new URL(targetUrl, window.location.origin);
          params = new URLSearchParams(parsed.search);
        } else {
          params = new URLSearchParams(window.location.search);
        }
      } catch {
        params = new URLSearchParams(window.location.search);
      }

      const incomingCallParam =
        params.get('incomingCall')?.trim() || extraData?.callerId?.trim() || '';
      const callerNameParam =
        params.get('callerName')?.trim() || extraData?.callerName?.trim() || '';

      const targetId =
        incomingCallParam ||
        params.get('targetId')?.trim() ||
        extraData?.chatId?.trim() ||
        extraData?.fromId?.trim() ||
        '';
      const action =
        incomingCallParam || extraData?.action === 'ANSWER_CALL'
          ? 'call'
          : params.get('action')?.trim() ||
            (extraData?.kind === 'call' ? 'call' : targetId ? 'chat' : '');
      const callTypeParam = params.get('callType')?.trim() || extraData?.callType;
      const callIdParam = params.get('callId')?.trim() || extraData?.callId;
      const nameParam = callerNameParam || params.get('name')?.trim() || extraData?.fromName;
      const shouldAutoAccept = params.get('autoAccept') === '1';

      setShowMainMenu(false);
      setShowProfileDrawer(false);
      setShowShareAppModal(false);
      setShowNewChatModal(false);
      setShowNewGroupModal(false);
      setShowResetConfirm(false);
      setCameraPurpose(null);
      setLightboxMedia(null);

      // (a) Jika ini adalah panggilan masuk (?incomingCall=... atau action=call/ANSWER_CALL), paksa tampilkan Modal Layar Penuh Panggilan Masuk
      if (action === 'call') {
        const isVideo = Boolean(extraData?.isVideo ?? callTypeParam === 'video');
        forceShowIncomingCallModal({
          callerId: targetId || undefined,
          callerName: nameParam || undefined,
          callId: callIdParam || undefined,
          callType: isVideo ? 'video' : 'audio',
          isVideo,
        });
        if (shouldAutoAccept) {
          void (async () => {
            const permsReady = await checkCallMediaPermissionsGranted(isVideo);
            if (permsReady) {
              await handleAcceptCallRef.current(true);
            }
          })();
        }
      } else if (targetId && targetId !== profileRef.current?.id) {
        // (b) Untuk notifikasi chat, langsung pilih dan buka ruang chat milik targetId tersebut
        const cleanId = fromFullPeerId(targetId);
        if (!contactsRef.current.some((c) => c.id === cleanId)) {
          upsertContact({
            id: cleanId,
            name: getTrustedPeerName(cleanId, nameParam),
            bio: 'Ada',
            avatar: '',
            addedAt: Date.now(),
          });
        }
        void resolvePeerIdentity(cleanId, nameParam);
        setActiveTab('chats');
        setActiveChatId(cleanId);
        activeChatIdRef.current = cleanId;
      }

      // Bersihkan query parameter dari URL agar tidak terpicu ulang saat reload (tetap jaga wattappsGuard)
      try {
        if (window.location.search || window.location.pathname !== '/') {
          window.history.replaceState({ wattappsGuard: true }, '', '/');
        }
      } catch {
        // ignore
      }

      void wakeAndSyncPeer();
    },
    [wakeAndSyncPeer, forceShowIncomingCallModal, upsertContact]
  );

  // Cek apakah izin mikrofon (dan kamera jika video) sudah pernah diberikan sebelum auto-accept dari tombol Jawab notifikasi
  const checkCallMediaPermissionsGranted = async (isVideo: boolean): Promise<boolean> => {
    try {
      if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
        return false;
      }
      const micPerm = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });
      if (micPerm.state !== 'granted') return false;
      if (isVideo) {
        const camPerm = await navigator.permissions.query({
          name: 'camera' as PermissionName,
        });
        if (camPerm.state !== 'granted') return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  // Tangkap parameter ?incomingCall=... atau ?targetId=...&action=... saat aplikasi baru dimuat (misal dari clients.openWindow)
  useEffect(() => {
    if (!profile || !dataLoaded || !pendingNotificationTargetUrl) return;
    const urlToOpen = pendingNotificationTargetUrl;
    setPendingNotificationTargetUrl(null);
    applyNotificationTarget(urlToOpen);
  }, [profile, dataLoaded, pendingNotificationTargetUrl, applyNotificationTarget]);

  // Dengarkan pesan dari Service Worker (public/sw.js):
  // REJECT_INCOMING_CALL_FROM_NOTIFICATION, ACCEPT_INCOMING_CALL_FROM_NOTIFICATION, TRIGGER_INCOMING_CALL_UI, OPEN_TARGET
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const handleSwMessage = (event: MessageEvent) => {
      const payload = event.data as
        | {
            type?: string;
            url?: string;
            callerId?: string;
            callerName?: string;
            callId?: string;
            callType?: CallType;
            isVideo?: boolean;
            data?: NotificationClickData;
          }
        | undefined;
      if (!payload) return;

      // 1. Tombol "Tolak" pada notifikasi layar kunci: tolak langsung tanpa membuka layar
      if (payload.type === 'REJECT_INCOMING_CALL_FROM_NOTIFICATION') {
        const isVideo = Boolean(
          payload.isVideo ||
            payload.callType === 'video' ||
            payload.data?.isVideo ||
            payload.data?.callType === 'video'
        );
        handleRejectCallRef.current({
          callerId: payload.callerId || payload.data?.callerId || payload.data?.fromId,
          callerName: payload.callerName || payload.data?.callerName || payload.data?.fromName,
          callId: payload.callId || payload.data?.callId,
          callType: isVideo ? 'video' : 'audio',
        });
        return;
      }

      // 2. Tombol "Jawab" pada notifikasi panggilan: buka modal layar penuh & langsung angkat jika izin sudah siap
      if (payload.type === 'ACCEPT_INCOMING_CALL_FROM_NOTIFICATION') {
        const isVideo = Boolean(
          payload.isVideo ||
            payload.callType === 'video' ||
            payload.data?.isVideo ||
            payload.data?.callType === 'video'
        );
        forceShowIncomingCallModal({
          callerId: payload.callerId || payload.data?.callerId || payload.data?.fromId,
          callerName: payload.callerName || payload.data?.callerName || payload.data?.fromName,
          callId: payload.callId || payload.data?.callId,
          callType: isVideo ? 'video' : 'audio',
          isVideo,
        });
        void wakeAndSyncPeer();
        void (async () => {
          const permsReady = await checkCallMediaPermissionsGranted(isVideo);
          if (permsReady) {
            await handleAcceptCallRef.current(true);
          }
        })();
        return;
      }

      if (payload.type === 'TRIGGER_INCOMING_CALL_UI') {
        const isVideo = Boolean(
          payload.isVideo ||
            payload.callType === 'video' ||
            payload.data?.isVideo ||
            payload.data?.callType === 'video'
        );
        forceShowIncomingCallModal({
          callerId: payload.callerId || payload.data?.callerId || payload.data?.fromId,
          callerName: payload.callerName || payload.data?.callerName || payload.data?.fromName,
          callId: payload.callId || payload.data?.callId,
          callType: isVideo ? 'video' : 'audio',
          isVideo,
        });
        void wakeAndSyncPeer();
        return;
      }

      if (payload.type === 'OPEN_TARGET') {
        applyNotificationTarget(payload.url, payload.data);
        return;
      }

      if (payload.type === 'NOTIFICATION_CLICKED') {
        applyNotificationTarget(payload.data?.url, payload.data);
      }
    };

    navigator.serviceWorker.addEventListener('message', handleSwMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', handleSwMessage);
    };
  }, [applyNotificationTarget, forceShowIncomingCallModal, wakeAndSyncPeer]);

  // Whenever user opens a chat room, clear unread badge & send READ_ACK
  useEffect(() => {
    if (!activeChatId) return;
    setUnreadCounts((prev) => {
      if (!prev[activeChatId]) return prev;
      const next = { ...prev };
      delete next[activeChatId];
      return next;
    });
    sendReadAcksForChat(activeChatId);

    // Ensure P2P connection to this contact (or group members)
    const target = contactsRef.current.find((c) => c.id === activeChatId);
    if (target) {
      if (target.isGroup && target.members) {
        target.members.forEach((mId) => {
          if (mId !== profileRef.current?.id) {
            peerManagerRef.current?.ensureConnection(mId);
          }
        });
      } else {
        peerManagerRef.current?.ensureConnection(target.id);
      }
    }
  }, [activeChatId, sendReadAcksForChat]);

  // Auto-apply deep-link invite (?add=482910&name=...) once profile & local DB are ready
  useEffect(() => {
    if (!profile || !dataLoaded || !pendingInvite) return;
    const invite = pendingInvite;
    setPendingInvite(null);

    // Clean query string from URL bar without reloading (keep wattappsGuard state)
    try {
      const cleanUrl = `${window.location.origin}${window.location.pathname}`;
      window.history.replaceState({ wattappsGuard: true }, '', cleanUrl);
    } catch {
      // ignore
    }

    if (invite.id === profile.id) return;

    const existing = contactsRef.current.find((c) => c.id === invite.id);
    if (!existing) {
      upsertContact({
        id: invite.id,
        name: getTrustedPeerName(invite.id, invite.name),
        bio: 'Ada',
        avatar: '',
        addedAt: Date.now(),
      });
    } else if (invite.name && isPlaceholderPeerName(existing.name)) {
      upsertContact({ ...existing, name: invite.name });
    }
    void resolvePeerIdentity(invite.id, invite.name, true);
    setActiveTab('chats');
    setActiveChatId(invite.id);
    peerManagerRef.current?.ensureConnection(invite.id);
    showToast(`Terhubung dengan ${invite.name || `ID ${invite.id}`} via tautan undangan`);
  }, [profile, dataLoaded, pendingInvite, upsertContact, showToast, getTrustedPeerName, isPlaceholderPeerName, resolvePeerIdentity]);

  // Complete Onboarding (kunci permanen wattapps_user_id & wattapps_user_name di localStorage)
  const handleCompleteOnboarding = (newProfile: UserProfile) => {
    const lockedProfile = saveUserProfile(newProfile);
    setProfile(lockedProfile);
    showToast(`Selamat datang, ${lockedProfile.name}! ID Terkunci: ${formatSixDigitId(lockedProfile.id)}`);
  };

  // Update Profile (tetap kunci wattapps_user_id & perbarui wattapps_user_name)
  const handleUpdateProfile = (updated: UserProfile) => {
    const lockedProfile = saveUserProfile(updated);
    setProfile(lockedProfile);
    peerManagerRef.current?.updateProfile(lockedProfile);
  };

  // Add Contact / Open Chat
  const handleAddContact = (rawSixDigitId: string, nickname?: string) => {
    const sixDigitId = normalizePeerId(rawSixDigitId);
    if (!sixDigitId) {
      showToast('ID kontak tidak valid.');
      return;
    }
    const cleanNickname = nickname?.trim();
    const existing = contacts.find((c) => normalizePeerId(c.id) === sixDigitId);
    if (!existing) {
      const contact: Contact = {
        id: sixDigitId,
        name: cleanNickname || getTrustedPeerName(sixDigitId),
        bio: 'Ada',
        avatar: '',
        addedAt: Date.now(),
      };
      upsertContact(contact);
    } else if (cleanNickname) {
      upsertContact({ ...existing, id: sixDigitId, name: cleanNickname });
    }
    void resolvePeerIdentity(sixDigitId, cleanNickname, true);
    setShowNewChatModal(false);
    setActiveTab('chats');
    setActiveChatId(sixDigitId);
    peerManagerRef.current?.ensureConnection(sixDigitId);
  };

  // Create Group Chat P2P
  const handleCreateGroup = (name: string, memberIds: string[], avatar: string) => {
    if (!profile) return;
    const allMembers = Array.from(new Set([profile.id, ...memberIds]));
    const memberNames: Record<string, string> = { [profile.id]: profile.name };
    for (const id of memberIds) {
      const c = contacts.find((ct) => ct.id === id);
      memberNames[id] = c?.name || getTrustedPeerName(id);
    }

    const groupContact: Contact = {
      id: `GRP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name,
      bio: `Grup P2P · Dibuat oleh ${profile.name}`,
      avatar,
      addedAt: Date.now(),
      isGroup: true,
      members: allMembers,
      memberNames,
      adminId: profile.id,
    };

    upsertContact(groupContact);

    // Broadcast group invitation to every member
    for (const memberId of memberIds) {
      peerManagerRef.current?.sendPacket(memberId, {
        kind: 'GROUP_INVITE',
        group: groupContact,
      });
    }

    setShowNewGroupModal(false);
    setActiveTab('chats');
    setActiveChatId(groupContact.id);
    showToast(`Grup "${name}" berhasil dibuat`);
  };

  // Send message (text / image / video / document / voice) to 1:1 or P2P Group
  const dispatchMessage = useCallback(
    (
      chatId: string,
      payload: Omit<ChatMessage, 'id' | 'chatId' | 'senderId' | 'senderName' | 'timestamp' | 'status' | 'isGroup'>
    ) => {
      const me = profileRef.current;
      const target = contactsRef.current.find((c) => c.id === chatId);
      if (!me || !target) return;

      const manager = peerManagerRef.current;
      const recipients =
        target.isGroup && target.members
          ? target.members.filter((mId) => mId !== me.id)
          : [target.id];

      const isMediaMessage = payload.type !== 'text' && Boolean(payload.mediaData);
      const computedSize =
        payload.fileSize ||
        (payload.mediaData ? estimateDataUrlBytes(payload.mediaData) : undefined);

      const allRecipientsOnline =
        recipients.length > 0 &&
        recipients.every((rId) => Boolean(manager?.isPeerOnline(rId)));

      const msg: ChatMessage = {
        id: generateUid('msg'),
        chatId,
        senderId: me.id,
        senderName: me.name,
        timestamp: Date.now(),
        status: allRecipientsOnline ? (isMediaMessage ? 'sending' : 'sent') : 'pending',
        transferProgress: isMediaMessage ? 0 : undefined,
        transferWaitingPeer: isMediaMessage && !allRecipientsOnline ? true : undefined,
        isGroup: Boolean(target.isGroup),
        e2ee: true,
        ...payload,
        fileSize: computedSize,
      };

      setMessages((prev) => [...prev, msg]);
      void dbSaveMessage(msg);
      playMessagePop(false);

      if (recipients.length === 0) return;

      const groupMeta =
        target.isGroup && target.members
          ? {
              id: target.id,
              name: target.name,
              avatar: target.avatar,
              members: target.members,
              memberNames: target.memberNames || {},
              adminId: target.adminId || me.id,
            }
          : undefined;

      // Daftarkan ke antrean persisten pendingMessages di IndexedDB hingga mendapat konfirmasi MSG_ACK / FILE_ACK
      const newPendingEntries: PendingOutboxMessage[] = recipients.map((recipientId) => ({
        id: `${msg.id}:${recipientId}`,
        messageId: msg.id,
        recipientId,
        chatId,
        createdAt: msg.timestamp,
        groupMeta,
      }));

      setPendingMessages((prev) => [...prev, ...newPendingEntries]);
      newPendingEntries.forEach((entry) => {
        void dbSavePendingMessage(entry);
      });

      // Kirim FCM High-Priority Data Push ke setiap penerima lewat Firestore `device_tokens` + `/api/push`
      const fcmMessageBody =
        msg.text?.trim() ||
        (msg.type === 'image'
          ? '📷 Foto'
          : msg.type === 'video'
          ? '🎥 Video'
          : msg.type === 'voice'
          ? '🎤 Pesan suara'
          : msg.type === 'document'
          ? `📄 ${msg.fileName || 'Dokumen'}`
          : 'Pesan baru masuk');

      const fcmSenderName = me.name?.trim() || me.id;
      void Promise.all(
        recipients.map((recipientId) =>
          sendFcmPushToUser({
            targetUserId: recipientId,
            type: 'message',
            sender: fcmSenderName,
            body: fcmMessageBody,
          })
        )
      ).then((results) => {
        const failedApi = results.find((r) => !r.success && r.reason === 'api_error');
        const missingToken = results.find((r) => !r.success && r.reason === 'token_not_found');
        const firestoreErr = results.find((r) => !r.success && r.reason === 'firestore_error');

        if (failedApi) {
          showToast(
            `Push notifikasi gagal (/api/push): ${failedApi.errorDetail || 'Server error'}`,
            3200,
            'warning'
          );
        } else if (missingToken) {
          showToast(
            `Notifikasi push belum aktif: perangkat tujuan belum mendaftarkan token FCM.`,
            3200,
            'warning'
          );
        } else if (firestoreErr) {
          showToast(
            `Gagal membaca token push tujuan dari Firestore.`,
            3200,
            'warning'
          );
        }
      });

      if (!manager) return;

      // Untuk setiap penerima: kirim langsung (terenkripsi AES-256-GCM) jika Online, atau biarkan di antrean pendingMessages jika Offline
      recipients.forEach((recipientId) => {
        const entryId = `${msg.id}:${recipientId}`;
        if (manager.isPeerOnline(recipientId)) {
          pendingLastAttemptRef.current.set(entryId, Date.now());
          if (isMediaMessage && msg.mediaData && msg.type !== 'text') {
            void sendMediaMessageToPeer(msg, recipientId, groupMeta);
          } else {
            void sendEncryptedMessageToPeer(msg, recipientId, groupMeta);
          }
        } else {
          // Penerima Offline: simpan di outboxMessages & kirim sinyal bangun terenkripsi via ntfy.sh (tanpa polling loop)
          void sendNtfyWakeSignal({
            targetId: recipientId,
            type: 'NEW_MSG',
            fromId: me.id,
            fromName: me.name,
          });
          manager.ensureConnection(recipientId, false);
        }
      });
    },
    [sendMediaMessageToPeer, sendEncryptedMessageToPeer, showToast]
  );

  // Typing signal
  const handleTyping = useCallback((isTyping: boolean) => {
    const me = profileRef.current;
    const chatId = activeChatIdRef.current;
    const manager = peerManagerRef.current;
    if (!me || !chatId || !manager) return;

    const target = contactsRef.current.find((c) => c.id === chatId);
    if (!target) return;

    const pkt: PeerPacket = {
      kind: 'TYPING',
      chatId: target.isGroup ? target.id : me.id,
      fromId: me.id,
      fromName: me.name,
      isTyping,
    };

    if (target.isGroup && target.members) {
      target.members.forEach((mId) => {
        if (mId !== me.id && manager.isPeerOnline(mId)) {
          manager.sendPacket(mId, pkt);
        }
      });
    } else if (manager.isPeerOnline(target.id)) {
      manager.sendPacket(target.id, pkt);
    }
  }, []);

  // Delete message
  const handleDeleteMessage = (messageId: string, forEveryone: boolean) => {
    const me = profileRef.current;
    const chatId = activeChatIdRef.current;
    if (!me || !chatId) return;

    setMessages((prev) =>
      prev.map((m) => {
        if (m.id === messageId) {
          const updated: ChatMessage = {
            ...m,
            deleted: true,
            text: undefined,
            mediaData: undefined,
          };
          void dbSaveMessage(updated);
          return updated;
        }
        return m;
      })
    );

    setPendingMessages((prev) => prev.filter((p) => p.messageId !== messageId));
    void dbDeletePendingByMessageId(messageId);

    if (forEveryone) {
      const target = contacts.find((c) => c.id === chatId);
      const pkt: PeerPacket = {
        kind: 'DELETE_MSG',
        chatId,
        messageId,
        fromId: me.id,
      };
      if (target?.isGroup && target.members) {
        target.members.forEach((mId) => {
          if (mId !== me.id) peerManagerRef.current?.sendPacket(mId, pkt);
        });
      } else if (target) {
        peerManagerRef.current?.sendPacket(target.id, pkt);
      }
    }
  };

  // Clear chat / Delete contact
  const handleClearChat = (chatId: string) => {
    const toRemove = pendingMessagesRef.current.filter((p) => p.chatId === chatId);
    toRemove.forEach((p) => void dbDeletePendingMessage(p.id));
    setPendingMessages((prev) => prev.filter((p) => p.chatId !== chatId));
    setMessages((prev) => prev.filter((m) => m.chatId !== chatId));
    void dbDeleteMessagesForChat(chatId);
    showToast('Riwayat obrolan dibersihkan');
  };

  const handleDeleteContact = (chatId: string) => {
    const toRemove = pendingMessagesRef.current.filter(
      (p) => p.chatId === chatId || p.recipientId === chatId
    );
    toRemove.forEach((p) => void dbDeletePendingMessage(p.id));
    setPendingMessages((prev) =>
      prev.filter((p) => p.chatId !== chatId && p.recipientId !== chatId)
    );
    setContacts((prev) => prev.filter((c) => c.id !== chatId));
    setMessages((prev) => prev.filter((m) => m.chatId !== chatId));
    void dbDeleteContact(chatId);
    void dbDeleteMessagesForChat(chatId);
    if (activeChatId === chatId) setActiveChatId(null);
    showToast('Kontak dihapus');
  };

  // Status Posting (24-hour TTL + P2P broadcast to connected contacts; photo statuses chunked <= 16 KB)
  const broadcastStatus = (status: StatusItem) => {
    setStatuses((prev) => [status, ...prev]);
    void dbSaveStatus(status);
    contacts
      .filter((c) => !c.isGroup)
      .forEach((c) => {
        if (status.type === 'image' && status.mediaData) {
          peerManagerRef.current?.sendFileChunked(c.id, {
            fileId: `${status.id}-${c.id}`,
            fileName: `status-${status.timestamp}.jpg`,
            fileType: 'image/jpeg',
            fileSize: estimateDataUrlBytes(status.mediaData),
            dataUrl: status.mediaData,
            statusMeta: {
              id: status.id,
              userId: status.userId,
              userName: status.userName,
              userAvatar: status.userAvatar,
              caption: status.caption,
              timestamp: status.timestamp,
              expiresAt: status.expiresAt,
            },
          });
        } else {
          peerManagerRef.current?.sendPacket(c.id, {
            kind: 'STATUS_UPDATE',
            status,
          });
        }
      });
    showToast('Pembaruan status dipublikasikan (24 jam)');
  };

  const handlePostTextStatus = (text: string, bgColor: string, fontClass: string) => {
    if (!profile) return;
    const now = Date.now();
    broadcastStatus({
      id: generateUid('st'),
      userId: profile.id,
      userName: profile.name,
      userAvatar: profile.avatar,
      type: 'text',
      text,
      bgColor,
      fontClass,
      timestamp: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
      viewed: true,
    });
  };

  const handlePostImageStatus = (mediaData: string, caption: string) => {
    if (!profile) return;
    const now = Date.now();
    broadcastStatus({
      id: generateUid('st'),
      userId: profile.id,
      userName: profile.name,
      userAvatar: profile.avatar,
      type: 'image',
      mediaData,
      caption,
      timestamp: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
      viewed: true,
    });
  };

  const handleMarkStatusViewed = useCallback((statusId: string) => {
    setStatuses((prev) =>
      prev.map((s) => {
        if (s.id === statusId && !s.viewed) {
          const updated = { ...s, viewed: true };
          void dbSaveStatus(updated);
          return updated;
        }
        return s;
      })
    );
  }, []);

  const handleDeleteStatus = (statusId: string) => {
    setStatuses((prev) => prev.filter((s) => s.id !== statusId));
    void dbDeleteStatus(statusId);
    showToast('Status dihapus');
  };

  const handleReplyToStatus = (userId: string, statusText: string, replyText: string) => {
    const existing = contacts.find((c) => c.id === userId);
    if (!existing) {
      upsertContact({
        id: userId,
        name: getTrustedPeerName(userId),
        bio: 'Ada',
        avatar: '',
        addedAt: Date.now(),
      });
      void resolvePeerIdentity(userId);
    }
    setActiveTab('chats');
    setActiveChatId(userId);
    window.setTimeout(() => {
      dispatchMessage(userId, {
        type: 'text',
        text: replyText,
        replyTo: {
          id: 'status-reply',
          senderId: userId,
          senderName: `Status · ${existing?.name || userId}`,
          type: 'text',
          text: statusText,
        },
      });
    }, 50);
  };

  // Start Outgoing Audio / Video Call
  const handleStartCall = async (rawPeerId: string, callType: CallType) => {
    const peerId = normalizePeerId(rawPeerId);
    if (!profile || !peerId) return;
    if (callRuntimeRef.current) {
      showToast('Anda sedang dalam panggilan aktif.');
      return;
    }

    const manager = peerManagerRef.current;
    if (!manager || peerState !== 'online') {
      showToast('Menunggu koneksi PeerJS online sebelum menelepon.');
      return;
    }

    // 1. Tepat di baris pertama klik tombol Panggil (User Gesture Android WebView):
    // Hentikan semua dering, reset audio panggilan sebelumnya, buka & resume AudioContext panggilan,
    // aktifkan mode audio panggilan native Android, buka kunci <audio id="remoteAudio">, lalu tangkap mikrofon
    stopAllCallRingtones();
    pauseKeepAliveForCall();
    attachRemoteCallAudioStream(null);
    resumeWebAudioContext();
    ensureCallAudioContext(true);
    setAndroidBridgeCallAudioMode(true);
    isSpeakerOnRef.current = true;
    unlockRemoteAudioElement();

    let localStream: MediaStream;
    try {
      localStream = await getCallLocalStream(callType);
    } catch {
      closeCallAudioContext();
      setAndroidBridgeCallAudioMode(false);
      resumeKeepAliveAfterCall();
      showToast(
        callType === 'video'
          ? 'Izin kamera dan mikrofon diperlukan untuk panggilan video.'
          : 'Izin mikrofon diperlukan untuk panggilan suara.'
      );
      return;
    }

    const callId = generateUid('call');
    const contact = contacts.find((c) => normalizePeerId(c.id) === peerId);
    const peerName = getTrustedPeerName(peerId, contact?.name);
    const peerAvatar = contact?.avatar || '';
    void resolvePeerIdentity(peerId, contact?.name, true);

    // 2. Setelah mikrofon siap, kirim sinyal FCM, ntfy wake, CALL_REQUEST, lalu buka MediaConnection (iceTransportPolicy: 'all')
    void sendFcmPushToUser({
      targetUserId: peerId,
      type: 'call',
      sender: profile.name?.trim() || profile.id,
      body: 'Panggilan Masuk WattappsAU',
    }).then((result) => {
      if (!result.success) {
        if (result.reason === 'token_not_found') {
          showToast(
            `Push panggilan tidak terkirim: token FCM ${peerName} belum ditemukan di Firestore.`,
            3200,
            'warning'
          );
        } else if (result.reason === 'api_error') {
          showToast(
            `Gagal mengirim push panggilan (/api/push): ${result.errorDetail || 'Server error'}`,
            3200,
            'warning'
          );
        } else if (result.reason === 'firestore_error') {
          showToast(
            `Gagal mengambil token FCM ${peerName} dari Firestore.`,
            3200,
            'warning'
          );
        }
      }
    });

    void sendNtfyWakeSignal({
      targetId: peerId,
      type: 'INCOMING_CALL',
      fromId: profile.id,
      fromName: profile.name,
      callType,
      callId,
    });

    if (!manager.isPeerOnline(peerId)) {
      showToast(`Sinyal bangun panggilan dikirim ke ${peerName} via ntfy`);
    } else {
      manager.sendPacket(peerId, {
        kind: 'CALL_REQUEST',
        callId,
        callType,
        fromId: profile.id,
        fromName: profile.name,
        fromAvatar: profile.avatar,
      });
    }

    const mediaCall = manager.startMediaCall(peerId, localStream, {
      callId,
      callType,
      isVideo: callType === 'video',
      callerName: profile.name,
      callerAvatar: profile.avatar,
    });

    if (!mediaCall) {
      localStream.getTracks().forEach((t) => t.stop());
      closeCallAudioContext();
      setAndroidBridgeCallAudioMode(false);
      resumeKeepAliveAfterCall();
      showToast('Gagal memulai panggilan. Pastikan teman sedang online.');
      return;
    }

    callRuntimeRef.current = {
      callId,
      peerId,
      peerName,
      peerAvatar,
      callType,
      direction: 'outgoing',
      mediaCall,
      localStream,
      startedAt: Date.now(),
      connectedAt: null,
      facingMode: 'user',
    };

    // Pasang listener stream/close/error & pc.ontrack + ICE status segera setelah peer.call()
    bindOutgoingMediaCall(callId, mediaCall);

    setActiveCallUI({
      callId,
      peerId,
      peerName,
      peerAvatar,
      callType,
      phase: 'outgoing',
      duration: 0,
      isMuted: false,
      isCameraOff: callType !== 'video',
      isSpeakerOn: true,
      connectionMode: 'connecting',
      iceState: 'checking',
      localStream,
      remoteStream: null,
    });

    startOutgoingRingback();

    if (unansweredCallTimerRef.current !== null) {
      window.clearTimeout(unansweredCallTimerRef.current);
    }
    // Jika lawan bicara tidak mengangkat dalam 30 detik, tandai sebagai Panggilan tak terjawab
    unansweredCallTimerRef.current = window.setTimeout(() => {
      unansweredCallTimerRef.current = null;
      const currentRt = callRuntimeRef.current;
      if (currentRt && currentRt.callId === callId && !currentRt.connectedAt) {
        peerManagerRef.current?.sendPacket(peerId, {
          kind: 'CALL_SIGNAL',
          action: 'end',
          callId,
          callType,
          fromId: profile.id,
          fromName: profile.name,
          fromAvatar: profile.avatar,
        });
        showToast(`${peerName} tidak menjawab panggilan`);
        finalizeCall('missed');
      }
    }, 30000);
  };

  // Accept Incoming Call (termasuk pendingCall / incomingCallRef yang stabil terhadap re-render React)
  const handleAcceptCall = async (isAutoAccept = false) => {
    // BARIS PERTAMA: matikan total seluruh suara dering secara sinkron seketika tombol Jawab ditekan
    stopAllCallRingtones();
    try {
      const initialRt = callRuntimeRef.current;
      const initialIncoming = incomingCallRef.current;
      const initialPending = pendingCallRef.current;
      if (!initialRt && !initialIncoming && !initialPending) return;

      const targetCallType: CallType =
        initialRt?.callType ||
        (initialIncoming ? (initialIncoming.isVideo ? 'video' : 'audio') : undefined) ||
        initialPending?.callType ||
        'audio';

      // 1. Pertama-tama ambil mikrofon via getUserMedia (otomatis fallback ke { audio: true } jika kamera video gagal)
      let localStream: MediaStream;
      try {
        localStream = await getCallLocalStream(targetCallType);
      } catch (mediaErr) {
        console.error('[WattappsAU Call] Gagal mengakses mikrofon/kamera saat Angkat:', mediaErr);
        if (isAutoAccept) {
          showToast('Ketuk tombol hijau Jawab untuk menghubungkan audio/video.');
        } else {
          showToast('Gagal mengakses mikrofon. Periksa izin aplikasi.');
          handleRejectCall();
        }
        return;
      }

      // Baca ulang seluruh ref terbaru SETELAH await getUserMedia agar tidak basi bila mediaCall baru saja tiba
      const latestRt = callRuntimeRef.current;
      const latestIncoming = incomingCallRef.current;
      const latestPending = pendingCallRef.current;
      const me = profileRef.current;

      const targetMediaCall = latestRt?.mediaCall || latestIncoming?.call || null;

      // Kasus 1: MediaConnection masuk tersedia -> SEGERA eksekusi incomingCall.answer(stream) PERTAMA
      // SEBELUM pengaturan AudioContext, AndroidBridge, UI timer, atau animasi apa pun!
      if (targetMediaCall) {
        const resolvedCallId =
          latestRt?.callId || latestIncoming?.callId || latestPending?.callId || generateUid('call');
        const resolvedPeerId =
          latestRt?.peerId ||
          latestIncoming?.callerId ||
          latestPending?.peerId ||
          fromFullPeerId(targetMediaCall.peer);
        const resolvedPeerName = getTrustedPeerName(
          resolvedPeerId,
          latestRt?.peerName || latestIncoming?.callerName || latestPending?.peerName
        );
        void resolvePeerIdentity(resolvedPeerId);
        const resolvedPeerAvatar =
          latestRt?.peerAvatar ||
          latestIncoming?.callerAvatar ||
          latestPending?.peerAvatar ||
          '';
        const hasVideoTrack = localStream.getVideoTracks().length > 0;
        const resolvedCallType: CallType =
          targetCallType === 'video' && hasVideoTrack ? 'video' : 'audio';

        const activeRuntime: ActiveCallRuntime = latestRt
          ? {
              ...latestRt,
              mediaCall: targetMediaCall,
              localStream,
              callType: resolvedCallType,
              connectedAt: latestRt.connectedAt || Date.now(),
            }
          : {
              callId: resolvedCallId,
              peerId: resolvedPeerId,
              peerName: resolvedPeerName,
              peerAvatar: resolvedPeerAvatar,
              callType: resolvedCallType,
              direction: 'incoming',
              mediaCall: targetMediaCall,
              localStream,
              remoteStream: remoteStreamRef.current,
              startedAt: Date.now(),
              connectedAt: Date.now(),
              facingMode: 'user',
            };
        callRuntimeRef.current = activeRuntime;

        // Pastikan listener call.on('stream') sudah terdaftar sebelum answer(stream)
        bindMediaCallDiagnostics(resolvedCallId, targetMediaCall);

        // EKSEKUSI UTAMA: langsung kirim SDP Answer via incomingCall.answer(localStream)
        if (peerManagerRef.current) {
          peerManagerRef.current.answerMediaCall(targetMediaCall, localStream);
        } else {
          localStream.getAudioTracks().forEach((track) => {
            track.enabled = true;
          });
          targetMediaCall.answer(localStream);
          ensureLocalAudioTracksAttached(targetMediaCall, localStream);
        }

        // Pasang listener RTCPeerConnection (pc.ontrack & iceconnectionstatechange) segera setelah answer() membuat peerConnection
        bindMediaCallDiagnostics(resolvedCallId, targetMediaCall);

        // 2. Setelah handshake answer berhasil dipicu, pastikan semua dering mati & jalankan pengaturan audio/UI secara terisolasi
        stopAllCallRingtones();
        if (unansweredCallTimerRef.current !== null) {
          window.clearTimeout(unansweredCallTimerRef.current);
          unansweredCallTimerRef.current = null;
        }

        try {
          pauseKeepAliveForCall();
          dismissIncomingCallNotification(resolvedPeerId);
        } catch {
          // ignore
        }

        try {
          isSpeakerOnRef.current = true;
          unlockRemoteAudioElement();
          setAndroidBridgeCallAudioMode(true);
        } catch (audioModeErr) {
          console.warn('[WattappsAU Call] Pengaturan mode speaker Android gagal:', audioModeErr);
        }

        try {
          resumeWebAudioContext();
          ensureCallAudioContext(true);
        } catch (ctxErr) {
          console.warn('[WattappsAU Call] Inisialisasi AudioContext panggilan gagal:', ctxErr);
        }

        const bufferedRemote = remoteStreamRef.current || activeRuntime.remoteStream || null;
        if (bufferedRemote) {
          try {
            attachRemoteCallAudioStream(bufferedRemote, true);
          } catch (streamErr) {
            console.warn('[WattappsAU Call] Gagal memutar remoteStream ter-buffer:', streamErr);
          }
        }

        setPersistentIncomingCall(null);
        setActiveCallUI({
          callId: resolvedCallId,
          peerId: resolvedPeerId,
          peerName: resolvedPeerName,
          peerAvatar: resolvedPeerAvatar,
          callType: resolvedCallType,
          phase: 'connected',
          duration: 0,
          isMuted: false,
          isCameraOff: resolvedCallType !== 'video',
          isSpeakerOn: true,
          connectionMode: 'connecting',
          iceState: getMediaCallPeerConnection(targetMediaCall)?.iceConnectionState || 'checking',
          localStream,
          remoteStream: bufferedRemote,
        });

        if (callTimerRef.current !== null) {
          window.clearInterval(callTimerRef.current);
        }
        callTimerRef.current = window.setInterval(() => {
          if (!callRuntimeRef.current?.connectedAt) return;
          const secs = Math.floor((Date.now() - callRuntimeRef.current.connectedAt) / 1000);
          setActiveCallUI((prev) => (prev ? { ...prev, duration: secs } : null));
        }, 1000);
        return;
      }

      // Kasus 2: Pengguna mengetuk Jawab pada pop-up pendingCall/notifikasi sebelum MediaConnection baru tiba dari penelepon
      const fallbackPeerId = latestPending?.peerId || latestIncoming?.callerId;
      const fallbackCallId = latestPending?.callId || latestIncoming?.callId;
      const fallbackPeerName = fallbackPeerId
        ? getTrustedPeerName(fallbackPeerId, latestPending?.peerName || latestIncoming?.callerName)
        : LOADING_IDENTITY_LABEL;
      const fallbackPeerAvatar = latestPending?.peerAvatar || latestIncoming?.callerAvatar || '';

      if (fallbackPeerId && fallbackCallId && me) {
        const hasVideoTrack = localStream.getVideoTracks().length > 0;
        const resolvedCallType: CallType =
          targetCallType === 'video' && hasVideoTrack ? 'video' : 'audio';

        stopAllCallRingtones();
        if (unansweredCallTimerRef.current !== null) {
          window.clearTimeout(unansweredCallTimerRef.current);
          unansweredCallTimerRef.current = null;
        }

        const timeoutId = window.setTimeout(() => {
          if (awaitingMediaCallAnswerRef.current?.callId === fallbackCallId) {
            showToast('Panggilan sudah berakhir atau tidak dapat tersambung.');
            finalizeCall('missed');
          }
        }, 15000);

        awaitingMediaCallAnswerRef.current = {
          callId: fallbackCallId,
          peerId: fallbackPeerId,
          peerName: fallbackPeerName,
          peerAvatar: fallbackPeerAvatar,
          callType: resolvedCallType,
          localStream,
          timeoutId,
        };

        // Kirim sinyal accept segera agar penelepon mengirim MediaConnection segar
        peerManagerRef.current?.ensureConnection(fallbackPeerId, true);
        peerManagerRef.current?.sendPacket(fallbackPeerId, {
          kind: 'CALL_SIGNAL',
          action: 'accept',
          callId: fallbackCallId,
          callType: resolvedCallType,
          fromId: me.id,
          fromName: me.name,
          fromAvatar: me.avatar,
        });

        try {
          stopAllCallRingtones();
          pauseKeepAliveForCall();
          dismissIncomingCallNotification(fallbackPeerId);
          isSpeakerOnRef.current = true;
          unlockRemoteAudioElement();
          setAndroidBridgeCallAudioMode(true);
          resumeWebAudioContext();
          ensureCallAudioContext(true);
        } catch {
          // ignore
        }

        setActiveCallUI((prev) =>
          prev
            ? {
                ...prev,
                callType: resolvedCallType,
                isCameraOff: resolvedCallType !== 'video',
                phase: 'outgoing',
                iceState: 'checking',
                localStream,
              }
            : null
        );
      }
    } catch (err) {
      console.error('[WattappsAU Call] Error tidak terduga pada handleAcceptCall:', err);
      showToast('Terjadi kendala saat menjawab panggilan. Coba lagi.');
    }
  };

  const handleRejectCall = (fallback?: {
    callerId?: string;
    callerName?: string;
    callId?: string;
    callType?: CallType;
  }) => {
    // BARIS PERTAMA: matikan total seluruh suara dering secara sinkron seketika tombol Tolak ditekan
    stopAllCallRingtones();
    const rt = callRuntimeRef.current;
    const pending = pendingCallRef.current;
    const activeIncoming = incomingCallRef.current;
    const me = profileRef.current;
    const cleanFallbackId = fallback?.callerId ? fromFullPeerId(fallback.callerId) : undefined;

    const targetPeerId = rt?.peerId || pending?.peerId || activeIncoming?.callerId || cleanFallbackId;
    const targetCallId =
      rt?.callId || pending?.callId || activeIncoming?.callId || fallback?.callId || generateUid('call');
    const targetCallType: CallType =
      rt?.callType ||
      pending?.callType ||
      (activeIncoming ? (activeIncoming.isVideo ? 'video' : 'audio') : undefined) ||
      fallback?.callType ||
      'audio';

    if (activeIncoming?.call) {
      try {
        activeIncoming.call.close();
      } catch {
        // ignore
      }
    }

    if (targetPeerId && targetCallId && me) {
      peerManagerRef.current?.sendPacket(targetPeerId, {
        kind: 'CALL_SIGNAL',
        action: 'reject',
        callId: targetCallId,
        callType: targetCallType,
        fromId: me.id,
        fromName: me.name,
        fromAvatar: me.avatar,
      });
    }

    // Jika runtime/pending sudah ada, finalizeCall('rejected') akan otomatis menghentikan dering & mencatat riwayat + log chat
    if (rt || pending || awaitingMediaCallAnswerRef.current) {
      finalizeCall('rejected');
      return;
    }

    // Fallback bila penolakan dari layar kunci datang sebelum state runtime terbentuk
    stopAllCallRingtones();
    attachRemoteCallAudioStream(null);
    setAndroidBridgeCallAudioMode(false);
    resumeKeepAliveAfterCall();
    setPersistentIncomingCall(null);
    setActiveCallUI(null);
    if (targetPeerId) {
      const existingContact = contactsRef.current.find((c) => c.id === targetPeerId);
      const record: CallRecord = {
        id: targetCallId,
        peerId: targetPeerId,
        peerName: getTrustedPeerName(
          targetPeerId,
          activeIncoming?.callerName || fallback?.callerName
        ),
        peerAvatar: existingContact?.avatar || activeIncoming?.callerAvatar || '',
        callType: targetCallType,
        direction: 'incoming',
        status: 'rejected',
        timestamp: Date.now(),
        duration: 0,
      };
      setCalls((prev) => (prev.some((c) => c.id === record.id) ? prev : [record, ...prev]));
      void dbSaveCall(record);
      appendCallLogToChat(record);
      void resolvePeerIdentity(targetPeerId);
    }
  };

  handleAcceptCallRef.current = handleAcceptCall;
  handleRejectCallRef.current = handleRejectCall;

  const handleEndCall = () => {
    // BARIS PERTAMA: matikan total seluruh suara dering secara sinkron seketika tombol Tutup ditekan
    stopAllCallRingtones();
    const rt = callRuntimeRef.current;
    const pending = pendingCallRef.current || awaitingMediaCallAnswerRef.current;
    const me = profileRef.current;
    const targetPeerId = rt?.peerId || pending?.peerId;
    const targetCallId = rt?.callId || pending?.callId;
    const targetCallType = rt?.callType || pending?.callType || 'audio';

    if (targetPeerId && targetCallId && me) {
      peerManagerRef.current?.sendPacket(targetPeerId, {
        kind: 'CALL_SIGNAL',
        action: 'end',
        callId: targetCallId,
        callType: targetCallType,
        fromId: me.id,
        fromName: me.name,
        fromAvatar: me.avatar,
      });
    }
    finalizeCall();
  };

  const handleToggleMute = () => {
    const rt = callRuntimeRef.current;
    if (!rt?.localStream) return;
    const nextMuted = !activeCallUI?.isMuted;
    rt.localStream.getAudioTracks().forEach((t) => {
      t.enabled = !nextMuted;
    });
    setActiveCallUI((prev) => (prev ? { ...prev, isMuted: nextMuted } : null));
  };

  const handleToggleCamera = () => {
    const rt = callRuntimeRef.current;
    if (!rt?.localStream) return;
    const nextOff = !activeCallUI?.isCameraOff;
    rt.localStream.getVideoTracks().forEach((t) => {
      t.enabled = !nextOff;
    });
    setActiveCallUI((prev) => (prev ? { ...prev, isCameraOff: nextOff } : null));
  };

  const handleSwitchCamera = async () => {
    const rt = callRuntimeRef.current;
    if (!rt?.localStream || rt.callType !== 'video') return;
    const nextFacing: 'user' | 'environment' =
      rt.facingMode === 'user' ? 'environment' : 'user';
    try {
      const newVideoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: nextFacing },
        audio: false,
      });
      const newVideoTrack = newVideoStream.getVideoTracks()[0];
      if (!newVideoTrack) return;

      // Replace video track in RTCPeerConnection sender so remote sees new camera seamlessly
      const pc = (rt.mediaCall as unknown as { peerConnection?: RTCPeerConnection })
        .peerConnection;
      if (pc) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(newVideoTrack);
        }
      }

      // Stop old video track & update local stream
      rt.localStream.getVideoTracks().forEach((t) => {
        t.stop();
        rt.localStream?.removeTrack(t);
      });
      rt.localStream.addTrack(newVideoTrack);
      rt.facingMode = nextFacing;
      setActiveCallUI((prev) =>
        prev ? { ...prev, localStream: new MediaStream(rt.localStream!.getTracks()) } : null
      );
    } catch {
      showToast('Kamera lain tidak tersedia pada perangkat ini.');
    }
  };

  const handleToggleSpeaker = () => {
    setActiveCallUI((prev) => {
      if (!prev) return null;
      const nextSpeaker = !prev.isSpeakerOn;
      isSpeakerOnRef.current = nextSpeaker;
      if (callRemoteGainRef.current) {
        callRemoteGainRef.current.gain.value = nextSpeaker ? 1.0 : 0.0;
      }
      if (nextSpeaker && callAudioCtxRef.current?.state === 'suspended') {
        void callAudioCtxRef.current.resume().catch(() => {});
      }
      const audioEl =
        remoteCallAudioRef.current ||
        (document.getElementById('remoteAudio') as HTMLAudioElement | null);
      if (audioEl) {
        audioEl.volume = 1.0;
        audioEl.muted = !nextSpeaker;
        if (nextSpeaker && audioEl.srcObject) {
          void audioEl.play().catch(() => {});
        }
      }
      return { ...prev, isSpeakerOn: nextSpeaker };
    });
  };

  // Tombol darurat "Paksa Suara / Speaker" di layar panggilan:
  // Menjalankan audioCtx.resume(), re-bind & remoteAudio.play(), menyambungkan ulang remoteStream ke AudioContext,
  // serta memanggil window.AndroidBridge?.setCallAudioMode?.(true).
  const handleRefreshCallAudio = () => {
    const rt = callRuntimeRef.current;
    stopAllCallRingtones();
    resumeWebAudioContext();
    const ctx = ensureCallAudioContext(false);
    if (ctx) {
      void ctx.resume().catch(() => {});
    }
    setAndroidBridgeCallAudioMode(true);
    isSpeakerOnRef.current = true;
    setActiveCallUI((prev) => (prev ? { ...prev, isSpeakerOn: true } : null));

    if (rt?.localStream && !activeCallUI?.isMuted) {
      rt.localStream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      ensureLocalAudioTracksAttached(rt.mediaCall, rt.localStream);
    }

    const remoteStream =
      remoteStreamRef.current || rt?.remoteStream || activeCallUI?.remoteStream || null;
    const audioEl =
      remoteCallAudioRef.current ||
      (document.getElementById('remoteAudio') as HTMLAudioElement | null);
    if (remoteStream) {
      attachRemoteCallAudioStream(remoteStream, true);
      setActiveCallUI((prev) => (prev ? { ...prev, remoteStream } : null));
    } else if (audioEl) {
      audioEl.volume = 1.0;
      audioEl.muted = false;
      void audioEl.play().catch(() => {});
    }

    if (rt) {
      const pc = getMediaCallPeerConnection(rt.mediaCall);
      if (pc?.iceConnectionState) {
        setActiveCallUI((prev) =>
          prev ? { ...prev, iceState: pc.iceConnectionState } : null
        );
      }
      void inspectMediaCallTransport(rt.mediaCall, false).then((mode) => {
        if (mode && callRuntimeRef.current?.callId === rt.callId) {
          setActiveCallUI((prev) => (prev ? { ...prev, connectionMode: mode } : null));
        }
      });
    }

    showToast('Suara & speaker panggilan dipaksa aktif');
  };

  // Toggle Mode Siaga (Service Worker + Auto-Reconnect PeerJS + Screen Wake Lock tanpa membajak fokus audio Android/Bluetooth)
  const handleToggleStandby = useCallback(async () => {
    if (standbyModeRef.current) {
      await disableStandbyMode();
      setStandbyMode(false);
      showToast('Mode Siaga dinonaktifkan');
      return;
    }

    const res = await enableStandbyMode();
    setStandbyMode(true);

    if (res.wakeLockActive) {
      showToast('Mode Siaga Aktif · PeerJS & Service Worker siaga tanpa mengganggu fokus audio');
    } else {
      showToast('Mode Siaga Aktif · Koneksi P2P & notifikasi siaga tanpa mengganggu audio perangkat');
    }
  }, [showToast]);

  // Reset all data
  const handleConfirmReset = async () => {
    await disableStandbyMode();
    setStandbyMode(false);
    peerManagerRef.current?.destroy();
    await resetAllLocalData();
    setContacts([]);
    setMessages([]);
    setStatuses([]);
    setCalls([]);
    setPendingMessages([]);
    setUnreadCounts({});
    setActiveChatId(null);
    setShowResetConfirm(false);
    setProfile(null);
  };

  // Keluar aplikasi secara resmi (matikan Mode Siaga, lepas AudioContext & Media Session, lalu putus koneksi)
  const handleExitApp = useCallback(async () => {
    setShowMainMenu(false);
    setShowProfileDrawer(false);
    setShowShareAppModal(false);
    setShowNewChatModal(false);
    setShowNewGroupModal(false);
    setShowResetConfirm(false);
    setCameraPurpose(null);
    setLightboxMedia(null);
    setSearchOpen(false);
    setActiveChatId(null);

    if (callRuntimeRef.current || pendingCallRef.current) {
      finalizeCall('rejected');
    }
    stopAllCallRingtones();

    standbyModeRef.current = false;
    setStandbyMode(false);
    await disableStandbyMode();
    await syncConnectionWakeLock(false);
    releaseActiveMediaSession();
    clearPeerMediaSession();
    releaseAudioContextNow();

    isHistoryTrapped = false;
    isExitedRef.current = true;
    peerManagerRef.current?.destroy();
    peerManagerRef.current = null;
    setPeerState('disconnected');
    setOnlinePeers({});
    setPeerTransports({});
    setIsExited(true);

    // Coba tutup jendela/tab aplikasi (didukung di PWA/window tertentu)
    try {
      window.close();
    } catch {
      // ignore
    }
  }, [finalizeCall]);

  // Buka kembali aplikasi dari layar istirahat/offline
  const handleReopenApp = useCallback(async () => {
    isHistoryTrapped = false;
    isExitedRef.current = false;
    standbyModeRef.current = true;
    setStandbyMode(true);
    setPeerState('connecting');
    setIsExited(false);
    await enableStandbyMode();
    showToast('WattappsAU kembali aktif & siaga');
  }, [showToast]);

  const activeContact = useMemo(
    () => contacts.find((c) => c.id === activeChatId) || null,
    [contacts, activeChatId]
  );

  const activeChatMessages = useMemo(
    () => (activeChatId ? messages.filter((m) => m.chatId === activeChatId) : []),
    [messages, activeChatId]
  );

  const totalUnreadChats = useMemo(
    () => Object.values(unreadCounts).reduce((sum, n) => sum + (n > 0 ? 1 : 0), 0),
    [unreadCounts]
  );

  const hasUnviewedStatus = useMemo(
    () => statuses.some((s) => s.userId !== profile?.id && !s.viewed && s.expiresAt > Date.now()),
    [statuses, profile?.id]
  );

  // Show Welcome / Onboarding if no profile saved yet
  if (!profile) {
    return <OnboardingScreen onComplete={handleCompleteOnboarding} />;
  }

  // Layar Istirahat / Offline setelah pengguna memilih menu Exit (Dark-Mode Command-Center: Navy/Slate + Cyan/Gold)
  if (isExited) {
    return (
      <div className="h-dvh w-full flex flex-col items-center justify-center bg-[#070d16] text-slate-100 px-6 text-center">
        <div className="w-full max-w-sm rounded-3xl bg-[#0f172a] border border-cyan-500/20 p-7 shadow-[0_20px_60px_rgba(0,0,0,0.6)] flex flex-col items-center">
          <div className="relative mb-5">
            <AppLogo size={76} className="opacity-80 grayscale-[25%] ring-2 ring-cyan-400/35" />
            <span className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-slate-900 border-2 border-amber-400/60 flex items-center justify-center">
              <Power className="w-3.5 h-3.5 text-amber-400" />
            </span>
          </div>

          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/15 border border-amber-400/35 text-amber-300 text-[11px] font-semibold tracking-wide">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            Offline · Mode Siaga Nonaktif
          </span>

          <h1 className="mt-4 text-xl font-bold tracking-tight text-white">
            WattappsAU Telah Berhenti
          </h1>

          <p className="mt-2.5 text-sm text-slate-400 leading-relaxed">
            Layanan siaga, sesi media, AudioContext, dan koneksi P2P telah dilepas sepenuhnya. Aplikasi ini sekarang aman untuk ditutup.
          </p>

          <div className="mt-6 w-full flex flex-col gap-2.5">
            <button
              type="button"
              onClick={() => void handleReopenApp()}
              className="w-full h-11 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-sm font-bold transition-colors cursor-pointer"
            >
              Buka Kembali WattappsAU
            </button>
            <button
              type="button"
              onClick={() => {
                try {
                  window.close();
                } catch {
                  // ignore
                }
              }}
              className="w-full h-10 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-semibold transition-colors cursor-pointer"
            >
              Tutup Jendela / Swipe Keluar
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-dvh w-full flex bg-[#F0F2F5] dark:bg-[#070d16] overflow-hidden relative">
      {/* LEFT SIDEBAR (Full-width on mobile when no chat active; fixed 380px-420px split-pane on desktop) */}
      <aside
        className={`w-full md:w-[380px] lg:w-[420px] h-full flex flex-col bg-white dark:bg-[#0b1320] border-r border-black/10 dark:border-cyan-500/15 shrink-0 ${
          activeContact ? 'hidden md:flex' : 'flex'
        }`}
      >
        {/* Top Command-Center Header (Navy/Slate + Neon Cyan & Gold Accents in Dark Mode) */}
        <header className="bg-[#008069] dark:bg-[#0f172a] dark:border-b dark:border-cyan-500/15 text-white shrink-0 pt-safe">
          {searchOpen ? (
            <div className="h-[58px] px-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery('');
                }}
                className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-white/10 cursor-pointer"
                aria-label="Tutup pencarian"
              >
                <X className="w-5 h-5" />
              </button>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Cari chat, ID 6 digit, atau panggilan..."
                autoFocus
                className="flex-1 h-10 px-3 rounded-xl bg-white/15 text-white placeholder:text-white/70 text-sm focus:outline-none"
              />
            </div>
          ) : (
            <div className="flex flex-col">
            <div className="min-h-[60px] py-1.5 px-3 flex items-center justify-between gap-1.5">
              {/* Brand & PeerJS Live Status Indicator */}
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setShowProfileDrawer(true)}
                  className="inline-flex items-center gap-2 text-lg font-bold tracking-tight hover:opacity-90 cursor-pointer min-w-0"
                >
                  <AppLogo size={32} className="shadow-xs ring-1 ring-white/25 shrink-0" />
                  <span className="flex flex-col items-start text-left min-w-0 leading-none">
                    <span className="text-[16px] font-bold tracking-tight leading-tight">
                      WattappsAU
                    </span>
                    <span className="text-[6.5px] font-medium tracking-[0.01em] text-white/80 leading-[1.15] whitespace-normal">
                      Wireless Air Tactical Application System Angkatan Udara
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (peerState !== 'online') {
                      peerManagerRef.current?.connect();
                      showToast('Menghubungkan ulang ke server PeerJS...');
                    } else {
                      setShowProfileDrawer(true);
                    }
                  }}
                  title={peerError || `ID Anda: ${profile.id}`}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-white/90 hover:text-white transition-colors whitespace-nowrap cursor-pointer shrink-0"
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      peerState === 'online'
                        ? 'bg-[#25D366]'
                        : peerState === 'connecting'
                        ? 'bg-amber-300 animate-pulse'
                        : 'bg-rose-400'
                    }`}
                  />
                  <span>
                    {peerState === 'online'
                      ? 'Online'
                      : peerState === 'connecting'
                      ? 'Menghubungkan...'
                      : 'Terputus'}
                  </span>
                  {peerState === 'disconnected' || peerState === 'error' ? (
                    <RefreshCw className="w-3 h-3" />
                  ) : null}
                </button>
              </div>

              {/* Right Icons: Mode Siaga / Anti-Sleep, Camera, Global Search, 3-Dot Menu */}
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => void handleToggleStandby()}
                  className={`h-8 px-2 mr-0.5 rounded-full inline-flex items-center gap-1 text-[11px] font-semibold transition-all cursor-pointer border ${
                    standbyMode
                      ? 'bg-cyan-500/15 border-cyan-400/65 text-cyan-200 shadow-[0_0_12px_rgba(34,211,238,0.28)]'
                      : 'bg-white/10 border-white/15 text-white/90 hover:bg-white/20'
                  }`}
                  title={
                    standbyMode
                      ? 'Mode Siaga AKTIF (Service Worker & Auto-Reconnect tanpa mengganggu fokus audio)'
                      : 'Aktifkan Mode Siaga untuk menjaga koneksi P2P & notifikasi'
                  }
                  aria-label="Mode Siaga"
                  aria-pressed={standbyMode}
                >
                  {standbyMode ? (
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                  ) : (
                    <Shield className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span>Siaga</span>
                </button>

                <button
                  type="button"
                  onClick={() => setCameraPurpose(activeContact ? 'chat' : 'status')}
                  className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors cursor-pointer"
                  title="Kamera"
                  aria-label="Buka Kamera"
                >
                  <Camera className="w-5 h-5" />
                </button>

                <button
                  type="button"
                  onClick={() => setSearchOpen(true)}
                  className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors cursor-pointer"
                  title="Pencarian"
                  aria-label="Pencarian global"
                >
                  <Search className="w-5 h-5" />
                </button>

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowMainMenu((prev) => !prev)}
                    className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors cursor-pointer"
                    title="Menu lainnya"
                    aria-label="Menu titik tiga"
                  >
                    <MoreVertical className="w-5 h-5" />
                  </button>

                  {showMainMenu && (
                    <>
                      <div
                        className="fixed inset-0 z-30"
                        onClick={() => setShowMainMenu(false)}
                      />
                      <div className="absolute right-0 mt-1 w-60 rounded-xl bg-white dark:bg-[#233138] shadow-2xl border border-black/10 dark:border-white/10 py-1.5 z-40 text-[#111B21] dark:text-[#E9EDEF]">
                        <button
                          type="button"
                          onClick={() => {
                            setShowMainMenu(false);
                            void handleToggleStandby();
                          }}
                          className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left text-sm hover:bg-[#F5F6F6] dark:hover:bg-[#182229] transition-colors cursor-pointer"
                        >
                          <span className="flex items-center gap-3 min-w-0">
                            {standbyMode ? (
                              <ShieldCheck className="w-4 h-4 shrink-0 text-[#00A884] animate-pulse" />
                            ) : (
                              <Shield className="w-4 h-4 shrink-0 text-[#008069] dark:text-[#00A884]" />
                            )}
                            <span className="truncate">Mode Siaga Latar Belakang</span>
                          </span>
                          <span
                            className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded-md shrink-0 ${
                              standbyMode
                                ? 'bg-[#00A884]/20 text-[#008069] dark:text-[#06CF9C]'
                                : 'bg-black/5 dark:bg-white/10 text-[#667781] dark:text-[#8696A0]'
                            }`}
                          >
                            {standbyMode ? 'ON' : 'OFF'}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setShowMainMenu(false);
                            setShowNewGroupModal(true);
                          }}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm hover:bg-[#F5F6F6] dark:hover:bg-[#182229] transition-colors cursor-pointer"
                        >
                          <Users className="w-4 h-4 text-[#008069] dark:text-[#00A884] shrink-0" />
                          <span>Grup Baru</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setShowMainMenu(false);
                            setShowProfileDrawer(true);
                          }}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm hover:bg-[#F5F6F6] dark:hover:bg-[#182229] transition-colors cursor-pointer"
                        >
                          <User className="w-4 h-4 text-[#008069] dark:text-[#00A884] shrink-0" />
                          <span>Profil &amp; ID Saya</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setShowMainMenu(false);
                            setShowShareAppModal(true);
                          }}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm hover:bg-[#F5F6F6] dark:hover:bg-[#182229] transition-colors cursor-pointer"
                        >
                          <Share2 className="w-4 h-4 text-[#008069] dark:text-[#00A884] shrink-0" />
                          <span>Bagikan Aplikasi</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
                            setShowMainMenu(false);
                          }}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm hover:bg-[#F5F6F6] dark:hover:bg-[#182229] transition-colors cursor-pointer"
                        >
                          {theme === 'dark' ? (
                            <Sun className="w-4 h-4 text-amber-400 shrink-0" />
                          ) : (
                            <Moon className="w-4 h-4 text-[#008069] shrink-0" />
                          )}
                          <span>{theme === 'dark' ? 'Mode Terang' : 'Mode Gelap'}</span>
                        </button>

                        <PWAInstallButton
                          variant="menu-item"
                          onAfterClick={() => setShowMainMenu(false)}
                        />

                        <div className="my-1 border-t border-black/5 dark:border-white/10" />

                        <button
                          type="button"
                          onClick={() => {
                            setShowMainMenu(false);
                            setShowResetConfirm(true);
                          }}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm text-rose-600 dark:text-rose-400 hover:bg-[#F5F6F6] dark:hover:bg-[#182229] transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4 shrink-0" />
                          <span>Reset Data</span>
                        </button>

                        <div className="my-1 border-t border-black/5 dark:border-white/10" />

                        <button
                          type="button"
                          onClick={() => void handleExitApp()}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-orange-600 dark:text-orange-400 hover:bg-orange-50/70 dark:hover:bg-orange-950/30 transition-colors cursor-pointer"
                        >
                          <LogOut className="w-4 h-4 shrink-0" />
                          <span>Exit</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Badge Identitas Aktif Perangkat (Terkunci di localStorage) */}
            <div className="px-3 pb-1.5 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setShowProfileDrawer(true)}
                className="min-w-0 flex-1 inline-flex items-center gap-1.5 rounded-lg bg-black/15 dark:bg-slate-800/80 border border-white/15 dark:border-cyan-500/25 px-2.5 py-1 text-left text-[11.5px] font-medium text-white/95 hover:bg-black/25 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                title="Identitas perangkat terkunci permanen — ketuk untuk melihat profil"
              >
                <Lock className="w-3 h-3 text-emerald-300 dark:text-cyan-400 shrink-0" />
                <span className="truncate">
                  <span className="text-white/75">ID Aktif: </span>
                  <span className="font-semibold text-white">{profile.name}</span>
                  <span className="font-mono text-emerald-200 dark:text-cyan-300 ml-1">
                    ({formatSixDigitId(profile.id)})
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(profile.id).then(() => {
                    showToast(`ID Aktif ${formatSixDigitId(profile.id)} disalin`);
                  });
                }}
                className="h-7 px-2 rounded-lg bg-black/15 dark:bg-slate-800/80 border border-white/15 dark:border-cyan-500/25 text-[11px] font-medium text-white/90 hover:bg-black/25 dark:hover:bg-slate-800 inline-flex items-center gap-1 shrink-0 transition-colors cursor-pointer"
                title="Salin ID Aktif"
                aria-label="Salin ID Aktif"
              >
                <Copy className="w-3 h-3 shrink-0" />
                <span>Salin</span>
              </button>
            </div>
            </div>
          )}

          {/* 3 Main Navigation Tabs: Chat · Status · Panggilan */}
          <nav className="grid grid-cols-3 text-sm font-semibold">
            <button
              type="button"
              onClick={() => setActiveTab('chats')}
              className={`h-11 flex items-center justify-center gap-1.5 border-b-[3px] transition-colors cursor-pointer ${
                activeTab === 'chats'
                  ? 'border-white dark:border-cyan-400 text-white dark:text-cyan-300'
                  : 'border-transparent text-white/70 dark:text-slate-400 hover:text-white'
              }`}
            >
              <span>Chat</span>
              {totalUnreadChats > 0 && (
                <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-white dark:bg-amber-400 text-[#008069] dark:text-slate-950 text-[10.5px] font-bold flex items-center justify-center tabular-nums">
                  {totalUnreadChats}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('status')}
              className={`h-11 flex items-center justify-center gap-1.5 border-b-[3px] transition-colors cursor-pointer ${
                activeTab === 'status'
                  ? 'border-white dark:border-cyan-400 text-white dark:text-cyan-300'
                  : 'border-transparent text-white/70 dark:text-slate-400 hover:text-white'
              }`}
            >
              <span>Status</span>
              {hasUnviewedStatus && (
                <span className="w-2 h-2 rounded-full bg-amber-400" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('calls')}
              className={`h-11 flex items-center justify-center gap-1.5 border-b-[3px] transition-colors cursor-pointer ${
                activeTab === 'calls'
                  ? 'border-white dark:border-cyan-400 text-white dark:text-cyan-300'
                  : 'border-transparent text-white/70 dark:text-slate-400 hover:text-white'
              }`}
            >
              <span>Panggilan</span>
            </button>
          </nav>
        </header>

        {/* Active Sidebar Tab Content */}
        {!dataLoaded ? (
          <div className="flex-1 flex items-center justify-center text-sm text-[#667781] dark:text-[#8696A0]">
            Memuat data lokal...
          </div>
        ) : activeTab === 'chats' ? (
          <ChatList
            contacts={contacts}
            messages={messages}
            myId={profile.id}
            activeChatId={activeChatId}
            unreadCounts={unreadCounts}
            onlinePeers={onlinePeers}
            typingMap={typingMap}
            searchQuery={searchQuery}
            onSelectChat={(id) => setActiveChatId(id)}
            onNewChat={() => setShowNewChatModal(true)}
          />
        ) : activeTab === 'status' ? (
          <StatusTab
            profile={profile}
            statuses={statuses}
            onPostTextStatus={handlePostTextStatus}
            onPostImageStatus={handlePostImageStatus}
            onMarkStatusViewed={handleMarkStatusViewed}
            onDeleteStatus={handleDeleteStatus}
            onReplyToStatus={handleReplyToStatus}
            onOpenCameraForStatus={() => setCameraPurpose('status')}
          />
        ) : (
          <CallsTab
            calls={calls}
            searchQuery={searchQuery}
            onStartCall={handleStartCall}
            onClearCalls={() => {
              setCalls([]);
              void dbClearCalls();
              showToast('Riwayat panggilan dihapus');
            }}
          />
        )}
      </aside>

      {/* RIGHT MAIN PANE (Active Chat Room or Desktop WhatsApp Web Welcome View) */}
      <main
        className={`flex-1 h-full flex flex-col min-w-0 ${
          activeContact ? 'flex' : 'hidden md:flex'
        }`}
      >
        {activeContact ? (
          <ChatRoom
            profile={profile}
            contact={activeContact}
            messages={activeChatMessages}
            isPeerOnline={Boolean(onlinePeers[activeContact.id])}
            peerTransport={
              activeContact.isGroup ? null : peerTransports[activeContact.id] ?? null
            }
            typingUserName={typingMap[activeContact.id]}
            onBack={() => setActiveChatId(null)}
            onSendText={(txt, replyTo) =>
              dispatchMessage(activeContact.id, { type: 'text', text: txt, replyTo })
            }
            onSendMedia={(media) => dispatchMessage(activeContact.id, media)}
            onDeleteMessage={handleDeleteMessage}
            onClearChat={handleClearChat}
            onDeleteContact={handleDeleteContact}
            onTyping={handleTyping}
            onStartCall={handleStartCall}
            onOpenCamera={() => setCameraPurpose('chat')}
            onOpenLightbox={setLightboxMedia}
            onToast={showToast}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center bg-[#F0F2F5] dark:bg-[#222E35] border-b-[6px] border-[#25D366] dark:border-[#00A884] px-8 text-center">
            <div className="mb-5">
              <AppLogo size={96} className="shadow-lg ring-4 ring-white/80 dark:ring-white/10" />
            </div>
            <h1 className="text-2xl font-light text-[#41525D] dark:text-[#E9EDEF]">
              WattappsAU Web &amp; PWA
            </h1>
            <p className="mt-2.5 text-sm text-[#667781] dark:text-[#8696A0] max-w-md leading-relaxed">
              Kirim pesan, Voice Note, dokumen, Status 24 jam, dan panggilan suara atau video secara langsung Peer-to-Peer tanpa nomor telepon maupun database eksternal.
            </p>

            {/* Quick 6-Digit ID Copy Card */}
            <div className="mt-7 rounded-2xl bg-white dark:bg-[#111B21] border border-black/5 dark:border-white/10 px-6 py-4 shadow-xs flex items-center gap-5">
              <div className="text-left">
                <div className="text-xs text-[#667781] dark:text-[#8696A0]">ID 6 Digit Anda</div>
                <div className="font-mono-id text-2xl font-bold tracking-wider text-[#008069] dark:text-[#00A884]">
                  {formatSixDigitId(profile.id)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(profile.id);
                      showToast(`ID ${profile.id} disalin`);
                    } catch {
                      showToast(`ID Anda: ${profile.id}`);
                    }
                  }}
                  className="h-10 px-3.5 rounded-xl bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] text-white dark:text-[#111B21] text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Salin ID</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowShareAppModal(true)}
                  className="h-10 px-3.5 rounded-xl bg-[#F0F2F5] dark:bg-[#202C33] text-[#111B21] dark:text-[#E9EDEF] text-xs font-semibold flex items-center gap-1.5 hover:bg-[#E4E7EB] dark:hover:bg-[#2A3942] cursor-pointer whitespace-nowrap"
                  title="Bagikan Aplikasi via Barcode & Link"
                >
                  <Share2 className="w-3.5 h-3.5 text-[#008069] dark:text-[#00A884]" />
                  <span>Bagikan Aplikasi</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowProfileDrawer(true)}
                  className="h-10 w-10 rounded-xl bg-[#F0F2F5] dark:bg-[#202C33] text-[#111B21] dark:text-[#E9EDEF] flex items-center justify-center hover:bg-[#E4E7EB] dark:hover:bg-[#2A3942] cursor-pointer"
                  title="Lihat QR Code Saya"
                >
                  <QrCode className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="mt-10 flex items-center gap-1.5 text-xs text-[#8696A0]">
              <Lock className="w-3.5 h-3.5" />
              <span>Terenkripsi Peer-to-Peer (WebRTC DTLS/SRTP) · 100% Penyimpanan Lokal</span>
            </div>
          </div>
        )}
      </main>

      {/* Modals & Overlays */}
      {showProfileDrawer && (
        <ProfileDrawer
          profile={profile}
          onUpdateProfile={handleUpdateProfile}
          onOpenShareApp={() => {
            setShowProfileDrawer(false);
            setShowShareAppModal(true);
          }}
          onClose={() => setShowProfileDrawer(false)}
          onToast={showToast}
        />
      )}

      {showShareAppModal && (
        <ShareAppModal
          profile={profile}
          onClose={() => setShowShareAppModal(false)}
          onToast={showToast}
        />
      )}

      {showNewChatModal && (
        <NewChatModal
          myId={profile.id}
          onAddContact={handleAddContact}
          onClose={() => setShowNewChatModal(false)}
        />
      )}

      {showNewGroupModal && (
        <NewGroupModal
          contacts={contacts}
          onCreateGroup={handleCreateGroup}
          onClose={() => setShowNewGroupModal(false)}
        />
      )}

      {cameraPurpose && (
        <CameraModal
          title={cameraPurpose === 'status' ? 'Foto untuk Status 24 Jam' : 'Kirim Foto ke Obrolan'}
          onCapture={(dataUrl, caption, byteSize) => {
            if (cameraPurpose === 'chat' && activeContact) {
              dispatchMessage(activeContact.id, {
                type: 'image',
                mediaData: dataUrl,
                text: caption || undefined,
                fileName: `kamera-${Date.now()}.jpg`,
                fileSize: byteSize,
                mimeType: 'image/jpeg',
              });
            } else {
              handlePostImageStatus(dataUrl, caption);
              setActiveTab('status');
            }
            setCameraPurpose(null);
          }}
          onClose={() => setCameraPurpose(null)}
        />
      )}

      {(activeCallUI || incomingCall) && (
        <CallOverlay
          call={
            activeCallUI || {
              callId: incomingCall!.callId,
              peerId: incomingCall!.callerId,
              peerName: incomingCall!.callerName,
              peerAvatar: incomingCall!.callerAvatar,
              callType: incomingCall!.isVideo ? 'video' : 'audio',
              phase: 'incoming',
              duration: 0,
              isMuted: false,
              isCameraOff: !incomingCall!.isVideo,
              isSpeakerOn: true,
              localStream: null,
              remoteStream: null,
            }
          }
          forceFullscreenTick={incomingCallModalForceTick}
          onAccept={() => void handleAcceptCall(false)}
          onReject={() => handleRejectCall()}
          onEnd={handleEndCall}
          onToggleMute={handleToggleMute}
          onToggleCamera={handleToggleCamera}
          onSwitchCamera={handleSwitchCamera}
          onToggleSpeaker={handleToggleSpeaker}
          onRefreshAudio={handleRefreshCallAudio}
        />
      )}

      <MediaLightbox media={lightboxMedia} onClose={() => setLightboxMedia(null)} />

      {/* Reset Data Confirmation Dialog */}
      {showResetConfirm && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 backdrop-blur-xs p-4"
          onClick={() => setShowResetConfirm(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#233138] p-6 shadow-2xl border border-black/5 dark:border-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-[#111B21] dark:text-[#E9EDEF]">
              Reset Semua Data Lokal?
            </h3>
            <p className="mt-2 text-sm text-[#54656F] dark:text-[#AEBAC1] leading-relaxed">
              Seluruh profil, ID 6 digit, daftar kontak, riwayat chat, status, dan panggilan di perangkat ini akan dihapus permanen.
            </p>
            <div className="mt-6 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setShowResetConfirm(false)}
                className="h-10 px-4 rounded-xl bg-[#F0F2F5] dark:bg-[#111B21] text-sm font-semibold text-[#111B21] dark:text-[#E9EDEF] hover:bg-[#E4E7EB] cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirmReset}
                className="h-10 px-4 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold cursor-pointer"
              >
                Ya, Reset Data
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Subtle / Warning Toast Notification */}
      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[160] max-w-[calc(100vw-2rem)] sm:max-w-md px-4 py-2.5 rounded-xl text-xs font-medium text-center leading-relaxed shadow-xl border ${
            toastTone === 'warning'
              ? 'bg-[#0F2430]/95 text-amber-200 border-cyan-400/65 ring-1 ring-amber-400/35 shadow-[0_8px_28px_rgba(34,211,238,0.28)]'
              : 'bg-[#111B21]/95 dark:bg-[#233138] text-white border-white/10'
          }`}
        >
          {toast}
        </div>
      )}

      {/* Elemen audio panggilan WebRTC persisten agar suara remoteStream selalu terdengar jelas tanpa terputus */}
      <audio
        id="remoteAudio"
        ref={remoteCallAudioRef}
        autoPlay
        playsInline
        className="sr-only pointer-events-none"
      />
      {/* Elemen audio dering terlacak agar selalu dihentikan & di-reset sinkron oleh stopAllRingtones() */}
      <audio
        id="ringtoneAudio"
        ref={ringtoneAudioRef}
        preload="none"
        className="sr-only pointer-events-none"
      />

      <OfflineIndicator />
    </div>
  );
}
