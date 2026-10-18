// tests/gfx.test.mjs — graphics quality model (js/gfx.js). Run: node --test tests/gfx.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// js/gpu-level.js is a classic script in the page (window.StarHermitGpu); evaluate it the same way here.
new Function('window', 'module', readFileSync(new URL('../js/gpu-level.js', import.meta.url), 'utf8'))(globalThis, undefined);
const {
  PRESETS, CATEGORIES, DEFAULT_GRAPHICS, LEVELS, BUDGETS, SPARK_MAX, DUST_MAX, detectPreset, detectLevel, presetForLevel, budgetFor, sparkCap,
  resolve, presetTier, describe, withPreset, migrateGraphics,
} = await import('../js/gfx.js');
const { gfxStrings, pickLocale, GFX_LOCALES } = await import('../js/gfx-panel.js');

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(detectPreset('', DESK), 'low', 'no WebGL');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(detectPreset('Apple M2', PHONE), 'balanced');
  assert.equal(detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'table', 'floaters', 'dust', 'sparks', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) for (const k of keys) {
    if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[PRESETS[i]][k] >= BUDGETS[PRESETS[i - 1]][k], `${PRESETS[i]}.${k}`);
  }
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].bloomRes), [0.5, 0.5, 0.5, 1], 'half-res bloom below Ultra');
  assert.deepEqual(resolve({ preset: 'high' }, 'low', 10).budget, BUDGETS.high, 'floor level = the tuned budget');
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, resolve({ preset: 'ultra' }, 'ultra', 17).budget);
  assert.ok(budgetFor('balanced', 9).dust > budgetFor('balanced', 4).dust, 'counts scale up within the preset');
  assert.ok(budgetFor('ultra', 20).sparks <= SPARK_MAX && budgetFor('ultra', 20).dust <= DUST_MAX);
  assert.equal(sparkCap(resolve({ preset: 'high' }, 'low', 10)), BUDGETS.high.sparks);
  assert.equal(sparkCap(resolve({ preset: 'low' }, 'low', 0)), 96, 'Low: particles low');
  assert.equal(resolve({}, 'low', 0).budget.material, 'lambert', 'headless SwiftShader: Low, Lambert');
});

test('resolve: auto uses the detected preset, explicit preset wins', () => {
  const a = resolve({}, 'high');
  assert.equal(a.preset, 'high');
  assert.equal(a.auto, true);
  const b = resolve({ preset: 'low' }, 'high');
  assert.equal(b.preset, 'low');
  assert.equal(b.auto, false);
  assert.equal(b.shadows, 'off');
  assert.equal(b.post, false, 'Low renders without a composer');
  assert.equal(b.dpr, 1);
  const u = resolve({ preset: 'ultra' }, 'low');
  assert.equal(u.shadows, 'high');
  assert.equal(u.ao, 'high');
  assert.equal(u.post, true);
  assert.equal(resolve({ preset: 'bogus' }, undefined).preset, 'balanced');
});

test('resolve: overrides apply per category; invalid tiers fall back to the preset', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'nope', particles: 'high' }, 'low');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'off');
  assert.equal(r.particles, 'high');
  assert.equal(r.post, true, 'bloom override turns the post chain on');
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    for (const p of PRESETS) assert.ok(tiers.includes(presetTier(p, cat)), `${p}.${cat}`);
  }
});

test('resolve: render scale clamps to 50–200 %, adaptive defaults on, fps off', () => {
  assert.equal(resolve({ render_scale: 5 }, 'low').scale, 2);
  assert.equal(resolve({ render_scale: 0.1 }, 'low').scale, 0.5);
  assert.equal(resolve({ render_scale: 1.25 }, 'low').scale, 1.25);
  assert.equal(resolve({}, 'low').scale, 1);
  assert.equal(resolve({}, 'low').adaptive, true);
  assert.equal(resolve({ adaptive: false }, 'low').adaptive, false);
  assert.equal(resolve({}, 'low').showFps, false);
  assert.equal(resolve({ show_fps: true }, 'low').showFps, true);
});

test('choosing a preset clears overrides but keeps scale / toggles', () => {
  const saved = { ...DEFAULT_GRAPHICS, preset: 'low', bloom: 'on', ao: 'high', render_scale: 1.5, show_fps: true };
  const next = withPreset(saved, 'high');
  assert.equal(next.preset, 'high');
  for (const c of Object.keys(CATEGORIES)) assert.equal(next[c], 'preset');
  assert.equal(next.render_scale, 1.5);
  assert.equal(next.show_fps, true);
  assert.equal(resolve(next, 'low').ao, 'on');
});

test('describe and legacy migration', () => {
  const d = describe(resolve({ preset: 'high' }, 'low'), [1280, 800]);
  assert.match(d, /2048² shadows/);
  assert.match(d, /1280×800 px/);
  assert.match(describe(resolve({ preset: 'low' }, 'low')), /no shadows/);
  assert.equal(migrateGraphics({ tier: 'medium', renderScale: 1 }).preset, 'balanced');
  assert.equal(migrateGraphics({ tier: 'auto' }).preset, 'auto');
  assert.equal(migrateGraphics(undefined).preset, 'auto');
  assert.equal(migrateGraphics({ preset: 'ultra', bloom: 'off' }).bloom, 'off');
});

test('panel strings exist in every required locale', () => {
  for (const loc of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
    assert.ok(GFX_LOCALES.includes(loc), loc);
    const T = gfxStrings(loc);
    for (const k of ['graphics', 'quality', 'auto', 'renderScale', 'fromPreset', 'adaptive', 'showFps', 'postUnavailable', ...PRESETS]) {
      assert.ok(typeof T[k] === 'string' && T[k].length, `${loc}.${k}`);
    }
    for (const c of Object.keys(CATEGORIES)) assert.ok(T.cat[c], `${loc}.cat.${c}`);
    for (const tiers of Object.values(CATEGORIES)) for (const t of tiers) assert.ok(T.tier[t], `${loc}.tier.${t}`);
  }
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('pt-PT'), 'pt-BR');
  assert.equal(pickLocale('ja-JP'), 'en-US');
});
