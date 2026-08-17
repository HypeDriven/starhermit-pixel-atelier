// content.js — versioned content: authored pixel arts, procedural generator,
// journey progression, daily/practice/challenge builders, themes, tutorials,
// and offline validators. No DOM access; safe to import from Node.

import { RNG, cyrb53 } from './rng.js';

export const CONTENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

export function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

// Accessibility palette remaps. Index 0 (canvas background) is preserved.
const RAMP_CONTRAST = ['#ffd166', '#06d6a0', '#ef476f', '#118ab2', '#f78c6b', '#c77dff', '#8ac926', '#f4f1de'];
const RAMP_CVD = ['#e69f00', '#56b4e9', '#009e73', '#f0e442', '#0072b2', '#d55e00', '#cc79a7', '#999999'];

export function remapPalette(palette, mode) {
  if (mode === 'contrast') {
    return palette.map((c, i) => (i === 0 ? c : RAMP_CONTRAST[(i - 1) % RAMP_CONTRAST.length]));
  }
  if (mode === 'cvd') {
    return palette.map((c, i) => (i === 0 ? c : RAMP_CVD[(i - 1) % RAMP_CVD.length]));
  }
  return palette.slice();
}

// ---------------------------------------------------------------------------
// Authored arts. '.' is always index 0 (canvas background).
// ---------------------------------------------------------------------------

const ARTS = [
  {
    id: 'sprout', title: 'First Sprout', w: 12, h: 12,
    palette: ['#101828', '#3fd68f', '#9ef01a', '#8b5e34'],
    map: { '.': 0, s: 1, l: 2, g: 3 },
    rows: [
      '............',
      '............',
      '.....ll.....',
      '....llll....',
      '....llll....',
      '.....ll.....',
      '......s.....',
      '.l...s...l..',
      '.ll..s..ll..',
      '..ll.s.ll...',
      '......s.....',
      '.gggggggggg.',
    ],
  },
  {
    id: 'mug', title: 'Beacon Mug', w: 12, h: 12,
    palette: ['#14101f', '#ff6b6b', '#c9184a', '#a9d6e5'],
    map: { '.': 0, b: 1, h: 2, w: 3 },
    rows: [
      '............',
      '..w.....w...',
      '...w...w....',
      '..w.....w...',
      '............',
      '..bbbbbb....',
      '..bbbbbb.h..',
      '..bbbbbbhh..',
      '..bbbbbb.h..',
      '..bbbbbb....',
      '..bbbbbb....',
      '...bbbb.....',
    ],
  },
  {
    id: 'rocket', title: 'Ion Rocket', w: 14, h: 14,
    palette: ['#0d1b2a', '#e0fbfc', '#ee6c4d', '#3d5a80', '#ffb703'],
    map: { '.': 0, w: 1, r: 2, p: 3, o: 4, f: 2 },
    rows: [
      '......rr......',
      '.....rrrr.....',
      '....rrrrrr....',
      '....wwwwww....',
      '...wwwwwwww...',
      '...wwppppww...',
      '...wwppppww...',
      '...wwwwwwww...',
      '..f.wwwwww.f..',
      '.fffwwwwwwfff.',
      '.fffwwwwwwfff.',
      '....oooooo....',
      '.....oooo.....',
      '......oo......',
    ],
  },
  {
    id: 'fish', title: 'Tide Glider', w: 14, h: 14,
    palette: ['#081c30', '#2ec4b6', '#cbf3f0', '#1d7a8c', '#ffffff'],
    map: { '.': 0, b: 1, u: 2, t: 3, e: 4 },
    rows: [
      '..............',
      '..............',
      '......tt......',
      '.....bbbb.....',
      '...bbbbbbbb...',
      '..tbbbbbebb...',
      '.ttbbbbbbbb...',
      '.tttbbbbubb...',
      '.tttbbbuuub...',
      '..ttbbbuub....',
      '....bbbubb....',
      '.....bbbb.....',
      '..............',
      '..............',
    ],
  },
  {
    id: 'shroom', title: 'Lantern Shroom', w: 16, h: 16,
    palette: ['#160f29', '#f72585', '#ffd166', '#e5e5e5', '#7b2cbf'],
    map: { '.': 0, c: 1, d: 2, s: 3, g: 4 },
    rows: [
      '................',
      '.....cccccc.....',
      '...cccccccccc...',
      '..ccddccccddcc..',
      '.ccddddccddddcc.',
      '.cccccccccccccc.',
      '..cccccccccccc..',
      '....ssssssss....',
      '.....ssssss.....',
      '.....ssssss.....',
      '.....ssssss.....',
      '....ssssssss....',
      '....gggggggg....',
      '...gggggggggg...',
      '................',
      '................',
    ],
  },
  {
    id: 'owl', title: 'Night Warden', w: 16, h: 16,
    palette: ['#0b1426', '#83580b', '#f5b942', '#fff3b0', '#3e1f47', '#ffffff'],
    map: { '.': 0, b: 1, w: 2, e: 3, k: 4, g: 5 },
    rows: [
      '................',
      '..bb........bb..',
      '..bbbb....bbbb..',
      '..bbbbbbbbbbbb..',
      '..bbwwbbwwbbbb..',
      '..bbwegbwegbbb..',
      '..bbwwbbwwbbbb..',
      '..bbbbkkbbbbbb..',
      '..bbbbbbbbbbbb..',
      '..bbbbbbbbbbbb..',
      '...bbbbbbbbbb...',
      '...bbbbbbbbbb...',
      '....bb....bb....',
      '...ggg....ggg...',
      '................',
      '................',
    ],
  },
  {
    id: 'boat', title: 'Paper Regatta', w: 16, h: 16,
    palette: ['#0a2540', '#ffffff', '#ff8fa3', '#ffb703', '#219ebc'],
    map: { '.': 0, s: 1, r: 2, h: 3, w: 4 },
    rows: [
      '................',
      '.......s........',
      '.......ss.......',
      '.......sss......',
      '.......ssss.....',
      '.......ssssr....',
      '.......ssssrr...',
      '.......ssssrrr..',
      '.......ssssrrrr.',
      '.......ssssrrrrr',
      '................',
      '..hhhhhhhhhhhh..',
      '...hhhhhhhhhh...',
      '....hhhhhhhh....',
      '.wwwwwwwwwwwwww.',
      'wwwwwwwwwwwwwwww',
    ],
  },
  {
    id: 'planet', title: 'Quiet Orbit', w: 18, h: 18,
    palette: ['#0b0b1e', '#7209b7', '#b5179e', '#f72585', '#4cc9f0', '#ffd166'],
    map: { '.': 0, p: 1, m: 2, h: 3, r: 4, s: 5 },
    rows: [
      '..................',
      '...s..............',
      '.........s........',
      '......pppppp......',
      '....pppppppppp....',
      '...ppmmmpppppp....',
      '..pppmmmmmpppph...',
      '..pppmmmmppphhh...',
      '.rrppmmmmphhhhhr..',
      'rrrrppppphhhhrrrrr',
      '.rrrppppphhhrrrr..',
      '..pppphhhhhppr....',
      '..pppphhhppppr....',
      '...pppppppppp.....',
      '....pppppppp..s...',
      '......pppppp......',
      '..............s...',
      '..................',
    ],
  },
];

