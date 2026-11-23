import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Lock,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  RefreshCw,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { CallType } from '../types';
import { formatDuration, formatSixDigitId } from '../lib/media';
import { activateActiveMediaSession, releaseActiveMediaSession } from '../lib/standby';
import { Avatar } from './Avatar';
import { AppLogo } from './AppLogo';

export interface ActiveCallUIState {
  callId: string;
  peerId: string;
  peerName: string;
  peerAvatar: string;
  callType: CallType;
  phase: 'incoming' | 'outgoing' | 'connected';
  duration: number;
  isMuted: boolean;
  isCameraOff: boolean;
  isSpeakerOn: boolean;
  iceState?: string;
  connectionMode?: 'connecting' | 'direct' | 'relay' | 'reconnecting_relay';
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
}

interface CallOverlayProps {
  call: ActiveCallUIState;
  forceFullscreenTick?: number;
  onAccept: () => void;
  onReject: () => void;
  onEnd: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onSwitchCamera: () => void;
  onToggleSpeaker: () => void;
  onRefreshAudio?: () => void;
}

const WHATSAPP_DARK_PATTERN_SVG = `url("data:image/svg+xml,%3Csvg width='120' height='120' viewBox='0 0 120 120' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' stroke='%23ffffff' stroke-opacity='0.045' stroke-width='1.1'%3E%3Ccircle cx='24' cy='24' r='9'/%3E%3Cpath d='M78 16l10 6v12l-10 6-10-6V22z'/%3E%3Cpath d='M18 76h18v12H24l-6 5z'/%3E%3Cpath d='M76 78c4-5 12-5 16 0M80 84c2-2.5 6-2.5 8 0'/%3E%3Ccircle cx='84' cy='90' r='1.5' fill='%23ffffff' fill-opacity='0.06'/%3E%3Cpath d='M52 48l6 6-6 6-6-6z'/%3E%3C/g%3E%3C/svg%3E")`;

