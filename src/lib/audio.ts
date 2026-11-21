// Synthesized Web Audio API ringtones and message sound effects (zero external mp3 files)

let ringtoneTimer: number | null = null;
let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
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

function playMarimbaNote(ctx: AudioContext, freq: number, startTime: number, duration: number, gainPeak = 0.14) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, startTime);

  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(gainPeak, startTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

export function startIncomingRingtone(): void {
  stopRingtone();
  const playPattern = () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    // Pleasant rhythmic marimba-inspired WhatsApp ring melody
    const notes = [
      { f: 523.25, t: 0.0, d: 0.18 }, // C5
      { f: 659.25, t: 0.16, d: 0.18 }, // E5
      { f: 783.99, t: 0.32, d: 0.22 }, // G5
      { f: 659.25, t: 0.56, d: 0.18 }, // E5
      { f: 783.99, t: 0.72, d: 0.24 }, // G5
      { f: 1046.5, t: 0.94, d: 0.32 }, // C6
    ];
    for (const n of notes) {
      playMarimbaNote(ctx, n.f, now + n.t, n.d, 0.16);
    }
  };

  playPattern();
  ringtoneTimer = window.setInterval(playPattern, 2600);
}

export function startOutgoingRingback(): void {
  stopRingtone();
  const playPulse = () => {
    const ctx = getAudioContext();
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
    gain.gain.linearRampToValueAtTime(0.06, now + 0.05);
    gain.gain.setValueAtTime(0.06, now + 0.95);
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
}

export function playMessagePop(incoming = false): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  if (incoming) {
    playMarimbaNote(ctx, 587.33, now, 0.1, 0.08);
    playMarimbaNote(ctx, 880, now + 0.07, 0.14, 0.09);
  } else {
    playMarimbaNote(ctx, 660, now, 0.09, 0.06);
  }
}
