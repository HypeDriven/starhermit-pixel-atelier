// platform.js — StarHermit-style host adapter: launch token, same-origin
// /api routes, round-trip time sync, retries with rate-limit handling,
// presence heartbeats, cloud save, leaderboards, telemetry consent.
// Everything degrades gracefully to local/guest mode when not hosted.

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
    this.launchToken = params.get('launchToken') || null;
    this.apiBase = params.get('api') || '/api/v1';
    this.hosted = false;
    this.profile = null;
    this.timeOffsetMs = 0;
    this._presenceTimer = null;
    this._activityStarted = false;
    this.telemetryConsent = false;
    this._telemetryQueue = [];
  }

  async init() {
    if (typeof fetch === 'undefined') return this;
    try {
      await this.syncTime();
      this.hosted = true;
    } catch {
      this.hosted = false; // static/offline hosting → guest mode
    }
    if (this.hosted) {
      try { this.profile = await this.get('/profile'); } catch { this.profile = null; }
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
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      throw new PlatformError(data?.error || `http-${res.status}`, data?.error || res.statusText, res.status);
    }
    return data;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body ?? {}); }
  put(path, body) { return this.request('PUT', path, body ?? {}); }

  // Round-trip-adjusted server time: daily boundaries and countdowns sync
  // to platform time, never the client clock.
  async syncTime() {
    const t0 = Date.now();
    const data = await this.get('/time');
    const t1 = Date.now();
    const serverNow = Number(data.now);
    if (!Number.isFinite(serverNow)) throw new PlatformError('bad-time', 'Bad time response');
    this.timeOffsetMs = serverNow - (t0 + (t1 - t0) / 2);
    return this.timeOffsetMs;
  }

  now() { return Date.now() + (this.hosted ? this.timeOffsetMs : 0); }

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

  // --- daily session (hosted: server-issued; offline: derived locally) ---
  async dailyInfo() {
    if (this.hosted) {
      try { return await this.get('/daily'); } catch { /* fall through */ }
    }
    const date = this.utcDateString();
    return { date, seed: `daily:${date}`, version: 1, excluded: false };
  }

  // --- leaderboards ---
  async submitScore(boardId, entry) {
    if (!this.hosted) throw new PlatformError('offline', 'Not hosted');
    return this.post('/scores', { boardId, entry });
  }
  async leaderboard(boardId, scope = 'global') {
    if (!this.hosted) throw new PlatformError('offline', 'Not hosted');
    return this.get(`/leaderboard?board=${encodeURIComponent(boardId)}&scope=${scope}`);
  }

  // --- achievements (durable delivery when hosted) ---
  async unlockAchievement(key) {
    if (!this.hosted) return null;
    try { return await this.post('/achievements', { key }); } catch { return null; }
  }

  // --- cloud save ---
  async cloudLoad() {
    if (!this.hosted) return null;
    try { return await this.get('/save'); } catch { return null; }
  }
  async cloudSave(doc) {
    if (!this.hosted) return null;
    try { return await this.put('/save', doc); } catch { return null; }
  }

  // --- presence + activity (playtime accuracy) ---
  startPresence() {
    if (!this.hosted || this._presenceTimer) return;
    const beat = () => this.post('/presence', { state: 'playing' }).catch(() => {});
    beat();
    this._presenceTimer = setInterval(beat, 30000);
  }
  stopPresence() {
    if (this._presenceTimer) clearInterval(this._presenceTimer);
    this._presenceTimer = null;
    if (this.hosted) this.post('/presence', { state: 'idle' }).catch(() => {});
  }
  activityStart() {
    if (!this.hosted || this._activityStarted) return;
    this._activityStarted = true;
    this.post('/activity', { event: 'start' }).catch(() => { this._activityStarted = false; });
  }
  activityEnd() {
    if (!this.hosted || !this._activityStarted) return;
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
    if (!this.hosted) { this._telemetryQueue.push(payload); return; }
    this.post('/telemetry', payload).catch(() => this._telemetryQueue.push(payload));
    if (this._telemetryQueue.length > 50) this._telemetryQueue.length = 0;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
