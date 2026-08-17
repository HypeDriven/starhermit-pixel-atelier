// rng.js — deterministic seeded random streams.
// Separate streams for rules / decoration / audiovisual variants so cosmetic
// randomness can never leak into rules outcomes.

export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0) * 4294967296 + (h1 >>> 0);
}

export function hashString(str) {
  // 53-bit deterministic hash, returned as hex string for stable state hashes.
  return cyrb53(str).toString(16).padStart(14, '0');
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RNG {
  constructor(seedString) {
    this.seedString = String(seedString);
    this._next = mulberry32(cyrb53(this.seedString) % 4294967296);
  }
  fork(label) {
    return new RNG(this.seedString + '::' + label);
  }
  float() { return this._next(); }
  range(min, max) { return min + (max - min) * this._next(); }
  int(min, maxInclusive) { return Math.floor(this.range(min, maxInclusive + 1)); }
  pick(arr) { return arr[Math.floor(this._next() * arr.length)]; }
  chance(p) { return this._next() < p; }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
