import * as THREE from 'three';
import { Rng, fbm } from '../core/rng.js';
import { GeoBuilder, rockGeom, slabGeom, derivePalette } from './buildkit.js';

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
  // Open-ended: the trunk's top disappears inside the lowest tier and its
  // bottom is in the turf, so both caps are ten triangles of nothing. Same
  // reasoning for the tier cones below. Across ~30k conifers this is worth
  // about a million triangles, which is what pays for the extra trees.
  b.cyl(tr * 0.8, tr * 1.5, trunkH + 1.6, 5, K.bark, { y: (trunkH + 1.6) / 2, open: true });
  let y = trunkH;
  // Broader skirt, slightly shorter tiers than v1. Measured off target_01: the
  // conifers there are about a third as wide as they are tall, with the lowest
  // tier clearly the widest. Ours were nearer a fifth, which read as spikes.
  let r = rng.float(2.45, 3.35) * wide;
  for (let i = 0; i < tiers; i++) {
    const h = rng.float(3.1, 4.3) * tall * (1 - i * 0.05);
    // Dark at the skirt, lighter at the tip. The reference's conifers all read
    // this way — a deep shadowed core with sunlit new growth on top — and it is
    // what stops a stand of firs from being one flat green mass.
    const c = K.leafRamp[Math.min(K.leafRamp.length - 1, Math.floor((i / Math.max(1, tiers - 1)) * K.leafRamp.length))];
    b.cone(r, h, rng.int(5, 7), c, { y: y + h / 2, ry: rng.float(0, 1.2), open: true });
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

function flowerPatch(rng, K, colIdx, o = {}) {
  // Reference read: a SPRINKLE of tiny specks with green showing between every
  // one of them — never a coloured mat. Two things used to break that.
  //
  //   1. A tinted "bed" disc under the spray. K.meadow is a dark linear-space
  //      green, so meadow.lerp(near-white, 0.07) rendered as a SLATE-BLUE
  //      heptagon roughly six metres across, and every patch read as a doormat
  //      thrown on the lawn. Measured in shots/mine: the disc was the darkest
  //      thing in the meadow. It is gone; the turf under a drift is just turf.
  //   2. Blooms 0.22-0.36 units across an instance scaled up to 1.5 — a metre
  //      -wide daisy, ~14 px at the hero camera. In target_01 a bloom is 2-3 px.
  //      They are now ~10 cm, and there are a third as many, spread over the
  //      same footprint so the patch is a scatter rather than a blob.
  //
  // ROUND 4: the cut went too far. Two rounds ago the meadow was confetti; last
  // round a hero frame contained about a dozen white specks in total and the
  // grass read as mown. target_01 has a STEADY sprinkle — you are never more
  // than a few metres from a bloom, but they never form a coloured mat. So the
  // patch keeps its loose even-area scatter and gets half again as many heads,
  // and the weights in the mix below carry the rest of the difference.
  //
  // The heads and stems are open-ended cones now (no base cap, which is buried
  // in grass anyway), so a 12-bloom patch costs FEWER triangles than the old
  // 7-bloom one.
  const b = new GeoBuilder();
  // Tighter footprint. At 1.8-3.2 m a drift of a dozen blooms was spread over
  // 30 m² and read as isolated specks; in target_01 a drift is a handful of
  // flowers you could cover with a doormat, with clear grass all round it.
  const R = rng.float(1.25, 2.30) * (o.spread ?? 1);
  const c = o.color ?? K.accents[colIdx % K.accents.length];
  const n = rng.int(8, 14);
  for (let i = 0; i < n; i++) {
    // Even-area scatter (sqrt), not a dense core. The old 0.62 exponent piled
    // most of the blooms into the middle, which is what made a patch read as
    // one coloured object instead of as individual flowers in grass.
    const a = rng.float(0, Math.PI * 2);
    const d = Math.sqrt(rng.float(0.06, 1)) * R;
    const s = rng.float(0.10, 0.17);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    // A bloom is 3-5 px on screen; a 5-sided squat cone is indistinguishable
    // from an icosahedron there and a fraction of the cost.
    b.cone(s, s * 1.5, 5, c, { x, z, y: 0.32, open: true });
    // A hair-thin green stem. Without it a white speck floats; with it the
    // flower is planted in the grass, which is the reference's read.
    b.cone(0.035, 0.32, 4, K.grass[0], { x, z, y: 0.16, open: true });
  }
  // Two taller stems break the flat top of the drift. More than that and the
  // patch costs more triangles than a whole fir.
  for (let i = 0; i < 2; i++) {
    const a = rng.float(0, Math.PI * 2), d = rng.float(0, R * 0.8);
    b.cone(0.09, 0.60, 4, K.grass[1], { x: Math.cos(a) * d, z: Math.sin(a) * d, y: 0.30, open: true });
  }
  return { geo: b.build(), trunkR: 0, height: 0.7 };
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
    b.cone(rng.float(0.5, 0.85), h, 5, K.grass[i % K.grass.length], { y: h / 2, sz: 0.7, open: true });
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
    b.raw(rockGeom(rng, { jitter: 0.34 }), i % 3 === 0 ? K.scree : K.rockDark);
    b.pop();
  }
  return { geo: b.build(), trunkR: 0, height: 1 };
}

