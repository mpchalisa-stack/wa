// Synthesized Web Audio API ringtones (440Hz+480Hz telephone ring), message chimes, global AudioContext unlock, and vibration

let ringtoneTimer: number | null = null;
let audioCtx: AudioContext | null = null;
let unlockRegistered = false;

export function getSharedAudioContext(): AudioContext | null {
  try {
    if (!audioCtx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        audioCtx = new Ctx();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      void audioCtx.resume();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

/**
 * Unlock AudioContext global secara otomatis pada sentuhan/klik pertama pengguna di layar mana pun
 * agar browser mengizinkan pemutaran nada dering & notifikasi di tab latar belakang.
 */
export function initGlobalAudioUnlock(): () => void {
  if (typeof window === 'undefined' || unlockRegistered) {
    return () => {};
  }
  unlockRegistered = true;

  const unlockHandler = () => {
    try {
      const ctx = getSharedAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }
      // Putar 1-sample silent buffer untuk membuka kunci pipeline audio di Chrome Android / iOS Safari
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      // ignore
    }
  };

  window.addEventListener('pointerdown', unlockHandler, { passive: true });
  window.addEventListener('touchstart', unlockHandler, { passive: true });
  window.addEventListener('keydown', unlockHandler, { passive: true });

  return () => {
    unlockRegistered = false;
    window.removeEventListener('pointerdown', unlockHandler);
    window.removeEventListener('touchstart', unlockHandler);
    window.removeEventListener('keydown', unlockHandler);
  };
}

export function triggerAlertVibration(pattern: number | number[] = [500, 200, 500]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {
    // ignore on unsupported browsers
  }
}

export function stopVibration(): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(0);
    }
  } catch {
    // ignore
  }
}

/**
 * Mode notifikasi senyap untuk kenyamanan pendengaran:
 * Panggilan masuk & pesan tidak lagi memutar nada dering nyaring atau getaran yang mengganggu.
 */
export function startIncomingRingtone(): void {
  stopRingtone();
}

export function startOutgoingRingback(): void {
  stopRingtone();
  const playPulse = () => {
    const ctx = getSharedAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(440, now);
    osc2.frequency.setValueAtTime(480, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.05, now + 0.05);
    gain.gain.setValueAtTime(0.05, now + 0.95);
    gain.gain.linearRampToValueAtTime(0.0001, now + 1.05);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 1.1);
    osc2.stop(now + 1.1);
  };

  playPulse();
  ringtoneTimer = window.setInterval(playPulse, 3200);
}

export function stopRingtone(): void {
  if (ringtoneTimer !== null) {
    window.clearInterval(ringtoneTimer);
    ringtoneTimer = null;
  }
  stopVibration();
}

export function playMessagePop(_incoming = false): void {
  // Senyap: tidak memutar suara atau getaran agar notifikasi tidak mengganggu kenyamanan pendengaran
  void _incoming;
}
