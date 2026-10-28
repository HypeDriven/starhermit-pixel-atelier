// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU its
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the spark pool and the dust motes scaled within the tier by the level
// (frame().levelIndex, at most 2×), as the browser build scaled them by its
// hardware level. The runtime owns the rest of what the old Graphics panel
// did: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout. The old panel's
// per-effect overrides are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
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

/** gfx.js TABLE (Low rendered with MSAA, as its canvas was). */
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, particles: "high", animated: true, detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, particles: "high", animated: true, detailed: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", table: 128, floaters: 20, dust: 60, sparks: 240, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", table: 256, floaters: 32, dust: 100, sparks: 400, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", table: 512, floaters: 44, dust: 160, sparks: 600, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", table: 1024, floaters: 72, dust: 260, sparks: 900, bloomRes: 1, aoRes: 1 },
};
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
export const SPARK_MAX = 1800, DUST_MAX = 520, PARTICLE_LOW = 96;

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.dust = Math.min(DUST_MAX, Math.round(b.dust * k));
  return { preset, ...TABLE[preset], budget: b };
}
/** gfx.js sparkCap: the preset's pool at Particles high, ≤ 96 at low. */
export function sparkCap(l: Look): number { return l.particles === "high" ? l.budget.sparks : Math.min(PARTICLE_LOW, l.budget.sparks); }
