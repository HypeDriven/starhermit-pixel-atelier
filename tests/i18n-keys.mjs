// The player-facing keys the engine client uses (shared by tests/i18n.test.mjs and tools/i18n-prune.mjs).
import { readFileSync, readdirSync } from 'node:fs';
import { JOURNEY, JOURNEY_CHAPTERS, LESSONS, THEMES, CHALLENGE_TYPES, PRACTICE_PRESETS } from '../js/content.js';
import { INVALID_MESSAGES } from '../js/rules.js';
import { ACHIEVEMENTS } from '../js/progress.js';

const NATIVE = new URL('../native/', import.meta.url);

export function usedKeys() {
  const keys = new Set();
  for (const f of readdirSync(NATIVE).filter((n) => n.endsWith('.ts'))) {
    const s = readFileSync(new URL(f, NATIVE), 'utf8');
    for (const m of s.matchAll(/\b[TN]\("((?:[^"\\]|\\.)*)"/g)) keys.add(m[1]);
    for (const m of s.matchAll(/onCaption\?\.\("([^"]+)"\)/g)) keys.add(m[1]);
  }
  const main = readFileSync(new URL('main.ts', NATIVE), 'utf8');
  for (const m of main.slice(main.indexOf('RESULT_REASONS: Record'), main.indexOf('export const app')).matchAll(/: "([^"]+)"/g)) keys.add(m[1]);
  keys.add('Combo {n}');
  for (const v of Object.values(INVALID_MESSAGES)) keys.add(v);
  for (const c of JOURNEY_CHAPTERS) keys.add(c.name);
  for (const s of JOURNEY) keys.add(s.meta.title);
  for (const l of LESSONS) { keys.add(l.title); keys.add(l.intro); for (const st of l.steps) keys.add(st.text); }
  for (const th of THEMES) keys.add(th.name);
  for (const c of Object.values(CHALLENGE_TYPES)) { keys.add(c.label); keys.add(c.blurb); }
  for (const p of Object.values(PRACTICE_PRESETS)) { keys.add(p.label); keys.add(p.blurb); }
  for (const a of ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  for (const m of ['learn', 'journey', 'daily', 'practice', 'challenge', 'score-chase']) keys.add('mode.' + m);
  for (const w of ['speed', 'precision', 'sequence']) keys.add('twist.' + w);
  for (const k of ['Daily — {date}', 'Daily — {date} ({twist})', 'Practice — {preset}', 'Score Chase — Week {week}']) keys.add(k);
  keys.delete('');
  return keys;
}

