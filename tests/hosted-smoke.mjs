// Throwaway hosted-mode smoke test (not shipped): boots the real game in
// headless Chrome with a #game_token= fragment against a mock platform API.
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `e30.${b64url({ sub: 'u-1234-abcd', game_scope: 'pixel-atelier' })}.sig`;

const calls = [];
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    calls.push(`${req.method} ${u.pathname}${u.search} auth=${req.headers.authorization || '-'}`);
    const j = (code, body, type = 'application/json') => {
      const data = type === 'application/json' ? JSON.stringify(body) : body;
      res.writeHead(code, { 'Content-Type': type }); res.end(data);
    };
    if (u.pathname === '/api/v1/users/u-1234-abcd/profile') return j(200, { id: 'u-1234-abcd', username: 'secret_username', nickname: 'NeonFox' });
    if (u.pathname === '/api/v1/time') return j(200, { now: Date.now() });
    if (u.pathname === '/api/v1/daily') return j(200, { date: new Date().toISOString().slice(0, 10), seed: 'daily:x', version: 1, excluded: false });
    if (['/api/v1/presence', '/api/v1/activity', '/api/v1/telemetry', '/api/v1/achievements', '/api/v1/scores'].includes(u.pathname)) return j(200, { ok: true });
    if (u.pathname === '/api/v1/me/cloud-saves/pixel-atelier' && req.method === 'GET') return j(404, { error: 'not-found' });
    if (u.pathname === '/api/v1/me/cloud-saves/pixel-atelier' && req.method === 'PUT') return j(200, { ok: true });
    if (u.pathname === '/api/v1/games/pixel-atelier') return j(200, { leaderboardId: 'lb-1' });
    if (u.pathname === '/api/v1/leaderboards/lb-1/entries') return j(200, { entries: [{ userId: 'u-1234-abcd', score: 1234, progressPct: 100, errors: 0, elapsedMs: 65000 }] });
    return j(404, { error: 'not-found' });
  }
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/index.html';
  try {
    const data = await readFile(path.join(ROOT, p));
    res.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' });
    res.end(data);
  } catch { res.writeHead(404).end('nf'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'] });
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return; // expected 404 probes
    errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${BASE}/index.html#game_token=${JWT}&session_id=zzz`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__app?.appState === 'title', null, { timeout: 20000 });

  const state = await page.evaluate(() => ({
    hosted: window.__app.platform.hosted,
    userId: window.__app.platform.userId,
    slug: window.__app.platform.gameSlug,
    hash: location.hash,
    name: window.__app.store.data.profile.name,
    syncStatus: window.__app.platform.syncStatus,
  }));
  console.log('state:', JSON.stringify(state));
  if (!state.hosted || state.userId !== 'u-1234-abcd' || state.slug !== 'pixel-atelier') throw new Error('token decode/hosted wrong');
  if (state.hash !== '#session_id=zzz') throw new Error('fragment not stripped correctly: ' + state.hash);
  if (state.name !== 'NeonFox') throw new Error('nickname not adopted: ' + state.name);

  // Read-only platform board with nickname resolution.
  await page.click('#btn-boards');
  await page.waitForSelector('#screen-board:not([hidden])');
  await page.waitForFunction(() => /NeonFox/.test(document.getElementById('board-list').textContent), null, { timeout: 5000 });
  const boardText = await page.textContent('#board-list');
  const note = await page.textContent('#board-note');
  if (/secret_username/.test(boardText)) throw new Error('username leaked to board!');
  console.log('board note:', note, '| row:', boardText.trim());

  // Profile screen shows the sync status slot.
  await page.click('#screen-board [data-nav="title"]');
  await page.waitForSelector('#screen-title:not([hidden])');
  await page.click('#btn-profile');
  await page.waitForSelector('#screen-profile:not([hidden])');
  console.log('profile-sync:', (await page.textContent('#profile-sync')).trim());

  // Complete a round → debounced cloud PUT fires with Bearer + {dataBase64}.
  await page.evaluate(() => {
    const app = window.__app;
    app.openMode('practice');
  });
  await page.waitForSelector('#screen-setup:not([hidden])');
  await page.selectOption('#practice-preset', 'calm');
  await page.click('#btn-setup-start');
  await page.waitForFunction(() => window.__app?.session?.status === 'active', null, { timeout: 20000 });
  await page.evaluate(() => {
    const app = window.__app;
    const s = app.session.state;
    for (let i = 0; i < s.targets.length; i++) {
      if (!s.filled[i]) { app.session.select(s.targets[i]); app.session.fill(i, s.targets[i], 'brush'); }
    }
  });
  await page.waitForFunction(() => window.__app?.appState === 'results', null, { timeout: 15000 });
  const t0 = Date.now();
  while (!calls.some((c) => c.startsWith('PUT /api/v1/me/cloud-saves/pixel-atelier')) && Date.now() - t0 < 8000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!calls.some((c) => c.startsWith('PUT /api/v1/me/cloud-saves/pixel-atelier'))) throw new Error('cloud PUT never fired');
  console.log('cloud PUT observed after round end');

  if (errors.length) throw new Error('page errors:\n  ' + errors.join('\n  '));
  console.log('\nHOSTED SMOKE PASS');
  console.log('api calls:'); for (const c of calls) console.log('  ', c);
} catch (e) {
  console.error('HOSTED SMOKE FAIL:', e.message);
  console.error('api calls:'); for (const c of calls) console.log('  ', c);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
