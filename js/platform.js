// platform.js — StarHermit host adapter: launch token from the URL fragment,
// same-origin /api/v1 routes with Bearer auth, 45-minute token refresh,
// account nickname, cloud save (zip+base64, debounced, pagehide flush),
// read-only platform leaderboards, retries with rate-limit handling.
// Everything degrades gracefully to local/guest mode when no launch token
// was read. The bundled dev server (node server.js, reached on localhost or
// via ?api=) keeps its own validated routes for local development only —
// none of them are called on-platform.

export class PlatformError extends Error {
  constructor(code, message, status = 0) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

export class Platform {
  constructor() {
    const params = typeof location !== 'undefined'
      ? new URLSearchParams(location.search) : new URLSearchParams();
    // Game scope comes from the short-lived launch token, never hard-coded,
    // and the token is held in memory only — never persisted.
    this.launchToken = null;
    this.apiBase = params.get('api') || '/api/v1';
    this.hosted = false;
    this.devMode = typeof location !== 'undefined'
      && (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || params.has('api'));
    this.timeSynced = false;
    this.profile = null;
    this.gameSlug = null;
    this.userId = null;
    this.timeOffsetMs = 0;
    this.syncStatus = 'offline';
    this.onSyncStatus = null;
    this._presenceTimer = null;
    this._activityStarted = false;
    this.telemetryConsent = false;
    this._telemetryQueue = [];
    this._nickCache = new Map();
    this._gameInfo = undefined; // undefined = not fetched yet
    this._saveT = null;
    this._pendingDoc = null;
    this._refreshT = null;

    // Primary: the platform delivers the launch token in the URL fragment.
    // Read once, then strip it from the address bar.
    if (typeof location !== 'undefined' && location.hash.length > 1) {
      const frag = new URLSearchParams(location.hash.slice(1));
      const token = frag.get('game_token');
      if (token) {
        this.launchToken = token;
        frag.delete('game_token');
        const rest = frag.toString();
        if (typeof history !== 'undefined') {
          history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
        }
      }
    }
    // Local-dev fallbacks only — the platform itself never puts a token in
    // the query string.
    if (!this.launchToken) {
      this.launchToken = params.get('game_token') || params.get('launchToken')
        || params.get('token') || params.get('launch') || null;
    }
    const claims = this.launchToken ? decodeJwtPayload(this.launchToken) : {};
    this.userId = typeof claims.sub === 'string' && claims.sub ? claims.sub : null;
    this.gameSlug = typeof claims.game_scope === 'string' && claims.game_scope ? claims.game_scope : null;
    this.hosted = !!this.launchToken;
  }

