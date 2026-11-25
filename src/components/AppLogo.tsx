import React, { useId, useState } from 'react';

interface AppLogoProps {
  size?: number;
  className?: string;
}

/**
 * Logo resmi WattappsAU bertema Diskomlekau.
 * Menggunakan /icon-512.png dengan fallback SVG vektor presisi tinggi:
 * - Gelembung chat bulat biru langit (#56b4f5) berbingkai putih
 * - Gagang telepon putih di tengah
 * - Petir oranye (#ff9f1c) berbingkai merah (#e61919) menyilang diagonal kanan atas ke kiri bawah
 * - Tulisan melengkung "DISKOMLEKAU" berwarna merah di bagian bawah dalam lingkaran
 */
export const AppLogo: React.FC<AppLogoProps> = ({ size = 36, className = '' }) => {
  const [imgFailed, setImgFailed] = useState(false);
  const uid = useId().replace(/:/g, '');
  const arcId = `diskomlekau-arc-${uid}`;
  const shadowId = `logo-shadow-${uid}`;

  if (!imgFailed) {
    return (
      <img
        src="/assets/aistudio/1792503945296_954409ac.jpg"
        alt="WattappsAU Swa Bhuwana Paksa"
        width={size}
        height={size}
        onError={() => setImgFailed(true)}
        className={`rounded-full object-cover shrink-0 select-none bg-black ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      role="img"
      aria-label="Logo WattappsAU Diskomlekau"
      className={`shrink-0 select-none ${className}`}
      style={{ width: size, height: size }}
    >
      <defs>
        <filter id={shadowId} x="-15%" y="-15%" width="130%" height="130%">
          <feDropShadow dx="0" dy="6" stdDeviation="7" floodColor="#0B141A" floodOpacity="0.22" />
        </filter>
        <path
          id={arcId}
          d="M 118 332 A 164 164 0 0 0 394 332"
          fill="none"
        />
      </defs>

      {/* Bingkai luar gelembung chat putih */}
      <path
        d="M256 36 C134.5 36 36 134.5 36 256 C36 297.8 47.7 336.9 68 370.2 L36 476 L145.6 445.5 C178.5 464.9 216 476 256 476 C377.5 476 476 377.5 476 256 C476 134.5 377.5 36 256 36 Z"
        fill="#FFFFFF"
        filter={`url(#${shadowId})`}
      />

      {/* Gelembung chat biru langit (#56b4f5) */}
      <path
        d="M256 72 C154.4 72 72 154.4 72 256 C72 293.5 83.2 328.4 102.5 357.5 L80 432 L156.8 410.5 C185.8 429.2 219.7 440 256 440 C357.6 440 440 357.6 440 256 C440 154.4 357.6 72 256 72 Z"
        fill="#56b4f5"
      />

      {/* Gagang telepon putih di tengah */}
      <path
        d="M192 152 C185 152 176 154 169 161 C157 173 144 192 144 218 C144 251 163 288 197 322 C231 356 268 375 301 375 C327 375 346 362 358 350 C365 343 367 334 367 327 C367 321 364 316 359 313 L318 292 C311 288 303 290 298 295 L283 310 C279 314 273 315 268 313 C251 306 235 294 221 280 C207 266 195 250 188 233 C186 228 187 222 191 218 L206 203 C211 198 213 190 209 183 L188 142 C185 137 198 152 192 152 Z"
        fill="#FFFFFF"
        filter={`url(#${shadowId})`}
      />

      {/* Simbol petir oranye (#ff9f1c) berbingkai merah (#e61919) menyilang diagonal kanan atas ke kiri bawah */}
      <path
        d="M350 116 L214 250 L264 246 L166 378 L322 216 L272 220 Z"
        fill="#ff9f1c"
        stroke="#e61919"
        strokeWidth="12"
        strokeLinejoin="miter"
        strokeMiterlimit="6"
      />

      {/* Tulisan melengkung DISKOMLEKAU warna merah di bagian bawah dalam lingkaran */}
      <text
        fill="#e61919"
        fontFamily="Arial Black, Impact, sans-serif"
        fontSize="28"
        fontWeight="900"
        letterSpacing="2.5"
      >
        <textPath href={`#${arcId}`} startOffset="50%" textAnchor="middle">
          DISKOMLEKAU
        </textPath>
      </text>
    </svg>
  );
};
