import * as THREE from 'three';
import { Rng, fbm } from '../core/rng.js';
import { GeoBuilder, rockGeom, derivePalette } from './buildkit.js';

/**
 * VEGETATION & GROUND COVER.
 *
 * Two ideas drive this file.
 *
 * 1. A real species library. Each biome gets 5-8 distinct plants with their own
 *    silhouette, their own altitude / slope / moisture preferences and their own
 *    size distribution. A fir is not a recoloured blob.
 *
 * 2. Placement is the art. Nothing is sprinkled uniformly. Trees are placed as
 *    COPSES: a cluster centre is accepted only where a two-scale noise field is
 *    high, the copse is stretched along the local contour so it follows the
 *    valley, members fall off toward the edge and shrink as they go. Between the
 *    copses there is nothing, which is the composition. A handful of oversized
 *    hero trees are then placed in the OPEN, where the forest mask is low — that
 *    lone-tree-in-a-meadow read is most of what sells the reference frame.
 *
 * Everything is instanced (one draw call per species variant) and every geometry
 * carries a vertex `color` attribute, so a single tree can have a pale birch
 * trunk and a yellow canopy without costing a second draw call. Per-instance
 * colour is a near-white multiplier used only for value/temperature variation.
 */

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;

/** Trapezoidal membership: 0 below a, 1 between b and c, 0 above d. */
function band(v, a, b, c, d) {
  if (v <= a || v >= d) return 0;
  if (v < b) return (v - a) / Math.max(1e-5, b - a);
  if (v > c) return (d - v) / Math.max(1e-5, d - c);
  return 1;
}

function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// SPECIES GEOMETRY
// Every maker returns { geo, trunkR, height }. Local origin sits on the ground.
// ---------------------------------------------------------------------------

function shade(c, l, s = 0) { return c.clone().offsetHSL(0, s, l); }

function fir(rng, K, o = {}) {
  const b = new GeoBuilder();
  const tall = o.tall ?? 1;
  const wide = o.wide ?? 1;
  const tiers = o.tiers ?? rng.int(3, 5);
  const trunkH = rng.float(1.3, 2.4) * tall;
  const tr = rng.float(0.26, 0.38) * wide;
  b.cyl(tr * 0.8, tr * 1.5, trunkH + 1.6, 5, K.bark, { y: (trunkH + 1.6) / 2 });
  let y = trunkH;
  let r = rng.float(1.75, 2.45) * wide;
  for (let i = 0; i < tiers; i++) {
    const h = rng.float(3.8, 5.2) * tall * (1 - i * 0.05);
    const c = K.leaf[i % K.leaf.length];
    b.cone(r, h, rng.int(5, 7), c, { y: y + h / 2, ry: rng.float(0, 1.2) });
    // Snow only settles on the upper tiers — a white cap, not white frosting.
    if (o.snow && i >= tiers - 2) {
      b.cone(r * 0.62, h * 0.26, rng.int(5, 6), K.snow, { y: y + h * 0.84 });
    }
    y += h * rng.float(0.60, 0.72);
    r *= rng.float(0.64, 0.76);
  }
  return { geo: b.build(), trunkR: Math.max(0.75, tr * 2.4), height: y + 2 };
}

function scotsPine(rng, K) {
  const b = new GeoBuilder();
  const h = rng.float(9, 15);
  const tr = rng.float(0.30, 0.44);
  b.cyl(tr * 0.7, tr * 1.4, h, 6, K.bark, { y: h / 2 });
  const n = rng.int(3, 5);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.float(-0.4, 0.4);
    const rr = rng.float(1.5, 2.6);
    const d = rng.float(0.6, 2.2);
    b.blob(rr, K.leaf[i % K.leaf.length], {
      x: Math.cos(a) * d, z: Math.sin(a) * d,
      y: h + rng.float(-0.8, 1.4), sy: 0.62,
    });
  }
  return { geo: b.build(), trunkR: 0.85, height: h + 3 };
}

function broadleaf(rng, K) {
  const b = new GeoBuilder();
  const th = rng.float(2.6, 4.6);
  const tr = rng.float(0.28, 0.46);
  b.cyl(tr * 0.75, tr * 1.5, th + 0.6, 5, K.bark, { y: (th + 0.6) / 2 });
  const n = rng.int(3, 5);
  const R = rng.float(2.4, 3.8);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.float(-0.5, 0.5);
    const d = i === 0 ? 0 : rng.float(0.8, R * 0.55);
    b.blob(R * rng.float(0.55, 0.92), K.leaf[i % K.leaf.length], {
      x: Math.cos(a) * d,
      z: Math.sin(a) * d,
      y: th + rng.float(0.6, 2.4),
      sy: rng.float(0.72, 1.0),
    });
  }
  return { geo: b.build(), trunkR: 0.9, height: th + R + 2 };
}

function birch(rng, K) {
  const b = new GeoBuilder();
  const th = rng.float(6.5, 10.5);
  b.cyl(0.16, 0.30, th, 5, K.birch, { y: th / 2 });
  // A couple of dark bark scars — reads as a birch even at this camera height.
  b.box(0.34, 0.5, 0.34, K.trunkDark, { y: th * 0.42 });
  b.box(0.34, 0.4, 0.34, K.trunkDark, { y: th * 0.66 });
  const n = rng.int(3, 5);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.float(-0.6, 0.6);
    b.blob(rng.float(1.4, 2.1), K.leafPale[i % K.leafPale.length], {
      x: Math.cos(a) * rng.float(0.3, 1.5),
      z: Math.sin(a) * rng.float(0.3, 1.5),
      y: th - rng.float(0.6, 2.6), sy: 0.85,
    });
  }
  return { geo: b.build(), trunkR: 0.62, height: th + 3 };
}

