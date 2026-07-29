import * as THREE from 'three';
import { Rng, fbm } from '../core/rng.js';
import { GeoBuilder, rockGeom, slabGeom, blockGeom, firTier, firFrond, derivePalette } from './buildkit.js';

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

  // ---- WHAT THIS TREE IS, AND THE FOUR THINGS THAT WERE WRONG WITH IT ------
  //
  // Cropping target_01's fir at 6x beside ours settled a question three rounds
  // of proportion tuning could not: the difference is not size, it is that a
  // reference tier is a RING OF DROOPING TWO-FACET FLAPS and ours was a cone
  // with a jagged hem. See `firFrond` in buildkit for the measurement that
  // proves one rim ring cannot produce a value range — mirror facets share
  // normal.y to within 2%, so the whole tier renders as one green whatever the
  // jitter does. That is why round 8 widened the jitter to +/-30% and shot a
  // flat tree anyway.
  //
  // Held from earlier rounds, as negative results worth not repeating:
  //
  //   * FOUR TO SIX WIDELY SPACED TIERS is not what the reference has; that
  //     came back as a stack of paper triangles with sky between each pair.
  //     Its fir is eight or nine skirts with heavy overlap, and you read the
  //     tiers as ROWS OF DROOPING POINTS, not as gaps.
  //   * A trunk of 2.6-4.0 m read as a brown POLE with a conifer balanced on
  //     top. What shows below the skirt is a STUB — enough to plant the tree
  //     and put a slot of grass under it. Here it is derived: the bare part is
  //     ~7.5% of the tree's height, measured off the reference, and the trunk
  //     is then extended by the bottom tier's own droop so the skirt cannot
  //     swallow it (which is what hid it before: the tier started 1.2 m up and
  //     its 2.3 m skirt covered everything below).
  //   * Proportions land near 1:3 width:height. Under our camera, which is
  //     steeper than the reference's, height foreshortens and skirt does not,
  //     so a solid measuring 1:2 in metres renders as a green umbrella.
  //
  // Triangle budget: 4 per rim vertex pair, i.e. 2*seg per tier. A `fir` at
  // seg 12 and 8 tiers is ~210 triangles against the old 80. Across ~37 000
  // conifers that is about +4.6 M, spent on the subject of the frame.
  const tiers = o.tiers ?? rng.int(9, 11);
  /**
   * FLAP COUNT, SOLVED FOR PAD ASPECT — the reason our firs read as thistles.
   *
   * A flap is a triangle whose base is a chord of the shoulder ring and whose
   * apex is the tip out at r. Its base chord is `2*inner*r*sin(PI/half)` and its
   * radial length is `(1-inner)*r`, so at seg 14 / inner 0.34 the pads measured
   * 0.30r wide by 0.66r long — an aspect of 1:2.2, which is a THORN. Setting
   * base = length gives inner = 1/(1 + 2*sin(PI/half)):
   *
   *     half 4 (seg 8)  -> inner 0.41      half 6 (seg 12) -> inner 0.50
   *     half 5 (seg 10) -> inner 0.46      half 7 (seg 14) -> inner 0.54
   *
   * So FEWER, BROADER flaps per tier and MORE tiers — which is also what the
   * reference has, and it is cheaper: 10 tiers at seg 8 is 178 triangles against
   * 8 tiers at seg 14's 242. Swept a step PAST equilateral (inner 0.50 at seg 8,
   * i.e. pads wider than they are long) and that read denser and blunter again;
   * it only avoids the exposed-plateau failure because `crownK` came down with
   * it — a shallow crown of 0.22r has almost no vertical extent to show.
   */
  const seg = o.seg ?? 8;
  // Radius ladder first, because both the trunk length and the tier spacing are
  // derived from it — the old code advanced by a jittered fraction of the TIER
  // height, which made total height a random walk and is why "6-9 tiers" once
  // grew a 30 m mast.
  /**
   * THE PROFILE, AND WHY A CONSTANT TAPER CANNOT BE IT.
   *
   * A fixed shrink per tier is a geometric series, so the tree is a straight
   * cone whose top tier is still 45-50% of the base width — and above that
   * stump the leader had to be a big smooth triangle to reach a point at all.
   * On the sheet that read as a paper dart floating over the tree, which was the
   * single worst thing in the first shot of this geometry. A conifer's real
   * outline is nearly straight down the flanks and then closes FAST over the top
   * quarter, which is a power curve: (remaining/total)^e with e about 0.55 gives
   * a top tier under a third of the base and a leader that is a tip rather than
   * a hat.
   */
  const profE = o.profE ?? rng.float(0.50, 0.62);
  /**
   * DROOP, SWEPT AND MEASURED ON THE SHEET. At 0.62 of the tier radius the flap
   * tips protrude as long thin THORNS and the tree reads as a thistle; the
   * reference's tips barely clear the row below. 0.34-0.46 keeps the serration
   * (it is what the silhouette is made of) without the spikes.
   */
  const dropK = o.dropK ?? rng.float(0.38, 0.50);
  // `stepK` is the tier advance as a fraction of the tier's OWN radius, and it
  // has to stay a little above `dropK` or the tips of one skirt hang below the
  // shoulder of the next one down and the stack closes into a smooth cone. The
  // ratio that reads as "rows of drooping points" is about 1.15.
  const stepK = o.stepK ?? rng.float(0.42, 0.50);
  const rad = [];
  const r0 = rng.float(2.20, 2.70) * wide;
  for (let i = 0; i < tiers; i++) {
    rad.push(r0 * Math.pow((tiers - i) / tiers, profE) * rng.float(0.965, 1.035));
  }
  /**
   * WHORLS ARE EVENLY SPACED. The first version advanced each tier by a fraction
   * of its OWN radius, which packs the top of the tree into a smooth spike while
   * the bottom rows sit a metre and a half apart — and a smooth spike is what the
   * client is calling "no detail". Rows in target_01 are evenly spaced from the
   * skirt to the leader, so the step is a fraction of the tree's BASE radius,
   * with a fifth of the old proportional behaviour kept so the top rows tighten
   * a little as they narrow.
   */
  const step = rad.map((v) => stepK * (r0 * 0.80 + v * 0.20) * tall);
  const rise = step.reduce((a, c) => a + c, 0);
  const leaderH = rad[tiers - 1] * 2.4 * tall;
  const drop0 = dropK * r0 * tall;
  // The bare pole, as a fraction of the whole tree. 0.075 is read off the
  // reference: you see grass under the skirt and a stub of bark, never a leg.
  // 0.075 of the tree's height was not enough to SEE: at 60-100 px per tree that
  // is four pixels, and the bottom skirt hangs over it. In target_01 the bare
  // pole under a fir is closer to an eighth of the whole tree and you can read
  // grass under the skirt on every one of them.
  const trunkH = drop0 + (o.bareK ?? 0.13) * (rise + leaderH);
  // ...and SLIMMER. At rBot = 1.7*tr the pole was 0.8 m across on a 13.6 m tree,
  // 6% of its height against the reference's 3-4%, and a six-sided pole that wide
  // shows two or three faces at this camera — so it read as a brown WEDGE rather
  // than as a trunk.
  const tr = rng.float(0.13, 0.175) * wide * (1 + tiers * 0.018);
  // Open-ended and six-sided: the top is inside the canopy and the bottom is in
  // the turf, so both caps are pure waste. It runs up past the second tier's
  // shoulder so no gap can open between bark and needles.
  const trunkLen = trunkH + r0 * 1.1;
  b.raw(new THREE.CylinderGeometry(tr * 0.70, tr * 1.28, trunkLen, 6, 1, true)
    .translate(0, trunkLen / 2, 0), K.trunkBark);

  let y = trunkH;
  const NR = K.leafRamp.length;
  for (let i = 0; i < tiers; i++) {
    const r = rad[i];
    // Dark at the skirt, lighter toward the tip: the reference's conifers are a
    // deep shadowed core with sunlit new growth on top, and that gradient is
    // what stops a stand of firs from being one flat green mass. The BODY rung
    // climbs; the lit rung is always the top of the ramp, because the mosaic
    // wants the whole ramp inside every tier, not the two rungs either side of
    // the tier's own. Measured on target_01's fir at 8x, one skirt spans
    // #2a4d22 to #86b054 — a factor of three in luminance.
    const t = tiers > 1 ? i / (tiers - 1) : 1;
    /**
     * THE VERTICAL GRADIENT, and it is the other half of "reads as a lit volume".
     *
     * The tier ramp gives a fir its light-and-dark WITHIN a row; this gives it
     * light and dark DOWN THE TREE, and side by side with target_01 that is the
     * more obvious of the two. A reference fir's bottom third is almost entirely
     * #172e17 — the single most common colour in its frame, 9.4% of pixels, and
     * ours held 4.6% — while its top third carries the yellow-green highlight.
     * Ours stepped through four rungs of `leafRamp` that span a factor of 1.4 in
     * total, which is not a gradient, it is a rounding error.
     *
     * `t*t` rather than `t`, because the dark part of a reference fir is the
     * bottom HALF, not the bottom eighth: a linear ramp put the midpoint colour
     * at mid-height and the skirt never got dark.
     */
    // The body climbs to the SECOND rung, not the third. A high albedo brightens
    // a tree's shadow side as well as its lit side — the ramp cannot know where
    // the sun is, because instances are randomly yawed — so pushing the lit
    // anchor up cost the frame its mid-dark population: luma bucket 1 fell from
    // 14.9% to 10.6% against the reference's 15.0%. Taking the body ladder a rung
    // down puts it back without touching the highlight.
    const body = K.leafShade.clone()
      // Floor at 0.42, not 0.20. Masking the frame at L < 0.10 showed 3.4% of it
      // (against the reference's 1.0%) is the anti-sun flank of the LOWEST tiers,
      // whose body was effectively `leafShade` itself — and a shade albedo lit by
      // ambient alone falls off the bottom of the scale. The gradient still runs
      // dark-to-light; it just no longer starts at the shadow anchor.
      // The TOP of the gradient is the brightest body rung, not the second
      // darkest. This is where the frame's foliage brightness actually lives:
      // measured, three quarters of the reference's foliage pixels sit above 129
      // while three quarters of ours sat above 94, and those are the up-facing
      // frill tops at moderate normal.y — i.e. BODY colour, not highlight. Raising
      // `leafSun` could never reach them, because the area-weighted normal.y
      // histogram puts only 2.5% of a fir above 0.8.
      .lerp(K.leafRamp[NR - 2], 0.30 + 0.70 * t * t);
    const litc = K.leafRamp[NR - 1].clone().lerp(K.leafSun, 0.25 + 0.75 * t);
    b.push(0, y, 0, rng.float(0, Math.PI * 2));
    b.rawLit(
      firFrond(r, r * (o.crownK ?? 0.22), dropK * r * tall, seg,
        { inner: o.inner, notch: o.notch, notchK: o.notchK }, rng),
      body, litc,
      /**
       * THE RAMP WINDOW IS SOLVED FROM THE GEOMETRY, not tuned by eye.
       *
       * `firFrond` hands `mergeColored` normal.y in three clean bands — crown
       * facets 0.86, flap halves 0.44, notch walls about 0.00 — so the window
       * only has to put one band at each end of the ramp and the middle band in
       * the middle. Solving for that:
       *
       *     t0 0.18, t1 0.78, l0 -0.02  ->  notch 3% toward body (i.e. shade),
       *                                     flap 42% toward lit, crown 100%
       *
       * The previous window (0.06 / 0.80 / -0.26) put the notch wall 93% of the
       * way to the BODY colour, which is why a tier with three geometric bands
       * still rendered as one green: the ramp was reading them all as "up".
       */
      /**
       * THE WINDOW IS SOLVED FROM AN AREA-WEIGHTED normal.y HISTOGRAM of the
       * actual geometry (scratch/nyhist.mjs), not tuned by eye. For a `fir`:
       *
       *     ny   0.0   0.1   0.2   0.3   0.4   0.5   0.6   0.7   0.8
       *     %   11.6   3.9   6.9   2.2  10.0  18.5  15.3  26.7   2.5
       *
       * i.e. the notch walls sit at 0.0 and nothing at all reaches 0.9 — so a
       * window ending at t1 0.86 put 29% of the tree's AREA at 83-98% of the way
       * to the lit rung, and the whole canopy went a stop bright: frame mean luma
       * 0.380 -> 0.404 against a 0.379 target, and % dark 33.1 -> 24.4. Ending
       * the ramp at 1.00 (above anything the geometry produces) makes the lit
       * rung a highlight again, and starting it at 0.35 with l0 at 0 hands the
       * whole 0.0-0.3 population — 24% of the area — to the shadow rung, which is
       * where the reference's missing #172e17 lives.
       */
      /**
       * WHERE THE FRAME'S BRIGHTNESS ACTUALLY COMES FROM. Re-running the
       * area-weighted normal.y histogram after the flaps were widened:
       *
       *     ny   0.0  0.1  0.2  0.3  0.4  0.5  0.6  0.7  0.8
       *     %   16.0  2.1  7.2  7.6 11.0 12.2 11.0 27.6  2.1
       *
       * — one band, ny 0.7, holds 28% of a fir's area, and it is the band the
       * camera sees most of. Whatever fraction of the lit rung THAT band gets is
       * the canopy's brightness, and at t1 0.86 it was 54% of the way to a 2.6x
       * anchor, i.e. 2.16x the palette green against the old ramp's brightest rung
       * at 1.80x. That alone was +0.011 on the frame mean. t1 1.10 puts the band
       * back near 1.87x and leaves the genuinely shallow crown facets as the
       * highlight, which is what a highlight is.
       *
       * Raising t0 does nothing about it — the band is above t0 either way. That
       * is the sort of thing the histogram tells you and eyeballing does not.
       */
      { t0: 0.52, t1: 1.10, low: K.leafShade, l0: 0.04 },
    );
    b.pop();
    // Snow only settles on the upper tiers — a white cap, not white frosting.
    if (o.snow && i >= tiers - 3) {
      b.cone(r * 0.52, r * 0.62, 6, K.snow, { y: y + r * 0.30 });
    }
    y += step[i];
  }
  // The leader: a thin spire above the last full skirt. A `firFrond` is wrong
  // here — its crown facets would go steep and dark — so this stays a star cone
  // in the lit rung, which is what the reference's tip is.
  b.push(0, y - step[tiers - 1] * 0.55, 0, rng.float(0, Math.PI * 2));
  // ...and it must NOT take the full lit rung. A leader is a cone, so all of its
  // facets sit in one narrow normal.y band; handed `leafSun` at t1 0.62 every
  // tree in the frame grew a pale paper dart on top of a dark body, which is a
  // worse read than the blunt stack it replaced.
  b.rawLit(firTier(rad[tiers - 1] * 0.86, leaderH, 6, leaderH * 0.20, 0.60, rng),
    K.leafRamp[NR - 2], K.leafRamp[NR - 1].clone().lerp(K.leafSun, 0.45),
    { t0: 0.30, t1: 0.90, low: K.leafRamp[0], l0: -0.10 });
  b.pop();
  return { geo: b.build(), trunkR: Math.max(0.75, tr * 2.4), height: y - step[tiers - 1] * 0.55 + leaderH };
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
  // ROUND 5: halved. At R up to 2.2 with an instance scale up to 1.4 a single
  // shrub was a six-metre green ball — as wide as a conifer's skirt and, being
  // a smooth blob, far more conspicuous. Three of them landed in the hero frame
  // and read as round-canopy trees, which is the exact note the reference does
  // not have. In target_01 a shrub is knee-to-waist high: something you notice
  // as texture in the grass, never as an object.
  const R = rng.float(0.55, 1.25);
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
  const n = rng.int(9, 15);
  for (let i = 0; i < n; i++) {
    // Even-area scatter (sqrt), not a dense core. The old 0.62 exponent piled
    // most of the blooms into the middle, which is what made a patch read as
    // one coloured object instead of as individual flowers in grass.
    const a = rng.float(0, Math.PI * 2);
    const d = Math.sqrt(rng.float(0.06, 1)) * R;
    const s = rng.float(0.105, 0.155);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    // A bloom is 3-5 px on screen; a 5-sided squat cone is indistinguishable
    // from an icosahedron there and a fraction of the cost.
    b.cone(s, s * 0.95, 5, c, { x, z, y: 0.34, open: true });
    // A hair-thin green stem. Without it a white speck floats; with it the
    // flower is planted in the grass, which is the reference's read.
    b.cone(0.035, 0.32, 4, K.grass[0], { x, z, y: 0.16, open: true });
  }
  // Two taller stems break the flat top of the drift. More than that and the
  // patch costs more triangles than a whole fir.
  for (let i = 0; i < 2; i++) {
    const a = rng.float(0, Math.PI * 2), d = rng.float(0, R * 0.8);
    b.cone(0.09, 0.60, 4, K.grassLit.clone().lerp(K.grass[1], 0.35), { x: Math.cos(a) * d, z: Math.sin(a) * d, y: 0.30, open: true });
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
  // One or two blades per tuft carry the sunlit crown, the rest stay at or
  // below the sward. A whole tussock in `grassLit` reads as a dead straw
  // clump; one lit blade among four reads as grass with light on it, and 20 000
  // of those are what put a sparkle through the reference's meadow.
  const litA = rng.bool(0.62) ? rng.int(0, n - 1) : -1;
  const litB = -1;
  for (let i = 0; i < n; i++) {
    const a = rng.float(0, Math.PI * 2), d = rng.float(0, 1.1);
    const h = rng.float(0.55, 1.05);
    const lit = i === litA || i === litB;
    const c = lit
      ? K.grassLit.clone().lerp(K.grass[1], rng.float(0.10, 0.55))
      : K.grass[i % K.grass.length];
    b.pushTilt(Math.cos(a) * d, 0, Math.sin(a) * d, rng.float(0, 6.28), 0, rng.float(-0.3, 0.3));
    b.cone(rng.float(0.5, 0.85), h * (lit ? 1.15 : 1), 5, c, { y: h / 2, sz: 0.7, open: true });
    b.pop();
  }
  return { geo: b.build(), trunkR: 0, height: 1.0 };
}

