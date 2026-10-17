// Every player-facing key used in markup (index.html data-i18n*), code
// (main.js / ui.js / audio captions / rules messages) and content (chapters,
// stages, lessons, themes, presets, challenges, achievements) exists in all
// nine locales with the same {placeholders}. DUMP=1 lists the keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STRINGS, EN } from '../js/strings.js';
import { JOURNEY, JOURNEY_CHAPTERS, LESSONS, THEMES, CHALLENGE_TYPES, PRACTICE_PRESETS } from '../js/content.js';
import { INVALID_MESSAGES } from '../js/rules.js';

const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const lit = /'((?:[^'\\]|\\.)*)'/.source;
const all = (src, re, keys, groups = [1]) => { for (const m of src.matchAll(re)) for (const g of groups) if (m[g] != null) keys.add(m[g].replace(/\\'/g, "'")); };

export function usedKeys() {
  const keys = new Set();
  const html = read('index.html');
  all(html, /data-i18n(?:-aria|-placeholder|-title)?="([^"]*)"/g, keys);
  for (const k of [...keys]) { keys.delete(k); keys.add(unescape(k)); }
  const main = read('js/main.js');
  const ui = read('js/ui.js');
  for (const src of [main, ui]) {
    all(src, new RegExp(`\\bt\\(${lit}`, 'g'), keys);
    all(src, new RegExp(`\\bt\\([^()]*?\\?\\s*${lit}\\s*:\\s*${lit}`, 'g'), keys, [1, 2]);
  }
  all(main, new RegExp(`name: ${lit}, desc: ${lit}`, 'g'), keys, [1, 2]);       // achievements
  all(main, new RegExp(`label: ${lit}, def:`, 'g'), keys);                       // binding labels
  all(main, new RegExp(`\\[\\d, ${lit}\\]`, 'g'), keys);                          // challenge levels
  all(main, new RegExp(`\\[${lit}, (?:t\\(|'★|fmtTime|content\\.|r\\.)`, 'g'), keys); // setup rows
  all(main.slice(main.indexOf('const RESULT_REASONS'), main.indexOf('function captionText')), new RegExp(`: ${lit}`, 'g'), keys);
  all(ui, new RegExp(`\\[${lit}, (?:breakdown\\.|num\\(|s\\.|mins|t\\()`, 'g'), keys);  // results + profile rows
  all(ui.slice(ui.indexOf('setSyncStatus(status)'), ui.indexOf('renderRivals(')), new RegExp(`: ${lit}`, 'g'), keys);
  all(read('js/audio.js'), new RegExp(`this\\.caption\\(${lit}\\)`, 'g'), keys);
  keys.add('Combo {n}'); keys.add('Malformed command.');
  for (const v of Object.values(INVALID_MESSAGES)) keys.add(v);
  for (const c of JOURNEY_CHAPTERS) keys.add(c.name);
  for (const s of JOURNEY) keys.add(s.meta.title);
  for (const l of LESSONS) { keys.add(l.title); keys.add(l.intro); for (const st of l.steps) keys.add(st.text); }
  for (const th of THEMES) keys.add(th.name);
  for (const c of Object.values(CHALLENGE_TYPES)) { keys.add(c.label); keys.add(c.blurb); }
  for (const p of Object.values(PRACTICE_PRESETS)) { keys.add(p.label); keys.add(p.blurb); }
  for (const m of ['learn', 'journey', 'daily', 'practice', 'challenge', 'score-chase']) keys.add('mode.' + m);
  for (const w of ['speed', 'precision', 'sequence']) keys.add('twist.' + w);
  for (const k of ['Daily — {date}', 'Daily — {date} ({twist})', 'Practice — {preset}', 'Score Chase — Week {week}']) keys.add(k);
  for (const k of [...keys]) if (k === '' || /^(mode|twist)\.$/.test(k)) keys.delete(k);
  return keys;
}

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every used key exists in every translated locale with matching placeholders', () => {
  const keys = usedKeys();
  if (process.env.DUMP) console.log([...keys].sort().map((k) => JSON.stringify(k)).join('\n'));
  assert.ok(keys.size > 250, 'key scan found ' + keys.size);
  const missing = [];
  for (const loc of LOCALES) {
    if (loc.startsWith('en-')) continue;
    for (const k of keys) {
      const v = STRINGS[loc][k];
      if (typeof v !== 'string' || !v) missing.push(loc + ': ' + k);
      else if (ph(v) !== ph(EN[k] ?? k)) missing.push(loc + ' placeholders: ' + k);
    }
  }
  assert.deepEqual(missing, []);
});

test('nine locales; en-GB overrides only real keys; symbolic keys have en-US text', () => {
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort());
  const keys = usedKeys();
  for (const k of Object.keys(STRINGS['en-GB'])) assert.ok(keys.has(k), 'unknown en-GB key ' + k);
  for (const k of keys) if (/^(mode|twist)\./.test(k)) assert.ok(EN[k], 'EN text for ' + k);
});