function maple(rng, K) {
  const b = new GeoBuilder();
  const th = rng.float(2.2, 3.6);
  b.cyl(0.34, 0.60, th + 0.6, 5, K.bark, { y: (th + 0.6) / 2 });
  const R = rng.float(3.0, 4.6);
  const n = rng.int(5, 7);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.float(-0.4, 0.4);
    const d = i === 0 ? 0 : rng.float(R * 0.2, R * 0.58);
    b.blob(R * rng.float(0.46, 0.78), K.leaf[i % K.leaf.length], {
      x: Math.cos(a) * d, z: Math.sin(a) * d,
      y: th + rng.float(-0.9, 1.7),
      sy: rng.float(0.6, 0.88),
    });
  }
  return { geo: b.build(), trunkR: 1.0, height: th + R };
}

function snag(rng, K) {
  const b = new GeoBuilder();
  const h = rng.float(5.5, 11);
  b.cyl(0.16, 0.46, h, 5, K.dead, { y: h / 2, rz: rng.float(-0.05, 0.05) });
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    const a = rng.float(0, Math.PI * 2);
    const bl = rng.float(1.2, 2.6);
    b.pushTilt(0, h * rng.float(0.45, 0.9), 0, a, 0, rng.float(0.5, 1.15));
    b.cyl(0.08, 0.17, bl, 4, K.dead, { y: bl / 2 });
    b.pop();
  }
  return { geo: b.build(), trunkR: 0.6, height: h };
}

function stump(rng, K) {
  const b = new GeoBuilder();
  const h = rng.float(0.7, 1.5);
  b.cyl(0.62, 0.85, h, 6, K.dead, { y: h / 2 });
  b.cyl(0.62, 0.62, 0.12, 6, K.woodPale, { y: h + 0.05 });
  return { geo: b.build(), trunkR: 0.8, height: h };
}

function saguaro(rng, K) {
  const b = new GeoBuilder();
  const h = rng.float(4.5, 8.5);
  b.cyl(0.55, 0.72, h, 7, K.leaf[0], { y: h / 2 });
  b.cone(0.55, 0.5, 7, K.leaf[0], { y: h });
  const arms = rng.int(0, 3);
  for (let i = 0; i < arms; i++) {
    const side = rng.sign();
    const yj = h * rng.float(0.38, 0.66);
    const ah = rng.float(1.8, 3.2);
    const yaw = rng.float(0, Math.PI * 2);
    const c = K.leaf[1 % K.leaf.length];
    b.push(0, 0, 0, yaw);
    b.cyl(0.30, 0.32, 1.5, 6, c, { rz: Math.PI / 2, x: side * 0.75, y: yj });
    b.cyl(0.30, 0.34, ah, 6, c, { x: side * 1.45, y: yj + ah / 2 });
    b.cone(0.30, 0.32, 6, c, { x: side * 1.45, y: yj + ah });
    b.pop();
  }
  return { geo: b.build(), trunkR: 0.8, height: h };
}

function barrelCactus(rng, K) {
  const b = new GeoBuilder();
  const r = rng.float(0.7, 1.3);
  b.blob(r, K.leaf[0], { y: r * 0.72, sy: rng.float(0.85, 1.25) });
  b.cone(r * 0.5, r * 0.5, 6, K.accents[1], { y: r * 1.45 });
  return { geo: b.build(), trunkR: 0.7, height: r * 1.8 };
}

function ocotillo(rng, K) {
  const b = new GeoBuilder();
  const n = rng.int(5, 8);
  const h = rng.float(2.6, 4.4);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.float(-0.3, 0.3);
    b.pushTilt(0, 0, 0, a, 0, rng.float(0.18, 0.42));
    b.cyl(0.05, 0.14, h * rng.float(0.7, 1.15), 4, K.dead, { y: h * 0.5 });
    b.pop();
  }
  return { geo: b.build(), trunkR: 0, height: h };
}

function scrub(rng, K) {
  const b = new GeoBuilder();
  const n = rng.int(2, 4);
  const R = rng.float(0.9, 1.9);
  for (let i = 0; i < n; i++) {
    b.blob(R * rng.float(0.55, 1.0), K.leaf[i % K.leaf.length], {
      x: rng.gauss(0, R * 0.45), z: rng.gauss(0, R * 0.45),
      y: R * rng.float(0.35, 0.7), sy: rng.float(0.45, 0.72),
    });
  }
  return { geo: b.build(), trunkR: 0, height: R };
}

function windPine(rng, K) {
  const b = new GeoBuilder();
  const lean = rng.float(0.20, 0.42);
  const h = rng.float(5.5, 9.5);
  b.pushTilt(0, 0, 0, 0, 0, -lean);
  b.cyl(0.22, 0.42, h, 5, K.bark, { y: h / 2 });
  b.pop();
  const tipX = Math.sin(lean) * h;
  const n = rng.int(3, 5);
  for (let i = 0; i < n; i++) {
    b.blob(rng.float(1.6, 2.9), K.leaf[i % K.leaf.length], {
      x: tipX + rng.float(0.4, 3.0),
      z: rng.gauss(0, 1.1),
      y: h * Math.cos(lean) + rng.float(-1.4, 0.9),
      sy: rng.float(0.34, 0.5),
    });
  }
  return { geo: b.build(), trunkR: 0.7, height: h };
}

function bush(rng, K, pal) {
  const b = new GeoBuilder();
  const n = rng.int(2, 4);
  const R = rng.float(1.0, 2.2);
  for (let i = 0; i < n; i++) {
    b.blob(R * rng.float(0.6, 1.0), pal[i % pal.length], {
      x: rng.gauss(0, R * 0.5), z: rng.gauss(0, R * 0.5),
      y: R * rng.float(0.45, 0.85), sy: rng.float(0.62, 0.9),
    });
  }
  return { geo: b.build(), trunkR: 0, height: R * 1.6 };
}