// ---------------------------------------------------------------------------
// THE DETAIL SET — "most polygons have no detail at all"
//
// This block exists because of one crop. Blowing target_01's meadow up 8x next
// to ours: between its conifers there is something every couple of metres —
// upright blades catching the sun, dark spiky scrub, a half-buried cobble, a
// hollow stump, a fallen log, a scrape of bare earth, a drift of white heads —
// and NONE of it is more than a handful of triangles. Ours had exactly two
// kinds of ground cover (a squat grass tuft and a flower drift), both of them
// within a few percent of the sward's own colour, so 37 000 tussocks in a map
// contributed nothing you could see.
//
// The rule for everything here: under 25 triangles, and a CLEAR value or hue
// step off the grass. Detail you cannot see is the most expensive thing in a
// frame — you pay for it twice, once in triangles and once in the note the
// client writes.
// ---------------------------------------------------------------------------

/** Thin upright blades. Taller and brighter than `tussock`, which is a squat
 *  clump: these are the individual spikes catching the key light. */
function grassBlades(rng, K) {
  const b = new GeoBuilder();
  // ---- FOOTPRINT, and the arithmetic that had been missing all round -------
  //
  // Cropping target_01 at 8x and measuring against the road (11 m) puts its
  // meadow at roughly ONE VISIBLE MARK PER TWO SQUARE METRES. A blanket cell of
  // 1.4 m would deliver that in instances and would also be 1.7 million of
  // them, which is not a budget, it is a joke. But a mark is not an instance:
  // one of these carries eight or ten blades. So the density is bought by
  // spreading each instance over a wider footprint instead of by placing more
  // of them — same triangles per mark, a third of the instances.
  const n = rng.int(7, 11);
  for (let i = 0; i < n; i++) {
    const a = rng.float(0, Math.PI * 2), d = Math.sqrt(rng.float(0, 1)) * 1.6;
    const h = rng.float(0.80, 1.60);
    // Two thirds lit. In target_01 the blades standing proud of the sward are
    // the BRIGHTEST green in the meadow — brighter than the sunlit turf — which
    // is what gives its grass a sparkle ours has never had.
    const lit = rng.bool(0.62);
    // No accent in it. The first pass warmed the lit blade 10% toward the
    // palette yellow and the meadow filled with straw-coloured spikes — the
    // same mistake the `grassLit` note above already records once.
    // ...and the lit blade is pulled a quarter back toward the sward green.
    // Straight `grassLit` is built off the two brightest rungs of a ramp that
    // is already yellow-olive at the top, so at blade scale it rendered as
    // chartreuse spikes standing out of green grass.
    // 0.30 toward the dark rung, not 0.13. Cropped at 5x, a lit blade at 0.13
    // is a chartreuse spike sitting ON the meadow; the reference's lit blades
    // are the same hue family as the sward, one value step up, so they read as
    // grass catching light rather than as a different plant.
    const c = lit ? K.grassLit.clone().lerp(K.grass[1], 0.30) : K.grass[i % K.grass.length];
    b.pushTilt(Math.cos(a) * d, 0, Math.sin(a) * d, rng.float(0, 6.28), 0, rng.float(-0.44, 0.44));
    // Three segments: a blade is 2 px wide on screen and a triangle prism is
    // indistinguishable from anything rounder there.
    // Wider than the first pass. At radius 0.11-0.21 squashed to 0.42 on one
    // axis a blade was under half a screen pixel across at the hero camera —
    // 62 000 of them in the map and a 3.4x crop of the meadow showed almost
    // none. Detail that cannot resolve is the most expensive thing there is.
    b.cone(rng.float(0.17, 0.30), h, 3, c, { y: h / 2, sz: 0.62, open: true });
    b.pop();
  }
  return { geo: b.build(), trunkR: 0, height: 1.7 };
}

/** Low dark scrub — the near-black speckle scattered through the reference's
 *  meadow. Spiky rather than blobby, so it never reads as a small tree. */
function shrubTuft(rng, K) {
  const b = new GeoBuilder();
  const n = rng.int(5, 8);
  const R = rng.float(0.7, 1.5);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.float(-0.55, 0.55);
    const d = rng.float(0, R * 0.75);
    const h = rng.float(0.5, 1.15);
    b.pushTilt(Math.cos(a) * d, 0, Math.sin(a) * d, rng.float(0, 6.28), 0, rng.float(-0.55, 0.55));
    b.cone(rng.float(0.20, 0.40), h, 4, K.bushDark[i % K.bushDark.length], { y: h / 2, open: true });
    b.pop();
  }
  return { geo: b.build(), trunkR: 0, height: 1.0 };
}

