// Pixel Atelier on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (js/rules.js), content (js/content.js)
// and session (js/session.js: validated commands, replay log, snapshots) are
// the browser build's, unchanged; this module is what js/main.js did around
// them — the state machine (title → mode select / setup → countdown → active
// ⇄ paused → resolving → results), every mode (Learn, Journey, Daily,
// Practice, Challenge, Score Chase), the session's events (sounds, captions,
// sparks, toasts, announcements, lesson steps, hints), the round's bookkeeping
// (stats, stars, the daily streak, achievements, theme unlocks, the local
// boards, the Score Chase post), the replay, the round snapshot and its
// resume, painting by pointer, finger, keys and pads (brush strokes with
// interpolation, the region tool, the keyboard cursor), the camera (wheel,
// pinch, two-finger and right-drag pan, pan mode, refit) and the lifecycle (a
// hidden window pauses a round, as visibilitychange did). Screens are drawn
// by screens.ts (starhermit:ui), the drafting table by render.ts
// (starhermit:scene).
//
// Time is the runtime's fixed steps (60 a second): the authoritative round
// clock accumulates them and dispatches the same quantized tick commands the
// browser build sent from requestAnimationFrame (≥ 200 ms, in 100 ms quanta),
// and the countdown, the results delay, toasts, captions, the hint highlight,
// the replay and the autosave run on the same clock, so slow frames never
// change a round and play scripts replay exactly.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, onWheel } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import {
  Content, Progress, Rules, Sessions, type Achievement, type BoardEntry, type Content as ContentT, type Final, type GameEvent,
  type Lesson, type Session, type Snapshot,
} from "./game.ts";
import * as audio from "./audio.ts";
import { N, S, T, contentTitle, fmtTime } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type ScreenName = "title" | "learn" | "journey" | "setup" | "results" | "profile" | "board" | "settings" | "help";
export type Mode = "learn" | "journey" | "daily" | "practice" | "challenge" | "score-chase";
export interface SetupRow { k: string; v: string }
export interface Setup {
  mode: Mode; title: string; rows: SetupRow[]; note: string; startLabel: string; content: ContentT | null;
  countdown?: boolean;
}
export interface Results {
  reason: string; status: string; final: Final; stars: number; achievements: Achievement[];
  board: { rank: number; total: number; ranked: boolean } | null; canNext: boolean; nextLabel: string;
  lb: platform.Posted | "posting" | null;
}
export interface Confirm { title: string; text: string; yes: () => void; no?: () => void }

/** main.js RESULT_REASONS. */
export const RESULT_REASONS: Record<string, string> = {
  "all-filled": "Canvas complete!", "move-limit": "Out of actions", "time-limit": "Out of time", "error-limit": "Too many errors", abandoned: "Round abandoned",
};

export const app = {
  /** The full-page screen, or null on the drafting table (the HUD). */
  screen: "title" as ScreenName | null,
  /** The pause card or a confirmation over the current view. */
  overlay: null as "pause" | "confirm" | null,
  confirm: null as Confirm | null,
  /** Where Settings returns to (Back): the title, or the pause card of a paused round. */
  settingsFrom: "title" as "title" | "pause",
  /** Compact layouts: the open side drawer. */
  drawer: null as "left" | "right" | null,
  openedFrame: 0,
  screenFrame: 0,
  focusNext: null as string | null,
  appState: "title" as "title" | "mode-select" | "countdown" | "active" | "paused" | "resolving" | "results",
  session: null as Session | null,
  content: null as ContentT | null,
  lastContent: null as ContentT | null,
  mode: "journey" as Mode,
  lesson: null as { def: Lesson; fills: number; strokeCells: Map<string, number>; maxStroke: number; cameraMoved: boolean } | null,
  lessonStep: 0,
  lessonStarted: false,
  tool: "brush" as "brush" | "region",
  panMode: false,
  keyboardCell: -1,
  hoverCell: -1,
  combo: 0,
  countdown: null as string | null,
  toast: null as { text: string; until: number } | null,
  caption: null as { text: string; until: number } | null,
  pauseSummary: (): string => "",
  results: null as Results | null,
  setup: null as Setup | null,
  practicePreset: "standard",
  practiceSeed: "",
  challengeType: "speed",
  challengeLevel: 2,
  /** The Leaderboard screen. */
  board: { id: "", scope: "global" as "global" | "friends", label: (): string => "", entries: null as BoardEntry[] | null, note: "", key: 0 },
  lastBoardId: null as string | null,
  replay: false,
};
let clockMs = 0;
export const now = (): number => clockMs;
export const fresh = (): boolean => frame().frame !== app.openedFrame;

// ------------------------------------------------------------------ timers on the clock
const timers: { at: number; fn: () => void; tag: string }[] = [];
function after(ms: number, fn: () => void, tag = ""): void { timers.push({ at: clockMs + ms, fn, tag }); }
function cancel(tag: string): void { for (let i = timers.length - 1; i >= 0; i--) if (timers[i]!.tag === tag) timers.splice(i, 1); }
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }

