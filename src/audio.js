// audio.js — every sound is synthesized with WebAudio. No assets, no files.
let ctx = null, master = null;

export function initAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
}

function noiseBuffer() {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// Filtered noise burst — the backbone of gunshots, digs, explosions.
function burst({ dur = 0.15, freq = 1200, q = 1, gain = 0.5, decay = 12 }) {
  if (!ctx) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer();
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  src.connect(f).connect(g).connect(master);
  src.start();
  src.stop(ctx.currentTime + dur + 0.05);
}

function tone({ freq = 440, dur = 0.12, type = 'square', gain = 0.2, slide = 0, delay = 0 }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

export const sfx = {
  rifle:     () => { burst({ dur: 0.22, freq: 900,  gain: 0.7 }); tone({ freq: 140, dur: 0.1, type: 'sawtooth', gain: 0.25, slide: -90 }); },
  smg:       () => { burst({ dur: 0.1,  freq: 1400, gain: 0.45 }); tone({ freq: 200, dur: 0.06, type: 'square', gain: 0.12, slide: -120 }); },
  dig:       () => burst({ dur: 0.08, freq: 500, gain: 0.5 }),
  place:     () => tone({ freq: 300, dur: 0.06, type: 'triangle', gain: 0.25, slide: 120 }),
  hit:       () => tone({ freq: 900, dur: 0.05, type: 'square', gain: 0.18 }),
  hurt:      () => { tone({ freq: 220, dur: 0.15, type: 'sawtooth', gain: 0.3, slide: -140 }); },
  throw_:    () => burst({ dur: 0.09, freq: 2000, gain: 0.15 }),
  explosion: () => { burst({ dur: 0.9, freq: 500, gain: 1.0 }); tone({ freq: 70, dur: 0.7, type: 'sine', gain: 0.6, slide: -40 }); },
  pickup:    () => { tone({ freq: 520, dur: 0.09, gain: 0.22 }); tone({ freq: 780, dur: 0.12, gain: 0.22, delay: 0.09 }); },
  drop:      () => { tone({ freq: 500, dur: 0.09, gain: 0.2 }); tone({ freq: 320, dur: 0.12, gain: 0.2, delay: 0.09 }); },
  capture:   () => [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, dur: 0.16, type: 'triangle', gain: 0.28, delay: i * 0.1 })),
  lose:      () => [392, 330, 262].forEach((f, i) => tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.25, delay: i * 0.14 })),
  respawn:   () => tone({ freq: 440, dur: 0.1, type: 'triangle', gain: 0.2, slide: 220 }),
  click:     () => tone({ freq: 700, dur: 0.04, type: 'square', gain: 0.1 }),
};