function flowerPatch(rng, K, colIdx) {
  // At this camera height a flower is 3 px. What reads is the PATCH: a shallow
  // dish of tinted meadow with a scatter of low domes just proud of it.
  const b = new GeoBuilder();
  const R = rng.float(2.4, 3.8);
  const c = K.accents[colIdx % K.accents.length];
  const bedA = K.meadow.clone().lerp(c, 0.10);
  const bedB = K.meadow.clone().lerp(c, 0.24);
  b.cyl(R, R * 0.88, 0.12, 7, bedA, { y: 0.06 });
  b.cyl(R * 0.58, R * 0.46, 0.14, 6, bedB, { y: 0.11, x: rng.float(-0.5, 0.5), z: rng.float(-0.5, 0.5) });
  const n = rng.int(10, 15);
  for (let i = 0; i < n; i++) {
    const a = rng.float(0, Math.PI * 2), d = Math.sqrt(rng.float(0, 1)) * R * 0.85;
    b.cone(rng.float(0.36, 0.62), rng.float(0.26, 0.42), 5, c, {
      x: Math.cos(a) * d, z: Math.sin(a) * d, y: rng.float(0.2, 0.32),
    });
  }
  return { geo: b.build(), trunkR: 0, height: 0.6 };
}

function reeds(rng, K) {
  const b = new GeoBuilder();
  const n = rng.int(7, 12);
  for (let i = 0; i < n; i++) {
    const a = rng.float(0, Math.PI * 2), d = Math.sqrt(rng.float(0, 1)) * 1.5;
    const h = rng.float(1.2, 2.2);
    b.pushTilt(Math.cos(a) * d, 0, Math.sin(a) * d, rng.float(0, 6.28),
      rng.float(-0.13, 0.13), rng.float(-0.13, 0.13));
    b.cone(rng.float(0.26, 0.44), h, 5, i % 4 === 0 ? K.reedTip : K.reed, { y: h / 2 });
    b.pop();
  }
  return { geo: b.build(), trunkR: 0, height: 2.0 };
}

function tussock(rng, K) {
  // Low, wide clump of coarse grass. Deliberately squat — anything thin and
  // vertical at this camera height turns into shimmering white needles.
  const b = new GeoBuilder();
  const n = rng.int(4, 7);
  for (let i = 0; i < n; i++) {
    const a = rng.float(0, Math.PI * 2), d = rng.float(0, 1.1);
    const h = rng.float(0.55, 1.05);
    b.pushTilt(Math.cos(a) * d, 0, Math.sin(a) * d, rng.float(0, 6.28), 0, rng.float(-0.3, 0.3));
    b.cone(rng.float(0.5, 0.85), h, 5, K.grass[i % K.grass.length], { y: h / 2, sz: 0.7 });
    b.pop();
  }
  return { geo: b.build(), trunkR: 0, height: 1.0 };
}

function screePatch(rng, K) {
  const b = new GeoBuilder();
  const n = rng.int(5, 8);
  for (let i = 0; i < n; i++) {
    const a = rng.float(0, Math.PI * 2), d = Math.sqrt(rng.float(0, 1)) * 3.4;
    const s = rng.float(0.28, 0.72);
    b.pushTilt(Math.cos(a) * d, 0, Math.sin(a) * d, rng.float(0, 6.28),
      rng.float(-0.3, 0.3), rng.float(-0.3, 0.3), s);
    b.raw(rockGeom(rng, { jitter: 0.5 }), i % 3 === 0 ? K.scree : K.rockDark);
    b.pop();
  }
  return { geo: b.build(), trunkR: 0, height: 1 };
}

function boulder(rng, K, o = {}) {
  const b = new GeoBuilder();
  const body = K.rock.clone().lerp(K.rockDark, rng.float(0.25, 0.75));
  b.raw(rockGeom(rng, { jitter: 0.36 }), body);
  if (rng.bool(0.5)) {
    const lump = rockGeom(rng, { jitter: 0.4 });
    lump.scale(0.55, 0.5, 0.55);
    lump.translate(rng.float(-0.9, 0.9), 0.1, rng.float(-0.9, 0.9));
    b.raw(lump, K.rockDark);
  }
  if (o.snow) {
    const cap = rockGeom(rng, { jitter: 0.22 });
    cap.scale(1.02, 0.5, 1.02);
    cap.translate(0, 0.44, 0);
    b.raw(cap, K.snow);
  }
  return { geo: b.build(), trunkR: 1, height: 1 };
}

const MAKERS = {
  fir,
  firOld: (r, K) => fir(r, K, { tall: 1.35, wide: 1.25, tiers: 5 }),
  firYoung: (r, K) => fir(r, K, { tall: 0.62, wide: 0.72, tiers: 3 }),
  firSnow: (r, K) => fir(r, K, { snow: true }),
  firSnowOld: (r, K) => fir(r, K, { snow: true, tall: 1.3, wide: 1.2, tiers: 5 }),
  scotsPine, broadleaf, birch, maple, snag, stump,
  saguaro, barrelCactus, ocotillo, scrub, windPine,
  bushDark: (r, K) => bush(r, K, K.bushDark),
  bushLight: (r, K) => bush(r, K, K.bushLight),
  flowersA: (r, K) => flowerPatch(r, K, 0),
  flowersB: (r, K) => flowerPatch(r, K, 1),
  flowersC: (r, K) => flowerPatch(r, K, 2),
  reeds, tussock, screePatch,
  boulder,
  boulderSnow: (r, K) => boulder(r, K, { snow: true }),
};

// ---------------------------------------------------------------------------
// BIOME MIXES
//   alt  : [a,b,c,d] metres above the water line — the species' altitude band
//   wet  : [a,b,c,d] moisture membership, 0 = arid ridge, 1 = valley floor
//   flat : minimum terrain normal.y ; flatMax : maximum (scree wants steep)
//   size : [min,max] instance scale
//
//   forest.cover  : the FRACTION OF THE MAP that is forest. The threshold that
//                   achieves it is solved at build time from the actual noise
//                   field (see `quantileGate`), so the composition is the same
//                   whatever the seed does. `spacing` is the metres between
//                   trees inside a copse.
// ---------------------------------------------------------------------------

