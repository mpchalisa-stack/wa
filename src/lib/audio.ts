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

function playMarimbaNote(
  ctx: AudioContext,
  freq: number,
  startTime: number,
  duration: number,
  gainPeak = 0.24,
  waveform: OscillatorType = 'triangle'
) {
  const osc = ctx.createOscillator();
  const harmonic = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = waveform;
  osc.frequency.setValueAtTime(freq, startTime);

  harmonic.type = 'sine';
  harmonic.frequency.setValueAtTime(freq * 2, startTime);

  const harmonicGain = ctx.createGain();
  harmonicGain.gain.setValueAtTime(0.25, startTime);

  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(gainPeak, startTime + 0.014);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  osc.connect(gain);
  harmonic.connect(harmonicGain);
  harmonicGain.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startTime);
  harmonic.start(startTime);
  osc.stop(startTime + duration + 0.02);
  harmonic.stop(startTime + duration + 0.02);
}

function playTelephoneBurst(ctx: AudioContext, startTime: number, duration: number, gainPeak = 0.42) {
  // Osilator ganda nyaring 480Hz + 620Hz (nada dering taktis) + harmonisa ringan agar tembus speaker HP
  const osc480 = ctx.createOscillator();
  const osc620 = ctx.createOscillator();
  const oscHarmonic = ctx.createOscillator();
  const masterGain = ctx.createGain();
  const harmonicGain = ctx.createGain();

  osc480.type = 'sine';
  osc620.type = 'sine';
  oscHarmonic.type = 'triangle';

  osc480.frequency.setValueAtTime(480, startTime);
  osc620.frequency.setValueAtTime(620, startTime);
  oscHarmonic.frequency.setValueAtTime(1100, startTime);

  harmonicGain.gain.setValueAtTime(0.18, startTime);

  masterGain.gain.setValueAtTime(0.0001, startTime);
  masterGain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.02);
  masterGain.gain.setValueAtTime(gainPeak, startTime + Math.max(0.05, duration - 0.03));
  masterGain.gain.linearRampToValueAtTime(0.0001, startTime + duration);

  osc480.connect(masterGain);
  osc620.connect(masterGain);
  oscHarmonic.connect(harmonicGain);
  harmonicGain.connect(masterGain);
  masterGain.connect(ctx.destination);

  osc480.start(startTime);
  osc620.start(startTime);
  oscHarmonic.start(startTime);

  const stopAt = startTime + duration + 0.03;
  osc480.stop(stopAt);
  osc620.stop(stopAt);
  oscHarmonic.stop(stopAt);
}

/**
 * Nada dering panggilan masuk nyaring:
 * Osilator ganda 480Hz + 620Hz berulang via AudioContext + getaran [1000, 400, 1000, 400, 1000] ms
 * sampai panggilan diangkat atau ditolak.
 */
export function startIncomingRingtone(): void {
  stopRingtone();
  const playPattern = () => {
    triggerAlertVibration([1000, 400, 1000, 400, 1000]);
    const ctx = getSharedAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const now = ctx.currentTime;
    // Pola dering ganda nyaring: ring 0.48s - jeda 0.18s - ring 0.58s
    playTelephoneBurst(ctx, now, 0.48, 0.42);
    playTelephoneBurst(ctx, now + 0.66, 0.58, 0.42);
  };

  playPattern();
  ringtoneTimer = window.setInterval(playPattern, 2400);
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
    gain.gain.linearRampToValueAtTime(0.07, now + 0.05);
    gain.gain.setValueAtTime(0.07, now + 0.95);
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

export function playMessagePop(incoming = false): void {
  const ctx = getSharedAudioContext();
  if (incoming) {
    triggerAlertVibration([500, 200, 500]);
  }
  if (!ctx) return;
  const now = ctx.currentTime;
  if (incoming) {
    playMarimbaNote(ctx, 659.25, now, 0.13, 0.24, 'triangle');
    playMarimbaNote(ctx, 987.77, now + 0.09, 0.2, 0.26, 'triangle');
  } else {
    playMarimbaNote(ctx, 660, now, 0.09, 0.06, 'sine');
  }
}