// ------------------------------------------------------------------ helpers
export function announce(text: string, assertive = false): void {
  if (text) ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
/** ui.js toast (one at a time, 2.6 s). */
export function toast(text: string, ms = 2600): void { app.toast = { text, until: clockMs + ms }; }
function caption(text: string): void {
  if (!platform.options.captions) return;
  const m = /^Combo (\d+)$/.exec(text);
  app.caption = { text: m ? T("Combo {n}", { n: m[1]! }) : T(text), until: clockMs + 2200 };
}
export function resolvedPalette(c: ContentT | null = app.content): string[] {
  return Content.remapPalette(c?.palette ?? [], platform.options.palette);
}
export function theme(): ReturnType<typeof Content.getTheme> { return Content.getTheme(platform.data().cosmetics.theme); }
export function playing(): boolean { return app.screen === null && app.overlay === null && !!app.session; }

// ------------------------------------------------------------------ screens
export function openScreen(name: ScreenName | null): void {
  app.screen = name;
  app.drawer = null;
  app.openedFrame = app.screenFrame = frame().frame;
  ui.setFocus(null);
}
export function toTitle(): void {
  app.appState = "title";
  teardownSession(false);
  openScreen("title");
  app.focusNext = "btn-play";
  audio.play("ui.open");
}
/** Back on a menu screen (data-nav="title"): a paused round's settings return to its pause card. */
export function navBack(): void {
  audio.play("ui.back");
  if (app.screen === "settings" && app.settingsFrom === "pause" && app.session && app.appState === "paused") {
    openScreen(null);
    openPause();
  } else toTitle();
}
export function openMode(mode: Mode): void {
  audio.play("ui.open");
  app.mode = mode;
  if (mode === "learn" || mode === "journey") {
    app.appState = "mode-select";
    openScreen(mode);
    return;
  }
  showSetup(mode, null);
}
/** main.js onPlay: continue the Journey at the first stage without stars. */
export function quickPlay(): void {
  const stars = platform.data().journey.stars;
  const next = Content.JOURNEY.find((s) => !(stars[s.id]! > 0)) ?? Content.JOURNEY[Content.JOURNEY.length - 1]!;
  app.mode = "journey";
  showSetup("journey", next);
}
export function openSettings(from: "title" | "pause"): void {
  app.settingsFrom = from;
  if (from === "pause") app.overlay = null;
  openScreen("settings");
}
export function openHelp(): void { openScreen("help"); }
export function openProfile(): void { openScreen("profile"); }

// ------------------------------------------------------------------ setup (main.js showSetup)
export function showSetup(mode: Mode, preset: ContentT | null): void {
  app.appState = "mode-select";
  app.mode = mode;
  let s: Setup;
  if (mode === "journey" && preset) {
    s = { mode, title: contentTitle(preset.meta.title), rows: summaryRows(preset), note: preset.meta.mastery ? "Mastery table — combined mechanics." : "Journey stage.", startLabel: N("Start"), content: preset };
  } else if (mode === "daily") {
    const c = Content.dailyContent(platform.utcDate());
    s = { mode, title: N("Daily Table"), rows: summaryRows(c), note: N("One shared seed per UTC day."), startLabel: N("Start daily"), content: c, countdown: true };
  } else if (mode === "practice") {
    s = { mode, title: N("Practice"), rows: [], note: N("Unranked. Restart and undo freely — nothing here affects ratings."), startLabel: N("Start"), content: null };
  } else if (mode === "challenge") {
    s = { mode, title: N("Challenge"), rows: [], note: "", startLabel: N("Start"), content: null };
  } else {
    const c = Content.scoreChaseContent(platform.isoWeek());
    s = { mode, title: N("Score Chase"), rows: summaryRows(c), note: N("Same seed for everyone this week. Highest validated total wins."), startLabel: N("Start chase"), content: c };
  }
  app.setup = s;
  openScreen("setup");
  app.focusNext = "btn-setup-start";
}
/** main.js addRulesSummary (keys translated where shown). */
function summaryRows(content: ContentT): SetupRow[] {
  const r = content.ruleset;
  const assist = platform.options.timingAssist;
  const rows: SetupRow[] = [
    { k: N("Canvas"), v: T("{w}×{h} · {n} colors", { w: content.width, h: content.height, n: content.palette.length }) },
    { k: N("Difficulty"), v: "★".repeat(Content.difficultyOf(content)) },
    { k: N("Expected"), v: fmtTime(content.par.timeMs) },
    { k: N("Ranked"), v: content.meta.ranked ? T("Yes — validated board") : T("No") },
  ];
  if (r.moveLimit != null) rows.push({ k: N("Move limit"), v: T("{n} actions", { n: r.moveLimit }) });
  if (r.timeLimitMs != null) rows.push({ k: N("Time limit"), v: fmtTime(assist ? r.timeLimitMs * 1.5 : r.timeLimitMs) + (assist ? " " + T("(assist)") : "") });
  if (!r.errorPrevention) rows.push({ k: N("Errors"), v: r.errorLimit ? T("Count against you · fail at {n}", { n: r.errorLimit }) : T("Count against you") });
  if (!r.tools.region) rows.push({ k: N("Tools"), v: T("Region tool disabled") });
  if (r.sequence) rows.push({ k: N("Order"), v: T("Colors unlock in sequence") });
  rows.push({ k: N("Seed"), v: content.seed });
  return rows;
}
export function setupRows(): SetupRow[] { return app.setup?.content ? summaryRows(app.setup.content) : []; }
export function startSetup(): void {
  const s = app.setup;
  if (!s) return;
  let c = s.content;
  if (s.mode === "practice") c = Content.practiceContent(app.practicePreset, app.practiceSeed.trim() || `practice:${app.practicePreset}:${Date.now().toString(36)}`);
  if (s.mode === "challenge") c = Content.challengeContent(app.challengeType, app.challengeLevel);
  if (c) startRound(c, s.mode);
}

// ------------------------------------------------------------------ the round
export function startRound(content0: ContentT, mode: Mode): void {
  let content = content0;
  if (platform.options.timingAssist && content.ruleset.timeLimitMs) {
    content = JSON.parse(JSON.stringify(content)) as ContentT;
    content.ruleset.timeLimitMs = Math.round(content.ruleset.timeLimitMs! * 1.5);
    content.meta.assists = ["timing"];
  }
  teardownSession(false);
  app.content = content;
  app.mode = mode;
  app.lastContent = content;
  app.appState = "countdown";
  app.tool = "brush";
  app.panMode = false;
  app.keyboardCell = -1;
  app.hoverCell = -1;
  app.combo = 0;
  app.results = null;
  app.replay = false;
  stroke = null;
  app.session = new Sessions.Session(content, { onEvents: (e) => onSessionEvents(e), onState: () => { autosaveDirty = true; } });
  render.setTheme(theme());
  render.setBoard(content, resolvedPalette());
  render.syncState(app.session.state);
  openScreen(null);
  announce(`${contentTitle(content.meta.title)}. ${objectiveText(content)}`);
  // Countdown — input locked during this shortest resolution phase.
  let n = 3;
  app.countdown = String(n);
  audio.play("ui.tap");
  const step = (): void => {
    n--;
    if (n > 0) {
      app.countdown = String(n);
      audio.play("ui.tap");
      after(700, step, "countdown");
    } else {
      app.countdown = "Go!";
      audio.play("resume");
      after(500, () => {
        app.countdown = null;
        app.session?.start();
        app.appState = "active";
        audio.setAmbience(theme().ambience);
        audio.startMusic(content.seed);
      }, "countdown");
    }
  };
  after(700, step, "countdown");
}
export function objectiveText(content: ContentT): string {
  const r = content.ruleset;
  if (r.sequence) return T("Fill colors in order — the palette shows which is active.");
  if (r.moveLimit != null) return T("Fill every cell within {n} actions.", { n: r.moveLimit });
  if (r.timeLimitMs != null) return T("Fill every cell before time runs out.");
  if (r.errorLimit != null) return T("Fill every cell. {n} wrong cells end the round.", { n: r.errorLimit });
  return T("Fill every cell with its target color.");
}
export function startLesson(lesson: Lesson): void {
  const lc = Content.lessonContent(lesson.id);
  if (!lc) return;
  startRound(lc.content, "learn");
  app.lesson = { def: lesson, fills: 0, strokeCells: new Map(), maxStroke: 0, cameraMoved: false };
  app.lessonStep = 0;
  app.lessonStarted = false;
  announce(T("Lesson: {title}. {intro}", { title: T(lesson.title), intro: T(lesson.intro) }), true);
}
/** The lesson box's text (main.js refreshLessonText). */
export function lessonText(): { title: string; text: string } | null {
  const L = app.lesson;
  if (!L) return null;
  const step = L.def.steps[app.lessonStep];
  if (!app.lessonStarted) return { title: T(L.def.title), text: T(L.def.intro) };
  if (step) return { title: T(L.def.title), text: T("Step {n}/{total}: {text}", { n: app.lessonStep + 1, total: L.def.steps.length, text: T(step.text) }) };
  return { title: T(L.def.title), text: T("Lesson complete!") };
}
function checkLessonEvents(events: GameEvent[]): void {
  const L = app.lesson;
  if (!L) return;
  if (!app.lessonStarted) {
    app.lessonStarted = true;
    const st = L.def.steps[app.lessonStep];
    if (st) announce(T(st.text));
  }
  const step = L.def.steps[app.lessonStep];
  if (!step) return;
  const req = step.require;
  let done = false;
  for (const ev of events) {
    if (req.type === "select" && ev.type === "select" && ev.color === req.color) done = true;
    if (req.type === "fills" && ev.type === "fill") { L.fills += ev.cells?.length ?? 0; if (L.fills >= (req.n ?? 0)) done = true; }
    if (req.type === "region" && ev.type === "fill" && ev.tool === "region") done = true;
    if (req.type === "hint" && ev.type === "hint") done = true;
    if (req.type === "complete" && ev.type === "terminal" && ev.status === "complete") done = true;
  }
  if (req.type === "stroke" && L.maxStroke >= (req.minCells ?? 4)) done = true;
  if (req.type === "camera" && L.cameraMoved) done = true;
  if (done) {
    audio.play("lesson.step");
    app.lessonStep++;
    const next = L.def.steps[app.lessonStep];
    if (next) announce(T(next.text));
  }
}
function noteCameraMove(): void {
  if (app.lesson && app.appState === "active") {
    app.lesson.cameraMoved = true;
    checkLessonEvents([]);
  }
}

// ------------------------------------------------------------------ session events (main.js onSessionEvents)
function onSessionEvents(events: GameEvent[]): void {
  const s = app.session;
  if (!s) return;
  render.applyEvents(events, s.state);
  for (const ev of events) {
    switch (ev.type) {
      case "fill": {
        audio.play(ev.tool === "region" ? "fill.region" : ev.tool === "drag" ? "fill.drag" : "fill.brush");
        if ((ev.combo ?? 0) > 0 && ev.combo! % 5 === 0) audio.play("combo", { tier: ev.combo! / 5, combo: ev.combo! });
        app.combo = ev.combo ?? 0;
        if (app.lesson && stroke) {
          const n = (app.lesson.strokeCells.get(stroke.id) ?? 0) + (ev.cells?.length ?? 0);
          app.lesson.strokeCells.set(stroke.id, n);
          app.lesson.maxStroke = Math.max(app.lesson.maxStroke, n);
        }
        break;
      }
      case "error":
        audio.play("error");
        app.combo = 0;
        announce(T("Wrong color — target was {n}.", { n: ev.target ?? 0 }), true);
        break;
      case "invalid":
        // Mid-stroke rejections (filled/wrong cells under a drag) are expected — acknowledge the stroke start, stay quiet after.
        if (!ev.cmd?.strokeContinuation) {
          audio.play("invalid");
          if (ev.message) { toast(T(ev.message)); announce(T(ev.message), true); }
        }
        break;
      case "select": audio.play("select"); break;
      case "undo": audio.play("undo"); break;
      case "hint":
        audio.play("hint");
        if (ev.hint?.type === "fill") {
          toast(ev.hint.tool === "region" ? T("Try the region tool on the highlighted cell.") : T("Try painting the highlighted cell."));
          flashHint(ev.hint.cell!, ev.hint.tool === "region");
        } else if (ev.hint?.type === "select") {
          toast(T("This color is finished — switch to color {n}.", { n: ev.hint.color === 0 ? "•" : ev.hint.color }));
        }
        break;
      case "pause": audio.play("pause"); break;
      case "resume": audio.play("resume"); break;
      case "terminal": onTerminal(ev); break;
    }
  }
  if (app.lesson) checkLessonEvents(events);
}
function flashHint(cell: number, isRegion: boolean): void {
  const s = app.session;
  if (!s) return;
  render.setGhost(isRegion ? Rules.regionAt(s.state, cell) : [cell]);
  cancel("hint");
  after(1800, () => render.setGhost(null), "hint");
}

// ------------------------------------------------------------------ the end of a round (main.js onTerminal)
function onTerminal(ev: GameEvent): void {
  const s = app.session!, content = app.content!;
  app.appState = "resolving";
  platform.clearSnapshot();
  autosaveDirty = false;
  const state = s.state;
  const final = ev.final!;
  const complete = ev.status === "complete";
  let unlocked: { achievements: Achievement[]; themes: string[] } = { achievements: [], themes: [] };
  platform.update((d) => {
    unlocked = Progress.recordRound(d, {
      state, mode: app.mode, contentId: content.id, mastery: !!content.meta.mastery, lessonId: app.lesson && complete ? app.lesson.def.id : null, final,
    });
  });
  for (const id of unlocked.themes) toast(T("Theme unlocked: {name}", { name: T(Content.getTheme(id).name) }));
  audio.play(complete ? "complete" : "failed");
  audio.setIntensity(0);
  // the local (casual) board
  const entry = Sessions.boardEntryFromSession(s, platform.data().profile.name);
  const boardId = Sessions.boardIdFor({ mode: app.mode, id: content.id });
  let board: Results["board"] = null;
  if (complete || final.progressPct > 0) {
    const r = Progress.recordScore(platform.loadBoards(), boardId, entry);
    platform.saveBoards(r.boards);
    platform.update((d) => Progress.noteRivalBest(d, entry.name, entry.score));
    board = { rank: r.rank, total: r.total, ranked: !!content.meta.ranked };
  }
  app.lastBoardId = boardId;
  let canNext = false, nextLabel = N("Next");
  if (app.mode === "journey" && complete) {
    const idx = Content.JOURNEY.findIndex((x) => x.id === content.id);
    if (idx >= 0 && idx + 1 < Content.JOURNEY.length) { canNext = true; nextLabel = N("Next stage"); }
  } else if (app.mode === "learn") {
    const idx = Content.LESSONS.findIndex((l) => l.id === content.id);
    if (idx >= 0 && idx + 1 < Content.LESSONS.length) { canNext = true; nextLabel = N("Next lesson"); }
  }
  const results: Results = {
    reason: ev.reason ?? "", status: ev.status ?? "", final, stars: app.mode === "journey" ? Progress.starsFor(state) : 0,
    achievements: unlocked.achievements, board: complete ? board : null, canNext, nextLabel, lb: null,
  };
  app.results = results;
  // Signed in only: a Score Chase round that ended on its own posts its total; the results show the rank.
  if (app.mode === "score-chase" && ev.reason !== "abandoned" && platform.signedIn()) {
    results.lb = "posting";
    void platform.postScore(final.total).then((r) => { results.lb = r; });
  }
  // Slight delay so the completion wave reads before the results.
  after(preferences().reducedMotion ? 150 : 1400, () => {
    if (app.results !== results) return;
    app.appState = "results";
    openScreen("results");
    app.focusNext = canNext ? "btn-results-next" : "btn-results-retry";
    const reason = RESULT_REASONS[results.reason];
    announce(T("{reason}. Score {score}. {pct} percent painted.", { reason: reason ? T(reason) : results.status, score: final.total, pct: Math.round(final.progressPct) }), true);
  }, "results");
}
export function leaderboardLine(): string | null {
  const r = app.results?.lb;
  if (!r) return null;
  if (r === "posting") return S("lbPosting");
  return !r.posted ? S("lbNotPosted") : r.rank ? S("lbRank", { rank: r.rank }) : S("lbPosted");
}
export function resultsNext(): void {
  const c = app.content;
  if (app.mode === "journey" && c) {
    const idx = Content.JOURNEY.findIndex((s) => s.id === c.id);
    const next = Content.JOURNEY[idx + 1];
    if (next) { showSetup("journey", next); return; }
  }
  if (app.mode === "learn" && c) {
    const idx = Content.LESSONS.findIndex((l) => l.id === c.id);
    const next = Content.LESSONS[idx + 1];
    if (next) { startLesson(next); return; }
  }
  toTitle();
}
export function resultsRetry(): void {
  const c = app.content;
  if (app.mode === "learn" && c) {
    const lesson = Content.LESSONS.find((l) => l.id === c.id);
    if (lesson) { startLesson(lesson); return; }
  }
  // Same seed → same board: a true retry.
  if (app.lastContent) startRound(JSON.parse(JSON.stringify(app.lastContent)) as ContentT, app.mode);
}

// ------------------------------------------------------------------ the replay (main.js resultsReplay)
let replaySession: Session | null = null;
let replayQueue: Snapshot["log"] = [];
export function resultsReplay(): void {
  const s = app.session;
  if (!s) return;
  const snap = s.snapshot();
  openScreen(null);
  app.replay = true;
  toast(T("Replay — press Esc to exit"));
  replaySession = new Sessions.Session(snap.content, { onEvents: (e, st) => render.applyEvents(e, st) });
  render.setBoard(snap.content, resolvedPalette(snap.content));
  render.syncState(replaySession.state);
  replaySession.start();
  replayQueue = snap.log.filter((c) => c.type !== "start" && c.type !== "tick");
  cancel("replay");
  after(0, replayStep, "replay");
}
function replayStep(): void {
  if (!app.replay || !replaySession) return;
  const cmd = replayQueue.shift();
  if (!cmd) {
    toast(T("Replay finished"));
    after(900, () => { if (app.replay) exitReplay(); }, "replay");
    return;
  }
  replaySession.dispatch({ ...cmd });
  after(preferences().reducedMotion ? 20 : 90, replayStep, "replay");
}
/** The replay's progress (the HUD shows it while watching). */
export function replayState(): Session["state"] | null { return app.replay ? replaySession?.state ?? null : null; }
export function exitReplay(): void {
  if (!app.replay) return;
  app.replay = false;
  cancel("replay");
  replaySession = null;
  app.appState = "results";
  openScreen("results");
  if (app.session && app.content) {
    render.setBoard(app.content, resolvedPalette());
    render.syncState(app.session.state);
    render.settle();
  }
}

// ------------------------------------------------------------------ pause / resume / leave
function openPause(): void {
  app.overlay = "pause";
  app.openedFrame = frame().frame;
  app.focusNext = "btn-resume";
}
export function pauseToggle(): void {
  if (app.replay) { exitReplay(); return; }
  const s = app.session;
  if (!s) return;
  if (s.status === "active") {
    s.pause();
    app.appState = "paused";
    const st = s.state, c = app.content!;
    app.pauseSummary = () => T("{title} — {done}/{total} cells, {time} elapsed", { title: contentTitle(c.meta.title), done: st.stats.correct, total: st.w * st.h, time: fmtTime(st.elapsedMs) });
    endStroke();
    openPause();
    autosaveNow();
  } else if (s.status === "paused") resumeRound();
}
export function resumeRound(): void {
  const s = app.session;
  if (!s) return;
  if (s.status === "paused") s.resume();
  app.appState = s.status === "active" ? "active" : app.appState;
  app.overlay = null;
  app.openedFrame = frame().frame;
  ui.setFocus(null);
}
export function askConfirm(c: Confirm): void {
  app.confirm = c;
  app.overlay = "confirm";
  app.openedFrame = frame().frame;
  app.focusNext = "btn-confirm-no";
}
export function closeConfirm(yes: boolean): void {
  const c = app.confirm;
  app.confirm = null;
  app.overlay = null;
  app.openedFrame = frame().frame;
  if (c) (yes ? c.yes : c.no ?? (() => undefined))();
}
export function leaveRound(): void {
  const s = app.session;
  if (!s) { toTitle(); return; }
  if (!Rules.isTerminal(s.state)) {
    askConfirm({
      title: T("Leave round"), text: T("Leave this round? Progress on this canvas will be lost."),
      yes: () => { app.session?.abandon(); toTitle(); }, no: () => openPause(),
    });
    return;
  }
  toTitle();
}
export function restartRound(): void {
  askConfirm({ title: T("Restart round"), text: T("Restart this canvas from scratch?"), yes: () => resultsRetry(), no: () => openPause() });
}
export function skipAnimations(): void { render.settle(); toast(T("Animations skipped — state is exact.")); }
function teardownSession(clearSnapshot = true): void {
  cancel("countdown");
  cancel("results");
  cancel("hint");
  cancel("replay");
  app.countdown = null;
  app.session = null;
  app.lesson = null;
  app.overlay = null;
  app.replay = false;
  replaySession = null;
  stroke = null;
  touches.clear();
  render.setHover(-1);
  render.setKeyboardCursor(-1);
  render.setGhost(null);
  if (clearSnapshot) platform.clearSnapshot();
}
/** main.js resumeSnapshot: the last safe snapshot replayed, paused, the pause card open. */
function resumeSnapshot(snap: Snapshot): void {
  try {
    teardownSession(false);
    app.content = snap.content;
    app.mode = (snap.content.meta?.mode as Mode) || "practice";
    app.lastContent = snap.content;
    const s = Sessions.Session.restore(snap, { now: Date.now(), onEvents: (e) => onSessionEvents(e), onState: () => { autosaveDirty = true; } });
    app.session = s;
    const away = s.lastAwayDuration ?? 0;
    if (s.status === "active") s.pause();
    app.appState = "paused";
    app.tool = "brush";
    render.setTheme(theme());
    render.setBoard(snap.content, resolvedPalette());
    render.syncState(s.state);
    openScreen(null);
    const awayText = (): string => (away > 45000 ? " " + T("You were away {time} — the table waited, clock paused.", { time: fmtTime(away) }) : "");
    app.pauseSummary = () => T("Restored from your last safe snapshot.") + awayText();
    openPause();
    toast(T("Round restored.") + awayText());
  } catch (err) {
    console.warn(`restore failed: ${String(err)}`);
    platform.clearSnapshot();
    toast(T("Could not restore the saved round — starting fresh."));
  }
}
let autosaveDirty = false, autosaveT = 0;
function autosaveNow(): void {
  const s = app.session;
  if (s && !Rules.isTerminal(s.state) && s.log.length > 0 && !app.replay) platform.saveSnapshot(s.snapshot());
  autosaveDirty = false;
}

// ------------------------------------------------------------------ painting and tools
let stroke: { id: string; last: number; moved: boolean } | null = null;
let strokeSeq = 0;
export function commitFill(cell: number, tool: "brush" | "region", continuation = false): void {
  const s = app.session;
  if (!s || s.status !== "active") return;
  const r = s.fill(cell, s.state.selected, tool, tool === "brush" ? stroke?.id ?? null : null, continuation);
  if (r.ok && stroke) stroke.last = cell;
}
function endStroke(): void { stroke = null; }
function cellsBetween(a: number, b: number): number[] {
  if (a < 0) return [b];
  const w = app.session!.state.w;
  const ax = a % w, ay = Math.floor(a / w), bx = b % w, by = Math.floor(b / w);
  const out: number[] = [];
  const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
  for (let i = 1; i <= steps; i++) out.push(Math.round(ay + (by - ay) * (i / steps)) * w + Math.round(ax + (bx - ax) * (i / steps)));
  return out;
}
export function selectColor(c: number): void { app.session?.select(c); }
export function cycleColor(dir: number): void {
  const s = app.session?.state;
  if (!s) return;
  const n = s.palette.length;
  let c = s.selected;
  for (let i = 0; i < n; i++) {
    c = (c + dir + n) % n;
    if (!s.ruleset.sequence || c === s.seqColor) break;
  }
  app.session!.select(c);
}
export function setTool(tool: "brush" | "region"): void {
  if (tool === "region" && app.session && !app.session.state.ruleset.tools.region) {
    toast(T("The region tool is disabled in this ruleset."));
    return;
  }
  app.tool = tool;
  render.setGhost(null);
  audio.play("ui.tap");
}
export function doUndo(): void { app.session?.undo(); }
export function doHint(): void { app.session?.hint(); }
export function zoom(f: number): void { render.zoomBy(f); }
export function camReset(): void { render.resetCamera(); }
export function togglePan(): void {
  app.panMode = !app.panMode;
  toast(app.panMode ? T("Pan mode — drag moves the camera") : T("Paint mode"));
}
function moveCursor(dx: number, dy: number): void {
  const s = app.session!.state;
  if (app.keyboardCell < 0) {
    const la = Rules.legalActions(s);
    app.keyboardCell = la.colors.find((c) => c.color === s.selected)?.sample ?? la.colors[0]?.sample ?? 0;
  } else {
    const x = (app.keyboardCell % s.w) + dx, y = Math.floor(app.keyboardCell / s.w) + dy;
    if (x >= 0 && y >= 0 && x < s.w && y < s.h) app.keyboardCell = y * s.w + x;
  }
  render.setKeyboardCursor(app.keyboardCell);
  const target = s.targets[app.keyboardCell]!;
  const args = { x: (app.keyboardCell % s.w) + 1, y: Math.floor(app.keyboardCell / s.w) + 1, color: target === 0 ? T("background") : target };
  announce(s.filled[app.keyboardCell] ? T("Cell {x}, {y} — wants color {color}, filled", args) : T("Cell {x}, {y} — wants color {color}", args));
}

// ------------------------------------------------------------------ keys and pads (main.js onKeyDown, pollGamepad)
const CURSOR: Record<string, [number, number]> = { cursor_up: [0, -1], cursor_down: [0, 1], cursor_left: [-1, 0], cursor_right: [1, 0] };
const PAN: Record<string, [number, number]> = { pan_up: [0, 1], pan_down: [0, -1], pan_left: [1, 0], pan_right: [-1, 0] };
const held = new Set<string>();
onAction((e) => {
  const a = e.action;
  if (!e.pressed) { held.delete(a); return; }
  if (PAN[a] || a === "zoom_in" || a === "zoom_out") held.add(a);
  if (ui.capturingKeys()) return;
  if (app.replay) { if ((a === "cancel" || a === "pause") && fresh()) later(exitReplay); return; }
  if (app.overlay) {
    if ((a !== "cancel" && a !== "pause") || !fresh()) return;
    if (app.overlay === "pause") later(resumeRound);
    else later(() => closeConfirm(false));
    return;
  }
  if (app.screen) {
    if (a !== "cancel" || !fresh()) return;
    if (app.screen === "settings" || app.screen === "learn" || app.screen === "journey" || app.screen === "setup" || app.screen === "profile"
      || app.screen === "board" || app.screen === "help") later(navBack);
    return;
  }
  const inRound = app.appState === "active" || app.appState === "paused";
  if ((a === "pause" || a === "cancel") && inRound) {
    if (!fresh()) return;
    if (app.drawer && a === "cancel") { app.drawer = null; return; }
    later(pauseToggle);
    return;
  }
  const s = app.session;
  if (app.appState !== "active" || !s) return;
  const m = /^color_(\d)$/.exec(a);
  if (m) {
    const n = Number(m[1]);
    if (n < s.state.palette.length) s.select(n);
    return;
  }
  const dir = CURSOR[a];
  if (dir) { ui.setFocus(null); moveCursor(dir[0], dir[1]); return; }
  switch (a) {
    case "fill":
      if (ui.focused() !== null) return; // Enter on a focused button is the button's
      if (app.keyboardCell >= 0) later(() => commitFill(app.keyboardCell, app.tool === "region" ? "region" : "brush"));
      break;
    case "undo": later(doUndo); break;
    case "hint": later(doHint); break;
    case "next_color": cycleColor(1); break;
    case "prev_color": cycleColor(-1); break;
    case "region_tool": setTool("region"); break;
    case "brush_tool": setTool("brush"); break;
    case "cam_reset": camReset(); break;
    case "zoom_in": zoom(0.8); break;
    case "zoom_out": zoom(1.25); break;
    default: break;
  }
});

// ------------------------------------------------------------------ pointer and touch on the table
/** Rectangles (window pixels) where a press belongs to the UI, set by screens.ts each frame. */
export const hudRects: { x: number; y: number; width: number; height: number }[] = [];
const onHud = (x: number, y: number): boolean => hudRects.some((r) => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
type PEv = { kind: "down" | "move" | "up"; x: number; y: number; button: number; touch: number | null };
const events: PEv[] = [];
let lastTouch = -1e9;
const touches = new Map<number, { x: number; y: number }>();
let pinch: { dist: number; mid: { x: number; y: number } } | null = null;
let press: { x: number; y: number; startX: number; startY: number; t: number; button: number; pan: boolean; id: number | null } | null = null;
/** holdToDrag off: a press starts a stroke that pointer movement keeps painting until the next press. */
let toggled = false;
let wheelAcc = 0;
onTouch((e) => {
  lastTouch = clockMs;
  if (e.control) return;
  events.push({ kind: e.phase === "start" ? "down" : e.phase === "move" ? "move" : "up", x: e.x, y: e.y, button: 0, touch: e.id });
});
onPointerButton((e) => {
  if (clockMs - lastTouch < 600) return;
  events.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y, button: e.button, touch: null });
});
onPointerMove((x, y) => { if (clockMs - lastTouch >= 600) events.push({ kind: "move", x, y, button: -1, touch: null }); });
onWheel((_dx, dy) => { wheelAcc += dy; });

