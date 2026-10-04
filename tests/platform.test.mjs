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
  const kv = { audio: { music: 0.2 } };
  let controls = [{ action: 'undo', codes: ['KeyZ'] }];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', init });
    const r = (status, body) => new Response(body, { status });
    const j = (o) => r(200, JSON.stringify(o));
    if (url === '/api/v1/users/user-12345678-abcd/profile') return j({ username: 'ignore_me', nickname: 'NeonFox' });
    if (url === '/api/v1/users/user-other/profile') return j({ nickname: 'RivalOne' });
    if (url.includes('/cloud-saves/')) {
      const key = decodeURIComponent(url.split('/cloud-saves/')[1]);
      if (init.method === 'PUT') { saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return j({}); }
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
  return { calls, saves, kv, controls: () => controls };
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

  assert.deepEqual(await p.loadRemoteSettings(), { audio: { music: 0.2 } });
  await p.syncSettings({ audio: { music: 0.2 }, camera: { tilt: 1 } });
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
  const h = install('https://pa-slug.starhermit.com/index.html');
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
