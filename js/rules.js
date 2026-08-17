// rules.js — pure deterministic rules engine for Pixel Atelier.
// No DOM, no rendering, no timers. All state transitions happen through
// validated commands. Serializable state, monotonic tick, terminal reasons,
// legal-action queries shared by play, hints and tutorials.

import { hashString } from './rng.js';

export const RULES_VERSION = 1;

export const TERMINAL = {
  ALL_FILLED: 'all-filled',
  MOVE_LIMIT: 'move-limit',
  TIME_LIMIT: 'time-limit',
  ERROR_LIMIT: 'error-limit',
  ABANDONED: 'abandoned',
};

export const INVALID = {
  NOT_ACTIVE: 'not-active',
  TERMINAL: 'terminal',
  OUT_OF_BOUNDS: 'out-of-bounds',
  BAD_COLOR: 'bad-color',
  TOOL_DISABLED: 'tool-disabled',
  ALREADY_FILLED: 'already-filled',
  WRONG_COLOR: 'wrong-color',
  REGION_MISMATCH: 'region-color-mismatch',
  COLOR_LOCKED: 'color-locked',
  UNDO_DISABLED: 'undo-disabled',
  NOTHING_TO_UNDO: 'nothing-to-undo',
  BAD_COMMAND: 'bad-command',
};

export const INVALID_MESSAGES = {
  [INVALID.NOT_ACTIVE]: 'The round is not active.',
  [INVALID.TERMINAL]: 'The round has ended.',
  [INVALID.OUT_OF_BOUNDS]: 'That cell is outside the canvas.',
  [INVALID.BAD_COLOR]: 'That color is not in this palette.',
  [INVALID.TOOL_DISABLED]: 'That tool is disabled in this ruleset.',
  [INVALID.ALREADY_FILLED]: 'That cell is already finished.',
  [INVALID.WRONG_COLOR]: 'Wrong color for this cell — error prevention is on.',
  [INVALID.REGION_MISMATCH]: 'The region tool only fills cells that match the selected color.',
  [INVALID.COLOR_LOCKED]: 'This ruleset fills colors in order — finish the highlighted color first.',
  [INVALID.UNDO_DISABLED]: 'Undo is not available in this mode.',
  [INVALID.NOTHING_TO_UNDO]: 'There is nothing to undo.',
  [INVALID.BAD_COMMAND]: 'Malformed command.',
};

const SCORE = {
  PER_CELL: 10,
  COMBO_CAP: 40,
  REGION_BONUS: 15,
  COMPLETION: 1000,
  TIME_BONUS_MAX: 500,
  ERROR_PENALTY: 25,
  HINT_PENALTY: 15,
};

export const TIME_QUANTUM_MS = 100; // authoritative inputs are quantized to this

// ---------------------------------------------------------------------------
// Content record (versioned data — see content.js):
// { id, version, seed, width, height, palette:[hex], targets:number[],
//   ruleset:{ errorPrevention, tools:{brush,drag,region}, allowUndo,
//             moveLimit, timeLimitMs, errorLimit, sequence },
//   par:{ timeMs, actions }, meta:{ title, theme, difficulty, ranked, mode } }
// ---------------------------------------------------------------------------

export function createState(content) {
  const cells = content.width * content.height;
  if (!content || !Array.isArray(content.targets) || content.targets.length !== cells) {
    throw new Error('rules: content targets do not match dimensions');
  }
  const state = {
    v: RULES_VERSION,
    contentId: content.id,
    contentVersion: content.version,
    seed: String(content.seed),
    ruleset: normalizeRuleset(content.ruleset),
    w: content.width,
    h: content.height,
    palette: content.palette.slice(),
    targets: content.targets.slice(),
    par: { timeMs: content.par?.timeMs ?? 0, actions: content.par?.actions ?? cells },
    filled: new Array(cells).fill(0),
    wrong: new Array(cells).fill(0), // 0 = clean, n>0 = wrongly painted with color n-1
    selected: 0, // start on the background swatch; players actively pick a color
    tick: 0,          // monotonically increasing command/tick number
    elapsedMs: 0,     // authoritative elapsed time (active only, quantized)
    status: 'ready',  // ready | active | paused | complete | failed | abandoned
    terminalReason: null,
    seqColor: 0,      // current required color for 'sequence' rulesets
    stats: {
      correct: 0, errors: 0, actions: 0, combo: 0, bestCombo: 0,
      comboPoints: 0, regionFills: 0, hints: 0, undos: 0, strokes: 0,
    },
    undoStack: [],    // inverses of fill commands (only when ruleset.allowUndo)
    final: null,      // score breakdown once terminal
  };
  state.seqColor = nextSequenceColor(state, -1);
  return state;
}