  async init() {
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.flushCloudSave());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushCloudSave();
      });
    }
    if (this.devMode) {
      // The bundled dev server serves platform time; on-platform there is no
      // /time route, so the local clock drives daily boundaries instead.
      try { await this.syncTime(); this.timeSynced = true; } catch { /* local clock */ }
    }
    if (this.hosted) {
      this._scheduleRefresh();
      // Account nickname (NEVER /api/v1/me — launch tokens get 403 there).
      this.profile = await this.fetchProfile();
      this._setSyncStatus('synced');
    }
    return this;
  }

  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.launchToken) h.Authorization = `Bearer ${this.launchToken}`;
    return h;
  }

  async request(method, path, body, attempt = 0) {
    let res;
    try {
      res = await fetch(this.apiBase + path, {
        method,
        headers: this.headers(),
        body: body == null ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (attempt < 2) {
        await sleep(300 * 2 ** attempt);
        return this.request(method, path, body, attempt + 1);
      }
      throw new PlatformError('network', 'Network unavailable', 0);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) {
        const retryAfter = Number(res.headers.get('Retry-After')) * 1000;
        await sleep(Math.min(retryAfter || 400 * 2 ** attempt, 5000));
        return this.request(method, path, body, attempt + 1);
      }
      throw new PlatformError('rate-limited', 'The server is busy — try again shortly.', res.status);
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
      throw new PlatformError(data?.error || `http-${res.status}`, data?.error || res.statusText, res.status);
    }
    return data;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body ?? {}); }
  put(path, body) { return this.request('PUT', path, body ?? {}); }

  // Round-trip-adjusted server time. Only the bundled dev server serves this;
  // on-platform daily boundaries sync to the local clock.
  async syncTime() {
    const t0 = Date.now();
    const data = await this.get('/time');
    const t1 = Date.now();
    const serverNow = Number(data.now);
    if (!Number.isFinite(serverNow)) throw new PlatformError('bad-time', 'Bad time response');
    this.timeOffsetMs = serverNow - (t0 + (t1 - t0) / 2);
    return this.timeOffsetMs;
  }

  now() { return Date.now() + (this.timeSynced ? this.timeOffsetMs : 0); }

  utcDateString(d = new Date(this.now())) {
    return d.toISOString().slice(0, 10);
  }

  isoWeekString(d = new Date(this.now())) {
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  msUntilNextUtcDay() {
    const now = new Date(this.now());
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return next - now;
  }

  // --- daily session (dev server: server-issued; otherwise derived locally) ---
  async dailyInfo() {
    if (this.devMode) {
      try {
        const info = await this.get('/daily');
        if (info && typeof info.date === 'string' && typeof info.seed === 'string') return info;
      } catch { /* fall through */ }
    }
    const date = this.utcDateString();
    return { date, seed: `daily:${date}`, version: 1, excluded: false };
  }

  // --- identity: account nickname via the profile route. NEVER usernames. ---
  async fetchProfile() {
    if (!this.hosted || !this.userId) return null;
    try {
      const p = await this.get(`/users/${encodeURIComponent(this.userId)}/profile`);
      return this._profileFromPayload(p);
    } catch {
      return { id: this.userId, name: `Player ${this.userId.slice(0, 8)}` };
    }
  }
  _profileFromPayload(p) {
    const id = (typeof p?.id === 'string' && p.id) || this.userId;
    const name = (typeof p?.nickname === 'string' && p.nickname) || `Player ${String(id).slice(0, 8)}`;
    return { id, name };
  }
  async nicknameFor(userId) {
    const key = String(userId);
    if (this._nickCache.has(key)) return this._nickCache.get(key);
    let name = `Player ${key.slice(0, 8)}`;
    try {
      const p = await this.get(`/users/${encodeURIComponent(key)}/profile`);
      if (typeof p?.nickname === 'string' && p.nickname) name = p.nickname;
    } catch { /* keep fallback */ }
    this._nickCache.set(key, name);
    return name;
  }

  // --- launch-token refresh (60 min lifetime; re-mint every 45 min) ---
  _scheduleRefresh() {
    if (!this.hosted || !this.gameSlug || typeof setTimeout === 'undefined') return;
    clearTimeout(this._refreshT);
    this._refreshT = setTimeout(() => this._refreshToken(), 45 * 60 * 1000);
    this._refreshT.unref?.(); // never keep a non-browser process alive
  }
  async _refreshToken() {
    try {
      const res = await this.post(`/games/${encodeURIComponent(this.gameSlug)}/launch-token`, {});
      if (res && typeof res.token === 'string' && res.token) this.launchToken = res.token;
      this._scheduleRefresh();
    } catch {
      this._refreshT = setTimeout(() => this._refreshToken(), 60000); // retry shortly
      this._refreshT.unref?.();
    }
  }

  // --- leaderboards (platform-owned: clients read, never submit) ---
  async gameInfo() {
    if (!this.hosted || !this.gameSlug) return null;
    if (this._gameInfo === undefined) {
      try { this._gameInfo = await this.get(`/games/${encodeURIComponent(this.gameSlug)}`); }
      catch { this._gameInfo = null; }
    }
    return this._gameInfo;
  }
  // Returns null when the game has no platform leaderboard — the caller then
  // shows local records only.
  async leaderboardEntries({ friendsOnly = false, page = 0, pageSize = 50 } = {}) {
    const info = await this.gameInfo();
    const lb = info?.leaderboardId;
    if (!lb) return null;
    const qs = new URLSearchParams({
      friendsOnly: String(friendsOnly), page: String(page), pageSize: String(pageSize),
    });
    const res = await this.get(`/leaderboards/${encodeURIComponent(lb)}/entries?${qs}`);
    const list = Array.isArray(res?.entries) ? res.entries : (Array.isArray(res) ? res : []);
    return Promise.all(list.map((e) => this._normalizeEntry(e)));
  }
  async _normalizeEntry(e) {
    const uid = e.userId ?? e.user_id ?? e.id ?? null;
    return {
      name: uid ? await this.nicknameFor(uid) : (typeof e.nickname === 'string' ? e.nickname : 'Player'),
      score: Number(e.score ?? e.value ?? 0) || 0,
      progressPct: Number(e.progressPct ?? e.progress ?? 0) || 0,
      errors: Number(e.errors ?? 0) || 0,
      elapsedMs: Number(e.elapsedMs ?? e.durationMs ?? e.elapsed ?? 0) || 0,
    };
  }
  // Local-development read against the bundled dev server's validated boards.
  async devLeaderboard(boardId, scope = 'global') {
    if (!this.devMode) throw new PlatformError('unsupported', 'No dev server');
    return this.get(`/leaderboard?board=${encodeURIComponent(boardId)}&scope=${scope}`);
  }
  // Local-development submit against the bundled dev server. On-platform,
  // leaderboards are script/elo-owned and clients can NEVER submit.
  async submitScore(boardId, entry) {
    if (!this.devMode) throw new PlatformError('unsupported', 'Clients cannot submit scores');
    return this.post('/scores', { boardId, entry });
  }

  // --- achievements stay local (part of the cloud-saved doc). The dev server
  // also tracks them for local testing; on-platform there is no client unlock
  // path and server.js is not a platform game script. ---
  async unlockAchievement(key) {
    if (!this.devMode) return null;
    try { return await this.post('/achievements', { key }); } catch { return null; }
  }

  // --- cloud save: ONE slot (zip+base64). localStorage stays the offline
  // cache; the cloud is a mirror. ---
  async cloudLoad() {
    if (!this.hosted || !this.gameSlug) return null;
    try {
      const res = await fetch(`${this.apiBase}/me/cloud-saves/${encodeURIComponent(this.gameSlug)}`, {
        headers: this.headers(),
      });
      if (res.status === 404) return null; // no save yet
      if (!res.ok) throw new PlatformError(`http-${res.status}`, 'cloud load failed', res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return JSON.parse(new TextDecoder().decode(unzipFirstEntry(bytes)));
    } catch {
      this._setSyncStatus('offline');
      return null;
    }
  }
  async cloudSave(doc) {
    if (!this.hosted || !this.gameSlug) return null;
    const zip = zipStore('save.json', new TextEncoder().encode(JSON.stringify(doc)));
    await this.put(`/me/cloud-saves/${encodeURIComponent(this.gameSlug)}`, { dataBase64: bytesToBase64(zip) });
    this._setSyncStatus('synced');
    return doc;
  }
  // Debounced mirror (~2 s), flushed on pagehide/visibilitychange.
  cloudSaveSoon(doc) {
    if (!this.hosted || !this.gameSlug) return;
    this._pendingDoc = doc;
    this._setSyncStatus('saving');
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.flushCloudSave(), 2000);
    this._saveT.unref?.();
  }
  async flushCloudSave() {
    clearTimeout(this._saveT);
    this._saveT = null;
    const doc = this._pendingDoc;
    if (!doc) return;
    this._pendingDoc = null;
    try { await this.cloudSave(doc); }
    catch { this._pendingDoc = doc; this._setSyncStatus('offline'); }
  }
  _setSyncStatus(status) {
    this.syncStatus = status;
    try { this.onSyncStatus?.(status); } catch { /* UI hook */ }
  }

  // --- presence + activity + telemetry: bundled-dev-server only. The wiki
  // has no per-game presence/telemetry/activity endpoints reachable by launch
  // tokens, so on-platform these are silent no-ops. ---
  startPresence() {
    if (!this.devMode || this._presenceTimer) return;
    const beat = () => this.post('/presence', { state: 'playing' }).catch(() => {});
    beat();
    this._presenceTimer = setInterval(beat, 30000);
  }
  stopPresence() {
    if (this._presenceTimer) clearInterval(this._presenceTimer);
    this._presenceTimer = null;
    if (this.devMode) this.post('/presence', { state: 'idle' }).catch(() => {});
  }
  activityStart() {
    if (!this.devMode || this._activityStarted) return;
    this._activityStarted = true;
    this.post('/activity', { event: 'start' }).catch(() => { this._activityStarted = false; });
  }
  activityEnd() {
    if (!this.devMode || !this._activityStarted) return;
    this._activityStarted = false;
    this.post('/activity', { event: 'end' }).catch(() => {});
  }

  // --- anonymous funnel telemetry (consent-gated, coarse categories only) ---
  setTelemetryConsent(consent) { this.telemetryConsent = consent === true; }
  track(event, detail = {}) {
    if (!this.telemetryConsent) return;
    const allowed = ['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error'];
    if (!allowed.includes(event)) return;
    const clean = {};
    for (const k of ['mode', 'step', 'tier', 'category', 'outcome']) {
      if (typeof detail[k] === 'string' && detail[k].length <= 40) clean[k] = detail[k];
    }
    const payload = { event, ...clean, at: Date.now() };
    if (!this.devMode) { this._telemetryQueue.push(payload); return; }
    this.post('/telemetry', payload).catch(() => this._telemetryQueue.push(payload));
    if (this._telemetryQueue.length > 50) this._telemetryQueue.length = 0;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// JWT payload (base64url decode, no verify): sub = user id, game_scope = slug.
function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) return {};
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    return json && typeof json === 'object' ? json : {};
  } catch { return {}; }
}

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
export function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
