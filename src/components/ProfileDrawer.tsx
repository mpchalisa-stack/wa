import React, { useRef, useState } from 'react';
import { ArrowLeft, Bell, Camera, Check, Copy, Pencil, QrCode, Share2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { UserProfile } from '../types';
import { PRESET_AVATARS, compressImageFile, formatSixDigitId } from '../lib/media';
import { getNtfyTopic } from '../lib/ntfy';
import { getNotificationPermissionState, requestNotificationPermission } from '../lib/standby';
import { Avatar } from './Avatar';
import { PWAInstallButton } from './PWAInstallButton';

interface ProfileDrawerProps {
  profile: UserProfile;
  onUpdateProfile: (updated: UserProfile) => void;
  onOpenShareApp: () => void;
  onClose: () => void;
  onToast: (msg: string) => void;
}

export const ProfileDrawer: React.FC<ProfileDrawerProps> = ({
  profile,
  onUpdateProfile,
  onOpenShareApp,
  onClose,
  onToast,
}) => {
  const [editingName, setEditingName] = useState(false);
  const [editingBio, setEditingBio] = useState(false);
  const [nameInput, setNameInput] = useState(profile.name);
  const [bioInput, setBioInput] = useState(profile.bio);
  const [copied, setCopied] = useState(false);
  const [copiedTopic, setCopiedTopic] = useState(false);
  const [notifPerm, setNotifPerm] = useState(() => getNotificationPermissionState());
  const [showLargeQR, setShowLargeQR] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ntfyTopic = getNtfyTopic(profile.id);

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await compressImageFile(file, 360, 0.84);
      onUpdateProfile({ ...profile, avatar: dataUrl });
      onToast('Foto profil diperbarui');
    } catch {
      onToast('Gagal memperbarui foto profil');
    }
  };

  const handleSaveName = () => {
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    onUpdateProfile({ ...profile, name: trimmed });
    setEditingName(false);
    onToast('Nama profil disimpan');
  };

  const handleSaveBio = () => {
    const trimmed = bioInput.trim() || 'Ada';
    onUpdateProfile({ ...profile, bio: trimmed });
    setEditingBio(false);
    onToast('Info profil disimpan');
  };

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(profile.id);
      setCopied(true);
      onToast(`ID ${profile.id} disalin ke papan klip`);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      onToast(`ID Anda: ${profile.id}`);
    }
  };

  const handleCopyNtfyTopic = async () => {
    try {
      await navigator.clipboard.writeText(ntfyTopic);
      setCopiedTopic(true);
      onToast(`Topik ntfy disalin: ${ntfyTopic}`);
      window.setTimeout(() => setCopiedTopic(false), 2000);
    } catch {
      onToast(`Topik ntfy Anda: ${ntfyTopic}`);
    }
  };

  const handleEnableBrowserNotifications = async () => {
    const res = await requestNotificationPermission();
    setNotifPerm(res);
    if (res === 'granted') {
      onToast('Notifikasi browser aktif');
    } else if (res === 'denied') {
      onToast('Izin notifikasi diblokir di pengaturan browser');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex bg-black/40 md:bg-black/30">
      <div className="w-full md:w-[420px] h-full bg-[#F0F2F5] dark:bg-[#111B21] flex flex-col shadow-2xl overflow-hidden">
        {/* WhatsApp Profile Top Header */}
        <div className="h-[60px] md:h-[108px] bg-[#008069] dark:bg-[#202C33] text-white flex items-end px-4 pb-3.5 shrink-0">
          <div className="flex items-center gap-4 w-full">
            <button
              type="button"
              onClick={onClose}
              className="w-10 h-10 -ml-2 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors cursor-pointer"
              aria-label="Kembali"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h2 className="text-lg font-semibold">Profil &amp; ID Saya</h2>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto wa-scroll pb-8">
          {/* Avatar Section */}
          <div className="py-7 flex flex-col items-center bg-white dark:bg-[#111B21]">
            <div className="relative">
              <Avatar src={profile.avatar} name={profile.name} size="2xl" />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="absolute bottom-0 right-0 w-11 h-11 rounded-full bg-[#00A884] hover:bg-[#008069] text-white flex items-center justify-center shadow-md ring-4 ring-white dark:ring-[#111B21] transition-colors cursor-pointer"
                aria-label="Ubah foto profil"
              >
                <Camera className="w-5 h-5" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handlePhotoUpload}
                className="hidden"
              />
            </div>

            <div className="mt-4 flex items-center gap-2">
              {PRESET_AVATARS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onUpdateProfile({ ...profile, avatar: preset.id })}
                  style={{ backgroundColor: preset.bg }}
                  className={`w-7 h-7 rounded-full flex items-center justify-center cursor-pointer transition-transform ${
                    profile.avatar === preset.id
                      ? 'ring-2 ring-offset-2 ring-[#00A884] dark:ring-offset-[#111B21] scale-110'
                      : 'opacity-80 hover:opacity-100'
                  }`}
                  aria-label={`Pilih warna ${preset.label}`}
                >
                  {profile.avatar === preset.id && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
                </button>
              ))}
            </div>
          </div>

          {/* 6-Digit Unique ID & Personal QR Code Card */}
          <div className="mt-3 bg-white dark:bg-[#111B21] px-6 py-5 border-y border-black/5 dark:border-white/5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-xs font-semibold text-[#008069] dark:text-[#00A884]">
                  ID Unik 6 Digit Anda
                </div>
                <div className="mt-1 font-mono-id text-3xl font-bold tracking-widest text-[#111B21] dark:text-[#E9EDEF]">
                  {formatSixDigitId(profile.id)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowLargeQR((prev) => !prev)}
                className="w-11 h-11 rounded-full bg-[#008069]/10 dark:bg-[#00A884]/15 text-[#008069] dark:text-[#00A884] flex items-center justify-center hover:bg-[#008069]/20 transition-colors cursor-pointer"
                title="Tampilkan QR Code"
              >
                <QrCode className="w-5 h-5" />
              </button>
            </div>

            <div className="flex items-center gap-2.5 mt-4">
              <button
                type="button"
                onClick={handleCopyId}
                className="flex-1 h-11 rounded-xl bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] text-white dark:text-[#111B21] text-sm font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span>{copied ? 'Tersalin!' : 'Salin ID'}</span>
              </button>
              <button
                type="button"
                onClick={onOpenShareApp}
                className="h-11 px-4 rounded-xl bg-[#F0F2F5] dark:bg-[#202C33] hover:bg-[#E4E7EB] dark:hover:bg-[#2A3942] text-[#111B21] dark:text-[#E9EDEF] text-sm font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <Share2 className="w-4 h-4" />
                <span>Bagikan Link</span>
              </button>
            </div>

            {/* Embedded QR Code */}
            <div className="mt-5 flex flex-col items-center rounded-2xl bg-[#F7F8FA] dark:bg-[#202C33] p-5">
              <div className="p-3 bg-white rounded-xl shadow-xs">
                <QRCodeSVG
                  value={`WA6:${profile.id}:${profile.name}`}
                  size={showLargeQR ? 220 : 164}
                  level="M"
                  fgColor="#111B21"
                  bgColor="#FFFFFF"
                />
              </div>
              <p className="mt-3 text-xs text-center text-[#54656F] dark:text-[#8696A0]">
                Pindai kode QR ini dari aplikasi WattappsAU teman untuk langsung terhubung tanpa mengetik.
              </p>
            </div>
          </div>

          {/* Name Section */}
          <div className="mt-3 bg-white dark:bg-[#111B21] px-6 py-4 border-y border-black/5 dark:border-white/5">
            <div className="text-xs font-semibold text-[#008069] dark:text-[#00A884] mb-2">
              Nama Anda
            </div>
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  maxLength={40}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
                  autoFocus
                  className="flex-1 bg-transparent border-b-2 border-[#00A884] py-1 text-base text-[#111B21] dark:text-[#E9EDEF] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleSaveName}
                  className="w-10 h-10 rounded-full flex items-center justify-center text-[#008069] dark:text-[#00A884] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
                >
                  <Check className="w-5 h-5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="text-base text-[#111B21] dark:text-[#E9EDEF] truncate">
                  {profile.name}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setNameInput(profile.name);
                    setEditingName(true);
                  }}
                  className="w-10 h-10 rounded-full flex items-center justify-center text-[#54656F] dark:text-[#8696A0] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
                  aria-label="Edit nama"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {/* Bio Section */}
          <div className="mt-3 bg-white dark:bg-[#111B21] px-6 py-4 border-y border-black/5 dark:border-white/5">
            <div className="text-xs font-semibold text-[#008069] dark:text-[#00A884] mb-2">
              Info / Bio
            </div>
            {editingBio ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  maxLength={100}
                  value={bioInput}
                  onChange={(e) => setBioInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveBio()}
                  autoFocus
                  className="flex-1 bg-transparent border-b-2 border-[#00A884] py-1 text-base text-[#111B21] dark:text-[#E9EDEF] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleSaveBio}
                  className="w-10 h-10 rounded-full flex items-center justify-center text-[#008069] dark:text-[#00A884] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
                >
                  <Check className="w-5 h-5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-[#3B4A54] dark:text-[#D1D7DB]">{profile.bio}</span>
                <button
                  type="button"
                  onClick={() => {
                    setBioInput(profile.bio);
                    setEditingBio(true);
                  }}
                  className="w-10 h-10 rounded-full flex items-center justify-center text-[#54656F] dark:text-[#8696A0] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
                  aria-label="Edit bio"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {/* Background Notification & ntfy Companion Section */}
          <div className="mt-3 bg-white dark:bg-[#111B21] px-6 py-5 border-y border-black/5 dark:border-white/5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-[#008069] dark:text-[#00A884] shrink-0" />
                <span className="text-xs font-semibold text-[#008069] dark:text-[#00A884]">
                  Notifikasi Latar Belakang &amp; Dering (ntfy)
                </span>
              </div>
              {notifPerm === 'granted' ? (
                <span className="text-[11px] font-semibold text-[#008069] dark:text-[#06CF9C]">
                  Izin Aktif
                </span>
              ) : notifPerm !== 'unsupported' ? (
                <button
                  type="button"
                  onClick={() => void handleEnableBrowserNotifications()}
                  className="text-[11px] font-semibold text-[#008069] dark:text-[#00A884] underline cursor-pointer"
                >
                  Izinkan Notifikasi
                </button>
              ) : null}
            </div>

            <p className="text-xs text-[#54656F] dark:text-[#8696A0] leading-relaxed">
              Agar HP tetap berdering keras saat ada panggilan/pesan masuk meski browser Chrome ditutup rapat 100%, pasang aplikasi gratis <strong className="text-[#111B21] dark:text-[#E9EDEF]">ntfy</strong> di Play Store lalu subscribe ke topik terenkripsi Anda:
            </p>

            <div className="flex items-center gap-2 rounded-xl bg-[#F0F2F5] dark:bg-[#202C33] px-3 py-2.5 border border-black/5 dark:border-white/10">
              <code className="flex-1 font-mono-id text-xs font-semibold text-[#111B21] dark:text-[#E9EDEF] truncate">
                {ntfyTopic}
              </code>
              <button
                type="button"
                onClick={handleCopyNtfyTopic}
                className="h-8 px-3 rounded-lg bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] text-white dark:text-[#111B21] text-xs font-semibold inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
              >
                {copiedTopic ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedTopic ? 'Disalin' : 'Salin Topik'}</span>
              </button>
            </div>

            <ol className="text-[11.5px] text-[#54656F] dark:text-[#8696A0] space-y-1 list-decimal list-inside">
              <li>Pasang aplikasi <strong className="text-[#111B21] dark:text-[#E9EDEF]">ntfy</strong> (gratis, tanpa login) dari Google Play Store.</li>
              <li>Tekan ikon <strong className="text-[#111B21] dark:text-[#E9EDEF]">+</strong> lalu tempel nama topik di atas dan aktifkan notifikasi prioritas tinggi.</li>
              <li>Sinyal dikirim terenkripsi AES-256-GCM saat perangkat Anda offline.</li>
            </ol>
          </div>

          {/* Share App & PWA Install Section */}
          <div className="px-6 mt-5 space-y-2.5">
            <button
              type="button"
              onClick={onOpenShareApp}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-white dark:bg-[#202C33] hover:bg-[#F5F6F6] dark:hover:bg-[#2A3942] border border-black/10 dark:border-white/10 text-[#111B21] dark:text-[#E9EDEF] font-semibold px-4 py-3 text-sm transition-colors cursor-pointer"
            >
              <Share2 className="w-4 h-4 text-[#008069] dark:text-[#00A884] shrink-0" />
              <span className="whitespace-nowrap">Bagikan Aplikasi (Barcode &amp; Link)</span>
            </button>
            <PWAInstallButton variant="button" />
          </div>
        </div>
      </div>

      {/* Clickable backdrop on desktop */}
      <div className="hidden md:block flex-1" onClick={onClose} />
    </div>
  );
};