const MIXES = {
  alpine: {
    canopyTarget: 3400, coverTarget: 1400, pebbleTarget: 2100, heroes: 90, moistScale: 46,
    forest: { macro: 0.0016, meso: 0.0060, rich: 0.20, bare: 0.30, spacing: 9.4, contrast: 1.35 },
    canopy: [
      { id: 'fir', w: 5.2, alt: [1, 6, 62, 84], wet: [0, 0.15, 0.9, 1.1], flat: 0.74, size: [0.85, 1.5] },
      { id: 'firOld', w: 1.5, alt: [2, 10, 55, 76], wet: [0, 0.2, 0.9, 1.1], flat: 0.77, size: [0.9, 1.35] },
      { id: 'firYoung', w: 2.0, alt: [1, 6, 70, 90], wet: [0, 0.1, 0.9, 1.1], flat: 0.72, size: [1.05, 1.8] },
      { id: 'broadleaf', w: 1.9, alt: [1, 5, 34, 52], wet: [0.2, 0.42, 1.0, 1.1], flat: 0.78, size: [0.85, 1.5] },
      { id: 'birch', w: 1.4, alt: [2, 8, 46, 66], wet: [0.15, 0.35, 0.95, 1.1], flat: 0.78, size: [0.9, 1.4] },
      { id: 'snag', w: 0.35, alt: [4, 14, 70, 92], wet: [0, 0, 0.7, 1.0], flat: 0.80, size: [0.8, 1.3] },
    ],
    heroSpecies: ['firOld', 'broadleaf', 'fir'],
    cover: [
      { id: 'bushDark', w: 2.4, alt: [1, 4, 70, 92], wet: [0, 0.1, 1, 1.1], flat: 0.74, size: [0.7, 1.6] },
      { id: 'bushLight', w: 1.6, alt: [1, 4, 58, 80], wet: [0.1, 0.3, 1, 1.1], flat: 0.74, size: [0.7, 1.5] },
      { id: 'flowersA', w: 1.5, alt: [2, 6, 44, 62], wet: [0.15, 0.4, 1, 1.1], flat: 0.90, size: [0.8, 1.4] },
      { id: 'flowersB', w: 1.1, alt: [2, 6, 50, 70], wet: [0.1, 0.35, 1, 1.1], flat: 0.90, size: [0.8, 1.4] },
      { id: 'tussock', w: 3.0, alt: [1, 3, 74, 96], wet: [0, 0.05, 1, 1.1], flat: 0.72, size: [0.8, 1.7] },
      { id: 'screePatch', w: 1.8, alt: [26, 52, 130, 220], wet: [0, 0, 0.55, 0.85], flat: 0.0, flatMax: 0.88, size: [0.7, 1.3] },
    ],
    shore: { id: 'reeds', size: [0.8, 1.5] },
    boulder: 'boulder',
  },

  autumn: {
    canopyTarget: 4200, coverTarget: 1300, pebbleTarget: 1100, heroes: 70, moistScale: 58,
    forest: { macro: 0.0018, meso: 0.0068, rich: 0.34, bare: 0.12, spacing: 7.4, contrast: 0.85 },
    canopy: [
      { id: 'maple', w: 4.2, alt: [1, 5, 40, 62], wet: [0.05, 0.3, 1, 1.1], flat: 0.76, size: [0.75, 1.5] },
      { id: 'broadleaf', w: 3.4, alt: [1, 5, 46, 68], wet: [0.05, 0.25, 1, 1.1], flat: 0.76, size: [0.75, 1.5] },
      { id: 'birch', w: 2.0, alt: [2, 8, 52, 74], wet: [0.1, 0.3, 1, 1.1], flat: 0.78, size: [0.8, 1.3] },
      { id: 'scotsPine', w: 1.4, alt: [8, 22, 62, 84], wet: [0, 0, 0.75, 1.0], flat: 0.76, size: [0.8, 1.35] },
      { id: 'snag', w: 0.5, alt: [2, 8, 62, 84], wet: [0, 0, 0.8, 1.05], flat: 0.80, size: [0.8, 1.3] },
      { id: 'stump', w: 0.6, alt: [1, 4, 56, 78], wet: [0, 0.1, 1, 1.1], flat: 0.86, size: [0.8, 1.6] },
    ],
    heroSpecies: ['maple', 'broadleaf', 'scotsPine'],
    cover: [
      { id: 'bushDark', w: 2.6, alt: [1, 3, 64, 86], wet: [0, 0.1, 1, 1.1], flat: 0.74, size: [0.7, 1.6] },
      { id: 'bushLight', w: 2.2, alt: [1, 3, 60, 82], wet: [0, 0.1, 1, 1.1], flat: 0.74, size: [0.7, 1.6] },
      { id: 'tussock', w: 2.4, alt: [1, 3, 70, 92], wet: [0, 0.05, 1, 1.1], flat: 0.72, size: [0.8, 1.6] },
      { id: 'flowersC', w: 0.8, alt: [2, 6, 40, 60], wet: [0.2, 0.45, 1, 1.1], flat: 0.90, size: [0.8, 1.3] },
      { id: 'screePatch', w: 1.0, alt: [20, 40, 100, 160], wet: [0, 0, 0.6, 0.9], flat: 0.0, flatMax: 0.90, size: [0.7, 1.2] },
    ],
    shore: { id: 'reeds', size: [0.9, 1.6] },
    boulder: 'boulder',
  },

  desert: {
    canopyTarget: 1750, coverTarget: 1400, pebbleTarget: 2100, heroes: 60, moistScale: 15,
    forest: { macro: 0.0022, meso: 0.0075, rich: 0.16, bare: 0.44, spacing: 18.0, contrast: 2.1 },
    canopy: [
      { id: 'saguaro', w: 8.0, alt: [1, 5, 52, 78], wet: [0, 0, 1.0, 1.2], flat: 0.80, size: [1.0, 1.7] },
      { id: 'ocotillo', w: 2.2, alt: [1, 5, 58, 84], wet: [0, 0, 1.0, 1.2], flat: 0.78, size: [0.9, 1.6] },
      { id: 'barrelCactus', w: 1.5, alt: [0, 3, 62, 88], wet: [0, 0, 1.05, 1.25], flat: 0.76, size: [0.9, 1.8] },
      { id: 'snag', w: 0.8, alt: [1, 5, 54, 80], wet: [0, 0, 1.0, 1.2], flat: 0.80, size: [0.7, 1.1] },
    ],
    heroSpecies: ['saguaro', 'saguaro', 'ocotillo'],
    cover: [
      { id: 'scrub', w: 5.0, alt: [0, 2, 68, 96], wet: [0, 0, 1.1, 1.3], flat: 0.72, size: [0.7, 1.8] },
      { id: 'tussock', w: 1.4, alt: [0, 2, 54, 80], wet: [0.1, 0.3, 1.1, 1.3], flat: 0.74, size: [0.7, 1.4] },
      { id: 'screePatch', w: 3.0, alt: [4, 14, 90, 150], wet: [0, 0, 1.1, 1.3], flat: 0.0, flatMax: 0.93, size: [0.7, 1.4] },
    ],
    shore: { id: 'reeds', size: [0.7, 1.2] },
    boulder: 'boulder',
  },

  coast: {
    canopyTarget: 2500, coverTarget: 1400, pebbleTarget: 1500, heroes: 64, moistScale: 30,
    forest: { macro: 0.0019, meso: 0.0066, rich: 0.18, bare: 0.34, spacing: 10.0, contrast: 1.5 },
    canopy: [
      { id: 'windPine', w: 4.0, alt: [3, 9, 40, 62], wet: [0, 0.1, 0.95, 1.1], flat: 0.76, size: [0.8, 1.5] },
      { id: 'scotsPine', w: 1.8, alt: [6, 16, 48, 70], wet: [0, 0.05, 0.9, 1.1], flat: 0.77, size: [0.8, 1.3] },
      { id: 'broadleaf', w: 1.4, alt: [4, 12, 36, 54], wet: [0.25, 0.5, 1, 1.1], flat: 0.80, size: [0.7, 1.2] },
      { id: 'snag', w: 0.6, alt: [2, 8, 46, 68], wet: [0, 0, 0.9, 1.1], flat: 0.82, size: [0.8, 1.2] },
    ],
    heroSpecies: ['windPine', 'scotsPine', 'windPine'],
    cover: [
      { id: 'bushDark', w: 3.4, alt: [2, 6, 50, 74], wet: [0, 0.05, 1, 1.1], flat: 0.72, size: [0.7, 1.6] },
      { id: 'tussock', w: 4.0, alt: [0.6, 2.5, 44, 70], wet: [0, 0.05, 1, 1.1], flat: 0.70, size: [0.8, 1.8] },
      { id: 'flowersA', w: 1.0, alt: [3, 8, 34, 52], wet: [0.2, 0.45, 1, 1.1], flat: 0.90, size: [0.8, 1.3] },
      { id: 'screePatch', w: 2.2, alt: [1, 5, 70, 120], wet: [0, 0, 1, 1.1], flat: 0.0, flatMax: 0.88, size: [0.7, 1.3] },
    ],
    shore: { id: 'reeds', size: [0.9, 1.5] },
    boulder: 'boulder',
  },

  winter: {
    canopyTarget: 2600, coverTarget: 900, pebbleTarget: 1150, heroes: 78, moistScale: 40,
    forest: { macro: 0.0017, meso: 0.0062, rich: 0.17, bare: 0.36, spacing: 10.0, coverBare: 0.45, contrast: 1.5 },
    canopy: [
      { id: 'firSnow', w: 4.2, alt: [2, 10, 48, 66], wet: [0, 0.1, 1, 1.1], flat: 0.76, size: [1.0, 1.65] },
      { id: 'firSnowOld', w: 1.2, alt: [3, 12, 42, 58], wet: [0, 0.1, 1, 1.1], flat: 0.78, size: [1.1, 1.5] },
      { id: 'firYoung', w: 2.0, alt: [2, 8, 54, 72], wet: [0, 0.1, 1, 1.1], flat: 0.74, size: [1.05, 1.7] },
      { id: 'snag', w: 0.8, alt: [4, 14, 60, 84], wet: [0, 0, 0.85, 1.1], flat: 0.80, size: [0.8, 1.3] },
    ],
    heroSpecies: ['firSnowOld', 'firSnow', 'snag'],
    cover: [
      { id: 'bushDark', w: 1.6, alt: [1, 4, 46, 66], wet: [0, 0.1, 1, 1.1], flat: 0.74, size: [0.7, 1.4] },
      { id: 'tussock', w: 1.2, alt: [1, 3, 40, 58], wet: [0, 0.1, 1, 1.1], flat: 0.74, size: [0.7, 1.3] },
      { id: 'screePatch', w: 3.2, alt: [12, 30, 120, 200], wet: [0, 0, 0.7, 1.0], flat: 0.0, flatMax: 0.88, size: [0.8, 1.4] },
    ],
    shore: { id: 'reeds', size: [0.7, 1.2] },
    boulder: 'boulderSnow',
  },
};

