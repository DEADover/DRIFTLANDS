// LANDFORM LIBRARY — the vocabulary of shapes the biomes are written in.
// ----------------------------------------------------------------------
// Owned by terrain & art direction. Everything here is a pure, deterministic
// function of (x, z, seed): no state, no Math.random, safe to call from the
// physics step at 120 Hz and from the mesh builder 250k times.
//
// Design rule: a biome is a *grammar*, not a noise amplitude. Alpine is a
// corridor. Autumn is a dome field. Desert is a threshold + terrace. Coast is a
// signed shoreline distance. Winter is a U-profile. Those five sentences are
// what make the places feel different — the palettes only finish the job.

import { fbm, ridged, valueNoise2D } from '../core/rng.js';

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const mix = (a, b, t) => a + (b - a) * t;

/** Hermite ramp. e0 > e1 is legal and gives a falling ramp. */
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** White-noise hash in [0,1). Used for per-facet grain and cell scatter. */
export function hash01(i, j, seed) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Field operators
// ---------------------------------------------------------------------------

/**
 * Domain warp. Pushes sample points around with low-frequency noise so level
 * sets stop looking like circular blobs and start looking eroded. Cheap: two
 * 2-octave fbm lookups.
 */
export function warped(x, z, seed, amp, scale) {
  const wx = fbm(x * scale, z * scale, { octaves: 2, seed: seed + 3301 });
  const wz = fbm(x * scale + 11.3, z * scale - 7.1, { octaves: 2, seed: seed + 6607 });
  return [x + wx * amp, z + wz * amp];
}

/**
 * Rounded hill field. Positive lobes get a broadened, dome-like top; negative
 * lobes stay shallow. The result rolls instead of ripples — no ridges, no
 * cliffs, which is exactly what separates woodland from alpine.
 */
export function domes(x, z, scale, seed, octaves = 3) {
  const n = fbm(x * scale, z * scale, { octaves, seed });
  return n > 0 ? Math.pow(n, 0.7) : n * 0.8;
}

/**
 * Dendritic hollow mask. |fbm| near zero traces a branching network of lines —
 * the natural plan-view of a stream system. Returns 1 in the hollow, 0 away.
 */
export function dendritic(x, z, scale, seed, width = 0.15, octaves = 3) {
  const d = Math.abs(fbm(x * scale, z * scale, { octaves, seed }));
  return 1 - smoothstep(0, width, d);
}

/**
 * A meandering corridor. Returns distance along (u) and signed distance across
 * (v) a curve that passes exactly through the world origin — so the spawn is
 * always on the valley floor / canyon rim, never halfway up a wall.
 *
 * The meander is a sum of sines rather than noise precisely so that v(0,0) = 0
 * is exact and free.
 */
export function corridor(x, z, seed, { dir = 0, amp = 180, wave = 1200 } = {}) {
  const c = Math.cos(dir), s = Math.sin(dir);
  const u = x * c + z * s;
  const v = -x * s + z * c;
  const a = 6.283185307 / wave;
  const k1 = a * (0.72 + hash01(seed, 11, 3) * 0.5);
  const k2 = a * (1.63 + hash01(seed, 12, 3) * 0.7);
  const k3 = a * (3.10 + hash01(seed, 13, 3) * 1.1);
  const m = Math.sin(u * k1) * amp + Math.sin(u * k2) * amp * 0.42 + Math.sin(u * k3) * amp * 0.17;
  return { u, v: v - m };
}

/**
 * Terracing with FLAT TOPS and NEAR-VERTICAL RISERS.
 *
 * The v0 bug was `round(h/s)*s*0.75 + h*0.25`: 25% of the raw signal leaked
 * through, so every "flat" top still had the fractal wobble of the source
 * field, and the step contours zigzagged along the mesh diagonals. Here the
 * flat is genuinely flat and the riser is a hard smoothstep occupying `riser`
 * of each step. Feed it a SMOOTH field (2 octaves, long wavelength) or the
 * contour lines will be jagged no matter how good this function is.
 */
export function terrace(h, step, riser = 0.16) {
  const t = h / step;
  const i = Math.floor(t);
  const f = t - i;
  const r = clamp(riser, 0.02, 0.9);
  return (i + smoothstep(0.5 - r * 0.5, 0.5 + r * 0.5, f)) * step;
}

/** Mountain spines. Ridged noise, sharpened. */
export function spines(x, z, scale, seed, sharpness = 2.1) {
  const r = ridged(x * scale, z * scale, { octaves: 4, seed });
  return Math.pow(clamp(r, 0, 1), sharpness);
}

/**
 * Sparse cell scatter — isolated pillars (sea stacks, buttes). Returns a 0..1
 * falloff from the nearest occupied cell centre. 9 hash lookups worst case.
 */
export function bumps(x, z, cell, seed, { chance = 0.14, radius = 0.3 } = {}) {
  const gx = Math.floor(x / cell), gz = Math.floor(z / cell);
  let best = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = gx + i, cz = gz + j;
      if (hash01(cx, cz, seed) > chance) continue;
      const px = (cx + 0.2 + hash01(cx, cz, seed + 1) * 0.6) * cell;
      const pz = (cz + 0.2 + hash01(cx, cz, seed + 2) * 0.6) * cell;
      const r = cell * radius * (0.5 + hash01(cx, cz, seed + 3) * 1.0);
      const dx = x - px, dz = z - pz;
      const f = 1 - clamp(Math.sqrt(dx * dx + dz * dz) / r, 0, 1);
      if (f > best) best = f;
    }
  }
  return best;
}

/** Micro relief. Small and high frequency — this is what makes facets tilt. */
export function grain(x, z, seed, amp = 2.4, scale = 0.021) {
  return fbm(x * scale, z * scale, { octaves: 2, seed: seed + 9091 }) * amp;
}

// ---------------------------------------------------------------------------
// Legacy shape set, kept so nothing outside this subsystem breaks.
// ---------------------------------------------------------------------------

export const HeightFns = {
  rollingHills(x, z, seed, { scale = 0.0022, amp = 26 } = {}) {
    return fbm(x * scale, z * scale, { octaves: 4, seed }) * amp;
  },
  mountains(x, z, seed, { scale = 0.0016, amp = 130 } = {}) {
    return spines(x, z, scale, seed + 7, 2.1) * amp;
  },
  plateau(x, z, seed, { scale = 0.0018, amp = 55, sharpness = 3.5 } = {}) {
    const n = (fbm(x * scale, z * scale, { octaves: 3, seed: seed + 13 }) + 1) * 0.5;
    return Math.pow(n, 1 / sharpness) * amp;
  },
  detail(x, z, seed, amp = 2.2) {
    return fbm(x * 0.02, z * 0.02, { octaves: 2, seed: seed + 91 }) * amp;
  },
  valueNoise2D,
};