/**
 * The alpine reference's hero rock: a pale grey block, flat-topped, bedded into
 * the turf, with one or two smaller blocks leaning on it. Two tone steps only —
 * a bright top plane and a cool shadow side — so it reads as one solid at
 * distance instead of granular noise.
 */
function slab(rng, K, o = {}) {
  const b = new GeoBuilder();
  // Pale, slightly warm grey. Against a deep green meadow the rock has to be
  // clearly LIGHTER than the grass or it disappears into it — in the reference
  // the boulders are the brightest thing in the frame after the road.
  // Warm pale grey, from the palette's own road-edge tone. The reference's
  // boulders are a warm stone, not the cool blue-grey of the cliff colour, and
  // that warmth is what separates them from the meadow shadows.
  // Pale, but not paper. At 0.30 toward plasterWarm the meadow boulders came
  // out a milky tan that read lighter than the road; the reference's stones are
  // a warm mid-grey that still sits a clear step above the grass.
  // Landed at 0.20 after shooting 0.30 (milky tan, lighter than the road) and
  // 0.14 (a muddy mid-grey that sank into the meadow shadows). target_01's
  // meadow blocks are a pale WARM grey whose sunlit top is the brightest thing
  // in the grass without ever competing with the gravel.
  const body = K.rock.clone().lerp(K.rockDark, rng.float(0.0, 0.18)).lerp(K.plasterWarm, 0.20);
  b.raw(slabGeom(rng, { jitter: 0.24 }), body);
  const n = rng.int(1, 3);
  for (let i = 0; i < n; i++) {
    const s = rng.float(0.34, 0.62);
    const a = rng.float(0, Math.PI * 2), d = rng.float(0.85, 1.35);
    b.pushTilt(Math.cos(a) * d, -0.06, Math.sin(a) * d, rng.float(0, 6.28),
      rng.float(-0.16, 0.16), rng.float(-0.16, 0.16), s);
    b.raw(slabGeom(rng, { jitter: 0.26 }),
      K.rockDark.clone().lerp(K.rock, rng.float(0.35, 0.85)).lerp(K.plasterWarm, 0.10));
    b.pop();
  }
  if (o.snow) {
    const cap = slabGeom(rng, { jitter: 0.2, squash: 0.1 });
    cap.scale(0.98, 0.5, 0.98);
    cap.translate(0, 0.22, 0);
    b.raw(cap, K.snow);
  }
  return { geo: b.build(), trunkR: 1, height: 1 };
}