function updateHover(x: number, y: number): void {
  const s = app.session;
  const cell = render.screenToCell(x, y);
  if (cell === app.hoverCell) return;
  app.hoverCell = cell;
  render.setHover(cell);
  if (cell >= 0 && app.tool === "region" && s) {
    render.setGhost(s.state.targets[cell] === s.state.selected ? Rules.regionAt(s.state, cell) : []);
  } else render.setGhost(null);
}
function strokeTo(cell: number): void {
  if (!stroke || cell < 0 || cell === stroke.last) return;
  for (const c of cellsBetween(stroke.last, cell)) commitFill(c, "brush", true);
}
/** Pointer and finger input after the UI is built (a press over the HUD is the HUD's). */
function pointerInput(wasPlaying: boolean): void {
  const list = events.splice(0);
  const wheel = wheelAcc;
  wheelAcc = 0;
  // compact layouts: a press beside the open drawer closes it (the drawer is UI state only)
  if (app.drawer && wasPlaying) {
    if (list.some((e) => e.kind === "down" && !onHud(e.x, e.y))) app.drawer = null;
    return;
  }
  const live = wasPlaying && playing() && app.appState === "active" && !app.replay;
  if (!live) {
    if (!playing()) { press = null; touches.clear(); pinch = null; endStroke(); toggled = false; }
    return;
  }
  if (wheel) { zoom(wheel > 0 ? 1.12 : 0.89); noteCameraMove(); }
  for (const ev of list) {
    if (ev.touch !== null) {
      if (ev.kind === "down") {
        if (onHud(ev.x, ev.y)) continue;
        touches.set(ev.touch, { x: ev.x, y: ev.y });
        if (touches.size === 2) { endStroke(); press = null; pinch = null; continue; }
        if (touches.size > 2) continue;
      } else if (!touches.has(ev.touch)) continue;
      if (touches.size >= 2) {
        if (ev.kind === "move") {
          touches.set(ev.touch, { x: ev.x, y: ev.y });
          const [a, b] = [...touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
          const dist = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          if (pinch) {
            render.zoomBy(pinch.dist / Math.max(1, dist));
            render.panBy(mid.x - pinch.mid.x, mid.y - pinch.mid.y);
            noteCameraMove();
          }
          pinch = { dist, mid };
        } else if (ev.kind === "up") { touches.delete(ev.touch); pinch = null; }
        continue;
      }
      if (ev.kind === "up") touches.delete(ev.touch);
    }
    if (ev.kind === "down") {
      if (onHud(ev.x, ev.y)) continue;
      ui.setFocus(null);
      const pan = app.panMode || ev.button === 1 || ev.button === 2;
      press = { x: ev.x, y: ev.y, startX: ev.x, startY: ev.y, t: clockMs, button: ev.button, pan, id: ev.touch };
      if (pan) continue;
      if (!platform.options.holdToDrag && toggled) { toggled = false; endStroke(); press = null; continue; }
      const cell = render.screenToCell(ev.x, ev.y);
      if (cell >= 0) {
        if (app.tool === "region") commitFill(cell, "region");
        else {
          stroke = { id: `stroke-${(++strokeSeq).toString(36)}`, last: -1, moved: false };
          commitFill(cell, "brush", false);
          if (!platform.options.holdToDrag) toggled = true;
        }
      }
    } else if (ev.kind === "move") {
      if (!press) {
        if (toggled && stroke && app.tool === "brush") strokeTo(render.screenToCell(ev.x, ev.y));
        else if (ev.touch === null) updateHover(ev.x, ev.y);
        continue;
      }
      if (ev.touch !== press.id) continue;
      const dx = ev.x - press.x, dy = ev.y - press.y;
      press.x = ev.x; press.y = ev.y;
      if (Math.hypot(ev.x - press.startX, ev.y - press.startY) > 10 && stroke) stroke.moved = true;
      if (press.pan) { render.panBy(dx, dy); noteCameraMove(); continue; }
      if (stroke && app.tool === "brush") strokeTo(render.screenToCell(ev.x, ev.y));
      else if (ev.touch === null && !stroke) updateHover(ev.x, ev.y);
    } else if (ev.kind === "up") {
      if (!press || ev.touch !== press.id) continue;
      const p = press;
      press = null;
      if (p.pan) continue;
      if (stroke && !stroke.moved && stroke.last === -1 && Math.hypot(ev.x - p.startX, ev.y - p.startY) < 10 && clockMs - p.t < 600) {
        // a pure tap that missed a cell at down: try again at up
        const cell = render.screenToCell(ev.x, ev.y);
        if (cell >= 0) commitFill(cell, app.tool === "region" ? "region" : "brush");
      }
      if (!toggled) endStroke();
    }
  }
}

// ------------------------------------------------------------------ settings, profile, boards
export function setPaletteOption(p: "default" | "contrast" | "cvd"): void {
  platform.setOption("palette", p);
}
function applyOptions(): void {
  render.setCellLabels(platform.options.cellLabels);
  audio.setHaptics(platform.options.haptics);
  if (app.content) {
    render.setBoard(app.content, resolvedPalette());
    if (app.session) render.syncState(app.session.state);
    render.settle();
  }
}
let paletteKey = "";
export function setTheme(id: string): void {
  platform.update((d) => { d.cosmetics.theme = id; });
  render.setTheme(theme());
  audio.setAmbience(theme().ambience);
}
export function rename(name: string): void {
  const n = name.trim().slice(0, 24);
  if (n && n !== platform.data().profile.name) platform.update((d) => { d.profile.name = n; d.profile.guest = false; });
}
export function addRival(name: string): void {
  const n = name.trim().slice(0, 24);
  if (!n) return;
  platform.update((d) => { if (!d.rivals.some((r) => r.name === n)) d.rivals.push({ name: n, best: 0 }); });
}
export function removeRival(name: string): void { platform.update((d) => { d.rivals = d.rivals.filter((r) => r.name !== name); }); }
export function replayTutorials(): void {
  platform.update((d) => { d.tutorials.done = []; });
  toast(T("Tutorials reset — find them under Learn."));
}
export function wipe(): void {
  askConfirm({
    title: T("Erase local data"), text: T("Erase all local progress, settings and boards? This cannot be undone."),
    yes: () => { platform.wipe(); render.setTheme(theme()); toTitle(); },
  });
}
export function cloudSync(): void { void platform.flush().then(() => toast(T("Cloud save synced."))); }

/** main.js showBoard: the platform board when signed in (read-only), else the local casual board. */
export function showBoard(which: "weekly" | "round", scope: "global" | "friends" = "global"): void {
  const week = platform.isoWeek();
  if (which === "round" && app.lastBoardId) {
    const title = app.content?.meta.title;
    app.board.id = app.lastBoardId;
    app.board.label = () => (title ? contentTitle(title) : T("This canvas"));
  } else if (which === "weekly") {
    app.board.id = Sessions.boardIdFor({ mode: "score-chase", id: `chase-${week}` });
    app.board.label = () => T("Score Chase — week {week}", { week });
  }
  setBoardScope(scope);
  openScreen("board");
}
export function setBoardScope(scope: "global" | "friends"): void {
  const b = app.board;
  b.scope = scope;
  const key = ++b.key;
  const local = (platform.loadBoards()[b.id] ?? []).map((e) => ({ ...e }));
  const d = platform.data();
  const friends = new Set([d.profile.name, ...d.rivals.map((r) => r.name)]);
  const show = (entries: BoardEntry[], note: string, pre = false): void => {
    if (key !== b.key) return;
    const list = scope === "friends" && !pre ? entries.filter((e) => friends.has(e.name)) : entries;
    b.entries = list.sort(Sessions.compareBoardEntries);
    b.note = note;
  };
  b.entries = null;
  if (platform.signedIn()) {
    platform.hostedBoard(scope === "friends").then((entries) => {
      if (entries) show(entries, N("Global board (read-only)."), true);
      else show(local, N("No platform board for this game — local records only."));
    }, () => show(local, N("Offline — showing local (casual) board.")));
  } else show(local, N("Local board — casual, unvalidated."));
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function copyInvite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(S("inviteCopied")); } catch { toast(S("inviteFailed", { link }), 6000); }
}

