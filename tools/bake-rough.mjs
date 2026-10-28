// Bakes the detailed table's roughness map (render.js makeNoiseTexture: soft
// value noise, 16 cells, seeded 'table-rough') into assets/table-rough.png at
// the Ultra budget's 512 px (lower tiers sample the same map): per-pixel canvas
// work is too slow for the native interpreter at start-up. Run once: node tools/bake-rough.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { RNG } from '../js/rng.js';

const size = 512;
const rng = new RNG('table-rough');
const g = 16, grid = [];
for (let i = 0; i < g * g; i++) grid.push(rng.range(0, 1));
const at = (x, y) => grid[((y % g + g) % g) * g + ((x % g + g) % g)];
const raw = Buffer.alloc((size * 3 + 1) * size);
for (let y = 0; y < size; y++) {
  raw[y * (size * 3 + 1)] = 0;
  for (let x = 0; x < size; x++) {
    const fx = (x / size) * g, fy = (y / size) * g;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const v = (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
    const r = Math.round(255 * (0.55 + 0.4 * v));
    const o = y * (size * 3 + 1) + 1 + x * 3;
    raw[o] = raw[o + 1] = raw[o + 2] = r;
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
writeFileSync(new URL('../assets/table-rough.png', import.meta.url), png);
console.log(`assets/table-rough.png ${png.length} bytes`);
