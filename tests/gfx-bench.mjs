// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts a Standard practice board and keeps painting correct cells — choosing the colour with the visible
// palette swatch and clicking the cell on the 3D canvas — retrying from the results screen, so cells rise,
// glow, burst and the holo ring / floating pixels / dust animate the whole time.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.__app?.appState === 'title', null, { timeout: 30000 });
  await page.click('#btn-settings');
  await page.waitForSelector('#screen-settings:not([hidden]) #gfx-panel #set-tier');
  await page.selectOption('#set-tier', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#screen-settings [data-nav="title"]');
  await page.waitForSelector('#screen-title:not([hidden])');
}

// Screen point of every cell, sampled through the renderer's own picking (like the e2e test).
const buildMap = (page) => page.evaluate(() => {
  const r = window.__app?.renderer, s = window.__app?.session?.state;
  if (!r?.screenToCell || !s) return false;
  const rect = document.querySelector('#gl, #flat').getBoundingClientRect();
  const acc = new Map();
  for (let y = rect.top; y < rect.bottom; y += 6) for (let x = rect.left; x < rect.right; x += 6) {
    const c = r.screenToCell(x, y);
    if (c >= 0) { const a = acc.get(c) || { x: 0, y: 0, n: 0 }; a.x += x; a.y += y; a.n++; acc.set(c, a); }
  }
  window.__benchMap = {};
  for (const [c, a] of acc) window.__benchMap[c] = { x: a.x / a.n, y: a.y / a.n };
  return acc.size;
});

const next = (page) => page.evaluate(() => {
  if (!document.getElementById('screen-results')?.hidden) return { results: true };
  const s = window.__app?.session?.state;
  if (window.__app?.session?.status !== 'active' || !s) return {};
  for (let i = 0; i < s.targets.length; i++) {
    if (s.filled[i] !== 1) {
      const pt = window.__benchMap?.[i];
      if (pt && window.__app.renderer.screenToCell(pt.x, pt.y) === i) return { i, color: s.targets[i], pt };
      return { remap: true };
    }
  }
  return {};
});

async function step(page) {
  const m = await next(page);
  if (m.results) {
    await page.click('#btn-results-retry', { timeout: 3000 });
    await page.waitForTimeout(1500);
    return buildMap(page);
  }
  if (m.remap) return buildMap(page);
  if (m.i == null) return;
  await page.locator('#hud-palette .swatch').nth(m.color).click({ timeout: 2000 });
  await page.mouse.click(m.pt.x, m.pt.y);
}

export async function start(page) {
  await page.click('#btn-practice');
  await page.waitForSelector('#screen-setup:not([hidden])');
  await page.click('#btn-setup-start');
  await page.waitForFunction(() => window.__app?.session?.status === 'active', null, { timeout: 20000 });
  await page.waitForTimeout(2500); // intro camera settles
  await buildMap(page);
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(200).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
