// Synthesized Web Audio API ringtones (440Hz+480Hz telephone ring), message chimes, and strict AudioContext focus release

let ringtoneTimer: number | null = null;
let idleReleaseTimer: number | null = null;
let audioCtx: AudioContext | null = null;

function clearIdleReleaseTimer(): void {
  if (idleReleaseTimer !== null) {
    window.clearTimeout(idleReleaseTimer);
    idleReleaseTimer = null;
  }
}

export function getSharedAudioContext(): AudioContext | null {
  try {
    clearIdleReleaseTimer();
    if (!audioCtx || audioCtx.state === 'closed') {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        audioCtx = new Ctx();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      void audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  } catch {
    return null;
  }
}

/**
 * Menutup & melepas AudioContext sepenuhnya agar sistem Android dan perangkat Bluetooth
 * eksternal (misal headset VIVAN Sport X3) langsung mendapatkan kembali fokus audio normal.
 */
export function releaseAudioContextNow(): void {
  clearIdleReleaseTimer();
  if (ringtoneTimer !== null) return; // Jangan tutup saat dering panggilan masih aktif

  const ctx = audioCtx;
  audioCtx = null;
  if (!ctx) return;

  try {
    if (ctx.state !== 'closed') {
      void ctx.close().catch(() => {
        try {
          void ctx.suspend().catch(() => {});
        } catch {
          // ignore
        }
      });
    }
  } catch {
    // ignore
  }
}

function scheduleIdleAudioContextRelease(delayMs = 550): void {
  clearIdleReleaseTimer();
  if (ringtoneTimer !== null) return;
  idleReleaseTimer = window.setTimeout(() => {
    idleReleaseTimer = null;
    if (ringtoneTimer === null) {
      releaseAudioContextNow();
    }
  }, delayMs);
}

/**
 * Jangan memainkan silent buffer terus-menerus pada setiap sentuhan layar agar tidak
 * mencuri fokus audio Android / Bluetooth saat aplikasi idle.
 * Hanya dengarkan visibilitychange untuk memastikan AudioContext dilepas saat ke latar belakang.
 */
export function initGlobalAudioUnlock(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  const handleVisibilityRelease = () => {
    if (document.visibilityState === 'hidden' && ringtoneTimer === null) {
      releaseAudioContextNow();
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityRelease);
  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityRelease);
    releaseAudioContextNow();
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

function playTelephoneBurst(ctx: AudioContext, startTime: number, duration: number, gainPeak = 0.34) {
  // Osilator ganda 440Hz + 480Hz pola dering telepon klasik + sedikit harmonisa agar nyaring di speaker HP
  const osc440 = ctx.createOscillator();
  const osc480 = ctx.createOscillator();
  const oscHarmonic = ctx.createOscillator();
  const masterGain = ctx.createGain();
  const harmonicGain = ctx.createGain();

  osc440.type = 'sine';
  osc480.type = 'sine';
  oscHarmonic.type = 'triangle';

  osc440.frequency.setValueAtTime(440, startTime);
  osc480.frequency.setValueAtTime(480, startTime);
  oscHarmonic.frequency.setValueAtTime(920, startTime);

  harmonicGain.gain.setValueAtTime(0.18, startTime);

  masterGain.gain.setValueAtTime(0.0001, startTime);
  masterGain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.025);
  masterGain.gain.setValueAtTime(gainPeak, startTime + Math.max(0.05, duration - 0.03));
  masterGain.gain.linearRampToValueAtTime(0.0001, startTime + duration);

  osc440.connect(masterGain);
  osc480.connect(masterGain);
  oscHarmonic.connect(harmonicGain);
  harmonicGain.connect(masterGain);
  masterGain.connect(ctx.destination);

  osc440.start(startTime);
  osc480.start(startTime);
  oscHarmonic.start(startTime);

  const stopAt = startTime + duration + 0.03;
  osc440.stop(stopAt);
  osc480.stop(stopAt);
  oscHarmonic.stop(stopAt);
}

/**
 * Nada dering panggilan masuk nyaring:
 * Osilator ganda 440Hz + 480Hz pola dering telepon berulang + getaran [1000, 300, 1000] ms
 * hingga panggilan diangkat atau ditolak.
 */
export function startIncomingRingtone(): void {
  stopRingtone();
  clearIdleReleaseTimer();
  const playPattern = () => {
    triggerAlertVibration([1000, 300, 1000]);
    const ctx = getSharedAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    // Pola dering ganda khas telepon: ring 0.45s - jeda 0.18s - ring 0.55s
    playTelephoneBurst(ctx, now, 0.45, 0.34);
    playTelephoneBurst(ctx, now + 0.63, 0.55, 0.34);
  };

  playPattern();
  ringtoneTimer = window.setInterval(playPattern, 2600);
}

export function startOutgoingRingback(): void {
  stopRingtone();
  clearIdleReleaseTimer();
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
  // Segera lepas AudioContext agar fokus audio perangkat Android/Bluetooth kembali normal
  releaseAudioContextNow();
}

export function playMessagePop(incoming = false): void {
  if (incoming) {
    triggerAlertVibration([300, 120, 300]);
  }
  // Saat tab tidak terlihat dan bukan panggilan, cukup andalkan notifikasi sistem + getar
  // agar tidak merebut fokus audio musik/Bluetooth di latar belakang
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return;
  }
  const ctx = getSharedAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  if (incoming) {
    playMarimbaNote(ctx, 659.25, now, 0.13, 0.24, 'triangle');
    playMarimbaNote(ctx, 987.77, now + 0.09, 0.2, 0.26, 'triangle');
    scheduleIdleAudioContextRelease(480);
  } else {
    playMarimbaNote(ctx, 660, now, 0.09, 0.06, 'sine');
    scheduleIdleAudioContextRelease(260);
  }
}
