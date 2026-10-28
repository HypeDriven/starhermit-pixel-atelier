// The browser build's pure game modules (shared with the node tests), typed
// for this client: the rules (js/rules.js: validated commands, legality,
// hints, scoring, hashing), the content (js/content.js: the authored arts,
// the glimmerkin generator, the 42 Journey stages, lessons, Daily, Practice,
// Challenge and Score Chase builders, themes), the session (js/session.js:
// command log, snapshots, replay envelopes, boards' tie-break), the seeded
// streams (js/rng.js) and the save model (js/progress.js).
import * as rulesMod from "../js/rules.js";
import * as contentMod from "../js/content.js";
import * as sessionMod from "../js/session.js";
import * as rngMod from "../js/rng.js";
import * as progressMod from "../js/progress.js";

export interface Ruleset {
  errorPrevention: boolean; tools: { brush: boolean; drag: boolean; region: boolean }; allowUndo: boolean;
  moveLimit: number | null; timeLimitMs: number | null; errorLimit: number | null; sequence: boolean;
}
export interface ContentMeta {
  title: string; theme: string; difficulty: number; ranked: boolean; mode: string; tutorial: string | null; stageId: string | null;
  seedInspectable: boolean; chapter?: number; mastery?: boolean; assists?: string[];
}
export interface Content {
  id: string; version: number; seed: string; width: number; height: number; palette: string[]; targets: number[];
  ruleset: Ruleset; par: { timeMs: number; actions: number }; meta: ContentMeta;
}
export interface Stats {
  correct: number; errors: number; actions: number; combo: number; bestCombo: number; comboPoints: number;
  regionFills: number; hints: number; undos: number; strokes: number;
}
export interface Final {
  base: number; comboBonus: number; regionBonus: number; completionBonus: number; timeBonus: number; errorPenalty: number;
  hintPenalty: number; total: number; correct: number; errors: number; actions: number; bestCombo: number; elapsedMs: number; progressPct: number;
}
export interface State {
  w: number; h: number; palette: string[]; targets: number[]; filled: number[]; wrong: number[]; selected: number; tick: number;
  elapsedMs: number; status: "ready" | "active" | "paused" | "complete" | "failed" | "abandoned"; terminalReason: string | null;
  seqColor: number; stats: Stats; ruleset: Ruleset; par: { timeMs: number; actions: number }; final: Final | null; undoStack: unknown[];
}
export interface Hint { type: "fill" | "select"; tool?: "region" | "brush"; cell?: number; color: number }
export interface GameEvent {
  type: string; cells?: number[]; color?: number; tool?: string; combo?: number; target?: number; status?: string; reason?: string;
  final?: Final; hint?: Hint | null; message?: string; required?: number; cmd?: { strokeContinuation?: boolean };
}
export interface Result { ok: boolean; reason?: string; message?: string; events: GameEvent[] }
export interface LogEntry { id: string; type: string; cell?: number; color?: number; tool?: string; stroke?: unknown; dtMs?: number }
export interface Snapshot { sessionId: string; createdAt: number; awayMs: number; savedAt: number; content: Content; log: LogEntry[]; cmdSeq: number }
export interface Session {
  readonly state: State; readonly status: State["status"]; readonly content: Content; readonly log: LogEntry[]; sessionId: string;
  lastAwayDuration?: number;
  dispatch(cmd: Record<string, unknown>): Result;
  start(): Result; pause(): Result; resume(): Result; select(color: number): Result;
  fill(cell: number, color: number, tool: string, stroke?: string | null, strokeContinuation?: boolean): Result;
  undo(): Result; hint(): Result; abandon(): Result; advanceTime(dtMs: number): Result;
  snapshot(): Snapshot;
}
interface SessionCtor {
  new (content: Content, opts?: { sessionId?: string; createdAt?: number; onEvents?: (e: GameEvent[], s: State) => void; onState?: (s: State) => void }): Session;
  restore(snapshot: Snapshot, opts?: { now?: number; onEvents?: (e: GameEvent[], s: State) => void; onState?: (s: State) => void }): Session;
}
export interface BoardEntry { name: string; score: number; progressPct: number; errors: number; elapsedMs: number; sessionId: string; contentId?: string; at?: number }
export interface Lesson { id: string; title: string; board: string; intro: string; steps: { id: string; text: string; require: { type: string; color?: number; n?: number; minCells?: number } }[] }
export interface Theme {
  id: string; name: string; unlock: { type: string; n?: number }; bg: string; fog: string; table: string; tableEdge: string; grid: string;
  cellEmpty: string; accentA: string; accentB: string; key: string; rim: string; ambience: string;
}
export interface Chapter { id: string; name: string; theme: string }
export interface Rng { float(): number; range(a: number, b: number): number; int(a: number, b: number): number; pick<T>(a: T[]): T; chance(p: number): boolean }

