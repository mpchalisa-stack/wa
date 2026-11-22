import React, { useRef, useState } from 'react';
import { Camera, RefreshCw, ShieldCheck, ArrowRight, Check } from 'lucide-react';
import { UserProfile } from '../types';
import {
  PRESET_AVATARS,
  compressImageFile,
  formatSixDigitId,
  generateSixDigitId,
} from '../lib/media';
import { Avatar } from './Avatar';
import { AppLogo } from './AppLogo';

interface OnboardingScreenProps {
  onComplete: (profile: UserProfile) => void;
}

export const OnboardingScreen: React.FC<OnboardingScreenProps> = ({ onComplete }) => {
  const [sixDigitId, setSixDigitId] = useState<string>(() => generateSixDigitId());
  const [name, setName] = useState('');
  const [bio, setBio] = useState('Ada');
  const [avatar, setAvatar] = useState<string>(PRESET_AVATARS[0].id);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUploadPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await compressImageFile(file, 360, 0.84);
      setAvatar(dataUrl);
    } catch {
      setError('Gagal memuat foto profil. Coba gambar lain.');
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Masukkan nama tampilan Anda terlebih dahulu.');
      return;
    }
    onComplete({
      id: sixDigitId,
      name: trimmed,
      bio: bio.trim() || 'Ada',
      avatar,
      createdAt: Date.now(),
    });
  };

  return (
    <div className="min-h-dvh w-full flex flex-col bg-[#F0F2F5] dark:bg-[#0B141A] overflow-y-auto wa-scroll">
      {/* Classic WhatsApp Top Teal Banner */}
      <div className="h-44 sm:h-52 w-full bg-[#008069] dark:bg-[#1F2C34] shrink-0 relative flex items-start justify-center pt-8 px-4">
        <div className="w-full max-w-md flex items-center gap-3 text-white">
          <AppLogo size={44} className="shadow-md ring-2 ring-white/25" />
          <div>
            <h1 className="text-lg font-bold tracking-tight leading-tight">WattappsAU</h1>
            <p className="text-xs text-white/80">Komunikasi P2P Diskomlekau · Tanpa Nomor Telepon</p>
          </div>
        </div>
      </div>

      {/* Main Setup Card */}
      <div className="flex-1 flex items-start justify-center px-4 pb-10 -mt-24 sm:-mt-28 z-10">
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-md bg-white dark:bg-[#111B21] rounded-2xl shadow-xl border border-black/5 dark:border-white/10 p-6 sm:p-8"
        >
          <div className="text-center mb-6">
            <h2 className="text-xl font-bold text-[#111B21] dark:text-[#E9EDEF]">
              Info Profil Anda
            </h2>
            <p className="mt-1 text-sm text-[#54656F] dark:text-[#8696A0]">
              Masukkan nama dan foto profil untuk mulai terhubung lewat ID 6 digit.
            </p>
          </div>

          {/* Generated 6-Digit Unique ID Box */}
          <div className="mb-6 rounded-xl bg-[#F0F2F5] dark:bg-[#202C33] p-4 flex items-center justify-between gap-3">
            <div>
              <span className="block text-xs font-medium text-[#54656F] dark:text-[#8696A0]">
                ID Unik 6 Digit Anda
              </span>
              <span className="font-mono-id text-2xl font-bold tracking-wider text-[#008069] dark:text-[#00A884]">
                {formatSixDigitId(sixDigitId)}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setSixDigitId(generateSixDigitId())}
              className="min-h-[44px] px-3 rounded-xl bg-white dark:bg-[#2A3942] border border-black/5 dark:border-white/10 text-xs font-semibold text-[#111B21] dark:text-[#E9EDEF] hover:bg-[#F5F6F6] dark:hover:bg-[#32434D] flex items-center gap-1.5 transition-colors cursor-pointer"
              title="Acak ID 6 Digit baru"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Acak</span>
            </button>
          </div>

          {/* Avatar Picker & Photo Upload */}
          <div className="flex flex-col items-center mb-6">
            <div className="relative group">
              <Avatar src={avatar} name={name || 'WattappsAU'} size="2xl" />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="absolute bottom-0 right-0 w-10 h-10 rounded-full bg-[#00A884] hover:bg-[#008069] text-white flex items-center justify-center shadow-md ring-4 ring-white dark:ring-[#111B21] transition-colors cursor-pointer"
                aria-label="Unggah foto profil"
              >
                <Camera className="w-5 h-5" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleUploadPhoto}
                className="hidden"
              />
            </div>

            <div className="mt-4 flex items-center gap-2.5">
              {PRESET_AVATARS.map((preset) => {
                const selected = avatar === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setAvatar(preset.id)}
                    style={{ backgroundColor: preset.bg }}
                    className={`w-8 h-8 rounded-full flex items-center justify-center transition-transform cursor-pointer ${
                      selected
                        ? 'ring-2 ring-offset-2 ring-[#00A884] dark:ring-offset-[#111B21] scale-110'
                        : 'opacity-80 hover:opacity-100'
                    }`}
                    aria-label={`Warna avatar ${preset.label}`}
                  >
                    {selected && <Check className="w-4 h-4 text-white" strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Name & Bio Inputs */}
          <div className="space-y-4">
            <div>
              <label
                htmlFor="wa6-name"
                className="block text-xs font-semibold text-[#008069] dark:text-[#00A884] mb-1.5"
              >
                Nama Tampilan
              </label>
              <input
                id="wa6-name"
                type="text"
                maxLength={40}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError('');
                }}
                placeholder="Contoh: Budi Santoso"
                autoFocus
                className="w-full h-11 px-3.5 rounded-xl bg-[#F0F2F5] dark:bg-[#202C33] text-[#111B21] dark:text-[#E9EDEF] placeholder:text-[#667781] text-sm border border-transparent focus:border-[#00A884] focus:outline-none transition-colors"
              />
            </div>

            <div>
              <label
                htmlFor="wa6-bio"
                className="block text-xs font-semibold text-[#008069] dark:text-[#00A884] mb-1.5"
              >
                Info / Bio
              </label>
              <input
                id="wa6-bio"
                type="text"
                maxLength={100}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Ada"
                className="w-full h-11 px-3.5 rounded-xl bg-[#F0F2F5] dark:bg-[#202C33] text-[#111B21] dark:text-[#E9EDEF] placeholder:text-[#667781] text-sm border border-transparent focus:border-[#00A884] focus:outline-none transition-colors"
              />
            </div>
          </div>

          {error && (
            <p className="mt-3 text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>
          )}

          <button
            type="submit"
            className="mt-6 w-full h-12 rounded-xl bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] text-white dark:text-[#111B21] font-semibold text-sm flex items-center justify-center gap-2 shadow-sm transition-colors cursor-pointer"
          >
            <span>Lanjutkan ke WattappsAU</span>
            <ArrowRight className="w-4 h-4" />
          </button>

          <div className="mt-5 flex items-start gap-2.5 text-xs text-[#667781] dark:text-[#8696A0]">
            <ShieldCheck className="w-4 h-4 text-[#00A884] shrink-0 mt-0.5" />
            <p>
              Semua pesan, media, dan kontak disimpan secara lokal di perangkat ini dan dikirim langsung Peer-to-Peer via WebRTC tanpa server database.
            </p>
          </div>
        </form>
      </div>
    </div>
  );
};
