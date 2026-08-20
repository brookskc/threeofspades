// audio.js — every sound is synthesized with WebAudio. No assets, no files.
let ctx = null, master = null;

export function initAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
}

// One shared noise buffer — allocating per gunshot was the main source of GC churn.
let _noise = null;
function noiseBuffer() {
  if (_noise) return _noise;
  const buf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return (_noise = buf);
}

// Positional audio: the game sets the listener pose once per frame, then
// sfx.at('dig', pos) pans/attenuates the named sound by bearing and range.
// _pan/_scale are set for the duration of one sfx call, then reset.
let listener = null; // { x, y, z, rx, rz } — position + unit right vector
let _pan = 0, _scale = 1;
export function setListener(l) { listener = l; }

// Filtered noise burst — the backbone of gunshots, digs, explosions.
function burst({ dur = 0.15, freq = 1200, q = 1, gain = 0.5, decay = 12 }) {
  if (!ctx) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer();
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain * _scale, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  src.connect(f).connect(g);
  if (_pan) { // one StereoPanner per audible burst: cheap at our voice counts
    const p = ctx.createStereoPanner();
    p.pan.value = _pan;
    g.connect(p).connect(master);
  } else g.connect(master);
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
  g.gain.setValueAtTime(gain * _scale, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g);
  if (_pan) {
    const p = ctx.createStereoPanner();
    p.pan.value = _pan;
    g.connect(p).connect(master);
  } else g.connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

export const sfx = {
  rifle:     () => { burst({ dur: 0.22, freq: 900,  gain: 0.7 }); tone({ freq: 140, dur: 0.1, type: 'sawtooth', gain: 0.25, slide: -90 }); },
  smg:       () => { burst({ dur: 0.1,  freq: 1400, gain: 0.45 }); tone({ freq: 200, dur: 0.06, type: 'square', gain: 0.12, slide: -120 }); },
  // Deeper, longer, louder than the rifle — a bolt-action round should read
  // as more powerful, not just a variant of the same bang. This entry
  // didn't exist when the sniper was added: sfx[t.key]() in player.js
  // indexes this object by the weapon's key with no fallback, so firing
  // the sniper threw (sfx.sniper is not a function) and aborted BEFORE
  // reaching either requestShoot or the aim-climb line — silent, no shot,
  // no felt recoil, all from the one missing entry.
  sniper:    () => { burst({ dur: 0.35, freq: 550, gain: 0.85 }); tone({ freq: 90, dur: 0.18, type: 'sawtooth', gain: 0.35, slide: -120 }); },
  dig:       () => burst({ dur: 0.08, freq: 500, gain: 0.5 }),
  crumble:   () => { burst({ dur: 0.45, freq: 260, gain: 0.6 }); tone({ freq: 90, dur: 0.4, type: 'sawtooth', gain: 0.2, slide: -40 }); },
  place:     () => tone({ freq: 300, dur: 0.06, type: 'triangle', gain: 0.25, slide: 120 }),
  hit:       () => tone({ freq: 900, dur: 0.05, type: 'square', gain: 0.18 }),
  // Confirmed kill: a bright two-note rising chime (sine, not the hit
  // tick's harsher square wave) — deliberately distinct so it reads as
  // "that one was different," not just a louder version of the same tick.
  kill:      () => { tone({ freq: 1100, dur: 0.1, type: 'sine', gain: 0.24 });
                      tone({ freq: 1650, dur: 0.16, type: 'sine', gain: 0.2, delay: 0.06 }); },
  hurt:      () => { tone({ freq: 220, dur: 0.15, type: 'sawtooth', gain: 0.3, slide: -140 }); },
  throw_:    () => burst({ dur: 0.09, freq: 2000, gain: 0.15 }),
  explosion: () => { burst({ dur: 0.9, freq: 500, gain: 1.0 }); tone({ freq: 70, dur: 0.7, type: 'sine', gain: 0.6, slide: -40 }); },
  pickup:    () => { tone({ freq: 520, dur: 0.09, gain: 0.22 }); tone({ freq: 780, dur: 0.12, gain: 0.22, delay: 0.09 }); },
  drop:      () => { tone({ freq: 500, dur: 0.09, gain: 0.2 }); tone({ freq: 320, dur: 0.12, gain: 0.2, delay: 0.09 }); },
  capture:   () => [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, dur: 0.16, type: 'triangle', gain: 0.28, delay: i * 0.1 })),
  lose:      () => [392, 330, 262].forEach((f, i) => tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.25, delay: i * 0.14 })),
  respawn:   () => tone({ freq: 440, dur: 0.1, type: 'triangle', gain: 0.2, slide: 220 }),
  click:     () => tone({ freq: 700, dur: 0.04, type: 'square', gain: 0.1 }),
  step:      () => burst({ dur: 0.05, freq: 550 + Math.random() * 250, gain: 0.16 }),
  slide:     () => burst({ dur: 0.32, freq: 620, gain: 0.3, q: 0.7 }),
  // Positional variant: sfx.at('step', {x,y,z}) pans by bearing off the
  // listener's right ear and fades with distance; past 70 blocks, silence.
  // Quiet work sounds don't carry across the map: footsteps and shovels fade
  // fast and cut out close by; gunfire and explosions still travel.
  at(name, pos) {
    if (!ctx || !listener || !this[name]) return;
    const QUIET = { step: 24, dig: 30 };
    const cutoff = QUIET[name] ?? 70;
    const dx = pos.x - listener.x, dy = (pos.y ?? listener.y) - listener.y,
          dz = pos.z - listener.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > cutoff) return;
    _pan = d < 1.5 ? 0 : Math.max(-0.9, Math.min(0.9, (dx * listener.rx + dz * listener.rz) / d));
    _scale = 1 / (1 + d * (QUIET[name] ? 0.16 : 0.09));
    this[name]();
    _pan = 0; _scale = 1;
  },
};
