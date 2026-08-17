// server.js — Pixel Atelier authoritative Game Script (StarHermit).
// Zero-dependency Node ESM server: static distribution + /api/v1 routes.
// Responsibilities: platform time, immutable daily seeds, replay-validated
// leaderboards, durable idempotent achievements, cloud saves, presence,
// activity pairing, consent-gated coarse telemetry.
//
// Run: node server.js  (PORT env, default 8080)

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { CONTENT_VERSION, dailyContent, scoreChaseContent } from './js/content.js';
import { Session } from './js/session.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA = join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 8080;

// Days with defective content are excluded from ranking, never silently
// replaced — daily seeds are immutable after publication.
const EXCLUDED_DAILY = new Set();

const ACHIEVEMENT_KEYS = new Set([
  'first-completion', 'mechanic-mastery', 'daily-streak-7',
  'expert-milestone', 'marathon-painter',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------------------
// Tiny JSON stores (durable, atomic writes)
// ---------------------------------------------------------------------------
async function loadJson(name, fallback) {
  try {
    const raw = await readFile(join(DATA, name), 'utf8');
    return JSON.parse(raw);
  } catch { return fallback; }
}
async function saveJson(name, value) {
  await mkdir(DATA, { recursive: true });
  const tmp = join(DATA, `${name}.tmp`);
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, join(DATA, name));
}

// ---------------------------------------------------------------------------
// Rate limiting: token bucket per identity, structured 429s.
// ---------------------------------------------------------------------------
const buckets = new Map();
function rateLimit(id, cost = 1) {
  const now = Date.now();
  let b = buckets.get(id);
  if (!b || now - b.at > 10000) { b = { tokens: 20, at: now }; buckets.set(id, b); }
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  return true;
}
setInterval(() => { if (buckets.size > 5000) buckets.clear(); }, 60000).unref();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}
function err(res, status, code) { json(res, status, { error: code }); }

function profileId(req) {
  // The host shell issues account tokens; here we derive a stable opaque id.
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : 'guest';
  return createHash('sha256').update(token || 'guest').digest('hex').slice(0, 16);
}

async function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}

function utcDate(d = new Date()) { return d.toISOString().slice(0, 10); }

