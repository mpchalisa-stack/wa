import React, { useEffect, useRef } from 'react';
import {
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
  const showRemoteVideo = isVideo && call.phase === 'connected' && Boolean(call.remoteStream);

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
              'radial-gradient(circle at 50% 25%, #123D34 0%, #0B141A 65%, #070E12 100%)',
          }}
        />
      )}

      {/* Subtle scrim for readability over video */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/75" />

      {/* Top Caller Info */}
      <div className="relative z-10 pt-10 pt-safe px-6 flex flex-col items-center text-center">
        <div className="text-xs font-medium text-[#25D366] tracking-wide mb-1">
          {call.phase === 'incoming'
            ? isVideo
              ? 'Panggilan Video WA6 Masuk'
              : 'Panggilan Suara WA6 Masuk'
            : call.phase === 'outgoing'
            ? 'Memanggil...'
            : isVideo
            ? 'Panggilan Video Terenkripsi P2P'
            : 'Panggilan Suara Terenkripsi P2P'}
        </div>

        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">{call.peerName}</h2>
        <div className="mt-1 font-mono-id text-sm text-white/75">
          {call.phase === 'connected'
            ? formatDuration(call.duration)
            : `ID ${formatSixDigitId(call.peerId)}`}
        </div>
      </div>

      {/* Center Avatar (shown during incoming, outgoing, or audio call) */}
      {!showRemoteVideo && (
        <div className="relative z-10 flex flex-col items-center justify-center my-auto">
          <div className="relative">
            {call.phase !== 'connected' && (
              <span className="absolute -inset-4 rounded-full border-2 border-[#25D366]/40 animate-ping" />
            )}
            <div className="ring-4 ring-[#00A884]/40 rounded-full">
              <Avatar src={call.peerAvatar} name={call.peerName} size="2xl" />
            </div>
          </div>
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
                onClick={onReject}
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
                onClick={onAccept}
                className="w-16 h-16 rounded-full bg-[#25D366] hover:bg-[#1FD060] text-white shadow-xl flex items-center justify-center active:scale-95 transition-transform cursor-pointer"
                aria-label="Terima panggilan"
              >
                {isVideo ? <Video className="w-7 h-7" /> : <Phone className="w-7 h-7" />}
              </button>
              <span className="text-xs font-medium text-white/80">Terima</span>
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
