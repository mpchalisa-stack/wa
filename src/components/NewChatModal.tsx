import React, { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, QrCode, UserPlus, X } from 'lucide-react';
import jsQR from 'jsqr';

interface NewChatModalProps {
  myId: string;
  onAddContact: (sixDigitId: string, nickname?: string) => void;
  onClose: () => void;
}

function parseScannedQR(raw: string): { id: string; name?: string } | null {
  const trimmed = raw.trim();
  // Format URL share link: "https://.../?add=482910&name=Budi"
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const url = new URL(trimmed);
      const addParam = url.searchParams.get('add')?.replace(/\D/g, '');
      if (addParam && addParam.length === 6) {
        return { id: addParam, name: url.searchParams.get('name')?.trim() || undefined };
      }
    }
  } catch {
    // ignore malformed URL
  }
  // Format "WA6:482910:Budi", "WattappsAU:482910:Budi", atau Barcode "WattappsAU-482910" / "WA6-482910"
  const appMatch = trimmed.match(/^(?:WA6|WattappsAU)[:\-](\d{6})(?::(.+))?$/i);
  if (appMatch) {
    return { id: appMatch[1], name: appMatch[2]?.trim() };
  }
  // Plain 6-digit number anywhere in string
  const digitsMatch = trimmed.match(/\b(\d{6})\b/);
  if (digitsMatch) {
    return { id: digitsMatch[1] };
  }
  return null;
}

