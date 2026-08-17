// session.js — local authoritative session: validated commands with ids,
// ordered replay log with periodic state hashes, snapshots, autosave.
// Solo play runs locally; the same envelope is what server.js re-validates.

import * as rules from './rules.js';
import { hashString } from './rng.js';

export const REPLAY_SCHEMA = 1;
export const BUILD_VERSION = '1.0.0';
const HASH_EVERY = 10;

let sessionCounter = 0;

export class Session {
  constructor(content, opts = {}) {
    this.content = content;
    this.sessionId = opts.sessionId || `s${Date.now().toString(36)}-${(sessionCounter++).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.state = rules.createState(content);
    this.log = [];
    this.hashes = [{ at: 0, hash: rules.hashState(this.state) }];
    this.cmdSeq = 0;
    this.seenIds = new Set();
    this.onEvents = opts.onEvents || (() => {});
    this.onState = opts.onState || (() => {});
    this.createdAt = opts.createdAt || Date.now();
    this.pausedWallAt = null;
    this.awayMs = 0;
  }

  get tick() { return this.state.tick; }
  get status() { return this.state.status; }

  // All mutations flow through here. Duplicate command ids are rejected
  // idempotently (safe retry), never double-applied.
  dispatch(cmd) {
    if (!cmd || typeof cmd !== 'object') {
      return { ok: false, reason: 'bad-command', message: 'Malformed command.', events: [] };
    }
    if (!cmd.id) cmd.id = `${this.sessionId}:${++this.cmdSeq}`;
    else this.cmdSeq += 1;
    if (this.seenIds.has(cmd.id)) {
      return { ok: true, deduped: true, events: [] };
    }
    const result = rules.apply(this.state, cmd);
    if (!result.ok) {
      this.onEvents([{ type: 'invalid', reason: result.reason, message: result.message, required: result.required, cmd }], this.state);
      return result;
    }
    this.seenIds.add(cmd.id);
    this.log.push({
      id: cmd.id, type: cmd.type, cell: cmd.cell, color: cmd.color,
      tool: cmd.tool, stroke: cmd.stroke, dtMs: cmd.dtMs,
    });
    if (this.log.length % HASH_EVERY === 0) {
      this.hashes.push({ at: this.log.length, hash: rules.hashState(this.state) });
    }
    this.onEvents(result.events, this.state);
    this.onState(this.state);
    return result;
  }

  // Convenience wrappers used by UI/keyboard/gamepad.
  start() { return this.dispatch({ type: 'start' }); }
  pause() { return this.dispatch({ type: 'pause' }); }
  resume() { return this.dispatch({ type: 'resume' }); }
  select(color) { return this.dispatch({ type: 'select', color }); }
  fill(cell, color, tool, stroke, strokeContinuation) {
    return this.dispatch({ type: 'fill', cell, color, tool, stroke, strokeContinuation });
  }
  undo() { return this.dispatch({ type: 'undo' }); }
  hint() { return this.dispatch({ type: 'hint' }); }
  abandon() { return this.dispatch({ type: 'abandon' }); }
  advanceTime(dtMs) {
    if (this.state.status !== 'active') return { ok: false, events: [] };
    return this.dispatch({ type: 'tick', dtMs });
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      awayMs: this.awayMs,
      savedAt: Date.now(),
      content: this.content,
      log: this.log.map((c) => ({ ...c })),
      cmdSeq: this.cmdSeq,
    };
  }

  // Rebuild state by replaying the ordered log (durable session restore —
  // never trust a cached raw state blob).
  static restore(snapshot, opts = {}) {
    const session = new Session(snapshot.content, {
      sessionId: snapshot.sessionId,
      createdAt: snapshot.createdAt,
      onEvents: opts.onEvents,
      onState: opts.onState,
    });
    session.awayMs = snapshot.awayMs || 0;
    for (const entry of snapshot.log) {
      const r = session.dispatch({ ...entry });
      if (!r.ok) throw new Error(`session: restore failed at ${entry.id}: ${r.reason}`);
    }
    // Wall-clock time passed while away (solo simulation stayed paused).
    if (snapshot.savedAt && opts.now) {
      session.lastAwayDuration = Math.max(0, opts.now - snapshot.savedAt);
    }
    return session;
  }

  envelope(resultNote) {
    return {
      schema: REPLAY_SCHEMA,
      build: BUILD_VERSION,
      contentId: this.content.id,
      contentVersion: this.content.version,
      seed: this.content.seed,
      initialHash: this.hashes[0]?.hash,
      createdAt: this.createdAt,
      commands: this.log.map((c) => ({ ...c })),
      hashes: this.hashes.slice(1),
      result: resultNote || (this.state.final ? {
        status: this.state.status,
        reason: this.state.terminalReason,
        total: this.state.final.total,
      } : null),
      finalHash: rules.hashState(this.state),
    };
  }

  // Deterministic replay verification: same version+seed+commands must
  // reproduce identical hashes. Used by tests and by server-side validation.
  static verify(envelope, content) {
    if (!envelope || envelope.schema !== REPLAY_SCHEMA) {
      return { ok: false, error: 'unsupported-schema' };
    }
    if (envelope.contentId !== content.id || envelope.contentVersion !== content.version) {
      return { ok: false, error: 'content-mismatch' };
    }
    const session = new Session(content, { sessionId: 'verify', createdAt: envelope.createdAt });
    let hashIdx = 0;
    for (let i = 0; i < envelope.commands.length; i++) {
      const entry = envelope.commands[i];
      const r = session.dispatch({ ...entry });
      if (!r.ok) return { ok: false, error: 'illegal-command', at: i, reason: r.reason };
      const next = i + 1;
      if (hashIdx < envelope.hashes.length && envelope.hashes[hashIdx].at === next) {
        const actual = rules.hashState(session.state);
        if (actual !== envelope.hashes[hashIdx].hash) {
          return { ok: false, error: 'hash-mismatch', at: next };
        }
        hashIdx++;
      }
    }
    const finalHash = rules.hashState(session.state);
    if (finalHash !== envelope.finalHash) return { ok: false, error: 'final-hash-mismatch' };
    return {
      ok: true,
      finalHash,
      result: session.state.final,
      status: session.state.status,
      reason: session.state.terminalReason,
      stats: { ...session.state.stats },
      elapsedMs: session.state.elapsedMs,
    };
  }
}

// Local leaderboard helpers (friends/global hosted boards go through
// platform.js; offline boards stay local and are labeled casual).
export function boardEntryFromSession(session, name) {
  const f = session.state.final || rules.scoreBreakdown(session.state);
  return {
    name: name || 'Guest',
    score: f.total,
    progressPct: f.progressPct,
    errors: f.errors,
    elapsedMs: f.elapsedMs,
    contentId: session.content.id,
    contentVersion: session.content.version,
    seed: session.content.seed,
    ranked: session.content.meta.ranked === true,
    assists: session.state.stats.hints > 0 ? ['hint'] : [],
    at: Date.now(),
    sessionId: session.sessionId,
    envelope: session.envelope(),
  };
}

// Tie-break ordering shared with rules.compareResults semantics.
export function compareBoardEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.progressPct !== a.progressPct) return b.progressPct - a.progressPct;
  if (a.errors !== b.errors) return a.errors - b.errors;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

export function boardIdFor(content) {
  return hashString(`${content.mode}:${content.id}`).slice(0, 12);
}