export const CallOverlay: React.FC<CallOverlayProps> = ({
  call,
  forceFullscreenTick = 0,
  onAccept,
  onReject,
  onEnd,
  onToggleMute,
  onToggleCamera,
  onSwitchCamera,
  onToggleSpeaker,
  onRefreshAudio,
}) => {
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [shakeStopped, setShakeStopped] = useState(false);
  const [minimizedBanner, setMinimizedBanner] = useState(false);
  const [logoImgFailed, setLogoImgFailed] = useState(false);
  const [avatarImgFailed, setAvatarImgFailed] = useState(false);
  const [micLevel, setMicLevel] = useState(0);

  // Reset animasi getar & paksa layar penuh setiap kali panggilan masuk baru / dipicu notifikasi
  useEffect(() => {
    setShakeStopped(false);
    setMinimizedBanner(false);
    setAvatarImgFailed(false);
  }, [call.callId, call.phase, call.peerAvatar, forceFullscreenTick]);

  // Kelola navigator.mediaSession secara terkontrol HANYA selama panggilan berlangsung
  useEffect(() => {
    const isVideoCall = call.callType === 'video';
    const statusText =
      call.phase === 'incoming'
        ? isVideoCall
          ? 'Panggilan Video Masuk'
          : 'Panggilan Suara Masuk'
        : call.phase === 'outgoing'
        ? isVideoCall
          ? 'Memanggil Video...'
          : 'Memanggil Suara...'
        : isVideoCall
        ? 'Panggilan Video Terenkripsi'
        : 'Panggilan Suara Terenkripsi';

    activateActiveMediaSession({
      mode: 'call',
      statusText,
      peerName: call.peerName,
      onEndOrPause: call.phase === 'incoming' ? onReject : onEnd,
    });
  }, [call.callId, call.phase, call.callType, call.peerName, onReject, onEnd]);

  // Pastikan seluruh elemen video & MediaSession dibersihkan penuh saat CallOverlay ditutup
  useEffect(() => {
    const remoteVid = remoteVideoRef.current;
    const localVid = localVideoRef.current;
    return () => {
      if (remoteVid) {
        remoteVid.pause();
        remoteVid.srcObject = null;
      }
      if (localVid) {
        localVid.pause();
        localVid.srcObject = null;
      }
      releaseActiveMediaSession('call');
    };
  }, []);

  useEffect(() => {
    if (remoteVideoRef.current && call.remoteStream) {
      remoteVideoRef.current.srcObject = call.remoteStream;
      // Audio ditangani oleh elemen <audio autoplay playsinline> persisten di root App.tsx agar bebas gema
      remoteVideoRef.current.muted = true;
      void remoteVideoRef.current.play().catch(() => {});
    }
  }, [call.remoteStream]);

  useEffect(() => {
    if (localVideoRef.current && call.localStream) {
      localVideoRef.current.srcObject = call.localStream;
      void localVideoRef.current.play().catch(() => {});
    }
  }, [call.localStream, call.isCameraOff]);

  // Meteran level suara mikrofon lokal real-time (hanya AnalyserNode, TIDAK disambungkan ke speaker agar bebas gema)
  useEffect(() => {
    if (call.phase === 'incoming' || !call.localStream || call.isMuted) {
      setMicLevel(0);
      return;
    }

    const audioTracks = call.localStream.getAudioTracks();
    if (audioTracks.length === 0 || !audioTracks.some((t) => t.readyState === 'live' && t.enabled)) {
      setMicLevel(0);
      return;
    }

    const AudioCtxCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtxCtor) return;

    let ctx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let rafId = 0;
    let disposed = false;

    try {
      ctx = new AudioCtxCtor();
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
      source = ctx.createMediaStreamSource(call.localStream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (disposed || !analyser) return;
        analyser.getByteTimeDomainData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i += 1) {
          const centered = (dataArray[i] - 128) / 128;
          sumSquares += centered * centered;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        // Skala sensitivitas suara manusia ke 0..100
        const normalized = Math.min(100, Math.round(rms * 380));
        setMicLevel(normalized);
        rafId = window.requestAnimationFrame(tick);
      };
      rafId = window.requestAnimationFrame(tick);
    } catch {
      setMicLevel(0);
    }

    return () => {
      disposed = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      try {
        source?.disconnect();
      } catch {
        // ignore
      }
      try {
        analyser?.disconnect();
      } catch {
        // ignore
      }
      if (ctx && ctx.state !== 'closed') {
        void ctx.close().catch(() => {});
      }
      setMicLevel(0);
    };
  }, [call.localStream, call.isMuted, call.phase]);

  const isVideo = call.callType === 'video';
  const isIncomingRinging = call.phase === 'incoming' && !shakeStopped;
  const showRemoteVideo = isVideo && call.phase === 'connected' && Boolean(call.remoteStream);
  const hasContactPhoto = Boolean(call.peerAvatar && !avatarImgFailed);

  // Hentikan animasi getar & radar seketika saat tombol Jawab atau Tolak ditekan
  const handleAcceptClick = () => {
    setShakeStopped(true);
    setMinimizedBanner(false);
    onAccept();
  };

  const handleRejectClick = () => {
    setShakeStopped(true);
    setMinimizedBanner(false);
    onReject();
  };

  // Banner Notifikasi Mengambang ala WhatsApp (saat panggilan masuk diperkecil)
  if (call.phase === 'incoming' && minimizedBanner) {
    return (
      <div className="fixed top-3 left-3 right-3 sm:left-1/2 sm:-translate-x-1/2 sm:max-w-md z-[130] select-none">
        <div
          onClick={() => setMinimizedBanner(false)}
          className="rounded-2xl bg-[#111b21]/95 backdrop-blur-md border border-emerald-500/35 shadow-2xl px-3.5 py-3 flex items-center gap-3 text-white cursor-pointer"
        >
          <div className="relative w-12 h-12 flex items-center justify-center shrink-0">
            {isIncomingRinging && (
              <>
                <span
                  className="pointer-events-none absolute inset-0 rounded-full border-2 border-[#10b981] bg-[#10b981]/20"
                  style={{ animation: 'wa-radar-pulse 1.5s infinite ease-out' }}
                />
                <span
                  className="pointer-events-none absolute inset-0 rounded-full border-2 border-[#10b981] bg-[#10b981]/15"
                  style={{
                    animation: 'wa-radar-pulse 1.5s infinite ease-out',
                    animationDelay: '0.75s',
                  }}
                />
              </>
            )}
            <div
              className="relative z-10 w-10 h-10 rounded-full overflow-hidden shadow-md ring-2 ring-emerald-400/70"
              style={
                isIncomingRinging
                  ? { animation: 'wa-ring-shake 0.9s infinite ease-in-out' }
                  : undefined
              }
            >
              {hasContactPhoto ? (
                <img
                  src={call.peerAvatar}
                  alt={call.peerName}
                  onError={() => setAvatarImgFailed(true)}
                  className="w-10 h-10 rounded-full object-cover"
                />
              ) : logoImgFailed ? (
                <AppLogo size={40} />
              ) : (
                <img
                  src="/icon-512.png"
                  alt="WattappsAU"
                  onError={() => setLogoImgFailed(true)}
                  className="w-10 h-10 rounded-full object-cover"
                />
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-white truncate">
              {call.peerName}
            </div>
            <div
              className="text-[11px] font-medium text-emerald-400 truncate"
              style={
                isIncomingRinging
                  ? { animation: 'wa-text-pulse 1.4s infinite ease-in-out' }
                  : undefined
              }
            >
              {isVideo ? 'Panggilan video WattappsAU...' : 'Panggilan suara WattappsAU...'}
            </div>
            <div className="text-[11px] font-mono text-slate-400 truncate">
              ID: {formatSixDigitId(call.peerId)}
            </div>
          </div>

          <div
            className="flex items-center gap-2 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={handleRejectClick}
              className="w-10 h-10 rounded-full bg-red-600 hover:bg-red-500 text-white shadow-lg flex items-center justify-center active:scale-95 transition-transform cursor-pointer"
              aria-label="Tolak panggilan"
              title="Tolak"
            >
              <PhoneOff className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleAcceptClick}
              className={`w-10 h-10 rounded-full bg-[#00a884] hover:bg-[#00c298] text-white shadow-lg flex items-center justify-center active:scale-95 transition-transform cursor-pointer ${
                isIncomingRinging ? 'animate-bounce' : ''
              }`}
              aria-label="Jawab panggilan"
              title="Jawab"
            >
              {isVideo ? <Video className="w-4 h-4" /> : <Phone className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[150] bg-[#0b141a] text-white flex flex-col justify-between overflow-hidden select-none">
      {/* Background / Remote Full-Screen Video */}
      {showRemoteVideo ? (
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute inset-0 w-full h-full object-cover bg-black"
        />
      ) : (
        <>
          {/* WhatsApp Dark Mode solid #0b141a base with subtle tactical chat pattern */}
          <div
            className="absolute inset-0 bg-[#0b141a]"
            style={{
              backgroundImage: WHATSAPP_DARK_PATTERN_SVG,
              backgroundRepeat: 'repeat',
            }}
          />
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(circle at 50% 42%, rgba(0, 168, 132, 0.14) 0%, rgba(11, 20, 26, 0.55) 55%, rgba(11, 20, 26, 0.92) 100%)',
            }}
          />
        </>
      )}

      {/* Subtle scrim for readability over video */}
      {showRemoteVideo && (
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/75" />
      )}

      {/* Minimize to Floating Banner button during incoming call */}
      {call.phase === 'incoming' && (
        <button
          type="button"
          onClick={() => setMinimizedBanner(true)}
          className="absolute top-4 right-4 pt-safe z-30 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-slate-200 flex items-center justify-center transition-colors cursor-pointer"
          title="Perkecil ke banner mengambang"
          aria-label="Perkecil ke banner mengambang"
        >
          <ChevronDown className="w-5 h-5" />
        </button>
      )}

      {call.phase === 'incoming' ? (
        /* Layar Panggilan Masuk Full-Screen Ala WhatsApp Dark Mode */
        <div className="relative z-10 flex-1 flex flex-col items-center justify-between px-6 pt-8 pt-safe pb-4 text-center">
          {/* Header Atas: Enkripsi End-to-End */}
          <div className="inline-flex items-center gap-1.5 text-xs text-slate-400 mt-1">
            <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span>Terenkripsi secara end-to-end (AES-256)</span>
          </div>

          {/* Identitas Penelepon di Tengah Atas */}
          <div className="mt-6 flex flex-col items-center max-w-full">
            <h2 className="text-3xl font-semibold text-white tracking-tight max-w-full truncate px-2">
              {call.peerName}
            </h2>
            <p
              className="mt-2 text-sm sm:text-base text-slate-300 font-normal"
              style={
                isIncomingRinging
                  ? { animation: 'wa-text-pulse 1.4s infinite ease-in-out' }
                  : undefined
              }
            >
              {isIncomingRinging
                ? isVideo
                  ? 'Panggilan video WattappsAU...'
                  : 'Panggilan suara WattappsAU...'
                : 'Menghubungkan...'}
            </p>
            <div className="mt-1.5 font-mono text-emerald-400 text-sm tracking-wider">
              ID: {formatSixDigitId(call.peerId)}
            </div>
          </div>

          {/* Avatar Kontak / Logo WattappsAU di Tengah Layar dengan 2 Radar Hijau Zamrud & Efek Getar */}
          <div className="relative w-48 h-48 flex items-center justify-center my-auto">
            {isIncomingRinging && (
              <>
                <span
                  className="pointer-events-none absolute w-32 h-32 rounded-full border-2 border-[#10b981] bg-[#10b981]/20 shadow-[0_0_28px_rgba(16,185,129,0.4)]"
                  style={{ animation: 'wa-radar-pulse 1.5s infinite ease-out' }}
                />
                <span
                  className="pointer-events-none absolute w-32 h-32 rounded-full border-2 border-[#10b981] bg-[#10b981]/15 shadow-[0_0_24px_rgba(16,185,129,0.3)]"
                  style={{
                    animation: 'wa-radar-pulse 1.5s infinite ease-out',
                    animationDelay: '0.75s',
                  }}
                />
              </>
            )}

            <div
              className="relative z-10 w-32 h-32 rounded-full overflow-hidden ring-2 ring-[#10b981]/80 bg-[#111b21] shadow-[0_0_36px_rgba(16,185,129,0.35)] flex items-center justify-center"
              style={
                isIncomingRinging
                  ? { animation: 'wa-ring-shake 0.9s infinite ease-in-out' }
                  : undefined
              }
            >
              {hasContactPhoto ? (
                <img
                  src={call.peerAvatar}
                  alt={call.peerName}
                  onError={() => setAvatarImgFailed(true)}
                  className="w-32 h-32 rounded-full object-cover"
                />
              ) : logoImgFailed ? (
                <AppLogo size={128} />
              ) : (
                <img
                  src="/icon-512.png"
                  alt="WattappsAU"
                  onError={() => setLogoImgFailed(true)}
                  className="w-32 h-32 rounded-full object-cover"
                />
              )}
            </div>
          </div>

          <div className="h-4" />
        </div>
      ) : (
        <>
          {/* Top Caller Info (Outgoing / Connected) */}
          <div className="relative z-10 pt-8 pt-safe px-6 flex flex-col items-center text-center">
            <div className="inline-flex items-center gap-1.5 text-xs text-slate-400 mb-3">
              <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span>Terenkripsi secara end-to-end (AES-256)</span>
            </div>

            <h2 className="text-3xl font-semibold text-white tracking-tight">
              {call.peerName}
            </h2>
            <div className="mt-1.5 text-sm text-slate-300">
              {call.phase === 'outgoing'
                ? isVideo
                  ? 'Memanggil video...'
                  : 'Memanggil...'
                : formatDuration(call.duration)}
            </div>
            {call.phase !== 'connected' && (
              <div className="mt-1 font-mono text-sm text-emerald-400">
                ID: {formatSixDigitId(call.peerId)}
              </div>
            )}
            {/* Panel Diagnostik Real-Time: Status ICE & Meteran Level Mikrofon Lokal */}
            <div className="mt-2.5 flex flex-col items-center gap-2">
              <div className="inline-flex items-center gap-2 rounded-full bg-white/10 border border-white/15 px-3 py-1 text-[11px] font-mono tracking-wide text-slate-100">
                <span
                  className={`w-2 h-2 rounded-full ${
                    call.iceState === 'connected' || call.iceState === 'completed'
                      ? 'bg-emerald-400'
                      : call.iceState === 'failed' || call.iceState === 'disconnected'
                      ? 'bg-rose-400'
                      : 'bg-sky-400 animate-pulse'
                  }`}
                />
                <span>ICE: {call.iceState || 'checking'}</span>
                {call.connectionMode === 'direct' && (
                  <span className="text-emerald-300 font-sans font-medium">· P2P</span>
                )}
              </div>

              <div
                className="inline-flex items-center gap-2 rounded-full bg-black/35 border border-white/10 px-3 py-1.5 backdrop-blur-xs"
                aria-label="Level suara mikrofon lokal"
              >
                {call.isMuted ? (
                  <MicOff className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                ) : (
                  <Mic
                    className={`w-3.5 h-3.5 shrink-0 transition-colors ${
                      micLevel > 8 ? 'text-emerald-400' : 'text-slate-300'
                    }`}
                  />
                )}
                <div className="flex items-end gap-[3px] h-3.5">
                  {[12, 22, 34, 46, 58, 70, 82, 92].map((threshold, idx) => {
                    const active = !call.isMuted && micLevel >= threshold;
                    const barHeight = `${38 + idx * 8}%`;
                    return (
                      <span
                        key={threshold}
                        style={{ height: barHeight }}
                        className={`w-1 rounded-full transition-colors duration-75 ${
                          active
                            ? idx >= 6
                              ? 'bg-amber-400'
                              : 'bg-emerald-400'
                            : 'bg-white/20'
                        }`}
                      />
                    );
                  })}
                </div>
                <span className="text-[10px] font-medium text-slate-300 min-w-[46px] text-left">
                  {call.isMuted
                    ? 'Bisukan'
                    : call.localStream
                    ? micLevel > 8
                      ? 'Aktif'
                      : 'Siap'
                    : 'No Mic'}
                </span>
              </div>
            </div>
          </div>

          {!showRemoteVideo && (
            <div className="relative z-10 flex flex-col items-center justify-center my-auto px-6">
              <div className="relative">
                {call.phase !== 'connected' && (
                  <span className="absolute -inset-4 rounded-full border-2 border-[#10b981]/40 animate-ping" />
                )}
                <div className="ring-4 ring-[#00a884]/40 rounded-full">
                  <Avatar src={call.peerAvatar} name={call.peerName} size="2xl" />
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Local PiP Self Video (Corner Overlay) */}
      {isVideo && call.localStream && !call.isCameraOff && call.phase !== 'incoming' && (
        <div className="absolute top-28 right-4 z-20 w-28 h-40 sm:w-36 sm:h-52 rounded-2xl overflow-hidden shadow-2xl border-2 border-white/25 bg-black">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover scale-x-[-1]"
          />
        </div>
      )}

      {/* Bottom Controls */}
      <div className="relative z-20 px-8 pb-12 pb-safe">
        {call.phase === 'incoming' ? (
          <div className="max-w-xs mx-auto flex items-center justify-between">
            <div className="flex flex-col items-center gap-2.5">
              <button
                type="button"
                onClick={handleRejectClick}
                className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-500 text-white shadow-lg flex items-center justify-center active:scale-95 transition-transform cursor-pointer"
                aria-label="Tolak panggilan"
              >
                <PhoneOff className="w-7 h-7" />
              </button>
              <span className="text-sm font-medium text-slate-200">Tolak</span>
            </div>

            <div className="flex flex-col items-center gap-2.5">
              <button
                type="button"
                onClick={handleAcceptClick}
                className={`w-16 h-16 rounded-full bg-[#00a884] hover:bg-[#00c298] text-white shadow-lg shadow-[#00a884]/40 flex items-center justify-center active:scale-95 transition-transform cursor-pointer ${
                  isIncomingRinging ? 'animate-bounce' : ''
                }`}
                aria-label="Jawab panggilan"
              >
                {isVideo ? <Video className="w-7 h-7" /> : <Phone className="w-7 h-7" />}
              </button>
              <span className="text-sm font-semibold text-emerald-300">Jawab</span>
            </div>
          </div>
        ) : (
          <div className="max-w-md mx-auto flex flex-col items-center gap-3">
            {onRefreshAudio && (
              <button
                type="button"
                onClick={onRefreshAudio}
                className="inline-flex items-center gap-2 rounded-full bg-[#1F2C34]/90 hover:bg-[#2A3942] active:scale-95 border border-emerald-400/35 px-4 py-2 text-xs font-semibold text-emerald-200 shadow-lg backdrop-blur-md transition-all cursor-pointer"
                aria-label="Refresh Audio atau Speaker"
                title="Segarkan pemutaran suara, speaker, dan jalur ICE panggilan"
              >
                <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
                <span>Refresh Audio / Speaker</span>
              </button>
            )}
            <div className="w-full bg-[#1F2C34]/90 backdrop-blur-md rounded-3xl px-4 py-3.5 flex items-center justify-around shadow-2xl border border-white/10">
            {/* Speaker */}
            <div className="flex flex-col items-center gap-1">
              <button
                type="button"
                onClick={onToggleSpeaker}
                className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
                  call.isSpeakerOn
                    ? 'bg-white text-[#111B21]'
                    : 'bg-white/10 text-white hover:bg-white/20'
                }`}
                aria-label={call.isSpeakerOn ? 'Speaker Aktif' : 'Speaker Mati'}
                title={call.isSpeakerOn ? 'Speaker Aktif' : 'Speaker Mati'}
              >
                {call.isSpeakerOn ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
              </button>
              <span className="text-[11px] font-medium text-slate-200">Speaker</span>
            </div>

            {/* Camera Toggle */}
            {isVideo && (
              <div className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  onClick={onToggleCamera}
                  className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
                    call.isCameraOff
                      ? 'bg-white text-[#111B21]'
                      : 'bg-white/10 text-white hover:bg-white/20'
                  }`}
                  aria-label={call.isCameraOff ? 'Nyalakan Kamera' : 'Matikan Kamera'}
                  title={call.isCameraOff ? 'Nyalakan Kamera' : 'Matikan Kamera'}
                >
                  {call.isCameraOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
                </button>
                <span className="text-[11px] font-medium text-slate-200">Kamera</span>
              </div>
            )}

            {/* Switch Front/Back Camera */}
            {isVideo && (
              <div className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  onClick={onSwitchCamera}
                  className="w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer"
                  aria-label="Ganti Kamera Depan/Belakang"
                  title="Ganti Kamera Depan/Belakang"
                >
                  <RefreshCw className="w-5 h-5" />
                </button>
                <span className="text-[11px] font-medium text-slate-200">Putar</span>
              </div>
            )}

            {/* Mute Mic */}
            <div className="flex flex-col items-center gap-1">
              <button
                type="button"
                onClick={onToggleMute}
                className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
                  call.isMuted
                    ? 'bg-white text-[#111B21]'
                    : 'bg-white/10 text-white hover:bg-white/20'
                }`}
                aria-label={call.isMuted ? 'Nyalakan Mikrofon' : 'Bisukan Mikrofon'}
                title={call.isMuted ? 'Nyalakan Mikrofon' : 'Bisukan Mikrofon'}
              >
                {call.isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
              </button>
              <span className="text-[11px] font-medium text-slate-200">Mikrofon</span>
            </div>

            {/* End Call */}
            <div className="flex flex-col items-center gap-1">
              <button
                type="button"
                onClick={onEnd}
                className="w-14 h-12 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center shadow-lg active:scale-95 transition-transform cursor-pointer"
                aria-label="Akhiri Panggilan"
                title="Akhiri Panggilan"
              >
                <PhoneOff className="w-5 h-5" />
              </button>
              <span className="text-[11px] font-medium text-rose-300">Akhiri</span>
            </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
