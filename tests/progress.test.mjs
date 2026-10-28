// The engine build's save model (js/progress.js): normalizing, the two-device
// merge (the browser build's mergeSaveData rules), the browser build's cloud
// slot read as a foreign save (checksummed wrapper, options carried over),
// options validation, a finished round's bookkeeping and the local boards.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/progress.js';
import { Session } from '../js/session.js';
import { lessonContent, JOURNEY } from '../js/content.js';

test('normalize fills defaults and keeps known values', () => {
  const d = P.normalize({ data: { profile: { name: 'Neon', guest: false }, stats: { cellsFilled: 7 }, cosmetics: { unlocked: ['rose-quartz'], theme: 'rose-quartz' } } });
  assert.equal(d.v, P.SAVE_SCHEMA);
  assert.equal(d.data.profile.name, 'Neon');
  assert.equal(d.data.profile.guest, false);
  assert.equal(d.data.stats.cellsFilled, 7);
  assert.equal(d.data.stats.sessions, 0);
  assert.deepEqual(d.data.cosmetics.unlocked.sort(), ['neon-draft', 'rose-quartz']);
  assert.deepEqual(P.normalize(null), P.defaultSave());
  assert.ok(P.sameSave(null, P.defaultSave()));
});

test('merge keeps the best progress of both devices', () => {
  const a = P.normalize({ data: { journey: { stars: { j01: 1, j02: 3 }, bestScores: { j01: 100 } }, achievements: { 'first-completion': 50 },
    daily: { lastDate: '2026-10-01', streak: 2, history: { '2026-10-01': { score: 10 } } }, stats: { cellsFilled: 100, sessions: 9 },
    tutorials: { done: ['learn-1'] }, rivals: [{ name: 'Ada', best: 5 }], cosmetics: { unlocked: ['ember-grid'], theme: 'ember-grid' } } });
  const b = P.normalize({ data: { profile: { name: 'Neon', guest: false }, journey: { stars: { j01: 3 }, bestScores: { j01: 50, j03: 7 } },
    achievements: { 'first-completion': 30, 'mechanic-mastery': 40 }, daily: { lastDate: '2026-10-03', streak: 1, history: { '2026-10-01': { score: 20 } } },
    stats: { cellsFilled: 40, sessions: 12 }, tutorials: { done: ['learn-2'] }, rivals: [{ name: 'Ada', best: 9 }, { name: 'Bo', best: 1 }] } });
  const m = P.mergeSave(a, b).data;
  assert.deepEqual(m.journey.stars, { j01: 3, j02: 3 });
  assert.deepEqual(m.journey.bestScores, { j01: 100, j03: 7 });
  assert.deepEqual(m.achievements, { 'first-completion': 30, 'mechanic-mastery': 40 });
  assert.equal(m.daily.lastDate, '2026-10-03');
  assert.equal(m.daily.streak, 1);
  assert.equal(m.daily.history['2026-10-01'].score, 20);
  assert.equal(m.stats.cellsFilled, 100);
  assert.equal(m.stats.sessions, 12);
  assert.deepEqual(m.tutorials.done.sort(), ['learn-1', 'learn-2']);
  assert.deepEqual(m.rivals, [{ name: 'Ada', best: 9 }, { name: 'Bo', best: 1 }]);
  assert.equal(m.profile.name, 'Neon');
  assert.equal(m.cosmetics.theme, 'neon-draft'); // the local (second) device's theme
  assert.ok(m.cosmetics.unlocked.includes('ember-grid'));
  // a named profile wins over a guest either way round
  assert.equal(P.mergeSave(b, a).data.profile.name, 'Neon');
  // merging twice changes nothing
  assert.ok(P.sameSave(P.mergeSave(a, P.mergeSave(a, b)), P.mergeSave(a, b)));
});

