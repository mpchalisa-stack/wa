import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Pause, Play } from 'lucide-react';
import { formatDuration } from '../lib/media';
import { Avatar } from './Avatar';

interface VoiceNoteBubbleProps {
  audioSrc: string;
  duration?: number;
  isMine: boolean;
  senderName: string;
  senderAvatar?: string;
}

const WAVE_BARS = 28;

export const VoiceNoteBubble: React.FC<VoiceNoteBubbleProps> = ({
  audioSrc,
  duration = 0,
  isMine,
  senderName,
  senderAvatar,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(duration);
  const [rate, setRate] = useState<1 | 1.5 | 2>(1);

  // Deterministic pseudo-waveform heights for crisp WhatsApp look
  const barHeights = useMemo(() => {
    const heights: number[] = [];
    let seed = audioSrc.length;
    for (let i = 0; i < WAVE_BARS; i++) {
      seed = (seed * 9301 + 49297) % 233280;
      const normalized = seed / 233280;
      heights.push(24 + Math.round(normalized * 72));
    }
    return heights;
  }, [audioSrc]);

  useEffect(() => {
    const audio = new Audio(audioSrc);
    audioRef.current = audio;

    const onLoaded = () => {
      if (isFinite(audio.duration) && audio.duration > 0) {
        setTotalDuration(audio.duration);
      }
    };
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.pause();
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
    };
  }, [audioSrc]);

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.playbackRate = rate;
      try {
        await audio.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
      }
    }
  };

  const cycleRate = () => {
    const next: 1 | 1.5 | 2 = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
    if (audioRef.current) {
      audioRef.current.playbackRate = next;
    }
  };

  const handleSeek = (index: number) => {
    const audio = audioRef.current;
    if (!audio || !totalDuration) return;
    const ratio = index / WAVE_BARS;
    audio.currentTime = ratio * totalDuration;
    setCurrentTime(audio.currentTime);
  };

  const progress = totalDuration > 0 ? Math.min(1, currentTime / totalDuration) : 0;

  return (
    <div className="flex items-center gap-2.5 min-w-[230px] sm:min-w-[260px] py-0.5">
      {/* Play / Pause Button */}
      <button
        type="button"
        onClick={togglePlay}
        className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
          isMine
            ? 'text-[#54656F] dark:text-[#D1D7DB] hover:bg-black/5 dark:hover:bg-white/10'
            : 'text-[#54656F] dark:text-[#8696A0] hover:bg-black/5 dark:hover:bg-white/10'
        }`}
        aria-label={isPlaying ? 'Jeda pesan suara' : 'Putar pesan suara'}
      >
        {isPlaying ? (
          <Pause className="w-5 h-5 fill-current" />
        ) : (
          <Play className="w-5 h-5 fill-current ml-0.5" />
        )}
      </button>

      {/* Waveform Scrubber + Time */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-[2px] h-7 cursor-pointer">
          {barHeights.map((h, idx) => {
            const active = idx / WAVE_BARS <= progress;
            return (
              <button
                key={idx}
                type="button"
                onClick={() => handleSeek(idx)}
                style={{ height: `${Math.max(18, Math.round(h * 0.28))}px` }}
                className={`flex-1 rounded-full transition-colors ${
                  active
                    ? 'bg-[#53BDEB]'
                    : isMine
                    ? 'bg-[#8696A0]/55 dark:bg-white/35'
                    : 'bg-[#8696A0]/45 dark:bg-white/25'
                }`}
                aria-label={`Lompat ke ${Math.round((idx / WAVE_BARS) * 100)}%`}
              />
            );
          })}
        </div>
        <div className="mt-1 flex items-center justify-between text-[11px] text-[#667781] dark:text-[#AEBAC1] tabular-nums">
          <span>{formatDuration(isPlaying ? currentTime : totalDuration)}</span>
          {isPlaying && (
            <button
              type="button"
              onClick={cycleRate}
              className="px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/15 font-semibold text-[10px] text-[#111B21] dark:text-white cursor-pointer"
            >
              {rate}x
            </button>
          )}
        </div>
      </div>

      {/* Sender Avatar with Mic Badge */}
      <div className="relative shrink-0">
        <Avatar src={senderAvatar} name={senderName} size="sm" />
        <span className="absolute -bottom-0.5 -left-1 w-4 h-4 rounded-full bg-[#D9FDD3] dark:bg-[#005C4B] flex items-center justify-center">
          <Mic className="w-2.5 h-2.5 text-[#00A884] dark:text-[#53BDEB]" strokeWidth={2.6} />
        </span>
      </div>
    </div>
  );
};
