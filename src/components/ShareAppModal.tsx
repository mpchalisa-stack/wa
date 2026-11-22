import React, { useMemo, useRef, useState } from 'react';
import {
  Barcode,
  Check,
  Copy,
  Download,
  Link2,
  QrCode,
  Share2,
  X,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { UserProfile } from '../types';
import { downloadSvgAsPng, encodeCode128B } from '../lib/barcode';
import { formatSixDigitId } from '../lib/media';
import { AppLogo } from './AppLogo';

interface ShareAppModalProps {
  profile: UserProfile;
  onClose: () => void;
  onToast: (msg: string) => void;
}

export const ShareAppModal: React.FC<ShareAppModalProps> = ({
  profile,
  onClose,
  onToast,
}) => {
  const [codeTab, setCodeTab] = useState<'qr' | 'barcode'>('qr');
  const [includeMyId, setIncludeMyId] = useState(true);
  const [copiedLink, setCopiedLink] = useState(false);

  const qrWrapperRef = useRef<HTMLDivElement>(null);
  const barcodeSvgRef = useRef<SVGSVGElement>(null);

  const shareUrl = useMemo(() => {
    const base =
      typeof window !== 'undefined'
        ? `${window.location.origin}${window.location.pathname}`
        : 'https://wattappsau.app/';
    if (!includeMyId) return base;
    const params = new URLSearchParams({
      add: profile.id,
      name: profile.name,
    });
    return `${base}?${params.toString()}`;
  }, [includeMyId, profile.id, profile.name]);

  // Code 128B payload: concise & universally scannable by 1D barcode scanners
  const barcodeValue = useMemo(
    () => (includeMyId ? `WattappsAU-${profile.id}` : 'WattappsAU'),
    [includeMyId, profile.id]
  );

  const barcodeBits = useMemo(() => encodeCode128B(barcodeValue), [barcodeValue]);

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedLink(true);
      onToast('Tautan aplikasi berhasil disalin');
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      onToast('Gagal menyalin otomatis. Salin tautan secara manual.');
    }
  };

  const handleNativeShare = async () => {
    const shareText = includeMyId
      ? `Yuk ngobrol & telepon gratis di WattappsAU tanpa nomor HP! Klik tautan ini untuk langsung terhubung dengan saya (${profile.name} · ID ${formatSixDigitId(profile.id)}):`
      : 'Yuk coba WattappsAU — aplikasi chat & panggilan P2P tanpa nomor HP dan tanpa database!';

    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({
          title: 'WattappsAU — Pesan & Panggilan P2P',
          text: shareText,
          url: shareUrl,
        });
        return;
      } catch (err) {
        // User cancelled native share sheet
        if ((err as { name?: string })?.name === 'AbortError') return;
      }
    }

    // Fallback: copy full invite message + link
    try {
      await navigator.clipboard.writeText(`${shareText}\n${shareUrl}`);
      setCopiedLink(true);
      onToast('Pesan & tautan undangan disalin ke papan klip');
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      onToast('Salin tautan di kolom bawah untuk membagikan aplikasi.');
    }
  };

  const handleDownloadCode = async () => {
    if (codeTab === 'qr') {
      const svg = qrWrapperRef.current?.querySelector('svg') as SVGSVGElement | null;
      const ok = await downloadSvgAsPng(
        svg,
        `WattappsAU-QR-${includeMyId ? profile.id : 'App'}.png`,
        includeMyId ? `WattappsAU · ${profile.name}` : 'Bagikan Aplikasi WattappsAU',
        includeMyId ? `ID: ${formatSixDigitId(profile.id)}` : shareUrl.replace(/^https?:\/\//, '')
      );
      onToast(ok ? 'Gambar QR Code berhasil diunduh' : 'Gagal mengunduh QR Code');
    } else {
      const ok = await downloadSvgAsPng(
        barcodeSvgRef.current,
        `WattappsAU-Barcode-${barcodeValue}.png`,
        includeMyId ? `WattappsAU · ${profile.name}` : 'WattappsAU',
        barcodeValue
      );
      onToast(ok ? 'Gambar Barcode berhasil diunduh' : 'Gagal mengunduh Barcode');
    }
  };

  // Compute compact SVG bar rectangles for crisp rendering
  const barRects = useMemo(() => {
    const rects: Array<{ x: number; w: number }> = [];
    let i = 0;
    while (i < barcodeBits.length) {
      if (barcodeBits[i] === '1') {
        const start = i;
        while (i < barcodeBits.length && barcodeBits[i] === '1') i++;
        rects.push({ x: start, w: i - start });
      } else {
        i++;
      }
    }
    return rects;
  }, [barcodeBits]);

  const quietZone = 10;
  const totalModules = barcodeBits.length + quietZone * 2;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-xs p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[92dvh] flex flex-col rounded-2xl bg-white dark:bg-[#233138] shadow-2xl border border-black/5 dark:border-white/10 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-[#008069] dark:bg-[#1F2C34] text-white px-5 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <AppLogo size={38} className="shadow-sm ring-1 ring-white/25" />
            <div>
              <h2 className="text-base font-semibold leading-tight">Bagikan WattappsAU</h2>
              <p className="text-xs text-white/75">Undang teman via Barcode, QR, atau Tautan</p>
            </div>
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

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto wa-scroll p-5 space-y-5">
          {/* Segmented Switch: QR Code vs 1D Barcode */}
          <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-[#F0F2F5] dark:bg-[#111B21]">
            <button
              type="button"
              onClick={() => setCodeTab('qr')}
              className={`h-10 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer whitespace-nowrap ${
                codeTab === 'qr'
                  ? 'bg-white dark:bg-[#2A3942] text-[#008069] dark:text-[#00A884] shadow-xs'
                  : 'text-[#54656F] dark:text-[#8696A0] hover:text-[#111B21] dark:hover:text-white'
              }`}
            >
              <QrCode className="w-4 h-4 shrink-0" />
              <span>QR Code Link</span>
            </button>
            <button
              type="button"
              onClick={() => setCodeTab('barcode')}
              className={`h-10 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer whitespace-nowrap ${
                codeTab === 'barcode'
                  ? 'bg-white dark:bg-[#2A3942] text-[#008069] dark:text-[#00A884] shadow-xs'
                  : 'text-[#54656F] dark:text-[#8696A0] hover:text-[#111B21] dark:hover:text-white'
              }`}
            >
              <Barcode className="w-4 h-4 shrink-0" />
              <span>Barcode 1D</span>
            </button>
          </div>

          {/* Code Display Card */}
          <div className="rounded-2xl bg-[#F7F8FA] dark:bg-[#111B21] border border-black/5 dark:border-white/5 p-5 flex flex-col items-center">
            <div className="flex items-center gap-2 mb-3.5">
              <AppLogo size={26} />
              <span className="text-xs font-bold tracking-tight text-[#111B21] dark:text-[#E9EDEF]">
                WattappsAU · Diskomlekau
              </span>
            </div>

            {codeTab === 'qr' ? (
              <>
                <div
                  ref={qrWrapperRef}
                  className="p-3.5 bg-white rounded-2xl shadow-xs"
                >
                  <QRCodeSVG
                    value={shareUrl}
                    size={196}
                    level="M"
                    fgColor="#111B21"
                    bgColor="#FFFFFF"
                  />
                </div>
                <p className="mt-3 text-xs text-center text-[#54656F] dark:text-[#8696A0] max-w-xs leading-relaxed">
                  {includeMyId
                    ? `Pindai QR ini dengan kamera HP atau WattappsAU untuk membuka aplikasi dan langsung terhubung ke ID ${formatSixDigitId(profile.id)}.`
                    : 'Pindai QR ini dengan kamera HP untuk langsung membuka halaman aplikasi WattappsAU.'}
                </p>
              </>
            ) : (
              <>
                <div className="w-full p-4 bg-white rounded-2xl shadow-xs flex flex-col items-center">
                  <svg
                    ref={barcodeSvgRef}
                    viewBox={`0 0 ${totalModules} 64`}
                    className="w-full max-w-[300px] h-24"
                    preserveAspectRatio="none"
                    role="img"
                    aria-label={`Barcode Code 128 untuk ${barcodeValue}`}
                  >
                    <rect width={totalModules} height={64} fill="#FFFFFF" />
                    {barRects.map((bar, idx) => (
                      <rect
                        key={idx}
                        x={quietZone + bar.x}
                        y={4}
                        width={bar.w}
                        height={56}
                        fill="#111B21"
                      />
                    ))}
                  </svg>
                  <div className="mt-2 font-mono-id text-sm font-bold tracking-[0.22em] text-[#111B21]">
                    {barcodeValue}
                  </div>
                </div>
                <p className="mt-3 text-xs text-center text-[#54656F] dark:text-[#8696A0] max-w-xs leading-relaxed">
                  Barcode standar Code 128 yang mudah dipindai atau disimpan sebagai kartu undangan ID WattappsAU Anda.
                </p>
              </>
            )}

            <button
              type="button"
              onClick={handleDownloadCode}
              className="mt-4 h-10 px-4 rounded-xl bg-white dark:bg-[#202C33] hover:bg-[#EFEFEF] dark:hover:bg-[#2A3942] border border-black/10 dark:border-white/10 text-xs font-semibold text-[#111B21] dark:text-[#E9EDEF] flex items-center gap-2 transition-colors cursor-pointer"
            >
              <Download className="w-4 h-4 text-[#008069] dark:text-[#00A884]" />
              <span>Unduh {codeTab === 'qr' ? 'QR Code' : 'Barcode'} (PNG)</span>
            </button>
          </div>

          {/* Toggle: Include my 6-digit ID in invite link */}
          <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-xl bg-[#F0F2F5] dark:bg-[#111B21] cursor-pointer">
            <div className="min-w-0">
              <div className="text-sm font-medium text-[#111B21] dark:text-[#E9EDEF]">
                Sertakan ID Saya ({formatSixDigitId(profile.id)})
              </div>
              <div className="text-xs text-[#667781] dark:text-[#8696A0]">
                Otomatis menambahkan Anda sebagai kontak saat teman membuka link
              </div>
            </div>
            <input
              type="checkbox"
              checked={includeMyId}
              onChange={(e) => setIncludeMyId(e.target.checked)}
              className="w-5 h-5 accent-[#008069] dark:accent-[#00A884] rounded cursor-pointer shrink-0"
            />
          </label>

          {/* Shareable Link Box */}
          <div className="space-y-2.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[#008069] dark:text-[#00A884]">
              <Link2 className="w-3.5 h-3.5" />
              <span>Tautan Undangan Aplikasi</span>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={shareUrl}
                onFocus={(e) => e.target.select()}
                className="flex-1 h-11 px-3 rounded-xl bg-[#F0F2F5] dark:bg-[#111B21] text-xs font-mono-id text-[#3B4A54] dark:text-[#D1D7DB] border border-black/5 dark:border-white/10 focus:outline-none focus:border-[#00A884] truncate"
              />
              <button
                type="button"
                onClick={handleCopyLink}
                className="h-11 px-3.5 rounded-xl bg-[#F0F2F5] dark:bg-[#111B21] hover:bg-[#E4E7EB] dark:hover:bg-[#2A3942] border border-black/5 dark:border-white/10 text-xs font-semibold text-[#111B21] dark:text-[#E9EDEF] flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer"
                title="Salin tautan"
              >
                {copiedLink ? (
                  <>
                    <Check className="w-4 h-4 text-[#00A884]" />
                    <span>Tersalin</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    <span>Salin</span>
                  </>
                )}
              </button>
            </div>

            <button
              type="button"
              onClick={handleNativeShare}
              className="w-full h-12 rounded-xl bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] text-white dark:text-[#111B21] text-sm font-semibold flex items-center justify-center gap-2 shadow-sm transition-colors cursor-pointer"
            >
              <Share2 className="w-4 h-4" />
              <span>Bagikan Link Aplikasi</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
