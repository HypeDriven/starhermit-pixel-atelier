// The game's data and the StarHermit platform, on the runtime's modules (what
// js/platform.js and js/storage.js did over the JS SDK and localStorage):
// - the save (starhermit:storage `saves`, schema 1: on the device and in the
//   player's cloud slot) is the progress document { v, data } (js/progress.js);
//   two devices' saves merge on a conflict (the browser build's mergeSaveData,
//   which it also ran on its saveconflict); the slot the browser build wrote
//   through the JS SDK (game:<slug>: its checksummed { v, rev, updatedAt, data }
//   with the settings) shows as foreign: its progress is merged in and it is
//   replaced once (its game options carried over);
// - the round snapshot (resume after leaving mid-round) and the local casual
//   boards stay on this device only (starhermit:storage `storage`), as they
//   stayed in localStorage;
// - the game's own options (cell palette, cell numbers, captions, haptics,
//   left-handed layout, hold-to-paint, timing assistance) are engine
//   `settings` (synced with the account); the browser build's a11y values in
//   the account's settings KV are adopted (unless set here since), then all
//   its KV keys are removed (volumes, mute, graphics, reduced motion,
//   contrast, larger text and the language are the runtime's Options);
// - the player, the invite link, the platform's clock for the Daily and the
//   Score Chase week, posting a finished Score Chase round's total through
//   score-script.js (a practice session whose socket carries
//   { type: 'result', scores }, as the JS SDK's submitScores did) with the
//   rank, and the platform board's entries for Leaderboard (read-only).
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, profile as fetchProfile, serverNow, serverTime, sessions,
  type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import { Progress, type BoardEntry, type Options, type SaveData, type SaveDoc, type Snapshot } from "./game.ts";

// --- the save --------------------------------------------------------------------------------
let doc: SaveDoc = Progress.defaultSave();
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

