// Synthesized Web Audio API ringtones (440Hz+480Hz telephone ring), message chimes, and strict AudioContext focus release

let ringtoneTimer: number | null = null;
let idleReleaseTimer: number | null = null;
let audioCtx: AudioContext | null = null;
let ringtoneAudioCtx: AudioContext | null = null;
let ringtoneSessionId = 0;

const activeRingtoneIntervals = new Set<number>();
const activeRingtoneContexts = new Set<AudioContext>();
const activeRingtoneNodes = new Set<AudioNode>();
const activeRingtoneOscillators = new Set<OscillatorNode>();
const registeredRingtoneAudioElements = new Set<HTMLAudioElement>();
let activeRingtoneAudioEl: HTMLAudioElement | null = null;

function clearIdleReleaseTimer(): void {
  if (idleReleaseTimer !== null) {
    window.clearTimeout(idleReleaseTimer);
    idleReleaseTimer = null;
  }
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
    null
  );
}

function isRingtoneActive(): boolean {
  return (
    ringtoneTimer !== null ||
    activeRingtoneIntervals.size > 0 ||
    activeRingtoneOscillators.size > 0 ||
    ringtoneAudioCtx !== null
  );
}

/**
 * Mendaftarkan elemen HTMLAudioElement (misal dari useRef) agar selalu dihentikan & di-reset
 * secara sinkron oleh stopAllRingtones().
 */
export function registerRingtoneAudioElement(el: HTMLAudioElement | null): () => void {
  if (!el) return () => {};
  registeredRingtoneAudioElements.add(el);
  return () => {
    registeredRingtoneAudioElements.delete(el);
  };
}

