/**
 * Pixel Atelier — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the REAL visible UI in headless Chrome via playwright-core:
 *   boot → title → Practice → Calm (10×10) → paint every cell on the
 *   on-screen drafting table (selecting palette swatches and clicking /
 *   tapping the actual canvas cells) until the board is complete → the
 *   Results screen ("Canvas complete!") with score breakdown + persisted
 *   progress. Also exercises pause/resume, Undo and Hint through the
 *   visible HUD buttons, and runs a shorter load → practice → tap-a-few
 *   pass on a mobile touch viewport.
 *
 * Painting is a real input path: the game raycasts the interactive canvas
 * (the Three.js drafting table, or the 2D compatibility renderer) in
 * `onPointerDown`, maps the pointer to a cell via `renderer.screenToCell`
 * and fills it through the session's own `fill()` command. The palette
 * swatches are real `<button class="swatch">` elements whose click reaches
 * `session.select(idx)`.
 *
 * The test reads `window.__app` (the game's own exposed debug/validation
 * handle, main.js: `window.__app = app`) ONLY to observe rules state
 * (which cell still needs which color — the same knowledge the player gets
 * from the palette counts) and to derive the on-screen pixel of a cell
 * (`renderer.cellToScreen`). It never calls the game's move API to perform
 * a move: every fill is a real click/tap on a real palette swatch and a
 * real pointer event on the canvas. No game code is modified.
 *
 * Serving: the repo ships `server.js` (the StarHermit authoritative script
 * declared by starhermit.txt), but the game is fully playable offline —
 * when `/api/v1/time` is unavailable, `Platform.init` sets `hosted=false`
 * and every screen works in guest mode (platform.js). So, like the sibling
 * static-SPA tests, this embeds a minimal node:http static server on an
 * ephemeral port and answers /api/* probes with 200 `{}`; the client
 * degrades to its documented offline path with zero console noise. If the
 * UI ever required the real backend this could be swapped for spawning
 * `server.js`; today it is not needed.
 *
 * Run: npm run test:e2e   (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/pixel-atelier-e2e-${stage}-${vp}.png`;

// benign GPU / swiftshader noise
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions|swiftshader/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// ---------- read-only observation of the game's own handle ----------

// window.__app is the game's validation/debug handle (main.js). Read only:
// rules state (solution + fills) to pick the next legal color/cell, and the
// renderer's cellToScreen to derive where a real canvas click must land.
const readState = (page) => page.evaluate(() => {
  const app = window.__app;
  const s = app?.session?.state;
  if (!s) return null;
  return {
    appState: app.appState,
    status: s.status,
    w: s.w, h: s.h,
    selected: s.selected,
    targets: s.targets.slice(),
    filled: s.filled.slice(),
    stats: { ...s.stats },
    kind: app.renderer?.kind,
    hasRenderer: !!app.renderer,
  };
});

// Pick the next unfilled cell by scanning the board. Returns its index.
const nextUnfilled = (st) => {
  for (let i = 0; i < st.targets.length; i++) if (!st.filled[i]) return i;
  return -1;
};

const waitActive = (page) =>
  page.waitForFunction(() => window.__app?.session?.status === 'active', null, { timeout: 20000 });

// The 3D camera fits the board with a critically damped spring (smoothTime
// 0.3s in render.js), so the board can still be gliding when the round first
// becomes active. The cell→pixel map is only valid once that spring settles,
// so wait here and keep the build stable.
async function waitCameraSettled(page) {
  await page.waitForFunction(() => {
    const app = window.__app;
    const cm = app?.renderer?.cameraMode;
    if (!cm) return true; // 2D renderer has no camera spring
    const posErr = Math.abs(cm.x - cm.tx) + Math.abs(cm.z - cm.tz) + Math.abs(cm.d - cm.dist);
    const vel = Math.abs(cm.vx) + Math.abs(cm.vz) + Math.abs(cm.vd);
    return posErr < 0.01 && vel < 0.01;
  }, null, { timeout: 12000 });
}

// Build a per-cell → on-screen-pixel map once per round. The game maps a
// real pointer down to a cell via `renderer.screenToCell` (a ray against the
// drafting-table plate), so we scan the canvas for each cell's screen region
// and take its centroid — that is exactly the pixel a real click hits to
// paint that cell through the game's own handler. The map is stable because
// the plate geometry (and the camera) do not change while filling. Each
// centroid is re-verified (screenToCell(point) === cell) so a stale map is
// detected and rebuilt rather than silently painting a wrong cell.
async function buildCellMap(page) {
  await waitCameraSettled(page);
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await page.evaluate(() => {
      const r = window.__app?.renderer;
      if (!r || typeof r.screenToCell !== 'function') return null;
      const s = window.__app?.session?.state;
      if (!s) return null;
      const canvas = document.querySelector('#gl, #flat');
      const rect = canvas.getBoundingClientRect();
      const acc = new Map(); // cell -> {sx, sy, n}
      const left = rect.left, top = rect.top, W = rect.width, H = rect.height;
      for (let y = top; y < top + H; y += 6) {
        for (let x = left; x < left + W; x += 6) {
          const c = r.screenToCell(x, y);
          if (c >= 0) {
            const a = acc.get(c) || { sx: 0, sy: 0, n: 0 };
            a.sx += x; a.sy += y; a.n++;
            acc.set(c, a);
          }
        }
      }
      const total = s.w * s.h;
      if (acc.size < total) return { incomplete: true, found: acc.size, total };
      const map = new Array(total).fill(null);
      for (const [c, a] of acc) map[c] = { x: a.sx / a.n, y: a.sy / a.n };
      // verify every centroid re-maps to its own cell
      for (let i = 0; i < total; i++) {
        if (r.screenToCell(map[i].x, map[i].y) !== i) return { incomplete: true, found: acc.size, total };
      }
      return { map };
    });
    if (res?.map) return res.map;
    await page.waitForTimeout(250);
  }
  throw new Error('cell map could not be rendered reliably (camera did not settle)');
}

// The game pops transient toasts (e.g. the Hint toast, ~2.6s) that sit over
// the canvas and intercept a click. Before solving, wait for them to clear.
async function clearToasts(page) {
  await page.waitForFunction(() => {
    const el = document.getElementById('toast');
    return !el || el.hidden;
  }, null, { timeout: 6000 });
}

// Paint cell `i` for real: select its required color via the visible palette
// swatch, then click the actual canvas pixel for that cell. Retries a few
// times if a transient overlay (toast) is covering the pixel at that moment.
async function paintCell(page, cellMap, i) {
  if (!cellMap[i]) throw new Error(`no click point for cell ${i}`);
  for (let attempt = 0; attempt < 5; attempt++) {
    const st = await readState(page);
    const color = st.targets[i];
    // Select the required color via the visible palette swatch (index = color).
    await page.locator('#hud-palette .swatch').nth(color).click();
    const pt = cellMap[i];
    // Only paint when the pixel really lands on the interactive canvas; a
    // transient toast/overlay would swallow the event and register as a no-op.
    const onCanvas = await page.evaluate((pt) => {
      const el = document.elementFromPoint(pt.x, pt.y);
      return !!(el && (el.id === 'gl' || el.id === 'flat'));
    }, pt);
    if (!onCanvas) { await page.waitForTimeout(400); continue; }
    await page.evaluate((p) => { window.__dbgPt = p; }, pt);
    await page.mouse.click(pt.x, pt.y);
    try {
      await page.waitForFunction((i) => {
        const s = window.__app?.session?.state;
        return s && s.filled[i] === 1;
      }, i, { timeout: 3000 });
      return;
    } catch {
      // fall through to retry
    }
  }
  const diag = await page.evaluate((i) => {
    const app = window.__app; const r = app.renderer; const s = app.session.state;
    const el = document.elementFromPoint(window.__dbgPt?.x ?? 0, window.__dbgPt?.y ?? 0);
    return {
      i, pt: window.__dbgPt, status: s.status, selected: s.selected, target: s.targets[i],
      filled: s.filled[i], correct: s.stats.correct, errors: s.stats.errors,
      mapBack: r.screenToCell(window.__dbgPt?.x ?? 0, window.__dbgPt?.y ?? 0),
      elemAtPt: el ? `${el.id || el.tagName}` : null,
    };
  }, i);
  throw new Error(`fill of cell ${i} did not register: ${JSON.stringify(diag)}`);
}

// Paint the next unfilled cell (used by the undo sanity check).
async function paintNextCell(page, cellMap, st) {
  const cell = nextUnfilled(st);
  if (cell < 0) throw new Error('no unfilled cell but round not terminal');
  await paintCell(page, cellMap, cell);
}

async function startCalmPractice(page) {
  await page.click('#btn-practice');
  await page.waitForSelector('#screen-setup:not([hidden])');
  // choose the Calm preset (10×10, smallest) so the full solve is fast
  await page.selectOption('#practice-preset', 'calm');
  await page.click('#btn-setup-start');
  await waitActive(page);
  await page.waitForFunction(() => {
    const s = window.__app?.session?.state;
    return s && (s.w * s.h) === 100;
  }, null, { timeout: 10000 });
}

// ---------- one full pass ----------
async function runPass(browser, name, ctxOpts, { full }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  try {
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title:not([hidden])', { timeout: 20000 });
    await page.waitForFunction(() => !!window.__app && window.__app.appState === 'title');
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: title screen visible (appState=${(await page.evaluate(() => window.__app.appState))})`);
    await page.click('#btn-boards');
    await page.waitForSelector('#screen-board:not([hidden])');
    if (!/Score Chase/.test(await page.textContent('#board-sub'))) throw new Error('weekly board missing');
    await page.click('#screen-board [data-nav="title"]');
    await page.waitForSelector('#screen-title:not([hidden])');
    await page.waitForFunction(() => window.__app.audio._music?.step > 0);
    const musicStep = await page.evaluate(() => window.__app.audio._music.step);
    await page.waitForFunction(step => window.__app.audio._music.step > step, musicStep);
    const caption = await page.evaluate(() => {
      const app = window.__app;
      app.audio.setMuted(true);
      app.audio.play('complete');
      const text = document.querySelector('#captions').textContent;
      app.audio.setMuted(false);
      return text;
    });
    if (!/Canvas complete/.test(caption)) throw new Error('muted caption missing');

    if (full) {
      await startCalmPractice(page);
      const st0 = await readState(page);
      if (st0.w !== 10 || st0.h !== 10) throw new Error(`expected 10×10 calm practice, got ${st0.w}×${st0.h}`);
      if (st0.stats.errors !== 0) throw new Error('unexpected starting errors');
      await page.screenshot({ path: SHOT('play', name) });
      ok(`${name}: practice board active (${st0.w}×${st0.h}, cells=${st0.targets.length}, renderer=${st0.kind})`);

      // Build the real click map (one screen pixel per cell) once.
      const cellMap = await buildCellMap(page);

      // pause / resume via the visible HUD buttons
      await page.click('#btn-hud-pause');
      await page.waitForSelector('#overlay-pause:not([hidden])');
      await page.screenshot({ path: SHOT('pause', name) });
      await page.click('#btn-resume');
      await page.waitForFunction(() => window.__app?.session?.status === 'active');
      ok(`${name}: pause and resume work`);

      // hint via the visible Hint button (increments the hint counter)
      const beforeHint = await readState(page);
      await page.click('#btn-hint');
      await page.waitForFunction((n) => (window.__app?.session?.state?.stats?.hints ?? 0) > n, beforeHint.stats.hints, { timeout: 3000 });
      const afterHint = await readState(page);
      if (afterHint.stats.hints !== beforeHint.stats.hints + 1) throw new Error('hint did not increment');
      ok(`${name}: hint button works (hints ${beforeHint.stats.hints}→${afterHint.stats.hints})`);

      // undo via the visible Undo button: do one real fill then undo it to
      // prove undo works. (We undo the fill, not the hint; the hint only
      // broadcasts where to paint and does not change board state.)
      await paintNextCell(page, cellMap, afterHint);
      const afterFill = await readState(page);
      if (afterFill.stats.correct < afterHint.stats.correct + 1) throw new Error('fill did not register');
      await page.click('#btn-undo');
      await page.waitForFunction((n) => (window.__app?.session?.state?.stats?.correct ?? -1) < n, afterFill.stats.correct, { timeout: 3000 });
      const afterUndo = await readState(page);
      if (afterUndo.stats.correct !== afterHint.stats.correct) throw new Error('undo did not restore');
      ok(`${name}: paint → undo restores the previous board state`);

      // solve the whole calm board for real on the visible table
      await clearToasts(page);
      let st = await readState(page);
      for (let guard = 0; guard < 512; guard++) {
        st = await readState(page);
        if (!st) throw new Error('state handle missing while solving');
        if (st.status === 'complete') break;
        if (st.status === 'failed' || st.status === 'abandoned') throw new Error('round ended early: ' + st.status);
        if (st.stats.errors > 0) throw new Error('a wrong fill produced an error');
        const cell = nextUnfilled(st);
        await paintCell(page, cellMap, cell);
        // avoid touching any wrong cell; error-prevention keeps us clean
        st = await readState(page);
        if (st.status === 'complete') break;
      }
      st = await readState(page);
      if (st.status !== 'complete') throw new Error('board did not complete: ' + st.status);

      // results screen
      await page.waitForSelector('#screen-results:not([hidden])', { timeout: 10000 });
      const headline = (await page.textContent('#results-headline')) || '';
      if (!/Canvas complete/i.test(headline)) throw new Error(`unexpected results headline: "${headline}"`);
      const tableRows = await page.locator('#results-table tr').count();
      if (tableRows < 1) throw new Error('score breakdown table is empty');
      const progressText = (await page.textContent('#results-progress')) || '';
      if (!/100% painted/.test(progressText)) throw new Error(`unexpected progress line: "${progressText}"`);
      await page.screenshot({ path: SHOT('results', name) });
      ok(`${name}: canvas solved on the visible table — results shown ("${headline}", ${tableRows} score rows)`);

      // persistence: first-completion achievement + progress persisted
      const progress = await page.evaluate(() => {
        const raw = localStorage.getItem('pixelatelier.save.v1');
        return raw ? JSON.parse(raw).data?.stats : null;
      });
      if (!progress || !(progress.roundsCompleted > 0)) throw new Error('completion not persisted: ' + JSON.stringify(progress));
      ok(`${name}: progress persisted (roundsCompleted: ${progress.roundsCompleted})`);
      await page.click('#btn-results-board');
      await page.waitForSelector('#screen-board:not([hidden])');
      if (!/100%/.test(await page.textContent('#board-list'))) throw new Error('completed round missing from board');
    } else {
      // mobile: load → practice → tap a few real cells via touchscreen.tap
      await startCalmPractice(page);
      const cellMap = await buildCellMap(page);
      let tapped = 0;
      const st0 = await readState(page);
      for (let i = 0; i < 3; i++) {
        const st = await readState(page);
        const cell = nextUnfilled(st);
        if (cell < 0) break;
        const color = st.targets[cell];
        await page.locator('#hud-palette .swatch').nth(color).tap();
        const pt = cellMap[cell];
        await page.touchscreen.tap(pt.x, pt.y);
        await page.waitForFunction((i) => {
          const s = window.__app?.session?.state;
          return s && s.filled[i] === 1;
        }, cell, { timeout: 3000 });
        tapped++;
      }
      const stFinal = await readState(page);
      if (stFinal.stats.correct < tapped) throw new Error(`expected >=${tapped} filled, got ${stFinal.stats.correct}`);
      await page.screenshot({ path: SHOT('mobile-play', name) });
      ok(`${name}: started practice and painted ${tapped} cells via touchscreen.tap`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false });
  console.log('\nE2E PASS — pixel-atelier, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);