export interface Achievement { key: string; name: string; desc: string }
export interface SaveData {
  profile: { name: string; guest: boolean };
  journey: { stars: Record<string, number>; bestScores: Record<string, number> };
  achievements: Record<string, number>;
  daily: { lastDate: string | null; streak: number; best: Record<string, number>; history: Record<string, { score: number }> };
  stats: { cellsFilled: number; sessions: number; playtimeMs: number; roundsCompleted: number };
  tutorials: { done: string[] };
  cosmetics: { unlocked: string[]; theme: string };
  rivals: { name: string; best: number }[];
}
export interface SaveDoc { v: number; data: SaveData }
export interface Options {
  palette: "default" | "contrast" | "cvd"; leftHanded: boolean; holdToDrag: boolean; timingAssist: boolean; haptics: boolean; captions: boolean; cellLabels: boolean;
}

interface RulesApi {
  TERMINAL: Record<string, string>;
  regionAt(state: State, cell: number): number[];
  legalActions(state: State): { active: boolean; colors: { color: number; remaining: number; sample: number }[]; canUndo: boolean; canHint: boolean };
  isTerminal(state: State): boolean;
  progress(state: State): number;
  scoreBreakdown(state: State): Final;
}
interface ContentApi {
  JOURNEY: Content[]; JOURNEY_CHAPTERS: Chapter[]; LESSONS: Lesson[]; THEMES: Theme[];
  CHALLENGE_TYPES: Record<string, { label: string; blurb: string }>;
  PRACTICE_PRESETS: Record<string, { label: string; size: number; colors: number; blurb: string }>;
  lessonContent(id: string): { lesson: Lesson; content: Content } | null;
  dailyContent(date: string): Content; practiceContent(preset: string, seed?: string): Content;
  challengeContent(type: string, level: number, seed?: string): Content; scoreChaseContent(week: string): Content;
  remapPalette(palette: string[], mode: string): string[]; getTheme(id: string): Theme; difficultyOf(c: Content): number;
}
interface ProgressApi {
  ACHIEVEMENTS: Achievement[]; DEFAULT_OPTIONS: Options; OPTION_KEYS: (keyof Options)[]; BROWSER_KEYS: string[]; PALETTES: string[];
  defaultSave(): SaveDoc; normalize(raw: unknown): SaveDoc; mergeSave(remote: unknown, local: unknown): SaveDoc; sameSave(a: unknown, b: unknown): boolean;
  readForeign(text: string): { save: SaveDoc; options: Partial<Options> } | null; pickOptions(raw: unknown): Partial<Options>;
  starsFor(state: State): number;
  recordRound(d: SaveData, round: { state: State; mode: string; contentId: string; mastery: boolean; lessonId: string | null; final: Final; now?: number }): { achievements: Achievement[]; themes: string[] };
  recordScore(boards: unknown, boardId: string, entry: BoardEntry): { boards: Record<string, BoardEntry[]>; rank: number; total: number };
  noteRivalBest(d: SaveData, name: string, score: number): void;
}
interface SessionModApi {
  Session: SessionCtor; BUILD_VERSION: string;
  boardEntryFromSession(s: Session, name: string): BoardEntry;
  compareBoardEntries(a: BoardEntry, b: BoardEntry): number;
  boardIdFor(c: { mode: string; id: string }): string;
}
interface RngApi { RNG: new (seed: string) => Rng }

export const Rules = rulesMod as unknown as RulesApi;
export const Content = contentMod as unknown as ContentApi;
export const Progress = progressMod as unknown as ProgressApi;
export const Sessions = sessionMod as unknown as SessionModApi;
export const RNG = (rngMod as unknown as RngApi).RNG;
