// progress.js — the save model of the engine build (pure, shared with the node
// tests): the player's progress document (what js/storage.js kept under
// pixelatelier.save.v1 minus the settings, which are now the runtime's Options
// and the game's own options), its merge for two devices' saves (the browser
// build's mergeSaveData), the browser build's cloud slot read as a foreign save
// (its checksummed { v, rev, updatedAt, data } wrapper), the game's options, and
// the bookkeeping a finished round does (main.js onTerminal: lifetime stats,
// journey stars, the daily streak, achievements, theme unlocks; local boards).

import { cyrb53 } from './rng.js';
import { compareBoardEntries } from './session.js';

export const SAVE_SCHEMA = 1;

export const ACHIEVEMENTS = [
  { key: 'first-completion', name: 'First Light', desc: 'Complete your first canvas.' },
  { key: 'mechanic-mastery', name: 'Mastery', desc: 'Complete a journey mastery stage.' },
  { key: 'daily-streak-7', name: 'Seven-Day Streak', desc: 'Complete dailies on 7 consecutive days.' },
  { key: 'expert-milestone', name: 'Grand Atelier', desc: 'Complete the final journey stage.' },
  { key: 'marathon-painter', name: 'Marathon Painter', desc: 'Paint 10,000 cells in total.' },
];

/** The progress document (storage.js defaultSaveData without `settings`). */
export function defaultData() {
  return {
    profile: { name: 'Guest', guest: true },
    journey: { stars: {}, bestScores: {} },
    achievements: {},
    daily: { lastDate: null, streak: 0, best: {}, history: {} },
    stats: { cellsFilled: 0, sessions: 0, playtimeMs: 0, roundsCompleted: 0 },
    tutorials: { done: [] },
    cosmetics: { unlocked: ['neon-draft'], theme: 'neon-draft' },
    rivals: [],
  };
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Any stored shape (engine save data, or the browser build's data) → a full progress document. */
export function normalizeData(d0) {
  const d = obj(d0);
  const def = defaultData();
  const profile = obj(d.profile);
  return {
    profile: { name: typeof profile.name === 'string' && profile.name ? profile.name.slice(0, 24) : def.profile.name, guest: profile.guest !== false },
    journey: { stars: { ...obj(obj(d.journey).stars) }, bestScores: { ...obj(obj(d.journey).bestScores) } },
    achievements: { ...obj(d.achievements) },
    daily: { ...def.daily, ...obj(d.daily), best: { ...obj(obj(d.daily).best) }, history: { ...obj(obj(d.daily).history) } },
    stats: { ...def.stats, ...obj(d.stats) },
    tutorials: { done: Array.isArray(obj(d.tutorials).done) ? obj(d.tutorials).done.filter((x) => typeof x === 'string') : [] },
    cosmetics: {
      unlocked: Array.isArray(obj(d.cosmetics).unlocked) && obj(d.cosmetics).unlocked.length ? [...new Set(['neon-draft', ...obj(d.cosmetics).unlocked])] : ['neon-draft'],
      theme: typeof obj(d.cosmetics).theme === 'string' ? obj(d.cosmetics).theme : 'neon-draft',
    },
    rivals: Array.isArray(d.rivals) ? d.rivals.filter((r) => r && typeof r.name === 'string').map((r) => ({ name: r.name, best: Number(r.best) || 0 })) : [],
  };
}

export function defaultSave() { return { v: SAVE_SCHEMA, data: defaultData() }; }
/** A stored save document (or null) → { v, data }. */
export function normalize(raw) {
  const r = obj(raw);
  return { v: SAVE_SCHEMA, data: normalizeData(r.data) };
}
export function sameSave(a, b) { return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b)); }

/**
 * Two devices' progress (storage.js mergeSaveData): per-stage best stars and
 * scores, earliest achievement dates, unions of tutorials, unlocks, rivals and
 * daily history, larger lifetime stats; the streak follows the more recent
 * last-played day; this device's theme; a named profile wins over a guest.
 */
export function mergeData(remote, local) {
  const r = normalizeData(remote), l = normalizeData(local);
  const maxMap = (a = {}, b = {}) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = Math.max(Number(out[k]) || 0, Number(v) || 0);
    return out;
  };
  const achievements = { ...r.achievements };
  for (const [k, v] of Object.entries(l.achievements)) achievements[k] = achievements[k] ? Math.min(achievements[k], v) : v;
  const history = { ...r.daily.history };
  for (const [k, v] of Object.entries(l.daily.history)) history[k] = { score: Math.max(history[k]?.score || 0, v?.score || 0) };
  const newer = String(l.daily.lastDate || '') >= String(r.daily.lastDate || '') ? l.daily : r.daily;
  const rivals = r.rivals.map((x) => ({ ...x }));
  for (const x of l.rivals) {
    const hit = rivals.find((y) => y.name === x.name);
    if (hit) hit.best = Math.max(hit.best || 0, x.best || 0); else rivals.push({ ...x });
  }
  const stats = {};
  for (const k of new Set([...Object.keys(r.stats), ...Object.keys(l.stats)])) stats[k] = Math.max(Number(r.stats[k]) || 0, Number(l.stats[k]) || 0);
  return {
    profile: l.profile.guest && !r.profile.guest ? r.profile : l.profile,
    journey: { stars: maxMap(r.journey.stars, l.journey.stars), bestScores: maxMap(r.journey.bestScores, l.journey.bestScores) },
    achievements,
    daily: { ...newer, best: maxMap(r.daily.best, l.daily.best), history },
    stats,
    tutorials: { done: [...new Set([...r.tutorials.done, ...l.tutorials.done])] },
    cosmetics: { theme: l.cosmetics.theme, unlocked: [...new Set([...r.cosmetics.unlocked, ...l.cosmetics.unlocked])] },
    rivals,
  };
}
export function mergeSave(remote, local) {
  return { v: SAVE_SCHEMA, data: mergeData(obj(remote).data, obj(local).data) };
}

