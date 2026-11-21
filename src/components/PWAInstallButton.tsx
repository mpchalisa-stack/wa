import React, { useState } from 'react';
import { Download, Share, PlusSquare, X, WifiOff } from 'lucide-react';
import { usePWAInstall, useOnlineStatus } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'menu-item' | 'button';
  onAfterClick?: () => void;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  variant = 'button',
  onAfterClick,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  const handleClick = async () => {
    if (isInstallable) {
      await install();
      onAfterClick?.();
    } else if (isIOS) {
      setShowIOSGuide(true);
    } else {
      setShowIOSGuide(true);
    }
  };

  return (
    <>
      {variant === 'menu-item' ? (
        <button
          type="button"
          onClick={handleClick}
          className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm text-[#111B21] dark:text-[#E9EDEF] hover:bg-[#F5F6F6] dark:hover:bg-[#182229] transition-colors"
        >
          <Download className="w-4 h-4 text-[#008069] dark:text-[#00A884] shrink-0" />
          <span className="whitespace-nowrap">Instal Aplikasi (PWA)</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] text-white dark:text-[#111B21] font-semibold px-4 py-3 text-sm transition-colors shadow-sm cursor-pointer"
        >
          <Download className="w-4 h-4 shrink-0" />
          <span className="whitespace-nowrap">
            {isInstallable ? 'Instal WA6 di Perangkat' : 'Cara Instal di Layar Utama'}
          </span>
        </button>
      )}

      {showIOSGuide && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
          onClick={() => setShowIOSGuide(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#233138] p-6 shadow-2xl border border-black/5 dark:border-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-[#111B21] dark:text-[#E9EDEF]">
                Instal WA6 ke Layar Utama
              </h3>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="w-9 h-9 rounded-full flex items-center justify-center text-[#54656F] dark:text-[#8696A0] hover:bg-black/5 dark:hover:bg-white/10"
                aria-label="Tutup"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {isIOS ? (
              <ol className="space-y-3 text-sm text-[#3B4A54] dark:text-[#D1D7DB]">
                <li className="flex items-start gap-3">
                  <span className="w-6 h-6 rounded-full bg-[#008069]/15 text-[#008069] dark:text-[#00A884] font-semibold text-xs flex items-center justify-center shrink-0 mt-0.5">
                    1
                  </span>
                  <span>
                    Ketuk tombol <strong className="inline-flex items-center gap-1 font-semibold"><Share className="w-3.5 h-3.5 inline" /> Bagikan</strong> di bilah bawah Safari.
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="w-6 h-6 rounded-full bg-[#008069]/15 text-[#008069] dark:text-[#00A884] font-semibold text-xs flex items-center justify-center shrink-0 mt-0.5">
                    2
                  </span>
                  <span>
                    Gulir ke bawah lalu pilih <strong className="inline-flex items-center gap-1 font-semibold"><PlusSquare className="w-3.5 h-3.5 inline" /> Tambahkan ke Layar Utama</strong>.
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="w-6 h-6 rounded-full bg-[#008069]/15 text-[#008069] dark:text-[#00A884] font-semibold text-xs flex items-center justify-center shrink-0 mt-0.5">
                    3
                  </span>
                  <span>Ketuk <strong>Tambah</strong> di pojok kanan atas untuk membuka WA6 secara layar penuh.</span>
                </li>
              </ol>
            ) : (
              <p className="text-sm text-[#3B4A54] dark:text-[#D1D7DB] leading-relaxed">
                Buka menu browser (ikon titik tiga di pojok kanan atas Chrome/Edge) lalu pilih{' '}
                <strong>Instal aplikasi</strong> atau <strong>Tambahkan ke layar utama</strong> untuk menjalankan WA6 dalam mode standalone.
              </p>
            )}

            <button
              type="button"
              onClick={() => {
                setShowIOSGuide(false);
                onAfterClick?.();
              }}
              className="mt-5 w-full rounded-xl bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] text-white dark:text-[#111B21] py-2.5 text-sm font-semibold transition-colors"
            >
              Mengerti
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-xl bg-[#111B21] dark:bg-[#233138] border border-amber-500/40 px-3.5 py-2 text-xs font-medium text-white shadow-lg">
      <WifiOff className="w-4 h-4 text-amber-400 shrink-0" />
      <span>Mode Offline — Data lokal tetap tersimpan</span>
    </div>
  );
};
