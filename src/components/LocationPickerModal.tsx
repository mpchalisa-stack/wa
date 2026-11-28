import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Crosshair,
  ExternalLink,
  Loader2,
  MapPin,
  RefreshCw,
  SendHorizontal,
  X,
} from 'lucide-react';
import { LocationMeta } from '../types';
import { requestAndroidBridgeGpsLocation } from '../lib/fcmPush';

interface LocationPickerModalProps {
  open: boolean;
  onClose: () => void;
  onSendLocation: (location: LocationMeta) => void;
}

interface AndroidLocationUpdateDetail {
  lat?: number | string;
  lng?: number | string;
  accuracy?: number | string;
  error?: string;
}

export function buildOpenStreetMapEmbedUrl(lat: number, lng: number, delta = 0.0045): string {
  const minLng = (lng - delta).toFixed(6);
  const minLat = (lat - delta).toFixed(6);
  const maxLng = (lng + delta).toFixed(6);
  const maxLat = (lat + delta).toFixed(6);
  return `https://www.openstreetmap.org/export/embed.html?bbox=${minLng}%2C${minLat}%2C${maxLng}%2C${maxLat}&layer=mapnik&marker=${lat.toFixed(6)}%2C${lng.toFixed(6)}`;
}

export function buildExternalMapUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export const LocationPickerModal: React.FC<LocationPickerModalProps> = ({
  open,
  onClose,
  onSendLocation,
}) => {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number; accuracy?: number } | null>(null);
  const [label, setLabel] = useState('');
  const requestSessionRef = useRef(0);
  const bridgeTimerRef = useRef<number | null>(null);
  const coordsResolvedRef = useRef(false);

  const clearBridgeTimer = useCallback(() => {
    if (bridgeTimerRef.current !== null) {
      window.clearTimeout(bridgeTimerRef.current);
      bridgeTimerRef.current = null;
    }
  }, []);

  const fetchGpsLocation = useCallback(() => {
    const sessionId = ++requestSessionRef.current;
    coordsResolvedRef.current = false;
    clearBridgeTimer();

    const bridgeTriggered = requestAndroidBridgeGpsLocation();
    const hasWebGeolocation = typeof navigator !== 'undefined' && Boolean(navigator.geolocation);

    if (!bridgeTriggered && !hasWebGeolocation) {
      setErrorMsg('Perangkat atau browser ini tidak mendukung GPS Geolocation.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    const applyResolvedCoords = (lat: number, lng: number, accuracy?: number) => {
      if (requestSessionRef.current !== sessionId) return;
      coordsResolvedRef.current = true;
      clearBridgeTimer();
      setCoords({
        lat,
        lng,
        accuracy:
          typeof accuracy === 'number' && Number.isFinite(accuracy)
            ? Math.round(accuracy)
            : undefined,
      });
      setLoading(false);
      setErrorMsg(null);
    };

    const failWithGpsError = (message: string) => {
      if (requestSessionRef.current !== sessionId || coordsResolvedRef.current) return;
      clearBridgeTimer();
      setLoading(false);
      setErrorMsg(message);
    };

    if (bridgeTriggered) {
      bridgeTimerRef.current = window.setTimeout(() => {
        if (requestSessionRef.current === sessionId && !coordsResolvedRef.current) {
          failWithGpsError(
            'GPS HP tampak sedang mati atau tidak merespons. Aktifkan layanan Lokasi (GPS) di pengaturan HP Anda lalu ketuk Coba Lagi.'
          );
        }
      }, 15000);
    }

    if (!hasWebGeolocation) {
      return;
    }

    const onSuccess = (pos: GeolocationPosition) => {
      applyResolvedCoords(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
    };

    const onFallbackError = (err: GeolocationPositionError) => {
      if (requestSessionRef.current !== sessionId || coordsResolvedRef.current) return;
      let friendlyMsg =
        'Waktu pencarian GPS habis. Pastikan GPS HP dalam keadaan aktif lalu coba lagi.';
      if (err.code === err.PERMISSION_DENIED) {
        friendlyMsg =
          'Izin lokasi GPS ditolak atau GPS HP belum diaktifkan. Aktifkan Lokasi (GPS) serta izin lokasi aplikasi lalu coba lagi.';
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        friendlyMsg =
          'GPS perangkat sedang mati atau sinyal satelit tidak tersedia. Aktifkan GPS di bilah status HP Anda lalu coba lagi.';
      }

      // Jika AndroidBridge.requestGpsLocation dipanggil, beri kesempatan event android-location-update menyelesaikan terlebih dahulu
      if (bridgeTriggered) {
        clearBridgeTimer();
        bridgeTimerRef.current = window.setTimeout(() => {
          failWithGpsError(friendlyMsg);
        }, 4500);
        return;
      }

      failWithGpsError(friendlyMsg);
    };

    navigator.geolocation.getCurrentPosition(
      onSuccess,
      () => {
        // Fallback akurasi standar jika high-accuracy GPS timeout di dalam ruangan
        navigator.geolocation.getCurrentPosition(onSuccess, onFallbackError, {
          enableHighAccuracy: false,
          timeout: 10000,
          maximumAge: 30000,
        });
      },
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 5000,
      }
    );
  }, [clearBridgeTimer]);

  useEffect(() => {
    if (!open) {
      requestSessionRef.current += 1;
      coordsResolvedRef.current = false;
      clearBridgeTimer();
      setCoords(null);
      setLabel('');
      setErrorMsg(null);
      setLoading(false);
      return;
    }

    const handleAndroidLocationUpdate = (event: Event) => {
      const detail = (event as CustomEvent<AndroidLocationUpdateDetail>)?.detail;
      if (!detail) return;

      const lat = typeof detail.lat === 'string' ? Number(detail.lat) : detail.lat;
      const lng = typeof detail.lng === 'string' ? Number(detail.lng) : detail.lng;
      const accuracy =
        typeof detail.accuracy === 'string' ? Number(detail.accuracy) : detail.accuracy;

      if (
        typeof lat === 'number' &&
        Number.isFinite(lat) &&
        typeof lng === 'number' &&
        Number.isFinite(lng)
      ) {
        coordsResolvedRef.current = true;
        clearBridgeTimer();
        setCoords({
          lat,
          lng,
          accuracy:
            typeof accuracy === 'number' && Number.isFinite(accuracy)
              ? Math.round(accuracy)
              : undefined,
        });
        setLoading(false);
        setErrorMsg(null);
        return;
      }

      if (detail.error && !coordsResolvedRef.current) {
        clearBridgeTimer();
        setLoading(false);
        setErrorMsg(
          typeof detail.error === 'string' && detail.error.trim()
            ? detail.error.trim()
            : 'GPS HP sedang mati atau izin lokasi belum aktif. Aktifkan GPS lalu coba lagi.'
        );
      }
    };

    window.addEventListener('android-location-update', handleAndroidLocationUpdate);
    fetchGpsLocation();

    return () => {
      window.removeEventListener('android-location-update', handleAndroidLocationUpdate);
      clearBridgeTimer();
    };
  }, [open, fetchGpsLocation, clearBridgeTimer]);

  if (!open) return null;

  const handleConfirmSend = () => {
    if (!coords) return;
    onSendLocation({
      lat: coords.lat,
      lng: coords.lng,
      accuracy: coords.accuracy,
      label: label.trim() || undefined,
      capturedAt: Date.now(),
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[110] bg-black/75 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl bg-white dark:bg-[#202C33] text-[#111B21] dark:text-[#E9EDEF] shadow-2xl border border-black/10 dark:border-white/10 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3.5 bg-[#008069] dark:bg-[#182229] text-white flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-full bg-emerald-500/25 flex items-center justify-center">
              <MapPin className="w-4 h-4 text-emerald-300" />
            </span>
            <div>
              <h3 className="text-sm font-semibold leading-tight">Bagikan Lokasi GPS</h3>
              <p className="text-[11px] text-white/75 leading-tight">
                Koordinat akurat perangkat via satelit/jaringan
              </p>
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

        {/* Map / GPS Status Area */}
        <div className="p-4 space-y-3">
          <div className="relative h-52 w-full rounded-xl overflow-hidden bg-[#0B141A] border border-black/10 dark:border-white/10 flex items-center justify-center">
            {coords ? (
              <>
                <iframe
                  title="Pratinjau Peta GPS"
                  src={buildOpenStreetMapEmbedUrl(coords.lat, coords.lng)}
                  className="w-full h-full border-0"
                  loading="lazy"
                />
                <a
                  href={buildExternalMapUrl(coords.lat, coords.lng)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="absolute top-2.5 right-2.5 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#111B21]/85 text-white text-[11px] font-medium hover:bg-[#111B21] shadow-md"
                >
                  <ExternalLink className="w-3 h-3" />
                  <span>Buka Peta</span>
                </a>
              </>
            ) : loading ? (
              <div className="flex flex-col items-center gap-2.5 text-center px-4">
                <span className="w-12 h-12 rounded-full bg-[#00A884]/20 text-[#00A884] flex items-center justify-center">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </span>
                <div className="text-xs font-medium text-white/90">
                  Mengunci koordinat GPS perangkat...
                </div>
                <div className="text-[11px] text-white/60">
                  Pastikan layanan lokasi (GPS) perangkat aktif
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2.5 text-center px-5">
                <span className="w-11 h-11 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center">
                  <Crosshair className="w-5 h-5" />
                </span>
                <p className="text-xs text-rose-200 leading-relaxed">{errorMsg}</p>
                <button
                  type="button"
                  onClick={fetchGpsLocation}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#00A884] text-[#111B21] text-xs font-semibold hover:bg-[#06CF9C] cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Coba Lagi</span>
                </button>
              </div>
            )}
          </div>

          {/* Coordinates Readout */}
          {coords && (
            <div className="rounded-xl bg-[#F0F2F5] dark:bg-[#111B21] px-3.5 py-2.5 flex items-center justify-between gap-2 border border-black/5 dark:border-white/5">
              <div className="min-w-0">
                <div className="font-mono-id text-xs font-semibold text-[#008069] dark:text-[#00A884] truncate">
                  {coords.lat.toFixed(6)}, {coords.lng.toFixed(6)}
                </div>
                <div className="text-[11px] text-[#667781] dark:text-[#8696A0]">
                  {typeof coords.accuracy === 'number'
                    ? `Akurasi GPS ±${coords.accuracy} meter`
                    : 'Koordinat siap dikirim'}
                </div>
              </div>
              <button
                type="button"
                onClick={fetchGpsLocation}
                disabled={loading}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#233138] text-xs font-medium text-[#111B21] dark:text-[#E9EDEF] border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/10 shrink-0 cursor-pointer"
                title="Perbarui posisi GPS"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                <span>Perbarui</span>
              </button>
            </div>
          )}

          {/* Optional Note/Label */}
          <div>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={120}
              placeholder="Catatan lokasi (opsional, mis. Posko Utama)"
              className="w-full h-10 px-3.5 rounded-xl bg-[#F0F2F5] dark:bg-[#2A3942] text-sm text-[#111B21] dark:text-[#E9EDEF] placeholder:text-[#667781] dark:placeholder:text-[#8696A0] focus:outline-none focus:ring-2 focus:ring-[#00A884]/50"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1 pb-safe">
            <button
              type="button"
              onClick={onClose}
              className="px-4 h-10 rounded-xl text-sm font-medium text-[#54656F] dark:text-[#8696A0] hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={!coords || loading}
              onClick={handleConfirmSend}
              className="inline-flex items-center gap-2 px-4 h-10 rounded-xl bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] disabled:opacity-45 text-white dark:text-[#111B21] text-sm font-semibold shadow-sm cursor-pointer disabled:cursor-not-allowed"
            >
              <SendHorizontal className="w-4 h-4" />
              <span>Kirim Lokasi</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
