// tests/gfx.test.mjs — graphics quality model (js/gfx.js). Run: node --test tests/gfx.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, CATEGORIES, DEFAULT_GRAPHICS, detectPreset, resolve, presetTier, describe, withPreset, migrateGraphics,
} from '../js/gfx.js';
import { gfxStrings, pickLocale, GFX_LOCALES } from '../js/gfx-panel.js';

test('detectPreset maps GPU strings to presets', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2 Pro'), 'high');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon RX 6800 XT)'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620)'), 'balanced');
  assert.equal(detectPreset('Mali-G78'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
  // Touch / mobile devices cap Auto at Balanced.
  assert.equal(detectPreset('Apple M1', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
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