export function getArt(id) {
  return ARTS.find((a) => a.id === id) || null;
}

function artToContent(art, overrides = {}) {
  const targets = new Array(art.w * art.h);
  for (let y = 0; y < art.h; y++) {
    const row = art.rows[y];
    for (let x = 0; x < art.w; x++) {
      const ch = row[x] ?? '.';
      const idx = art.map[ch];
      if (idx == null) throw new Error(`art ${art.id}: unmapped char '${ch}' at ${x},${y}`);
      targets[y * art.w + x] = idx;
    }
  }
  return {
    id: overrides.id || `art-${art.id}`,
    version: CONTENT_VERSION,
    seed: overrides.seed || `art:${art.id}`,
    width: art.w,
    height: art.h,
    palette: art.palette.slice(),
    targets,
    artId: art.id,
    title: overrides.title || art.title,
  };
}

// ---------------------------------------------------------------------------
// Procedural generator — mirrored blob fauna ("glimmerkin"), deterministic.
// ---------------------------------------------------------------------------

const GEN_NAMES_A = ['Amber', 'Velvet', 'Static', 'Lumen', 'Cinder', 'Moss', 'Prism', 'Tidal'];
const GEN_NAMES_B = ['Glimmer', 'Wisp', 'Mote', 'Sprite', 'Drifter', 'Bloom', 'Imp', 'Comet'];

