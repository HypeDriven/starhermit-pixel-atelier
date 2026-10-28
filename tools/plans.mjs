// Shared by tools/gen-plays.mjs and tools/browser-play.mjs: render.ts's camera fit projected by hand (a cell's
// centre on the board plane in logical / CSS pixels), the phone HUD's rectangles to avoid, and the board's
// unfilled regions per color.
import * as rules from '../js/rules.js';

// ---------------------------------------------------------------- render.ts camera (fitCamera + update)
const FOV = 32, ELEV = 0.76;
export function projector(w, h, cw, ch) {
  const aspect = w / h, ext = Math.max(cw, ch);
  const fitV = (ext * 1.62) / (2 * Math.tan((FOV * Math.PI / 180) / 2));
  const dist = Math.min(60, Math.max(6, Math.max(fitV, aspect < 1 ? fitV / Math.max(aspect, 0.4) * 1.05 : fitV)));
  const pos = [0, dist * Math.sin(ELEV), dist * Math.cos(ELEV) * 0.55];
  const len = Math.hypot(...pos);
  const f = pos.map((v) => -v / len);
  let r = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0]; // f × up
  const rl = Math.hypot(...r); r = r.map((v) => v / rl);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const t = Math.tan((FOV * Math.PI / 180) / 2);
  return (cell) => {
    const x = (cell % cw) - (cw - 1) / 2, z = Math.floor(cell / cw) - (ch - 1) / 2;
    const v = [x - pos[0], 0.01 - pos[1], z - pos[2]];
    const xc = v[0] * r[0] + v[1] * r[1] + v[2] * r[2], yc = v[0] * u[0] + v[1] * u[1] + v[2] * u[2], zc = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
    return { x: ((xc / (zc * t * aspect)) + 1) / 2 * w, y: (1 - yc / (zc * t)) / 2 * h };
  };
}
/** The phone HUD's rectangles (logical px) a touch must avoid: top bar and lesson strip, drawer tabs, tray. */
export function safeOnPhone(p, w, h) {
  if (p.y < 120 || p.y > h - 100) return false;
  if ((p.x < 50 || p.x > w - 50) && p.y > h / 2 - 45 && p.y < h / 2 + 45) return false;
  return p.x > 8 && p.x < w - 8;
}
export const fmt = (n) => n.toFixed(1);

// ---------------------------------------------------------------- shared: regions per color
export function regions(state) {
  const seen = new Set(), list = [];
  for (let i = 0; i < state.targets.length; i++) {
    if (state.filled[i] || seen.has(i)) continue;
    const reg = rules.regionAt(state, i);
    for (const c of reg) seen.add(c);
    list.push({ color: state.targets[i], cells: reg });
  }
  return list.sort((a, b) => a.color - b.color || a.cells[0] - b.cells[0]);
}