// ---------------------------------------------------------------------------

/** Minimal BufferGeometry merge — avoids pulling in the addons bundle.
 *  Kept here, unchanged, because entities/car.js imports it. */
export function mergeGeometries(geos) {
  let total = 0;
  for (const g of geos) total += g.index ? g.index.count : g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    const gi = g.index;
    const p = g.attributes.position;
    const n = g.attributes.normal ?? (g.computeVertexNormals(), g.attributes.normal);
    if (gi) {
      const np = new Float32Array(gi.count * 3);
      const nn = new Float32Array(gi.count * 3);
      for (let i = 0; i < gi.count; i++) {
        const v = gi.getX(i);
        np[i * 3] = p.getX(v); np[i * 3 + 1] = p.getY(v); np[i * 3 + 2] = p.getZ(v);
        nn[i * 3] = n.getX(v); nn[i * 3 + 1] = n.getY(v); nn[i * 3 + 2] = n.getZ(v);
      }
      pos.set(np, o * 3); nrm.set(nn, o * 3); o += gi.count;
    } else {
      pos.set(p.array, o * 3); nrm.set(n.array, o * 3); o += p.count;
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, o * 3), 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(0, o * 3), 3));
  return out;
}

const VARIANTS = 3;

export class PropScatter {
  constructor(terrain, palette, biome, seed = 2024) {
    this.terrain = terrain;
    this.palette = palette;
    this.biome = biome;
    this.seed = seed;
    this.rng = new Rng(seed);
    this.group = new THREE.Group();
    this.group.name = 'props';
    this.colliders = [];
    this.counts = {};
  }

