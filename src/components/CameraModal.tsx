import React, { useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, RotateCcw, SendHorizontal, X } from 'lucide-react';
import { compressCanvasToJpeg } from '../lib/media';

interface CameraModalProps {
  title?: string;
  onCapture: (dataUrl: string, caption: string, byteSize: number) => void;
  onClose: () => void;
}

export const CameraModal: React.FC<CameraModalProps> = ({
  title = 'Ambil Foto',
  onCapture,
  onClose,
}) => {
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment');
  const [capturedUrl, setCapturedUrl] = useState<string | null>(null);
  const [capturedSize, setCapturedSize] = useState<number>(0);
  const [caption, setCaption] = useState('');
  const [error, setError] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  useEffect(() => {
    if (capturedUrl) {
      stopStream();
      return;
    }

    let cancelled = false;
    setError('');

    const init = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode },
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
      } catch {
        if (!cancelled) {
          setError('Kamera tidak tersedia atau izin ditolak browser.');
        }
      }
    };

    void init();
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [facingMode, capturedUrl]);

  const handleShutter = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    // Resolusi maksimal lebar/tinggi 1024px (proporsional)
    const maxDim = 1024;
    let w = video.videoWidth;
    let h = video.videoHeight;
    if (w > maxDim || h > maxDim) {
      if (w >= h) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (facingMode === 'user') {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);
    // Kompresi otomatis image/jpeg kualitas 0.7 (dijamin < 250 KB)
    const { dataUrl, byteSize } = compressCanvasToJpeg(canvas, 0.7, 245 * 1024);
    setCapturedUrl(dataUrl);
    setCapturedSize(byteSize);
  };

  const handleSend = () => {
    if (!capturedUrl) return;
    onCapture(capturedUrl, caption.trim(), capturedSize);
  };

  return (
    <div className="fixed inset-0 z-[110] bg-black flex flex-col">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/60 text-white shrink-0 z-10">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-white/10 cursor-pointer"
            aria-label="Tutup kamera"
          >
            <X className="w-6 h-6" />
          </button>
          <span className="text-sm font-semibold">{title}</span>
        </div>

        {!capturedUrl && !error && (
          <button
            type="button"
            onClick={() => setFacingMode((m) => (m === 'user' ? 'environment' : 'user'))}
            className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-white/10 cursor-pointer"
            title="Ganti Kamera"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Camera Viewport / Captured Preview */}
      <div className="flex-1 relative flex items-center justify-center overflow-hidden bg-black">
        {capturedUrl ? (
          <img
            src={capturedUrl}
            alt="Hasil kamera"
            className="max-w-full max-h-full object-contain"
          />
        ) : error ? (
          <div className="text-center px-6 text-white/80">
            <Camera className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="text-sm">{error}</p>
          </div>
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            className={`w-full h-full object-cover ${facingMode === 'user' ? 'scale-x-[-1]' : ''}`}
          />
        )}
      </div>

      {/* Bottom Controls */}
      <div className="px-4 py-5 pb-safe bg-black/80 shrink-0">
        {capturedUrl ? (
          <div className="max-w-xl mx-auto flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setCapturedUrl(null)}
              className="w-11 h-11 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center shrink-0 cursor-pointer"
              title="Ulangi foto"
            >
              <RotateCcw className="w-5 h-5" />
            </button>
            <input
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Tambah keterangan..."
              className="flex-1 h-11 px-4 rounded-full bg-[#2A3942] text-white placeholder:text-white/60 text-sm focus:outline-none"
            />
            <button
              type="button"
              onClick={handleSend}
              className="w-12 h-12 rounded-full bg-[#00A884] hover:bg-[#06CF9C] text-white flex items-center justify-center shrink-0 shadow-lg cursor-pointer"
              title="Kirim foto"
            >
              <SendHorizontal className="w-5 h-5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-center">
            <button
              type="button"
              disabled={Boolean(error)}
              onClick={handleShutter}
              className="w-18 h-18 rounded-full border-4 border-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-40 cursor-pointer"
              aria-label="Ambil foto"
            >
              <span className="w-14 h-14 rounded-full bg-white" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