function normalizeRuleset(r = {}) {
  const tools = r.tools || {};
  return {
    errorPrevention: r.errorPrevention !== false,
    tools: {
      brush: tools.brush !== false,
      drag: tools.drag !== false,
      region: tools.region !== false,
    },
    allowUndo: r.allowUndo !== false,
    moveLimit: Number.isInteger(r.moveLimit) ? r.moveLimit : null,
    timeLimitMs: Number.isInteger(r.timeLimitMs) ? r.timeLimitMs : null,
    errorLimit: Number.isInteger(r.errorLimit) ? r.errorLimit : null,
    sequence: r.sequence === true,
  };
}

export function totalCells(state) { return state.w * state.h; }
export function isTerminal(state) {
  return state.status === 'complete' || state.status === 'failed' || state.status === 'abandoned';
}
export function progress(state) { return state.stats.correct / totalCells(state); }

function nextSequenceColor(state, afterColor) {
  // Find the next color index (ascending, after `afterColor`) that still has
  // unfilled cells. Returns -1 when the board is complete.
  const counts = colorCounts(state);
  const order = Object.keys(counts).map(Number).filter((c) => c > afterColor);
  for (const c of order.sort((a, b) => a - b)) {
    if (remainingForColor(state, c) > 0) return c;
  }
  return -1;
}