export function generateArt(seedStr, size = 16, colorN = 4) {
  const rng = new RNG('gen:' + seedStr);
  size = Math.max(8, Math.min(24, size));
  colorN = Math.max(3, Math.min(6, colorN));
  const half = Math.ceil(size / 2);
  let field = new Uint8Array(size * size);
  const set = (x, y, v) => { field[y * size + x] = v; if (x !== size - 1 - x) field[y * size + size - 1 - x] = v; };
  const get = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? 0 : field[y * size + x]);

  // Seed random noise on the left half, mirrored.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < half; x++) set(x, y, rng.chance(0.52) ? 1 : 0);
  }
  // Cellular smoothing → blobby silhouettes.
  for (let it = 0; it < 3; it++) {
    const next = new Uint8Array(field);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < half; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += get(x + dx, y + dy);
        next[y * size + x] = n >= 5 ? 1 : n <= 2 ? 0 : field[y * size + x];
      }
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < half; x++) {
      const v = next[y * size + x];
      field[y * size + x] = v; field[y * size + size - 1 - x] = v;
    }
  }
  // Keep the largest connected component.
  const comp = new Int32Array(size * size).fill(-1);
  let bestC = -1, bestN = 0, nc = 0;
  for (let i = 0; i < field.length; i++) {
    if (!field[i] || comp[i] >= 0) continue;
    const stack = [i]; comp[i] = nc; let n = 0;
    while (stack.length) {
      const c = stack.pop(); n++;
      const x = c % size;
      for (const d of [x > 0 ? c - 1 : -1, x < size - 1 ? c + 1 : -1, c - size, c + size]) {
        if (d >= 0 && d < field.length && field[d] && comp[d] < 0) { comp[d] = nc; stack.push(d); }
      }
    }
    if (n > bestN) { bestN = n; bestC = nc; }
    nc++;
  }
  for (let i = 0; i < field.length; i++) field[i] = comp[i] === bestC ? 1 : 0;
  if (bestN < size * size * 0.2) {
    // Fallback: stamp a diamond so content is never degenerate.
    const c = (size - 1) / 2, r = size * 0.4;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      field[y * size + x] = Math.abs(x - c) + Math.abs(y - c) <= r ? 1 : 0;
    }
  }

  // Assign colors: 1 body, 2 belly (lower interior), 3 accent spots, 4 eyes.
  const targets = new Array(size * size).fill(0);
  const rowsWithBody = [];
  for (let y = 0; y < size; y++) {
    let xs = [];
    for (let x = 0; x < size; x++) if (field[y * size + x]) xs.push(x);
    if (xs.length) rowsWithBody.push({ y, min: xs[0], max: xs[xs.length - 1], n: xs.length });
  }
  const yMin = rowsWithBody[0]?.y ?? 0;
  const yMax = rowsWithBody[rowsWithBody.length - 1]?.y ?? size - 1;
  const span = Math.max(1, yMax - yMin);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!field[i]) continue;
      const relY = (y - yMin) / span;
      let c = 1;
      const interior = get(x - 1, y) && get(x + 1, y) && get(x, y - 1) && get(x, y + 1);
      if (colorN >= 3 && relY > 0.55 && interior) c = 2; // belly
      targets[i] = c;
    }
  }
  if (colorN >= 4) {
    // Accent spots: a few random interior clusters.
    const spots = rng.int(2, 4);
    for (let s = 0; s < spots; s++) {
      const row = rng.pick(rowsWithBody.filter((r) => r.n >= 4)) || rowsWithBody[0];
      if (!row) break;
      const cx = rng.int(row.min + 1, row.max - 1);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = (row.y + dy) * size + cx + dx;
        if (i >= 0 && i < targets.length && field[i]) targets[i] = 3;
      }
    }
  }
  if (colorN >= 5) {
    // Eyes: symmetric pair in the upper third.
    const eyeRow = rowsWithBody.find((r) => (r.y - yMin) / span > 0.15 && r.n >= 6) || rowsWithBody[0];
    if (eyeRow) {
      const mid = (eyeRow.min + eyeRow.max) / 2;
      const off = Math.max(1, Math.round((eyeRow.max - eyeRow.min) / 4));
      for (const ex of [Math.floor(mid - off), Math.ceil(mid + off)]) {
        const i = eyeRow.y * size + ex;
        if (field[i]) targets[i] = 4;
      }
    }
  }

  // Compact: keep only semantic colors that were actually placed, renumber
  // densely, then derive hues per semantic slot (deterministic).
  const SEMANTIC_HUES = (hue) => ({
    1: hslToHex(hue, 0.72, 0.58),        // body
    2: hslToHex(hue + 30, 0.55, 0.78),   // belly
    3: hslToHex(hue + 160, 0.65, 0.6),   // spots
    4: '#f8f9fa',                        // eyes
    5: hslToHex(hue + 300, 0.7, 0.55),   // spare
  });
  const baseHue = rng.range(0, 360);
  const hues = SEMANTIC_HUES(baseHue);
  const usedSemantics = [...new Set(targets.filter((t) => t > 0))].sort((a, b) => a - b);
  const renumber = new Map(usedSemantics.map((sem, i) => [sem, i + 1]));
  for (let i = 0; i < targets.length; i++) {
    if (targets[i] > 0) targets[i] = renumber.get(targets[i]);
  }
  const palette = [hslToHex(baseHue + 220, 0.45, 0.08)];
  for (const sem of usedSemantics) palette.push(hues[sem]);

  return {
    id: `gen-${seedStr}-${size}-${colorN}`,
    version: CONTENT_VERSION,
    seed: `gen:${seedStr}:${size}:${colorN}`,
    width: size, height: size,
    palette, targets,
    generated: true,
    title: `${rng.pick(GEN_NAMES_A)} ${rng.pick(GEN_NAMES_B)}`,
  };
}

// ---------------------------------------------------------------------------
// Ruleset assembly, pars, difficulty
// ---------------------------------------------------------------------------

function regionCountPerColor(width, height, targets) {
  const seen = new Uint8Array(width * height);
  const counts = {};
  for (let i = 0; i < targets.length; i++) {
    if (seen[i]) continue;
    const color = targets[i];
    counts[color] = (counts[color] || 0) + 1;
    const stack = [i]; seen[i] = 1;
    while (stack.length) {
      const c = stack.pop();
      const x = c % width;
      for (const d of [x > 0 ? c - 1 : -1, x < width - 1 ? c + 1 : -1, c - width, c + width]) {
        if (d >= 0 && d < targets.length && !seen[d] && targets[d] === color) { seen[d] = 1; stack.push(d); }
      }
    }
  }
  return counts;
}

