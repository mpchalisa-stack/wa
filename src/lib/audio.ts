// Synthesized Web Audio API loud ringtones, message chimes, and vibration (zero external mp3 files)

let ringtoneTimer: number | null = null;
let audioCtx: AudioContext | null = null;

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

  // Harmonisa halus agar dering lebih nyaring dan jelas terdengar di speaker HP
  harmonic.type = 'sine';
  harmonic.frequency.setValueAtTime(freq * 2, startTime);

  const harmonicGain = ctx.createGain();
  harmonicGain.gain.setValueAtTime(0.28, startTime);

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

/**
 * Nada dering panggilan masuk nyaring via Web Audio API + getar [500, 200, 500] ms berulang
 */
export function startIncomingRingtone(): void {
  stopRingtone();
  const playPattern = () => {
    triggerAlertVibration([500, 200, 500]);
    const ctx = getSharedAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const notes = [
      { f: 587.33, t: 0.0, d: 0.2 }, // D5
      { f: 739.99, t: 0.16, d: 0.2 }, // F#5
      { f: 880.0, t: 0.32, d: 0.24 }, // A5
      { f: 739.99, t: 0.56, d: 0.2 }, // F#5
      { f: 880.0, t: 0.72, d: 0.26 }, // A5
      { f: 1174.66, t: 0.94, d: 0.36 }, // D6
    ];
    for (const n of notes) {
      playMarimbaNote(ctx, n.f, now + n.t, n.d, 0.34, 'triangle');
    }
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
    // Nada notifikasi pesan masuk lebih nyaring & tegas
    playMarimbaNote(ctx, 659.25, now, 0.13, 0.24, 'triangle');
    playMarimbaNote(ctx, 987.77, now + 0.09, 0.2, 0.26, 'triangle');
  } else {
    playMarimbaNote(ctx, 660, now, 0.09, 0.06, 'sine');
  }
}
