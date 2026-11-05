// The look per graphics level. The engine's level (levelSettings()) owns the
// effects: shadow map, AO, bloom, grade and anti-aliasing. The browser build's
// art per preset (js/gfx.js TABLE / BUDGETS: materials, table texture, floaters,
// detail) stays keyed by the quality tier, with the spark pool and the dust
// motes scaled by the level's particle budget against the tier's anchor level
// (at most 2×) and the table texture held to the level's maximum. The runtime
// owns the rest of what the old Graphics panel did: Auto and the level choice,
// render scale and the pixel-ratio cap, adaptive resolution, the frame-rate
// limit and readout. The old panel's per-effect overrides are not offered (the
// runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Cell shading: Lambert (Low), Standard (Balanced), clear-coated Physical (High, Ultra; with reflections). */
  material: "lambert" | "standard" | "physical";
  /** Detailed drafting-table texture size (roughness noise: half). */
  table: number;
  /** Floating neon pixels around the table (Detail on). */
  floaters: number;
  /** Dust motes (Particles high). */
  dust: number;
  /** Fill-burst pool at Particles high (low: ≤ 96). */
  sparks: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map: the level's size (0 = off). */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  particles: "low" | "high";
  /** Background animated: holo ring, floating pixels, dust drift, light shimmer. */
  animated: boolean;
  /** Bevelled cells, pylons, holo ring, floating pixels, the detailed table surface. */
  detailed: boolean;
  budget: Budget;
}

/** gfx.js TABLE, without the effects. */
type Art = Omit<Look, "preset" | "budget" | "shadows" | "ao" | "bloom" | "grade" | "antialias">;
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { reflections: true, particles: "high", animated: true, detailed: true },
  high: { reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { reflections: true, particles: "high", animated: true, detailed: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", table: 128, floaters: 20, dust: 60, sparks: 240 },
  balanced: { material: "standard", table: 256, floaters: 32, dust: 100, sparks: 400 },
  high: { material: "physical", table: 512, floaters: 44, dust: 160, sparks: 600 },
  ultra: { material: "physical", table: 1024, floaters: 72, dust: 260, sparks: 900 },
};
/** The level whose particle budget is each tier's own. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
export const SPARK_MAX = 1800, DUST_MAX = 520, PARTICLE_LOW = 96;

/** The look at a graphics level. Plain data: applyLook compares it by JSON. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.dust = Math.min(DUST_MAX, Math.round(b.dust * k));
  b.table = Math.min(b.table, s.maxTextureSize);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
/** gfx.js sparkCap: the preset's pool at Particles high, ≤ 96 at low. */
export function sparkCap(l: Look): number { return l.particles === "high" ? l.budget.sparks : Math.min(PARTICLE_LOW, l.budget.sparks); }