  /** Per-variant colour set. Variants differ in canopy hue so a copse is not
   *  one flat green — a real wood has three or four greens in it. */
  _colorsFor(vi) {
    const p = this.palette;
    const D = derivePalette(p, this.biome.id);
    const fol = p.foliage.map((h) => new THREE.Color(h));
    const n = fol.length;
    const a = fol[vi % n];
    const b2 = fol[(vi + 1) % n];
    const j = (vi - (VARIANTS - 1) / 2) * 0.035;
    // Canopy should sit a clear step from the ground ramp. On a light palette
    // that means darker; on the dusk palette the foliage is already near-black,
    // so push the other way or the trees become holes in the frame.
    const hsl = { h: 0, s: 0, l: 0 };
    a.getHSL(hsl);
    const dir = hsl.l > 0.30 ? -1 : 1;
    const leaf = [
      shade(a, j + dir * 0.035, 0.03),
      shade(a, j + dir * 0.105, 0.06),
      shade(b2, j + dir * 0.01, -0.02),
    ];
    return {
      ...D,
      leaf,
      leafPale: leaf.map((c) => shade(c, 0.10, -0.05)),
      meadow: shade(new THREE.Color(p.ground[1]), -0.05, 0.07),
      grass: [
        shade(leaf[0], 0.06, -0.06),
        shade(new THREE.Color(p.ground[1]), -0.06, 0.04),
      ],
      reed: shade(leaf[0], -0.02, 0.05),
      reedTip: shade(new THREE.Color(p.ground[3]), -0.02, 0.04),
      bushDark: [shade(leaf[1], -0.04, 0.02), shade(leaf[2], -0.06, 0.04)],
      bushLight: [shade(leaf[0], 0.06, -0.03), shade(leaf[2], 0.09, -0.05)],
    };
  }

