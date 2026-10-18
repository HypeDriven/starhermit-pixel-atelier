// gfx.js — graphics quality model: presets, per-category overrides, StarHermit
// hardware-level detection, per-preset budgets and a cost summary. Pure (no three.js), so the settings panel,
// the renderer and the unit tests agree on what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],       // studio environment reflections + clearcoat on cells
  particles: ['low', 'high'],       // fill-burst budget + drifting dust motes
  background: ['static', 'animated'], // holo ring, floating pixels, light shimmer
  detail: ['plain', 'detailed'],    // bevelled cells, props, table surface texture
};

// Each preset is a row of tiers plus a device-pixel-ratio cap.
const TABLE = {
  low: { dpr: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', particles: 'low', background: 'static', detail: 'plain' },
  balanced: { dpr: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  high: { dpr: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  ultra: { dpr: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
export const PARTICLE_CAP = { low: 96, high: 600 };

export const DEFAULT_GRAPHICS = Object.freeze({
  preset: 'auto', render_scale: 1, adaptive: true, show_fps: false,
  ...Object.fromEntries(Object.keys(CATEGORIES).map((c) => [c, 'preset'])),
});

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; js/gpu-level.js → window.StarHermitGpu, a classic script loaded before the game): Low from 0,
// Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  const sys = { webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') };
  if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
  return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Board, cells, picking
 * and rules are identical on every preset — only visuals change.
 *   material  cell shading: lambert (Low) / standard (Balanced) / clear-coated physical (High, Ultra;
 *             Reflections on — without reflections cells are Standard, Lambert on Low)
 *   table     detailed drafting-table texture size in px (roughness noise: half; Detail on)
 *   floaters  floating neon pixels around the table (Detail on)
 *   dust      dust motes (Particles high), scaled with the level
 *   sparks    fill-burst pool at Particles high (low: ≤ 96), scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', table: 128, floaters: 20, dust: 60, sparks: 240, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', table: 256, floaters: 32, dust: 100, sparks: 400, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', table: 512, floaters: 44, dust: 160, sparks: 600, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', table: 1024, floaters: 72, dust: 260, sparks: 900, bloomRes: 1, aoRes: 1 },
};
export const SPARK_MAX = 1800;
export const DUST_MAX = 520;

/** A preset's concrete budget for a hardware level (dust and spark counts scale ≤ 2× within the preset). */
export function budgetFor(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.dust = Math.min(DUST_MAX, Math.round(b.dust * k));
  return b;
}

/** Live burst-pool size for a resolved setting (Particles tier within the preset's budget). */
export function sparkCap(r) {
  return r.particles === 'high' ? r.budget.sparks : Math.min(PARTICLE_CAP.low, r.budget.sparks);
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = { preset, auto, dpr: row.dpr, scale: clamp(Number(s.render_scale) || 1, 0.5, 2) };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // The composer runs only when something needs it; otherwise the canvas renders directly.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Choosing a preset clears every per-category override. */
export function withPreset(saved, preset) {
  const out = { ...DEFAULT_GRAPHICS, ...(saved || {}), preset };
  for (const c of Object.keys(CATEGORIES)) out[c] = 'preset';
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

export function describe(r, pixels) {
  const parts = [
    r.shadows === 'off' ? 'no shadows' : `${SHADOW_MAP[r.shadows]}² shadows`,
    r.ao === 'off' ? null : r.ao === 'high' ? 'full ambient occlusion' : 'ambient occlusion',
    r.bloom === 'on' ? 'bloom' : null,
    r.reflections === 'on' ? 'reflections' : null,
    r.antialias === 'off' ? 'no anti-aliasing' : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Migrate the pre-preset save shape ({ tier, renderScale }) to the current one. */
export function migrateGraphics(g) {
  const src = g && typeof g === 'object' ? g : {};
  const out = { ...DEFAULT_GRAPHICS };
  for (const k of Object.keys(DEFAULT_GRAPHICS)) if (k in src) out[k] = src[k];
  if (!('preset' in src) && src.tier) {
    out.preset = src.tier === 'medium' ? 'balanced' : PRESETS.includes(src.tier) ? src.tier : 'auto';
  }
  if (!('render_scale' in src) && Number(src.renderScale)) out.render_scale = clamp(Number(src.renderScale), 0.5, 2);
  return out;
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