export function minimalActions(width, height, targets, regionAllowed) {
  if (!regionAllowed) return width * height;
  const counts = regionCountPerColor(width, height, targets);
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

export function makeContent(base, ruleset, meta = {}) {
  const cells = base.width * base.height;
  const regionAllowed = ruleset.tools?.region !== false;
  const minActs = minimalActions(base.width, base.height, base.targets, regionAllowed);
  const par = {
    timeMs: meta.parTimeMs ?? Math.round(cells * 650 + 15000),
    actions: meta.parActions ?? Math.max(minActs + 2, Math.round(minActs * 1.8)),
  };
  return {
    id: meta.id || base.id,
    version: CONTENT_VERSION,
    seed: meta.seed || base.seed,
    width: base.width,
    height: base.height,
    palette: base.palette.slice(),
    targets: base.targets.slice(),
    ruleset: {
      errorPrevention: ruleset.errorPrevention !== false,
      tools: { brush: true, drag: ruleset.tools?.drag !== false, region: regionAllowed },
      allowUndo: ruleset.allowUndo !== false,
      moveLimit: ruleset.moveLimit ?? null,
      timeLimitMs: ruleset.timeLimitMs ?? null,
      errorLimit: ruleset.errorLimit ?? null,
      sequence: ruleset.sequence === true,
    },
    par,
    meta: {
      title: meta.title || base.title || 'Untitled',
      theme: meta.theme || 'neon-draft',
      difficulty: meta.difficulty ?? 1,
      ranked: meta.ranked === true,
      mode: meta.mode || 'practice',
      tutorial: meta.tutorial || null,
      stageId: meta.stageId || null,
      seedInspectable: true,
    },
  };
}

export function difficultyOf(content) {
  const cells = content.width * content.height;
  let d = 1;
  if (cells > 140) d++;
  if (cells > 320) d++;
  if (content.palette.length > 5) d++;
  const r = content.ruleset;
  if (!r.errorPrevention || r.errorLimit != null) d++;
  if (r.moveLimit != null || r.timeLimitMs != null || r.sequence) d++;
  if (!r.tools.region) d++;
  return Math.max(1, Math.min(5, d));
}

// ---------------------------------------------------------------------------
// Offline validators — prove basic legality, reachable goals, bounded
// duration, and absence of soft locks before content ships.
// ---------------------------------------------------------------------------

export function validateContent(content, problems = []) {
  const fail = (msg) => { problems.push(`${content.id || '?'}: ${msg}`); };
  const { width: w, height: h } = content;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 6 || h < 6 || w > 26 || h > 26) fail(`dimensions ${w}x${h} out of range 6..26`);
  if (!Array.isArray(content.palette) || content.palette.length < 2 || content.palette.length > 8) fail('palette must have 2..8 colors');
  if (!Array.isArray(content.targets) || content.targets.length !== w * h) fail('targets length mismatch');
  else {
    const used = new Set(content.targets);
    for (const t of content.targets) {
      if (!Number.isInteger(t) || t < 0 || t >= content.palette.length) { fail('target out of palette range'); break; }
    }
    if (used.size < 2) fail('needs at least 2 used colors');
    for (let i = 0; i < content.palette.length; i++) {
      if (!used.has(i)) fail(`palette color ${i} is never used`);
    }
    if (!used.has(0)) fail('background color 0 must be used');
  }
  const r = content.ruleset;
  if (!r || r.tools?.brush !== true) fail('brush tool must always be available (soft-lock guard)');
  if (r) {
    const cells = w * h;
    const minActs = minimalActions(w, h, content.targets || [], r.tools?.region !== false);
    if (r.moveLimit != null) {
      if (r.moveLimit < minActs) fail(`move limit ${r.moveLimit} < minimum reachable ${minActs}`);
      if (r.moveLimit > cells * 2) fail('move limit unbounded (no challenge)');
    }
    if (r.timeLimitMs != null) {
      if (r.timeLimitMs < cells * 120) fail('time limit below human floor');
      if (r.timeLimitMs > 20 * 60 * 1000) fail('time limit unbounded');
    }
    if (r.errorLimit != null && (r.errorLimit < 1 || r.errorLimit > 50)) fail('error limit out of sane range');
    if (r.sequence && r.tools?.region !== false) fail('sequence ruleset requires region tool disabled');
  }
  if (content.par && content.par.timeMs > 20 * 60 * 1000) fail('par time unbounded');
  return problems;
}

// ---------------------------------------------------------------------------
// Learn (interactive lessons — one rule at a time, action required)
// ---------------------------------------------------------------------------

