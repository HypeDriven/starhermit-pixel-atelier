// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3): on the desktop Journey stage 1 is
// solved by keys (swatch numbers, the region tool, the cursor and Enter) to its
// results, with a pause by Escape; on the phone lesson 1 is played by finger
// (a swatch, the Region tool from the drawer, cells tapped at their projected
// centres, tools/plans.mjs) to its results; sideways the Score Chase table is
// started, a cell painted with a swipe, paused and left. Widgets are found
// through the page's accessibility mirror of the engine's UI. Screenshots of
// each step go to --shots. Fails on console errors or warnings, the runtime's
// error screen, or a view that does not finish.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();
const { JOURNEY, lessonContent, scoreChaseContent } = await import('../js/content.js');
const { Session } = await import('../js/session.js');
const rules = await import('../js/rules.js');
const { projector, safeOnPhone, regions } = await import('./plans.mjs');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const views = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000);
  const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${name}.png`) }); } };
  const find = (name) => page.getByRole('button', { name, exact: true }).or(page.getByRole('checkbox', { name, exact: true })).or(page.getByRole('radio', { name, exact: false })).or(page.getByText(name, { exact: true })).first();
  /** A tap / click at window coordinates (CSS px). */
  const tapAt = async (x, y) => {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  const results = async () => { await page.getByText('Total', { exact: true }).first().waitFor({ timeout: 60000 }); await page.getByText('Canvas complete!').first().waitFor({ timeout: 5000 }); await page.waitForTimeout(600); };
  const key = async (code) => { await page.keyboard.press(code); await page.waitForTimeout(60); };
  const roundStarted = async () => { await page.getByText('0:00', { exact: true }).first().waitFor({ timeout: 60000 }); await page.waitForTimeout(1200); };
  /** A press on a widget (or a table target): the mouse on the desktop, a finger on the phones. */
  const press = async (name) => {
    const el = find(name);
    await el.waitFor({ timeout: 15000 });
    const b = await el.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  let reached = false;
  try {
    await shot('title');
    if (v.name === 'desktop') {
      await press('Play');
      await press('Start');
      await roundStarted();
      await shot('journey-1');
      const s = new Session(JOURNEY[0]); s.start();
      await key('KeyR');
      let kc = -1;
      for (const reg of regions(s.state)) {
        if (s.state.filled[reg.cells[0]]) continue;
        await key(`Digit${reg.color}`); s.select(reg.color);
        if (kc < 0) { await key('ArrowRight'); const la = rules.legalActions(s.state); kc = la.colors.find((c) => c.color === s.state.selected)?.sample ?? la.colors[0].sample; }
        const w = s.state.w, t = reg.cells[0];
        let dx = (t % w) - (kc % w), dy = Math.floor(t / w) - Math.floor(kc / w);
        while (dx) { await key(dx > 0 ? 'ArrowRight' : 'ArrowLeft'); dx -= Math.sign(dx); }
        while (dy) { await key(dy > 0 ? 'ArrowDown' : 'ArrowUp'); dy -= Math.sign(dy); }
        kc = t;
        await key('Enter');
        s.fill(t, reg.color, 'region');
        if (s.state.stats.correct > 60 && s.state.stats.correct < 100) await shot('journey-1-half');
      }
      await results();
      await shot('journey-1-results');
      await press('Next stage');
      await press('Start');
      await roundStarted();
      await page.keyboard.press('Escape');
      await find('Resume').waitFor({ timeout: 15000 });
      await shot('pause');
      await press('Resume');
    } else if (v.name === 'phone') {
      await press('Learn');
      await press('1. Color & Fill');
      await roundStarted();
      await shot('lesson-1');
      const { content } = lessonContent('learn-1');
      const s = new Session(content); s.start();
      const proj = projector(v.viewport.width, v.viewport.height, content.width, content.height);
      let tool = 'brush';
      const order = regions(s.state).sort((a, b) => (a.color === 1 ? -1 : 0) - (b.color === 1 ? -1 : 0));
      let cur = -1;
      for (const reg of order) {
        if (s.state.filled[reg.cells[0]]) continue;
        if (reg.color !== cur) { await press(reg.color ? `Color ${reg.color},` : 'Color background,'); s.select(reg.color); cur = reg.color; }
        if (tool !== 'region') { await press('Open tools panel'); await press('Region'); tool = 'region'; }
        const p = reg.cells.map(proj).find((q) => safeOnPhone(q, v.viewport.width, v.viewport.height));
        await tapAt(p.x, p.y);
        s.fill(reg.cells[0], reg.color, 'region');
        if (s.state.stats.correct > 10 && s.state.stats.correct < 30) await shot('lesson-1-painting');
      }
      await results();
      await shot('lesson-1-results');
    } else {
      await press('Score Chase');
      await press('Start chase');
      await roundStarted();
      const content = scoreChaseContent('2026-W01');
      const proj = projector(v.viewport.width, v.viewport.height, content.width, content.height);
      await press('Color 1,');
      // a finger stroke across the board's middle row (the brush paints the cells that want color 1)
      const row = Math.floor(content.height / 2) * content.width;
      const a = proj(row + 3), b = proj(row + content.width - 4);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y, id: 1 }] });
      for (let k = 1; k <= 10; k++) {
        await page.waitForTimeout(30);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + (b.x - a.x) * k / 10, y: a.y + (b.y - a.y) * k / 10, id: 1 }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(800);
      await shot('chase-stroke');
      await press('Pause');
      await find('Resume').waitFor({ timeout: 15000 });
      await shot('pause');
      await press('Leave round');
      await press('Confirm');
      await page.getByText('Paint the table. Reveal the art.').first().waitFor({ timeout: 15000 });
    }
    reached = true;
  } catch (e) { problems.push(`play: ${String(e.message || e).split('\n')[0]}`); await shot('failed'); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && reached;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} played=${reached}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
