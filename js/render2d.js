// render2d.js — canvas fallback renderer implementing the same interface as
// render.js. Used when WebGL is unavailable; keeps the full game playable
// and legible (the no-3D compatibility path).

export function createRenderer2D(canvas, opts = {}) {
  return new FlatRenderer(canvas, opts);
}

class FlatRenderer {
  constructor(canvas, opts) {
    this.kind = '2d';
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.onCameraChange = null;
    this.theme = null;
    this.reducedMotion = false;
    this.cellLabels = false;
    this.tier = 'low';
    this.content = null;
    this.palette = [];
    this.cells = [];
    this.ghostCells = new Set();
    this.hoverCell = -1;
    this.keyboardCell = -1;
    this.selectedColor = -1;
    this.cam = { x: 0, y: 0, scale: 24, tx: 0, ty: 0, tscale: 24 };
    this.anims = [];
    this.time = 0;
    this.hidden = false;
    this._dpr = 1;
  }

  setTheme(theme) { this.theme = theme; }
  setQuality() { /* 2D path is already the low tier */ }
  setRenderScale() {}
  setReducedMotion(v) { this.reducedMotion = v; }
  setCellLabels(v) { this.cellLabels = v; }

  setBoard(content, palette) {
    this.content = content;
    this.palette = palette;
    this.w = content.width;
    this.h = content.height;
    this.cells = content.targets.map(() => ({ filled: false, wrong: 0, rise: 0 }));
    this.anims = [];
    this.fitCamera(true);
  }

  syncState(state) {
    for (let i = 0; i < state.targets.length; i++) {
      this.cells[i].filled = state.filled[i] === 1;
      this.cells[i].wrong = state.wrong[i];
      this.cells[i].rise = this.cells[i].filled ? 1 : 0;
    }
    this.selectedColor = state.selected;
  }

  applyEvents(events, state) {
    for (const ev of events) {
      if (ev.type === 'fill' || ev.type === 'undo' || ev.type === 'error') {
        for (const i of ev.cells || []) {
          this.cells[i].filled = state.filled[i] === 1;
          this.cells[i].wrong = state.wrong[i];
          if (this.reducedMotion) this.cells[i].rise = this.cells[i].filled ? 1 : 0;
          else this.anims.push({ cell: i, t: 0 });
        }
      }
      if (ev.type === 'select') this.selectedColor = ev.color;
      if (ev.type === 'terminal' && ev.status === 'complete' && !this.reducedMotion) {
        for (let i = 0; i < this.cells.length; i++) this.anims.push({ cell: i, t: -0.3 - Math.random() * 0.3 });
      }
    }
  }

  settle() {
    for (const c of this.cells) c.rise = c.filled ? 1 : 0;
    this.anims = [];
  }

  _cellPos(i) {
    return { x: (i % this.w) - (this.w - 1) / 2, y: Math.floor(i / this.w) - (this.h - 1) / 2 };
  }

  _toScreen(wx, wy) {
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    return {
      x: cw / 2 + (wx - this.cam.x) * this.cam.scale,
      y: ch / 2 + (wy - this.cam.y) * this.cam.scale * 0.82, // slight oblique tilt
    };
  }

  screenToCell(clientX, clientY) {
    if (!this.content) return -1;
    const rect = this.canvas.getBoundingClientRect();
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const wx = (clientX - rect.left - cw / 2) / this.cam.scale + this.cam.x;
    const wy = (clientY - rect.top - ch / 2) / (this.cam.scale * 0.82) + this.cam.y;
    const x = Math.floor(wx + this.w / 2);
    const y = Math.floor(wy + this.h / 2);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }

  cellToScreen(i) {
    const { x, y } = this._cellPos(i);
    const s = this._toScreen(x, y - 0.3);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }

  setHover(cell) { this.hoverCell = cell; }
  setKeyboardCursor(cell) { this.keyboardCell = cell; }
  setGhost(cells) { this.ghostCells = new Set(cells || []); }

  fitCamera(immediate = false) {
    const cw = this.canvas.clientWidth || 800, ch = this.canvas.clientHeight || 600;
    const scale = Math.min(cw / (this.w + 3), ch / ((this.h + 3) * 0.82));
    this.cam.tx = 0; this.cam.ty = 0; this.cam.tscale = scale;
    if (immediate || this.reducedMotion) {
      this.cam.x = 0; this.cam.y = 0; this.cam.scale = scale;
    }
    this.onCameraChange?.();
  }

  panBy(dxPx, dyPx) {
    this.cam.tx -= dxPx / this.cam.tscale;
    this.cam.ty -= dyPx / (this.cam.tscale * 0.82);
    this.onCameraChange?.();
  }

  zoomBy(factor) {
    this.cam.tscale = Math.max(6, Math.min(120, this.cam.tscale * factor));
    this.onCameraChange?.();
  }

  resetCamera() { this.fitCamera(); }

  resize() {
    this._dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.canvas.width = Math.round(w * this._dpr);
    this.canvas.height = Math.round(h * this._dpr);
  }

