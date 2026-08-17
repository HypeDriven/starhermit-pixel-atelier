// tests/run.mjs — Pixel Atelier acceptance tests.
// Run: node tests/run.mjs
//
// Covers: every legal action, invalid-action reasons, scoring components,
// terminal states, serialization/migration, deterministic replay (property),
// malformed-command fuzz, content validators, golden sessions, tie-breaks.

import { RNG, hashString } from '../js/rng.js';
import * as rules from '../js/rules.js';
import {
  validateAllShipped, dailyContent, practiceContent, challengeContent,
  lessonContent, LESSONS, JOURNEY, generateArt, getArt,
} from '../js/content.js';
import { Session, boardEntryFromSession, compareBoardEntries } from '../js/session.js';
import { SaveStore, defaultSaveData, checksumOf } from '../js/storage.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; failures.push(name); console.error('FAIL:', name); }
}
function eq(a, b, name) { ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function section(name) { console.log(`\n== ${name}`); }

// Tiny deterministic content for rule tests.
function testContent(overrides = {}) {
  return {
    id: 'test', version: 1, seed: 'test',
    width: 4, height: 3,
    palette: ['#000000', '#111111', '#222222'],
    // 0 0 1 1 / 0 0 1 1 / 2 2 2 2  (regions: bg 4, c1 4, c2 4)
    targets: [0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 2, 2],
    ruleset: {
      errorPrevention: true, tools: { brush: true, drag: true, region: true },
      allowUndo: true, moveLimit: null, timeLimitMs: null, errorLimit: null, sequence: false,
    },
    par: { timeMs: 60000, actions: 20 },
    meta: { title: 'Test', mode: 'practice', ranked: false },
    ...overrides,
  };
}

function fillAll(session) {
  const s = session.state;
  for (let i = 0; i < s.targets.length; i++) {
    if (!s.filled[i]) {
      session.select(s.targets[i]);
      const r = session.fill(i, s.targets[i], 'brush');
      if (!r.ok) throw new Error(`fillAll failed at ${i}: ${r.reason}`);
    }
  }
}

// ---------------------------------------------------------------------------
section('rules: legal actions + invalid reasons');
{
  const s = new Session(testContent());
  eq(s.state.status, 'ready', 'initial status ready');
  let r = s.fill(0, 0, 'brush');
  eq(r.ok, false, 'fill before start rejected');
  eq(r.reason, 'not-active', 'reason not-active');
  s.start();
  eq(s.state.status, 'active', 'start activates');

  r = s.fill(99, 0, 'brush'); eq(r.reason, 'out-of-bounds', 'oob');
  r = s.fill(0, 7, 'brush'); eq(r.reason, 'bad-color', 'bad color');
  r = s.fill(2, 0, 'brush'); eq(r.reason, 'wrong-color', 'wrong color w/ prevention');
  r = s.fill(0, 0, 'brush'); ok(r.ok, 'legal brush fill');
  eq(s.state.stats.correct, 1, 'correct counted');
  eq(s.state.stats.actions, 1, 'action counted');
  r = s.fill(0, 0, 'brush'); eq(r.reason, 'already-filled', 'double fill rejected');

  // Region tool.
  s.select(1);
  r = s.fill(2, 1, 'region'); ok(r.ok, 'region fill ok');
  eq(s.state.stats.correct, 5, 'region filled 4 cells');
  eq(s.state.stats.actions, 2, 'region = one action');
  r = s.fill(8, 1, 'region'); eq(r.reason, 'region-color-mismatch', 'region wrong color rejected');

  // Region tool disabled.
  const s2 = new Session(testContent({ ruleset: { ...testContent().ruleset, tools: { brush: true, drag: true, region: false } } }));
  s2.start();
  r = s2.fill(0, 0, 'region'); eq(r.reason, 'tool-disabled', 'region disabled rejected');

  // Tick + time.
  r = s.advanceTime(500);
  ok(r.ok, 'tick ok');
  eq(s.state.elapsedMs, 500, 'elapsed accumulates (quantized)');
  r = s.advanceTime(Number.NaN); eq(r.ok, false, 'NaN tick rejected');

  // Pause/resume gating.
  s.pause();
  r = s.fill(8, 2, 'brush'); eq(r.reason, 'not-active', 'fill while paused rejected');
  s.resume();
  r = s.fill(8, 2, 'brush'); ok(r.ok, 'fill after resume');

  // Undo.
  const before = s.state.stats.correct;
  r = s.undo(); ok(r.ok, 'undo ok');
  eq(s.state.stats.correct, before - 1, 'undo reverts correct');
  eq(s.state.filled[8], 0, 'undo clears cell');

  // Hint uses the legal-action API.
  r = s.hint();
  ok(r.ok && r.events[0].hint, 'hint returns an action');
  const h = r.events[0].hint;
  if (h.type === 'fill') {
    const v = s.fill(h.cell, h.color, h.tool);
    ok(v.ok, 'hinted action is legal');
  }

  // Idempotency by command id.
  const s3 = new Session(testContent());
  s3.start();
  const cmd = { id: 'abc', type: 'fill', cell: 0, color: 0, tool: 'brush' };
  const a = s3.dispatch({ ...cmd });
  const b = s3.dispatch({ ...cmd });
  ok(a.ok && b.ok && b.deduped, 'duplicate command id deduped');
  eq(s3.state.stats.correct, 1, 'deduped command applied once');
}

// ---------------------------------------------------------------------------
section('rules: error prevention off + error limit terminal');
{
  const c = testContent({
    ruleset: { errorPrevention: false, tools: { brush: true, drag: true, region: true }, allowUndo: true, moveLimit: null, timeLimitMs: null, errorLimit: 2, sequence: false },
  });
  const s = new Session(c);
  s.start();
  let r = s.fill(2, 0, 'brush'); // wrong (target 1)
  ok(r.ok, 'wrong fill commits when prevention off');
  eq(s.state.stats.errors, 1, 'error counted');
  eq(s.state.filled[2], 0, 'wrong cell stays unfinished');
  eq(s.state.wrong[2], 1, 'wrong marker set');
  r = s.fill(2, 1, 'brush'); // repaint correctly
  ok(r.ok, 'repaint wrong cell ok');
  eq(s.state.stats.correct, 1, 'repaint counts correct');
  s.fill(0, 1, 'brush'); // error 2 → error limit
  eq(s.state.status, 'failed', 'error limit fails round');
  eq(s.state.terminalReason, 'error-limit', 'terminal reason error-limit');
  r = s.fill(3, 1, 'brush');
  eq(r.reason, 'terminal', 'no actions after terminal');
}

// ---------------------------------------------------------------------------
section('rules: move limit + time limit + sequence');
{
  const base = testContent();
  const cells = base.width * base.height;
  const c = testContent({ ruleset: { ...base.ruleset, moveLimit: cells, tools: { brush: true, drag: true, region: false } } });
  const s = new Session(c);
  s.start();
  s.fill(0, 1, 'brush'); // wasted? no — wrong color rejected (prevention on). Use an error instead.
  // prevention on → rejection doesn't consume actions. Undo consumes none. So fill all but one, then waste via select (not an action)…
  // Instead: exact-limit ruleset means filling every cell exactly completes at the limit.
  for (let i = 0; i < cells; i++) {
    if (!s.state.filled[i]) { s.select(s.state.targets[i]); s.fill(i, s.state.targets[i], 'brush'); }
  }
  eq(s.state.status, 'complete', 'exact move limit completes');

  const c2 = testContent({ ruleset: { ...base.ruleset, moveLimit: 4, tools: { brush: true, drag: true, region: false } } });
  const s2 = new Session(c2);
  s2.start();
  for (let i = 0; i < 4; i++) { s2.select(s2.state.targets[i]); s2.fill(i, s2.state.targets[i], 'brush'); }
  eq(s2.state.status, 'failed', 'move limit fails incomplete round');
  eq(s2.state.terminalReason, 'move-limit', 'reason move-limit');

  const c3 = testContent({ ruleset: { ...base.ruleset, timeLimitMs: 1000 } });
  const s3 = new Session(c3);
  s3.start();
  s3.advanceTime(1200);
  eq(s3.state.status, 'failed', 'time limit fails round');
  eq(s3.state.terminalReason, 'time-limit', 'reason time-limit');

  const c4 = testContent({ ruleset: { ...base.ruleset, sequence: true, tools: { brush: true, drag: true, region: false } } });
  const s4 = new Session(c4);
  s4.start();
  eq(s4.state.seqColor, 0, 'sequence starts at color 0');
  let r = s4.fill(8, 2, 'brush');
  eq(r.reason, 'color-locked', 'sequence locks later colors');
  for (let i = 0; i < 8; i++) { if (!s4.state.filled[i]) s4.fill(i, 0, 'brush'); }
  eq(s4.state.seqColor, 1, 'sequence advances to color 1');
  r = s4.select(2);
  eq(r.ok, false, 'sequence select locked');
}

// ---------------------------------------------------------------------------
section('rules: scoring components are integers and itemized');
{
  const s = new Session(testContent());
  s.start();
  fillAll(s);
  eq(s.state.status, 'complete', 'fillAll completes');
  const f = s.state.final;
  ok(Number.isInteger(f.total), 'total is integer');
  eq(f.base, 12 * 10, 'base = cells × 10');
  eq(f.completionBonus, 1000, 'completion bonus');
  ok(f.comboBonus > 0, 'combo bonus positive');
  ok(f.timeBonus >= 0 && f.timeBonus <= 500, 'time bonus within bounds');
  eq(f.total, Math.max(0, f.base + f.comboBonus + f.regionBonus + f.completionBonus + f.timeBonus - f.errorPenalty - f.hintPenalty), 'total sums components');
  eq(f.progressPct, 100, 'progress 100');
}

// ---------------------------------------------------------------------------
section('rules: serialization round-trip + migration guard');
{
  const s = new Session(testContent());
  s.start();
  s.fill(0, 0, 'brush');
  const snap = rules.serialize(s.state);
  const restored = rules.deserialize(snap);
  eq(rules.hashState(restored), rules.hashState(s.state), 'serialize→deserialize hash stable');
  let threw = false;
  try { rules.deserialize({ ...snap, v: 999 }); } catch { threw = true; }
  ok(threw, 'future version rejected');
}

// ---------------------------------------------------------------------------
section('replay: same version+seed+commands → identical hashes (property)');
{
  const rng = new RNG('property');
  for (let iter = 0; iter < 12; iter++) {
    const content = practiceContent(['calm', 'standard', 'expert'][iter % 3], `prop-${iter}`);
    const run = () => {
      const s = new Session(content, { sessionId: 'prop' });
      s.start();
      const r2 = new RNG(`cmds-${iter}`);
      let steps = r2.int(20, 120);
      while (steps-- > 0 && !rules.isTerminal(s.state)) {
        const la = rules.legalActions(s.state);
        if (!la.colors.length) break;
        const pick = r2.pick(la.colors);
        const cells = rules.legalTargetsForColor(s.state, pick.color);
        const cell = r2.pick(cells);
        s.select(pick.color);
        if (r2.chance(0.3) && la.tools.region) s.fill(cell, pick.color, 'region');
        else s.fill(cell, pick.color, 'brush');
        if (r2.chance(0.1)) s.undo();
        if (r2.chance(0.05)) s.hint();
        s.advanceTime(300);
      }
      return s;
    };
    const a = run();
    const envA = a.envelope();
    const b = run();
    eq(rules.hashState(a.state), rules.hashState(b.state), `replay deterministic iter ${iter}`);
    const verdict = Session.verify(envA, content);
    ok(verdict.ok, `envelope verifies iter ${iter}${verdict.ok ? '' : ' — ' + verdict.error}`);
  }
}

// ---------------------------------------------------------------------------
section('fuzz: malformed commands never hang or corrupt');
{
  const rng = new RNG('fuzz');
  const content = testContent();
  for (let i = 0; i < 2000; i++) {
    const s = new Session(content);
    s.start();
    const weird = [
      { type: 'fill', cell: -1, color: 0 },
      { type: 'fill', cell: 1e9, color: 0 },
      { type: 'fill', cell: 'x', color: 0 },
      { type: 'fill', cell: 0, color: -5 },
      { type: 'fill', cell: 0, color: 0, tool: 'laser' },
      { type: 'tick', dtMs: -50 },
      { type: 'tick', dtMs: 1e12 },
      { type: 'tick', dtMs: 'fast' },
      { type: 'select', color: null },
      { type: 'bogus' },
      null, undefined, 42, 'fill',
      { type: 'fill' },
      { type: 'undo' },
    ];
    const cmd = rng.pick(weird);
    const r = s.dispatch(cmd ? { ...cmd } : cmd);
    ok(r !== undefined, `fuzz ${i} returned`);
    ok(rules.hashState(s.state).length > 0, `fuzz ${i} state hashable`);
  }
  ok(true, 'fuzz batch completed without hang');
}

// ---------------------------------------------------------------------------
section('content: all shipped content validates');
{
  const problems = validateAllShipped();
  eq(problems.length, 0, `validators clean (${problems.slice(0, 3).join('; ')})`);
  eq(JOURNEY.length, 42, '42 journey stages');
  // Daily determinism.
  const d1 = dailyContent('2026-08-17');
  const d2 = dailyContent('2026-08-17');
  eq(JSON.stringify(d1.targets), JSON.stringify(d2.targets), 'daily immutable for a date');
  ok(d1.id !== dailyContent('2026-08-18').id, 'daily differs by date');
  // Generator determinism.
  eq(hashString(JSON.stringify(generateArt('x', 16, 4).targets)),
     hashString(JSON.stringify(generateArt('x', 16, 4).targets)), 'generator deterministic');
  // Lessons are completable (sanity: all targets fillable).
  for (const l of LESSONS) {
    const { content } = lessonContent(l.id);
    const s = new Session(content);
    s.start();
    fillAll(s);
    eq(s.state.status, 'complete', `lesson ${l.id} completable`);
  }
}

// ---------------------------------------------------------------------------
section('golden sessions: easy / medium / hard / interrupted / terminal');
{
  // Easy: full region playthrough of a lesson board.
  const runGolden = (content, script) => {
    const s = new Session(content, { sessionId: 'golden' });
    s.start();
    script(s);
    return s;
  };
  const auto = (s, useRegion) => {
    let guard = 10000;
    while (!rules.isTerminal(s.state) && guard-- > 0) {
      const la = rules.legalActions(s.state);
      if (!la.colors.length) break;
      const pick = la.colors[0];
      const cell = pick.sample;
      s.select(pick.color);
      if (useRegion) s.fill(cell, pick.color, 'region');
      else s.fill(cell, pick.color, 'brush');
      s.advanceTime(500);
    }
  };
  const g1 = runGolden(lessonContent('learn-1').content, (s) => auto(s, false));
  eq(g1.state.status, 'complete', 'golden easy completes');
  const g2 = runGolden(practiceContent('standard', 'golden-std'), (s) => auto(s, true));
  eq(g2.state.status, 'complete', 'golden medium completes');
  ok(g2.state.stats.regionFills > 0, 'golden medium used region tool');
  const g3 = runGolden(challengeContent('speed', 2, 'golden-hard'), (s) => auto(s, true));
  ok(['complete', 'failed'].includes(g3.state.status), 'golden hard reaches terminal');
  // Interrupted: abandon mid-run.
  const g4 = runGolden(practiceContent('calm', 'golden-int'), (s) => {
    auto(s, true);
    if (!rules.isTerminal(s.state)) s.abandon();
  });
  // Resumed: snapshot → restore → continue → same terminal hash as uninterrupted.
  const contentR = practiceContent('calm', 'golden-resume');
  const sA = new Session(contentR, { sessionId: 'res' });
  sA.start();
  const sB = new Session(contentR, { sessionId: 'res' });
  sB.start();
  // play 10 fills on both
  for (let i = 0; i < 10; i++) {
    for (const s of [sA, sB]) {
      if (rules.isTerminal(s.state)) break;
      const la = rules.legalActions(s.state);
      const pick = la.colors[0];
      s.select(pick.color);
      s.fill(pick.sample, pick.color, 'brush');
      s.advanceTime(400);
    }
  }
  const snap = sB.snapshot();
  const sC = Session.restore(snap, {});
  eq(rules.hashState(sC.state), rules.hashState(sB.state), 'restore reproduces hash');
  // finish both
  for (const s of [sA, sC]) auto(s, true);
  eq(rules.hashState(sA.state), rules.hashState(sC.state), 'resumed session matches uninterrupted');

  // Golden totals (pinned — regenerate only with a deliberate rules change).
  console.log('   golden totals:', {
    easy: g1.state.final.total, medium: g2.state.final.total,
    hard: g3.state.final?.total ?? 'n/a', interrupted: g4.state.final.total,
  });
  eq(g1.state.final.total, 2298, 'golden easy total pinned');
  eq(g1.state.final.elapsedMs, 17500, 'golden easy time pinned');
}

// ---------------------------------------------------------------------------
section('session: boards, tie-breaks');
{
  const s = new Session(testContent());
  s.start();
  fillAll(s);
  const e = boardEntryFromSession(s, 'Tester');
  ok(e.envelope && e.score > 0, 'board entry carries envelope + score');
  const a = { score: 100, progressPct: 100, errors: 0, elapsedMs: 5000, sessionId: 'a' };
  const b = { score: 100, progressPct: 100, errors: 1, elapsedMs: 4000, sessionId: 'b' };
  ok(compareBoardEntries(a, b) < 0, 'tie → fewer errors wins');
  const c = { ...a, sessionId: 'z' };
  ok(compareBoardEntries(a, c) < 0, 'full tie → stable session id');
}

// ---------------------------------------------------------------------------
section('storage: checksum, migration, corruption');
{
  const store = new SaveStore();
  store.update((d) => { d.stats.cellsFilled = 42; });
  const doc = store.exportDoc();
  eq(doc.data.stats.cellsFilled, 42, 'persisted value');
  // Corruption → rejected by importDoc.
  const bad = JSON.parse(JSON.stringify(doc));
  bad.data.stats.cellsFilled = 9999;
  let threw = false;
  try { store.importDoc(bad); } catch { threw = true; }
  ok(threw, 'corrupted checksum rejected');
  // Migration fills new fields on old-shaped saves.
  const ancient = { v: 0, rev: 1, updatedAt: 1, data: { profile: { name: 'Old' } } };
  ancient.checksum = checksumOf({ v: ancient.v, rev: ancient.rev, updatedAt: ancient.updatedAt, data: ancient.data });
  store.importDoc(ancient);
  eq(store.data.profile.name, 'Old', 'old save value kept');
  ok(store.data.settings.a11y && store.data.cosmetics.unlocked.length > 0, 'defaults merged on migrate');
  // Revision resolution.
  eq(SaveStore.resolveRevision(null, doc), 'remote', 'no local → remote');
  eq(SaveStore.resolveRevision(doc, null), 'local', 'no remote → local');
  eq(SaveStore.resolveRevision(doc, doc), 'local', 'same → local');
  const older = { ...doc, rev: doc.rev - 1, checksum: 'x' };
  eq(SaveStore.resolveRevision(doc, older), 'local', 'newer local wins');
  const conflict = { ...doc, checksum: 'different' };
  eq(SaveStore.resolveRevision(doc, conflict), 'conflict', 'same rev diff content → conflict');
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('Failures:', failures.join(' | '));
  process.exit(1);
}
console.log('ALL TESTS PASSED');
