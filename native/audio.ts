// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event, the quiet per-theme
// ambience (noise through a filter whose cutoff an LFO sweeps: hum, fire,
// wind, chime) and the adaptive music (a seeded four-chord pad loop of
// detuned triangles, with a sine pluck layer once the canvas is past 35 %).
// The browser build ran the ambience and the music live (a noise loop, an
// LFO and oscillators on a 200 ms timer); here they are rendered once into
// clips (createClip, a slice a frame) and looped on the music bus — the
// runtime has no ambience bus, so the ambience's gain carries the old
// ambience/music volume ratio (0.5 / 0.6) — and the pluck layer's clip fades
// with the intensity. The LFO rates are rounded to whole cycles of the 20 s
// ambience loop (hum 0.1 Hz, wind 0.05, fire 0.9, chime 0.05). The
// oscillator fallbacks it played while a sample decoded are not ported (a
// live synthesis graph makes clip loads fail on the web runtime): a clip
// still loading is silent. Captions (a game option) and haptics still run
// when the runtime mutes the sound, as before. The runtime's Options own the
// volumes, the mute and the voice limit. Clips load once the mixer runs
// (natively at once, in a browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { vibrate } from "starhermit:input";
import { RNG } from "./game.ts";

/** audio.js SFX_SAMPLES. */
const SAMPLES: Record<string, string> = {
  "ui.tap": "ui-tap", "ui.back": "ui-back", "ui.open": "ui-open", select: "select-confirm",
  "fill.brush": "brush-fill", "fill.drag": "drag-fill", "fill.region": "region-fill", error: "error-buzz", invalid: "invalid-deny",
  combo: "combo-chime", undo: "undo-sweep", hint: "hint-sparkle", pause: "pause-click", resume: "resume-click",
  "lesson.step": "lesson-step", complete: "complete-fanfare", failed: "failed-fall",
};
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;
/** Captions for audio cues (main.ts shows them when the option is on). */
export let onCaption: ((text: string) => void) | null = null;
export function setCaptionHandler(fn: (text: string) => void): void { onCaption = fn; }
export let hapticsEnabled = true;
export function setHaptics(on: boolean): void { hapticsEnabled = on; }
function haptic(ms: number): void { if (hapticsEnabled) { try { vibrate(ms); } catch { /* no motor */ } } }

/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

/** audio.js play(event, { tier, combo }): the sample, then its caption and haptics. */
export function play(event: string, opts: { tier?: number; combo?: number } = {}): void {
  const name = SAMPLES[event];
  const clip = name ? clips.get(name) : undefined;
  if (clip && !suspended) {
    try { playClip(clip, { bus: "effects" }); } catch { clips.delete(name!); if (!queue.includes(name!)) queue.push(name!); }
  }
  if (event === "error") { onCaption?.("That cell does not take this color."); haptic(70); }
  else if (event === "combo") { if (Math.min(4, opts.tier ?? 1) >= 3) onCaption?.(`Combo ${opts.combo ?? ""}`.trim()); }
  else if (event === "complete") { onCaption?.("Canvas complete!"); haptic(200); }
  else if (event === "failed") onCaption?.("Round over.");
}

