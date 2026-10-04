// platform.js — StarHermit host adapter over the shared SDK
// (starhermit-sdk.js, loaded as a classic script before the game modules):
// launch token + renewal, sign-in, account nickname, cloud save (slot
// game:<slug>, debounced, pagehide flush), per-player settings KV, keyboard
// bindings (with rebinding written back), invite link and read-only platform
// leaderboards. Hosted mode is "the SDK holds a token"; everything degrades
// to local/guest mode without one and then no request is made at all. The
// game never calls its own server routes (/api, /ws): the device clock drives
// daily boundaries; boards, achievements and stats are local.

export class PlatformError extends Error {
  constructor(code, message, status = 0) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

/** The SDK instance (window.StarHermit; tests may inject one on globalThis). */
function sdk() { return globalThis.StarHermit || null; }

export class Platform {
  constructor() {
    this.profile = null;
    this.syncStatus = 'offline';
    this.onSyncStatus = null;
    this.onAuthChange = null;   // ({ signedIn }) after the platform session ends
    this._sentSettings = {};
    // Read the launch token (no-op when index.html already did).
    const sh = sdk();
    if (sh && !sh.signedIn) sh.init();
  }

  get hosted() { return !!(sdk() && sdk().signedIn); }
  get userId() { return this.hosted ? sdk().userId : null; }
  get gameSlug() { return this.hosted ? sdk().slug : null; }

  async init() {
    const sh = sdk();
    if (sh) {
      sh.on('saved', (ok) => this._setSyncStatus(ok ? 'synced' : 'offline'));
      sh.on('auth', (a) => {
        if (!a.signedIn) { this.profile = null; this._setSyncStatus('offline'); }
        try { this.onAuthChange?.({ signedIn: !!a.signedIn }); } catch { /* UI hook */ }
      });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.flushCloudSave(true));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushCloudSave(true);
      });
    }
    if (this.hosted) {
      // Account nickname (never /api/v1/me — launch tokens get 403 there).
      this.profile = await this.fetchProfile();
      this._setSyncStatus('synced');
    }
    return this;
  }

  canSignIn() { return !!(sdk() && sdk().canSignIn()); }
  signIn() { return !!(sdk() && sdk().signIn()); }
  inviteLink() { return this.hosted ? sdk().inviteLink() : null; }

  // Device clock: there is no client-reachable time route.
  now() { return Date.now(); }

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

  // --- daily session: derived locally from the UTC date ---
  async dailyInfo() {
    const date = this.utcDateString();
    return { date, seed: `daily:${date}`, version: 1, excluded: false };
  }

  // --- identity: account nickname via the profile (never usernames) ---
  async fetchProfile() {
    if (!this.hosted) return null;
    const p = await sdk().profile();
    return { id: this.userId, name: p ? p.displayName : `Player ${String(this.userId).slice(0, 6)}` };
  }
  async nicknameFor(userId) {
    const p = this.hosted ? await sdk().profile(String(userId)) : null;
    return p ? p.displayName : `Player ${String(userId).slice(0, 6)}`;
  }

  // --- leaderboards (platform-owned: clients read, never submit) ---
  // Returns null when the game has no platform leaderboard — the caller then
  // shows local records only.
  async leaderboardEntries({ friendsOnly = false, pageSize = 50 } = {}) {
    if (!this.hosted) return null;
    const r = await sdk().leaderboard(null, { pageSize, scope: friendsOnly ? 'friends' : undefined });
    if (!r || !r.board) return null;
    return Promise.all((r.items || []).map((e) => this._normalizeEntry(e)));
  }
  async _normalizeEntry(e) {
    const uid = e.userId ?? null;
    return {
      name: uid ? await this.nicknameFor(uid) : 'Player',
      score: Number(e.score ?? 0) || 0,
      progressPct: Number(e.progressPct ?? 0) || 0,
      errors: Number(e.errors ?? 0) || 0,
      elapsedMs: Number(e.elapsedMs ?? 0) || 0,
    };
  }
  // Achievements stay local (part of the cloud-saved doc); there is no
  // client unlock path.

  // --- cloud save: ONE slot (game:<slug>). localStorage stays the offline
  // cache; the cloud is a mirror. ---
  async cloudLoad() {
    if (!this.hosted) return null;
    const doc = await sdk().loadJSON();
    return doc && typeof doc === 'object' ? doc : null;
  }
  async cloudSave(doc) {
    if (!this.hosted) return null;
    const ok = await sdk().writeSave(JSON.stringify(doc));
    if (!ok) throw new PlatformError('cloud-save', 'Cloud save failed');
    return doc;
  }
  // Debounced mirror (~2 s), flushed on pagehide/visibilitychange.
  cloudSaveSoon(doc) {
    if (!this.hosted) return;
    this._setSyncStatus('saving');
    sdk().saveJSON(doc, 2000);
  }
  async flushCloudSave(keepalive = false) {
    if (!this.hosted) return false;
    return sdk().flushSave(keepalive);
  }

  // --- per-player settings KV (preferences mirror) ---
  async loadRemoteSettings() {
    if (!this.hosted) return {};
    const s = (await sdk().getSettings()) || {};
    this._settingsLoaded = true; // no PATCH before the platform values were read
    for (const [k, v] of Object.entries(s)) this._sentSettings[k] = JSON.stringify(v);
    return s;
  }
  syncSettings(prefs) {
    if (!this.hosted || !this._settingsLoaded) return Promise.resolve(null);
    const patch = {};
    for (const [k, v] of Object.entries(prefs || {})) {
      const json = JSON.stringify(v);
      if (this._sentSettings[k] !== json) { patch[k] = v; this._sentSettings[k] = json; }
    }
    return Object.keys(patch).length ? sdk().patchSettings(patch) : Promise.resolve(null);
  }

  // --- controls: { action: codes[] } with the player's platform overrides ---
  loadBindings(defaults) {
    const copy = () => Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, v.slice()]));
    if (!this.hosted) return Promise.resolve(copy());
    return sdk().loadBindings(defaults).catch(copy);
  }
  saveBindings(bindings) {
    if (!this.hosted) return Promise.resolve(null);
    return sdk().setControls(bindings).catch(() => null);
  }
  resetBindings() {
    if (!this.hosted) return Promise.resolve(null);
    return sdk().resetControls();
  }

  _setSyncStatus(status) {
    this.syncStatus = status;
    try { this.onSyncStatus?.(status); } catch { /* UI hook */ }
  }
}