const LESSON_BOARDS = {
  l1: {
    id: 'lesson-1', title: 'Lesson Canvas', w: 6, h: 6,
    palette: ['#101828', '#ff6b6b', '#ffd166'],
    map: { '.': 0, a: 1, b: 2 },
    rows: [
      '.aa.aa',
      'aaaaaa',
      'aaaaaa',
      '.abba.',
      '..bb..',
      '...b..',
    ],
  },
  l2: {
    id: 'lesson-2', title: 'Lesson Canvas', w: 8, h: 6,
    palette: ['#101828', '#2ec4b6', '#f5b942'],
    map: { '.': 0, a: 1, b: 2 },
    rows: [
      '........',
      'aaaaaaaa',
      'aaaaaaaa',
      'bbbbbbbb',
      'bbbbbbbb',
      '........',
    ],
  },
  l3: {
    id: 'lesson-3', title: 'Lesson Canvas', w: 10, h: 8,
    palette: ['#101828', '#4cc9f0', '#f72585'],
    map: { '.': 0, a: 1, b: 2 },
    rows: [
      '..........',
      '...bbbb...',
      '..bbbbbb..',
      '..bbbbbb..',
      '..bbbbbb..',
      '...bbbb...',
      '.a......a.',
      '..........',
    ],
  },
  l4: {
    id: 'lesson-4', title: 'Lesson Canvas', w: 12, h: 10,
    palette: ['#101828', '#9ef01a', '#ff8fa3', '#e0fbfc'],
    map: { '.': 0, a: 1, b: 2, c: 3 },
    rows: [
      '............',
      '..a......b..',
      '..aa....bb..',
      '..aaa..bbb..',
      '..aaaaaaaa..',
      '...cccccc...',
      '....cccc....',
      '..cccccccc..',
      '............',
      '............',
    ],
  },
};

export const LESSONS = [
  {
    id: 'learn-1', title: 'Color & Fill', board: 'l1',
    intro: 'Every cell hides a target color. Pick a swatch, then paint the cells that want it.',
    steps: [
      { id: 'select', text: 'Select the red swatch (1) in the palette.', require: { type: 'select', color: 1 } },
      { id: 'fill', text: 'Paint 3 glowing cells with the brush — click or tap them.', require: { type: 'fills', n: 3 } },
      { id: 'finish', text: 'Finish the whole canvas. Cells that want your color glow.', require: { type: 'complete' } },
    ],
  },
  {
    id: 'learn-2', title: 'Drag-Fill', board: 'l2',
    intro: 'You can paint whole runs of cells in one stroke.',
    steps: [
      { id: 'drag', text: 'Press and drag across a glowing row to paint it in one stroke.', require: { type: 'stroke', minCells: 4 } },
      { id: 'finish', text: 'Drag through the rest — the brush only lands where the color belongs.', require: { type: 'complete' } },
    ],
  },
  {
    id: 'learn-3', title: 'Region Tool', board: 'l3',
    intro: 'The region tool floods every connected cell that shares a target color.',
    steps: [
      { id: 'region', text: 'Pick the region tool (bucket), then click the pink shape to flood it.', require: { type: 'region' } },
      { id: 'finish', text: 'Use the region tool or brush to finish the canvas.', require: { type: 'complete' } },
    ],
  },
  {
    id: 'learn-4', title: 'Navigate & Hint', board: 'l4',
    intro: 'Big canvases need camera control — and hints when you are stuck.',
    steps: [
      { id: 'zoom', text: 'Zoom in (wheel, pinch, or the + button) and pan the camera.', require: { type: 'camera' } },
      { id: 'hint', text: 'Press the hint button (or H) to highlight a legal cell.', require: { type: 'hint' } },
      { id: 'finish', text: 'Complete the canvas to finish your training.', require: { type: 'complete' } },
    ],
  },
];

export function lessonContent(lessonId) {
  const lesson = LESSONS.find((l) => l.id === lessonId);
  if (!lesson) return null;
  const art = LESSON_BOARDS[lesson.board];
  const base = artToContent(art, { id: lesson.id, seed: `lesson:${lesson.id}` });
  return {
    lesson,
    content: makeContent(base, { allowUndo: true }, {
      id: lesson.id, title: lesson.title, mode: 'learn', difficulty: 1,
      tutorial: lesson.id, theme: 'neon-draft', seed: base.seed,
    }),
  };
}

// ---------------------------------------------------------------------------
// Journey — 42 authored stages across 7 chapters (6th of each = mastery).
// ---------------------------------------------------------------------------

function stageBase(source) {
  if (source.art) return artToContent(getArt(source.art));
  return generateArt(source.gen.seed, source.gen.size, source.gen.colors);
}

const CHAPTERS = [
  { id: 'ch1', name: 'First Strokes', theme: 'neon-draft' },
  { id: 'ch2', name: 'Lift Off', theme: 'neon-draft' },
  { id: 'ch3', name: 'Tide & Sail', theme: 'ember-grid' },
  { id: 'ch4', name: 'Night Garden', theme: 'verdant-circuit' },
  { id: 'ch5', name: 'Quiet Orbit', theme: 'rose-quartz' },
  { id: 'ch6', name: 'Glimmer Fauna', theme: 'mono-blueprint' },
  { id: 'ch7', name: 'Master Atelier', theme: 'neon-draft' },
];