  setHidden(hidden) {
    this.hidden = hidden;
    if (hidden) this.settle();
  }

  update(dtMs) {
    if (this.hidden || !this.content || !this.theme) return;
    const dt = Math.min(0.05, dtMs / 1000);
    this.time += dt;
    const ctx = this.ctx;
    const dpr = this._dpr;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;

    // Camera easing.
    const k = this.reducedMotion ? 1 : Math.min(1, dt * 10);
    this.cam.x += (this.cam.tx - this.cam.x) * k;
    this.cam.y += (this.cam.ty - this.cam.y) * k;
    this.cam.scale += (this.cam.tscale - this.cam.scale) * k;

    // Rise animations.
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      a.t += dt * 4;
      if (a.t >= 0) {
        const cell = this.cells[a.cell];
        const target = cell.filled ? 1 : 0;
        cell.rise = target === 1 ? Math.min(1, a.t) : Math.max(0, cell.rise - dt * 4);
        if ((target === 1 && cell.rise >= 1) || (target === 0 && cell.rise <= 0)) this.anims.splice(i, 1);
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, cw, ch);

    // Table.
    const tl = this._toScreen(-this.w / 2 - 1.5, -this.h / 2 - 1.5);
    const br = this._toScreen(this.w / 2 + 1.5, this.h / 2 + 1.5);
    ctx.fillStyle = this.theme.table;
    roundRect(ctx, tl.x, tl.y, br.x - tl.x, br.y - tl.y, 12);
    ctx.fill();
    ctx.strokeStyle = this.theme.accentA;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Cells.
    const s = this.cam.scale;
    const showLabels = this.cellLabels || s > 34;
    const pulse = 0.55 + 0.3 * Math.sin(this.time * 4);
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      const { x, y } = this._cellPos(i);
      const p = this._toScreen(x, y);
      const size = s * 0.92;
      const lift = cell.rise * s * 0.28;
      const target = this.content.targets[i];
      let color;
      if (cell.filled) color = this.palette[target];
      else if (cell.wrong) color = this.palette[cell.wrong - 1];
      else color = mixHex(this.theme.cellEmpty, this.palette[target], 0.18);
      // Shadow side (extrusion cue).
      if (lift > 0.5) {
        ctx.fillStyle = shadeHex(color, 0.55);
        ctx.fillRect(p.x - size / 2, p.y - size / 2 * 0.82 - lift + lift, size, size * 0.82);
      }
      ctx.fillStyle = color;
      ctx.fillRect(p.x - size / 2, p.y - (size * 0.82) / 2 - lift, size, size * 0.82);
      if (this.ghostCells.has(i)) {
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.fillRect(p.x - size / 2, p.y - (size * 0.82) / 2 - lift, size, size * 0.82);
      }
      // Marker diamond on cells wanting the selected color.
      if (!cell.filled && target === this.selectedColor && this.selectedColor >= 0) {
        ctx.fillStyle = `rgba(255,255,255,${pulse})`;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - lift - size * 0.14);
        ctx.lineTo(p.x + size * 0.12, p.y - lift);
        ctx.lineTo(p.x, p.y - lift + size * 0.14);
        ctx.lineTo(p.x - size * 0.12, p.y - lift);
        ctx.fill();
      }
      if (cell.wrong) {
        ctx.strokeStyle = '#ff5d5d';
        ctx.lineWidth = Math.max(2, s * 0.06);
        ctx.beginPath();
        ctx.moveTo(p.x - size * 0.25, p.y - lift - size * 0.2);
        ctx.lineTo(p.x + size * 0.25, p.y - lift + size * 0.2);
        ctx.moveTo(p.x + size * 0.25, p.y - lift - size * 0.2);
        ctx.lineTo(p.x - size * 0.25, p.y - lift + size * 0.2);
        ctx.stroke();
      }
      if (showLabels && !cell.filled) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = `bold ${Math.max(8, s * 0.34)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(target === 0 ? '•' : String(target), p.x, p.y - lift);
      }
    }

    // Hover + keyboard cursor.
    if (this.hoverCell >= 0) this._outline(this.hoverCell, '#ffffff');
    if (this.keyboardCell >= 0) this._outline(this.keyboardCell, this.theme.accentB);
  }

  _outline(i, color) {
    const { x, y } = this._cellPos(i);
    const p = this._toScreen(x, y);
    const size = this.cam.scale;
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x - size / 2, p.y - (size * 0.82) / 2 - 6, size, size * 0.82);
  }

  getStats() { return { drawCalls: 1, triangles: 0 }; }
  dispose() { this.hidden = true; }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a, b, t) {
  const ca = hexRgb(a), cb = hexRgb(b);
  const m = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return `rgb(${m[0]},${m[1]},${m[2]})`;
}

function shadeHex(hex, f) {
  if (hex.startsWith('rgb')) return hex;
  const c = hexRgb(hex).map((v) => Math.round(v * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
