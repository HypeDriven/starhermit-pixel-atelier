// Drops js/strings.js rows the engine client no longer uses (tests/i18n-keys.mjs)
// and adds the rows in a JSON file { locale-table-name: { key: text } } (DE, ES,
// FR, PT, IT, ES_ES, FR_CA, EN_GB) before each table's closing brace.
//   node tools/i18n-prune.mjs [additions.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { usedKeys } from '../tests/i18n-keys.mjs';

const file = new URL('../js/strings.js', import.meta.url);
const keys = usedKeys();
const add = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : {};
let table = null, dropped = 0;
const out = [];
for (const line of readFileSync(file, 'utf8').split('\n')) {
  const open = /^const (\w+) = \{$/.exec(line);
  if (open) table = open[1];
  if (table && line === '};') {
    for (const [k, v] of Object.entries(add[table] ?? {})) out.push(`  ${JSON.stringify(k).replace(/^"|"$/g, "'").replace(/\\"/g, '"')}: ${quote(v)},`);
    table = null;
  }
  const row = /^  '((?:[^'\\]|\\.)*)': /.exec(line);
  if (table && row && !keys.has(row[1].replace(/\\'/g, "'"))) { dropped++; continue; }
  out.push(line);
}
function quote(v) { return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; }
writeFileSync(file, out.join('\n'));
console.log(`dropped ${dropped} unused rows`);