/** ROCK FAMILY 3 of 4 — a single half-buried cobble, squat and rounded, never
 *  bigger than a football. The grit that keeps a meadow off being a plane. */
function cobble(rng, K) {
  const b = new GeoBuilder();
  // One to three of them, loosely spread. A cobble on its own is a mark; two
  // or three a metre apart are a SCATTER, and the reference's turf is scatters
  // all the way down. Costs 20 triangles per stone and buys the density that
  // placing three times as many instances would.
  const n = rng.int(1, 3);
  for (let i = 0; i < n; i++) {
    const g = rockGeom(rng, { jitter: 0.36 });
    const s = i === 0 ? 1 : rng.float(0.42, 0.80);
    g.scale(s, s * rng.float(0.30, 0.52), s);
    if (i > 0) {
      const a = rng.float(0, Math.PI * 2), d = rng.float(0.7, 1.7);
      g.translate(Math.cos(a) * d, -0.12, Math.sin(a) * d);
    }
    const k = rng.float(0.05, 0.55);
    b.rawLit(g, K.stoneBody.clone().lerp(K.stoneLow, k),
      K.stoneTop.clone().lerp(K.stoneBody, 0.30 + k * 0.5),
      { t0: 0.40, t1: 0.96, low: K.stoneLow, l0: -0.30 });
  }
  return { geo: b.build(), trunkR: 0, height: 0.6 };
}

/** ROCK FAMILY 2 of 4 — a TRAIN of three or four mid stones stepping down a
 *  heading. The reference almost never puts one stone anywhere; it puts a
 *  line of them, and the line is what reads as geology rather than as litter. */
function stoneTrain(rng, K) {
  const b = new GeoBuilder();
  const n = rng.int(3, 4);
  const a0 = rng.float(0, Math.PI * 2);
  const ux = Math.cos(a0), uz = Math.sin(a0);
  let run = 0;
  let s = rng.float(0.85, 1.35);
  for (let i = 0; i < n; i++) {
    const lat = rng.gauss(0, 0.30);
    const g = rng.bool(0.45) ? slabGeom(rng, { jitter: 0.26 }) : rockGeom(rng, { jitter: 0.32 });
    g.scale(s, s * rng.float(0.5, 0.85), s);
    g.rotateY(rng.float(0, Math.PI * 2));
    g.translate(ux * run - uz * lat, -s * 0.22, uz * run + ux * lat);
    const k = rng.float(0.05, 0.55);
    b.rawLit(g, K.stoneBody.clone().lerp(K.stoneLow, k),
      K.stoneTop.clone().lerp(K.stoneBody, 0.24 + k * 0.5),
      { t0: 0.44, t1: 0.96, low: K.stoneLow, l0: -0.28 });
    run += s * rng.float(1.3, 2.2);
    s *= rng.float(0.58, 0.84);
  }
  return { geo: b.build(), trunkR: 0, height: 1 };
}

/** A log lying in the grass, with a pale sawn end. */
function logFallen(rng, K) {
  const b = new GeoBuilder();
  const L = rng.float(2.4, 5.0);
  const r = rng.float(0.22, 0.40);
  b.push(0, r * 0.86, 0, rng.float(0, Math.PI * 2));
  b.cyl(r * 0.80, r, L, 6, K.dead, { rz: Math.PI / 2, open: true });
  b.cyl(r * 0.80, r * 0.80, 0.10, 6, K.woodPale, { rz: Math.PI / 2, x: L / 2 });
  // One broken branch stub, which is most of what stops a log reading as a pipe.
  if (rng.bool(0.6)) {
    const bl = rng.float(0.5, 1.1);
    b.pushTilt(rng.float(-L * 0.3, L * 0.3), 0, 0, rng.float(0, 6.28), 0, rng.float(-0.5, 0.5));
    b.cyl(0.07, 0.13, bl, 4, K.dead, { y: bl / 2, open: true });
    b.pop();
  }
  b.pop();
  return { geo: b.build(), trunkR: 0, height: 0.8 };
}

/** Two logs and one on top — a stack left at the edge of a clearing. */
function logPile(rng, K) {
  const b = new GeoBuilder();
  const L = rng.float(2.6, 4.2);
  const r = rng.float(0.26, 0.40);
  b.push(0, 0, 0, rng.float(0, Math.PI * 2));
  const put = (x, y) => {
    b.cyl(r * 0.86, r, L, 6, K.dead, { rz: Math.PI / 2, x: 0, y, z: x, open: true });
    b.cyl(r * 0.86, r * 0.86, 0.09, 6, K.woodPale, { rz: Math.PI / 2, x: L / 2, y, z: x });
  };
  put(-r * 1.02, r);
  put(r * 1.02, r);
  put(0, r * 2.72);
  b.pop();
  return { geo: b.build(), trunkR: 0, height: r * 3.4 };
}

/** A cut stump with a pale ring and a dark heart, or a hollow one. Straight off
 *  target_01, which has these dotted through the grass between the stands. */
function stumpHollow(rng, K) {
  const b = new GeoBuilder();
  const h = rng.float(0.7, 1.5);
  const r = rng.float(0.45, 0.80);
  b.cyl(r * 0.94, r * 1.20, h, 6, K.dead, { y: h / 2, open: true });
  b.cyl(r * 0.94, r * 0.94, 0.10, 6, K.woodPale, { y: h + 0.05 });
  b.cyl(r * 0.44, r * 0.44, 0.07, 5, K.trunkDark, { y: h + 0.13 });
  // Two root buttresses. A plain drum reads as a barrel from above.
  for (let i = 0; i < 2; i++) {
    const a = rng.float(0, Math.PI * 2);
    b.pushTilt(Math.cos(a) * r * 0.9, 0, Math.sin(a) * r * 0.9, a, 0, rng.float(0.7, 1.1));
    b.cyl(0.10, 0.22, r * 1.1, 4, K.dead, { y: r * 0.5, open: true });
    b.pop();
  }
  return { geo: b.build(), trunkR: 0, height: h };
}

/** A scrape of bare earth with a little grit in it. Flat-ish and wide: the job
 *  is to break the turf, not to be an object. */
function earthPatch(rng, K) {
  const b = new GeoBuilder();
  const R = rng.float(1.3, 2.8);
  // A shallow 7-sided dome. Cover props are emitted 0.15 below the ground, so
  // it needs half a metre of rise to show at all; what stands proud reads as a
  // worn scrape rather than a molehill because it is four times as wide as tall.
  b.rawLit(
    (() => { const g = rockGeom(rng, { jitter: 0.22 }); g.scale(R, R * rng.float(0.16, 0.26), R); return g; })(),
    K.soil, K.soilLit, { t0: 0.55, t1: 0.99, low: K.trunkDark, l0: -0.2 });
  const n = rng.int(2, 5);
  for (let i = 0; i < n; i++) {
    const a = rng.float(0, Math.PI * 2), d = Math.sqrt(rng.float(0, 1)) * R * 0.85;
    const s = rng.float(0.10, 0.26);
    const g = rockGeom(rng, { jitter: 0.34 });
    g.scale(s, s * 0.6, s);
    g.translate(Math.cos(a) * d, R * 0.12, Math.sin(a) * d);
    b.rawLit(g, K.stoneBody.clone().lerp(K.stoneLow, 0.35), K.stoneTop.clone().lerp(K.stoneBody, 0.4),
      { t0: 0.42, t1: 0.96, low: K.stoneLow, l0: -0.3 });
  }
  return { geo: b.build(), trunkR: 0, height: 0.5 };
}