function buildJourney() {
  const stages = [];
  const add = (chapter, n, opts) => {
    const idx = stages.length + 1;
    const base = stageBase(opts.source);
    const content = makeContent(base, opts.ruleset || {}, {
      id: `j${String(idx).padStart(2, '0')}`,
      stageId: `j${String(idx).padStart(2, '0')}`,
      title: opts.title,
      mode: 'journey',
      theme: CHAPTERS[chapter - 1].theme,
      difficulty: opts.difficulty,
      seed: `journey:${idx}`,
      tutorial: opts.tutorial || null,
      parTimeMs: opts.parTimeMs,
      parActions: opts.parActions,
    });
    content.meta.chapter = chapter;
    content.meta.mastery = n === 6;
    stages.push(content);
    return content;
  };

  // Chapter 1 — First Strokes: brush, then drag, then region.
  add(1, 1, { title: 'First Sprout', source: { art: 'sprout' }, difficulty: 1, tutorial: 'brush' });
  add(1, 2, { title: 'Beacon Mug', source: { art: 'mug' }, difficulty: 1 });
  add(1, 3, { title: 'Warmup Drifter', source: { gen: { seed: 'j1-3', size: 10, colors: 3 } }, difficulty: 1 });
  add(1, 4, { title: 'Small Comet', source: { gen: { seed: 'j1-4', size: 12, colors: 4 } }, difficulty: 2 });
  add(1, 5, { title: 'Moss Imp', source: { gen: { seed: 'j1-5', size: 12, colors: 4 } }, difficulty: 2 });
  add(1, 6, { title: 'Mastery: Steady Hand', source: { art: 'mug' }, difficulty: 2, ruleset: { errorPrevention: false, errorLimit: 5 } });

  // Chapter 2 — Lift Off: bigger boards, region tool assumed.
  add(2, 1, { title: 'Ion Rocket', source: { art: 'rocket' }, difficulty: 2 });
  add(2, 2, { title: 'Static Wisp', source: { gen: { seed: 'j2-2', size: 14, colors: 4 } }, difficulty: 2 });
  add(2, 3, { title: 'Lumen Sprite', source: { gen: { seed: 'j2-3', size: 14, colors: 5 } }, difficulty: 2 });
  add(2, 4, { title: 'Cinder Mote', source: { gen: { seed: 'j2-4', size: 16, colors: 4 } }, difficulty: 3 });
  add(2, 5, { title: 'Velvet Bloom', source: { gen: { seed: 'j2-5', size: 16, colors: 5 } }, difficulty: 3 });
  add(2, 6, { title: 'Mastery: Countdown', source: { art: 'rocket' }, difficulty: 3, ruleset: { timeLimitMs: 120000 } });

  // Chapter 3 — Tide & Sail.
  add(3, 1, { title: 'Tide Glider', source: { art: 'fish' }, difficulty: 3 });
  add(3, 2, { title: 'Paper Regatta', source: { art: 'boat' }, difficulty: 3 });
  add(3, 3, { title: 'Tidal Imp', source: { gen: { seed: 'j3-3', size: 16, colors: 5 } }, difficulty: 3 });
  add(3, 4, { title: 'Prism Drifter', source: { gen: { seed: 'j3-4', size: 18, colors: 5 } }, difficulty: 3 });
  add(3, 5, { title: 'Amber Comet', source: { gen: { seed: 'j3-5', size: 18, colors: 5 } }, difficulty: 4 });
  add(3, 6, { title: 'Mastery: No Bucket', source: { art: 'fish' }, difficulty: 4, ruleset: { tools: { region: false }, moveLimit: 14 * 14 } });

  // Chapter 4 — Night Garden.
  add(4, 1, { title: 'Lantern Shroom', source: { art: 'shroom' }, difficulty: 3 });
  add(4, 2, { title: 'Night Warden', source: { art: 'owl' }, difficulty: 4 });
  add(4, 3, { title: 'Moss Sprite', source: { gen: { seed: 'j4-3', size: 18, colors: 5 } }, difficulty: 4 });
  add(4, 4, { title: 'Velvet Wisp', source: { gen: { seed: 'j4-4', size: 20, colors: 5 } }, difficulty: 4 });
  add(4, 5, { title: 'Static Bloom', source: { gen: { seed: 'j4-5', size: 20, colors: 6 } }, difficulty: 4 });
  add(4, 6, { title: 'Mastery: In Order', source: { art: 'shroom' }, difficulty: 4, ruleset: { sequence: true, tools: { region: false } } });

  // Chapter 5 — Quiet Orbit.
  add(5, 1, { title: 'Quiet Orbit', source: { art: 'planet' }, difficulty: 4 });
  add(5, 2, { title: 'Lumen Mote', source: { gen: { seed: 'j5-2', size: 20, colors: 6 } }, difficulty: 4 });
  add(5, 3, { title: 'Cinder Sprite', source: { gen: { seed: 'j5-3', size: 22, colors: 5 } }, difficulty: 5 });
  add(5, 4, { title: 'Prism Imp', source: { gen: { seed: 'j5-4', size: 22, colors: 6 } }, difficulty: 5 });
  add(5, 5, { title: 'Tidal Comet', source: { gen: { seed: 'j5-5', size: 22, colors: 6 } }, difficulty: 5 });
  add(5, 6, { title: 'Mastery: Orbit Sprint', source: { art: 'planet' }, difficulty: 5, ruleset: { timeLimitMs: 150000 } });

  // Chapter 6 — Glimmer Fauna (procedural depth, curated seeds).
  add(6, 1, { title: 'Glimmer Alpha', source: { gen: { seed: 'j6-1', size: 18, colors: 5 } }, difficulty: 4 });
  add(6, 2, { title: 'Glimmer Beta', source: { gen: { seed: 'j6-2', size: 20, colors: 5 } }, difficulty: 4 });
  add(6, 3, { title: 'Glimmer Gamma', source: { gen: { seed: 'j6-3', size: 20, colors: 6 } }, difficulty: 5 });
  add(6, 4, { title: 'Glimmer Delta', source: { gen: { seed: 'j6-4', size: 22, colors: 6 } }, difficulty: 5 });
  add(6, 5, { title: 'Glimmer Sigma', source: { gen: { seed: 'j6-5', size: 24, colors: 6 } }, difficulty: 5 });
  add(6, 6, { title: 'Mastery: Flawless Fauna', source: { gen: { seed: 'j6-6', size: 20, colors: 5 } }, difficulty: 5, ruleset: { errorPrevention: false, errorLimit: 3 } });

  // Chapter 7 — Master Atelier: combined mechanics on signature arts.
  add(7, 1, { title: 'Rocket, Precisely', source: { art: 'rocket' }, difficulty: 4, ruleset: { errorPrevention: false, errorLimit: 4 } });
  add(7, 2, { title: 'Regatta Sprint', source: { art: 'boat' }, difficulty: 4, ruleset: { timeLimitMs: 150000 } });
  add(7, 3, { title: 'Owl in Order', source: { art: 'owl' }, difficulty: 5, ruleset: { sequence: true, tools: { region: false } } });
  add(7, 4, { title: 'Planet, No Bucket', source: { art: 'planet' }, difficulty: 5, ruleset: { tools: { region: false }, moveLimit: 18 * 18 } });
  add(7, 5, { title: 'Warden\'s Trial', source: { art: 'owl' }, difficulty: 5, ruleset: { errorPrevention: false, errorLimit: 3, timeLimitMs: 180000 } });
  add(7, 6, { title: 'Mastery: The Atelier', source: { art: 'planet' }, difficulty: 5, ruleset: { errorPrevention: false, errorLimit: 3, tools: { region: false }, moveLimit: 18 * 18 + 12 } });

  return stages;
}