export function getSharedAudioContext(): AudioContext | null {
  try {
    clearIdleReleaseTimer();
    if (!audioCtx || audioCtx.state === 'closed') {
      const Ctx = getAudioContextCtor();
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

function createDedicatedRingtoneContext(): AudioContext | null {
  try {
    const Ctx = getAudioContextCtor();
    if (!Ctx) return null;
    if (ringtoneAudioCtx && ringtoneAudioCtx.state !== 'closed') {
      if (ringtoneAudioCtx.state === 'suspended') {
        void ringtoneAudioCtx.resume().catch(() => {});
      }
      return ringtoneAudioCtx;
    }
    const ctx = new Ctx();
    ringtoneAudioCtx = ctx;
    activeRingtoneContexts.add(ctx);
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Memastikan Web Audio API AudioContext dalam keadaan aktif (`resume()`)
 * tepat saat tombol Panggil atau Jawab ditekan (User Gesture).
 */
export function resumeWebAudioContext(): void {
  try {
    const ctx = getSharedAudioContext();
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
  } catch {
    // ignore
  }
}

/**
 * Menutup & melepas AudioContext pesan/notifikasi sepenuhnya agar sistem Android dan perangkat Bluetooth
 * eksternal (misal headset VIVAN Sport X3) langsung mendapatkan kembali fokus audio normal.
 */
export function releaseAudioContextNow(): void {
  clearIdleReleaseTimer();
  if (isRingtoneActive()) return; // Jangan tutup saat dering panggilan masih aktif

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
  if (isRingtoneActive()) return;
  idleReleaseTimer = window.setTimeout(() => {
    idleReleaseTimer = null;
    if (!isRingtoneActive()) {
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
    if (document.visibilityState === 'hidden' && !isRingtoneActive()) {
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

function playTelephoneBurst(
  ctx: AudioContext,
  startTime: number,
  duration: number,
  gainPeak = 0.34
) {
  if (ctx.state === 'closed') return;

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

  activeRingtoneOscillators.add(osc440);
  activeRingtoneOscillators.add(osc480);
  activeRingtoneOscillators.add(oscHarmonic);
  activeRingtoneNodes.add(masterGain);
  activeRingtoneNodes.add(harmonicGain);

  const cleanup = () => {
    activeRingtoneOscillators.delete(osc440);
    activeRingtoneOscillators.delete(osc480);
    activeRingtoneOscillators.delete(oscHarmonic);
    activeRingtoneNodes.delete(masterGain);
    activeRingtoneNodes.delete(harmonicGain);
  };
  osc440.onended = cleanup;

  const stopAt = startTime + duration + 0.03;
  osc440.stop(stopAt);
  osc480.stop(stopAt);
  oscHarmonic.stop(stopAt);
}

/**
 * Fungsi terpusat untuk menghentikan & menghancurkan SELURUH sumber suara dering secara sinkron:
 * - Semua timer setInterval dering
 * - Semua elemen HTMLAudioElement dering (pause, currentTime = 0, src = '', load())
 * - Semua OscillatorNode & AudioNode dering (stop & disconnect)
 * - Semua AudioContext dering (ringtoneCtx.close())
 * - Getaran perangkat
 */
export function stopAllRingtones(): void {
  // Invalidasi sesi dering aktif terlebih dahulu agar callback interval/resume yang tertunda langsung batal
  ringtoneSessionId += 1;

  if (ringtoneTimer !== null) {
    try {
      window.clearInterval(ringtoneTimer);
    } catch {
      // ignore
    }
    ringtoneTimer = null;
  }

  activeRingtoneIntervals.forEach((timerId) => {
    try {
      window.clearInterval(timerId);
    } catch {
      // ignore
    }
  });
  activeRingtoneIntervals.clear();

  // Hentikan & putuskan semua OscillatorNode dering seketika
  activeRingtoneOscillators.forEach((osc) => {
    try {
      osc.onended = null;
    } catch {
      // ignore
    }
    try {
      osc.stop(0);
    } catch {
      try {
        osc.stop();
      } catch {
        // ignore if already stopped
      }
    }
    try {
      osc.disconnect();
    } catch {
      // ignore
    }
  });
  activeRingtoneOscillators.clear();

  // Putuskan semua GainNode / AudioNode dering seketika
  activeRingtoneNodes.forEach((node) => {
    try {
      node.disconnect();
    } catch {
      // ignore
    }
  });
  activeRingtoneNodes.clear();

  // Hentikan & kosongkan seluruh elemen HTMLAudioElement dering yang terlacak
  const stopAudioEl = (el: HTMLAudioElement) => {
    try {
      el.pause();
    } catch {
      // ignore
    }
    try {
      el.currentTime = 0;
    } catch {
      // ignore
    }
    try {
      el.src = '';
    } catch {
      // ignore
    }
    try {
      el.load();
    } catch {
      // ignore
    }
  };

  if (activeRingtoneAudioEl) {
    stopAudioEl(activeRingtoneAudioEl);
    activeRingtoneAudioEl = null;
  }
  registeredRingtoneAudioElements.forEach((el) => {
    stopAudioEl(el);
  });

  // Tutup paksa AudioContext dering terdedikasi agar tidak ada buffer suara tersisa
  if (ringtoneAudioCtx) {
    activeRingtoneContexts.add(ringtoneAudioCtx);
    ringtoneAudioCtx = null;
  }
  activeRingtoneContexts.forEach((ctx) => {
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
  });
  activeRingtoneContexts.clear();

  stopVibration();
  // Segera lepas AudioContext pesan jika idle agar fokus audio Android/Bluetooth kembali normal
  releaseAudioContextNow();
}

// Alias kompatibilitas mundur
export const stopRingtone = stopAllRingtones;

/**
 * Nada dering panggilan masuk nyaring:
 * Osilator ganda 440Hz + 480Hz pola dering telepon berulang + getaran [1000, 300, 1000] ms
 * hingga panggilan diangkat atau ditolak.
 */
export function startIncomingRingtone(): void {
  stopAllRingtones();
  clearIdleReleaseTimer();
  const sessionId = ringtoneSessionId;

  const playPattern = () => {
    if (sessionId !== ringtoneSessionId) return;
    triggerAlertVibration([1000, 300, 1000]);
    const ctx = createDedicatedRingtoneContext();
    if (!ctx || ctx.state === 'closed' || sessionId !== ringtoneSessionId) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    try {
      const now = ctx.currentTime;
      // Pola dering ganda khas telepon: ring 0.45s - jeda 0.18s - ring 0.55s
      playTelephoneBurst(ctx, now, 0.45, 0.34);
      playTelephoneBurst(ctx, now + 0.63, 0.55, 0.34);
    } catch {
      // ignore if context closed mid-schedule
    }
  };

  playPattern();
  const timerId = window.setInterval(playPattern, 2600);
  ringtoneTimer = timerId;
  activeRingtoneIntervals.add(timerId);
}

export function startOutgoingRingback(): void {
  stopAllRingtones();
  clearIdleReleaseTimer();
  const sessionId = ringtoneSessionId;

  const playPulse = () => {
    if (sessionId !== ringtoneSessionId) return;
    const ctx = createDedicatedRingtoneContext();
    if (!ctx || ctx.state === 'closed' || sessionId !== ringtoneSessionId) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    try {
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
      activeRingtoneOscillators.add(osc1);
      activeRingtoneOscillators.add(osc2);
      activeRingtoneNodes.add(gain);
      osc1.onended = () => {
        activeRingtoneOscillators.delete(osc1);
        activeRingtoneOscillators.delete(osc2);
        activeRingtoneNodes.delete(gain);
      };
      osc1.stop(now + 1.1);
      osc2.stop(now + 1.1);
    } catch {
      // ignore if context closed mid-schedule
    }
  };

  playPulse();
  const timerId = window.setInterval(playPulse, 3200);
  ringtoneTimer = timerId;
  activeRingtoneIntervals.add(timerId);
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