function oldCloudDoc(data) {
  const body = { v: 1, rev: 4, updatedAt: 123, data };
  return JSON.stringify({ ...body, checksum: P.checksumOf(body) });
}
test('the browser build cloud slot reads as a foreign save', () => {
  const text = oldCloudDoc({
    profile: { name: 'Old', guest: false }, journey: { stars: { j01: 2 }, bestScores: { j01: 900 } }, stats: { cellsFilled: 12, sessions: 3 },
    settings: { audio: { music: 0.2 }, a11y: { palette: 'cvd', cellLabels: true, leftHanded: true, captions: false, bogus: 1 } },
  });
  const f = P.readForeign(text);
  assert.ok(f);
  assert.equal(f.save.data.profile.name, 'Old');
  assert.equal(f.save.data.journey.stars.j01, 2);
  assert.equal(f.save.data.settings, undefined);
  assert.deepEqual(f.options, { palette: 'cvd', leftHanded: true, captions: false, cellLabels: true });
  // a tampered or foreign document is not adopted
  const bad = JSON.parse(text); bad.data.stats.cellsFilled = 999;
  assert.equal(P.readForeign(JSON.stringify(bad)), null);
  assert.equal(P.readForeign('not json'), null);
  assert.equal(P.readForeign('{"other":1}'), null);
});

test('options are validated', () => {
  assert.deepEqual(P.pickOptions({ palette: 'neon', haptics: 'yes', timingAssist: true, holdToDrag: false }), { timingAssist: true, holdToDrag: false });
  assert.deepEqual(P.pickOptions(null), {});
  assert.equal(P.OPTION_KEYS.length, 7);
});

function play(content, mode) {
  const s = new Session(content);
  s.start();
  const st = s.state;
  for (let i = 0; i < st.targets.length; i++) if (!st.filled[i]) { s.select(st.targets[i]); s.fill(i, st.targets[i], 'brush'); }
  return s;
}
test('a finished round records stats, stars, lessons, achievements and themes', () => {
  const d = P.defaultData();
  const lc = lessonContent('learn-1');
  const s = play(lc.content);
  const r = P.recordRound(d, { state: s.state, mode: 'learn', contentId: lc.content.id, mastery: false, lessonId: 'learn-1', final: s.state.final, now: 5 });
  assert.equal(s.state.status, 'complete');
  assert.deepEqual(d.tutorials.done, ['learn-1']);
  assert.equal(d.stats.roundsCompleted, 1);
  assert.equal(d.stats.cellsFilled, s.state.stats.correct);
  assert.deepEqual(r.achievements.map((a) => a.key), ['first-completion']);
  assert.equal(d.achievements['first-completion'], 5);
  // journey stars and best score
  const j = play(JOURNEY[0]);
  P.recordRound(d, { state: j.state, mode: 'journey', contentId: 'j01', mastery: false, lessonId: null, final: j.state.final });
  assert.equal(d.journey.stars.j01, P.starsFor(j.state));
  assert.ok(d.journey.bestScores.j01 > 0);
  // the daily streak follows consecutive days; a gap restarts it
  const daily = (date) => P.recordRound(d, { state: j.state, mode: 'daily', contentId: `daily-${date}`, mastery: false, lessonId: null, final: j.state.final });
  daily('2026-10-01'); daily('2026-10-02'); daily('2026-10-02'); daily('2026-10-03');
  assert.equal(d.daily.streak, 3);
  assert.ok(d.cosmetics.unlocked.includes('verdant-circuit'));
  daily('2026-10-05');
  assert.equal(d.daily.streak, 1);
  // 5,000 cells unlock Rose Quartz, 10,000 the Marathon Painter
  d.stats.cellsFilled = 9990;
  const big = P.recordRound(d, { state: j.state, mode: 'practice', contentId: 'x', mastery: true, lessonId: null, final: j.state.final });
  assert.deepEqual(big.achievements.map((a) => a.key).sort(), ['marathon-painter', 'mechanic-mastery']);
  assert.ok(big.themes.includes('rose-quartz'));
});

test('local boards keep the best 50 in tie-break order without envelopes', () => {
  let boards = {};
  let last;
  for (let i = 0; i < 55; i++) {
    last = P.recordScore(boards, 'b1', { name: 'P', score: i, progressPct: 100, errors: 0, elapsedMs: 1000, sessionId: `s${i}`, envelope: { big: true } });
    boards = last.boards;
  }
  assert.equal(boards.b1.length, 50);
  assert.equal(boards.b1[0].score, 54);
  assert.equal(last.rank, 1);
  assert.equal(last.total, 51); // the stored 50 plus this one (main.js recordScore)
  assert.ok(!('envelope' in boards.b1[0]));
  const d = P.defaultData();
  d.rivals.push({ name: 'P', best: 3 });
  P.noteRivalBest(d, 'P', 10);
  assert.equal(d.rivals[0].best, 10);
});