// Reconstruct the authoritative content for ranked boards; the client can
// never supply its own board definition for a ranked submission.
function contentForRanked(contentId) {
  if (/^daily-\d{4}-\d{2}-\d{2}$/.test(contentId)) {
    const date = contentId.slice(6);
    if (EXCLUDED_DAILY.has(date)) return null;
    return dailyContent(date);
  }
  if (/^chase-\d{4}-W\d{2}$/.test(contentId)) return scoreChaseContent(contentId.slice(6));
  return null;
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
const routes = {
  'GET /time': async (req, res) => json(res, 200, { now: Date.now() }),

  'GET /daily': async (req, res) => {
    const date = utcDate();
    json(res, 200, {
      date,
      seed: `daily:${date}`,
      version: CONTENT_VERSION,
      excluded: EXCLUDED_DAILY.has(date),
      nextInMs: new Date(`${date}T00:00:00Z`).getTime() + 86400000 - Date.now(),
    });
  },

  'GET /leaderboard': async (req, res, url) => {
    const board = url.searchParams.get('board') || '';
    if (!/^[a-z0-9:_-]{1,64}$/i.test(board)) return err(res, 400, 'bad-board');
    const boards = await loadJson('leaderboards.json', {});
    let entries = (boards[board] || []).map(({ envelope, ...e }) => e); // envelopes stay server-side
    const scope = url.searchParams.get('scope') || 'global';
    if (scope === 'friends') {
      const names = (url.searchParams.get('names') || '').split(',').filter(Boolean);
      entries = entries.filter((e) => names.includes(e.name));
    }
    entries.sort((a, b) => b.score - a.score || a.errors - b.errors || a.elapsedMs - b.elapsedMs);
    json(res, 200, { board, scope, entries: entries.slice(0, 50) });
  },

  'POST /scores': async (req, res) => {
    const body = await readBody(req);
    const { boardId, entry } = body || {};
    if (typeof boardId !== 'string' || !entry || typeof entry !== 'object') return err(res, 400, 'bad-request');
    if (typeof entry.name !== 'string' || entry.name.length > 24) return err(res, 400, 'bad-name');
    const content = contentForRanked(entry.contentId);
    if (!content) return err(res, 422, 'unranked-content'); // casual boards stay client-local
    if (entry.contentVersion !== CONTENT_VERSION) return err(res, 422, 'stale-version');
    if (!entry.envelope) return err(res, 422, 'missing-replay');

    // Authoritative validation: replay the input log against derived content.
    const verdict = Session.verify(entry.envelope, content);
    if (!verdict.ok) return err(res, 422, `replay-${verdict.error}`);
    const cells = content.width * content.height;
    if (verdict.elapsedMs < cells * 80) return err(res, 422, 'implausible-speed');
    if (verdict.status !== 'complete' && verdict.result?.progressPct < 1) {
      return err(res, 422, 'incomplete-round');
    }

    const pid = profileId(req);
    const boards = await loadJson('leaderboards.json', {});
    const list = boards[boardId] || [];
    // Rate guard: one entry per profile per board; keep the better one.
    const existing = list.findIndex((e) => e.pid === pid);
    const clean = {
      pid, name: entry.name.slice(0, 24),
      score: verdict.result?.total ?? 0,
      progressPct: verdict.result?.progressPct ?? 0,
      errors: verdict.stats.errors,
      elapsedMs: verdict.elapsedMs,
      contentId: content.id, contentVersion: content.version,
      seed: content.seed, assists: Array.isArray(entry.assists) ? entry.assists.slice(0, 4) : [],
      validated: true, at: Date.now(),
    };
    if (existing >= 0) {
      if (list[existing].score >= clean.score) return json(res, 200, { rank: existing + 1, kept: 'existing' });
      list.splice(existing, 1);
    }
    list.push(clean);
    list.sort((a, b) => b.score - a.score || a.errors - b.errors || a.elapsedMs - b.elapsedMs);
    boards[boardId] = list.slice(0, 100);
    await saveJson('leaderboards.json', boards);
    json(res, 200, { rank: boards[boardId].indexOf(clean) + 1, validated: true });
  },

  'POST /achievements': async (req, res) => {
    const body = await readBody(req);
    const key = body?.key;
    if (typeof key !== 'string' || !ACHIEVEMENT_KEYS.has(key)) return err(res, 400, 'unknown-achievement');
    const pid = profileId(req);
    const ach = await loadJson('achievements.json', {});
    ach[pid] = ach[pid] || {};
    if (!ach[pid][key]) { // idempotent unlock
      ach[pid][key] = Date.now();
      await saveJson('achievements.json', ach);
    }
    json(res, 200, { key, unlockedAt: ach[pid][key] });
  },

  'GET /save': async (req, res) => {
    const saves = await loadJson('saves.json', {});
    const doc = saves[profileId(req)] || null;
    json(res, 200, { doc });
  },

  'PUT /save': async (req, res) => {
    const body = await readBody(req, 256 * 1024);
    if (!body?.doc?.data || !body.doc.checksum || typeof body.doc.rev !== 'number') {
      return err(res, 400, 'bad-save');
    }
    const pid = profileId(req);
    const saves = await loadJson('saves.json', {});
    const existing = saves[pid];
    if (existing && existing.rev > body.doc.rev) {
      return json(res, 200, { kept: 'remote', doc: existing }); // conflict surfaced to client
    }
    saves[pid] = body.doc;
    await saveJson('saves.json', saves);
    json(res, 200, { kept: 'local' });
  },

  'POST /presence': async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const state = body?.state === 'playing' ? 'playing' : 'idle';
    const presence = await loadJson('presence.json', {});
    presence[profileId(req)] = { state, at: Date.now() };
    await saveJson('presence.json', presence);
    json(res, 200, { ok: true });
  },

  'POST /activity': async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (body?.event !== 'start' && body?.event !== 'end') return err(res, 400, 'bad-event');
    const activity = await loadJson('activity.json', {});
    const pid = profileId(req);
    activity[pid] = activity[pid] || { started: null, totalMs: 0 };
    if (body.event === 'start') activity[pid].started = Date.now();
    else {
      if (activity[pid].started) activity[pid].totalMs += Date.now() - activity[pid].started;
      activity[pid].started = null;
    }
    await saveJson('activity.json', activity);
    json(res, 200, { ok: true });
  },

  'POST /telemetry': async (req, res) => {
    const body = await readBody(req, 4096).catch(() => null);
    const allowed = new Set(['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error']);
    if (!body || !allowed.has(body.event)) return err(res, 400, 'bad-event');
    // Aggregate counts only — no raw text, no identifiers, no pointer trails.
    const stats = await loadJson('telemetry.json', {});
    const k = `${body.event}:${body.mode || body.step || body.category || body.outcome || ''}`.slice(0, 80);
    stats[k] = (stats[k] || 0) + 1;
    await saveJson('telemetry.json', stats);
    json(res, 200, { ok: true });
  },
};

// ---------------------------------------------------------------------------
// HTTP server: /api/v1/* + static distribution
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/v1/')) {
      const ip = req.socket.remoteAddress || 'unknown';
      if (!rateLimit(ip)) return err(res, 429, 'rate-limited');
      const key = `${req.method} ${url.pathname.slice('/api/v1'.length)}`;
      const route = routes[key];
      if (!route) return err(res, 404, 'not-found');
      return await route(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return err(res, 405, 'method-not-allowed');

    // Static files, traversal-safe.
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (path.startsWith('..') || path.includes('\0')) return err(res, 403, 'forbidden');
    if (path === '' || path === '.') path = 'index.html';
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file)) return err(res, 404, 'not-found');
    const data = await readFile(file);
    const immutable = /\.(js|css)$/.test(file) && !file.endsWith('server.js');
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=3600' : 'no-cache',
      'Content-Length': data.length,
    });
    res.end(data);
  } catch (e) {
    if (e?.message === 'payload-too-large') return err(res, 413, 'payload-too-large');
    if (e?.message === 'bad-json') return err(res, 400, 'bad-json');
    err(res, 500, 'internal');
  }
});

server.listen(PORT, () => {
  console.log(`Pixel Atelier listening on http://localhost:${PORT}`);
});
