// storage.js — versioned, checksummed local persistence with migration and
// cloud-conflict helpers. Works headless (in-memory backend) for tests.

import { cyrb53 } from './rng.js';

export const SAVE_VERSION = 1;

const KEY_SAVE = 'pixelatelier.save.v1';
const KEY_SESSION = 'pixelatelier.session.v1';
const KEY_BOARDS = 'pixelatelier.boards.v1';

const memoryBackend = new Map();

function backend() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.getItem('__probe__');
      return localStorage;
    }
  } catch { /* private mode etc. */ }
  return {
    getItem: (k) => (memoryBackend.has(k) ? memoryBackend.get(k) : null),
    setItem: (k, v) => memoryBackend.set(k, String(v)),
    removeItem: (k) => memoryBackend.delete(k),
  };
}

export function checksumOf(obj) {
  return cyrb53(JSON.stringify(obj)).toString(16).padStart(14, '0');
}

function wrap(data, rev = 1) {
  const body = { v: SAVE_VERSION, rev, updatedAt: Date.now(), data };
  return { ...body, checksum: checksumOf(body) };
}

function unwrap(raw) {
  if (!raw) return null;
  let doc;
  try { doc = JSON.parse(raw); } catch { return null; }
  if (!doc || typeof doc !== 'object' || doc.checksum == null) return null;
  const { checksum, ...body } = doc;
  if (checksumOf(body) !== checksum) return null; // corrupted → treat as absent
  return doc;
}

export function defaultSaveData() {
  return {
    profile: { name: 'Guest', guest: true },
    settings: defaultSettings(),
    journey: { stars: {}, bestScores: {} }, // stageId → stars / score
    achievements: {},                        // key → unlockedAt
    daily: { lastDate: null, streak: 0, best: {}, history: {} },
    stats: { cellsFilled: 0, sessions: 0, playtimeMs: 0, roundsCompleted: 0 },
    tutorials: { done: [] },
    cosmetics: { unlocked: ['neon-draft'], theme: 'neon-draft' },
    rivals: [],                              // local friends for score chase
  };
}

export function defaultSettings() {
  return {
    audio: { music: 0.6, effects: 0.9, ambience: 0.5, voice: 0.8, muted: false },
    graphics: { tier: 'auto', renderScale: 1 },
    a11y: {
      palette: 'default',        // default | contrast | cvd
      reducedMotion: false,
      highContrast: false,
      largerText: false,
      leftHanded: false,
      holdToDrag: true,          // hold vs toggle drag
      timingAssist: false,       // +50% time limits, no time bonus pressure
      haptics: true,
      captions: true,
      cellLabels: false,         // always show index labels on cells
    },
    controls: { bindings: {} },  // action → key (overrides of DEFAULT_BINDINGS)
    camera: { autoFit: true },
    telemetryConsent: false,
  };
}

function migrateData(data, fromVersion) {
  // v1 is current; chained migrations live here for future versions.
  const d = data && typeof data === 'object' ? data : {};
  const def = defaultSaveData();
  // Shallow-merge defaults so new fields appear on old saves.
  const merged = { ...def, ...d };
  merged.settings = {
    ...def.settings, ...(d.settings || {}),
    audio: { ...def.settings.audio, ...(d.settings?.audio || {}) },
    graphics: { ...def.settings.graphics, ...(d.settings?.graphics || {}) },
    a11y: { ...def.settings.a11y, ...(d.settings?.a11y || {}) },
    controls: { ...def.settings.controls, ...(d.settings?.controls || {}) },
    camera: { ...def.settings.camera, ...(d.settings?.camera || {}) },
  };
  merged.journey = { ...def.journey, ...(d.journey || {}) };
  merged.daily = { ...def.daily, ...(d.daily || {}) };
  merged.stats = { ...def.stats, ...(d.stats || {}) };
  merged.tutorials = { ...def.tutorials, ...(d.tutorials || {}) };
  merged.cosmetics = { ...def.cosmetics, ...(d.cosmetics || {}) };
  return merged;
}

export class SaveStore {
  constructor() {
    this.store = backend();
    const doc = unwrap(this.store.getItem(KEY_SAVE));
    if (doc) {
      this.rev = doc.rev;
      this.data = migrateData(doc.data, doc.v);
    } else {
      this.rev = 0;
      this.data = defaultSaveData();
      this.persist();
    }
  }

  persist() {
    this.rev += 1;
    const doc = wrap(this.data, this.rev);
    try { this.store.setItem(KEY_SAVE, JSON.stringify(doc)); } catch { /* quota */ }
    return doc;
  }

  update(mutator) {
    mutator(this.data);
    return this.persist();
  }

  // Cloud conflict: returns 'local' | 'remote' | 'conflict'.
  static resolveRevision(localDoc, remoteDoc) {
    if (!remoteDoc) return 'local';
    if (!localDoc) return 'remote';
    if (remoteDoc.rev > localDoc.rev) return 'remote';
    if (localDoc.rev > remoteDoc.rev) return 'local';
    if (localDoc.checksum === remoteDoc.checksum) return 'local';
    return 'conflict'; // same revision, different content → ask the player
  }

  exportDoc() { return wrap(this.data, this.rev); }

  importDoc(doc) {
    const { checksum, ...body } = doc;
    if (checksumOf(body) !== checksum) throw new Error('save: bad checksum');
    this.data = migrateData(body.data, body.v);
    this.rev = body.rev;
    this.persist();
  }

  // --- mid-round session snapshot (last safe local snapshot) ---
  saveSessionSnapshot(snapshot) {
    try { this.store.setItem(KEY_SESSION, JSON.stringify(snapshot)); } catch { /* quota */ }
  }
  loadSessionSnapshot() {
    try {
      const raw = this.store.getItem(KEY_SESSION);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  clearSessionSnapshot() {
    try { this.store.removeItem(KEY_SESSION); } catch { /* ignore */ }
  }

  // --- local (casual) leaderboards ---
  loadBoards() {
    try {
      const raw = this.store.getItem(KEY_BOARDS);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }
  saveBoards(boards) {
    try { this.store.setItem(KEY_BOARDS, JSON.stringify(boards)); } catch { /* quota */ }
  }
}