function screePatch(rng, K) {
  const b = new GeoBuilder();
  const n = rng.int(5, 8);
  for (let i = 0; i < n; i++) {
    const a = rng.float(0, Math.PI * 2), d = Math.sqrt(rng.float(0, 1)) * 3.4;
    const s = rng.float(0.28, 0.72);
    b.pushTilt(Math.cos(a) * d, 0, Math.sin(a) * d, rng.float(0, 6.28),
      rng.float(-0.3, 0.3), rng.float(-0.3, 0.3), s);
    const sc = K.stoneBody.clone().lerp(K.stoneLow, i % 3 === 0 ? 0.10 : 0.48);
    b.rawLit(rockGeom(rng, { jitter: 0.34 }), sc,
      K.stoneTop.clone().lerp(K.stoneBody, 0.30), { t0: 0.50, t1: 0.98, low: K.stoneLow, l0: -0.30 });
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
  // GREY STONE, THREE PLANES. See buildkit's `stoneBody / stoneTop / stoneLow`
  // for the measurement; the short version is that the previous round's warm
  // crown was both far too warm and applied to far too much of the solid, so
  // every boulder in the meadow rendered flesh-pink. The chunky faceted
  // silhouette below is unchanged — it was never the problem.
  //
  // A LITTLE per-instance variation in the body keeps a group of blocks from
  // looking like one material stamped four times, but it varies VALUE only.
  const k = rng.float(0.0, 0.26);
  const body = K.stoneBody.clone().lerp(K.stoneLow, k);
  const top = K.stoneTop.clone().lerp(K.stoneBody, k * 0.9 + rng.float(0, 0.14));
  const low = K.stoneLow;
  // t0 0.42: a planed granite face is not exactly level, and at 0.74 only the
  // one facet that happened to point straight up caught the light, so the
  // reference's broad pale crown came out as a single bright polygon in a sea
  // of mid grey. The shadow ramp starts at the same place and runs down to
  // horizontal-and-below, which is where a bedded block's dark side lives.
  b.rawLit(slabGeom(rng, { jitter: 0.24 }), body, top,
    { t0: 0.55, t1: 0.94, low, l0: -0.10 });
  const n = rng.int(1, 3);
  for (let i = 0; i < n; i++) {
    const s = rng.float(0.34, 0.62);
    const a = rng.float(0, Math.PI * 2), d = rng.float(0.85, 1.35);
    b.pushTilt(Math.cos(a) * d, -0.06, Math.sin(a) * d, rng.float(0, 6.28),
      rng.float(-0.16, 0.16), rng.float(-0.16, 0.16), s);
    const k2 = rng.float(0.10, 0.44);
    b.rawLit(slabGeom(rng, { jitter: 0.26 }),
      K.stoneBody.clone().lerp(K.stoneLow, k2),
      K.stoneTop.clone().lerp(K.stoneBody, 0.20 + k2),
      { t0: 0.52, t1: 0.92, low, l0: -0.10 });
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
  // Same grey triad as `slab`. A rounded boulder has no single plane facing the
  // sky, so its crown ramp starts higher and its shadow ramp bites earlier —
  // which is what gives target_01's round stones their soft top-to-bottom roll
  // instead of the slab's hard three planes. `detail: 1` because the reference's
  // rounded boulders are visibly many-faceted, not eight-sided lumps.
  const k = rng.float(0.06, 0.40);
  const body = K.stoneBody.clone().lerp(K.stoneLow, k);
  b.rawLit(rockGeom(rng, { jitter: 0.30, detail: rng.bool(0.5) ? 1 : 0 }), body,
    K.stoneTop.clone().lerp(K.stoneBody, 0.24 + k),
    { t0: 0.50, t1: 0.98, low: K.stoneLow, l0: -0.30 });
  if (rng.bool(0.5)) {
    const lump = rockGeom(rng, { jitter: 0.30 });
    lump.scale(0.55, 0.5, 0.55);
    lump.translate(rng.float(-0.9, 0.9), 0.1, rng.float(-0.9, 0.9));
    b.rawLit(lump, K.stoneBody.clone().lerp(K.stoneLow, 0.45),
      K.stoneTop.clone().lerp(K.stoneBody, 0.55),
      { t0: 0.50, t1: 0.98, low: K.stoneLow, l0: -0.30 });
  }
  if (o.snow) {
    const cap = rockGeom(rng, { jitter: 0.22 });
    cap.scale(1.02, 0.5, 1.02);
    cap.translate(0, 0.44, 0);
    b.raw(cap, K.snow);
  }
  return { geo: b.build(), trunkR: 1, height: 1 };
}

/**
 * ROCK FAMILY 1 of 4 — the CLEAVED BLOCK. A big flat-faced anchor with hard
 * vertical edges and a planed top, and one wedge fallen against its base. This
 * is the silhouette the meadow was completely missing: everything we had was a
 * jittered icosahedron under one name or another.
 */
function blockStone(rng, K, o = {}) {
  const b = new GeoBuilder();
  const k = rng.float(0.0, 0.30);
  const body = K.stoneBody.clone().lerp(K.stoneLow, k);
  const top = K.stoneTop.clone().lerp(K.stoneBody, k * 0.8 + rng.float(0, 0.18));
  const g = blockGeom(rng, { jitter: 0.24, taper: rng.float(0.12, 0.34) });
  // Wider than tall and slightly canted. A block sitting dead level reads as
  // masonry; two or three degrees of tilt reads as something that fell.
  g.scale(rng.float(1.15, 1.55), rng.float(0.60, 1.05), rng.float(0.95, 1.30));
  g.rotateY(rng.float(0, Math.PI * 2));
  g.rotateZ(rng.float(-0.16, 0.16));
  g.rotateX(rng.float(-0.13, 0.13));
  g.translate(0, 0.16, 0);
  // t0 0.46 / t1 0.86: a cleaved top is a real plane, so it should reach the
  // crown colour across the WHOLE face rather than only at its flattest point.
  b.rawLit(g, body, top, { t0: 0.46, t1: 0.86, low: K.stoneLow, l0: -0.12 });
  const n = rng.int(1, 2);
  for (let i = 0; i < n; i++) {
    const s = rng.float(0.30, 0.58);
    const a = rng.float(0, Math.PI * 2), d = rng.float(0.75, 1.25);
    const w = blockGeom(rng, { jitter: 0.30, taper: 0.36 });
    w.scale(s * 1.3, s * rng.float(0.5, 0.9), s);
    w.rotateY(rng.float(0, Math.PI * 2));
    w.rotateZ(rng.float(-0.5, 0.5));
    w.translate(Math.cos(a) * d, -0.08, Math.sin(a) * d);
    const k2 = rng.float(0.15, 0.50);
    b.rawLit(w, K.stoneBody.clone().lerp(K.stoneLow, k2),
      K.stoneTop.clone().lerp(K.stoneBody, 0.24 + k2),
      { t0: 0.46, t1: 0.86, low: K.stoneLow, l0: -0.12 });
  }
  if (o.snow) {
    const cap = blockGeom(rng, { jitter: 0.18, taper: 0.30 });
    cap.scale(1.18, 0.24, 1.0);
    cap.translate(0, 0.58, 0);
    b.raw(cap, K.snow);
  }
  return { geo: b.build(), trunkR: 1, height: 1 };
}

const MAKERS = {
  // ---- THE CONIFER LADDER, AS FIVE SILHOUETTES RATHER THAN FIVE SCALES ----
  //
  // "All one shape at different scales" was the client's fourth note and it was
  // literally true: every entry here differed only in `tall`, `wide` and tier
  // count, which is a scale change plus a stretch. target_01 puts tall narrow
  // spires, short full firs, half-grown ones and saplings in ONE view, and what
  // separates them is the shape of the tier: a spire's frills are short and its
  // taper is fast, an old fir's frills are long and its trunk is bare a long way
  // up. Those are `dropK`, `taper`, `stepK` and `bareK`, so they cost nothing.
  fir,
  // Short, full, heavy skirts, a slow taper and a wide crown — the "shorter
  // fuller fir" of the reference frame. Fewer tiers, but each one deeper.
  firOld: (r, K) => fir(r, K, {
    tall: 0.90, wide: 1.28, tiers: 9, seg: 10,
    dropK: 0.52, stepK: 0.40, profE: 0.42, bareK: 0.16, inner: 0.52,
  }),
  // TALL NARROW SPIRE. Not a needle: at wide 0.72 with six tiers this once came
  // out as a 22 m green spike three metres across, which read as litter. The
  // narrowness comes from SHORT frills and a fast-closing profile rather than
  // from a thin base, so the bottom of the tree still has a skirt on it.
  firSpire: (r, K) => fir(r, K, {
    tall: 1.02, wide: 0.86, tiers: 12, seg: 8,
    dropK: 0.34, stepK: 0.50, profE: 0.74, crownK: 0.26, inner: 0.48,
  }),
  // SQUAT AND FULL — the fourth silhouette, and the one the reference frame has
  // that we did not: a shoulder-high conifer wider than it is tall at the skirt,
  // with heavy overlapping frills and almost no bare trunk. It is what fills the
  // gaps at the edge of a stand in target_01, and it is what "rounder, bushier
  // forms in the same view" means without reintroducing the round-canopy
  // broadleaf that round 5 correctly threw out (a lumpy bright ball on a stick,
  // the most out-of-place object in that shot).
  firBushy: (r, K) => fir(r, K, {
    tall: 0.52, wide: 1.05, tiers: 7, seg: 10,
    dropK: 0.62, stepK: 0.46, profE: 0.34, bareK: 0.03, inner: 0.54, crownK: 0.18,
  }),
  firYoung: (r, K) => fir(r, K, {
    tall: 0.74, wide: 0.72, tiers: 7, seg: 8,
    dropK: 0.46, stepK: 0.50, profE: 0.52, bareK: 0.07, inner: 0.50,
  }),
  // The bottom of the size ladder. The reference is full of knee-to-waist-high
  // conifers filling the gaps between the hero trees; without them the meadow
  // reads as mown. Cheapest member: 5 tiers at seg 6 is 60 triangles of skirt.
  firSapling: (r, K) => fir(r, K, {
    tall: 0.80, wide: 0.38, tiers: 5, seg: 6,
    dropK: 0.48, stepK: 0.52, profE: 0.56, bareK: 0.05, inner: 0.48,
  }),
  firSnow: (r, K) => fir(r, K, { snow: true }),
  firSnowOld: (r, K) => fir(r, K, {
    snow: true, tall: 0.92, wide: 1.24, tiers: 9, seg: 10, dropK: 0.50, stepK: 0.44, profE: 0.46,
  }),
  scotsPine, broadleaf, birch, maple, snag, stump,
  saguaro, barrelCactus, ocotillo, scrub, windPine,
  bushDark: (r, K) => bush(r, K, K.bushDark),
  bushLight: (r, K) => bush(r, K, K.bushLight),
  flowersA: (r, K) => flowerPatch(r, K, 0),
  flowersB: (r, K) => flowerPatch(r, K, 1),
  flowersC: (r, K) => flowerPatch(r, K, 2),
  // Alpine's signature: drifts of white, and a softer cream-yellow. Derived
  // from the palette's own accents, never a hard-coded hex.
  // Pure palette white, not white-lerped-toward-yellow. Masking target_01 at
  // L > 0.70 showed its meadow highlights are the flower drifts and the stone
  // crowns; a bloom tinted 10% toward the yellow accent lands at 0.62 and
  // contributes nothing to the top of the histogram.
  flowersWhite: (r, K) => flowerPatch(r, K, 0, {
    color: K.accents[K.accents.length - 1],
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
  grassBlades, shrubTuft, cobble, stoneTrain,
  logFallen, logPile, stumpHollow, earthPatch,
  boulder, slab, blockStone,
  boulderSnow: (r, K) => boulder(r, K, { snow: true }),
  slabSnow: (r, K) => slab(r, K, { snow: true }),
  blockStoneSnow: (r, K) => blockStone(r, K, { snow: true }),
};

/**
 * Exported for the tree/prop sheet tooling only. Judging a conifer from a
 * whole-frame screenshot means judging a 60 px object, which is how three rounds
 * of tuning went into proportions that were never the problem; the sheet renders
 * one species 400 px tall on a flat lawn under the game's own light rig.
 */
export { MAKERS };

/** Tooling hook: build a conifer from an explicit parameter set. */
export const FIR_TEST = (rng, K, o) => fir(rng, K, o);

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
    //
    // ROUND 5. Probed: the r04 map carried 34 664 conifers over 2.89 km²
    // — 12 000/km² against target_01's measured ~25 000. The reason the last
    // round could not close it was collision, and collision is now fixed at
    // the cause (see `solidTree`), so the count can finally go where the
    // reference is. 72 000 lands at ~25 000/km². `singles` doubles with it,
    // because in target_01 most conifers are NOT in a stand: they are lone
    // trees with grass all round them, and that is the read the copse pass
    // can never produce on its own.
    // ROUND 6. 88 000 / 24 000 actually landed 57 654 conifers on a 2.89 km²
    // map — 20 000/km², one tree every 6.7 m averaged over the WHOLE map. At
    // that density no arrangement can have gaps in it: the trees have nowhere
    // to not be. Measured off target_01 with the road (11 m) as the ruler, its
    // frame carries about one conifer per 85 m², i.e. ~12 000/km², and the
    // difference between its meadow and ours is not chiefly the count — it is
    // that ours are packed tightly enough to fuse into one silhouette while
    // its stand of six still shows grass between every pair.
    //
    // So: total down to ~34 000 (12 000/km², the reference's own figure), the
    // clump share cut hard in favour of `singles`, and a hard MINIMUM GAP
    // between conifers (see `gapOK`) so no two of them can ever merge however
    // the noise field piles up. The count that is removed is the count that
    // was invisible anyway — the interior of a thicket.
    // ...and the correction, shot the same round. 34 000 / 18 000 with a 6.2 m
    // and 9.5 m gap landed 12 587 conifers and the hero frame came back a
    // MOWN LAWN: %dark 18.2 against the reference's 32.5, saturation up to
    // 0.800 because bare grass was most of the picture. The measurement that
    // matters is not trees/km², it is how much of the FRAME is canopy, and at
    // this camera height the reference is about a third dark.
    //
    // So the count goes back most of the way, and the separation is kept by
    // the gap floor alone: ~42 000 conifers, none of them closer than 5.2 m to
    // another, which is a stand you can see through rather than a thicket.
    canopyTarget: 94000, coverTarget: 92000, pebbleTarget: 13000, heroes: 800, singles: 60000, moistScale: 90,
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
    forest: { macro: 0.0044, meso: 0.0135, rich: 0.42, bare: 0.02, spacing: 7.4, contrast: 0.08, coverBare: 0.04 },
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
    // ROUND 5: smaller stands, more of them. A 33 m copse of 34 members is a
    // thicket you cannot see through, and four adjacent ones are the solid
    // green mass that filled the right half of the r04 hero frame while the
    // left half stayed bald. target_01 has no mass that size anywhere: its
    // largest group is maybe a dozen trees and you can see grass between most
    // of them. Halving the footprint and the membership at the same time as
    // doubling the map total turns one wall into six legible clumps.
    // ROUND 6 — the arithmetic that was missing every previous round.
    //
    // A copse's trees reach ~1.1 x `ra` from its centre (u is gauss(0,0.44)
    // and the loop rejects at r2 > 1.25). With radius up to 21 that is a 23 m
    // reach, and centres only `sep` = 20 m apart. Neighbouring copses were
    // therefore GUARANTEED to overlap — the "clump, gap, clump" rhythm could
    // not exist at those numbers whatever the noise field did, and the solid
    // green wall in the r05 hero frame was four copses whose ellipses shared
    // most of their area.
    //
    // The rule is sep > 2.2 x radiusMax. At radius [7,15] the reach is 16.5 m
    // and sep 38 leaves ~5 m of clear meadow between the skirts of adjacent
    // stands even when two land at the minimum separation. maxMembers 8 is
    // read straight off target_01, whose largest legible group is eight trees.
    clump: { tries: 170000, sep: 26, radius: [7, 15], maxMembers: 12, base: 0.90, kMax: 4.6, gap: 4.5 },
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
      // The squat full one. Weight kept below the spires and the standard fir —
      // target_01 is a conifer meadow whose dominant form is the tall fir — but
      // high enough that a hero frame holds several, because "all one shape at
      // different scales" is a per-FRAME complaint and a species that appears
      // once a kilometre does not answer it.
      { id: 'firBushy', w: 1.5, alt: [1, 4, 140, 210], wet: [0, 0.08, 1.05, 1.2], flat: 0.56, size: [0.80, 1.55] },
      // Kept deliberately low: target_01 is a conifer meadow. Round canopies
      // are the accent, not the crop.
      // A copse picks ONE dominant species and then keeps it for three quarters
      // of its members, so a broadleaf weight of 1.0 does not mean "one tree in
      // eight is round" — it means one stand in eight is entirely round-topped,
      // and a whole blob-canopy grove landed in the right of the hero frame.
      // target_01 has no round canopies at all. These stay only as a rare
      // single-tree note in damp hollows.
      // ROUND 5: gone. Cropping the hero frame at 2x found a broadleaf standing
      // a few metres off the road — a lumpy bright-green ball on a grey stick,
      // the single most out-of-place object in the shot. There are 31 of them
      // on a 2.89 km² map and one still landed in the one frame that matters,
      // which is what a 0.30 weight buys you. target_01 contains no round
      // canopy anywhere: it is a conifer meadow, and the accent that is not in
      // the reference is not an accent, it is a mistake waiting for a frame.
      // No snags in alpine. A dead pole reads from 200 m up as a two-tone stub
      // — bright sunlit face, near-black shadow face — and the copse pass will
      // happily make one the dominant species of a whole stand, which put
      // fields of black dots through the meadow. The reference has none.
    ],
    heroSpecies: ['firOld', 'firSpire', 'fir'],
    cover: [
      { id: 'bushDark', w: 1.9, alt: [1, 4, 150, 230], wet: [0, 0.08, 1.05, 1.2], flat: 0.60, size: [0.52, 0.86] },
      { id: 'bushLight', w: 0.9, alt: [1, 4, 120, 180], wet: [0.05, 0.22, 1.05, 1.2], flat: 0.60, size: [0.52, 0.82] },
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
      { id: 'flowersWhite', w: 4.6, alt: [1, 4, 120, 180], wet: [0, 0.12, 1.05, 1.2], flat: 0.78, size: [0.9, 1.35] },
      { id: 'flowersCream', w: 1.05, alt: [2, 5, 110, 160], wet: [0.05, 0.2, 1.05, 1.2], flat: 0.82, size: [0.8, 1.25] },
      { id: 'flowersRed', w: 1.15, alt: [2, 5, 95, 140], wet: [0.1, 0.3, 1.05, 1.2], flat: 0.82, size: [0.85, 1.3] },
      { id: 'tussock', w: 5.0, alt: [1, 3, 190, 300], wet: [0, 0.04, 1.05, 1.2], flat: 0.58, size: [1.0, 2.2] },
      { id: 'screePatch', w: 1.2, alt: [120, 190, 300, 430], wet: [0, 0, 0.6, 0.9], flat: 0.0, flatMax: 0.88, size: [0.7, 1.3] },

      // ---- THE DETAIL SET -------------------------------------------------
      // Weights are the answer to the client's "most polygons have no detail at
      // all", and the split between them is read straight off the reference:
      // grass first, dark scrub second, then stone, then wood and earth as the
      // notes you find once or twice a frame.
      //
      // Everything that is not a plant is `accent: true`. The cluster pass
      // picks ONE dominant per copse and keeps it for three quarters of the
      // members, so without the flag a 0.5-weight log becomes a copse of
      // fourteen logs in a ten-metre circle roughly once every twenty stands —
      // which is a woodyard, not a meadow. As accents they can only ever be the
      // minority quarter, i.e. one or two per group. Same reasoning that
      // retired the broadleaf in round 5.
      { id: 'grassBlades', w: 6.2, alt: [1, 3, 190, 300], wet: [0, 0.04, 1.05, 1.2], flat: 0.55, size: [0.85, 1.75] },
      { id: 'shrubTuft', w: 3.0, alt: [1, 3, 170, 260], wet: [0, 0.04, 1.05, 1.2], flat: 0.55, size: [0.8, 1.7] },
      { id: 'cobble', w: 2.1, accent: true, alt: [1, 3, 220, 340], wet: [0, 0, 1.1, 1.3], flat: 0.42, size: [0.55, 1.7] },
      { id: 'stoneTrain', w: 1.1, accent: true, alt: [1, 4, 220, 340], wet: [0, 0, 1.1, 1.3], flat: 0.60, size: [0.6, 1.5] },
      { id: 'earthPatch', w: 1.0, accent: true, alt: [1, 4, 200, 320], wet: [0, 0, 1.05, 1.25], flat: 0.72, size: [0.6, 1.4] },
      { id: 'logFallen', w: 0.62, accent: true, alt: [1, 4, 150, 230], wet: [0, 0.05, 1.05, 1.2], flat: 0.74, size: [0.7, 1.3] },
      { id: 'stumpHollow', w: 0.55, accent: true, alt: [1, 4, 150, 230], wet: [0, 0.05, 1.05, 1.2], flat: 0.72, size: [0.8, 1.5] },
      { id: 'logPile', w: 0.16, accent: true, alt: [1, 4, 130, 200], wet: [0, 0.05, 1.05, 1.2], flat: 0.82, size: [0.8, 1.2] },
    ],
    /**
     * THE DETAIL BLANKET — the pass that answers "most polygons have no detail
     * at all" directly, and the reason the cover pass alone never could.
     *
     * `placeClusters` puts ground cover in COPSES: it accepts a centre, packs
     * members round it, and moves on. That is right for plants that grow in
     * company, and it is why the r10 meadow could hold 92 000 ground props and
     * still show forty-metre stretches of untouched polygon — the props were
     * all in the other stretches. Cropping our frame at 3.4x next to the
     * reference: theirs never gives you more than two or three metres of empty
     * turf, ours routinely gives twenty.
     *
     * So this is a JITTERED GRID, not a scatter: one candidate per `cell`
     * metres of map, everywhere, with the position jittered inside its cell so
     * there is no visible lattice. Even coverage is the whole point — the grid
     * cannot leave a hole because it has a cell there.
     *
     * It runs last and on its own Rng, so every earlier pass keeps the exact
     * placement it had before this existed.
     */
    blanket: {
      // 3.6 m, and this is the number the client note is really about. At 5.0
      // the blanket put one item per 25 m² and a 3.4x crop of the meadow still
      // showed stretches of twenty metres with nothing in them; at 3.6 it is
      // one per 13 m², which is what counting marks in the reference's own turf
      // gives. Below this the triangle bill grows faster than anything is
      // visible.
      cell: 3.6, fill: 0.90,
      mix: [
        { id: 'grassBlades', w: 0.22, size: [0.75, 1.45] },
        // Tussock's weight is cut to a token. It is the oldest ground-cover
        // species we have and, measured, the least useful: the map carried
        // 42 000 of them and a 3.4x crop of the meadow shows not one, because
        // every colour in a tuft is derived from the sward it stands in. It
        // stays as filler under the other marks, not as a headline.
        { id: 'tussock', w: 0.06, size: [0.9, 2.0] },
        // Reweighted by what actually RESOLVES. Shot and cropped at 3.4x, the
        // marks you can see in our meadow are, in order: cobbles, dark scrub,
        // flower drifts, bare earth — and only then blades. So the weight moves
        // toward the first four.
        { id: 'shrubTuft', w: 0.24, size: [0.80, 1.7] },
        { id: 'bushDark', w: 0.07, size: [0.45, 0.85] },
        // Stone, wood and earth are a fifth of the blanket, and that fifth is
        // the measured shortfall: the frame's "other" pixel population (road +
        // stone + small detail) sits at 25.7% against the reference's 32.3%.
        { id: 'cobble', w: 0.16, size: [0.55, 1.75] },
        { id: 'flowersWhite', w: 0.11, size: [0.85, 1.3] },
        { id: 'earthPatch', w: 0.07, size: [0.55, 1.4] },
        { id: 'stoneTrain', w: 0.045, size: [0.5, 1.3] },
        { id: 'flowersRed', w: 0.015, size: [0.8, 1.25] },
        { id: 'logFallen', w: 0.014, size: [0.7, 1.3] },
        { id: 'stumpHollow', w: 0.014, size: [0.8, 1.5] },
      ],
    },
    shore: { id: 'reeds', size: [0.8, 1.5] },
    boulder: 'boulder',
    slab: 'slab',
    // Anchors are what a group is built around; satellites are what lies
    // beside it. `cobble` appears only as a satellite because a football-sized
    // stone cannot anchor anything, and `blockStone` is weighted twice into the
    // anchor list because the cleaved block is the silhouette the frame was
    // short of.
    anchors: ['blockStone', 'blockStone', 'slab', 'boulder'],
    sats: ['blockStone', 'slab', 'boulder', 'cobble', 'cobble'],
    verge: {
      // The verge is the one band the detail blanket cannot reach — everything
      // inside the road's keep-out is rejected by `isBlocked` — so the strip
      // beside the gravel has to be dressed by this pass or it stays the one
      // bare part of the frame. Counted up with the blanket.
      count: 9000, width: 13,
      mix: [
        { id: 'flowersWhite', w: 0.16 },
        { id: 'tussock', w: 0.08 },
        // The verge is where the reference is DENSEST — blades, cobbles and a
        // scrape of bare earth crowd the gravel, and the soft encroaching
        // margin is most of why its road looks driven-on.
        { id: 'grassBlades', w: 0.14 },
        { id: 'cobble', w: 0.09 },
        { id: 'earthPatch', w: 0.05 },
        { id: 'shrubTuft', w: 0.05 },
        // A few real trees on the verge, not just saplings. In target_01 the
        // wood closes to within a couple of metres of the gravel in places and
        // that is what stops the road looking drawn on rather than cut through.
        { id: 'firYoung', w: 0.08 },
        // Roadside stone. In target_01 there is a pale block within a couple of
        // metres of the gravel every hundred metres or so, and it is the single
        // clearest scale cue the frame has — bigger share than the flowers.
        { id: 'slab', w: 0.10 },
        { id: 'flowersCream', w: 0.04 },
        { id: 'bushDark', w: 0.06 },
        // Young conifers crowding the verge: in the reference the wood comes
        // right down to the fence line, and the road's keep-out band is the
        // only reason ours does not.
        { id: 'firSapling', w: 0.12 },
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

    // ---- CONIFER GREEN, MEASURED --------------------------------------
    // Sampling every green pixel of target_01 and of our own hero frame, split
    // into brightness bands, gave this:
    //
    //            band g20-60      g60-100      g100-150
    //   ours     (10,54,26) 2.5%  (12,80,32)   (34,120,36)
    //   target   (24,51,23) 8.0%  (51,77,21)   (94,121,16)
    //
    // Two facts fall out. (a) In EVERY band the reference's greens carry two to
    // three times our red — its conifers are a warm, slightly olive green, ours
    // are a pure chroma green that exists nowhere in the picture. That single
    // channel is most of the 0.83-vs-0.756 saturation gap. (b) The reference
    // puts three times as many pixels in the DARK green band as we do: its
    // conifers are shadow shapes with a lit edge, ours are uniformly mid-bright,
    // which is a large part of why our histogram piles into two buckets.
    //
    // The old ramp could not express either. It shaded with offsetHSL, and
    // THREE.Color is LINEAR: alpine foliage measures l≈0.13, so the `dir` test
    // always chose +1 and every tier was LIGHTENED, the top one by +0.125 in
    // linear terms — nearly double the value of the base green. Hence neon.
    //
    // So alpine builds its ramp by scaling in linear space (which is what
    // "further into shadow" physically means) and lerping red toward the green
    // channel by a measured amount. `mul` is the tier's value, `warm` its red
    // lift, `blue` the cool lift that keeps the shadow side from going olive.
    const tier = (c, mul, warm, blue) => {
      const o = c.clone().multiplyScalar(mul * (1 + j * 2.2));
      o.r = lerp(o.r, o.g * 0.62, warm);
      o.b = lerp(o.b, o.g * 0.26, blue);
      return o;
    };
    const alp = this.biome.id === 'alpine';

    // ---- VARIANT VALUE NORMALISATION ------------------------------------
    // The four palette foliage entries are not four hues at one value, they
    // are four hues at four VALUES: 0x1e3b28 carries about 60% of the light
    // 0x35673d does. Every tier is a multiple of its variant's own colour, so
    // variant 2 came out a stop and a half darker than variant 3 all the way
    // up its ramp — and masking the hero frame at L < 0.10 showed exactly that:
    // the crushed pixels are not spread over the wood, they belong to the
    // handful of trees that drew the dark variant, whose whole shadow flank
    // falls off the bottom of the scale.
    //
    // A wood should hold three or four GREENS at one exposure, not three or
    // four exposures. Each variant is pulled 72% of the way to the set's mean
    // luminance, which keeps every hue the palette declared and throws away
    // only the value spread that was never wanted.
    const lumOf = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const levelled = (c) => {
      if (!alp) return c;
      let m = 0;
      for (const f of fol) m += lumOf(f);
      m /= fol.length;
      const l = lumOf(c);
      if (l < 1e-5) return c;
      return c.clone().multiplyScalar(1 + (m / l - 1) * 0.72);
    };
    const aL = levelled(a);
    const bL = levelled(b2);

    const leaf = alp ? [
      tier(aL, 1.28, 0.28, 0.98),
      tier(aL, 1.50, 0.24, 0.94),
      tier(bL, 1.14, 0.30, 1.00),
    ] : [
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
    // Alpine: a genuine dark-to-light ladder. The skirt sits at a third of the
    // palette green's value and the sunlit tip a little above it, so a fir reads
    // as a solid in shadow with light caught on the top two tiers — which is
    // exactly the silhouette target_01's conifers have. The warm lift falls off
    // as the tier gets lighter, because in the reference it is the SHADOW side
    // that is olive and the lit side that is greenest.
    //
    // Levels landed by measurement, not by eye. The first pass ran 0.30/0.47/
    // 0.66/0.92 and put 6.1% of the frame in the BOTTOM luma bucket against the
    // reference's 0.9% — the conifers had gone from neon to soot and the frame
    // mean fell to 0.341 against a 0.379 target. Everything is a third brighter
    // here, which keeps the ladder and the warm lift but lands the mass of the
    // canopy in luma buckets 1-3 where the reference keeps it.
    // ---- ROUND 6: THE BLUE SHADOW ---------------------------------------
    //
    // Masking our hero frame at L < 0.10 showed the crushed darks are not
    // spread through the picture at all: they are ENTIRELY the sun-facing-away
    // flanks of conifers, 5.9% of the frame against the reference's 0.9%. And
    // the dominant-colour table says what they are made of:
    //
    //     ours    #00172e   5.4% of frame   (R<23, G 23-46, B 46-69)
    //     target  #172e17   9.4% of frame   (R 23-46, G 46-69, B 23-46)
    //
    // Ours is BLUE — blue is its largest channel and red is near zero. The
    // reference's is green, with red and blue level. Same shape, same job in
    // the composition, opposite hue. Our ambient in shadow is strongly blue
    // and it was swamping an albedo whose own blue was 40% of its green, so
    // the shadow side of every fir went to sky colour and then to black.
    //
    // Luma is 0.2126R + 0.7152G + 0.0722B, so this is also most of the
    // brightness gap and it is nearly free to fix: moving a unit of blue into
    // green multiplies its contribution by ten. Red comes up with it (`warm`),
    // which RAISES luma and LOWERS saturation — and we are 0.012 over on
    // saturation, so that is the direction to be wrong in.
    const leafRamp = (alp ? [
      tier(aL, 1.34, 0.42, 1.00),
      tier(aL, 1.48, 0.38, 0.98),
      tier(bL, 1.60, 0.32, 0.92),
      tier(bL, 1.80, 0.27, 0.86),
    ] : [
      shade(a, j + dir * 0.005, 0.045),
      shade(a, j + dir * 0.045, 0.02),
      shade(b2, j + dir * 0.085, -0.01),
      shade(b2, j + dir * 0.125, -0.045),
    ]).sort((p, q) => lum(p) - lum(q));

    /**
     * THE TWO ENDS OF A CONIFER'S VALUE RANGE, MEASURED INSIDE ONE TREE.
     *
     * `leafRamp` is a four-rung ladder for the BODY of successive tiers, and its
     * rungs are deliberately close together (1.28 to 1.80 of the palette green,
     * a factor of 1.4) because a wood should hold three or four greens at one
     * exposure, not four exposures. Using its two ends as the lit/shadow anchors
     * of a single tier was the mistake: masking the foliage pixels of ONE tree
     * and taking percentiles gives
     *
     *                       p10    p50    p90    brightest decile
     *     target_01          34     73    133    rgb(138,167,38)
     *     ours (r11)         56     85     95    rgb( 78,107,47)
     *
     * — a range of 3.9x inside one reference fir against 1.7x inside one of ours.
     * That single number is the client's "reads as a cut-out": a solid with light
     * on it spans four stops, a cut-out spans one. So the tier ramp gets its own
     * anchors, far outside the body ladder.
     *
     * The lit end is a WARM YELLOW-GREEN, not a brighter version of the body.
     * Measured on the hero frame, the brightest decile of our foliage ran
     * rgb(102,131,24) — red at 78% of green — against the reference's
     * rgb(150,165,26), red at 91%. In linear terms that is red at 0.80 of green
     * rather than 0.58, which is past anything `tier()`'s `warm` can reach (it
     * tops out at 0.62), so it is set directly. Blue goes to almost nothing: the
     * reference's lit needles are 0.014 blue-to-green and the hemisphere ambient
     * will put plenty of blue back.
     */
    const leafSun = (() => {
      const c = levelled(fol[(vi + 1) % n]).clone();
      if (!alp) return shade(c, 0.16, -0.06);
      /**
       * ...and blue at 0.16 of green was too austere. Measured on the frame, our
       * brightest foliage decile came back rgb(116,126,9) against the reference's
       * rgb(150,165,26): red-to-green now matches to within 1% (0.92 vs 0.91) but
       * the blue had collapsed to a third of the reference's, which is what makes
       * a lit needle read as acid rather than as sunlit green.
       */
      c.multiplyScalar(2.60 * (1 + j * 1.6));
      c.r = c.g * 0.78;
      c.b = c.g * 0.30;
      return c;
    })();
    /**
     * ...and the shadow end. This is the note that goes in the notch walls —
     * the near-vertical facets between two flaps — and it must be a CLEAR step,
     * not a shading nuance. Careful, though: round 6 put 6.1% of the frame in
     * the bottom luma bucket against the reference's 0.9% and the wood read as
     * soot. The reference's own darkest decile INSIDE a tree is rgb(9,36,21),
     * i.e. luma 0.12 — dark, and nowhere near black. 0.50 of the palette green
     * with red and blue held at a third of it lands there.
     */
    const leafShade = (() => {
      const c = levelled(fol[vi % n]).clone();
      if (!alp) return shade(c, -0.05, 0.04);
      // 0.50 crushed: shot, it put 2.1% of the frame in the BOTTOM luma bucket
      // against the reference's 0.9% and printed #171717 as a dominant colour.
      // The reference's own darkest in-tree decile is rgb(9,36,21) — luma 0.12,
      // i.e. the TOP of bucket 1, which is where 15% of its pixels live and only
      // 10.6% of ours did. Lighter shade colour, wider shade window (t0), so the
      // deep facets land in bucket 1 instead of falling out of the bottom.
      /**
       * ...and it is a BLUE-green, which is what the client's note actually says
       * ("a SHADED side (dark blue-green)") and what masking both frames at
       * L < 0.10 confirms. Those pixels are entirely the shadow flanks of the
       * conifers, and they measure
       *
       *     ours    3.43% of frame   rgb(12,23,12)   B/G 0.52
       *     target  0.99% of frame   rgb( 9,27,21)   B/G 0.78
       *
       * — ours a third darker in green with almost no blue in it, which is why
       * they fall out of the bottom of the histogram instead of sitting in luma
       * bucket 1 where the reference keeps them. The ambient multiplies B/G by
       * about 1.37 and R/G by 1.13 on the way to the screen (measured on the same
       * two masks), so the albedo is pre-divided by those: 0.57 blue and 0.30 red
       * against green lands on the reference's numbers.
       *
       * This is NOT the round-6 "blue shadow" failure, which had red near zero and
       * blue AHEAD of green — a spruce lit by nothing but sky. Here red and blue
       * are both a fraction of green and green is the largest channel.
       */
      c.multiplyScalar(0.75);
      c.r = c.g * 0.30;
      c.b = c.g * 0.57;
      return c;
    })();

    return {
      ...D,
      leaf,
      leafRamp,
      leafSun,
      leafShade,
      leafPale: leaf.map((c) => shade(c, 0.10, -0.05)),
      /**
       * CONIFER BARK, and why it is not `bark`.
       *
       * `derivePalette.bark` is `offsetHSL(trunk, 0.01, -0.04, +0.05)`, and
       * THREE.Color is LINEAR: the palette's trunk #6b4a30 measures l = 0.09
       * there, so +0.05 is not a nudge, it more than doubles the value. Rendered
       * on the tree sheet that came out a pale pinkish tan, and the frame's grade
       * runs a 1.05 red gain on top — so the one part of the tree the client
       * asked to be able to SEE was printing salmon. This is the palette's own
       * brown taken slightly DOWN instead: a fir's trunk in target_01 is darker
       * than its ground, not lighter.
       */
      trunkBark: (() => {
        // 0.82 shot ORANGE. Zoomed 5x on the hero frame the trunks came back as
        // roughly rgb(150,90,70) wedges against the reference's rgb(95,62,45):
        // the hue was close (R/G 1.67 against 1.53) and the VALUE was 60% too
        // high, which on a warm brown under a warm key prints as terracotta. The
        // frame's grade adds another 5% of red on top, so red comes off a little
        // as well.
        const c = D.trunk.clone().multiplyScalar(0.40);
        c.r *= 0.90;
        return c;
      })(),
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
      // SUNLIT CROWN. Every colour a tussock had was at or below the meadow's
      // own value, which is why the meadow could hold 20 000 grass tufts and
      // still contribute nothing to the top of the histogram: there was no
      // material in it brighter than the ground it stood on. In target_01 the
      // crown of a tuft catching the key light is a pale yellow-green a clear
      // stop ABOVE the sward — the same note as the brightest terrain polygon,
      // put on an object that faces the sun instead of lying flat.
      // Built from the top rung of the ground ramp, warmed toward the palette's
      // own yellow accent; nothing invented.
      // ...and the correction. `ground[4]` warmed 22% toward the yellow accent
      // rendered as BRIGHT STRAW: cropping the meadow at 2.2x showed hundreds
      // of little yellow spikes where the reference has dark green scrub. A
      // sunlit blade is one STEP above the sward, not a different plant. Built
      // off ground[3] (the sward's own top rung) lifted a third of the way to
      // ground[4], with no accent in it at all.
      grassLit: new THREE.Color(p.ground[3])
        .lerp(new THREE.Color(p.ground[p.ground.length - 2]), 0.34),
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
    if (mix.anchors) for (const id of mix.anchors) need.add(id);
    if (mix.sats) for (const id of mix.sats) need.add(id);
    if (mix.verge) for (const m of mix.verge.mix) need.add(m.id);
    if (mix.blanket) for (const m of mix.blanket.mix) need.add(m.id);
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

    /**
     * CONIFER SPACING GRID — the mechanism that makes the meadow breathe.
     *
     * Every previous round tried to buy separation with the noise field, and
     * the field cannot deliver it: it decides how MANY trees a patch wants,
     * not how close two of them may stand. So a "thin" patch of a dense map is
     * still a patch where trees touch, and touching conifers do not read as
     * two trees — they read as one dark blob with a serrated edge, which is
     * exactly the mass that filled the right of the r05 hero frame.
     *
     * This is the hard floor instead: no conifer may be placed within `minD`
     * metres of another conifer, full stop. A fir's skirt is ~4.5-6 m across,
     * so a 6.2 m floor inside a stand leaves a sliver of grass showing between
     * every pair, and the 9 m floor the singles pass uses leaves a whole tree
     * width. Uniform grid, ~25 lookups per candidate, so it is affordable at
     * 150 000 tries.
     */
    const GCELL = 10;
    const gGrid = new Map();
    const gKey = (ix, iz) => (Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663)) | 0;
    const gapOK = (x, z, minD) => {
      if (!(minD > 0)) return true;
      const ix = Math.floor(x / GCELL), iz = Math.floor(z / GCELL);
      const rr = minD * minD;
      const span = Math.ceil(minD / GCELL);
      for (let a = -span; a <= span; a++) {
        for (let c = -span; c <= span; c++) {
          const arr = gGrid.get(gKey(ix + a, iz + c));
          if (!arr) continue;
          for (let i = 0; i < arr.length; i += 2) {
            const dx = arr[i] - x, dz = arr[i + 1] - z;
            if (dx * dx + dz * dz < rr) return false;
          }
        }
      }
      return true;
    };
    const gapAdd = (x, z) => {
      const k = gKey(Math.floor(x / GCELL), Math.floor(z / GCELL));
      let a = gGrid.get(k);
      if (!a) gGrid.set(k, (a = []));
      a.push(x, z);
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

    /**
     * TRUNK COLLISION POLICY — the reason density used to cost 40 km/h.
     *
     * game.js resolves a hit by `velocity *= 0.45` for EVERY overlapping
     * collider on EVERY fixed step, and it inflates each collider's radius by
     * the car's own 1.4 m. So a trunk's real radius (~0.35 m) is irrelevant:
     * what matters is how many 1.75 m discs sit where the car actually goes.
     * Raising the tree count therefore hit the drive quadratically, and the
     * previous round backed a 50 000-tree map out at 90 km/h instead of 131.
     *
     * Two rules fix the cause instead of capping the count.
     *
     *  1. SHOULDER GRACE. A trunk within `SHOULDER` metres of the road's
     *     keep-out band is drawn but is NOT solid. In the reference the wood
     *     closes right up to the gravel, and clipping the outermost tree of
     *     that line at 130 km/h is not a collision the player caused — it is a
     *     tax on driving near the edge, which is the whole game. Off-road,
     *     more than a car's width from the band, every mature trunk is solid.
     *  2. MATURE ONLY, PER SPECIES. `solidTree` gates on the instance's REAL
     *     height (geometry height x scale), not on its scale, so saplings and
     *     the young firs that fill the meadow are scenery. Their radius is the
     *     species' own trunk radius rather than a shared constant.
     *
     * Cost: eight isBlocked lookups per candidate, and only for the minority of
     * trees that pass the height gate.
     */
    const SHOULDER = 7.0;
    const onShoulder = (x, z) => {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        if (isBlocked(x + Math.cos(a) * SHOULDER, z + Math.sin(a) * SHOULDER)) return true;
      }
      return false;
    };
    const solidTree = (entry, x, z, s, minH = 13.5) => {
      if (entry.trunkR < 0.55 || entry.height * s < minH) return false;
      if (onShoulder(x, z)) return false;
      this.colliders.push({ x, z, r: entry.trunkR * s * 0.34 });
      return true;
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
          if (!gapOK(x, z, opt.gap ?? 0)) continue;

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
          solidTree(lib.get(`${spec.id}#${v}`), x, z, s);
          if (opt.gap) gapAdd(x, z);
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
      maxMembers: CL.maxMembers ?? 190, kMax: CL.kMax, gap: CL.gap ?? 0,
    });
    // Ground cover gets a HIGH probability floor. The canopy pass wants a
    // "copse, gap, copse" rhythm; ground cover does not — in the reference the
    // grass and the flower drifts are everywhere, thicker in places, and the
    // only thing a density field should do to them is vary how thick. With the
    // default 0.30 floor the drifts collected into the top quarter of the cover
    // mask and whole frames (hero_alpine) came out with a bare lawn.
    // ROUND 5: more drifts, each smaller. Cropping our meadow at 2x against
    // target_01's showed the difference is not the amount of grass — it is that
    // ours arrives in 21 m patches with 40 m of bare polygon between them,
    // while the reference never gives you more than a few metres of empty turf.
    // 26-member drifts on a 10 m spacing put something in every gap without
    // making any one patch read as a planted bed.
    placeClusters(mix.cover, mix.coverTarget, {
      density: coverDensity, contrast: 1.0, base: 0.90,
      tries: 60000, sep: 8, radius: [4, 14], spacing: 3.2, maxMembers: 30,
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
        // Verge conifers join the spacing grid too. Without it the roadside
        // saplings pile into the same 13 m band a thousand at a time and the
        // fence line grows a continuous green hedge — which is the thing the
        // reference most obviously does not have: you can see the meadow
        // THROUGH its verge planting.
        if (/^fir/.test(id)) {
          if (!gapOK(p.x, p.z, 5.2)) continue;
          gapAdd(p.x, p.z);
        }
        const v = rng.int(0, VARIANTS - 1);
        // Roadside stone is the exception to the verge's uniform size range.
        // In target_01 the blocks sitting a metre off the gravel are car-sized
        // or bigger — that is the whole reason they read as a scale cue — and
        // at 0.75-1.45 ours were pebbles you had to hunt for.
        const s = (id === mix.slab || id === 'blockStone') ? rng.float(1.1, 2.3) : rng.float(0.75, 1.45);
        emit(id, v, {
          x: p.x, y: e.h - (id === mix.slab ? s * 0.12 : 0.12), z: p.z, s,
          r: rng.float(0, Math.PI * 2),
          tx: rng.gauss(0, 0.03), tz: rng.gauss(0, 0.03),
        });
        // Verge props are never solid — by construction they sit inside the
        // shoulder grace band, so `solidTree` would reject them anyway, and
        // asking it would cost eight isBlocked lookups apiece to learn that.
        vplaced++;
      }
    }

    // ---- HERO TREES ------------------------------------------------------
    // Isolated giants, deliberately placed where the forest is THIN.
    const HERO_GAP = 13;
    let heroes = 0;
    for (let i = 0; i < 40000 && heroes < mix.heroes; i++) {
      const x = rng.float(-half, half), z = rng.float(-half, half);
      // "Open" is now judged against the flattened field: with `base` doing most
      // of the work the density term rarely drops below 0.4, and a 0.42 gate
      // meant heroes could only stand in the couple of hollows where the field
      // bottomed out — which is why every hero tree ended up on the same side.
      if (forestDensity(x, z) > 0.62) continue;
      const e = envAt(x, z);
      if (!e || e.ny < 0.82) continue;
      if (isBlocked(x, z) || nearSpawn(x, z)) continue;
      // A hero needs its own patch of sky. 15 m of clearance is two full
      // skirts, which is what makes target_01's big trees read as landmarks
      // rather than as the tallest member of whatever stand they fell into.
      if (!gapOK(x, z, HERO_GAP)) continue;
      const id = rng.pick(mix.heroSpecies);
      const spec = mix.canopy.find((s) => s.id === id) ?? mix.canopy[0];
      if (fitness(spec, e) <= 0.15) continue;
      const v = rng.int(0, VARIANTS - 1);
      // A hero is the biggest thing in its part of the frame — the lone tree in
      // the meadow that gives the whole shot its scale. ~25-30 m.
      // Heroes shrank with everyone else. Now that a normal fir tops out at
      // ~1.3, a 1.5 hero was twice the height of its neighbours and read as a
      // mistake rather than as a landmark. Half again as tall is enough.
      // ROUND 6: heroes get their size back, because they now have room for
      // it. target_01 has a handful of conifers half again as tall as their
      // neighbours standing ALONE in grass — that contrast is what gives the
      // frame its scale, and at 1.16-1.40 inside a thicket it was invisible.
      const s = rng.float(1.34, 1.72);
      emit(id, v, { x, y: e.h - 0.15, z, s, r: rng.float(0, Math.PI * 2), tx: 0, tz: 0 });
      // A hero IS the landmark of its patch of meadow, so it stays solid at a
      // lower height gate and a fatter radius than an ordinary tree.
      solidTree(lib.get(`${id}#${v}`), x, z, s * 1.3, 9);
      gapAdd(x, z);
      heroes++;
    }

    // ---- SCATTERED SINGLES -----------------------------------------------
    // target_01 is not "copse, gap, copse" alone. Between the stands there are
    // LONE conifers, one every 30-50 m, at ordinary sizes — and they are what
    // stops the meadow reading as a mown lawn laid between two woods. The
    // cluster pass can never make them (a copse of one is just a small copse),
    // and the hero pass only makes giants, so they get their own pass. It
    // deliberately prefers the OPEN ground the cluster pass skipped.
    const SINGLE_GAP = 5.5;
    const singles = Math.round((mix.singles ?? 0) * D);
    let lone = 0;
    for (let i = 0; i < singles * 26 && lone < singles; i++) {
      const x = rng.float(-half, half), z = rng.float(-half, half);
      if (rng.float(0, 1) > 1 - forestDensity(x, z) * 0.80) continue;
      const e = envAt(x, z);
      if (!e || e.ny < 0.66) continue;
      if (isBlocked(x, z) || nearSpawn(x, z)) continue;
      // A LONE tree, so the gap it keeps is a generous one — 9.5 m is a whole
      // tree width of grass on every side, which is what the reference's
      // between-the-stands conifers actually have.
      if (!gapOK(x, z, SINGLE_GAP)) continue;
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
      solidTree(lib.get(`${spec.id}#${v}`), x, z, s);
      gapAdd(x, z);
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
    // FOUR FAMILIES, NOT ONE. Every rock in the map used to come from
    // `mix.slab` — one geometry maker, one size ladder, one silhouette — which
    // is the whole of "the rocks are all the same rock". The anchors now draw
    // from three distinct hulls and the satellites from four, so a group is a
    // cleaved block with a rounded boulder and a couple of cobbles round it
    // rather than four copies of itself at four scales.
    const rockId = mix.slab ?? mix.boulder;
    const ANCHORS = mix.anchors ?? [rockId];
    const SATS = mix.sats ?? [rockId];
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
      // Bedding depth is a property of the HULL, not of a single id. A cleaved
      // block and a flat-topped slab both carry their mass above the origin and
      // only need a hand's depth; a centred icosahedron wants a third sunk.
      const flat = id === mix.slab || id === 'blockStone';
      emit(id, v, {
        x, y: h - s * (flat ? rng.float(0.10, 0.22) : rng.float(0.26, 0.42)), z, s,
        r: rng.float(0, Math.PI * 2),
        tx: rng.gauss(0, 0.05), tz: rng.gauss(0, 0.05),
        sy: flat ? rng.float(0.86, 1.18) : rng.float(0.62, 1.00),
      });
      // SHOULDER GRACE FOR STONE, and the reason it exists. Round 6 made the
      // anchor blocks car-sized-or-bigger, because that is what target_01 has
      // sitting a metre off its gravel and it is the frame's clearest scale
      // cue. Shot with `--times`, the drift preset then went from 84 km/h at
      // t13 to THREE: the car ran wide at 130, met a 4 m block three metres off
      // the verge and stopped dead. A rock you cannot see coming, in the band
      // where the game wants you to be, is not a hazard — it is a wall.
      //
      // So roadside stone is drawn and not solid, exactly as roadside trees
      // are, and only genuinely large blocks well off-piste stop the car.
      if (s > 2.7 && !onShoulder(x, z)) this.colliders.push({ x, z, r: s * 0.36 });
      rocks++;
      return true;
    };

    // -- groups
    // ROUND 5. In target_01 a boulder is almost never alone: it is an anchor
    // block with two or three smaller stones lying in a rough LINE off one of
    // its faces, sizes stepping down along the line — the shape a rock makes
    // when it splits and the pieces slide downhill. Ours were an anchor with a
    // symmetrical RING of satellites at 0.8-2.4 anchor-radii, which from above
    // reads as a flower, not a train, and at 42% of the rock budget the other
    // 58% were ambient singles anyway.
    //
    // So: groups take nearly three quarters of the budget, the satellites lie
    // along a heading with only a little lateral scatter, and they are big
    // enough (0.30-0.72 of the anchor) to read as the same rock broken up
    // rather than as gravel that happens to be nearby.
    const groupTarget = Math.round(rockTarget * 0.72);
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
      // Rates cut roughly a third across the board. The detail blanket now
      // supplies a cobble every few metres everywhere, so the BIG groups no
      // longer have to carry "the meadow must contain stone" on their own —
      // and at the old rate, with anchors up to 4.4 units, the hero frame held
      // nine car-sized blocks. target_01 has two.
      const p = 0.15 + rocky * 0.24 + Math.max(0, field) * 0.26 + road * 0.36;
      if (rng.float(0, 1) > p) continue;

      // One anchor block, then a train of smaller ones around it. The anchor is
      // deliberately car-sized or bigger: a boulder that is not clearly larger
      // than the car gives the frame no sense of scale at all.
      const big = lerp(1.6, 3.5, Math.pow(rng.float(0, 1), 1.7)) * (1 + rocky * 0.3);
      const anchorId = rng.pick(ANCHORS);
      if (!dropRock(cx, cz, big, anchorId)) continue;
      grouped++;
      // The train runs DOWNHILL from the anchor where the ground has a slope to
      // speak of, and along an arbitrary heading where it does not. Following
      // the gradient is most of what makes a group look deposited rather than
      // arranged, and it costs two height lookups.
      const eps = 5;
      const gx = T.heightAt(cx + eps, cz) - T.heightAt(cx - eps, cz);
      const gz = T.heightAt(cx, cz + eps) - T.heightAt(cx, cz - eps);
      const gl = Math.hypot(gx, gz);
      let a0 = gl > 0.25 ? Math.atan2(-gz, -gx) : rng.float(0, Math.PI * 2);
      a0 += rng.float(-0.5, 0.5);
      const ux = Math.cos(a0), uz = Math.sin(a0);
      const n2 = rng.int(2, 4);
      // Walk out from the anchor's own edge, stone by stone, each a step
      // smaller than the last. `run` is the distance travelled so far, so the
      // train never doubles back on itself the way a random ring does.
      let run = big * rng.float(0.62, 0.95);
      let s = big * rng.float(0.52, 0.72);
      for (let k = 0; k < n2 && grouped < groupTarget; k++) {
        const lat = rng.gauss(0, big * 0.24);
        const x = cx + ux * run - uz * lat;
        const z = cz + uz * run + ux * lat;
        // A satellite is a DIFFERENT rock that broke off the same joint, not a
        // shrunken copy of the anchor — so it draws its own hull.
        if (dropRock(x, z, s, rng.pick(SATS))) grouped++;
        run += (s + big * 0.34) * rng.float(0.85, 1.45);
        s *= rng.float(0.52, 0.78);
        if (s < big * 0.14) break;
      }
    }

    // -- ambient scatter
    // Deliberately SMALL now. Its job is to keep the meadow floor from being an
    // empty plane between the trains; anything here big enough to read as a
    // boulder in its own right is a lone boulder, which is the exact thing the
    // group pass exists to avoid.
    for (let i = 0; i < rockTarget * 4 && rocks < rockTarget; i++) {
      const x = rng.float(-half, half), z = rng.float(-half, half);
      const n = T.normalAt(x, z, 3.5);
      const rocky = clamp((1 - n.y) * 6, 0, 1);
      const field = fbm(x * 0.0052, z * 0.0052, { octaves: 3, seed: S + 431 });
      const p = 0.12 + rocky * 0.55 + Math.max(0, field) * 0.5;
      if (rng.float(0, 1) > p) continue;
      const s = lerp(0.42, 1.35, Math.pow(rng.float(0, 1), 2.4)) * (1 + rocky * 0.5);
      dropRock(x, z, s, rng.pick(SATS));
    }

    // ---- DETAIL BLANKET --------------------------------------------------
    // See `blanket` in the alpine mix for why this exists. One candidate per
    // cell of the whole map, jittered inside its cell; the only things that can
    // stop it are water, the road band, the spawn pocket and a cliff face.
    const BK = mix.blanket;
    if (BK) {
      const br = new Rng((S ^ 0x2f81a7) >>> 0);
      const cell = BK.cell;
      const n = Math.floor((half * 2) / cell);
      let wsum = 0;
      for (const m of BK.mix) wsum += m.w;
      let blanketed = 0;
      for (let iz = 0; iz < n; iz++) {
        for (let ix = 0; ix < n; ix++) {
          if (br.float(0, 1) > BK.fill) continue;
          const x = -half + (ix + br.float(0.06, 0.94)) * cell;
          const z = -half + (iz + br.float(0.06, 0.94)) * cell;
          const e = envAt(x, z);
          // 0.30 is a 73 degree slope. Ground cover clings to far worse than
          // the 0.55-0.74 gates the species table uses, and the bald hillsides
          // in previous rounds were exactly the ground those gates excluded —
          // shot at 0.42, lake_bridge still came back with a bare wedge of
          // steep meadow in its bottom-left corner and nothing else in the
          // frame was wrong with it.
          if (!e || e.ny < 0.30) continue;
          if (isBlocked(x, z)) continue;
          if (nearSpawn(x, z)) continue;
          let t = br.float(0, wsum), m = BK.mix[BK.mix.length - 1];
          for (const q of BK.mix) { t -= q.w; if (t <= 0) { m = q; break; } }
          const sz = m.size;
          const s = sz[0] + (sz[1] - sz[0]) * Math.pow(br.float(0, 1), 1.3);
          emit(m.id, br.int(0, VARIANTS - 1), {
            x, y: e.h - 0.12, z, s,
            r: br.float(0, Math.PI * 2),
            tx: br.gauss(0, 0.03), tz: br.gauss(0, 0.03),
          });
          blanketed++;
        }
      }
      this.blanketed = blanketed;
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
      // STONE GETS THE WIDEST TEMPERATURE SPREAD IN THE MAP, and this is the
      // last piece of "different rocks". Geometry variety alone still left the
      // meadow with four silhouettes in ONE material: every block the same
      // grey, which from 200 m up reads as one rock cut four ways. In target_01
      // the stones beside its lake are a warm tan-grey, the blocks in its
      // meadow are near-neutral, and one or two of the small ones are frankly
      // purple. +/-11% of red-against-blue on a near-white multiplier spans
      // that without inventing a hex or costing a draw call.
      const stone = /^(boulder|slab|blockStone|cobble|stoneTrain|screePatch)/.test(key);
      const kLo = bloom ? 0.94 : canopy ? 0.86 : stone ? 0.78 : 0.84;
      const kHi = bloom ? 1.10 : canopy ? 1.055 : stone ? 1.10 : 1.14;
      // ...and capped there. At +/-0.11 on a 1.16 multiplier the warm tail of
      // the distribution came out at (1.29, 1.16, 1.03) over an already-bright
      // crown, i.e. SALMON — the exact note the client opened with. 0.075 on a
      // 1.10 ceiling keeps the tan-to-cool spread and cannot reach flesh.
      const wAmp = bloom ? 0.012 : stone ? 0.075 : 0.055;
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
      // Collider count is the number that actually trades against the drive.
      // Without it "raise the density" and "the car got slower" are two
      // unrelated observations instead of one curve.
      colliders: this.colliders.length,
      tris, kinds: buckets.size,
    };
    // Tuning aid, same shape as landmarks' `window.__LM`: what actually got
    // placed, per species. Density arguments are unwinnable without it.
    if (typeof window !== 'undefined') window.__PROPS = { ...this.stats, counts: this.counts };
    return this.group;
  }
}
