import React from 'react';
import { Users } from 'lucide-react';
import { PRESET_AVATARS } from '../lib/media';

interface AvatarProps {
  src?: string;
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  isGroup?: boolean;
  isOnline?: boolean;
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<AvatarProps['size']>, string> = {
  xs: 'w-7 h-7 text-xs',
  sm: 'w-9 h-9 text-xs',
  md: 'w-11 h-11 text-sm',
  lg: 'w-12 h-12 text-base',
  xl: 'w-20 h-20 text-2xl',
  '2xl': 'w-28 h-28 text-3xl',
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export const Avatar: React.FC<AvatarProps> = ({
  src,
  name,
  size = 'md',
  isGroup = false,
  isOnline = false,
  className = '',
}) => {
  const sizeClass = SIZE_CLASSES[size];
  const isImage = Boolean(src && (src.startsWith('data:image') || src.startsWith('http') || src.startsWith('/')));
  const preset = PRESET_AVATARS.find((p) => p.id === src);

  // Deterministic color from name if no preset or image
  let fallbackBg = '#008069';
  if (preset) {
    fallbackBg = preset.bg;
  } else {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    fallbackBg = PRESET_AVATARS[Math.abs(hash) % PRESET_AVATARS.length].bg;
  }

  return (
    <div className={`relative shrink-0 inline-flex items-center justify-center ${className}`}>
      {isImage ? (
        <img
          src={src}
          alt={name}
          referrerPolicy="no-referrer"
          className={`${sizeClass} rounded-full object-cover bg-[#DFE5E7] dark:bg-[#2A3942] select-none`}
        />
      ) : (
        <div
          style={{ backgroundColor: fallbackBg }}
          className={`${sizeClass} rounded-full flex items-center justify-center font-semibold text-white select-none`}
        >
          {isGroup ? (
            <Users className="w-1/2 h-1/2" strokeWidth={2.2} />
          ) : (
            <span>{getInitials(name)}</span>
          )}
        </div>
      )}

      {isOnline && (
        <span
          title="Online"
          className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-[#25D366] ring-2 ring-white dark:ring-[#111B21]"
        />
      )}
    </div>
  );
};
