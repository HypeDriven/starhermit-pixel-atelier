// StarHermit adapter (js/platform.js) over the shared SDK with a stubbed fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The SDK is a classic browser script: evaluate it the way a <script> tag
// would, against a stand-in global.
const holder = {};
new Function('self', 'module', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(holder, undefined);
const SDK = holder.StarHermit;

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `h.${b64u({ sub: 'user-12345678-abcd', game_scope: 'pa-slug', exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;

function install(href) {
  const calls = [];
  const saves = {};
  const etags = {};
  let version = 0;
  const kv = { audio: { music: 0.2 }, 'ui.language': { choice: 'it-IT' } };
  let controls = [{ action: 'undo', codes: ['KeyZ'] }];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', init });
    const r = (status, body) => new Response(body, { status });
    const j = (o) => r(200, JSON.stringify(o));
    if (url === '/api/v1/users/user-12345678-abcd/profile') return j({ username: 'ignore_me', nickname: 'NeonFox' });
    if (url === '/api/v1/users/user-other/profile') return j({ nickname: 'RivalOne' });
    if (url.includes('/cloud-saves/')) {
      // Versioned slot like the platform: /info carries the ETag, a PUT must
      // match it (If-Match) or target an empty slot (If-None-Match: *), else 412.
      const rest = decodeURIComponent(url.split('/cloud-saves/')[1]);
      const key = rest.replace(/\/info$/, '');
      if (rest.endsWith('/info')) return j(saves[key] ? { exists: true, etag: etags[key] } : { exists: false });
      if (init.method === 'PUT') {
        const hd = init.headers || {};
        if ((hd['If-Match'] && hd['If-Match'] !== etags[key]) || (hd['If-None-Match'] === '*' && saves[key])) {
          return r(412, JSON.stringify({ error: 'precondition failed', etag: etags[key] }));
        }
        saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        etags[key] = `"v${++version}"`;
        return j({ etag: etags[key] });
      }
      return saves[key] ? r(200, saves[key]) : r(404, '');
    }
    if (url.endsWith('/settings') && init.method === 'PATCH') { Object.assign(kv, JSON.parse(init.body).settings); return j({}); }
    if (url.endsWith('/settings')) return j({ settings: kv });
    if (url.endsWith('/controls') && init.method === 'PUT') {
      for (const [action, codes] of Object.entries(JSON.parse(init.body).bindings)) controls = controls.filter((c) => c.action !== action).concat([{ action, codes }]);
      return j({});
    }
    if (url.endsWith('/controls') && init.method === 'DELETE') { controls = []; return r(204, null); }
    if (url.endsWith('/controls')) return j({ actions: controls });
    if (url.endsWith('/leaderboards')) return j([{ id: 'lb-1', key: 'score' }]);
    if (url.startsWith('/api/v1/leaderboards/lb-1/entries')) return j({ items: [{ userId: 'user-other', score: 777, progressPct: 100, errors: 0, elapsedMs: 61000 }] });
    return r(404, '');
  };
  const u = new URL(href);
  const loc = { hash: u.hash, search: u.search, pathname: u.pathname, origin: u.origin, hostname: u.hostname, href };
  globalThis.location = loc;
  globalThis.window = { addEventListener() {} };
  globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
  globalThis.fetch = fetch;
  globalThis.StarHermit = SDK.create({ window: { location: loc, history: { replaceState() {} } }, fetch, setTimeout: () => 0, clearTimeout: () => {} });
  return { calls, saves, etags, kv, fetch, loc, controls: () => controls };
}

test('hosted: token, nickname, cloud save game:<slug>, settings, controls, board', async () => {
  const h = install(`https://pa-slug.starhermit.com/index.html#game_token=${TOKEN}&session_id=xyz`);
  const { Platform } = await import('../js/platform.js?hosted');
  const p = new Platform();
  assert.equal(p.hosted, true);
  assert.equal(p.userId, 'user-12345678-abcd');
  assert.equal(p.gameSlug, 'pa-slug');
  await p.init();
  assert.equal(p.profile.name, 'NeonFox');
  assert.ok(h.calls.every((c) => c.init.headers.Authorization === `Bearer ${TOKEN}`));

  const doc = { v: 1, rev: 3, data: { stats: { cellsFilled: 7 } } };
  p.cloudSaveSoon(doc);
  assert.equal(p.syncStatus, 'saving');
  assert.equal(await p.flushCloudSave(), true);
  assert.equal(p.syncStatus, 'synced');
  assert.deepEqual(Object.keys(h.saves), ['game:pa-slug']);
  assert.deepEqual(await p.cloudLoad(), doc);

  assert.deepEqual(await p.loadRemoteSettings(), { audio: { music: 0.2 }, 'ui.language': { choice: 'it-IT' } });
  await p.syncSettings({ audio: { music: 0.2 }, camera: { tilt: 1 }, 'ui.language': { choice: 'de-DE' } }); // ui.* never mirrored
  const patches = h.calls.filter((c) => c.method === 'PATCH');
  assert.deepEqual(patches.map((c) => JSON.parse(c.init.body)), [{ settings: { camera: { tilt: 1 } } }]);

  assert.deepEqual(await p.loadBindings({ undo: ['KeyU'], hint: ['KeyH'] }), { undo: ['KeyZ'], hint: ['KeyH'] });
  await p.saveBindings({ hint: ['KeyJ'] });
  assert.deepEqual(h.controls().find((c) => c.action === 'hint').codes, ['KeyJ']);
  await p.resetBindings();
  assert.deepEqual(h.controls(), []);

  const entries = await p.leaderboardEntries();
  assert.deepEqual(entries.map((e) => [e.name, e.score]), [['RivalOne', 777]]);
  assert.match(p.inviteLink(), /\/game-invite\/user-12345678-abcd\/pa-slug$/);
});

