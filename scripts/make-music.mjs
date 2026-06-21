// Generates the horror background score as a real, same-origin audio file
// (audio/horror.wav) so it loads with ZERO CDN dependency and — crucially —
// plays through the iOS silent/ring switch (HTML5 media playback does; the
// Web Audio synth bed does NOT). Lazy-loaded on the play gesture, so it never
// touches initial page load.
//
// The track is a seamless 30 s loop: a dissonant low drone + sub rumble, slow
// swells, atonal high shimmer, wind, a slow double-thump heartbeat, and a
// couple of reverberant minor-2nd stingers. All tonal partials are snapped to
// the loop grid so the loop is click-free.
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SR = 22050, D = 30, N = SR * D;
const snap = (f) => Math.round(f * D) / D;          // → integer cycles over the loop
const TAU = Math.PI * 2;

// crude one-pole filters carried as closures (per channel)
function lp1() { let y = 0; return (x, a) => (y += a * (x - y)); }
function hp1() { let y = 0, px = 0; return (x, a) => { y = a * (y + x - px); px = x; return y; }; }

function makeChannel(seed, detune) {
  // deterministic noise
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };

  const drone = [           // freq, gain, type(0 sine|1 saw)
    [30, 0.20, 0], [55, 0.16, 1], [55.4, 0.13, 0], [73.42, 0.12, 1],
    [110, 0.09, 0], [220.6, 0.06, 1],
  ].map(([f, g, t]) => [snap(f * detune), g, t]);
  const shimmer = [1760, 1764, 2217].map((f) => snap(f * detune));

  const dlp = lp1();
  const whp = hp1(), wlp = lp1();

  // heartbeat double-thumps placed away from the seam
  const beats = [];
  for (let t = 3; t < D - 2; t += 3.7) { beats.push([t, 0.5]); beats.push([t + 0.33, 0.34]); }
  // dissonant stingers (root + minor 2nd) with long decay
  const stings = [[8.0, 196], [19.5, 233]];

  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    // --- low drone through a slowly opening lowpass ---
    let tone = 0;
    for (const [f, g, ty] of drone) {
      const ph = (f * t) % 1;
      tone += g * (ty ? (2 * ph - 1) : Math.sin(TAU * ph));   // saw or sine
    }
    const amp = 0.72 + 0.28 * Math.sin(TAU * snap(0.05) * t);
    const fc = 170 + 120 * Math.sin(TAU * snap(0.037) * t + 1);
    let v = dlp(tone * amp, Math.min(0.9, TAU * fc / SR));

    // --- high atonal shimmer (tremolo) ---
    let hi = 0;
    for (const f of shimmer) { const ph = (f * t) % 1; hi += (2 * ph - 1); }
    v += hi * 0.011 * (0.5 + 0.5 * Math.sin(TAU * snap(5.5) * t));

    // --- wind: band-passed noise with a slow gust envelope ---
    let w = rnd();
    w = whp(w, 0.10); w = wlp(w, 0.05);
    v += w * 0.06 * (0.55 + 0.45 * Math.sin(TAU * snap(0.03) * t + seed));

    // --- heartbeat double-thump ---
    for (const [tb, peak] of beats) {
      const dt = t - tb;
      if (dt >= 0 && dt < 0.36) {
        const fr = 62 - 26 * Math.min(1, dt / 0.2);
        const env = peak * Math.exp(-dt * 9);
        v += Math.sin(TAU * fr * dt) * env * 0.9;
      }
    }

    // --- reverberant minor-2nd stinger ---
    for (const [ts, root] of stings) {
      const dt = t - ts;
      if (dt >= 0 && dt < 5) {
        const env = (dt < 1.4 ? dt / 1.4 : Math.max(0, 1 - (dt - 1.4) / 3.6)) * 0.05;
        v += (Math.sin(TAU * snap(root * detune) * t) + Math.sin(TAU * snap(root * 1.059 * detune) * t)) * env;
      }
    }
    out[i] = v;
  }
  return out;
}

const L = makeChannel(1337, 1.0), R = makeChannel(99173, 1.004);

// normalise to avoid clipping
let peak = 1e-6;
for (let i = 0; i < N; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
const norm = 0.89 / peak;

// interleaved 16-bit PCM WAV
const bytes = 44 + N * 2 * 2;
const buf = Buffer.alloc(bytes);
buf.write("RIFF", 0); buf.writeUInt32LE(bytes - 8, 4); buf.write("WAVE", 8);
buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2 * 2, 28);
buf.writeUInt16LE(2 * 2, 32); buf.writeUInt16LE(16, 34);
buf.write("data", 36); buf.writeUInt32LE(N * 2 * 2, 40);
let o = 44;
for (let i = 0; i < N; i++) {
  const l = Math.max(-1, Math.min(1, L[i] * norm)) * 32767;
  const r = Math.max(-1, Math.min(1, R[i] * norm)) * 32767;
  buf.writeInt16LE(l | 0, o); buf.writeInt16LE(r | 0, o + 2); o += 4;
}
await mkdir(join(ROOT, "audio"), { recursive: true });
await writeFile(join(ROOT, "audio", "horror.wav"), buf);
console.log(`wrote audio/horror.wav — ${(bytes / 1048576).toFixed(2)} MB, ${D}s stereo @ ${SR}Hz`);
