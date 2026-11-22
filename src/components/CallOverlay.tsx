import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
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
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
}

interface CallOverlayProps {
  call: ActiveCallUIState;
  onAccept: () => void;
  onReject: () => void;
  onEnd: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onSwitchCamera: () => void;
  onToggleSpeaker: () => void;
}

export const CallOverlay: React.FC<CallOverlayProps> = ({
  call,
  onAccept,
  onReject,
  onEnd,
  onToggleMute,
  onToggleCamera,
  onSwitchCamera,
  onToggleSpeaker,
}) => {
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [shakeStopped, setShakeStopped] = useState(false);
  const [minimizedBanner, setMinimizedBanner] = useState(false);
  const [logoImgFailed, setLogoImgFailed] = useState(false);

  // Reset animasi getar & mode banner setiap kali panggilan baru masuk atau fase berubah
  useEffect(() => {
    setShakeStopped(false);
    if (call.phase !== 'incoming') {
      setMinimizedBanner(false);
    }
  }, [call.callId, call.phase]);

  useEffect(() => {
    if (remoteVideoRef.current && call.remoteStream) {
      remoteVideoRef.current.srcObject = call.remoteStream;
      remoteVideoRef.current.muted = !call.isSpeakerOn;
      void remoteVideoRef.current.play().catch(() => {});
    }
    if (remoteAudioRef.current && call.remoteStream) {
      remoteAudioRef.current.srcObject = call.remoteStream;
      remoteAudioRef.current.muted = !call.isSpeakerOn;
      void remoteAudioRef.current.play().catch(() => {});
    }
  }, [call.remoteStream, call.isSpeakerOn]);

  useEffect(() => {
    if (localVideoRef.current && call.localStream) {
      localVideoRef.current.srcObject = call.localStream;
      void localVideoRef.current.play().catch(() => {});
    }
  }, [call.localStream, call.isCameraOff]);

  const isVideo = call.callType === 'video';
  const isIncomingRinging = call.phase === 'incoming' && !shakeStopped;
  const showRemoteVideo = isVideo && call.phase === 'connected' && Boolean(call.remoteStream);

  // Hentikan animasi getar & radar seketika saat tombol Angkat atau Tolak ditekan
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

  // Banner Notifikasi Mengambang di dalam aplikasi (saat panggilan masuk diperkecil)
  if (call.phase === 'incoming' && minimizedBanner) {
    return (
      <div className="fixed top-3 left-3 right-3 sm:left-1/2 sm:-translate-x-1/2 sm:max-w-md z-[130] select-none">
        <div
          onClick={() => setMinimizedBanner(false)}
          className="rounded-2xl bg-[#111B21]/95 backdrop-blur-md border border-[#38bdf8]/40 shadow-2xl px-3.5 py-3 flex items-center gap-3 text-white cursor-pointer"
        >
          {/* Logo WattappsAU bergetar + 2 gelombang radar cyan/hijau di banner mengambang */}
          <div className="relative w-12 h-12 flex items-center justify-center shrink-0">
            {isIncomingRinging && (
              <>
                <span
                  className="pointer-events-none absolute inset-0 rounded-full border-2 border-[#38bdf8] bg-[#38bdf8]/20"
                  style={{ animation: 'wa-radar-pulse 1.5s infinite ease-out' }}
                />
                <span
                  className="pointer-events-none absolute inset-0 rounded-full border-2 border-[#25D366] bg-[#25D366]/15"
                  style={{
                    animation: 'wa-radar-pulse 1.5s infinite ease-out',
                    animationDelay: '0.75s',
                  }}
                />
              </>
            )}
            <div
              className="relative z-10 w-10 h-10 rounded-full overflow-hidden shadow-md ring-2 ring-[#38bdf8]/70"
              style={
                isIncomingRinging
                  ? { animation: 'wa-ring-shake 1.1s infinite ease-in-out' }
                  : undefined
              }
            >
              {logoImgFailed ? (
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
            <div
              className="text-[11px] font-semibold text-[#38bdf8] truncate"
              style={
                isIncomingRinging
                  ? { animation: 'wa-text-pulse 1.2s infinite ease-in-out' }
                  : undefined
              }
            >
              {isVideo ? 'Panggilan Video Masuk...' : 'Panggilan Suara Masuk...'}
            </div>
            <div
              className="text-sm font-bold truncate"
              style={
                isIncomingRinging
                  ? { animation: 'wa-text-pulse 1.2s infinite ease-in-out' }
                  : undefined
              }
            >
              {call.peerName}
            </div>
            <div className="text-[11px] font-mono-id text-white/65 truncate">
              ID {formatSixDigitId(call.peerId)}
            </div>
          </div>

          <div
            className="flex items-center gap-2 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={handleRejectClick}
              className="w-10 h-10 rounded-full bg-rose-600 hover:bg-rose-500 text-white shadow-lg flex items-center justify-center active:scale-95 transition-transform cursor-pointer"
              aria-label="Tolak panggilan"
              title="Tolak"
            >
              <PhoneOff className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleAcceptClick}
              className={`w-10 h-10 rounded-full bg-[#25D366] hover:bg-[#1FD060] text-white shadow-lg flex items-center justify-center active:scale-95 transition-transform cursor-pointer ${
                isIncomingRinging ? 'animate-bounce' : ''
              }`}
              aria-label="Angkat panggilan"
              title="Angkat"
            >
              {isVideo ? <Video className="w-4 h-4" /> : <Phone className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[130] bg-[#0B141A] text-white flex flex-col justify-between overflow-hidden select-none">
      {/* Remote Audio Element (always active for voice/video audio playback) */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      {/* Background / Remote Full-Screen Video */}
      {showRemoteVideo ? (
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="absolute inset-0 w-full h-full object-cover bg-black"
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 50% 28%, #0F2B3D 0%, #0B141A 64%, #070E12 100%)',
          }}
        />
      )}

      {/* Subtle scrim for readability over video */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/75" />

      {/* Minimize to Floating Banner button during incoming call */}
      {call.phase === 'incoming' && (
        <button
          type="button"
          onClick={() => setMinimizedBanner(true)}
          className="absolute top-4 right-4 pt-safe z-30 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white/90 flex items-center justify-center transition-colors cursor-pointer"
          title="Perkecil ke banner mengambang"
          aria-label="Perkecil ke banner mengambang"
        >
          <ChevronDown className="w-5 h-5" />
        </button>
      )}

      {/* Top Caller Info */}
      <div className="relative z-10 pt-10 pt-safe px-6 flex flex-col items-center text-center">
        <div
          className="text-xs font-semibold text-[#38bdf8] tracking-wide mb-1"
          style={
            isIncomingRinging
              ? { animation: 'wa-text-pulse 1.2s infinite ease-in-out' }
              : undefined
          }
        >
          {call.phase === 'incoming'
            ? isVideo
              ? 'Panggilan Video Masuk...'
              : 'Panggilan Suara Masuk...'
            : call.phase === 'outgoing'
            ? 'Memanggil...'
            : isVideo
            ? 'Panggilan Video Terenkripsi P2P'
            : 'Panggilan Suara Terenkripsi P2P'}
        </div>

        <h2
          className="text-2xl sm:text-3xl font-bold tracking-tight"
          style={
            isIncomingRinging
              ? { animation: 'wa-text-pulse 1.2s infinite ease-in-out' }
              : undefined
          }
        >
          {call.peerName}
        </h2>
        <div className="mt-1 font-mono-id text-sm text-white/75">
          {call.phase === 'connected'
            ? formatDuration(call.duration)
            : `ID ${formatSixDigitId(call.peerId)}`}
        </div>
      </div>

      {/* Center Visual: Shaking WattappsAU Logo (96x96 / w-24 h-24) + Dual Cyan/Green Radar Waves for Incoming Call */}
      {!showRemoteVideo && (
        <div className="relative z-10 flex flex-col items-center justify-center my-auto px-6">
          {call.phase === 'incoming' ? (
            <div className="flex flex-col items-center gap-6">
              <div className="relative w-32 h-32 flex items-center justify-center">
                {/* 2 Lingkaran Gelombang Radar Cyan & Hijau di Belakang Logo */}
                {isIncomingRinging && (
                  <>
                    <span
                      className="pointer-events-none absolute inset-2 rounded-full border-2 border-[#38bdf8] bg-[#38bdf8]/20 shadow-[0_0_24px_rgba(56,189,248,0.35)]"
                      style={{ animation: 'wa-radar-pulse 1.5s infinite ease-out' }}
                    />
                    <span
                      className="pointer-events-none absolute inset-2 rounded-full border-2 border-[#25D366] bg-[#25D366]/15 shadow-[0_0_24px_rgba(37,211,102,0.3)]"
                      style={{
                        animation: 'wa-radar-pulse 1.5s infinite ease-out',
                        animationDelay: '0.75s',
                      }}
                    />
                  </>
                )}

                {/* Logo WattappsAU (/icon-512.png, w-24 h-24) Bergetar Kencang Kiri-Kanan */}
                {logoImgFailed ? (
                  <div
                    className="relative z-10 rounded-full ring-2 ring-[#38bdf8]/75 shadow-[0_0_32px_rgba(56,189,248,0.4)]"
                    style={
                      isIncomingRinging
                        ? { animation: 'wa-ring-shake 1.1s infinite ease-in-out' }
                        : undefined
                    }
                  >
                    <AppLogo size={96} />
                  </div>
                ) : (
                  <img
                    src="/icon-512.png"
                    alt="WattappsAU"
                    onError={() => setLogoImgFailed(true)}
                    className="relative z-10 w-24 h-24 rounded-full object-cover ring-2 ring-[#38bdf8]/75 shadow-[0_0_32px_rgba(56,189,248,0.4)]"
                    style={
                      isIncomingRinging
                        ? { animation: 'wa-ring-shake 1.1s infinite ease-in-out' }
                        : undefined
                    }
                  />
                )}
              </div>

              {/* Avatar & Identitas Penelpon Berdenyut di Bawah Logo */}
              <div
                className="inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full bg-white/10 border border-white/15 backdrop-blur-xs"
                style={
                  isIncomingRinging
                    ? { animation: 'wa-text-pulse 1.2s infinite ease-in-out' }
                    : undefined
                }
              >
                <div
                  style={
                    isIncomingRinging
                      ? { animation: 'wa-ring-shake 1.1s infinite ease-in-out' }
                      : undefined
                  }
                >
                  <Avatar src={call.peerAvatar} name={call.peerName} size="sm" />
                </div>
                <span className="text-xs font-medium text-white/90">
                  {isIncomingRinging
                    ? `${call.peerName} memanggil...`
                    : 'Menghubungkan...'}
                </span>
              </div>
            </div>
          ) : (
            <div className="relative">
              {call.phase !== 'connected' && (
                <span className="absolute -inset-4 rounded-full border-2 border-[#25D366]/40 animate-ping" />
              )}
              <div className="ring-4 ring-[#00A884]/40 rounded-full">
                <Avatar src={call.peerAvatar} name={call.peerName} size="2xl" />
              </div>
            </div>
          )}
        </div>
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
      <div className="relative z-20 px-6 pb-10 pb-safe">
        {call.phase === 'incoming' ? (
          <div className="max-w-xs mx-auto flex items-center justify-between">
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={handleRejectClick}
                className="w-16 h-16 rounded-full bg-rose-600 hover:bg-rose-500 text-white shadow-xl flex items-center justify-center active:scale-95 transition-transform cursor-pointer"
                aria-label="Tolak panggilan"
              >
                <PhoneOff className="w-7 h-7" />
              </button>
              <span className="text-xs font-medium text-white/80">Tolak</span>
            </div>

            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={handleAcceptClick}
                className={`w-16 h-16 rounded-full bg-[#25D366] hover:bg-[#1FD060] text-white shadow-[0_0_24px_rgba(37,211,102,0.5)] flex items-center justify-center active:scale-95 transition-transform cursor-pointer ${
                  isIncomingRinging ? 'animate-bounce' : ''
                }`}
                aria-label="Angkat panggilan"
              >
                {isVideo ? <Video className="w-7 h-7" /> : <Phone className="w-7 h-7" />}
              </button>
              <span className="text-xs font-semibold text-[#D9FDD3]">Angkat</span>
            </div>
          </div>
        ) : (
          <div className="max-w-md mx-auto bg-[#1F2C34]/90 backdrop-blur-md rounded-3xl px-4 py-4 flex items-center justify-around shadow-2xl border border-white/10">
            {/* Speaker */}
            <button
              type="button"
              onClick={onToggleSpeaker}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
                call.isSpeakerOn
                  ? 'bg-white text-[#111B21]'
                  : 'bg-white/10 text-white hover:bg-white/20'
              }`}
              title={call.isSpeakerOn ? 'Speaker Aktif' : 'Speaker Mati'}
            >
              {call.isSpeakerOn ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
            </button>

            {/* Camera Toggle */}
            {isVideo && (
              <button
                type="button"
                onClick={onToggleCamera}
                className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
                  call.isCameraOff
                    ? 'bg-white text-[#111B21]'
                    : 'bg-white/10 text-white hover:bg-white/20'
                }`}
                title={call.isCameraOff ? 'Nyalakan Kamera' : 'Matikan Kamera'}
              >
                {call.isCameraOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
              </button>
            )}

            {/* Switch Front/Back Camera */}
            {isVideo && (
              <button
                type="button"
                onClick={onSwitchCamera}
                className="w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer"
                title="Ganti Kamera Depan/Belakang"
              >
                <RefreshCw className="w-5 h-5" />
              </button>
            )}

            {/* Mute Mic */}
            <button
              type="button"
              onClick={onToggleMute}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
                call.isMuted
                  ? 'bg-white text-[#111B21]'
                  : 'bg-white/10 text-white hover:bg-white/20'
              }`}
              title={call.isMuted ? 'Nyalakan Mikrofon' : 'Bisukan Mikrofon'}
            >
              {call.isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>

            {/* End Call */}
            <button
              type="button"
              onClick={onEnd}
              className="w-14 h-12 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center shadow-lg active:scale-95 transition-transform cursor-pointer"
              title="Akhiri Panggilan"
            >
              <PhoneOff className="w-5 h-5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