// -- the ambience ------------------------------------------------------------------------------
const RATE = 22050;
const AMB_SEC = 20, AMB_N = RATE * AMB_SEC;
interface AmbSpec { type: "lowpass" | "bandpass" | "highpass"; f: number; q: number; lfo: number; depth: number; gain: number }
/** audio.js startAmbience per kind (LFO rates rounded to whole cycles of the loop). */
const AMB: Record<string, AmbSpec> = {
  hum: { type: "lowpass", f: 220, q: Math.SQRT1_2, lfo: 0.1, depth: 60, gain: 0.05 },
  wind: { type: "bandpass", f: 400, q: 0.6, lfo: 0.05, depth: 250, gain: 0.05 },
  fire: { type: "bandpass", f: 900, q: 0.4, lfo: 0.9, depth: 120, gain: 0.035 },
  chime: { type: "highpass", f: 2000, q: Math.SQRT1_2, lfo: 0.05, depth: 800, gain: 0.02 },
};
const AMB_RATIO = 0.5 / 0.6;
interface AmbJob { kind: string; buf: Float32Array; pos: number; rng: { float(): number }; x1: number; x2: number; y1: number; y2: number; c: number[] }
let ambJob: AmbJob | null = null;
const ambClips = new Map<string, AudioClip>();
let ambKind: string | null = null;
let ambVoice: Sound | null = null, ambVoiceKind: string | null = null;
/** RBJ biquad coefficients (WebAudio's BiquadFilterNode). */
function coeffs(type: AmbSpec["type"], f: number, q: number): number[] {
  const w = 2 * Math.PI * Math.max(10, Math.min(RATE * 0.45, f)) / RATE, cw = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === "lowpass") { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
  else if (type === "highpass") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
  else { b0 = al; b1 = 0; b2 = -al; }
  const a0 = 1 + al;
  return [b0 / a0, b1 / a0, b2 / a0, (-2 * cw) / a0, (1 - al) / a0];
}
/** Renders `count` more samples of the ambience job (a half-second pre-roll warms the filter); true when done. */
function renderAmbience(count: number): boolean {
  const j = ambJob!;
  const s = AMB[j.kind]!;
  const pre = RATE / 2;
  const end = Math.min(AMB_N + pre, j.pos + count);
  for (; j.pos < end; j.pos++) {
    const n = (j.pos - pre + AMB_N) % AMB_N;
    if ((j.pos & 31) === 0) j.c = coeffs(s.type, s.f + s.depth * Math.sin(2 * Math.PI * s.lfo * (n / RATE)), s.q);
    const x = j.rng.float() * 2 - 1;
    const c = j.c;
    const y = c[0]! * x + c[1]! * j.x1 + c[2]! * j.x2 - c[3]! * j.y1 - c[4]! * j.y2;
    j.x2 = j.x1; j.x1 = x; j.y2 = j.y1; j.y1 = y;
    if (j.pos >= pre) j.buf[n] = y * s.gain * AMB_RATIO;
  }
  return j.pos >= AMB_N + pre;
}
/** audio.js startAmbience(kind): the theme's ambience (from the first round on, as before). */
export function setAmbience(kind: string): void { ambKind = AMB[kind] ? kind : "hum"; }