export function colorCounts(state) {
  const counts = {};
  for (let i = 0; i < state.targets.length; i++) {
    const t = state.targets[i];
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

export function remainingForColor(state, color) {
  let n = 0;
  for (let i = 0; i < state.targets.length; i++) {
    if (state.targets[i] === color && !state.filled[i]) n++;
  }
  return n;
}

// Connected region (4-way) of cells sharing the target color of `cell`,
// limited to unfilled cells. Used by the region tool and its ghost preview.
export function regionAt(state, cell) {
  if (cell < 0 || cell >= totalCells(state)) return [];
  const target = state.targets[cell];
  const out = [];
  const seen = new Uint8Array(totalCells(state));
  const stack = [cell];
  seen[cell] = 1;
  const w = state.w;
  while (stack.length) {
    const c = stack.pop();
    if (state.targets[c] !== target || state.filled[c]) continue;
    out.push(c);
    const x = c % w;
    if (x > 0 && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
    if (x < w - 1 && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
    if (c - w >= 0 && !seen[c - w]) { seen[c - w] = 1; stack.push(c - w); }
    if (c + w < totalCells(state) && !seen[c + w]) { seen[c + w] = 1; stack.push(c + w); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Command validation + resolution
// ---------------------------------------------------------------------------

function reject(reason, extra = {}) {
  return { ok: false, reason, message: INVALID_MESSAGES[reason] || reason, events: [], ...extra };
}

function validateCommon(state, cmd) {
  if (!cmd || typeof cmd.type !== 'string') return reject(INVALID.BAD_COMMAND);
  if (isTerminal(state)) return reject(INVALID.TERMINAL);
  if (state.status !== 'active') return reject(INVALID.NOT_ACTIVE);
  return null;
}

function validateFill(state, cmd) {
  const common = validateCommon(state, cmd);
  if (common) return common;
  const { cell, color, tool } = cmd;
  if (!Number.isInteger(cell) || cell < 0 || cell >= totalCells(state)) return reject(INVALID.OUT_OF_BOUNDS);
  if (!Number.isInteger(color) || color < 0 || color >= state.palette.length) return reject(INVALID.BAD_COLOR);
  const toolName = tool === 'region' ? 'region' : 'brush';
  if (!state.ruleset.tools[toolName] && !(toolName === 'brush' && cmd.stroke && state.ruleset.tools.drag)) {
    return reject(INVALID.TOOL_DISABLED);
  }
  if (state.ruleset.sequence && color !== state.seqColor) {
    return reject(INVALID.COLOR_LOCKED, { required: state.seqColor });
  }
  const target = state.targets[cell];
  if (toolName === 'region') {
    if (state.filled[cell] && !state.wrong[cell]) return reject(INVALID.ALREADY_FILLED);
    if (color !== target) return reject(INVALID.REGION_MISMATCH, { target });
    return { ok: true, toolName, target };
  }
  // brush / drag stroke cell
  if (state.filled[cell] && !state.wrong[cell]) return reject(INVALID.ALREADY_FILLED);
  if (color !== target && state.ruleset.errorPrevention) {
    return reject(INVALID.WRONG_COLOR, { target });
  }
  if (state.wrong[cell] === color + 1) return reject(INVALID.ALREADY_FILLED);
  return { ok: true, toolName, target };
}

function finalizeIfTerminal(state, events) {
  const s = state.stats;
  if (s.correct === totalCells(state)) {
    state.status = 'complete';
    state.terminalReason = TERMINAL.ALL_FILLED;
  } else if (state.ruleset.errorLimit != null && s.errors >= state.ruleset.errorLimit) {
    state.status = 'failed';
    state.terminalReason = TERMINAL.ERROR_LIMIT;
  } else if (state.ruleset.moveLimit != null && s.actions >= state.ruleset.moveLimit) {
    state.status = 'failed';
    state.terminalReason = TERMINAL.MOVE_LIMIT;
  } else if (state.ruleset.timeLimitMs != null && state.elapsedMs >= state.ruleset.timeLimitMs) {
    state.status = 'failed';
    state.terminalReason = TERMINAL.TIME_LIMIT;
  }
  if (isTerminal(state)) {
    state.final = scoreBreakdown(state);
    events.push({ type: 'terminal', status: state.status, reason: state.terminalReason, final: state.final });
  }
}

function applyFill(state, cmd, check) {
  const s = state.stats;
  const events = [];
  const inverse = { kind: 'fill', cells: [], wrongBefore: [], statsBefore: { ...s }, seqBefore: state.seqColor };
  const isStrokeStart = cmd.stroke && !cmd.strokeContinuation;

  if (check.toolName === 'region') {
    const region = regionAt(state, cmd.cell);
    if (region.length === 0) return reject(INVALID.ALREADY_FILLED);
    for (const c of region) {
      inverse.cells.push(c);
      inverse.wrongBefore.push(state.wrong[c]);
      state.filled[c] = 1;
      state.wrong[c] = 0;
    }
    s.correct += region.length;
    s.actions += 1;
    s.regionFills += 1;
    s.combo += 1;
    s.comboPoints += Math.min(s.combo, SCORE.COMBO_CAP);
    s.bestCombo = Math.max(s.bestCombo, s.combo);
    events.push({ type: 'fill', tool: 'region', cells: region, color: cmd.color, combo: s.combo });
  } else {
    const c = cmd.cell;
    const wasWrong = state.wrong[c];
    inverse.cells.push(c);
    inverse.wrongBefore.push(wasWrong);
    if (cmd.color === state.targets[c]) {
      state.filled[c] = 1;
      state.wrong[c] = 0;
      s.correct += 1;
      s.combo += 1;
      s.comboPoints += Math.min(s.combo, SCORE.COMBO_CAP);
      s.bestCombo = Math.max(s.bestCombo, s.combo);
      events.push({
        type: 'fill', tool: cmd.stroke ? 'drag' : 'brush', cells: [c], color: cmd.color,
        combo: s.combo, fixed: wasWrong > 0,
      });
    } else {
      // Committed wrong fill (error prevention off): cell is painted wrong,
      // stays unfinished, costs an error; repainting it later is allowed.
      state.wrong[c] = cmd.color + 1;
      s.errors += 1;
      s.combo = 0;
      events.push({ type: 'error', cells: [c], color: cmd.color, target: state.targets[c] });
    }
    s.actions += 1;
  }
  if (isStrokeStart) s.strokes += 1;

  state.tick += 1;
  if (state.ruleset.allowUndo) state.undoStack.push(inverse);
  if (state.ruleset.sequence) state.seqColor = nextSequenceColor(state, state.seqColor - 1);
  finalizeIfTerminal(state, events);
  return { ok: true, events };
}

function applyUndo(state) {
  if (isTerminal(state)) return reject(INVALID.TERMINAL);
  if (state.status !== 'active') return reject(INVALID.NOT_ACTIVE);
  if (!state.ruleset.allowUndo) return reject(INVALID.UNDO_DISABLED);
  const inverse = state.undoStack.pop();
  if (!inverse) return reject(INVALID.NOTHING_TO_UNDO);
  for (let i = 0; i < inverse.cells.length; i++) {
    const c = inverse.cells[i];
    state.filled[c] = 0;
    state.wrong[c] = inverse.wrongBefore[i];
  }
  state.stats = { ...inverse.statsBefore, undos: inverse.statsBefore.undos + 1 };
  state.seqColor = inverse.seqBefore;
  state.tick += 1;
  return { ok: true, events: [{ type: 'undo', cells: inverse.cells.slice() }] };
}

// The hint API deliberately reuses the same legality checks as play.
export function hint(state) {
  if (isTerminal(state) || state.status !== 'active') return null;
  const color = state.ruleset.sequence ? state.seqColor : state.selected;
  let cell = firstUnfilledOfColor(state, color);
  if (cell >= 0) {
    if (state.ruleset.tools.region) {
      const region = regionAt(state, cell);
      if (region.length >= 4) return { type: 'fill', tool: 'region', cell, color };
    }
    return { type: 'fill', tool: 'brush', cell, color };
  }
  // Selected color is finished: recommend the color with the most cells left.
  let best = -1, bestN = 0;
  for (const cStr of Object.keys(colorCounts(state))) {
    const c = Number(cStr);
    if (state.ruleset.sequence && c !== state.seqColor) continue;
    const n = remainingForColor(state, c);
    if (n > bestN) { bestN = n; best = c; }
  }
  if (best >= 0) return { type: 'select', color: best };
  return null;
}

function firstUnfilledOfColor(state, color) {
  for (let i = 0; i < state.targets.length; i++) {
    if (state.targets[i] === color && !state.filled[i]) return i;
  }
  return -1;
}

export function legalTargetsForColor(state, color) {
  const out = [];
  for (let i = 0; i < state.targets.length; i++) {
    if (state.targets[i] === color && !state.filled[i]) out.push(i);
  }
  return out;
}

// Summary of everything the UI is currently allowed to do.
export function legalActions(state) {
  if (isTerminal(state) || state.status !== 'active') {
    return { active: false, colors: [], canUndo: false, canHint: false, tools: {} };
  }
  const colors = [];
  for (const cStr of Object.keys(colorCounts(state))) {
    const c = Number(cStr);
    const remaining = remainingForColor(state, c);
    if (remaining > 0 && (!state.ruleset.sequence || c === state.seqColor)) {
      colors.push({ color: c, remaining, sample: firstUnfilledOfColor(state, c) });
    }
  }
  return {
    active: true,
    colors,
    canUndo: state.ruleset.allowUndo && state.undoStack.length > 0,
    canHint: true,
    tools: { ...state.ruleset.tools },
  };
}

// Main entry point. `cmd.id` makes commits idempotent at the session layer;
// the engine itself is pure resolution. Returns { ok, events, reason? }.
export function apply(state, cmd) {
  switch (cmd?.type) {
    case 'start': {
      if (state.status !== 'ready' && state.status !== 'paused') return reject(INVALID.BAD_COMMAND);
      state.status = 'active';
      state.tick += 1;
      return { ok: true, events: [{ type: 'start' }] };
    }
    case 'pause': {
      if (state.status !== 'active') return reject(INVALID.NOT_ACTIVE);
      state.status = 'paused';
      state.tick += 1;
      return { ok: true, events: [{ type: 'pause' }] };
    }
    case 'resume': {
      if (state.status !== 'paused') return reject(INVALID.NOT_ACTIVE);
      state.status = 'active';
      state.tick += 1;
      return { ok: true, events: [{ type: 'resume' }] };
    }
    case 'select': {
      const common = validateCommon(state, cmd);
      if (common) return common;
      if (!Number.isInteger(cmd.color) || cmd.color < 0 || cmd.color >= state.palette.length) {
        return reject(INVALID.BAD_COLOR);
      }
      if (state.ruleset.sequence && cmd.color !== state.seqColor) {
        return reject(INVALID.COLOR_LOCKED, { required: state.seqColor });
      }
      const changed = state.selected !== cmd.color;
      state.selected = cmd.color;
      state.tick += 1;
      return { ok: true, events: changed ? [{ type: 'select', color: cmd.color }] : [] };
    }
    case 'fill': {
      const check = validateFill(state, cmd);
      if (!check.ok) return check;
      return applyFill(state, cmd, check);
    }
    case 'undo':
      return applyUndo(state);
    case 'hint': {
      const common = validateCommon(state, cmd);
      if (common) return common;
      const h = hint(state);
      state.stats.hints += 1;
      state.tick += 1;
      return { ok: true, events: [{ type: 'hint', hint: h }] };
    }
    case 'tick': {
      const common = validateCommon(state, cmd);
      if (common) return common;
      let dt = cmd.dtMs;
      if (!Number.isFinite(dt) || dt < 0 || dt > 60000) return reject(INVALID.BAD_COMMAND);
      dt = Math.round(dt / TIME_QUANTUM_MS) * TIME_QUANTUM_MS; // quantize
      state.elapsedMs += dt;
      state.tick += 1;
      const events = [{ type: 'tick', elapsedMs: state.elapsedMs }];
      finalizeIfTerminal(state, events);
      return { ok: true, events };
    }
    case 'abandon': {
      if (isTerminal(state)) return reject(INVALID.TERMINAL);
      state.status = 'abandoned';
      state.terminalReason = TERMINAL.ABANDONED;
      state.tick += 1;
      state.final = scoreBreakdown(state);
      return { ok: true, events: [{ type: 'terminal', status: 'abandoned', reason: TERMINAL.ABANDONED, final: state.final }] };
    }
    default:
      return reject(INVALID.BAD_COMMAND);
  }
}

// ---------------------------------------------------------------------------
// Scoring — integers everywhere; formatting happens in presentation only.
// ---------------------------------------------------------------------------

export function scoreBreakdown(state) {
  const s = state.stats;
  const complete = state.status === 'complete';
  const base = s.correct * SCORE.PER_CELL;
  const comboBonus = s.comboPoints;
  const regionBonus = s.regionFills * SCORE.REGION_BONUS;
  const completionBonus = complete ? SCORE.COMPLETION : 0;
  let timeBonus = 0;
  if (complete && state.par.timeMs > 0 && state.elapsedMs <= state.par.timeMs) {
    timeBonus = Math.round(SCORE.TIME_BONUS_MAX * (1 - state.elapsedMs / state.par.timeMs));
  }
  const errorPenalty = s.errors * SCORE.ERROR_PENALTY;
  const hintPenalty = s.hints * SCORE.HINT_PENALTY;
  const total = Math.max(0, base + comboBonus + regionBonus + completionBonus + timeBonus - errorPenalty - hintPenalty);
  return {
    base, comboBonus, regionBonus, completionBonus, timeBonus,
    errorPenalty, hintPenalty, total,
    correct: s.correct, errors: s.errors, actions: s.actions,
    bestCombo: s.bestCombo, elapsedMs: state.elapsedMs,
    progressPct: Math.round(progress(state) * 10000) / 100,
  };
}

// Tie-break order: completion, fewer errors, lower elapsed, stable session id.
export function compareResults(a, b, sessionIdA = '', sessionIdB = '') {
  const pa = a.final?.progressPct ?? 0, pb = b.final?.progressPct ?? 0;
  if (pa !== pb) return pb - pa;
  const ea = a.stats.errors, eb = b.stats.errors;
  if (ea !== eb) return ea - eb;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  return sessionIdA < sessionIdB ? -1 : sessionIdA > sessionIdB ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Serialization + hashing (replay envelopes hash these canonically)
// ---------------------------------------------------------------------------

export function serialize(state) {
  return JSON.parse(JSON.stringify(state));
}

export function deserialize(data) {
  if (!data || typeof data !== 'object') throw new Error('rules: bad snapshot');
  if (data.v > RULES_VERSION) throw new Error(`rules: snapshot version ${data.v} newer than engine ${RULES_VERSION}`);
  const state = migrate(data);
  return state;
}

export function migrate(data) {
  // v1 is current; migration chain lives here for future versions.
  const state = JSON.parse(JSON.stringify(data));
  state.v = RULES_VERSION;
  return state;
}

export function hashState(state) {
  const canon = [
    state.v, state.contentId, state.contentVersion, state.seed, state.tick,
    state.elapsedMs, state.status, state.terminalReason, state.selected, state.seqColor,
    state.filled.join(''), state.wrong.join(''),
    state.stats.correct, state.stats.errors, state.stats.actions, state.stats.combo,
    state.stats.comboPoints, state.stats.regionFills, state.stats.hints, state.stats.undos,
    state.final ? state.final.total : -1,
  ].join('|');
  return hashString(canon);
}