// --- the game's options (engine settings; the browser build's settings.a11y) ---
export const DEFAULT_OPTIONS = {
  palette: 'default', leftHanded: false, holdToDrag: true, timingAssist: false, haptics: true, captions: true, cellLabels: false,
};
export const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
export const PALETTES = ['default', 'contrast', 'cvd'];
/** The valid options in `raw` (unknown keys and wrong types dropped). */
export function pickOptions(raw) {
  const r = obj(raw), out = {};
  for (const k of OPTION_KEYS) {
    const v = r[k];
    if (k === 'palette') { if (PALETTES.includes(v)) out[k] = v; } else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}
/** The browser build's settings KV keys (prefs() + the language helper's ui.*), all removed once read. */
export const BROWSER_KEYS = ['audio', 'graphics', 'a11y', 'camera'];

/** storage.js checksumOf. */
export function checksumOf(o) { return cyrb53(JSON.stringify(o)).toString(16).padStart(14, '0'); }

/**
 * The browser build's cloud slot (game:<slug>: storage.js exportDoc, a
 * checksummed { v, rev, updatedAt, data } with data.settings) → its progress
 * as a save and its options; null when it is not that document or its
 * checksum fails (storage.js mergeDoc refused those too).
 */
export function readForeign(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || typeof doc !== 'object' || doc.checksum == null || !doc.data || typeof doc.data !== 'object') return null;
  const { checksum, ...body } = doc;
  if (checksumOf(body) !== checksum) return null;
  return { save: { v: SAVE_SCHEMA, data: normalizeData(doc.data) }, options: pickOptions(obj(doc.data.settings).a11y) };
}

// --- a finished round (main.js onTerminal) ---
export function starsFor(state) {
  if (state.status !== 'complete') return 0;
  let stars = 1;
  if (state.stats.errors === 0) stars++;
  if (state.par.timeMs === 0 || state.elapsedMs <= state.par.timeMs) stars++;
  return stars;
}

/** The UTC day before `date` (YYYY-MM-DD). */
export function dayBefore(date) {
  const y = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) - 1));
  return y.toISOString().slice(0, 10);
}

/**
 * Records a terminal round in `d` (mutated): returns { achievements: [defs], themes: [ids] } newly unlocked.
 * round: { state, mode, contentId, mastery, lessonId, final, now }.
 */
export function recordRound(d, round) {
  const { state, mode, contentId, mastery, lessonId, final } = round;
  const now = round.now ?? Date.now();
  const complete = state.status === 'complete';
  const unlocked = [];
  const themes = [];
  d.stats.cellsFilled += state.stats.correct;
  d.stats.playtimeMs += state.elapsedMs;
  if (complete) d.stats.roundsCompleted++;
  if (lessonId && complete && !d.tutorials.done.includes(lessonId)) d.tutorials.done.push(lessonId);
  if (mode === 'journey' && complete) {
    d.journey.stars[contentId] = Math.max(d.journey.stars[contentId] || 0, starsFor(state));
    d.journey.bestScores[contentId] = Math.max(d.journey.bestScores[contentId] || 0, final.total);
  }
  if (mode === 'daily' && complete) {
    const date = contentId.replace('daily-', '');
    const prev = d.daily.history[date];
    d.daily.history[date] = { score: Math.max(prev?.score || 0, final.total) };
    if (d.daily.lastDate === date) { /* already counted */ }
    else if (d.daily.lastDate === dayBefore(date)) { d.daily.streak += 1; d.daily.lastDate = date; }
    else { d.daily.streak = 1; d.daily.lastDate = date; }
  }
  const grant = (key) => {
    if (!d.achievements[key]) {
      d.achievements[key] = now;
      unlocked.push(ACHIEVEMENTS.find((a) => a.key === key));
    }
  };
  if (complete) grant('first-completion');
  if (complete && mastery) grant('mechanic-mastery');
  if (d.daily.streak >= 7) grant('daily-streak-7');
  if (complete && contentId === 'j42') grant('expert-milestone');
  if (d.stats.cellsFilled >= 10000) grant('marathon-painter');
  const stageCount = Object.keys(d.journey.stars).length;
  for (const [id, ok] of [
    ['ember-grid', stageCount >= 12],
    ['verdant-circuit', d.daily.streak >= 3],
    ['mono-blueprint', stageCount >= 10],
    ['rose-quartz', d.stats.cellsFilled >= 5000],
  ]) {
    if (ok && !d.cosmetics.unlocked.includes(id)) { d.cosmetics.unlocked.push(id); themes.push(id); }
  }
  return { achievements: unlocked, themes };
}

/**
 * Local (casual) boards (main.js recordScore): the entry joins its board (best
 * 50 kept, the tie-break order of session.js); returns { boards, rank, total }.
 * Entries are kept without their replay envelope (device storage holds the
 * boards in one key; nothing read the stored envelopes back).
 */
export function recordScore(boards0, boardId, entry0) {
  const boards = { ...obj(boards0) };
  const { envelope, ...entry } = entry0;
  void envelope;
  const list = Array.isArray(boards[boardId]) ? boards[boardId].slice() : [];
  list.push(entry);
  list.sort(compareBoardEntries);
  boards[boardId] = list.slice(0, 50);
  return { boards, rank: list.indexOf(entry) + 1, total: list.length };
}

/** Rival bests: a rival named as the player takes the round's score. */
export function noteRivalBest(d, name, score) {
  for (const r of d.rivals) if (r.name === name) r.best = Math.max(r.best || 0, score);
}
