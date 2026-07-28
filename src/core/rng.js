// Deterministic RNG. Everything world-generating MUST use this so screenshots
// are byte-stable across runs and A/B comparisons are meaningful.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed = 1337) {
    this.next = mulberry32(seed);
  }
  float(min = 0, max = 1) {
    return min + this.next() * (max - min);
  }
  int(min, max) {
    return Math.floor(this.float(min, max + 1));
  }
  bool(p = 0.5) {
    return this.next() < p;
  }
  pick(arr) {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }
  /** Gaussian-ish via sum of uniforms; cheap and stable. */
  gauss(mean = 0, sd = 1) {
    const u = this.next() + this.next() + this.next() - 1.5;
    return mean + u * sd * 1.4142;
  }
  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }
}

// ---- Value noise / fBm, deterministic from an integer seed --------------------

function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function valueNoise2D(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  const ux = smooth(fx), uy = smooth(fy);
  return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
}

export function fbm(x, y, { octaves = 4, lacunarity = 2.0, gain = 0.5, seed = 0 } = {}) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * (valueNoise2D(x * freq, y * freq, seed + i * 101) * 2 - 1);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm; // ~[-1, 1]
}

/** Ridged noise — good for mountain spines. */
export function ridged(x, y, opts = {}) {
  const n = fbm(x, y, opts);
  return 1 - Math.abs(n);
}
