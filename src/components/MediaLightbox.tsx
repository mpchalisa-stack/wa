import React from 'react';
import { Download, X } from 'lucide-react';
import { formatTime, triggerDownload } from '../lib/media';

export interface LightboxMedia {
  type: 'image' | 'video';
  src: string;
  senderName: string;
  timestamp: number;
  caption?: string;
  fileName?: string;
}

interface MediaLightboxProps {
  media: LightboxMedia | null;
  onClose: () => void;
}

export const MediaLightbox: React.FC<MediaLightboxProps> = ({ media, onClose }) => {
  if (!media) return null;

  return (
    <div
      className="fixed inset-0 z-[120] bg-black/95 flex flex-col"
      onClick={onClose}
    >
      {/* Top Bar */}
      <div
        className="flex items-center justify-between px-4 py-3 bg-black/50 text-white shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{media.senderName}</div>
          <div className="text-xs text-white/70 tabular-nums">{formatTime(media.timestamp)}</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() =>
              triggerDownload(
                media.src,
                media.fileName || `WA6-${media.timestamp}.${media.type === 'video' ? 'mp4' : 'jpg'}`
              )
            }
            className="w-11 h-11 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors cursor-pointer"
            title="Unduh"
          >
            <Download className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="w-11 h-11 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors cursor-pointer"
            title="Tutup"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div
        className="flex-1 flex items-center justify-center p-4 overflow-hidden"
        onClick={onClose}
      >
        {media.type === 'image' ? (
          <img
            src={media.src}
            alt={media.caption || 'Pratinjau gambar'}
            referrerPolicy="no-referrer"
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded-lg select-none"
          />
        ) : (
          <video
            src={media.src}
            controls
            autoPlay
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full rounded-lg"
          />
        )}
      </div>

      {media.caption && (
        <div
          className="px-6 py-4 text-center text-sm text-white bg-black/60 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          {media.caption}
        </div>
      )}
    </div>
  );
};