function write(opts: { replaceForeign?: boolean } = {}): void {
  try {
    saves.save(doc as unknown as JsonValue, { schema: 1, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
/** The live progress document (change it, then persist()). */
export function data(): SaveData { return doc.data; }
/** Saves (the device at once, the account debounced by the runtime). */
export function persist(): void { write(); }
/** Changes the progress and saves (storage.js update). */
export function update(fn: (d: SaveData) => void): void { fn(doc.data); write(); }
function adopt(other: unknown): boolean {
  const next = Progress.mergeSave(other, doc);
  if (Progress.sameSave(next, doc)) return false;
  doc = next;
  write();
  return true;
}
saves.onConflict((mine, remote) => ({ merged: Progress.mergeSave(remote.data, mine?.data ?? null) as unknown as JsonValue }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud progress: merged with this device's save, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const found = old.text != null ? Progress.readForeign(old.text) : null;
  let grew = false;
  if (found) {
    for (const [k, v] of Object.entries(found.options)) adoptOption(k as keyof Options, v);
    const next = Progress.mergeSave(found.save, doc);
    grew = !Progress.sameSave(next, doc);
    doc = next;
  }
  write({ replaceForeign: true });
  if (grew) merged();
}

/** The profile's sync line: local (a guest) | saving | synced | error. */
export function syncState(): "local" | "saving" | "synced" | "error" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): Promise<unknown> { return saves.flush().catch(() => undefined); }
/** Erase local data: the progress back to its defaults, the round snapshot and boards gone, the options reset. */
export function wipe(): void {
  doc = Progress.defaultSave();
  write();
  clearSnapshot();
  try { storage.remove(KEY_BOARDS); } catch { /* none */ }
  for (const k of Progress.OPTION_KEYS) setOption(k, Progress.DEFAULT_OPTIONS[k]);
}

// --- device-only: the round snapshot and the local boards (localStorage in the browser build) ----
const KEY_SESSION = "pixelatelier.session.v1";
const KEY_BOARDS = "pixelatelier.boards.v1";
export function saveSnapshot(s: Snapshot): void {
  try { storage.setJson(KEY_SESSION, s as unknown as JsonValue); } catch (e) { console.warn(`snapshot: ${String(e)}`); }
}
export function loadSnapshot(): Snapshot | null {
  try { return storage.getJson(KEY_SESSION) as unknown as Snapshot | null; } catch { return null; }
}
export function clearSnapshot(): void { try { storage.remove(KEY_SESSION); } catch { /* none */ } }
export function loadBoards(): Record<string, BoardEntry[]> {
  try { return (storage.getJson(KEY_BOARDS) as unknown as Record<string, BoardEntry[]> | null) ?? {}; } catch { return {}; }
}
export function saveBoards(b: Record<string, BoardEntry[]>): void {
  try { storage.setJson(KEY_BOARDS, b as unknown as JsonValue); } catch (e) { console.warn(`boards: ${String(e)}`); }
}

// --- the game's options -----------------------------------------------------------------------
export const options: Options = { ...Progress.DEFAULT_OPTIONS };
const KEYS = Progress.OPTION_KEYS;
const optionListeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { optionListeners.add(fn); }
function optionsChanged(): void { for (const fn of optionListeners) fn(); }
function readOption(key: keyof Options): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = Progress.pickOptions({ [key]: v })[key];
  if (ok !== undefined) (options as unknown as Record<string, unknown>)[key] = ok;
}
/** A migrated value, kept unless this game set the key since. */
function adoptOption(key: keyof Options, value: unknown): void {
  const v = Progress.pickOptions({ [key]: value })[key];
  if (v === undefined) return;
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, v as JsonValue);
    (options as unknown as Record<string, unknown>)[key] = v;
    optionsChanged();
  } catch { /* keep the device's */ }
}
/** Changes one of the game's options (device and account). */
export function setOption<K extends keyof Options>(key: K, value: Options[K]): void {
  if (options[key] === value) return;
  options[key] = value;
  try { store.set(key, value as JsonValue); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
  optionsChanged();
}
// The browser build patched its prefs into the account's settings KV ({ audio, graphics, a11y, camera }, plus the
// language helper's ui.language): the a11y options carry over (unless set here since), then all are removed.
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  if (keys.includes("a11y")) {
    const a = store.legacy("a11y");
    for (const [k, v] of Object.entries(Progress.pickOptions(a))) adoptOption(k as keyof Options, v);
  }
  for (const key of keys) if (Progress.BROWSER_KEYS.includes(key) || key.startsWith("ui.")) store.removeLegacy(key);
}

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  doc = Progress.normalize(cur?.data ?? null);
  for (const k of KEYS) readOption(k);
  store.onChange((key) => {
    if (!(KEYS as string[]).includes(key)) return;
    readOption(key as keyof Options);
    optionsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  optionsChanged();
  refreshPlayer();
  void serverTime().then(() => { clockSynced = true; }, () => undefined);
}

// --- the player and the clock -----------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  for (const fn of playerListeners) fn();
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
onPlayerChange(() => refreshPlayer());

let clockSynced = false;
/** Whether the platform's clock answered (else the device's clock decides the Daily and the week). */
export function synced(): boolean { return clockSynced; }
/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}
/** platform.js utcDateString. */
export function utcDate(ms = nowMs()): string { return new Date(ms).toISOString().slice(0, 10); }
/** platform.js isoWeekString. */
export function isoWeek(ms = nowMs()): string {
  const d = new Date(ms);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
/** platform.js msUntilNextUtcDay. */
export function msUntilNextUtcDay(): number {
  const now = nowMs(), d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

// --- the platform board -----------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function firstBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
const names = new Map<string, string>();
async function nameOf(userId: string, given: string): Promise<string> {
  if (given) return given;
  const hit = names.get(userId);
  if (hit) return hit;
  let n = `Player ${userId.slice(0, 6)}`;
  try { n = (await fetchProfile(userId)).displayName || n; } catch { /* keep */ }
  names.set(userId, n);
  return n;
}
/** The Leaderboard screen's StarHermit board (read-only), nicknames resolved; null when there is none. */
export async function hostedBoard(friends: boolean): Promise<BoardEntry[] | null> {
  if (!player()) return null;
  const b = await firstBoard();
  if (!b) return null;
  const r = await leaderboards.entries(b.id, { pageSize: 50, friendsOnly: friends });
  return Promise.all(r.items.map(async (e) => ({
    name: await nameOf(e.userId, e.displayName), score: Number.isFinite(e.score) ? e.score : 0,
    progressPct: 0, errors: 0, elapsedMs: 0, sessionId: e.userId,
  })));
}
export interface Posted { posted: boolean; rank: number | null }
/** Signed in only: post a finished Score Chase total through score-script.js; { posted, rank }. Never rejects. */
export async function postScore(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (d) => {
        const m = d as { type?: string; accepted?: string[] } | null;
        if (m && m.type === "result-ack") finish(Array.isArray(m.accepted) ? m.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await firstBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