export const JOURNEY = buildJourney();
export const JOURNEY_CHAPTERS = CHAPTERS;

export function getStage(stageId) {
  return JOURNEY.find((s) => s.id === stageId) || null;
}

// ---------------------------------------------------------------------------
// Daily / Practice / Challenge / Score-chase builders
// ---------------------------------------------------------------------------

export function dailyContent(dateStr) {
  // One shared seed + ruleset per UTC day. Immutable once published.
  const seed = `daily:${dateStr}`;
  const rng = new RNG(seed);
  const pickArt = rng.chance(0.45);
  let base;
  if (pickArt) {
    base = artToContent(rng.pick(ARTS));
  } else {
    base = generateArt(seed, rng.pick([16, 18, 20]), rng.int(4, 6));
  }
  const twist = rng.pick(['standard', 'standard', 'speed', 'precision', 'sequence']);
  const ruleset = {};
  if (twist === 'speed') ruleset.timeLimitMs = base.width * base.height * 500;
  if (twist === 'precision') { ruleset.errorPrevention = false; ruleset.errorLimit = 5; }
  if (twist === 'sequence') { ruleset.sequence = true; ruleset.tools = { region: false }; }
  return makeContent(base, ruleset, {
    id: `daily-${dateStr}`,
    title: `Daily — ${dateStr}${twist !== 'standard' ? ` (${twist})` : ''}`,
    mode: 'daily',
    ranked: true,
    theme: rng.pick(['neon-draft', 'ember-grid', 'verdant-circuit', 'rose-quartz', 'mono-blueprint']),
    seed,
    difficulty: 3,
  });
}

export const PRACTICE_PRESETS = {
  calm: { label: 'Calm', size: 10, colors: 3, ruleset: {}, blurb: 'Small canvas, gentle pace, undo allowed.' },
  standard: { label: 'Standard', size: 16, colors: 4, ruleset: {}, blurb: 'The classic atelier canvas.' },
  expert: { label: 'Expert', size: 22, colors: 6, ruleset: { errorPrevention: false }, blurb: 'Large canvas, errors count. For steady hands.' },
};

export function practiceContent(presetId, seedStr) {
  const preset = PRACTICE_PRESETS[presetId] || PRACTICE_PRESETS.standard;
  const seed = seedStr || `practice:${presetId}:${Date.now().toString(36)}`;
  const base = generateArt(seed, preset.size, preset.colors);
  return makeContent(base, preset.ruleset, {
    id: `practice-${presetId}-${cyrb53(seed).toString(36)}`,
    title: `Practice — ${preset.label}`,
    mode: 'practice',
    ranked: false,
    theme: 'neon-draft',
    seed,
    difficulty: presetId === 'calm' ? 1 : presetId === 'expert' ? 4 : 2,
  });
}