function boulder(rng, K, o = {}) {
  const b = new GeoBuilder();
  const body = K.rock.clone().lerp(K.rockDark, rng.float(0.25, 0.70));
  b.raw(rockGeom(rng, { jitter: 0.28 }), body);
  if (rng.bool(0.5)) {
    const lump = rockGeom(rng, { jitter: 0.30 });
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
  // The bottom of the size ladder. The reference is full of knee-to-waist-high
  // conifers filling the gaps between the hero trees; without them the meadow
  // reads as mown.
  firSapling: (r, K) => fir(r, K, { tall: 0.30, wide: 0.42, tiers: 3 }),
  // Tall and slightly slim — NOT a needle. At wide: 0.72 with six tiers this
  // came out as a 22 m green spike about three metres across, which read as
  // litter rather than as a tree.
  firSpire: (r, K) => fir(r, K, { tall: 1.06, wide: 0.88, tiers: 5 }),
  firSnow: (r, K) => fir(r, K, { snow: true }),
  firSnowOld: (r, K) => fir(r, K, { snow: true, tall: 1.3, wide: 1.2, tiers: 5 }),
  scotsPine, broadleaf, birch, maple, snag, stump,
  saguaro, barrelCactus, ocotillo, scrub, windPine,
  bushDark: (r, K) => bush(r, K, K.bushDark),
  bushLight: (r, K) => bush(r, K, K.bushLight),
  flowersA: (r, K) => flowerPatch(r, K, 0),
  flowersB: (r, K) => flowerPatch(r, K, 1),
  flowersC: (r, K) => flowerPatch(r, K, 2),
  // Alpine's signature: drifts of white, and a softer cream-yellow. Derived
  // from the palette's own accents, never a hard-coded hex.
  flowersWhite: (r, K) => flowerPatch(r, K, 0, {
    color: K.accents[K.accents.length - 1].clone().lerp(K.accents[1], 0.10),
    spread: 1.15,
  }),
  flowersCream: (r, K) => flowerPatch(r, K, 0, {
    color: K.accents[K.accents.length - 1].clone().lerp(K.accents[1], 0.22),
  }),
  // Alpine's red drift, read off target_01: a MUTED BRICK, not the pure signal
  // red the palette keeps for corner boards. Straight accents[0] at flower
  // scale scattered brake lights through the meadow.
  flowersRed: (r, K) => flowerPatch(r, K, 0, {
    color: K.accents[0].clone().lerp(K.plasterWarm, 0.26),
    spread: 0.82,
  }),
  reeds, tussock, screePatch,
  boulder, slab,
  boulderSnow: (r, K) => boulder(r, K, { snow: true }),
  slabSnow: (r, K) => slab(r, K, { snow: true }),
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
    // Densities measured off ref/target_01: roughly 2.5k conifers and 8k ground
    // -cover items per km², with NO bare stretch wider than about 40 m. The old
    // numbers were a third of that and left 200 m holes in the meadow.
    // The route runs from 6 m to 76 m above the water line (measured), while the
    // backdrop ridges reach 350 m+. So the tree line is set at ~110-140 m: the
    // WHOLE drivable band is wooded meadow — no more bald stretches where the
    // road happens to climb — and the far ridges still go bare, which is where
    // the frame gets its distance.
    // ROUND 4. Counted off target_01: a ~77 x 43 m frame there holds about 85
    // conifers, i.e. ~25 000/km². We were placing 20 500 over a 2.89 km² map —
    // 7 100/km², a QUARTER of the reference — and the shortfall is why a hero
    // frame can look like mown lawn while a frame 200 m away looks like forest.
    // 32 000 lands at ~11 000/km²; the rest of the gap is closed by `singles`
    // and by the copse floor below rather than by piling more into the stands.
        // Tried 50 000 / 11 000 to close the last of the density gap to target_01
    // and had to back it out: drift_alpine finished at 90 km/h instead of 131,
    // i.e. the car was clipping trunks all the way round. Past this point more
    // conifers cost the DRIVE, and this is a playable demo before it is a
    // screenshot. 44 000 / 7 400 is where the two curves cross.
    canopyTarget: 44000, coverTarget: 32000, pebbleTarget: 9000, heroes: 430, singles: 7400, moistScale: 90,
    // macro/meso are the WAVELENGTHS of the two noise scales that decide where
    // wood wants to be. At macro 0.0016 the pattern repeated every ~620 m —
    // wider than the whole visible frame — so any single shot landed entirely
    // on one side of it: solid wood left, bare meadow right. At 0.0034 / 0.0115
    // the pattern turns over every ~290 m and ~87 m, so a 300 m frame always
    // contains both thick clumps and open ground, which is the reference's
    // rhythm. `contrast` is flattened for the same reason.
    // `contrast` dropped again (0.26 -> 0.14). It is the exponent on the density
    // field, and every notch of it is a notch of "wood on one side of the frame,
    // meadow on the other" — the exact regression this round is meant to kill.
    // target_01 has conifers in all four quadrants; what varies between them is
    // how CLOSE TOGETHER they are, not whether there are any.
    forest: { macro: 0.0034, meso: 0.0115, rich: 0.42, bare: 0.02, spacing: 7.4, contrast: 0.14, coverBare: 0.04 },
    // `sep` is the metres between copse CENTRES, and it alone decides whether a
    // clump is a wood or a bush. Round 2 ran sep 26 with an 84 m footprint: the
    // copses overlapped into a continuous forest edge. Dropping sep to 18 went
    // straight past the answer — 3000 centres shared 16 000 trees, five apiece,
    // and the meadow filled with green pimples. At sep 44 the map carries about
    // 450 stands of 20-45 trees with clear grass between them, which is the
    // rhythm target_01 actually has. Landed at 30 after shooting both ends: 44
    // put roughly a dozen stands in a hero frame and the shot could fall in a
    // gap, 18 made pimples. 30 gives ~1100 stands of 15-30, so any frame holds
    // six or eight clumps AND the meadow between them.
    // `base` is the floor probability that a copse centre is accepted where the
    // field says "open". At 0.66 a third of the acceptance still came from the
    // field, and the field is smooth over ~290 m — wider than the frame — so
    // whole shots landed on its low side. At 0.86 the field only decides how
    // BIG a stand is, never whether the quadrant gets one. `sep` down from 30
    // to 25 and `radius` widened at the bottom end so the size ladder runs from
    // three-tree groups to proper stands rather than clones of one footprint.
    clump: { tries: 34000, sep: 25, radius: [7, 33], maxMembers: 34, base: 0.86, kMax: 3.4 },
    canopy: [
      // Sizes calibrated against target_01: the hero conifers there stand about
      // 20 m and 7-8 m across the skirt, roughly five car lengths tall. Our
      // trees were topping out at 12 m, which is why the meadow looked like a
      // model railway however many of them were placed.
      // A base `fir` is ~17 m at scale 1, so these caps put the hero trees at
      // 24-26 m and the young ones around 10-14 m. Measured against target_01,
      // where the tallest conifers are about five car lengths: an earlier pass
      // ran the cap up to 2.5 and grew 40 m trees that dwarfed the car.
      // Weighted toward FULL-SIZE trees. At 2.6 / 2.2 the young and sapling
      // firs were a third of the canopy and the open half of the frame filled
      // with knee-high green lumps that read as scrub, not as woodland.
      // ROUND 4 sizes. Measured on target_01 with the car as the ruler: the tall
      // conifers there are ~4.2 m across the skirt and ~12 m to the tip. Ours
      // were 6.3 m by 15 m — a third oversized — and an oversized tree is not
      // just a big tree, it is a tree you can only afford a third as many of.
      // Smaller trees, many more of them: that trade is the whole difference
      // between our meadow and the reference's.
      // `flat` is a MINIMUM terrain normal.y, and it was the hidden cause of the
      // "trees all on one side" regression. Probing the hero frame: the ground
      // west of the road rolls down toward the tarn at normal.y 0.70-0.74, just
      // under the fir gate, so that whole hillside could grow bushes and nothing
      // else — a bald slope beside a wooded one, in every frame that contained
      // a slope. 0.62 is still a 52 degree limit; conifers manage far worse, and
      // the reference has them standing on visibly tilted ground throughout.
      { id: 'fir', w: 6.4, alt: [1, 5, 135, 195], wet: [0, 0.12, 0.95, 1.15], flat: 0.62, size: [0.70, 1.32] },
      { id: 'firOld', w: 2.6, alt: [2, 8, 118, 168], wet: [0, 0.15, 0.95, 1.15], flat: 0.66, size: [0.82, 1.24] },
      { id: 'firSpire', w: 2.2, alt: [2, 7, 135, 195], wet: [0, 0.12, 0.95, 1.15], flat: 0.64, size: [0.75, 1.26] },
      { id: 'firYoung', w: 1.9, alt: [1, 5, 145, 210], wet: [0, 0.08, 1.0, 1.2], flat: 0.58, size: [0.85, 1.80] },
      { id: 'firSapling', w: 1.1, alt: [1, 4, 155, 235], wet: [0, 0.05, 1.05, 1.25], flat: 0.52, size: [0.9, 2.1] },
      // Kept deliberately low: target_01 is a conifer meadow. Round canopies
      // are the accent, not the crop.
      // A copse picks ONE dominant species and then keeps it for three quarters
      // of its members, so a broadleaf weight of 1.0 does not mean "one tree in
      // eight is round" — it means one stand in eight is entirely round-topped,
      // and a whole blob-canopy grove landed in the right of the hero frame.
      // target_01 has no round canopies at all. These stay only as a rare
      // single-tree note in damp hollows.
      { id: 'broadleaf', w: 0.30, accent: true, alt: [1, 5, 30, 46], wet: [0.35, 0.60, 1.05, 1.2], flat: 0.70, size: [0.9, 1.4] },
      { id: 'birch', w: 0.22, accent: true, alt: [2, 8, 38, 58], wet: [0.30, 0.55, 1.0, 1.2], flat: 0.70, size: [0.9, 1.3] },
      // No snags in alpine. A dead pole reads from 200 m up as a two-tone stub
      // — bright sunlit face, near-black shadow face — and the copse pass will
      // happily make one the dominant species of a whole stand, which put
      // fields of black dots through the meadow. The reference has none.
    ],
    heroSpecies: ['firOld', 'firSpire', 'fir'],
    cover: [
      { id: 'bushDark', w: 1.7, alt: [1, 4, 150, 230], wet: [0, 0.08, 1.05, 1.2], flat: 0.60, size: [0.7, 1.4] },
      { id: 'bushLight', w: 0.8, alt: [1, 4, 120, 180], wet: [0.05, 0.22, 1.05, 1.2], flat: 0.60, size: [0.7, 1.3] },
      // Flowers are an ACCENT, not a crop. At w 4.4 / 1.7 / 1.0 they were 45%
      // of all ground cover and the meadow came out as confetti. In target_01
      // you can count the drifts in a frame on two hands. The weight that used
      // to go to blooms goes to tussock instead — grass, which is what the
      // reference actually fills its meadow with.
      // ROUND 4 recalibration. At 1.5 / 0.42 / 0.30 out of a 13.3 total the
      // blooms were 16% of ground cover and a hero frame held about a dozen
      // white specks — the reference holds well over a hundred. White is the
      // dominant note by a wide margin, cream is the quiet second, and red is
      // the rare one you notice twice a frame. `flat` relaxed from 0.86 so
      // drifts also take the gentle rolls, not only the billiard-flat shelves.
      { id: 'flowersWhite', w: 4.4, alt: [1, 4, 120, 180], wet: [0, 0.12, 1.05, 1.2], flat: 0.80, size: [0.85, 1.35] },
      { id: 'flowersCream', w: 1.05, alt: [2, 5, 110, 160], wet: [0.05, 0.2, 1.05, 1.2], flat: 0.82, size: [0.8, 1.25] },
      { id: 'flowersRed', w: 0.72, alt: [2, 5, 95, 140], wet: [0.1, 0.3, 1.05, 1.2], flat: 0.84, size: [0.8, 1.2] },
      { id: 'tussock', w: 6.8, alt: [1, 3, 190, 300], wet: [0, 0.04, 1.05, 1.2], flat: 0.60, size: [0.9, 1.9] },
      { id: 'screePatch', w: 1.2, alt: [120, 190, 300, 430], wet: [0, 0, 0.6, 0.9], flat: 0.0, flatMax: 0.88, size: [0.7, 1.3] },
    ],
    shore: { id: 'reeds', size: [0.8, 1.5] },
    boulder: 'boulder',
    slab: 'slab',
    verge: {
      count: 4200, width: 13,
      mix: [
        { id: 'flowersWhite', w: 0.22 },
        { id: 'tussock', w: 0.20 },
        // A few real trees on the verge, not just saplings. In target_01 the
        // wood closes to within a couple of metres of the gravel in places and
        // that is what stops the road looking drawn on rather than cut through.
        { id: 'firYoung', w: 0.08 },
        // Roadside stone. In target_01 there is a pale block within a couple of
        // metres of the gravel every hundred metres or so, and it is the single
        // clearest scale cue the frame has — bigger share than the flowers.
        { id: 'slab', w: 0.17 },
        { id: 'flowersCream', w: 0.06 },
        { id: 'bushDark', w: 0.10 },
        // Young conifers crowding the verge: in the reference the wood comes
        // right down to the fence line, and the road's keep-out band is the
        // only reason ours does not.
        { id: 'firSapling', w: 0.17 },
        { id: 'flowersRed', w: 0.05 },
      ],
    },
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
    // Conifer tier ramp, darkest first, sorted by luminance so it is correct
    // whichever way the palette pushed the foliage.
    //
    // NOTE the offsets are TINY. THREE.Color works in linear space, so a
    // palette green like #2f7d43 has an HSL lightness of ~0.12, not ~0.34 — a
    // "-0.075" nudge that looks harmless in sRGB terms takes it to near-black,
    // which is exactly what happened on the first attempt: every fir grew a
    // black skirt. Everything here is expressed as a step off the same `dir`
    // the leaf colours already use.
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const leafRamp = [
      shade(a, j + dir * 0.005, 0.045),
      shade(a, j + dir * 0.045, 0.02),
      shade(b2, j + dir * 0.085, -0.01),
      shade(b2, j + dir * 0.125, -0.045),
    ].sort((p, q) => lum(p) - lum(q));

    return {
      ...D,
      leaf,
      leafRamp,
      leafPale: leaf.map((c) => shade(c, 0.10, -0.05)),
      meadow: shade(new THREE.Color(p.ground[1]), -0.05, 0.07),
      // Grass tufts were derived from the CANOPY green and from ground[1], the
      // darkest rung of the terrain ramp. Both are far darker than the meadow
      // the tufts actually stand in, so a tussock rendered as a black fleck and
      // 15 000 of them peppered the alpine meadow with soot. The meadow the
      // camera sees is ramp indices 2-3, so the tufts are derived from THOSE —
      // one step down and one step up, barely distinct from the grass, which is
      // exactly how the reference's tufts read.
      // ...but not so close that they vanish. First pass at this landed the
      // tufts ON the meadow colour and the grass went smooth: target_01's tufts
      // are a clearly DARKER, greener clump than the yellow-green sward around
      // them, and that speckle is a lot of the reference's ground texture.
      // Halfway down the ramp from the meadow toward the dark rung.
      grass: [
        new THREE.Color(p.ground[2]).lerp(new THREE.Color(p.ground[1]), 0.55),
        new THREE.Color(p.ground[2]).lerp(new THREE.Color(p.ground[3]), 0.50),
      ],
      reed: shade(leaf[0], -0.02, 0.05),
      reedTip: shade(new THREE.Color(p.ground[3]), -0.02, 0.04),
      // Was -0.04 / -0.06. On a linear-space green already sitting near L=0.13
      // that produced near-black lumps that read as holes punched in the
      // meadow — the frame had two dozen of them. A shrub in target_01 is a
      // DARKER GREEN than the grass, not a shadow.
      bushDark: [shade(leaf[1], -0.012, 0.02), shade(leaf[2], -0.022, 0.04)],
      // Same linear-space caution again: +0.06/+0.09 turned the light bushes
      // into mint-green sweets that outshone the meadow. A pale shrub in
      // target_01 is barely a step off the grass.
      bushLight: [shade(leaf[0], 0.026, -0.02), shade(leaf[2], 0.042, -0.03)],
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
    if (mix.slab) need.add(mix.slab);
    if (mix.verge) for (const m of mix.verge.mix) need.add(m.id);
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

    /**
     * A point just outside the road's keep-out band, i.e. ON THE VERGE.
     *
     * `isBlocked` is the only road query props are handed, so the verge is found
     * by landing inside the band and walking out of it: sample until a point is
     * blocked, pick a direction, step until it stops being blocked. That costs
     * about fifteen index lookups per hit and needs nothing new from the roads
     * contract — which matters, because the verge is where half the reference's
     * furniture lives and a uniform scatter never puts anything there.
     */
    const findVerge = (jitterMax = 9) => {
      for (let k = 0; k < 50; k++) {
        const x0 = rng.float(-half, half), z0 = rng.float(-half, half);
        if (!isBlocked(x0, z0)) continue;
        const a = rng.float(0, Math.PI * 2);
        const dx = Math.cos(a), dz = Math.sin(a);
        let d = 0;
        while (d < 70 && isBlocked(x0 + dx * d, z0 + dz * d)) d += 2.5;
        if (d >= 70) continue;
        const j = rng.float(0.5, jitterMax);
        return { x: x0 + dx * (d + j), z: z0 + dz * (d + j) };
      }
      return null;
    };

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
        // `base` is the floor probability — the chance a copse lands even where
        // the field says "open meadow". At 0.30 the field decided almost
        // everything and the map split into a solid wood on one side of the
        // route and bald grass on the other, which is exactly the failure the
        // reference does not have: target_01 has conifer clumps in EVERY
        // quadrant with meadow between them, not a forest edge running through
        // the frame. Raising the floor and flattening `contrast` turns the
        // field from a gate into a gentle bias.
        if (rng.float(0, 1) > (opt.base ?? 0.30) + (1 - (opt.base ?? 0.30)) * d) continue;
        let clash = false;
        for (const c of centres) {
          const dx = c.x - cx, dz = c.z - cz;
          if (dx * dx + dz * dz < sep2) { clash = true; break; }
        }
        if (clash) continue;
        const e = envAt(cx, cz);
        if (!e) continue;
        // Species marked `accent` may appear INSIDE a stand but may never be
        // its dominant. Without this, a 0.30-weight broadleaf still lands as
        // the dominant of one copse in eight, and because a copse keeps its
        // dominant for three quarters of its members that is a whole grove of
        // round canopies — which target_01 does not contain anywhere.
        const domList = list.filter((sp) => !sp.accent);
        const dom = pickSpecies(domList.length ? domList : list, e, rng);
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
      const k = nominal > 0 ? clamp(target / nominal, 0.03, opt.kMax ?? 2.2) : 0;
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
          // camera height and turns into visual grit. Measured against
          // target_01, where the hero conifers occupy ~8% of the frame height,
          // the old 1.25 exponent produced a stand of near-identical mid-size
          // trees; 1.05 keeps the young ones and lets the big ones get big.
          let s = sz[0] + (sz[1] - sz[0]) * Math.pow(rng.float(0, 1), 1.05);
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
          //
          // The gate is the tree's REAL HEIGHT, not its instance scale. Scale
          // means nothing on its own — `firSapling` at s=2.4 is a four metre
          // shrub while `firOld` at s=1.2 is a twenty metre tree — and gating
          // on scale alone quietly turned every sapling stand back into a
          // minefield the moment the size ranges were retuned.
          const entry = lib.get(`${spec.id}#${v}`);
          if (entry.trunkR >= 0.7 && entry.height * s >= 11) {
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
    // A copse of 190 members over an 84 m ellipse is not a copse, it is a
    // forest, and four of them adjacent is the wall that used to fill half the
    // hero frame. Alpine overrides this with many small stands instead: same
    // tree count, spread as clumps of 8-40 with meadow between them.
    const CL = mix.clump ?? {};
    placeClusters(mix.canopy, Math.round(mix.canopyTarget * D), {
      density: forestDensity, contrast: F.contrast ?? 1, base: CL.base,
      tries: CL.tries ?? 14000, sep: CL.sep ?? 26,
      radius: CL.radius ?? [12, 84], spacing: F.spacing,
      maxMembers: CL.maxMembers ?? 190, kMax: CL.kMax,
    });
    // Ground cover gets a HIGH probability floor. The canopy pass wants a
    // "copse, gap, copse" rhythm; ground cover does not — in the reference the
    // grass and the flower drifts are everywhere, thicker in places, and the
    // only thing a density field should do to them is vary how thick. With the
    // default 0.30 floor the drifts collected into the top quarter of the cover
    // mask and whole frames (hero_alpine) came out with a bare lawn.
    placeClusters(mix.cover, mix.coverTarget, {
      density: coverDensity, contrast: 1.0, base: 0.70,
      tries: 24000, sep: 13, radius: [5, 21], spacing: 4.2, maxMembers: 42,
    });

    // ---- ROAD VERGE DRESSING --------------------------------------------
    // In the reference the road has NO clean edge: flower drifts, grass tufts
    // and loose stones crowd right up to the gravel, and that soft encroaching
    // margin is most of what makes the road look driven-on rather than drawn
    // on. A map-wide scatter can never produce it, because the verge is 3% of
    // the map area and gets 3% of the props.
    const VERGE = mix.verge;
    if (VERGE) {
      let vplaced = 0;
      for (let i = 0; i < VERGE.count * 3 && vplaced < VERGE.count; i++) {
        const p = findVerge(VERGE.width ?? 9);
        if (!p) continue;
        const e = envAt(p.x, p.z);
        if (!e || e.ny < 0.80) continue;
        if (isBlocked(p.x, p.z)) continue;
        if (nearSpawn(p.x, p.z)) continue;
        let t = rng.float(0, 1), id = VERGE.mix[VERGE.mix.length - 1].id;
        for (const m of VERGE.mix) { t -= m.w; if (t <= 0) { id = m.id; break; } }
        const v = rng.int(0, VARIANTS - 1);
        // Roadside stone is the exception to the verge's uniform size range.
        // In target_01 the blocks sitting a metre off the gravel are car-sized
        // or bigger — that is the whole reason they read as a scale cue — and
        // at 0.75-1.45 ours were pebbles you had to hunt for.
        const s = id === mix.slab ? rng.float(1.1, 2.3) : rng.float(0.75, 1.45);
        emit(id, v, {
          x: p.x, y: e.h - (id === mix.slab ? s * 0.12 : 0.12), z: p.z, s,
          r: rng.float(0, Math.PI * 2),
          tx: rng.gauss(0, 0.03), tz: rng.gauss(0, 0.03),
        });
        // Verge trees are solid on the same rule the copse pass uses. Without
        // this a mature conifer a metre off the gravel is scenery you drive
        // straight through, which is worse than not having it.
        const ventry = lib.get(`${id}#${v}`);
        if (ventry.trunkR >= 0.7 && ventry.height * s >= 11) {
          this.colliders.push({ x: p.x, z: p.z, r: ventry.trunkR * s * 0.42 });
        }
        vplaced++;
      }
    }

    // ---- HERO TREES ------------------------------------------------------
    // Isolated giants, deliberately placed where the forest is THIN.
    let heroes = 0;
    for (let i = 0; i < 12000 && heroes < mix.heroes; i++) {
      const x = rng.float(-half, half), z = rng.float(-half, half);
      // "Open" is now judged against the flattened field: with `base` doing most
      // of the work the density term rarely drops below 0.4, and a 0.42 gate
      // meant heroes could only stand in the couple of hollows where the field
      // bottomed out — which is why every hero tree ended up on the same side.
      if (forestDensity(x, z) > 0.62) continue;
      const e = envAt(x, z);
      if (!e || e.ny < 0.82) continue;
      if (isBlocked(x, z) || nearSpawn(x, z)) continue;
      const id = rng.pick(mix.heroSpecies);
      const spec = mix.canopy.find((s) => s.id === id) ?? mix.canopy[0];
      if (fitness(spec, e) <= 0.15) continue;
      const v = rng.int(0, VARIANTS - 1);
      // A hero is the biggest thing in its part of the frame — the lone tree in
      // the meadow that gives the whole shot its scale. ~25-30 m.
      // Heroes shrank with everyone else. Now that a normal fir tops out at
      // ~1.3, a 1.5 hero was twice the height of its neighbours and read as a
      // mistake rather than as a landmark. Half again as tall is enough.
      const s = rng.float(1.16, 1.40);
      emit(id, v, { x, y: e.h - 0.15, z, s, r: rng.float(0, Math.PI * 2), tx: 0, tz: 0 });
      const entry = lib.get(`${id}#${v}`);
      if (entry.trunkR >= 0.6) this.colliders.push({ x, z, r: entry.trunkR * s * 0.55 });
      heroes++;
    }

    // ---- SCATTERED SINGLES -----------------------------------------------
    // target_01 is not "copse, gap, copse" alone. Between the stands there are
    // LONE conifers, one every 30-50 m, at ordinary sizes — and they are what
    // stops the meadow reading as a mown lawn laid between two woods. The
    // cluster pass can never make them (a copse of one is just a small copse),
    // and the hero pass only makes giants, so they get their own pass. It
    // deliberately prefers the OPEN ground the cluster pass skipped.
    const singles = Math.round((mix.singles ?? 0) * D);
    let lone = 0;
    for (let i = 0; i < singles * 26 && lone < singles; i++) {
      const x = rng.float(-half, half), z = rng.float(-half, half);
      if (rng.float(0, 1) > 1 - forestDensity(x, z) * 0.80) continue;
      const e = envAt(x, z);
      if (!e || e.ny < 0.66) continue;
      if (isBlocked(x, z) || nearSpawn(x, z)) continue;
      const spec = pickSpecies(mix.canopy, e, rng);
      if (!spec) continue;
      const sz = spec.size;
      // Skewed the other way from the copse pass: a tree standing alone in the
      // open is normally a mature one, not a sapling.
      const s = sz[0] + (sz[1] - sz[0]) * Math.pow(rng.float(0, 1), 0.72);
      const v = rng.int(0, VARIANTS - 1);
      emit(spec.id, v, {
        x, y: e.h - 0.15, z, s, r: rng.float(0, Math.PI * 2),
        tx: rng.gauss(0, 0.014), tz: rng.gauss(0, 0.014),
      });
      const entry = lib.get(`${spec.id}#${v}`);
      if (entry.trunkR >= 0.7 && entry.height * s >= 11) {
        this.colliders.push({ x, z, r: entry.trunkR * s * 0.42 });
      }
      lone++;
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
    // Two habits, both taken straight off the reference:
    //
    //   GROUPS  a big flat-topped block with two or three smaller ones fallen
    //           around it. Sizes inside a group span pebble -> larger-than-car,
    //           which is what gives the frame its sense of scale.
    //   SCATTER a thin ambient sprinkle of small stones so the meadow floor is
    //           never an empty plane between the groups.
    //
    // Groups are biased toward the ROAD VERGE. `isBlocked` is the only road
    // query props are given, so the verge is found by probing outward: a point
    // that is itself clear but has blocked ground a few metres away is a
    // roadside. Cheap, and it needs nothing new from the roads contract.
    const rockId = mix.slab ?? mix.boulder;
    const nearRoad = (x, z, probe) =>
      !isBlocked(x, z) && (
        isBlocked(x + probe, z) || isBlocked(x - probe, z) ||
        isBlocked(x, z + probe) || isBlocked(x, z - probe));

    const rockTarget = Math.round(mix.pebbleTarget * (B.rockDensity ?? 1));
    let rocks = 0;

    const dropRock = (x, z, s, id) => {
      const h = T.heightAt(x, z);
      if (h < wl + 0.25) return false;
      if (isBlocked(x, z)) return false;
      if (s > 1.6 && nearSpawn(x, z)) return false;
      const v = rng.int(0, VARIANTS - 1);
      // Half-buried, but only half. slabGeom now carries its mass ABOVE the
      // origin (see buildkit), so it only needs bedding in by a hand's depth;
      // rockGeom is still centred and wants a real third of itself sunk.
      const flat = id === mix.slab;
      emit(id, v, {
        x, y: h - s * (flat ? rng.float(0.10, 0.22) : rng.float(0.26, 0.42)), z, s,
        r: rng.float(0, Math.PI * 2),
        tx: rng.gauss(0, 0.05), tz: rng.gauss(0, 0.05),
        sy: flat ? rng.float(0.86, 1.18) : rng.float(0.62, 1.00),
      });
      if (s > 2.4) this.colliders.push({ x, z, r: s * 0.42 });
      rocks++;
      return true;
    };

    // -- groups
    const groupTarget = Math.round(rockTarget * 0.42);
    let grouped = 0;
    for (let i = 0; i < groupTarget * 14 && grouped < groupTarget; i++) {
      const cx = rng.float(-half, half), cz = rng.float(-half, half);
      const h = T.heightAt(cx, cz);
      if (h < wl + 0.4) continue;
      if (isBlocked(cx, cz)) continue;
      const n = T.normalAt(cx, cz, 3.5);
      const rocky = clamp((1 - n.y) * 6, 0, 1);
      const field = fbm(cx * 0.0052, cz * 0.0052, { octaves: 3, seed: S + 431 });
      // Meadow boulders matter as much as scree ones: in the reference a grey
      // block sitting in flat green grass is the strongest scale cue in the
      // frame. So the base rate is high enough that flat ground gets groups
      // too, and steepness only tilts the odds.
      const road = nearRoad(cx, cz, 7) ? 1 : 0;
      const p = 0.22 + rocky * 0.30 + Math.max(0, field) * 0.34 + road * 0.55;
      if (rng.float(0, 1) > p) continue;

      // One anchor block, then a train of smaller ones around it. The anchor is
      // deliberately car-sized or bigger: a boulder that is not clearly larger
      // than the car gives the frame no sense of scale at all.
      const big = lerp(1.7, 3.8, Math.pow(rng.float(0, 1), 1.5)) * (1 + rocky * 0.3);
      dropRock(cx, cz, big, rockId) && grouped++;
      const n2 = rng.int(2, 5);
      for (let k = 0; k < n2 && grouped < groupTarget; k++) {
        const a = rng.float(0, Math.PI * 2);
        const d = big * rng.float(0.8, 2.4);
        const s = big * rng.float(0.16, 0.55);
        if (dropRock(cx + Math.cos(a) * d, cz + Math.sin(a) * d, s, rockId)) grouped++;
      }
    }

    // -- ambient scatter
    for (let i = 0; i < rockTarget * 4 && rocks < rockTarget; i++) {
      const x = rng.float(-half, half), z = rng.float(-half, half);
      const n = T.normalAt(x, z, 3.5);
      const rocky = clamp((1 - n.y) * 6, 0, 1);
      const field = fbm(x * 0.0052, z * 0.0052, { octaves: 3, seed: S + 431 });
      const p = 0.12 + rocky * 0.55 + Math.max(0, field) * 0.5;
      if (rng.float(0, 1) > p) continue;
      const s = lerp(0.5, 2.4, Math.pow(rng.float(0, 1), 2.4)) * (1 + rocky * 0.4);
      dropRock(x, z, s, rng.bool(0.45) ? rockId : mix.boulder);
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
      // Blooms keep a tight, warm-neutral multiplier. The general 0.84-1.14 with
      // a colour-temperature twist is right for foliage and stone, but on a
      // 4 px white flower it produced grey and pale-blue specks — the reference
      // reads clean white throughout, and a grey daisy just looks like grit.
      const bloom = key.startsWith('flowers');
      // Canopy gets a tighter, downward-skewed range. At 1.14 the brightest
      // instances came out mint against target_01's deep, fairly uniform
      // conifer greens — a wood should hold three or four greens, not a
      // highlight that outshines the meadow.
      const canopy = /^(fir|scotsPine|broadleaf|birch|maple|windPine)/.test(key);
      const kLo = bloom ? 0.94 : canopy ? 0.86 : 0.84;
      const kHi = bloom ? 1.10 : canopy ? 1.055 : 1.14;
      const wAmp = bloom ? 0.012 : 0.055;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        dummy.position.set(t.x, t.y, t.z);
        dummy.rotation.set(t.tx ?? 0, t.r, t.tz ?? 0);
        dummy.scale.set(t.s, t.s * (t.sy ?? 1), t.s);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
        // Near-white multiplier: value plus a touch of colour temperature.
        const k = cr.float(kLo, kHi);
        const w = cr.float(-wAmp, wAmp);
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
    // Tuning aid, same shape as landmarks' `window.__LM`: what actually got
    // placed, per species. Density arguments are unwinnable without it.
    if (typeof window !== 'undefined') window.__PROPS = { ...this.stats, counts: this.counts };
    return this.group;
  }
}
