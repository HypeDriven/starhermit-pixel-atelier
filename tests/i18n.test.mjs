// Every player-facing key the engine client uses (T / N in native/*.ts, the
// results reasons, audio captions, rules messages) and the content's names
// (chapters, stages, lessons, themes, presets, challenges, achievements)
// exists in all nine locales with the same {placeholders}. DUMP=1 lists the
// keys; MISSING=1 prints the missing keys per locale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS, EN } from '../js/strings.js';
import { LOCALES, t, setLocale, contentTitle } from '../js/i18n.js';

import { usedKeys } from './i18n-keys.mjs';

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
  if (process.env.MISSING) console.log(missing.join('\n'));
  assert.deepEqual(missing, []);
});

test('nine locales; en-GB overrides only used keys; no unused rows', () => {
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort());
  const keys = usedKeys();
  for (const k of Object.keys(STRINGS['en-GB'])) assert.ok(keys.has(k), 'unknown en-GB key ' + k);
  for (const loc of LOCALES) for (const k of Object.keys(STRINGS[loc])) assert.ok(keys.has(k), `${loc}: unused key ${k}`);
});

test('translation switches and canvas titles localize', () => {
  setLocale('de-DE');
  assert.equal(t('{done} / {total} cells', { done: 1, total: 2 }), '1 / 2 Zellen');
  assert.ok(contentTitle('Daily — 2026-10-01 (speed)').includes('2026-10-01'));
  setLocale('xx');
  assert.equal(t('Play'), 'Play');
  setLocale('en-US');
});