// ------------------------------------------------------------------ the clock
let hidden = false;
let tickAcc = 0;
const STEP_MS = 1000 / 60;
onFixedUpdate(() => {
  if (hidden) return;
  clockMs += STEP_MS;
  const s = app.session;
  if (s && s.status === "active" && !app.replay) {
    tickAcc += STEP_MS;
    if (tickAcc >= 200) {
      const q = Math.floor(tickAcc / 100) * 100;
      tickAcc -= q;
      s.advanceTime(q);
    }
    if (app.session) audio.setIntensity(Rules.progress(app.session.state));
  }
  // camera stick and zoom triggers (main.js pollGamepad axes) and the pan keys
  if (playing() && app.appState === "active") {
    let px = 0, py = 0;
    for (const a of held) { const p = PAN[a]; if (p) { px += p[0]; py += p[1]; } }
    if (px || py) { render.panBy(px * STEP_MS * 0.5, py * STEP_MS * 0.5); noteCameraMove(); }
    const z = (held.has("zoom_out") ? 1 : 0) - (held.has("zoom_in") ? 1 : 0);
    if (z) render.zoomBy(1 + z * STEP_MS * 0.0012);
  }
  if (autosaveDirty) {
    autosaveT += STEP_MS;
    if (autosaveT > 4000) { autosaveT = 0; autosaveNow(); }
  }
  for (let i = 0; i < timers.length;) {
    const t = timers[i]!;
    if (t.at <= clockMs) { timers.splice(i, 1); t.fn(); } else i++;
  }
  if (app.toast && app.toast.until < clockMs) app.toast = null;
  if (app.caption && app.caption.until < clockMs) app.caption = null;
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  platform.update((d) => { d.stats.sessions += 1; });
  audio.loadSfx();
  audio.setCaptionHandler(caption);
  audio.startMusic(platform.data().cosmetics.theme);
  render.setReducedMotion(preferences().reducedMotion);
  render.setCameraListener(noteCameraMove);
  applyLook();
  render.setTheme(theme());
  render.setCellLabels(platform.options.cellLabels);
  audio.setHaptics(platform.options.haptics);
  paletteKey = platform.options.palette;
  toTitle();
  // Returning player: resume offers the last safe snapshot within two actions.
  const snap = platform.loadSnapshot();
  if (snap && snap.log?.length && snap.content) {
    const away = Date.now() - (snap.savedAt || Date.now());
    const title = snap.content.meta?.title ? contentTitle(snap.content.meta.title) : snap.content.id;
    askConfirm({
      title: T("Welcome back"),
      text: away > 60000
        ? T("You have an unfinished round ({title}) — paused {time} ago. Resume it?", { title, time: fmtTime(away) })
        : T("You have an unfinished round ({title}). Resume it?", { title }),
      yes: () => resumeSnapshot(snap),
      no: () => platform.clearSnapshot(),
    });
  }
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onOptionsChange(() => {
  if (platform.options.palette !== paletteKey) { paletteKey = platform.options.palette; applyOptions(); }
  render.setCellLabels(platform.options.cellLabels);
  audio.setHaptics(platform.options.haptics);
});
platform.onProgressMerged(() => {
  render.setTheme(theme());
  if (app.screen === "title") announce(T("Progress restored from your StarHermit cloud save."));
});
onSessionEnded(() => toast(S("signedOut"), 5000));
onSuspend(() => {
  hidden = true;
  // Backgrounding pauses the solo simulation.
  if (app.session?.status === "active" && !app.replay) pauseToggle();
  render.setHidden(true);
  audio.setSuspended(true);
  autosaveNow();
  void platform.flush();
});
onResume(() => { hidden = false; render.setHidden(false); audio.setSuspended(false); });

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(ui.preferences().highContrast);
  audio.update();
});
onRender(() => {
  hudRects.length = 0;
  const wasPlaying = playing();
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput(wasPlaying);
  const f = frame();
  render.update(frameDt, f.width, f.height);
});