test('guest: no token → no request at all', async () => {
  const h = install('https://0b9d6f2e-3c4a-4e5b-9a7c-1d2e3f405162.starhermit.com/index.html');
  const { Platform } = await import('../js/platform.js?guest');
  const p = new Platform();
  await p.init();
  assert.equal(p.hosted, false);
  assert.equal(p.canSignIn(), true, 'sign-in offered on the hosted domain');
  assert.equal(p.inviteLink(), null);
  assert.equal(await p.cloudLoad(), null);
  p.cloudSaveSoon({ a: 1 });
  assert.deepEqual(await p.loadRemoteSettings(), {});
  assert.equal(await p.syncSettings({ a: 1 }), null);
  assert.deepEqual(await p.loadBindings({ undo: ['KeyU'] }), { undo: ['KeyU'] });
  assert.equal(await p.leaderboardEntries(), null);
  const info = await p.dailyInfo();
  assert.equal(info.seed, `daily:${info.date}`);
  assert.equal(h.calls.length, 0);
});

test('standalone on localhost: no own-server request (time/daily/presence/activity)', async () => {
  const h = install('http://localhost:8080/index.html');
  const { Platform } = await import('../js/platform.js?localhost');
  const p = new Platform();
  await p.init();
  assert.equal(p.hosted, false);
  const info = await p.dailyInfo();
  assert.equal(info.seed, `daily:${info.date}`);
  assert.ok(Math.abs(p.now() - Date.now()) < 50);
  assert.equal(h.calls.length, 0);
});

test('hosted: a save that lost to another device reloads and the merged copy saves on top', async () => {
  const h = install(`https://x.test/index.html#game_token=${TOKEN}`);
  const { Platform } = await import('../js/platform.js?conflict');
  const { mergeSaveData, defaultSaveData } = await import('../js/storage.js');
  const p = new Platform();
  await p.init();
  assert.equal(await p.cloudLoad(), null); // empty slot → next write is If-None-Match: *
  const other = SDK.create({ window: { location: h.loc, history: { replaceState() {} } }, fetch: h.fetch, setTimeout: () => 0, clearTimeout: () => {} });
  other.init();
  const remoteData = defaultSaveData();
  remoteData.journey.stars = { j2: 3 };
  remoteData.achievements = { 'first-completion': 100 };
  remoteData.stats.cellsFilled = 900;
  assert.equal(await other.writeSave(JSON.stringify({ v: 1, rev: 9, data: remoteData })), true);
  const localData = defaultSaveData();
  localData.journey.stars = { j1: 2, j2: 1 };
  localData.stats.cellsFilled = 50;
  localData.settings.audio.music = 0.33;
  const got = new Promise((resolve) => { p.onSaveConflict = resolve; });
  p.cloudSaveSoon({ v: 1, rev: 2, data: localData });
  assert.equal(await p.flushCloudSave(), false);
  const remote = await got;
  assert.equal(remote.rev, 9);
  const merged = mergeSaveData(remote.data, localData);
  assert.deepEqual(merged.journey.stars, { j2: 3, j1: 2 });
  assert.equal(merged.stats.cellsFilled, 900);
  assert.equal(merged.settings.audio.music, 0.33); // this device's settings on a conflict
  assert.deepEqual(Object.keys(merged.achievements), ['first-completion']);
  p.cloudSaveSoon({ v: 1, rev: 10, data: merged });
  assert.equal(await p.flushCloudSave(), true);
});