export const NewChatModal: React.FC<NewChatModalProps> = ({
  myId,
  onAddContact,
  onClose,
}) => {
  const [mode, setMode] = useState<'manual' | 'scan'>('manual');
  const [peerId, setPeerId] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState('');
  const [cameraError, setCameraError] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const uploadQrRef = useRef<HTMLInputElement>(null);

  const stopCamera = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  useEffect(() => {
    if (mode !== 'scan') {
      stopCamera();
      return;
    }

    let cancelled = false;
    setCameraError('');

    const startScanner = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        const scanFrame = () => {
          if (cancelled) return;
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const code = jsQR(imgData.data, imgData.width, imgData.height);
              if (code && code.data) {
                const parsed = parseScannedQR(code.data);
                if (parsed) {
                  if (parsed.id === myId) {
                    setCameraError('Itu adalah kode QR milik Anda sendiri.');
                  } else {
                    stopCamera();
                    onAddContact(parsed.id, parsed.name);
                    return;
                  }
                }
              }
            }
          }
          rafRef.current = requestAnimationFrame(scanFrame);
        };
        rafRef.current = requestAnimationFrame(scanFrame);
      } catch {
        if (!cancelled) {
          setCameraError(
            'Kamera tidak dapat diakses. Berikan izin kamera atau unggah gambar kode QR dari galeri.'
          );
        }
      }
    };

    void startScanner();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [mode, myId, onAddContact]);

  const handleUploadQRImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) {
          const parsed = parseScannedQR(code.data);
          if (parsed) {
            if (parsed.id === myId) {
              setCameraError('Tidak dapat menambahkan ID milik Anda sendiri.');
            } else {
              onAddContact(parsed.id, parsed.name);
            }
            return;
          }
        }
        setCameraError('Kode QR WattappsAU tidak ditemukan pada gambar tersebut.');
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const digits = peerId.replace(/\D/g, '');
    if (digits.length !== 6) {
      setError('Masukkan tepat 6 digit angka ID teman Anda.');
      return;
    }
    if (digits === myId) {
      setError('Tidak dapat memulai chat dengan ID Anda sendiri.');
      return;
    }
    onAddContact(digits, nickname.trim() || undefined);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-xs p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white dark:bg-[#233138] shadow-2xl border border-black/5 dark:border-white/10 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-[#008069] dark:bg-[#1F2C34] text-white px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <UserPlus className="w-5 h-5" />
            <h2 className="text-base font-semibold">Chat Baru</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-white/10 cursor-pointer"
            aria-label="Tutup"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Tabs */}
        <div className="grid grid-cols-2 border-b border-black/10 dark:border-white/10 bg-[#F7F8FA] dark:bg-[#111B21]">
          <button
            type="button"
            onClick={() => setMode('manual')}
            className={`h-12 text-sm font-semibold flex items-center justify-center gap-2 border-b-2 transition-colors cursor-pointer ${
              mode === 'manual'
                ? 'border-[#008069] dark:border-[#00A884] text-[#008069] dark:text-[#00A884]'
                : 'border-transparent text-[#54656F] dark:text-[#8696A0]'
            }`}
          >
            <UserPlus className="w-4 h-4" />
            <span>Input ID 6 Digit</span>
          </button>
          <button
            type="button"
            onClick={() => setMode('scan')}
            className={`h-12 text-sm font-semibold flex items-center justify-center gap-2 border-b-2 transition-colors cursor-pointer ${
              mode === 'scan'
                ? 'border-[#008069] dark:border-[#00A884] text-[#008069] dark:text-[#00A884]'
                : 'border-transparent text-[#54656F] dark:text-[#8696A0]'
            }`}
          >
            <QrCode className="w-4 h-4" />
            <span>Pindai QR</span>
          </button>
        </div>

        {mode === 'manual' ? (
          <form onSubmit={handleManualSubmit} className="p-6 space-y-4">
            <div>
              <label
                htmlFor="peer-6digit"
                className="block text-xs font-semibold text-[#008069] dark:text-[#00A884] mb-1.5"
              >
                ID Unik 6 Digit Teman
              </label>
              <input
                id="peer-6digit"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={peerId}
                onChange={(e) => {
                  const clean = e.target.value.replace(/\D/g, '').slice(0, 6);
                  setPeerId(clean);
                  if (error) setError('');
                }}
                placeholder="Contoh: 482910"
                autoFocus
                className="w-full h-12 px-4 rounded-xl bg-[#F0F2F5] dark:bg-[#111B21] font-mono-id text-xl tracking-[0.25em] text-center font-bold text-[#111B21] dark:text-[#E9EDEF] placeholder:text-[#8696A0] placeholder:tracking-normal placeholder:font-sans placeholder:text-sm placeholder:font-normal border border-transparent focus:border-[#00A884] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="peer-nick"
                className="block text-xs font-semibold text-[#54656F] dark:text-[#8696A0] mb-1.5"
              >
                Nama Kontak (Opsional)
              </label>
              <input
                id="peer-nick"
                type="text"
                maxLength={40}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="Otomatis terisi saat terhubung"
                className="w-full h-11 px-3.5 rounded-xl bg-[#F0F2F5] dark:bg-[#111B21] text-sm text-[#111B21] dark:text-[#E9EDEF] placeholder:text-[#8696A0] border border-transparent focus:border-[#00A884] focus:outline-none"
              />
            </div>

            {error && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>}

            <button
              type="submit"
              className="w-full h-12 rounded-xl bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] text-white dark:text-[#111B21] text-sm font-semibold transition-colors cursor-pointer"
            >
              Mulai Obrolan
            </button>
          </form>
        ) : (
          <div className="p-5 flex flex-col items-center">
            <div className="relative w-full aspect-square max-w-[280px] rounded-2xl overflow-hidden bg-black flex items-center justify-center">
              <video
                ref={videoRef}
                playsInline
                muted
                className="w-full h-full object-cover"
              />
              <canvas ref={canvasRef} className="hidden" />
              {/* Scanner frame */}
              <div className="pointer-events-none absolute inset-6 border-2 border-[#25D366] rounded-xl shadow-[0_0_0_999px_rgba(0,0,0,0.45)]" />
              {cameraError && (
                <div className="absolute inset-0 bg-[#111B21]/95 flex flex-col items-center justify-center p-5 text-center">
                  <Camera className="w-8 h-8 text-[#8696A0] mb-2" />
                  <p className="text-xs text-[#D1D7DB] leading-relaxed">{cameraError}</p>
                </div>
              )}
            </div>

            <p className="mt-3 text-xs text-center text-[#54656F] dark:text-[#8696A0]">
              Arahkan kamera ke kode QR WattappsAU teman Anda untuk terhubung otomatis.
            </p>

            <button
              type="button"
              onClick={() => uploadQrRef.current?.click()}
              className="mt-4 w-full h-11 rounded-xl bg-[#F0F2F5] dark:bg-[#111B21] hover:bg-[#E4E7EB] dark:hover:bg-[#2A3942] text-sm font-semibold text-[#111B21] dark:text-[#E9EDEF] flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <ImagePlus className="w-4 h-4 text-[#008069] dark:text-[#00A884]" />
              <span>Unggah Gambar QR dari Galeri</span>
            </button>
            <input
              ref={uploadQrRef}
              type="file"
              accept="image/*"
              onChange={handleUploadQRImage}
              className="hidden"
            />
          </div>
        )}
      </div>
    </div>
  );
};