// -- the music -----------------------------------------------------------------------------------
const CHORD = 3.2, STEPS = 8, MUS_N = Math.round(RATE * CHORD * STEPS);
const padBuf = new Float32Array(MUS_N), pluckBuf = new Float32Array(MUS_N);
let musicSeed = "";
let musStep = 0;
let padClip: AudioClip | null = null, pluckClip: AudioClip | null = null;
let padVoice: Sound | null = null, pluckVoice: Sound | null = null;
let intensity = 0;
function hashSeed(seed: string): number { let h = 0; for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
/** One note: exponential rise from 0.0001 to `peak` at `rise`, fall to 0.0001 at `fall`, cut at `stop` (wraps round the loop). */
function note(buf: Float32Array, t0: number, f: number, cents: number, peak: number, rise: number, fall: number, stop: number, tri: boolean): void {
  const ff = f * Math.pow(2, cents / 1200);
  const start = Math.round(t0 * RATE), len = Math.round(stop * RATE);
  for (let i = 0; i < len; i++) {
    const t = i / RATE;
    const env = t < rise ? 0.0001 * Math.pow(peak / 0.0001, t / rise) : t < fall ? peak * Math.pow(0.0001 / peak, (t - rise) / (fall - rise)) : 0;
    const ph = (ff * t) % 1;
    const w = tri ? 1 - 4 * Math.abs(ph - 0.5) : Math.sin(ph * 2 * Math.PI);
    const k = (start + i) % MUS_N;
    buf[k] = buf[k]! + w * env;
  }
}
/** audio.js startMusic's scheduler, one chord step a call (8 steps: the progression twice, the pluck pattern once). */
function renderMusic(): boolean {
  if (musStep >= STEPS) return true;
  const h = hashSeed(musicSeed || "pixel-atelier");
  const roots = [0, -4, 3, -2].map((s) => 220 * Math.pow(2, s / 12));
  const progression = [0, 1, 2, 3].map((i) => roots[(h + i) % roots.length]!);
  const t = musStep * CHORD;
  const root = progression[musStep % progression.length]!;
  for (const [ratio, vol] of [[1, 0.05], [1.5, 0.035], [2, 0.025]] as const) {
    note(padBuf, t, root * ratio, musStep % 2 ? -4 : 4, vol, CHORD * 0.4, CHORD * 1.05, CHORD * 1.1, true);
  }
  const notes = [1, 1.5, 2, 3];
  for (let k = 0; k < 4; k++) {
    if ((h >> ((musStep + k) % 8)) & 1) note(pluckBuf, t + k * (CHORD / 4), root * 2 * notes[(h + musStep + k) % notes.length]!, 0, 0.05, 0.01, 0.4, 0.5, false);
  }
  musStep++;
  return false;
}
/** audio.js startMusic(seed): started once, at the first press (the theme's seed then). */
export function startMusic(seed: string): void { if (!musicSeed) musicSeed = seed; }
/** audio.js setMusicIntensity: the pluck layer plays past 0.35, at the intensity's level. */
export function setIntensity(v: number): void {
  const next = Math.max(0, Math.min(1, v));
  const was = intensity > 0.35 ? intensity : 0;
  intensity = next;
  const now = next > 0.35 ? next : 0;
  if (Math.abs(now - was) > 0.02 && !suspended) { try { pluckVoice?.fade(now, 0.5); } catch { /* gone */ } }
}
/** A hidden window silences the loops (audio.js suspend / resume). */
export function setSuspended(on: boolean): void {
  if (on === suspended) return;
  suspended = on;
  try {
    ambVoice?.fade(on ? 0 : 1, 0.2);
    padVoice?.fade(on ? 0 : 1, 0.2);
    pluckVoice?.fade(on || intensity <= 0.35 ? 0 : intensity, 0.2);
  } catch { /* gone */ }
}

/** Each frame: the clips once the mixer runs (one at a time), then the music and the ambience. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const n of Object.values(SAMPLES)) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => {
        console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`);
        loading = false;
      });
    }
    return;
  }
  if (loading) return;
  if (musicSeed && (!padClip || !pluckClip)) {
    if (!renderMusic()) return;
    try { padClip = createClip([padBuf], RATE); pluckClip = createClip([pluckBuf], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); musicSeed = ""; }
    return;
  }
  if (padClip && !padVoice) {
    try { padVoice = playClip(padClip, { bus: "music", gain: suspended ? 0 : 1, loop: true }); } catch { padVoice = null; }
    return;
  }
  if (pluckClip && !pluckVoice) {
    try { pluckVoice = playClip(pluckClip, { bus: "music", gain: suspended || intensity <= 0.35 ? 0 : intensity, loop: true }); } catch { pluckVoice = null; }
    return;
  }
  if (!ambKind) return;
  if (ambVoiceKind === ambKind) return;
  const have = ambClips.get(ambKind);
  if (!have) {
    if (!ambJob || ambJob.kind !== ambKind) {
      ambJob = { kind: ambKind, buf: new Float32Array(AMB_N), pos: 0, rng: new RNG(`ambience:${ambKind}`), x1: 0, x2: 0, y1: 0, y2: 0, c: [0, 0, 0, 0, 0] };
    }
    if (!renderAmbience(6000)) return;
    try { ambClips.set(ambKind, createClip([ambJob.buf], RATE)); } catch (e) { console.warn(`audio: ${String(e)}`); }
    ambJob = null;
    return;
  }
  try { ambVoice?.stop(); } catch { /* gone */ }
  try { ambVoice = playClip(have, { bus: "music", gain: suspended ? 0 : 1, loop: true }); ambVoiceKind = ambKind; } catch { ambVoice = null; }
}