  build(isBlocked = () => false) {
    const B = this.biome;
    const S = this.seed;
    const T = this.terrain;
    const mix = MIXES[B.id] ?? MIXES.alpine;
    const half = (B.size / 2) * 0.95;
    const rng = this.rng;
    const wl = B.waterLevel;

    // ---- geometry library ------------------------------------------------
    const colorSets = [];
    for (let v = 0; v < VARIANTS; v++) colorSets.push(this._colorsFor(v));

    const lib = new Map();
    const need = new Set();
    for (const s of mix.canopy) need.add(s.id);
    for (const s of mix.cover) need.add(s.id);
    for (const id of mix.heroSpecies) need.add(id);
    need.add(mix.shore.id);
    need.add(mix.boulder);
    for (const id of need) {
      for (let v = 0; v < VARIANTS; v++) {
        const r = new Rng((strHash(id) ^ Math.imul(v + 1, 2654435761) ^ 0x9e37) >>> 0);
        lib.set(`${id}#${v}`, MAKERS[id](r, colorSets[v]));
      }
    }

    const buckets = new Map();
    const emit = (id, v, t) => {
      const k = `${id}#${v}`;
      let a = buckets.get(k);
      if (!a) buckets.set(k, (a = []));
      a.push(t);
      this.counts[id] = (this.counts[id] ?? 0) + 1;
    };

    // ---- environment fields ---------------------------------------------
    const F = mix.forest;

    const moistAt = (x, z, h) => {
      const above = h - wl;
      // How fast the ground dries out as you climb away from the water table.
      // Short in the desert (everything above the wash is arid), long in the
      // woodland (the whole valley floor is damp).
      const low = clamp(1 - above / (mix.moistScale ?? 46), 0, 1);
      const n = fbm(x * 0.0034, z * 0.0034, { octaves: 3, seed: S + 617 }) * 0.5 + 0.5;
      return clamp(low * 0.62 + n * 0.58, 0, 1);
    };

    /** Where woodland wants to be: two noise scales plus a pull toward damp,
     *  low ground, so copses run along the valleys instead of over the ridges. */
    const forestMask = (x, z) => {
      const h = T.heightAt(x, z);
      return (
        fbm(x * F.macro, z * F.macro, { octaves: 3, seed: S + 811 }) * 0.72 +
        fbm(x * F.meso, z * F.meso, { octaves: 2, seed: S + 1229 }) * 0.40 +
        (moistAt(x, z, h) - 0.5) * 0.55
      );
    };

    /** Where low scrub / meadow cover wants to be — an independent field, so
     *  ground cover is not simply a halo around every wood. */
    const coverMask = (x, z) =>
      fbm(x * F.macro * 1.6, z * F.macro * 1.6, { octaves: 3, seed: S + 2027 }) * 0.74 +
      fbm(x * F.meso * 1.4, z * F.meso * 1.4, { octaves: 2, seed: S + 3313 }) * 0.44;

    /**
     * Turn a raw noise mask into a 0..1 DENSITY field with a stable meaning:
     * the richest `rich` fraction of the map reads 1, the poorest `bare`
     * fraction reads 0, and everything between ramps. Solving the thresholds
     * from the actual field (rather than hard-coding them) means "the top fifth
     * of the alpine map is thick forest" stays true whatever the seed does.
     */
    const gradeField = (maskFn, rich, bare) => {
      const qr = new Rng((S ^ 0x7f4a) >>> 0);
      const N = 1100;
      const vals = [];
      for (let i = 0; i < N; i++) vals.push(maskFn(qr.float(-half, half), qr.float(-half, half)));
      vals.sort((a, b) => a - b);
      const at = (f) => vals[clamp(Math.round(f * (N - 1)), 0, N - 1)];
      const lo = at(bare);
      const hi = at(1 - rich);
      const span = Math.max(1e-4, hi - lo);
      return (x, z) => {
        const t = clamp((maskFn(x, z) - lo) / span, 0, 1);
        return t * t * (3 - 2 * t);
      };
    };

    const forestDensity = gradeField(forestMask, F.rich, F.bare);
    const coverDensity = gradeField(coverMask, 0.22, F.coverBare ?? 0.34);

    const envAt = (x, z) => {
      const h = T.heightAt(x, z);
      const above = h - wl;
      if (above < 0.7) return null;
      const n = T.normalAt(x, z, 3.5);
      return { h, above, ny: n.y, moist: moistAt(x, z, h) };
    };

    const fitness = (spec, e) => {
      if (e.ny < (spec.flat ?? 0)) return 0;
      if (spec.flatMax != null && e.ny > spec.flatMax) return 0;
      const a = band(e.above, spec.alt[0], spec.alt[1], spec.alt[2], spec.alt[3]);
      if (a <= 0) return 0;
      const w = band(e.moist, spec.wet[0], spec.wet[1], spec.wet[2], spec.wet[3]);
      if (w <= 0) return 0;
      return a * (0.35 + 0.65 * w);
    };

    // Keep the player's spawn pocket clear of anything solid.
    const SPAWN_CLEAR = 22;
    const nearSpawn = (x, z) => x * x + z * z < SPAWN_CLEAR * SPAWN_CLEAR;

    const pickSpecies = (list, e, r) => {
      let total = 0;
      const ws = [];
      for (const s of list) { const f = fitness(s, e) * s.w; ws.push(f); total += f; }
      if (total <= 1e-6) return null;
      let t = r.float(0, total);
      for (let i = 0; i < list.length; i++) { t -= ws[i]; if (t <= 0) return list[i]; }
      return list[list.length - 1];
    };

    // ---- CLUSTER PASS ----------------------------------------------------
    // Cluster centres are accepted only where the forest field is high AND at
    // least `sep` metres from an existing centre — that is what produces the
    // "copse, gap, copse" rhythm instead of an even blanket.
    const placeClusters = (list, target, opt) => {
      const sep2 = opt.sep * opt.sep;
      const centres = [];

      // -- pass 1: lay out every copse across the WHOLE map first. Capping by
      // instance count inside the sampling loop used to leave entire regions
      // bare (whichever corner the loop happened to reach last), which is how
      // the spawn area ended up with no trees at all.
      for (let i = 0; i < opt.tries; i++) {
        const cx = rng.float(-half, half);
        const cz = rng.float(-half, half);
        // Graded, not gated: copses appear everywhere but their likelihood and
        // their size both fall off with the density field, so the map reads as
        // thick wood -> scattered stands -> open ground -> nothing.
        const d = Math.pow(opt.density(cx, cz), opt.contrast ?? 1);
        if (rng.float(0, 1) > 0.30 + 0.70 * d) continue;
        let clash = false;
        for (const c of centres) {
          const dx = c.x - cx, dz = c.z - cz;
          if (dx * dx + dz * dz < sep2) { clash = true; break; }
        }
        if (clash) continue;
        const e = envAt(cx, cz);
        if (!e) continue;
        const dom = pickSpecies(list, e, rng);
        if (!dom) continue;

        // Stretch the copse along the local contour so it follows the valley.
        const eps = 26;
        const gx = T.heightAt(cx + eps, cz) - T.heightAt(cx - eps, cz);
        const gz = T.heightAt(cx, cz + eps) - T.heightAt(cx, cz - eps);
        const gl = Math.hypot(gx, gz) || 1;
        // Copse footprint is independent of the field — a thin stand is a small
        // NUMBER of trees over normal ground, not a shrunken model of a forest.
        const strength = 0.35 + 0.65 * d;
        const ra = opt.radius[0] + (opt.radius[1] - opt.radius[0]) * Math.pow(rng.float(0, 1), 1.4);
        const rb = ra * rng.float(0.34, 0.80);
        centres.push({
          x: cx, z: cz, dom, strength, ra, rb,
          ax: -gz / gl, az: gx / gl, bx: gx / gl, bz: gz / gl,
          nominal: (Math.PI * ra * rb) / (opt.spacing * opt.spacing) * strength,
        });
      }

      // -- pass 2: normalise so the map-wide total lands on the target. Every
      // copse thins or thickens together; none of them vanishes.
      let nominal = 0;
      for (const c of centres) nominal += c.nominal;
      const k = nominal > 0 ? clamp(target / nominal, 0.03, 2.2) : 0;
      const ceiling = Math.round(target * 1.12);
      let placed = 0;

      for (const c of centres) {
        if (placed >= ceiling) break;
        const members = Math.min(opt.maxMembers, Math.max(1, Math.round(c.nominal * k)));
        for (let i = 0; i < members; i++) {
          const u = rng.gauss(0, 0.44), vv = rng.gauss(0, 0.44);
          const r2 = u * u + vv * vv;
          if (r2 > 1.25) continue;
          const x = c.x + c.ax * u * c.ra + c.bx * vv * c.rb;
          const z = c.z + c.az * u * c.ra + c.bz * vv * c.rb;
          if (Math.abs(x) > half || Math.abs(z) > half) continue;
          const e2 = envAt(x, z);
          if (!e2) continue;
          const spec = rng.bool(0.76) ? c.dom : pickSpecies(list, e2, rng);
          if (!spec) continue;
          const f = fitness(spec, e2);
          if (f <= 0) continue;
          if (rng.float(0, 1) > f * (1 - 0.45 * r2)) continue;
          if (isBlocked(x, z)) continue;
          if (nearSpawn(x, z)) continue;

          const sz = spec.size;
          // Skewed toward small: many young trees, a few full-grown ones. Not
          // TOO skewed — below ~8 m a tree stops reading as a tree at this
          // camera height and turns into visual grit.
          let s = sz[0] + (sz[1] - sz[0]) * Math.pow(rng.float(0, 1), 1.25);
          s *= lerp(1.0, 0.80, clamp(r2, 0, 1));   // copse edge = younger
          if (rng.bool(0.07)) s *= 1.28;           // occasional veteran
          const v = rng.int(0, VARIANTS - 1);
          emit(spec.id, v, {
            x, y: e2.h - 0.15, z, s,
            r: rng.float(0, Math.PI * 2),
            tx: rng.gauss(0, 0.018), tz: rng.gauss(0, 0.018),
          });
          // Only MATURE trunks are solid. Every sapling being a collider turned
          // a copse into a minefield: game.js scales velocity by 0.45 for every
          // overlapping collider every fixed step, so one brush through a stand
          // parks the car. Three capture presets were finishing at 0 km/h.
          const entry = lib.get(`${spec.id}#${v}`);
          if (entry.trunkR >= 0.7 && s >= 1.34) {
            this.colliders.push({ x, z, r: entry.trunkR * s * 0.42 });
          }
          placed++;
        }
      }
      return placed;
    };

    // treeDensity is the biome author's dial; damp it so a 1.9 does not double
    // the triangle budget on its own.
    const D = 0.45 + 0.55 * (B.treeDensity ?? 1);
    placeClusters(mix.canopy, Math.round(mix.canopyTarget * D), {
      density: forestDensity, contrast: F.contrast ?? 1,
      tries: 9000, sep: 34, radius: [14, 84], spacing: F.spacing, maxMembers: 170,
    });
    placeClusters(mix.cover, mix.coverTarget, {
      density: coverDensity, contrast: 1.1,
      tries: 8000, sep: 21, radius: [7, 26], spacing: 4.6, maxMembers: 40,
    });

    // ---- HERO TREES ------------------------------------------------------
    // Isolated giants, deliberately placed where the forest is THIN.
    let heroes = 0;
    for (let i = 0; i < 12000 && heroes < mix.heroes; i++) {
      const x = rng.float(-half, half), z = rng.float(-half, half);
      if (forestDensity(x, z) > 0.42) continue;
      const e = envAt(x, z);
      if (!e || e.ny < 0.88) continue;
      if (isBlocked(x, z) || nearSpawn(x, z)) continue;
      const id = rng.pick(mix.heroSpecies);
      const spec = mix.canopy.find((s) => s.id === id) ?? mix.canopy[0];
      if (fitness(spec, e) <= 0.15) continue;
      const v = rng.int(0, VARIANTS - 1);
      const s = rng.float(1.15, 1.55);
      emit(id, v, { x, y: e.h - 0.15, z, s, r: rng.float(0, Math.PI * 2), tx: 0, tz: 0 });
      const entry = lib.get(`${id}#${v}`);
      if (entry.trunkR >= 0.6) this.colliders.push({ x, z, r: entry.trunkR * s * 0.55 });
      heroes++;
    }

    // ---- SHORELINE REEDS -------------------------------------------------
    let reedCount = 0;
    const reedTarget = B.id === 'desert' ? 90 : 420;
    for (let i = 0; i < 9000 && reedCount < reedTarget; i++) {
      const x = rng.float(-half, half), z = rng.float(-half, half);
      const h = T.heightAt(x, z);
      const above = h - wl;
      if (above < -0.35 || above > 1.9) continue;
      if (T.normalAt(x, z, 3).y < 0.90) continue;
      if (isBlocked(x, z)) continue;
      const v = rng.int(0, VARIANTS - 1);
      const sz = mix.shore.size;
      emit(mix.shore.id, v, {
        x, y: h - 0.3, z,
        s: sz[0] + rng.float(0, 1) * (sz[1] - sz[0]),
        r: rng.float(0, Math.PI * 2), tx: 0, tz: 0,
      });
      reedCount++;
    }

    // ---- BOULDERS & PEBBLES ---------------------------------------------
    // The reference's ambient texture: a wide, low-density pebble scatter with
    // occasional tight boulder groups. Small ones carry no collider.
    const rockTarget = Math.round(mix.pebbleTarget * (B.rockDensity ?? 1));
    let rocks = 0;
    for (let i = 0; i < rockTarget * 3 && rocks < rockTarget; i++) {
      const x = rng.float(-half, half), z = rng.float(-half, half);
      const h = T.heightAt(x, z);
      if (h < wl + 0.25) continue;
      if (isBlocked(x, z)) continue;
      const n = T.normalAt(x, z, 3.5);
      const rocky = clamp((1 - n.y) * 6, 0, 1);
      const field = fbm(x * 0.0052, z * 0.0052, { octaves: 3, seed: S + 431 });
      const p = 0.10 + rocky * 0.55 + Math.max(0, field) * 0.55;
      if (rng.float(0, 1) > p) continue;
      const t = Math.pow(rng.float(0, 1), 2.9);
      const s = lerp(0.45, 3.8, t) * (1 + rocky * 0.45);
      if (s > 1.6 && nearSpawn(x, z)) continue;
      const v = rng.int(0, VARIANTS - 1);
      emit(mix.boulder, v, {
        x, y: h - s * 0.22, z, s,
        r: rng.float(0, Math.PI * 2),
        tx: rng.gauss(0, 0.09), tz: rng.gauss(0, 0.09),
        sy: rng.float(0.55, 0.95),
      });
      if (s > 3.0) this.colliders.push({ x, z, r: s * 0.45 });
      rocks++;
    }

    // ---- BAKE ------------------------------------------------------------
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    let tris = 0;

    for (const [key, list] of buckets) {
      if (!list.length) continue;
      const entry = lib.get(key);
      const inst = new THREE.InstancedMesh(entry.geo, mat, list.length);
      const instColors = new Float32Array(list.length * 3);
      const cr = new Rng((strHash(key) ^ 0x5bd1) >>> 0);
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        dummy.position.set(t.x, t.y, t.z);
        dummy.rotation.set(t.tx ?? 0, t.r, t.tz ?? 0);
        dummy.scale.set(t.s, t.s * (t.sy ?? 1), t.s);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
        // Near-white multiplier: value plus a touch of colour temperature.
        const k = cr.float(0.84, 1.14);
        const w = cr.float(-0.055, 0.055);
        col.setRGB(k * (1 + w), k, k * (1 - w));
        instColors[i * 3] = col.r; instColors[i * 3 + 1] = col.g; instColors[i * 3 + 2] = col.b;
      }
      inst.instanceColor = new THREE.InstancedBufferAttribute(instColors, 3);
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      inst.name = key;
      this.group.add(inst);
      tris += (entry.geo.attributes.position.count / 3) * list.length;
    }

    this.stats = {
      instances: Object.values(this.counts).reduce((a, b) => a + b, 0),
      tris, kinds: buckets.size,
    };
    return this.group;
  }
}