export const CHALLENGE_TYPES = {
  speed: {
    label: 'Speed Table', blurb: 'Beat the clock. The table decides how much time you get.',
    ruleset: (size) => ({ timeLimitMs: size * size * 420 }),
  },
  precision: {
    label: 'Precision Draft', blurb: 'Error prevention is off. Three wrong cells end the round.',
    ruleset: () => ({ errorPrevention: false, errorLimit: 3 }),
  },
  nobucket: {
    label: 'Hand-Painted', blurb: 'No region tool, and exactly one action per cell.',
    ruleset: (size) => ({ tools: { region: false }, moveLimit: size * size }),
  },
  sequence: {
    label: 'Color Lock', blurb: 'Colors unlock in palette order. Finish one to reach the next.',
    ruleset: () => ({ sequence: true, tools: { region: false } }),
  },
};

export function challengeContent(typeId, level = 1, seedStr) {
  const type = CHALLENGE_TYPES[typeId] || CHALLENGE_TYPES.speed;
  const size = level <= 1 ? 12 : level === 2 ? 16 : 20;
  const colors = level <= 1 ? 4 : level === 2 ? 5 : 6;
  const seed = seedStr || `challenge:${typeId}:${level}:${Date.now().toString(36)}`;
  const base = generateArt(seed, size, colors);
  return makeContent(base, type.ruleset(size), {
    id: `challenge-${typeId}-${level}-${cyrb53(seed).toString(36)}`,
    title: `${type.label} ${['I', 'II', 'III'][level - 1] || level}`,
    mode: 'challenge',
    ranked: false,
    theme: 'ember-grid',
    seed,
    difficulty: Math.min(5, level + 2),
  });
}

// Score chase: fixed weekly seeds so scores are comparable.
export function scoreChaseContent(weekStr) {
  const seed = `chase:${weekStr}`;
  const rng = new RNG(seed);
  const base = generateArt(seed, 18, 5);
  return makeContent(base, { errorPrevention: false }, {
    id: `chase-${weekStr}`,
    title: `Score Chase — Week ${weekStr}`,
    mode: 'score-chase',
    ranked: true,
    theme: 'rose-quartz',
    seed,
    difficulty: 4,
  });
}

// ---------------------------------------------------------------------------
// Visual themes (cosmetic; several are unlockable rewards)
// ---------------------------------------------------------------------------

export const THEMES = [
  {
    id: 'neon-draft', name: 'Neon Draft', unlock: { type: 'default' },
    bg: '#05070f', fog: '#0a1024', table: '#0d1426', tableEdge: '#1c2b4d',
    grid: '#16233f', cellEmpty: '#141d33', accentA: '#22d3ee', accentB: '#f472b6',
    key: '#9fd8ff', rim: '#ff7ad9', ambience: 'hum',
  },
  {
    id: 'ember-grid', name: 'Ember Grid', unlock: { type: 'journey', n: 12 },
    bg: '#0f0705', fog: '#241010', table: '#26130d', tableEdge: '#4d2a1c',
    grid: '#3f2316', cellEmpty: '#331b14', accentA: '#ffb703', accentB: '#fb8500',
    key: '#ffd8a8', rim: '#ff9e7a', ambience: 'fire',
  },
  {
    id: 'verdant-circuit', name: 'Verdant Circuit', unlock: { type: 'streak', n: 3 },
    bg: '#040f0a', fog: '#0a2417', table: '#0d2618', tableEdge: '#1c4d33',
    grid: '#163f2a', cellEmpty: '#143324', accentA: '#80ed99', accentB: '#57cc99',
    key: '#c7f9cc', rim: '#7ae2cf', ambience: 'wind',
  },
  {
    id: 'mono-blueprint', name: 'Mono Blueprint', unlock: { type: 'stages', n: 10 },
    bg: '#05080f', fog: '#0a1224', table: '#0d1a33', tableEdge: '#24457a',
    grid: '#1a3560', cellEmpty: '#14284d', accentA: '#4cc9f0', accentB: '#e0fbfc',
    key: '#d8f3ff', rim: '#7ab8ff', ambience: 'hum',
  },
  {
    id: 'rose-quartz', name: 'Rose Quartz', unlock: { type: 'cells', n: 5000 },
    bg: '#100510', fog: '#240a24', table: '#260d26', tableEdge: '#4d1c4d',
    grid: '#3f163f', cellEmpty: '#331433', accentA: '#f0a6ff', accentB: '#ffd6ff',
    key: '#ffe0f7', rim: '#c77dff', ambience: 'chime',
  },
];

export function getTheme(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

// ---------------------------------------------------------------------------
// Run every validator over shipped content (used by tests and boot check)
// ---------------------------------------------------------------------------

export function validateAllShipped() {
  const problems = [];
  for (const stage of JOURNEY) validateContent(stage, problems);
  for (const lesson of LESSONS) validateContent(lessonContent(lesson.id).content, problems);
  for (const preset of Object.keys(PRACTICE_PRESETS)) validateContent(practiceContent(preset, 'validation'), problems);
  for (const type of Object.keys(CHALLENGE_TYPES)) {
    for (let lvl = 1; lvl <= 3; lvl++) validateContent(challengeContent(type, lvl, 'validation'), problems);
  }
  validateContent(dailyContent('2026-01-01'), problems);
  validateContent(scoreChaseContent('2026-W01'), problems);
  return problems;
}
