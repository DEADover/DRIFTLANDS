import * as THREE from 'three';
import { Rng, fbm, valueNoise2D } from '../core/rng.js';
import { mergeGeometries } from './props.js';

/**
 * ROAD NETWORK — owned by the roads builder.
 *
 * CONTRACT (do not change the shape of the return value; main.js depends on it):
 *   createRoadNetwork(ctx) -> {
 *     group:      THREE.Object3D            added to the scene
 *     isOnRoad(x, z) -> boolean             used for grip + prop keep-out
 *     gripAt(x, z)   -> number              1.0 tarmac, ~0.75 gravel, etc
 *     isBlocked(x, z)-> boolean             keep-out for props (road + verge)
 *     sample(t)      -> {x, z, heading}     point along the main route, t in 0..1
 *     spawn()        -> {x, z, heading}     good starting point on the route
 *     length:     number                    metres of main route
 *   }
 *
 * ctx = { terrain, biome, palette, seed, rng }
 *
 * ADDITIONS (purely additive — nothing existing depends on them):
 *   heightAt(x, z)  -> number|null   road surface height, null when off-road.
 *                                    game.js drives the car on RAW TERRAIN
 *                                    height; until groundAt() consults this the
 *                                    route may only cut/fill by ±0.45 m or the
 *                                    car sinks into its own road.
 *   surfaceAt(x, z) -> {kind, grip}|null
 *   colliders       -> {x,z,r}[]     sign posts, for whoever wants them
 *   waterCrossings  -> [{x,z,heading,span,deckY,ax,az,bx,bz,width}]
 *   barriers        -> { segments, hit(id, speed), update(dt) }
 *                                    breakable timber fences and fixed steel
 *                                    guardrails; see the block above the
 *                                    return statement for the full contract.
 *
 * ---------------------------------------------------------------------------
 * HOW THE ROUTE IS BUILT
 *
 *  1. A closed base loop: polar radius with three harmonics, so it starts life
 *     as a sequence of long sweeps rather than a circle.
 *  2. Terrain adaptation: the loop is relaxed against a cost field (slope,
 *     water depth, altitude, map bounds). This is what makes it hug contours,
 *     run along valley floors and pick narrow necks to cross water.
 *  3. Corner rhythm: designed gaussian lateral displacements are injected on
 *     top — hairpins, chicanes, sweepers, kinks, with ALTERNATING direction and
 *     real straights between them. Each bump decays to zero, so the loop still
 *     closes exactly and the designed rhythm survives the terrain fitting.
 *  4. Curvature limiting + self-separation: always drivable, never crosses
 *     itself, never brushes past itself.
 *  5. Elevation: terrain height smoothed along arc length (the road planes off
 *     bumps), grade-limited to ~17%, lifted onto a level deck across water.
 *  6. Mesh: a laterally LEVELLED corridor. The corridor is flat across the
 *     tangent while the hill is not, so every hillside produces a real cut on
 *     the uphill side and a fill embankment on the downhill side; the batter
 *     faces are marched outward until they meet the terrain.
 * ---------------------------------------------------------------------------
 */

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

const GRIP = {
  tarmac: 1.00,
  gravel: 0.80,
  dirt: 0.72,
  sand: 0.63,
  snow: 0.54,
  ice: 0.40,
};

/** Per-biome road character: width, verge, and the two surfaces it alternates.
 *
 * ART_DIRECTION §3: the carriageway is 12-20 m, three to five car lengths. The
 * alpine reference has no tarmac anywhere in frame — it is a dirt rally road
 * from edge to edge, so alpine alternates gravel and dirt, never tarmac. */
const STYLE = {
  // WIDTH: MEASURED AND LEFT ALONE AT 11.0.
  //
  // "The road is too wide" was tested, not argued about: 11.0 -> 9.2 m, shot and
  // measured. Every number got worse. The road's share of the frame went 17.7% ->
  // 15.2% against the reference's 30.3%, frame mean luma 0.364 -> 0.352 against
  // the target's 0.379, and the frame's dark fraction 32.9% -> 36.1% against
  // 32.5% — because road pixels are brighter than the meadow that replaces them,
  // so narrowing the ribbon darkens the whole picture away from the reference.
  // It also moved the hero spawn (the capture presets score frames off the route),
  // which makes every A/B after it a comparison of two different places.
  //
  // The reference does not get its 30% of frame from a WIDE road. It gets it from
  // a road that crosses the frame four times. Ours crosses once, diagonally, and
  // that — not the metres — is why it reads as an airstrip. Fixing it is a route
  // problem (see `cornerPlan`), not a width one, and it is the one thing left on
  // this file that would move the share.
  alpine: { width: 11.0, verge: 1.5, kinds: ['gravel', 'dirt'], spurs: 2 },
  autumn: { width: 7.4, verge: 1.20, kinds: ['gravel', 'dirt'], spurs: 2 },
  desert: { width: 8.6, verge: 1.60, kinds: ['dirt', 'sand'], spurs: 2 },
  coast: { width: 7.8, verge: 1.05, kinds: ['tarmac', 'gravel'], spurs: 1 },
  winter: { width: 8.4, verge: 1.30, kinds: ['snow', 'ice'], spurs: 2 },
};

/**
 * The measured road colour of the client references. ART_DIRECTION §6 gives
 * `road #c9a45f` for alpine and the same warm ochre for autumn; every dirt and
 * gravel frame in the set sits within a few percent of it. The palettes still
 * carry a grey-brown `road` (alpine ships 0x8a7f6e), which is the single
 * biggest reason our ribbon reads as tarmac in a meadow, so an unsurfaced road
 * is pulled most of the way onto the spec ochre. Sealed surfaces (tarmac) and
 * cold ones (snow, ice) stay on the palette, where grey is correct.
 */
const OCHRE = 0xc9a45f;   // ART_DIRECTION §6 — pale warm dirt

/**
 * THE THREE NUMBERS THAT SET THE ROAD, fitted against the reference's road
 * POPULATION rather than against a lit patch of it. `tools/roadstat.mjs`
 * isolates road pixels in both images by hue and connected-component size and
 * prints the population; that is the statistic these answer to, because a dirt
 * road with a third of itself in shadow is not described by two sunlit pixels.
 *
 *                       ours (before)   reference   after
 *   mean RGB            196,142,71      152,124,46
 *   mean luma           0.581           0.488
 *   G/R                 0.724           0.816
 *   B/R                 0.362           0.303
 *   mean saturation     0.630           0.692
 *
 * The reference road is a KHAKI: more green relative to red than ours and
 * markedly LESS blue. The previous fit had it the other way round (g x1.12,
 * b x1.34) because it was matched to rgb(177,137,69), one of the reference's
 * sunlit patches — and sunlit dirt is pinker than the surface it belongs to,
 * since the shadowed remainder is lit by sky and the sky term is what carries
 * the blue. Fitting the population instead reverses the sign on blue.
 *
 * These are LINEAR-space multipliers on a material colour that then goes through
 * the sun colour and the tonemap, both of which compress ratios toward 1, so
 * they over-correct on purpose. Each value below is what the rendered population
 * actually landed on, not what the arithmetic predicted.
 */
const PALE_LEVEL = 0.52;  // 0.88 -> 0.52; see the ACES note below.
// WHY 0.52 AND NOT 0.47. Swept and measured. At 0.47 the road POPULATION lands
// almost exactly on the reference — rgb(158,128,46) against rgb(152,124,46),
// luma 0.504 against 0.488 — but the frame's luma bucket 6 falls to 3.3 against
// the target's 5.0, i.e. it overshoots the very error this was fixing. At 0.52
// both land at once: the road's own share of bucket 6 is 4.2 points of frame
// against the reference road's 4.2, and the whole frame's bucket 6 is 5.0
// against 5.0. Frame mean luma turns out almost insensitive to this knob
// (0.365 at 0.60, 0.365 at 0.53, 0.361 at 0.47), so the histogram is the
// binding constraint, not the level.
const PALE_G = 1.30;      // was 1.12 — the population wants G/R up, not down
const PALE_B = 1.10;      // was 1.34 — fitted on a sunlit patch, and too blue.
// WHY 1.10 AND NOT 1.06. The grade's saturation expansion is stronger the
// brighter the pixel, so one material cannot land both ends of the road on the
// reference at once. Scanned, our LIT carriageway came out rgb(205,158,44),
// B/R 0.215, against the reference's lit rgb(210,159,73), B/R 0.348 — a mustard
// where the reference has warm sand, which is what the close-range wildlife
// preset shows. Four points of blue takes the lit surface most of the way there
// and, because it also drops the population's saturation from 0.725 to the
// reference's 0.69, it is the one adjustment here that improves BOTH the lit
// patch and the population. It costs about 0.005 of frame mean saturation.

/**
 * LEVEL AND SATURATION, measured against the reference rather than argued about.
 *
 * Sampled inside pure carriageway (no grass, no cast shadow) in target_01:
 * rgb(210,159,73) in full sun and rgb(177,137,69) a little further off. Ours
 * rendered rgb(173,131,58) at its brightest — most of a stop low, and 4 points
 * more saturated because the blue channel is short. That is the other half of
 * "a long way from the references": the reference road is a PALE tan that the
 * meadow sits on, ours was a saturated orange band laid across it.
 *
 * So an unsurfaced surface is lifted 11% and its blue channel a further 12%,
 * which lands rgb(192,146,71) — inside a couple of points of the reference on
 * every channel — without touching the R/G ratio of 1.30 that both agree on.
 * The deeper braid below takes the extra level straight back out of the frame
 * mean, so this is not a brightness grab.
 */
function pale(c) {
  // Green is 0.72 of luminance, so the channel gains below move the LEVEL as
  // well as the hue and this scalar has to answer for it. At 1.11 with those
  // gains the frame put 3.6% of its pixels above L 0.7 against the target's
  // 1.5%; at 0.88 frame mean luma is 0.378 against the target's 0.379.
  //
  // AND IT SETTLES A REAL CONFLICT. Matched to the reference's road exactly —
  // rgb(177,137,69), luma 141 on the cleanest patch either image has — our frame
  // mean luma comes out at 0.395 against the target's 0.379, because our hero
  // camera puts about twice as much road in frame as target_01 does. So the HUE
  // is matched exactly and the LEVEL is held ~9% under the reference, which
  // keeps the frame statistics where the previous round left them. Reported.
  c.multiplyScalar(PALE_LEVEL);
  // Channel ratios, measured on a pure road patch. Ours rgb(176,132,62) against
  // the reference's rgb(177,137,69): G/R 0.750 against 0.774, B/R 0.352 against
  // 0.390. Three percent of green and a fifth more blue is the whole difference,
  // and it is what takes the surface off "orange" and onto "tan".
  // ...AND IT HAS TO OVER-CORRECT, because the pipeline is not neutral. Probed
  // straight off the vertex buffer, the surface's LINEAR ratios are G/R 0.660,
  // B/R 0.241 — sRGB (195,163,102), a proper tan — and it comes out of the sun
  // colour and the tonemap as rendered (176,131,56), G/R 0.744, B/R 0.318. The
  // pipeline eats a fifth of the blue, so the material has to carry more of it
  // than the answer needs.
  // Fitted on the cleanest pure-carriageway patch each image has — ours at
  // (0.10,0.55)-(0.16,0.62), the reference's at (0.70,0.66)-(0.745,0.70), both
  // with a luminance sd under 14, so neither contains grass or cast shadow.
  //
  //   target  rgb(177,137,69)   G/R 0.774   B/R 0.390
  //   ours    rgb(150,128,58)   G/R 0.853   B/R 0.387   <- at g 1.36
  //
  // A first attempt fitted these gains against an RGB SCANLINE instead, and
  // overshot green by 10%: the scanline crossed the carriageway at its outermost
  // slice, where the crown tilts the facet toward the sun and the tonemap treats
  // it as a highlight. A patch average and a scanline are not the same statistic
  // and the road is not one tone.
  c.g = Math.min(1, c.g * PALE_G);
  c.b = Math.min(1, c.b * PALE_B);
  return c;
}

/**
 * PRE-CORRECTION FOR A FACET THE SUN DOES NOT REACH.
 *
 * The batter faces slope down and away from the road, so they are lit mostly by
 * the sky term, which is cold and which the tonemap then does not desaturate the
 * way it does a highlight. Scanned across the hero frame, the apron beside the
 * carriageway rendered rgb(111,127,92) at saturation 0.28 — G above R and four
 * times the blue the material carries — while the carriageway 30 px away
 * rendered rgb(206,160,49) at 0.77. A metre-wide grey-olive band down both sides
 * of the road: the "concrete kerb on a dirt rally stage" again, in its third
 * disguise.
 *
 * Painting it browner is not enough on its own, because the sky ADDS blue rather
 * than scaling it. What works is to take the blue almost entirely out of the
 * material and trim the green, so that what the sky puts back lands on damp
 * earth instead of on concrete. Fitted against the scanline, not derived.
 */
function skyLit(c) {
  c.g *= 0.88;
  c.b *= 0.30;
  return c;
}

function surfaceColour(palette, kind) {
  const road = new THREE.Color(palette.road);
  const edge = new THREE.Color(palette.roadEdge);
  const dark = new THREE.Color(palette.rockShadow);
  const ochre = new THREE.Color(OCHRE);
  const c = road.clone();
  switch (kind) {
    case 'tarmac': return c.lerp(dark, 0.55).multiplyScalar(0.70);
    case 'gravel': return pale(c.lerp(ochre, 0.94).lerp(edge, 0.12));
    case 'dirt': return pale(c.lerp(ochre, 0.94).multiplyScalar(0.93));
    case 'sand': return c.lerp(ochre, 0.55).lerp(edge, 0.40);
    case 'snow': return c.lerp(edge, 0.60);
    case 'ice': return c.lerp(edge, 0.80);
    default: return c;
  }
}

// ---------------------------------------------------------------------------
// Polyline helpers
// ---------------------------------------------------------------------------

function ringLength(p, closed = true) {
  let L = 0;
  const n = p.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = p[i], b = p[(i + 1) % n];
    L += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return L;
}

function resample(pts, spacing, closed = true) {
  const n = pts.length;
  const seg = [];
  let total = 0;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    seg.push(d);
    total += d;
  }
  if (total < 1e-3) return pts.map((p) => ({ x: p.x, z: p.z }));
  const m = Math.max(24, Math.round(total / spacing));
  const step = total / (closed ? m : m - 1);
  const out = [];
  let i = 0, acc = 0;
  for (let k = 0; k < m; k++) {
    const target = k * step;
    while (i < seg.length - 1 && acc + seg[i] < target) { acc += seg[i]; i++; }
    const t = seg[i] > 1e-6 ? clamp((target - acc) / seg[i], 0, 1) : 0;
    const a = pts[i], b = pts[(i + 1) % n];
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }
  return out;
}

function smoothRing(pts, iters, w) {
  const n = pts.length;
  let a = pts.map((p) => ({ x: p.x, z: p.z }));
  for (let it = 0; it < iters; it++) {
    const b = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = a[i], pr = a[(i - 1 + n) % n], nx = a[(i + 1) % n];
      b[i] = {
        x: p.x + w * ((pr.x + nx.x) * 0.5 - p.x),
        z: p.z + w * ((pr.z + nx.z) * 0.5 - p.z),
      };
    }
    a = b;
  }
  return a;
}

function smoothOpen(pts, iters, w) {
  const n = pts.length;
  let a = pts.map((p) => ({ x: p.x, z: p.z }));
  for (let it = 0; it < iters; it++) {
    const b = a.map((p) => ({ x: p.x, z: p.z }));
    for (let i = 1; i < n - 1; i++) {
      b[i].x = a[i].x + w * ((a[i - 1].x + a[i + 1].x) * 0.5 - a[i].x);
      b[i].z = a[i].z + w * ((a[i - 1].z + a[i + 1].z) * 0.5 - a[i].z);
    }
    a = b;
  }
  return a;
}

function blurRing(v, radius, passes = 1, closed = true) {
  const n = v.length;
  let a = Float64Array.from(v);
  for (let p = 0; p < passes; p++) {
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = -radius; k <= radius; k++) {
        let j = i + k;
        if (closed) j = ((j % n) + n) % n;
        else j = clamp(j, 0, n - 1);
        s += a[j]; c++;
      }
      b[i] = s / c;
    }
    a = b;
  }
  return a;
}

/** Unit tangents, left normals and signed curvature along a polyline. */
function frames(pts, closed = true) {
  const n = pts.length;
  const tx = new Float64Array(n), tz = new Float64Array(n);
  const kk = new Float64Array(n);
  const idx = (i) => (closed ? ((i % n) + n) % n : clamp(i, 0, n - 1));
  for (let i = 0; i < n; i++) {
    const a = pts[idx(i - 1)], b = pts[idx(i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l; tz[i] = dz / l;
  }
  for (let i = 0; i < n; i++) {
    const a = idx(i - 1), b = idx(i + 1);
    let dth = Math.atan2(tz[b], tx[b]) - Math.atan2(tz[a], tx[a]);
    while (dth > Math.PI) dth -= TAU;
    while (dth < -Math.PI) dth += TAU;
    const pa = pts[a], pb = pts[b];
    const ds = Math.hypot(pb.x - pa.x, pb.z - pa.z) || 1;
    kk[i] = dth / ds;
  }
  const nx = new Float64Array(n), nz = new Float64Array(n);
  for (let i = 0; i < n; i++) { nx[i] = -tz[i]; nz[i] = tx[i]; }
  return { tx, tz, nx, nz, k: kk };
}

// ---------------------------------------------------------------------------
// Route generation
// ---------------------------------------------------------------------------

function terrainSlope(terrain, x, z, e = 7) {
  const hx = terrain.heightAt(x + e, z) - terrain.heightAt(x - e, z);
  const hz = terrain.heightAt(x, z + e) - terrain.heightAt(x, z - e);
  return Math.hypot(hx, hz) / (2 * e);
}

/**
 * How expensive is it to build road here? Low cost = gentle, dry, inside the
 * map. Water is expensive but never forbidden, so the relaxation slides the
 * route toward the NARROWEST neck of a lake instead of avoiding water entirely.
 */
function makeCost(terrain, biome, wetScale = 1) {
  const wl = biome.waterLevel;
  const lim = biome.size * 0.5 - 150;
  // THE VALLEY FLOOR IS THE SET. Alpine's terrain ramp turns pale green above
  // ~48 m and goes to scree and snow above ~110 m; a route that climbs the bank
  // therefore drags the whole frame off the deep green the client asked for.
  // Holding the ceiling down near the meadow is the cheapest colour fix we own.
  const hiCap = biome.id === 'desert' ? 200 : 30;
  return function cost(x, z) {
    const h = terrain.heightAt(x, z);
    const s = terrainSlope(terrain, x, z, 8);
    let c = s * s * 300 + s * 12;
    const sub = wl + 2.0 - h;
    if (sub > 0) c += wetScale * (85 + sub * 9.0);
    if (h > hiCap) c += (h - hiCap) * (h - hiCap) * 0.14 + (h - hiCap) * 4.0;
    const r = Math.max(Math.abs(x), Math.abs(z));
    if (r > lim) c += (r - lim) * (r - lim) * 0.03 + (r - lim) * 4;
    return c;
  };
}

/** Tiny binary heap, keyed by float. */
class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  _swap(a, b) {
    const k = this.k[a]; this.k[a] = this.k[b]; this.k[b] = k;
    const v = this.v[a]; this.v[a] = this.v[b]; this.v[b] = v;
  }
  push(key, val) {
    let i = this.k.length;
    this.k.push(key); this.v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      this._swap(p, i); i = p;
    }
  }
  pop() {
    const top = this.v[0];
    const lk = this.k.pop(), lv = this.v.pop();
    const n = this.k.length;
    if (n > 0) {
      this.k[0] = lk; this.v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < n && this.k[l] < this.k[m]) m = l;
        if (r < n && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        this._swap(m, i); i = m;
      }
    }
    return top;
  }
}

/**
 * A traversal-cost raster of the whole map. This is the road engineer's view:
 * every cell carries a "metres of effort per metre travelled" multiplier, so a
 * least-cost path through it naturally follows valley floors, contours the side
 * of a hill instead of climbing it, and crosses a lake at its narrowest neck.
 */
function costGrid(terrain, biome) {
  const dryCost = makeCost(terrain, biome, 0);
  const size = biome.size;
  const N = clamp(Math.round(size / 14), 96, 148);
  const step = size / N;
  const half = size / 2;
  const n = N * N;
  const W = new Float64Array(n);
  const H = new Float64Array(n);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -half + (i + 0.5) * step;
      const z = -half + (j + 0.5) * step;
      W[j * N + i] = dryCost(x, z);
      H[j * N + i] = terrain.heightAt(x, z);
    }
  }

  // Distance to the nearest shore, over water only. This is the bridge-cost
  // field: a 40 m neck is cheap to span, the middle of a lake is not. It is
  // what makes the circuit cross rivers at sensible points instead of either
  // wading across a lake or refusing to touch water at all.
  const wl = biome.waterLevel;
  const INF = 1e9;
  const dw = new Float64Array(n);
  for (let c = 0; c < n; c++) dw[c] = H[c] < wl + 0.5 ? INF : 0;
  const dg = step * 1.41421356;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = j * N + i;
      if (dw[c] === 0) continue;
      let m = dw[c];
      if (i > 0) m = Math.min(m, dw[c - 1] + step);
      if (j > 0) m = Math.min(m, dw[c - N] + step);
      if (i > 0 && j > 0) m = Math.min(m, dw[c - N - 1] + dg);
      if (i < N - 1 && j > 0) m = Math.min(m, dw[c - N + 1] + dg);
      dw[c] = m;
    }
  }
  for (let j = N - 1; j >= 0; j--) {
    for (let i = N - 1; i >= 0; i--) {
      const c = j * N + i;
      if (dw[c] === 0) continue;
      let m = dw[c];
      if (i < N - 1) m = Math.min(m, dw[c + 1] + step);
      if (j < N - 1) m = Math.min(m, dw[c + N] + step);
      if (i < N - 1 && j < N - 1) m = Math.min(m, dw[c + N + 1] + dg);
      if (i > 0 && j < N - 1) m = Math.min(m, dw[c + N - 1] + dg);
      dw[c] = m;
    }
  }
  for (let c = 0; c < n; c++) {
    if (H[c] < wl + 0.5) W[c] += 8 + dw[c] * 0.80 + (wl - H[c]) * 1.6;
    W[c] = 1 + W[c] * 0.021;
  }

  return {
    N, step, half, W, H,
    xOf: (i) => -half + (i + 0.5) * step,
    zOf: (j) => -half + (j + 0.5) * step,
  };
}

const D8I = [1, -1, 0, 0, 1, 1, -1, -1];
const D8J = [0, 0, 1, -1, 1, -1, 1, -1];

function dijkstra(g, src) {
  const N = g.N, n = N * N;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  dist[src] = 0;
  heap.push(0, src);
  while (heap.size) {
    const key = heap.k[0];
    const u = heap.pop();
    if (key > dist[u] + 1e-9) continue;
    const ui = u % N, uj = (u - ui) / N;
    for (let d = 0; d < 8; d++) {
      const vi = ui + D8I[d], vj = uj + D8J[d];
      if (vi < 0 || vj < 0 || vi >= N || vj >= N) continue;
      const v = vj * N + vi;
      const len = d < 4 ? g.step : g.step * 1.41421356;
      const nd = dist[u] + len * (g.W[u] + g.W[v]) * 0.5;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; heap.push(nd, v); }
    }
  }
  return { dist, prev };
}

/**
 * Control towns: a handful of well-separated pieces of good ground that the
 * circuit has to visit. Farthest-point sampling keeps them spread across the
 * map; the seeded pick among the top candidates keeps seeds distinct.
 */
function pickWaypoints(g, rng, biome, K) {
  const wl = biome.waterLevel;
  const N = g.N;
  const margin = Math.round(N * 0.10);
  const cand = [];
  for (let j = margin; j < N - margin; j++) {
    for (let i = margin; i < N - margin; i++) {
      const c = j * N + i;
      if (g.H[c] < wl + 4) continue;
      cand.push(c);
    }
  }
  if (cand.length < K) return [];
  const sorted = cand.slice().sort((a, b) => g.W[a] - g.W[b]);
  const wLimit = g.W[sorted[Math.floor(sorted.length * 0.55)]];
  const good = cand.filter((c) => g.W[c] <= wLimit);
  const pool = good.length >= K * 8 ? good : cand;

  const chosen = [pool[rng.int(0, pool.length - 1)]];
  while (chosen.length < K) {
    const scored = [];
    for (const c of pool) {
      const ci = c % N, cj = (c - ci) / N;
      let mind = Infinity;
      for (const o of chosen) {
        const oi = o % N, oj = (o - oi) / N;
        const d = Math.hypot(ci - oi, cj - oj);
        if (d < mind) mind = d;
      }
      scored.push([mind * g.step - g.W[c] * 26, c]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const top = scored.slice(0, 8);
    chosen.push(top[rng.int(0, top.length - 1)][1]);
  }
  return chosen;
}

/** Cheapest Hamiltonian cycle over the waypoints (K is small: brute force). */
function bestTour(K, D) {
  const order = [];
  for (let i = 1; i < K; i++) order.push(i);
  let best = null, bestC = Infinity;
  const perm = (arr, cur) => {
    if (!arr.length) {
      let c = D[0][cur[0]];
      for (let i = 0; i + 1 < cur.length; i++) c += D[cur[i]][cur[i + 1]];
      c += D[cur[cur.length - 1]][0];
      if (c < bestC) { bestC = c; best = cur.slice(); }
      return;
    }
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      cur.push(arr[i]);
      perm(rest, cur);
      cur.pop();
    }
  };
  perm(order, []);
  return [0, ...best];
}

/**
 * Step 1 — the circuit: least-cost paths between control points, stitched into
 * a closed tour. This is what makes the route READ as engineered rather than
 * doodled: it goes round the lake, up the valley and over the saddle because
 * those are genuinely the cheapest lines across this terrain.
 */
function circuit(g, rng, biome) {
  const K = g.N * g.step > 1750 ? 6 : 5;
  const wps = pickWaypoints(g, rng, biome, K);
  if (wps.length < 3) return null;
  const runs = wps.map((c) => dijkstra(g, c));
  const D = wps.map((_, a) => wps.map((_, b) => runs[a].dist[wps[b]]));
  for (const row of D) for (const v of row) if (!isFinite(v)) return null;
  const tour = bestTour(wps.length, D);

  const pts = [];
  for (let t = 0; t < tour.length; t++) {
    const a = tour[t], b = tour[(t + 1) % tour.length];
    const prev = runs[a].prev;
    const leg = [];
    let c = wps[b];
    let guard = 0;
    while (c !== wps[a] && c >= 0 && guard++ < g.N * g.N) { leg.push(c); c = prev[c]; }
    leg.push(wps[a]);
    leg.reverse();            // a -> b
    for (let i = 0; i < leg.length - 1; i++) {
      const cell = leg[i];
      const ci = cell % g.N, cj = (cell - ci) / g.N;
      pts.push({ x: g.xOf(ci), z: g.zOf(cj) });
    }
  }
  // strip duplicated consecutive cells
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.z - q.z) > 1e-3) out.push(p);
  }
  return out.length > 24 ? out : null;
}

/** Step 2 — relax the loop against the terrain cost field. */
function adaptToTerrain(pts, cost, opts) {
  const { iters = 28, probe = 12, rate = 1.0, maxOff = 150, stepMax = 7 } = opts;
  const n = pts.length;
  const base = pts.map((p) => ({ x: p.x, z: p.z }));
  let cur = pts.map((p) => ({ x: p.x, z: p.z }));
  for (let it = 0; it < iters; it++) {
    const f = frames(cur);
    const move = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = cur[i];
      const g = (cost(p.x + f.nx[i] * probe, p.z + f.nz[i] * probe)
        - cost(p.x - f.nx[i] * probe, p.z - f.nz[i] * probe)) / (2 * probe);
      move[i] = clamp(-g * rate, -stepMax, stepMax);
    }
    const sm = blurRing(move, 3, 2);
    for (let i = 0; i < n; i++) {
      let x = cur[i].x + f.nx[i] * sm[i];
      let z = cur[i].z + f.nz[i] * sm[i];
      const dx = x - base[i].x, dz = z - base[i].z;
      const d = Math.hypot(dx, dz);
      if (d > maxOff) { x = base[i].x + (dx / d) * maxOff; z = base[i].z + (dz / d) * maxOff; }
      cur[i] = { x, z };
    }
    cur = smoothRing(cur, 2, 0.28);
  }
  return cur;
}

/**
 * A lateral gaussian bump of amplitude A and width σ has, at its crest, radius
 *
 *      r = σ² / (2A)
 *
 * and turns the road through roughly 1.715·σ/r radians in total (out one way at
 * the flanks, hard back at the crest, out again — which is exactly the entry /
 * apex / exit of a corner). So a corner is specified the way a road engineer
 * specifies one — by RADIUS — and σ follows from how much of a turn we want:
 *
 *      σ = shape · r        shape 1.2 → ~2 rad,   shape 1.9 → ~3.3 rad
 *
 * That is the whole trick. The previous plan picked σ and an amplitude ratio
 * independently, which meant its "sweepers" came out at 130-180 m radius —
 * indistinguishable from a straight line at a 200 m camera height — and its
 * "hairpins" came out at 11 m and were promptly flattened by the curvature
 * limiter. Nothing in between ever got built, and the frame had no shape.
 */
function corner(rng, r0, r1, shape) {
  const r = rng.float(r0, r1);
  const sg = shape * r;
  return { sigma: sg, amp: (sg * sg) / (2 * r) };
}

/**
 * Step 3 — the corner plan. A rally stage is a RHYTHM: a straight to breathe,
 * a long sweeper you can hold sideways, a hairpin that demands the handbrake, a
 * chicane that flips the car the other way. Direction alternates so drifts link
 * and so the route never reads as one big circle.
 *
 * ART_DIRECTION wants the road to BE the composition, so the mix is deliberately
 * corner-heavy: at a 200 m camera height anything over ~180 m radius photographs
 * as a straight line, so "sweeper" here means 120-170 m, not 300.
 */
function cornerPlan(rng, L) {
  const feats = [];
  let s = rng.float(0, 60);
  let sign = rng.sign();
  let guard = 0;
  const put = (c) => {
    feats.push({ s, sigma: c.sigma, amp: sign * c.amp });
    sign = -sign;
  };

  // A stage is not a uniform sprinkle of corners — it BREATHES, alternating
  // fast sections you can carry speed through with technical sections that
  // demand the handbrake. Two reasons that matters here, and the second is the
  // one that turned the frame around:
  //
  //  1. It is what a real stage does, and it is what the reference reads as.
  //  2. The capture autopilot never lifts, so it reaches 42 m/s in 270 m and
  //     can only hold ~200 m of radius by the end. On a route with corners
  //     sprinkled evenly, almost no 270 m window is drivable at that speed and
  //     spawn() has nothing to choose from — it was picking from 102 stations
  //     out of 1143. A fast section long enough to spawn in, running INTO a
  //     technical section, is the composition and the drivability at once: the
  //     car arrives on the road, and the hairpin is a hundred metres up the
  //     picture where nothing has to drive it.
  while (s < L - 160 && guard++ < 300) {
    // --- fast: long open curves, the part the shutter opens on ---------------
    const fastEnd = s + rng.float(430, 620);
    while (s < fastEnd && s < L - 160) {
      if (rng.float(0, 1) < 0.34) { s += rng.float(160, 250); continue; }
      const c = corner(rng, 190, 300, 1.05);
      put(c);
      s += c.sigma * 1.7 + rng.float(110, 190);
    }
    // --- technical: the part the picture is pointed at -----------------------
    const techEnd = s + rng.float(270, 430);
    while (s < techEnd && s < L - 160) {
      const roll = rng.float(0, 1);
      if (roll < 0.32) {
        const c = corner(rng, 26, 35, 1.95);        // ~3.3 rad — it doubles back
        put(c);
        s += c.sigma * 2.0 + rng.float(70, 130);
      } else if (roll < 0.64) {
        // Two opposite corners sharing an exit and an entry: the S the client
        // reference is built on. Mild individually so the pair stays drivable.
        const c = corner(rng, 55, 78, 1.15);
        feats.push({ s, sigma: c.sigma, amp: sign * c.amp });
        feats.push({ s: s + c.sigma * 1.9, sigma: c.sigma, amp: -sign * c.amp });
        sign = -sign;
        s += c.sigma * 3.4 + rng.float(70, 130);
      } else {
        const c = corner(rng, 44, 88, 1.60);
        put(c);
        s += c.sigma * 1.9 + rng.float(70, 130);
      }
    }
  }
  return feats;
}

/** Apply the corner plan as lateral gaussian displacement. Closure stays exact. */
function injectCorners(pts, feats, L) {
  const n = pts.length;
  const f = frames(pts);
  const ds = L / n;
  const disp = new Float64Array(n);
  for (const ft of feats) {
    const i0 = Math.round(ft.s / ds);
    const reach = Math.ceil((ft.sigma * 3) / ds);
    for (let d = -reach; d <= reach; d++) {
      const i = (((i0 + d) % n) + n) % n;
      const dist = d * ds;
      disp[i] += ft.amp * Math.exp(-(dist * dist) / (ft.sigma * ft.sigma));
    }
  }
  return pts.map((p, i) => ({ x: p.x + f.nx[i] * disp[i], z: p.z + f.nz[i] * disp[i] }));
}

/** Pull the route back out of water where a corner pushed it in. */
function repairRing(pts, ref, biome, terrain) {
  const n = pts.length;
  const wl = biome.waterLevel;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = terrain.heightAt(pts[i].x, pts[i].z);
    const hr = terrain.heightAt(ref[i].x, ref[i].z);
    w[i] = (h < wl + 1.0 && hr > wl + 1.0) ? 1 : 0;
  }
  const sm = blurRing(w, 4, 2);
  return pts.map((p, i) => ({
    x: lerp(p.x, ref[i].x, clamp(sm[i], 0, 1) * 0.85),
    z: lerp(p.z, ref[i].z, clamp(sm[i], 0, 1) * 0.85),
  }));
}

/** Keep every corner drivable: relax anything tighter than rMin. */
function limitCurvature(pts, rMin, iters = 90) {
  const n = pts.length;
  let a = pts.map((p) => ({ x: p.x, z: p.z }));
  const kMax = 1 / rMin;
  for (let it = 0; it < iters; it++) {
    const f = frames(a);
    let worst = 0;
    const b = a.map((p) => ({ x: p.x, z: p.z }));
    for (let i = 0; i < n; i++) {
      const ex = Math.abs(f.k[i]) / kMax;
      if (ex > worst) worst = ex;
      if (ex <= 1) continue;
      const lam = clamp((ex - 1) * 0.5, 0, 0.42);
      const pr = a[(i - 1 + n) % n], nx = a[(i + 1) % n];
      b[i].x = a[i].x + lam * ((pr.x + nx.x) * 0.5 - a[i].x);
      b[i].z = a[i].z + lam * ((pr.z + nx.z) * 0.5 - a[i].z);
    }
    a = b;
    if (worst <= 1.02) break;
  }
  return a;
}

function segCross(a, b, c, d) {
  const rx = b.x - a.x, rz = b.z - a.z;
  const sx = d.x - c.x, sz = d.z - c.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / den;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / den;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

/**
 * A least-cost tour can cross itself where two legs are drawn to the same
 * saddle. Local repulsion cannot undo a crossing — you have to cut the knot.
 * Snip at the intersection and keep the longer of the two resulting loops.
 */
function deloop(input) {
  let pts = input;
  for (let pass = 0; pass < 10; pass++) {
    const n = pts.length;
    if (n < 12) break;
    let hit = null;
    for (let i = 0; i < n && !hit; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        if (segCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) { hit = [i, j]; break; }
      }
    }
    if (!hit) break;
    const [i, j] = hit;
    const lenA = j - i;
    pts = lenA * 2 >= n ? pts.slice(i + 1, j + 1) : pts.slice(j + 1).concat(pts.slice(0, i + 1));
  }
  return pts;
}

/** Stop distant parts of the loop from touching (no accidental crossroads). */
function separate(pts, minDist, arcGap, iters = 14) {
  const n = pts.length;
  const cell = minDist;
  let a = pts.map((p) => ({ x: p.x, z: p.z }));
  for (let it = 0; it < iters; it++) {
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      const k = `${Math.floor(a[i].x / cell)},${Math.floor(a[i].z / cell)}`;
      let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(i);
    }
    const push = new Array(n);
    for (let i = 0; i < n; i++) push[i] = { x: 0, z: 0, c: 0 };
    let hits = 0;
    for (let i = 0; i < n; i++) {
      const ci = Math.floor(a[i].x / cell), cj = Math.floor(a[i].z / cell);
      for (let u = -1; u <= 1; u++) {
        for (let v = -1; v <= 1; v++) {
          const l = grid.get(`${ci + u},${cj + v}`);
          if (!l) continue;
          for (const j of l) {
            if (j === i) continue;
            const arc = Math.min(Math.abs(i - j), n - Math.abs(i - j));
            if (arc < arcGap) continue;
            const dx = a[i].x - a[j].x, dz = a[i].z - a[j].z;
            const d = Math.hypot(dx, dz);
            if (d < 1e-4 || d >= minDist) continue;
            hits++;
            const f = ((minDist - d) * 0.5) / d;
            push[i].x += dx * f; push[i].z += dz * f; push[i].c++;
          }
        }
      }
    }
    if (!hits) break;
    for (let i = 0; i < n; i++) {
      if (push[i].c) { a[i].x += push[i].x / push[i].c; a[i].z += push[i].z / push[i].c; }
    }
    a = smoothRing(a, 1, 0.2);
  }
  return a;
}

/** Fraction of a polyline that sits below the water line — a build-time check. */
function wetFraction(pts, terrain, biome) {
  let w = 0;
  for (const p of pts) if (terrain.heightAt(p.x, p.z) < biome.waterLevel) w++;
  return w / pts.length;
}

function buildRoute(ctx, style, rng) {
  const { terrain, biome } = ctx;
  const cost = makeCost(terrain, biome, 0.45);
  const grid = costGrid(terrain, biome);
  const dbg = globalThis.__ROADS_DEBUG;
  const stage = (name, p) => { if (dbg) dbg.push(`${name}: wet=${(100 * wetFraction(p, terrain, biome)).toFixed(0)}% n=${p.length}`); };

  let pts = circuit(grid, rng, biome);
  if (!pts) {
    // Degenerate world (no dry land found) — fall back to a plain ring so the
    // game still has a route rather than nothing at all.
    pts = [];
    const R = biome.size * 0.3;
    for (let i = 0; i < 96; i++) {
      const th = (i / 96) * TAU;
      pts.push({ x: Math.cos(th) * R, z: Math.sin(th) * R });
    }
  }
  stage('circuit', pts);
  pts = resample(pts, 16);
  pts = deloop(pts);
  // The grid path is 45-degree quantised; smooth it into something a surveyor
  // would sign off, then let the fine relaxation settle it back onto a contour.
  pts = smoothRing(pts, 26, 0.34);
  pts = adaptToTerrain(pts, cost, {
    iters: 20, probe: 15, rate: 1.0, maxOff: 90, stepMax: 5,
  });
  stage('adapt', pts);
  pts = resample(pts, 8);

  const L0 = ringLength(pts);
  const feats = cornerPlan(rng, L0);
  const ref = pts;
  pts = injectCorners(pts, feats, L0);
  stage('corners', pts);
  pts = repairRing(pts, ref, biome, terrain);
  stage('repair', pts);
  pts = resample(pts, 6);
  pts = limitCurvature(pts, 26, 140);
  // 52 m, not 40. A hairpin's two legs each carry 15 m of carriageway plus a
  // skirt, so at 40 m of separation the meadow between them is barely a car
  // wide and the pair renders as one blob of ochre with a green splinter in it
  // — which is exactly what the close preset showed. 52 m leaves a strip of
  // real meadow between the legs, which is what the reference draws (and what
  // the tree builder needs somewhere to put a clump).
  pts = separate(pts, 52, 26, 16);
  pts = deloop(pts);
  pts = limitCurvature(pts, 26, 90);
  pts = smoothRing(pts, 4, 0.22);
  // THE LAST WORD ON CURVATURE, at the density the car and the mesh actually
  // see. Limiting at 6 m spacing and then resampling to 3 m used to leave 6 m
  // radius spikes in the finished route: the spikes live BETWEEN the stations
  // the limiter was looking at. The mesh survives them (capU folds the inside
  // of the section away) but the autopilot does not — it was being thrown
  // fifteen metres into the meadow by corners that no measurement of the route
  // admitted existed. Anything under ~22 m is not a hairpin, it is a kink.
  let fine = resample(pts, 3.0);
  fine = limitCurvature(fine, 24, 260);
  fine = smoothRing(fine, 5, 0.20);
  // Two hundred more iterations, because the limiter relaxes a spike by at most
  // 0.42 of the local correction per pass and a hard one needs a long time to
  // bleed out. Left at 80 it converged on the alpine seed and stalled at an
  // 11 m radius on the lake seed — and an 11 m radius is a hole the autopilot
  // falls into on any route it appears in, not just the one being photographed.
  fine = limitCurvature(fine, 24, 260);
  stage('final', fine);
  return fine;
}

// ---------------------------------------------------------------------------
// Per-sample description of a ribbon of road
// ---------------------------------------------------------------------------

function describe(ctx, pts, opts) {
  const { terrain, biome } = ctx;
  const {
    closed = true, width, verge, kinds, surfSeed,
    smoothSigma = 9, deckRise = 2.4,
  } = opts;
  const n = pts.length;
  const f = frames(pts, closed);

  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    s[i] = s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  }
  const L = closed
    ? s[n - 1] + Math.hypot(pts[0].x - pts[n - 1].x, pts[0].z - pts[n - 1].z)
    : s[n - 1];
  const ds = L / (closed ? n : n - 1);

  // --- elevation -----------------------------------------------------------
  const yT = new Float64Array(n);
  for (let i = 0; i < n; i++) yT[i] = terrain.heightAt(pts[i].x, pts[i].z);

  const rad = Math.max(1, Math.round(smoothSigma / ds));
  let yS = blurRing(yT, rad, 3, closed);

  const gMax = 0.17 * ds;
  for (let it = 0; it < 160; it++) {
    let bad = 0;
    const nxt = Float64Array.from(yS);
    for (let i = 0; i < n; i++) {
      const j = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
      if (j === i) continue;
      const d = yS[j] - yS[i];
      if (Math.abs(d) > gMax) {
        bad++;
        const corr = (Math.abs(d) - gMax) * 0.5 * Math.sign(d);
        nxt[i] += corr; nxt[j] -= corr;
      }
    }
    yS = nxt;
    if (!bad) break;
  }
  yS = blurRing(yS, rad, 1, closed);

  // --- water spans ---------------------------------------------------------
  const wl = biome.waterLevel;
  const wet = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (yT[i] < wl + 0.4) wet[i] = 1;
  const gapN = Math.max(1, Math.round(18 / ds));
  const filled = Uint8Array.from(wet);
  for (let i = 0; i < n; i++) {
    if (wet[i]) continue;
    let before = 0, after = 0;
    for (let k = 1; k <= gapN; k++) if (wet[(i - k + n) % n]) { before = 1; break; }
    for (let k = 1; k <= gapN; k++) if (wet[(i + k) % n]) { after = 1; break; }
    if (before && after) filled[i] = 1;
  }

  const spans = [];
  if (closed) {
    let dry = -1;
    for (let i = 0; i < n; i++) if (!filled[i]) { dry = i; break; }
    if (dry >= 0) {
      let i = 0;
      while (i < n) {
        const a = (dry + i) % n;
        if (filled[a]) {
          let j = i;
          while (j < n && filled[(dry + j) % n]) j++;
          spans.push([a, (dry + j - 1) % n, j - i]);
          i = j;
        } else i++;
      }
    }
  }

  const deck = new Float64Array(n);
  const deckMask = new Float64Array(n);
  const rampN = Math.max(2, Math.round(26 / ds));
  const crossings = [];
  for (const [a, b, len] of spans) {
    if (len < 2 || len * ds > 460) continue;
    const ha = yS[(a - rampN + n) % n], hb = yS[(b + rampN) % n];
    const dy = Math.max(wl + deckRise, Math.min(ha, hb) + 0.5);
    for (let k = -rampN; k < len + rampN; k++) {
      const i = (((a + k) % n) + n) % n;
      let w = 1;
      if (k < 0) w = 1 + k / rampN;
      else if (k >= len) w = 1 - (k - len + 1) / rampN;
      w = clamp(w, 0, 1);
      w = w * w * (3 - 2 * w);
      if (w > deckMask[i]) { deckMask[i] = w; deck[i] = dy; }
    }
    const mid = (a + Math.floor(len / 2)) % n;
    crossings.push({
      x: pts[mid].x, z: pts[mid].z,
      heading: Math.atan2(f.tz[mid], f.tx[mid]),
      span: len * ds,
      deckY: dy,
      ax: pts[a].x, az: pts[a].z, bx: pts[b].x, bz: pts[b].z,
      width,
    });
  }

  // Final surface height. game.js puts the car on RAW terrain height, so the
  // carriageway may only stray from it by a few centimetres — the cut-and-fill
  // read comes from levelling the corridor LATERALLY, not from the profile.
  const maxD = 0.45;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = yS[i] - yT[i];
    const ground = yT[i] + maxD * Math.tanh(d / maxD);
    y[i] = lerp(ground, deck[i], deckMask[i]);
  }

  // --- banking -------------------------------------------------------------
  const bankRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = 1 / Math.max(1e-6, Math.abs(f.k[i]));
    const a = clamp(0.62 / Math.sqrt(Math.max(14, r)), 0, 0.135);
    bankRaw[i] = -Math.sign(f.k[i]) * a;
  }
  const bank = blurRing(bankRaw, Math.max(1, Math.round(10 / ds)), 2, closed);

  // --- surface variety along the route -------------------------------------
  const surf = new Array(n);
  const runs = Math.max(3, Math.round(L / 230));
  for (let i = 0; i < n; i++) {
    const q = Math.floor((i * runs) / n);
    const v = fbm(q * 0.61 + 0.13, surfSeed * 0.017, { octaves: 2, seed: surfSeed });
    surf[i] = v > 0.05 ? kinds[1] : kinds[0];
  }

  // widen a little through hairpins, the way a real road does
  const halfW = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const extra = clamp((Math.abs(f.k[i]) - 1 / 90) * 190, 0, 1.6);
    halfW[i] = width * 0.5 + extra;
  }
  const halfWs = blurRing(halfW, Math.max(1, Math.round(12 / ds)), 2, closed);

  // --- terrain cross-slope, so the bench can sit ON the hill ----------------
  // Measured across the actual carriageway rather than at a fixed probe: what
  // matters is the drop from one edge of THIS section to the other.
  const tiltRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.max(3, halfWs[i]);
    const hp = terrain.heightAt(pts[i].x + f.nx[i] * d, pts[i].z + f.nz[i] * d);
    // 0.86 of the ground's tilt: the bench still reads as engineered, but the
    // residual it has to bridge is small enough that the carriageway does not
    // have to be jacked up off the hill to clear its own uphill edge.
    const hm = terrain.heightAt(pts[i].x - f.nx[i] * d, pts[i].z - f.nz[i] * d);
    tiltRaw[i] = clamp(((hp - hm) / (2 * d)) * 0.86, -0.26, 0.26);
  }
  const tilt = blurRing(tiltRaw, Math.max(1, Math.round(14 / ds)), 2, closed);

  // --- clearance ------------------------------------------------------------
  // Whatever is left after tilting, the ground still pokes through: the terrain
  // mesh is jittered and its triangles are ~10 m across, so a single high
  // vertex halfway to the shoulder will spear the carriageway and the road
  // appears to be chewed into pieces. Raise each section by however much its
  // own worst poke-through needs — no more. Capped at 0.30 m because game.js
  // still drives the car on RAW terrain height (see the note in `describe`).
  const clearRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const hw = halfWs[i];
    let worst = 0;
    for (const q of [-1, -0.7, -0.4, 0.4, 0.7, 1]) {
      const u = q * hw;
      const g = terrain.heightAt(pts[i].x + f.nx[i] * u, pts[i].z + f.nz[i] * u);
      // plane of the section before clearance: y + tilt*u - bank*u
      const plane = y[i] + LIFT + tilt[i] * u - bank[i] * u;
      const poke = g + 0.10 - plane;
      if (poke > worst) worst = poke;
    }
    clearRaw[i] = clamp(worst, 0, 0.15);
  }
  const clearance = blurRing(clearRaw, Math.max(1, Math.round(10 / ds)), 2, closed);

  // Curvature as the WORN LINE sees it: a car takes ~25 m to change its mind,
  // so the rut drift has to be driven by a smoothed curvature or the ruts
  // shimmy from station to station instead of swinging through the corner.
  const kSm = blurRing(Float64Array.from(f.k), Math.max(1, Math.round(24 / ds)), 2, closed);

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const rl = rutLine(kSm[i]);
    out[i] = {
      x: pts[i].x, z: pts[i].z, s: s[i],
      y: y[i] + clearance[i] * (1 - deckMask[i]), yT: yT[i],
      tx: f.tx[i], tz: f.tz[i], nx: f.nx[i], nz: f.nz[i], k: f.k[i], ks: kSm[i],
      rutShift: rl.shift, rutSpread: rl.spread,
      rutL: warpU(-RUT_U, rl.shift, rl.spread),
      rutR: warpU(RUT_U, rl.shift, rl.spread),
      bank: bank[i], surf: surf[i], hw: halfWs[i], verge,
      // a bridge deck is a level structure — no ground tilt out over the water
      tilt: deckMask[i] > 0.02 ? tilt[i] * (1 - deckMask[i]) : tilt[i],
      wet: deckMask[i] > 0.02,
    };
  }
  return { samples: out, length: L, closed, crossings, ds };
}

// ---------------------------------------------------------------------------
// Mesh building
// ---------------------------------------------------------------------------

const LIFT = 0.12;   // above the terrain profile — just enough to beat z-fight
const CROWN = 0.10;  // camber drop at the carriageway edge
// Steepest LATERAL gradient the carriageway surface itself may show, after the
// drape has finished protecting it from the ground. 0.42 is 23 degrees: a road
// can be cross-fallen, cambered and rutted, but it cannot kick its outer metre
// up like a skateboard ramp. See the row clamp in `buildRibbonMesh`.
const LIP_MAX = 0.42;
// The shoulder ALWAYS gets this much soft blend. 1.6 m plus a 1.5 m verge put
// three metres of apron down each side of the carriageway; target_01 goes from
// dust to meadow in a metre to a metre and a half, and three metres of it read
// as a hard shoulder. 1.15 m is still ~16 px of blend at this camera height,
// which with the ragged-edge noise is enough that the road never ends on a line.
const SKIRT_MIN = 1.15;
const RUT_DEPTH = 0.11; // how deep the wheel ruts are worn in

/**
 * THE ANGLE OF REPOSE — why the embankment is no longer a wall.
 * ------------------------------------------------------------
 * The client photographed a height change built as a single vertical polygon
 * and said, correctly, that mountains do not form that way. Audited with
 * `auditSlopes` (below) on the shipped build: 256 of 260 stations carried a
 * perpendicular step steeper than 45 degrees and the worst was 31 metres of
 * drop per metre out — a box canyon, not terrain.
 *
 * The road's share of that was structural. `BANK_MAX` was 5 m: whatever the
 * height difference, the batter had five metres to resolve it, so against a
 * 30 m drop the "slope" was 6:1 — 80 degrees. The batter slope constants were
 * already sane (0.75 fill); the LENGTH was the bug. So the skirt is no longer a
 * fixed number of facets over a capped width. It MARCHES: each step descends by
 * at most the angle of repose and stops the moment the ground comes within
 * reach, so the footprint is a function of the height difference and the face
 * is never steeper than a real tip of spoil.
 *
 * Loose dry fill stands at 33-37 degrees; a cut face in soil and scree holds
 * closer to 40. Anything over 45 is masonry, and masonry is what the client
 * rejected.
 */
const FILL_SLOPE = 0.66;   // tan 33.4 deg — spoil tipped over the downhill edge
const CUT_SLOPE = 0.82;    // tan 39.4 deg — a face cut into the hillside
/**
 * A 22 m drop at the angle of repose is a 33 m talus, and one unbroken 33 m
 * face is its own kind of wrong: it reads as a ramp. Real mountain roads (and
 * real spoil heaps) break a tall face into BENCHES — a near-flat shelf every
 * few metres of rise, which is also where vegetation gets a hold. So every
 * BENCH_RISE metres of descent the march spends one step going almost
 * level.
 */
const BENCH_RISE = 3.4;    // vertical metres between shelves
const BENCH_W = 2.9;       // width of the shelf itself
const BENCH_SLOPE = 0.14;  // it is a shelf, not a terrace: 8 degrees of fall
const APRON_STEP = 2.3;    // march step on the face
const APRON_LOOK = 7.0;    // how far past the next step the batter looks for a floor
const APRON_STEPS = 15;    // hard limit on facets per side, cost control
const APRON_MAX = 34;      // hard limit on the footprint, metres from the verge

/**
 * THE CROSS-SECTION, as fractions of the half width. Everything about how the
 * road reads from above is decided by this table.
 *
 *  · Two wheel ruts at ±0.42 of the half width. On a 15 m road that puts their
 *    centres 3.15 m apart from the crown — a car track — and makes them 1.3 m
 *    wide, which is what the client references show: two dark bands you can
 *    follow round a corner. `rut` also sinks them, so the light catches them.
 *  · A faint centre scuff between the ruts, the strip a real dirt road keeps
 *    slightly greener/looser because nothing drives on it.
 *  · The outermost carriageway bands are `edge`: dustier and lighter, where
 *    grit gets thrown out of the ruts.
 */
const BANDS = [
  [-1.00, -0.66, 'edge'],
  [-0.66, -0.55, 'road'],
  [-0.55, -0.48, 'rutSoft'],
  [-0.48, -0.36, 'rut'],
  [-0.36, -0.29, 'rutSoft'],
  [-0.29, -0.20, 'road'],
  [-0.20, 0.20, 'centre'],
  [0.20, 0.29, 'road'],
  [0.29, 0.36, 'rutSoft'],
  [0.36, 0.48, 'rut'],
  [0.48, 0.55, 'rutSoft'],
  [0.55, 0.66, 'road'],
  [0.66, 1.00, 'edge'],
];

/**
 * The same table, subdivided so no slice is wider than 0.085 of the half width
 * (~0.47 m on an 11 m road).
 *
 * WHY: the reference's carriageway is not two dark ruts on a flat plane, it is
 * a dozen overlapping arcs of worn and thrown dirt, and that is most of the
 * tonal range in the picture. Measured on the shipped frame, 73% of our pixels
 * sat in three adjacent luminance buckets against the target's 60%, and the
 * road — a quarter of the image — was contributing one flat tone to that. A
 * per-slice tonal streak (see `streak` below) needs slices fine enough to carry
 * it; at 13 bands the finest streak was three metres wide and read as banding.
 */
/**
 * Widest a slice may be, as a fraction of the half width. 0.052 x 11 m = 0.57 m,
 * which the diagonal split inside `Strip.quad` halves again to ~0.29 m of
 * effective lateral resolution.
 *
 * WHY IT MOVED FROM 0.085. The reference's rut lines are 0.8-1.4 m of dip with
 * CRISP edges. A 0.6 m line drawn on a 0.94 m lattice cannot be crisp and
 * cannot be placed: measured, a braid line whose peak fell between two slice
 * centres delivered 44% of its depth to each of them and read as a 2 m smudge
 * at 13% contrast instead of a 1 m line at 30%. The lattice, not the amplitude,
 * was the whole reason the first two attempts at a braid did not read.
 */
const SLICE_W = 0.052;

const SLICES = (() => {
  const out = [];
  for (const [u0, u1, kind] of BANDS) {
    const k = Math.max(1, Math.ceil((u1 - u0) / SLICE_W));
    for (let i = 0; i < k; i++) {
      out.push([u0 + (u1 - u0) * (i / k), u0 + (u1 - u0) * ((i + 1) / k), kind]);
    }
  }
  return out;
})();

/**
 * LONGITUDINAL WEAR STREAKS. Coherent in arc length and in lateral station, so
 * they draw long thin light-and-dark arcs that follow the road round a corner —
 * traffic, not dither. `jitter` alone is per-quad hash noise: it adds variance
 * to a histogram without adding anything the eye reads as a surface.
 */
function streak(s, uf) {
  // Deliberately non-harmonic frequencies (11.3 : 29.7 : 4.1 shares no small
  // common factor) and a phase that drifts with arc length, so the arcs vary in
  // width and spacing down the road. Three near-harmonic terms produced evenly
  // ruled corduroy — regular enough to read as a texture bug rather than as
  // traffic.
  // The amplitudes used to be 0.150/0.090/0.070. Two thirds of that has moved
  // into `braid` and `grit` below, which put the same tonal energy at a spatial
  // frequency the eye reads as a SURFACE instead of as a slow wash. Measured on
  // a pure road patch: the reference's 2-98% luminance spread inside the
  // carriageway is 42-54 levels, ours was already 55 — the amplitude was never
  // the problem, the wavelength was.
  const wobble = 0.62 + 0.38 * Math.sin(s * 0.0033 + 0.9);
  return 1 + wobble * (
    0.058 * Math.sin(uf * 11.3 + s * 0.021 + 0.7 * Math.sin(s * 0.0027))
    + 0.034 * Math.sin(uf * 29.7 - s * 0.0088 + 1.7)
    + 0.040 * Math.sin(uf * 4.1 + s * 0.0039 + 3.1));
}

// ---------------------------------------------------------------------------
// SURFACE TEXTURE
//
// THE CLIENT: the road "looks like nothing in particular and is a long way from
// the references". target_01, read at six times magnification, carries four
// things our flat ochre band did not:
//
//   1. A BRAID of old wheel ruts — not two rails but eight or nine thin darker
//      lines that wander laterally, converge, cross and separate down the road.
//   2. GRAVEL SPECKLE — isolated dark stones and pale grit, a few pixels each,
//      sparse. Measured on the reference: ~5% of the surface is a fleck 25-40%
//      off the local tone, and the rest is nearly clean. That is an IMPULSE
//      distribution, not the gaussian dither `jitter` was producing.
//   3. WEAR PATCHES tens of metres long, lighter where traffic polishes the
//      surface and darker where it stays damp.
//   4. An edge that DISSOLVES: grass creeps in a metre here, grit washes out
//      two metres there, and nowhere is there a tonal line.
//
// There are no image assets in this project, so all of it is vertex colour. The
// blocker was cell size, not colour: at ds = 3 m stations a colour cell was
// 0.47 x 3 m, which projects to roughly 6 x 40 px — forty pixels long cannot
// hold a stone. So the carriageway is now subdivided SUBROWS times between
// consecutive stations, giving 0.47 x 0.75 m cells (about 6 x 6 px at this
// camera height, which is the size of the flecks in the reference).
//
// The subdivision costs triangles and nothing else: the two end rows of every
// segment are computed once, cached, and shared with their neighbours, and the
// sub-rows are linear interpolations of them. The geometry is identical to the
// single quad it replaces (a bilinear patch, subdivided) so no extra terrain
// query is made, and caching the rows actually HALVES the number of
// terrain.heightAt calls the old loop made, because it used to compute every
// station's row twice — once as the far end of one segment, once as the near
// end of the next.
// ---------------------------------------------------------------------------

/**
 * Longitudinal colour cells per station. 4 at ds = 3 m is one cell every
 * 0.75 m. Triangle cost is linear in this: see the count logged by
 * `createRoadNetwork` under window.__ROADS.
 */
const SUBROWS = 3;

/** Integer hash -> [0,1). Used for the sparse gravel, so it must not band. */
function hash3(a, b, c) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * THE RUT BRAID. Nine lines, each with its own lateral wander, width and depth
 * of wear. Two of them sit on the geometric ruts (see RUT_U) so the braid and
 * the sunken pair agree; the rest are old lines nobody follows any more.
 *
 * The wander frequencies are per-line irrational-ish multiples so the lines
 * cross rather than running parallel — a parallel set reads as corduroy, which
 * is what the first attempt looked like. Kernel is (1-t²)² rather than a
 * gaussian: same shape to the eye, no exp() in a loop that runs 1.4 M times.
 *
 * Returns a multiplier: 1 on clean surface, down to about 0.80 in the darkest
 * part of the deepest line, and slightly ABOVE 1 on the two dust ridges thrown
 * up between the wheel tracks, which the reference also shows.
 */
// MEASURED, not guessed. A scanline drawn straight across the reference's
// carriageway (tools: prof.mjs at y = 0.72, x 0.70-0.78 of target_01) reads
//
//     156 153 151 148 143 135 128 121 120 125 132 ... 162 ... 148 142 138 139
//     145 ... 151 149 144 141 135 131 130 134 ... 148 144 141 137 135 130 128
//     125 124 122 122 122 126 130 135 ...
//
// — five separate dips of 20 to 40 display levels off a base of about 145, each
// 8 to 15 px wide, which at 10.7 px/m there is 0.8-1.4 m. That is the braid, and
// it is what "the roads need some kind of texture" means.
//
// Our first pass produced dips of TEN levels. The gap is the sRGB curve: a 23%
// cut in a linear vertex colour comes out as about 10% of display level, so a
// 20-40 level dip off 145 needs a linear multiplier near 0.70, not 0.77.
// Depths are deliberately UNEQUAL. Setting all twelve to the same value (tried,
// at 0.50) produced twelve parallel lines of identical weight — corduroy, and
// the one thing the reference never looks like. In target_01 two lines carry the
// wear, three or four are half that, and the rest are ghosts of old lines; that
// spread is what makes the set read as a braid.
const BRAID = [
  // [nominal u, wander amp, wander freq, phase, half width, wear, sign]
  [-0.78, 0.095, 0.0181, 0.4, 0.042, 0.190, -1],
  [-0.60, 0.115, 0.0132, 2.1, 0.036, 0.280, -1],
  [-0.42, 0.065, 0.0094, 4.4, 0.052, 0.430, -1],   // geometric rut, left
  [-0.30, 0.100, 0.0207, 1.2, 0.030, 0.240, -1],
  [-0.16, 0.080, 0.0158, 5.6, 0.034, 0.140, -1],
  [-0.05, 0.060, 0.0113, 3.0, 0.044, 0.090, +1],   // dust ridge on the crown
  [0.07, 0.065, 0.0167, 4.8, 0.040, 0.080, +1],
  [0.17, 0.085, 0.0193, 0.9, 0.032, 0.180, -1],
  [0.30, 0.095, 0.0146, 2.7, 0.034, 0.265, -1],
  [0.42, 0.065, 0.0101, 5.1, 0.052, 0.430, -1],    // geometric rut, right
  [0.59, 0.120, 0.0175, 1.7, 0.038, 0.300, -1],
  [0.76, 0.100, 0.0121, 3.9, 0.044, 0.185, -1],
];

function braid(s, uf, shift) {
  let m = 1;
  for (let i = 0; i < BRAID.length; i++) {
    const L = BRAID[i];
    // Two wander terms per line: a long swing and a short one, so a line
    // meanders rather than oscillating on a single period.
    const c = L[0] + shift * (1 - Math.abs(L[0]))
      + L[1] * Math.sin(s * L[2] + L[3])
      + L[1] * 0.45 * Math.sin(s * L[2] * 2.71 + L[3] * 1.7);
    const t = (uf - c) / L[4];
    if (t <= -1 || t >= 1) continue;
    const k = 1 - t * t;
    m += L[6] * L[5] * k * k;
  }
  return m;
}

/**
 * GRAVEL. Sparse impulses, keyed on the colour cell so a stone is one cell and
 * does not smear along the road. Probabilities and depths measured off the
 * reference: about one cell in eighteen is a dark stone, one in forty is pale
 * grit, and everything else carries only a whisper of grain.
 *
 * `wash` raises the stone density toward the carriageway edge, where a real
 * dirt road throws its loose material.
 */
function grit(i, j, wash, cluster) {
  const h = hash3(i, j, 90173);
  // Gravel comes in DRIFTS. The first version sprinkled stones at a uniform
  // rate over the whole carriageway and the result read as a regular chequer —
  // every cell was a different tone, so the eye latched onto the cell grid
  // instead of onto the stones. Clustering the flecks means most of the surface
  // is genuinely clean and the grid has nothing to show.
  const cl = cluster * cluster;
  const dark = (0.020 + 0.075 * cl) * (1 + 1.1 * wash);
  const pale = (0.010 + 0.030 * cl) * (1 + 1.1 * wash);
  // Contrast was 0.60-0.86 / 1.13-1.28, fitted at the hero camera's distance
  // where a cell is about six pixels. The wildlife preset looks at the same road
  // from a third of that range, a cell is twenty pixels, and at those depths the
  // gravel stopped reading as gravel and started reading as a mosaic of
  // triangles. Pulled in far enough that the close view is calm; at hero range
  // the flecks still measure 20-30% off the local tone, which is what the
  // reference's stones do.
  if (h < dark) return 0.70 + 0.20 * (h / dark);          // a stone, or damp grit
  if (h > 1 - pale) return 1.10 + 0.12 * ((h - (1 - pale)) / pale);  // dry grit
  // Fine grain over the rest: enough to stop the clean cells reading as a
  // gradient, not enough to look like film noise or to make the cell grid
  // visible in its own right.
  return 1 + (h - 0.5) * 0.028;
}

/**
 * Broad polish-and-damp patches, tens of metres long and a few metres wide, plus
 * a much longer swing that takes whole STRETCHES of road up and down.
 *
 * WHY THE LONG SWING. tools/measure.mjs bins the frame into 12 levels per
 * channel and prints the dominant bins. With the braid and the gravel in, our
 * road still put 7.4% of the entire frame into the single bin #d18b46, while the
 * target's road does not appear in its top five at all — not because the
 * reference road is more varied over a metre (measured inside a patch it is
 * slightly LESS varied than ours) but because it is more varied over a hundred:
 * along its length it runs from rgb(210,159,73) in the open to rgb(177,137,69)
 * where it stays damp. One tone over a quarter of the picture is exactly what
 * "looks like nothing in particular" measures as.
 */
function wear(s, uf, seed) {
  return 1
    + 0.115 * (valueNoise2D(s * 0.0092, uf * 0.35, seed + 7) * 2 - 1)
    + 0.075 * (valueNoise2D(s * 0.038, uf * 1.6, seed + 11) * 2 - 1)
    + 0.045 * (valueNoise2D(s * 0.115, uf * 3.1, seed + 29) * 2 - 1);
}

/**
 * THE DARK THIRD.
 * ---------------
 * Measured, this is the largest single colour error left in the frame, and it is
 * not the level — it is the SHAPE OF THE DISTRIBUTION. Road pixels only, as a
 * percentage of the road's own area, by luminance bucket:
 *
 *   bucket        1    2    3    4    5    6    7
 *   ours          -    -    -   11   31   55    -
 *   reference     2    8   13   27   31   14    5
 *
 * Ours is a spike; the reference's road runs all the way down into bucket 1. A
 * third of the reference's carriageway is in shadow — tree shade, the shade of
 * its own cut bank, and long damp stretches that never dry out — and the whole
 * of our bucket-6 excess (10.8% of the frame against the reference's 5.0%, of
 * which our road supplies 9.9) is the absence of that third.
 *
 * `wear` and `braid` cannot supply it. They are SYMMETRIC noise around 1.0 with
 * amplitudes in the tenths: they widen the spike, they do not build a second
 * mode. What is needed is a sparse, strongly asymmetric term — most of the road
 * untouched, and a real minority of it taken down most of a stop. So:
 *
 *   · two octaves of noise, ~48 m and ~17 m of arc length, wide in the lateral
 *     direction so a patch crosses the whole carriageway rather than striping it;
 *   · a THRESHOLD, so it does nothing at all over the majority of the surface;
 *   · smoothstepped, so a patch has a soft margin like a shadow and not a
 *     stencilled edge.
 *
 * The multiplier is applied in LINEAR space and the display is roughly a 1/2.2
 * power of it, so 0.42 of light is 0.67 of display level: a bucket-6 tone at
 * 0.65 lands at 0.44 — bucket 4 — and the deepest patches reach bucket 3. That
 * is the shape above, built out of the one thing a vertex colour can honestly
 * claim to be: how much light this piece of ground gets.
 */
function shade(s, uf) {
  // THE PATCHES HAVE TO CROSS THE ROAD, NOT RUN ALONG IT. At uf * 0.42 the lateral
  // argument spans 0.84 of a noise unit across the whole carriageway while the
  // longitudinal one spans 2.1 per hundred metres, so every patch came out as a
  // stripe five times longer than it was wide — and the surface read as corduroy,
  // which is the one thing the reference never looks like. A tree shadow, a damp
  // hollow and a swept-clean crossing all lie ACROSS a road. 26 m and 10 m of arc
  // length against 1.4 and 3.1 lateral units puts the long axis the other way.
  const n = 0.62 * valueNoise2D(s * 0.038, uf * 0.70, 3313)
    + 0.38 * valueNoise2D(s * 0.098, uf * 1.55, 6607);
  // Nothing happens between SHADE_ON and SHADE_DRY; below the one the patch
  // deepens smoothly, above the other the ground is bone dry and lifts.
  const t = clamp((SHADE_ON - n) / SHADE_SOFT, 0, 1);
  // The dry term rides its OWN noise. A first version thresholded the same `n`
  // and delivered nothing: two octaves summed 0.62/0.38 give a distribution
  // piled up around the middle, so P(n > 0.84) measured 0.0% of the surface and
  // the bright tail never appeared in the frame at all. One octave is close
  // enough to uniform that a threshold means what it says — 22% of the road
  // above 0.78, of which about a fifth reaches full lift.
  const d = valueNoise2D(s * 0.017, uf * 0.55, 5171);
  const b = clamp((d - SHADE_DRY) / (1 - SHADE_DRY), 0, 1);
  return (1 - SHADE_DEEP * t * t * (3 - 2 * t)) * (1 + SHADE_LIFT * b);
}
const SHADE_ON = 0.545;    // noise level at which a patch starts
const SHADE_SOFT = 0.30;   // ...and how far below that it reaches full depth
const SHADE_DEEP = 0.58;   // deepest patch keeps 42% of the light
/**
 * AND THE OTHER TAIL. The reference road puts 4.6% of its own area above L 0.7
 * and a little above 0.8; ours had 0.0% there, which is the same bug as the
 * missing dark third seen from the other end — a spike has no tails. These are
 * the stretches of bone-dry dust the wind has cleaned off, and they are what
 * stops the darkened road reading as uniformly damp.
 */
const SHADE_DRY = 0.78;    // noise level above which the surface is dry dust
const SHADE_LIFT = 0.34;   // ...and how far it lifts at its driest

/** Nominal lateral station of the two ruts, as a fraction of the half width. */
const RUT_U = 0.42;

/**
 * WHERE THE WHEELS ACTUALLY WENT.
 *
 * Two rails at a constant gauge down the middle of the carriageway is what a
 * paint machine does, not what traffic does. Through a bend every driver turns
 * in toward the apex, so the worn pair DRIFTS to the inside of the corner; and
 * because they all pick slightly different lines, the pair also SPREADS. Both
 * effects are proportional to curvature, which is what makes the ruts read as
 * following the road rather than being ruled along it — they visibly converge
 * and swing across the carriageway through every corner.
 *
 * Driven by the smoothed curvature `ks` carried on each sample, so the drift is
 * a long lazy swing tens of metres long, not per-station dither.
 */
function rutLine(ks) {
  const t = clamp(Math.abs(ks ?? 0) * 150, 0, 1);
  return { shift: -Math.sign(ks ?? 0) * 0.22 * t, spread: 1 + 0.14 * t };
}

/**
 * Warp a lateral station by the racing line. The window is 1 at the crown and
 * 0 at the carriageway edge, so the ochre silhouette itself never moves — only
 * the worn band inside it — and the cross-section stays monotonic, which it
 * must be or the strip folds through itself and shows black slivers.
 */
function warpU(uf, shift, spread) {
  const w = (1 + Math.cos(Math.PI * clamp(Math.abs(uf), 0, 1))) * 0.5;
  return uf + (shift + uf * (spread - 1)) * w;
}

/** Depth worn into the carriageway, measured from the two rut centres. */
function rutDepth(uf, cL, cR) {
  const d = Math.min(Math.abs(uf - cL), Math.abs(uf - cR));
  const t = clamp(1 - d / 0.17, 0, 1);
  return RUT_DEPTH * t * t * (3 - 2 * t);
}

/**
 * Inside a tight corner the whole cross-section converges on the centre of
 * curvature. Past 0.72/|k| the ribbon folds through itself and shatters, so
 * every lateral station is capped on the inside of the bend.
 */
function capU(sm, u) {
  const k = sm.k;
  if (!k) return u;
  if (u * k <= 0) return u;
  const lim = 0.45 / Math.abs(k);
  return Math.sign(u) * Math.min(Math.abs(u), lim);
}

/**
 * Height of the carriageway at lateral offset `u`.
 *
 * `sm.tilt` is the fraction of the TERRAIN's own cross-slope the section
 * carries. A fully levelled corridor is what made the ribbon read as a slab
 * dropped on the hillside: on any cross-slope its uphill edge buried itself and
 * its downhill edge hung in the air by hw × slope, which at a 15 m width is
 * most of a metre. Carrying most of the ground's tilt keeps the road ON the
 * hill; the remainder is what still reads as a cut-and-fill bench.
 */
function sectionY(sm, u) {
  const t = clamp(u / sm.hw, -2, 2);
  return sm.y + LIFT + (sm.tilt ?? 0) * u - sm.bank * u
    - CROWN * Math.min(1, t * t)
    - rutDepth(t, sm.rutL ?? -RUT_U, sm.rutR ?? RUT_U);
}

/**
 * THE GROUND THE RIBBON IS BUILT AGAINST — the surface that is DRAWN, never the
 * analytic field.
 *
 * Everything below this line puts a vertex, a post foot or a query answer at a
 * height that has to agree with a triangle on screen, and `terrain.heightAt` is
 * not that triangle: it is the smooth field the terrain mesh SAMPLES. Measured
 * on the shipped build, over 4000 random points the mesh sat 0.115 m from the
 * field on average and 3.29 m from it at worst. Every one of those metres was a
 * green tongue across the ochre, a post in mid-air, or a wheel underground.
 *
 * Route PLANNING still uses the analytic field, and must: the cost grid, the
 * corner injection and the wet test are choosing where landforms are, not
 * touching them.
 */
function groundY(terrain, x, z) {
  return terrain.drawnHeightAt(x, z);
}

/**
 * DRAPE. The carriageway is a designed surface — crown, camber, ruts, the bench
 * tilt — but the ground underneath it is a jittered mesh with ~10 m triangles,
 * and a designed plane WILL be speared by it: a high vertex two metres off the
 * centre line pokes a green tongue straight across the road and the ribbon reads
 * as chopped into pieces. So no vertex is allowed below the ground beneath it.
 *
 * Sampled at the vertex AND around it. A terrain triangle is ~10 m across while
 * the carriageway quads are 3 m by 2 m, so a high ground vertex can sit BETWEEN
 * two road stations, above the quad that spans them, and shows as a green tongue
 * lying across the ochre. Taking the worst ground within a couple of metres
 * closes the gap the interpolation leaves.
 *
 * THE OLD COMMENT HERE CLAIMED THE LIFT WAS FREE. It said the extra height "is
 * inside the ±0.45 m the car's raw-terrain ground contact can absorb", and that
 * was the bug: the physics asked `heightAt`, which returned `sectionY` — the
 * DESIGN plane, with no drape in it at all — so the lift was not absorbed, it
 * was simply invisible to the car. Measured across the carriageway, u = -6..+6,
 * the wheel sat 0.13-0.27 m under the drawn gravel with a p95 of 0.88 m. The
 * lift is real and it is sometimes a metre; the query below now goes through
 * these same vertices, so it cannot be surprised by it again.
 *
 * MODULE LEVEL ON PURPOSE. This used to be a closure inside buildRibbonMesh, so
 * `auditSlopes` had to approximate the carriageway with max(sectionY, ground) —
 * and where the ground rose sharply just outside the carriageway the drape's
 * 1.7 m neighbour sample lifted the real edge vertex two metres above the
 * approximation. The audit duly reported a 60 degree "wall" between an edge that
 * was not there and a shoulder that was. One function, three callers.
 */
function drapeY(terrain, sm, u) {
  const cu = capU(sm, u);
  const px = sm.x + sm.nx * cu, pz = sm.z + sm.nz * cu;
  let g = groundY(terrain, px, pz);
  for (const [ax, az] of [[sm.nx, sm.nz], [-sm.nx, -sm.nz], [sm.tx, sm.tz], [-sm.tx, -sm.tz]]) {
    const h = groundY(terrain, px + ax * 1.7, pz + az * 1.7);
    if (h > g) g = h;
  }
  return Math.max(sectionY(sm, cu), g + LIFT);
}

/**
 * THE EMBANKMENT PROFILE for one side of one station.
 *
 * Walks outward from the verge edge, descending (or climbing) by at most the
 * angle of repose per step, and stops the instant the ground is within one
 * step's allowance — which is exactly where a real batter daylights. The
 * footprint therefore SCALES WITH THE HEIGHT DIFFERENCE instead of being capped
 * at a few metres, and the face angle is a constant of the material.
 *
 * Returns `{ pts, landed, benches }`, where `pts` is a list of
 * `[u, y, grass, bench]` in increasing absolute lateral offset from the road
 * centre line, starting at the verge point and ending — when `landed` — exactly
 * on the terrain.
 *
 *   cap      how far out the earthworks may reach (inside a bend, not far)
 *   wobble   0.75..1.25, so the facet spacing and the landing point wander
 *
 * `landed: false` means even APRON_MAX metres of talus could not reach the
 * ground: the last point is dropped onto it anyway (a hole is worse than a
 * step) and `auditSlopes` reports the residual.
 */
function apronProfile(terrain, sm, side, base, yEdge, cap, wobble) {
  // The toe of a batter has to LAND on the ground, and "the ground" is the
  // triangle, not the field it was sampled from. Landing on the analytic value
  // left the last facet floating or buried by the chord sag of whatever terrain
  // cell it daylighted into — a visible step at the exact place this march
  // exists to remove one.
  const gAt = (uu) => groundY(terrain, sm.x + sm.nx * side * uu, sm.z + sm.nz * side * uu);
  // A/B HARNESS. Set globalThis.__ROAD_LEGACY_BATTER before the world builds
  // and the ribbon is built with the model the client rejected: march at 1.2 m
  // for at most 5 m, then THREE facets that interpolate to the ground whether it
  // is one metre down or thirty. `tools/slopes.mjs --ab` boots the page twice,
  // once each way, so the before/after in the report is measured rather than
  // remembered.
  if (globalThis.__ROAD_LEGACY_BATTER) {
    const L_BANK = 5, L_CUT = 1.05, L_FILL = 0.75;
    let w = L_BANK;
    for (let d = 1.2; d <= L_BANK; d += 1.2) {
      const dy = gAt(base + d) - yEdge;
      if (Math.abs(dy) <= (dy > 0 ? L_CUT : L_FILL) * d) { w = d; break; }
    }
    w = Math.max(Math.min(cap, SKIRT_MIN), Math.min(cap, w)) * wobble;
    const pts = [[base, yEdge, 0, 0]];
    for (const f of [0.42, 0.74, 1.0]) {
      const u = base + w * f, t = gAt(u);
      const y = f === 1 ? t + 0.02 : Math.max(lerp(yEdge, t, f * 0.95), t + 0.03);
      pts.push([u, y, f === 1 ? 1 : (f > 0.5 ? 0.55 : 0), 0]);
    }
    return { pts, landed: true, benches: 0 };
  }
  const pts = [[base, yEdge, 0, 0]];
  const limit = base + Math.min(cap, APRON_MAX);
  let u = base, y = yEdge, rise = 0, benches = 0, landed = false;
  for (let s = 0; s < APRON_STEPS; s++) {
    const bench = rise >= BENCH_RISE;
    const step = (bench ? BENCH_W : APRON_STEP) * wobble;
    const un = Math.min(u + step, limit);
    const h = un - u;
    if (h < 0.25) break;
    const g = gAt(un);
    // DO NOT LAND ON A LEDGE YOU CAN SEE OVER. The ground one step out being
    // level with the batter does not mean the batter is finished: a road along
    // the lip of a carved basin sits on a shelf two metres wide with the floor
    // twenty metres below, and landing on that shelf is how the "flat floor,
    // vertical sides" box canyon in the client's photograph gets built.
    //
    // So look APRON_LOOK metres further and take the LOWER of the two as the
    // target — but only if the remaining footprint budget can actually reach it
    // at the angle of repose. If it cannot, land here and leave the cliff to
    // whoever owns the landform: chasing a drop we cannot finish would trade a
    // gentle toe for a NEW wall at the end of a long ramp, which is worse than
    // the shelf.
    let target = g;
    const room = limit - un;
    const far = gAt(Math.min(un + APRON_LOOK, limit));
    if (far < g - 1.2 && (y - far) < room * FILL_SLOPE * 0.85) target = far;
    const dy = target - y;
    // A bench is nearly level, so it only "reaches" ground very close by; the
    // face proper reaches a third of a metre down for every half metre out.
    const slope = bench ? BENCH_SLOPE : (dy > 0 ? CUT_SLOPE : FILL_SLOPE);
    const allowed = slope * h;
    if (Math.abs(dy) <= allowed) {
      pts.push([un, g, 1, bench ? 1 : 0]);
      landed = true;
      break;
    }
    // Never dig below the ground here: a batter that descends toward a floor it
    // saw further out must still lie ON the shelf it is crossing.
    const yPrev = y;
    y = Math.max(y + Math.sign(dy) * allowed, g - 0.02);
    u = un;
    // The rise that earns the next bench is the height ACTUALLY descended, not
    // the height allowed: a step that crossed a shelf without dropping has not
    // earned anything, and counting it would cut shelves into flat ground.
    if (bench) { rise = 0; benches++; } else rise += Math.abs(y - yPrev);
    // Greening ramps with distance from the carriageway, and a shelf greens
    // faster than a face because soil and seed actually stay on it.
    const f = (s + 1) / APRON_STEPS;
    pts.push([u, y, Math.min(0.92, f * f * 1.5 + (bench ? 0.30 : 0)), bench ? 1 : 0]);
    if (un >= limit - 1e-6) break;
  }
  if (!landed) {
    const g = gAt(u);
    const last = pts[pts.length - 1];
    // Land it. This is the one place a step can survive the model, so make it
    // as cheap as possible: put the landing a step further out, which buys one
    // more step's worth of allowance for free.
    if (Math.abs(g - last[1]) > 0.05) pts.push([u + 0.9, g, 1, 0]);
    else { last[1] = g; last[2] = 1; }
  }
  return { pts, landed, benches };
}

/**
 * THE WHOLE DRAWN CROSS-SECTION OF ONE STATION, AS ONE MONOTONE TABLE.
 *
 * Assembled from the three things the mesh is actually built out of, in the
 * order the mesh draws them: the left batter walked back in from its toe, the
 * carriageway row (post-LIP-clamp, so it is the row that got emitted), and the
 * right batter walked out to its toe. Every entry is stored at `capU`'s lateral
 * position, because `st()` puts the VERTEX there — inside a bend the nominal
 * offsets and the drawn ones are different numbers and the query has to use the
 * drawn one.
 *
 * WHY A TABLE AND NOT A FUNCTION. The old `heightAt` re-derived the surface from
 * `sectionY`, which knows nothing about the drape, the lip clamp, the shoulder
 * grading or the batter; measured across the carriageway that was 0.13-0.27 m of
 * sink, and at u = ±8..9 — the shoulder, one metre outside where the old query
 * gave up and returned null — it was 0.41-0.55 m mean, 8.9 m worst, with 76-84%
 * of samples reporting a different SURFACE from the one on screen. Interpolating
 * the emitted vertices cannot drift from them, so that class of bug is gone
 * rather than reduced.
 */
function buildProfile(sm, row, sides) {
  const L = sides[-1].pts, R = sides[1].pts;
  const NB = row.u.length;
  const n = L.length + NB + R.length;
  const U = new Float64Array(n), Y = new Float64Array(n);
  let p = 0;
  for (let q = L.length - 1; q >= 0; q--) { U[p] = capU(sm, -L[q][0]); Y[p] = L[q][1]; p++; }
  for (let j = 0; j < NB; j++) { U[p] = row.u[j]; Y[p] = row.y[j]; p++; }
  for (let q = 0; q < R.length; q++) { U[p] = capU(sm, R[q][0]); Y[p] = R[q][1]; p++; }
  // capU can flatten several outer stations onto the same lateral position on
  // the inside of a hairpin, so the table is non-DECREASING, not increasing.
  // The search below treats a zero-width span as a step and takes the outer
  // value, which is the sliver the mesh actually shows there.
  for (let q = 1; q < n; q++) if (U[q] < U[q - 1]) U[q] = U[q - 1];
  return { u: U, y: Y };
}

/** Scratch for the two stations `heightAt` blends between. */
const _secA = { y: 0, reach: 0 };
const _secB = { y: 0, reach: 0 };

/**
 * Height of the drawn cross-section at signed lateral offset `u`, plus how far
 * out this side draws anything at all. Returns false — with `y` clamped to the
 * nearest end of the profile — when `u` is past the toe.
 */
function drawnSection(sm, u, out) {
  const P = sm._prof;
  if (!P) { out.y = 0; out.reach = 0; return false; }
  const U = P.u, Y = P.y, n = U.length;
  out.reach = u < 0 ? -U[0] : U[n - 1];
  if (u <= U[0]) { out.y = Y[0]; return u === U[0]; }
  if (u >= U[n - 1]) { out.y = Y[n - 1]; return u === U[n - 1]; }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (U[m] <= u) lo = m; else hi = m;
  }
  const d = U[hi] - U[lo];
  out.y = d > 1e-9 ? Y[lo] + (Y[hi] - Y[lo]) * ((u - U[lo]) / d) : Y[hi];
  return true;
}

class Strip {
  constructor() { this.pos = []; this.col = []; }
  /** a,b on section i; c,d on section i+1; a and c share a lateral station. */
  quad(a, b, c, d, col, col2) {
    // orient so the face normal points up (walls are drawn double sided)
    const ux = d[0] - a[0], uy = d[1] - a[1], uz = d[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const ny = uz * vx - ux * vz;
    // TWO COLOURS PER QUAD, FREE. Whichever way the quad is flipped, its first
    // triangle is the one whose centroid sits at (1/3 across, 2/3 along) and its
    // second at (2/3 across, 1/3 along) — diagonal opposites. Colouring them
    // separately doubles the resolution of the surface texture in both
    // directions without adding a single triangle, and the cells come out
    // triangular, which is the shape everything else in this world is made of.
    const c2 = col2 || col;
    if (ny >= 0) { this.tri(a, d, c, col); this.tri(a, b, d, c2); }
    else { this.tri(a, c, d, col); this.tri(a, d, b, c2); }
  }
  tri(p, q, r, col) {
    this.pos.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
    for (let i = 0; i < 3; i++) this.col.push(col.r, col.g, col.b);
  }
  get count() { return this.pos.length / 3; }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const _jc = new THREE.Color();
const _sc = new THREE.Color();
const _sc2 = new THREE.Color();
function jitter(base, i, amt) {
  const t = ((Math.imul(i, 2654435761) >>> 0) / 4294967296 - 0.5) * amt;
  return _jc.copy(base).multiplyScalar(1 + t);
}

function buildRibbonMesh(ctx, route, colours, name) {
  const { terrain } = ctx;
  const b = new Strip();
  const S = route.samples;
  const n = S.length;
  const closed = route.closed;
  const last = closed ? n : n - 1;

  /**
   * Ragged-edge noise. A dirt road has no surveyed boundary — grass creeps in
   * two metres here, a wash of grit spills out three metres there.
   *
   * The frequency matters more than the amplitude. Per-station hash noise (the
   * stations are 3 m apart) just dithers the edge and, from 200 m up, averages
   * straight back out into the ruled line we are trying to get rid of. What
   * reads at this camera height is a SLOW wander, tens of metres long, so the
   * noise is driven by arc length and the two sides are decorrelated.
   */
  const ragged = (sm, side) => {
    const q = side > 0 ? 0 : 311.7;
    return fbm(sm.s * 0.021 + q, side * 5.3, { octaves: 2, seed: 5471 });
  };

  /** A vertex on the section, with the inside-of-corner cap applied. */
  const st = (sm, u, y) => {
    const cu = capU(sm, u);
    return [sm.x + sm.nx * cu, y === undefined ? sectionY(sm, cu) : y, sm.z + sm.nz * cu];
  };

  /** Shorthand for this ribbon's terrain — see `drapeY` at module level. */
  const drape = (sm, u) => drapeY(terrain, sm, u);

  // --- carriageway --------------------------------------------------------
  //
  // Every station's row of carriageway vertices, computed ONCE. The old loop
  // computed each row twice (as the far end of one segment and the near end of
  // the next), so caching pays for the extra colour cells before they cost
  // anything: the number of terrain.heightAt calls goes DOWN by half.
  //
  // Every lateral station goes through the same warp: the racing-line drift and
  // spread from `rutLine`, plus a slow arc-length sway. The window inside
  // `warpU` pins the outermost station, so the ochre silhouette is untouched
  // while the worn band swings across it through the corner.
  const NB = SLICES.length + 1;              // slice boundaries per section
  const BU = new Float64Array(NB);
  BU[0] = SLICES[0][0];
  for (let j = 0; j < SLICES.length; j++) BU[j + 1] = SLICES[j][1];
  const rowX = new Float64Array(n * NB);
  const rowY = new Float64Array(n * NB);
  const rowZ = new Float64Array(n * NB);
  // Kept for every station, not just the current one: `auditSlopes` profiles the
  // carriageway from these rows. It used to re-derive it from `drapeY`, which
  // silently bypassed the lip clamp below and went on reporting a 64 degree
  // kick-up that the shipped mesh no longer had.
  const rowU = new Float64Array(n * NB);
  const edgeU = new Float64Array(n * 2);     // outermost offset, [left, right]
  const edgeY = new Float64Array(n * 2);     // ...and its height after clamping
  for (let i = 0; i < n; i++) {
    const sm = S[i];
    // The ruts wander: a slow lateral drift with arc length, so they are never
    // two rails at a constant gauge. Half a metre of sway over ~60 m reads, at
    // this camera height, as tracks worn by cars that took different lines.
    const sway = Math.sin(sm.s * 0.031) * 0.05 + Math.sin(sm.s * 0.011 + 2.1) * 0.035;
    // The outermost station of the carriageway wanders with arc length, so the
    // ochre silhouette itself is irregular rather than a ruled line with a
    // ragged fringe pinned to it.
    const hem = [1 + ragged(sm, -1) * 0.13, 1 + ragged(sm, 1) * 0.13];
    for (let j = 0; j < NB; j++) {
      const uf = BU[j];
      const a = Math.abs(uf);
      let f = warpU(uf, sm.rutShift ?? 0, sm.rutSpread ?? 1);
      if (a > 0.19 && a < 0.7) f += sway * Math.sign(uf);
      if (a >= 0.999) f *= hem[uf > 0 ? 1 : 0];
      const cu = capU(sm, f * sm.hw);
      rowU[i * NB + j] = cu;
      rowX[i * NB + j] = sm.x + sm.nx * cu;
      rowY[i * NB + j] = drape(sm, f * sm.hw);
      rowZ[i * NB + j] = sm.z + sm.nz * cu;
    }
    // THE LIP. `drape` protects the carriageway from being speared by the ground
    // by refusing to let any vertex sit below it — and on a steep cutting that
    // hoists the OUTERMOST vertex up to the hillside. Audited: the outer edge of
    // one spur station stood 1.76 m above the vertex 0.84 m inboard of it, a
    // 64 degree kick-up on the road SURFACE. That is a wall too, and it is the
    // one the driver actually looks at.
    //
    // So the row is walked outward from the crown and each vertex is capped at
    // LIP_MAX of gradient above its inboard neighbour. Where the ground rises
    // faster than that the ribbon stays under it and the terrain wins the last
    // half metre of edge — which is a ragged green tongue biting into the ochre,
    // i.e. exactly what an unsurfaced road's boundary does anyway. Only upward
    // excursions are clamped; the crown, camber and ruts are design and are left
    // alone.
    const mid = Math.round((NB - 1) / 2);
    // `--ab` wants the mesh the client actually saw, which had no clamp either.
    // `--ab` wants the mesh the client actually saw, which had no clamp either.
    if (!globalThis.__ROAD_LEGACY_BATTER) {
      for (let j = mid + 1; j < NB; j++) {
        const du = Math.abs(rowU[i * NB + j] - rowU[i * NB + j - 1]);
        const capY = rowY[i * NB + j - 1] + LIP_MAX * du;
        if (rowY[i * NB + j] > capY) rowY[i * NB + j] = capY;
      }
      for (let j = mid - 1; j >= 0; j--) {
        const du = Math.abs(rowU[i * NB + j] - rowU[i * NB + j + 1]);
        const capY = rowY[i * NB + j + 1] + LIP_MAX * du;
        if (rowY[i * NB + j] > capY) rowY[i * NB + j] = capY;
      }
    }
    // The shoulder quad starts exactly here, so the earthworks pre-pass below
    // must read the CLAMPED edge, not re-derive it from `drape`: half a metre of
    // disagreement between the two is a crack you can see the sky through.
    edgeU[i * 2] = rowU[i * NB]; edgeU[i * 2 + 1] = rowU[i * NB + NB - 1];
    edgeY[i * 2] = rowY[i * NB]; edgeY[i * 2 + 1] = rowY[i * NB + NB - 1];
  }
  // --- earthworks pre-pass -------------------------------------------------
  //
  // Every station's embankment, both sides, computed once and CACHED ON THE
  // SAMPLE, because two things need to agree about it exactly: the mesh built
  // below, and `auditSlopes`, which walks the finished profile looking for the
  // vertical walls the client rejected. An audit that re-derives the shape is
  // an audit of a different road.
  const APRON = [];
  for (let i = 0; i < n; i++) {
    const sm = S[i];
    const hem = [1 + ragged(sm, -1) * 0.13, 1 + ragged(sm, 1) * 0.13];
    const sides = {};
    for (const side of [1, -1]) {
      const hm = side > 0 ? hem[1] : hem[0];
      const rg = 1 + ragged(sm, side) * 0.5;
      const e = edgeU[i * 2 + (side > 0 ? 1 : 0)];
      const vAbs = sm.hw * hm + sm.verge * rg;
      const v = side * vAbs;
      const yE = edgeY[i * 2 + (side > 0 ? 1 : 0)];
      const gv = groundY(terrain, sm.x + sm.nx * capU(sm, v), sm.z + sm.nz * capU(sm, v));
      // shoulder height: half way from the carriageway edge down to the ground,
      // and never below the ground it is standing on
      // A QUARTER OF THE WAY DOWN, NOT HALF. The shoulder used to fall half way
      // from the carriageway edge to the ground, which tilted it far enough that
      // the sun stopped reaching it: scanned across the hero frame it rendered
      // rgb(113,129,93) at saturation 0.28 between a carriageway at 0.78 and a
      // meadow at 0.83 — a grey-olive kerb a metre wide following the road down
      // both sides, which is the "concrete kerb on a dirt rally stage" this file
      // has already been through three times. A facet lit by the sky is a cold
      // facet whatever colour it is painted, so the fix is geometric: keep the
      // shoulder nearly coplanar with the road, and let the batter outside it —
      // which now marches at the angle of repose and can afford the height — do
      // the descending.
      let yV = Math.max(lerp(drape(sm, v), gv + LIFT, 0.25), gv + 0.03);
      // ...BUT THE SHOULDER IS A GRADED VERGE, NOT A RETAINING WALL. On a cut
      // the natural ground at the verge is metres above the carriageway, and
      // "never below the ground" used to hoist the shoulder point straight up
      // to meet it: measured, that put a 1.7 m rise into 1.0 m of verge — a
      // 60 degree step, and the steepest thing the road built anywhere in the
      // world. So the shoulder is capped at 1:2 either way and the CLIMB is
      // handed to the batter outside it, which already knows the angle of
      // repose. On the cut side that leaves the ribbon fractionally below the
      // raw ground for a metre or so; the terrain triangle wins there, which is
      // correct — a cutting is a hole in the hill, and roads.js does not own the
      // hill.
      const vw = Math.max(0.35, vAbs - Math.abs(e));
      if (!globalThis.__ROAD_LEGACY_BATTER) {
        yV = Math.min(yV, yE + 0.30 * vw);
        yV = Math.max(yV, yE - 0.30 * vw);
      }
      // A bridge deck has no earthworks — the ground is thirty metres of air.
      // Inside a bend the batter must shrink or neighbouring sections overlap;
      // only the INSIDE of the bend is capped, so the outside of a hairpin still
      // gets its full talus.
      const inner = Math.max(0, 0.45 / Math.max(Math.abs(sm.k), 1e-5) - vAbs);
      const cap = sm.wet ? 1.2 : Math.max(SKIRT_MIN, (side > 0) === (sm.k > 0) ? inner : APRON_MAX);
      const wob = clamp(1 + ragged(sm, side) * 0.30, 0.72, 1.3);
      const ap = apronProfile(terrain, sm, side, vAbs, yV, cap, wob);
      // Same sample as `gv` above, and it has to be the same NUMBER too: a face
      // painted as a cutting while its geometry was built against a different
      // ground is how the two disagree in the first place.
      sides[side] = { e, yE, v, yV, cut: yE + 0.5 < gv, ...ap };
    }
    APRON.push(sides);
    sm._apron = sides;   // diagnostics: auditSlopes reads this
    // ...and so is the finished carriageway row, clamp and all.
    sm._row = { u: rowU.subarray(i * NB, i * NB + NB), y: rowY.subarray(i * NB, i * NB + NB) };
    // The two caches above, spliced into the single monotone table `heightAt`
    // reads. Built here and only here, so the query cannot be looking at a road
    // the builder did not emit.
    sm._prof = buildProfile(sm, sm._row, sides);
  }

  // Scratch, so the inner loop allocates nothing.
  const _p = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const ds = route.ds || 3;

  for (let i = 0; i < last; i++) {
    const A = S[i], B = S[(i + 1) % n];
    const tone = {
      road: colours[A.surf],
      rut: colours[`${A.surf}:rut`],
      rutSoft: colours[`${A.surf}:rutSoft`],
      centre: colours[`${A.surf}:centre`],
      edge: colours[`${A.surf}:edge`],
    };
    const ia = i * NB, ib = ((i + 1) % n) * NB;
    // The braid drifts with the corner exactly as the geometric ruts do, so the
    // painted wear and the sunken pair never disagree about where the traffic
    // went.
    const shiftA = A.rutShift ?? 0, shiftB = B.rutShift ?? 0;

    for (let k = 0; k < SUBROWS; k++) {
      const t0 = k / SUBROWS, t1 = (k + 1) / SUBROWS;
      const tc = (k + 0.5) / SUBROWS;
      // Arc length of the cell centre, taken forward from A rather than as the
      // mean of A and B: on a closed loop B.s wraps to zero at the last segment
      // and the mean would put one cell's texture 1.8 km out of place.
      const sc = A.s + ds * tc;
      const shift = shiftA + (shiftB - shiftA) * tc;
      for (let j = 0; j < SLICES.length; j++) {
        const kind = SLICES[j][2];
        const u0 = BU[j], u1 = BU[j + 1];
        // p0/p1 at the near sub-row, p2/p3 at the far one.
        for (let e = 0; e < 4; e++) {
          const jj = ia + j + (e & 1);
          const kk = ib + j + (e & 1);
          const t = e < 2 ? t0 : t1;
          _p[e][0] = rowX[jj] + (rowX[kk] - rowX[jj]) * t;
          _p[e][1] = rowY[jj] + (rowY[kk] - rowY[jj]) * t;
          _p[e][2] = rowZ[jj] + (rowZ[kk] - rowZ[jj]) * t;
        }
        // The two triangles of this quad, at their own centroids: one third
        // across and two thirds along, and the other way round.
        for (let h = 0; h < 2; h++) {
          const fu = h ? 2 / 3 : 1 / 3;
          const uc = u0 + (u1 - u0) * fu;
          const ss = sc + ds * (h ? -1 : 1) / (SUBROWS * 6);
          // Four scales of surface, coarse to fine: the long wear arcs, the
          // metre-scale polish-and-damp patches, the rut braid, and the gravel.
          const wash = clamp((Math.abs(uc) - 0.55) / 0.45, 0, 1);
          const cluster = valueNoise2D(ss * 0.075, uc * 2.4, 7717);
          const m = streak(ss, uc) * wear(ss, uc, 4801) * braid(ss, uc, shift)
            * shade(ss, uc) * grit(i * SUBROWS * 2 + k * 2 + h, j, wash, cluster);
          (h ? _sc2 : _sc).copy(tone[kind]).multiplyScalar(m);
        }
        b.quad(_p[0], _p[1], _p[2], _p[3], _sc, _sc2);
      }
    }

    for (const side of [1, -1]) {
      // --- shoulder: carriageway edge -> soft skirt -> untouched ground ------
      //
      // No gutter, no kerb lip, no vertical face. The section walks outward in
      // as many steps as the height difference needs, each one lower and greener
      // than the last, and the LAST one lands exactly on the terrain it is
      // standing on. That is what stops the ribbon reading as a slab: there is
      // nowhere left for a step to hide.
      const apA = APRON[i][side], apB = APRON[(i + 1) % n][side];
      const eA = apA.e, eB = apB.e;
      const vA = apA.v, vB = apB.v;
      const yEA = apA.yE, yEB = apB.yE;
      const yVA = apA.yV, yVB = apB.yV;

      // THE EDGE HAS TO DISSOLVE. `ragged` already makes the shoulder's WIDTH
      // wander, but a uniformly-toned band of wandering width is still a band,
      // and at this camera height ours read as a two-metre gravel hard shoulder
      // following the carriageway — the same "kerb" the client rejected once
      // already, in a different colour. So the shoulder carries the road's own
      // grit and wear (it is the same dust, thrown wider) and is pulled toward
      // the meadow by a slow noise, so in one place the turf has taken it back
      // completely and forty metres later it is bare dust again.
      //
      // AND IT HAS TO BE A WHISPER. The first version let the creep reach 0.90
      // of the way to `blend` (which is the meadow), and measured on an RGB
      // scanline across the lake_bridge road the shoulder came out as the WIDEST
      // band in the apron, half of it dust and half of it turf — and warm dust
      // averaged with green over thirty pixels is grey. That is the third time
      // this band has rendered grey for the same underlying reason. The greening
      // belongs to the skirt facets outside it, which already ramp to grass; the
      // shoulder is dust, and only gets a hint of turf in the greenest places.
      const creepA = valueNoise2D(A.s * 0.042, side * 7.3, 913);
      const shGrit = grit(i * 2 + (side > 0 ? 0 : 1), 400, 1,
        valueNoise2D(A.s * 0.075, side * 2.4, 7717));
      // The shade patches do not stop at the carriageway edge — a tree shadow or a
      // damp hollow crosses the shoulder too — so the same term runs out here at
      // three quarters strength, which is also what keeps the shoulder from
      // reading as a continuous pale band beside a mottled road.
      _sc.copy(colours.shoulder).lerp(colours.blend, clamp(creepA * 0.55 - 0.12, 0, 0.18))
        .multiplyScalar(wear(A.s, side * 1.05, 4801) * shGrit
          * (1 - (1 - shade(A.s, side * 1.05)) * 0.75));
      b.quad(st(A, eA, yEA), st(A, vA, yVA), st(B, eB, yEB), st(B, vB, yVB), _sc);

      // THE TALUS. As many facets as the drop needs — see `apronProfile`. A cut
      // face shows raw earth; a fill face is already half grassed over; a bench
      // is greener still because soil and seed stay on a shelf.
      //
      // The two stations rarely agree on how many facets they need (the ground
      // one station along is three metres away and may be two metres lower), so
      // the quad strip runs to the LONGER of the two and the shorter side simply
      // repeats its landing point. Those quads come out as slivers along the toe
      // of the bank, which is exactly where a real batter's daylight line
      // wanders in and out.
      const ptsA = apA.pts, ptsB = apB.pts;
      const steps = Math.max(ptsA.length, ptsB.length);
      for (let q = 1; q < steps; q++) {
        const a0 = ptsA[Math.min(q - 1, ptsA.length - 1)], a1 = ptsA[Math.min(q, ptsA.length - 1)];
        const b0 = ptsB[Math.min(q - 1, ptsB.length - 1)], b1 = ptsB[Math.min(q, ptsB.length - 1)];
        if (a1[0] - a0[0] < 1e-4 && b1[0] - b0[0] < 1e-4) continue;
        const earth = apA.cut ? colours.cut : colours.fill;
        const g = a1[2];
        const face = g >= 1 ? colours.blend : earth.clone().lerp(colours.blend, g);
        b.quad(st(A, side * a0[0], a0[1]), st(A, side * a1[0], a1[1]),
          st(B, side * b0[0], b0[1]), st(B, side * b1[0], b1[1]),
          jitter(face, i * 13 + (side > 0 ? 1 : 2) + q * 37, 0.10));
      }
    }
  }

  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    polygonOffset: true,
    // Just enough to win the depth test where the skirt lies on the ground.
    // The old -3/-6 dragged the whole ribbon toward the camera, which is half
    // of why it looked like a separate object hovering over the meadow.
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(b.geometry(), mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.name = name;
  return mesh;
}

// ---------------------------------------------------------------------------
// Route furniture — marker posts, corner chevrons, hairpin retaining walls.
// Sparse by construction: they only appear where the road is doing something.
// ---------------------------------------------------------------------------

function markerGeom() {
  const post = new THREE.BoxGeometry(0.26, 1.55, 0.26);
  post.translate(0, 0.77, 0);
  const cap = new THREE.BoxGeometry(0.34, 0.26, 0.34);
  cap.translate(0, 1.55, 0);
  return mergeGeometries([post, cap]);
}

/**
 * Corner board. Tilted well back so a 61-degree camera sees the FACE, not the
 * top edge — the reference frame's arrow signs read the same way.
 */
function boardGeom() {
  const board = new THREE.BoxGeometry(0.14, 1.30, 3.00);
  board.rotateZ(-0.62);
  board.translate(0, 1.30, 0);
  const leg = new THREE.BoxGeometry(0.20, 1.10, 0.20);
  leg.translate(0.28, 0.55, 0.95);
  const leg2 = leg.clone(); leg2.translate(0, 0, -1.9);
  return mergeGeometries([board, leg, leg2]);
}

/** Rally kerb block — a dashed red/white line reads instantly from above. */
function kerbGeom() {
  const g = new THREE.BoxGeometry(1.45, 0.26, 0.62);
  g.translate(0, 0.10, 0);
  return g;
}

/**
 * BARRIERS — the roadside furniture the car can actually hit.
 *
 * Two kinds, and the difference is the whole feature:
 *
 *  · 'fence'  post-and-rail timber (ART_DIRECTION §4.1, and the single most
 *             recurring piece of furniture in the client set: warm brown
 *             timber following the road's curve, sometimes both sides, running
 *             off over a hill). It BREAKS. Hit a bay above BREAK_SPEED and its
 *             rails are knocked out, the gap stays knocked out for the rest of
 *             the session, and the timber goes tumbling across the meadow.
 *
 *  · 'guard'  steel W-beam guardrail — cool grey, one bright crease along the
 *             top that catches the sun. It does NOT break. It goes exactly
 *             where a real rally stage puts one: across a bridge approach, and
 *             on the OUTSIDE of a corner tight enough or with enough of a drop
 *             beyond it that a car leaving the road there leaves the stage.
 *             Sparse by construction — a guardrail everywhere reads as motorway
 *             furniture and tells the driver nothing.
 *
 * Built as geometry rather than instances because every bay is a different
 * length and a different slope: fence posts are planted on the TERRAIN (not on
 * the road plane, which is up to a third of a metre above it on a bench) and
 * the rails are stretched between consecutive post tops, so the line follows
 * the ground the way a real fence does instead of floating level. Guardrail
 * posts are the other way round — they are bolted to the SHOULDER, so their
 * beam tracks the carriageway and the post grows longer wherever the ground
 * falls away underneath it, which is what makes the drop read.
 *
 * BREAKING WITHOUT A DRAW CALL PER BAY. Everything lives in one merged buffer.
 * Each breakable bay remembers the vertex range its two rails occupy, and
 * breaking it collapses that range onto the bay's own centre: the triangles go
 * to zero area, disappear, and cost nothing. No mesh is created or destroyed,
 * the draw call count never moves, and the bounding sphere stays valid because
 * the collapse point is inside the old geometry.
 */

// Post pitch. WHY 4.4 m: the camera looks down from ~26 degrees above the
// horizon, so ground distance is foreshortened to 0.44 while anything VERTICAL
// keeps 0.90 of its length on screen. A fence running ALONG the road — which is
// every fence here — therefore has its bays squashed to 0.44 while its posts
// are not, and as soon as bay x 0.44 < post x 0.90 consecutive posts overlap
// and the line renders as one solid brown bar. 4.4 x 0.44 / 1.28 x 0.90 = 1.7,
// which leaves a clear run of open rail with meadow visible through it — what
// target_01 shows at every magnification.
const BAY = 4.4;
const POST_H = 1.28;
const POST_R = 0.16;      // half-width of the square timber post
const RAILS = [0.46, 0.94];
const RAIL_T = 0.10;      // rail half-thickness
const RAIL_H = 0.13;      // rail half-height
// How far below the carriageway a post foot may ever sink. Ordinary undulation
// is well inside this; a bank or a lake is not.
const FOOT_DROP = 1.9;

// Steel guardrail. Deliberately shorter than the fence and mounted right at the
// shoulder rather than back in the meadow: the two must never be mistaken for
// each other at a glance, and the one that stops you has to look like it is
// part of the road.
// WHAT THE CAMERA ACTUALLY SEES OF A GUARDRAIL. Looking down from 26 degrees
// above the horizon, a barrier is read almost entirely off its TOP faces. The
// first version put a near-white glint on the widest top face it had, and the
// result was a lavender pipe lying beside the road — no posts, no beam, no
// steel. So the tops are now mid grey and the highlight is a separate narrow
// strip down the middle of the beam: a grey band with one bright line in it,
// which is what a W-beam looks like from a helicopter.
const G_OFFSET = 1.35;    // metres outboard of the verge — a sliver of verge shows
// Fat enough that the posts read as ticks along the beam. 0.155 gave a 0.31 m
// post — four pixels at this camera height, against a bay pitch of sixty — and
// in the A/B against target_01 the whole barrier read as a thin grey LINE ruled
// along the road's edge, which target_01 has nothing like: a painted kerb, not a
// safety barrier. 0.20 makes the ticks five or six pixels and, with the taller
// head below and the per-bay tone variation on the beam, the object reads as
// posts carrying a beam rather than as a stripe.
const G_POST_R = 0.20;
const G_LO = 0.30;        // beam bottom, above the shoulder
const G_HI = 0.92;        // beam top
const G_POST_TOP = 1.22;  // post head stands proud of the beam
const G_BEAM_T = 0.195;   // half-thickness of the beam
const G_FAST = 200;       // ...and this is as wide as a "fast corner" gets
const G_ALWAYS = 55;      // this tight and it gets one whether it drops or not
const G_DROP = 2.0;       // metres the ground must fall away to earn one
const G_CLIFF = 9.0;      // ...and a RAVINE is a hazard whether it bends or not
// Where to ask. Five samples out to 26 m, because the terrain mesh is faceted
// at ~10 m and one probe measures the facet it happens to land on.
const G_PROBES = [4, 8, 13, 19, 26];
// Hard ceiling on the share of barrier bays that may be steel, per route side.
const G_BUDGET = 0.06;
const G_APPROACH = 30;    // guardrail this far back from a bridge deck
const G_ABUTMENT = 4.0;   // ...but stop short of the bridge's own wing walls
const G_MINRUN = 3;       // bays; anything shorter is a kink, not a corner

// Above this closing speed a timber bay is knocked out. Below it the car just
// scrapes along the rails. 7 m/s is 25 km/h — a nudge while parking survives,
// anything that reads as a mistake does not.
const BREAK_SPEED = 7;
const DEBRIS_POOL = 168;
const DEBRIS_LIFE = 5.4;
const DEBRIS_FADE = 1.0;

// THE CLIENT, THIS ROUND: "check that ALL sharp corners have metal guardrails.
// For example there are none before the first bridge."
//
// A "sharp corner" for a rally car doing 100-140 km/h is not 90 m. The route's
// own corner planner (see `cornerPlan`) builds hairpins at 26-60 m, chicanes and
// kinks at 70-150 m and sweepers wider than that; measured on the alpine main
// route, 90 m caught 6% of the road and left every 90-150 m bend — most of the
// corners a driver would call sharp — to the rationed drop rule, which spent its
// 6% budget on the deepest ravines and never got to them. So the sharp-corner
// gate is 140 m, and it is NOT rationed: the client's two cases are taken in
// full and the budget only ever buys EXTRA steel above a ravine.
const G_SHARP = 140;
// How close a barrier has to be to count as protecting a station, when the audit
// walks the route. The guardrail stands at hw + verge + G_OFFSET, so anything
// further out than this is a fence in the next field, not a barrier on this bend.
const G_NEAR = 9.0;

/**
 * Every bridge deck in the scene, as a padded world-space XZ rectangle.
 *
 * Read off the scene graph rather than guessed. bridges.js runs AFTER this
 * module and its decks are the only source that is actually right: `sm.wet` is
 * zero on every alpine preset because this world's bridges are not places the
 * road met water, they are places water was later brought to the road. If
 * bridges.js ever stops naming its decks 'bridge' this degrades to no approach
 * guardrails rather than to wrong ones.
 */
function bridgeDecks(node) {
  const out = [];
  try {
    let root = node;
    while (root.parent) root = root.parent;
    const bb = new THREE.Box3();
    root.traverse((o) => {
      if (o.name !== 'bridge' || !o.geometry) return;
      bb.setFromObject(o);
      if (bb.isEmpty()) return;
      out.push([bb.min.x - 3, bb.min.z - 3, bb.max.x + 3, bb.max.z + 3]);
    });
  } catch { out.length = 0; }
  return out;
}

/**
 * Distance along the route, in metres, from every station to the nearest bridge
 * deck. Two sweeps each way so it wraps properly on a closed loop.
 */
function deckDistances(route, decks) {
  const S = route.samples;
  const n = S.length;
  const ds = route.ds;
  const closed = route.closed !== false;
  const over = (x, z) => {
    for (const d of decks) if (x >= d[0] && x <= d[2] && z >= d[1] && z <= d[3]) return true;
    return false;
  };
  const onDeck = new Uint8Array(n);
  for (let i = 0; i < n; i++) onDeck[i] = (S[i].wet || over(S[i].x, S[i].z)) ? 1 : 0;
  const wetD = new Float64Array(n).fill(1e9);
  for (let i = 0; i < n; i++) if (onDeck[i]) wetD[i] = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const j = closed ? (i + 1) % n : Math.min(i + 1, n - 1);
      if (wetD[i] + ds < wetD[j]) wetD[j] = wetD[i] + ds;
    }
    for (let i = n - 1; i >= 0; i--) {
      const j = closed ? ((i - 1) + n) % n : Math.max(i - 1, 0);
      if (wetD[i] + ds < wetD[j]) wetD[j] = wetD[i] + ds;
    }
  }
  return { onDeck, wetD };
}

/**
 * HOW BADLY THE GROUND FALLS AWAY on one side of the road.
 *
 * Taken along a WHOLE PROFILE, not at one probe distance: the terrain mesh's
 * triangles are ~10 m across, and the single probe the first version used landed
 * on the last facet BEFORE a lakeside lip, read a 1.1 m drop, and put breakable
 * timber on a bluff with the water fourteen metres below.
 *
 *   bank   — the worst fall within 9 m of the verge. "Is there a bank here."
 *   hazard — the same fall discounted at 0.40 m per metre out, so the ground has
 *            to keep falling steeper than about 22 degrees to score at all.
 *            "Is this a ravine." Every road cut into a hillside has a downhill
 *            side that drops three or four metres; at a gentler discount that
 *            counted as a ravine and half the world's timber turned to steel.
 */
function sideProfile(terrain, cx, cz, nx, nz, side, base, roadY) {
  let bank = 0, hazard = 0;
  for (const d of G_PROBES) {
    const u = side * (base + d);
    const fall = roadY - terrain.heightAt(cx + nx * u, cz + nz * u);
    if (d <= 9 && fall > bank) bank = fall;
    const h = fall - d * 0.40;
    if (h > hazard) hazard = h;
  }
  return { bank, hazard };
}

/**
 * Does leaving the road HERE, on THIS side, cost the driver the stage? True for
 * a bank, a ravine, and (because a tarn basin is always a bank first) for water.
 */
function costlyToLeave(p) {
  return p.bank > G_DROP || p.hazard > 0;
}

/**
 * An axis-aligned-to-the-road box: four sides plus the top the camera sees.
 * `ends = false` drops the two faces perpendicular to the long axis, which is
 * what a rail wants — both of its ends are buried inside a post, and at this
 * coverage that is a quarter of the barrier's triangles saved for nothing.
 */
function barBox(strip, cx, cy, cz, ax, az, halfA, halfB, halfH, col, top, ends = true) {
  const bx = -az, bz = ax;                       // the other horizontal axis
  const ux = ax * halfA, uz = az * halfA;
  const vx = bx * halfB, vz = bz * halfB;
  const c = [
    [cx - ux - vx, cz - uz - vz], [cx + ux - vx, cz + uz - vz],
    [cx + ux + vx, cz + uz + vz], [cx - ux + vx, cz - uz + vz],
  ];
  const lo = cy - halfH, hi = cy + halfH;
  for (let q = 0; q < 4; q++) {
    if (!ends && q % 2 === 0) continue;           // the two end caps
    const p = c[q], r = c[(q + 1) % 4];
    // A vertical face at this sun angle gets almost nothing from the light rig,
    // so a 0.84 side multiplier came out black and the fence read as a dashed
    // shadow. The sides are lifted instead: the object has to survive being lit
    // almost entirely from above.
    strip.quad([p[0], hi, p[1]], [p[0], lo, p[1]], [r[0], hi, r[1]], [r[0], lo, r[1]],
      q % 2 ? col.clone().multiplyScalar(0.93) : col);
  }
  strip.quad([c[0][0], hi, c[0][1]], [c[1][0], hi, c[1][1]],
    [c[3][0], hi, c[3][1]], [c[2][0], hi, c[2][1]], top);
}

/** One broken splinter of rail. Flat-shaded, four faces, nothing clever. */
function splinterGeom() {
  const g = new THREE.BoxGeometry(0.86, 0.11, 0.15);
  return g;
}

/**
 * Plans, builds and owns every barrier in the world.
 *
 * Returns { group, segments, hit, update, reset } — see the module contract.
 */
function buildBarriers(routes, terrain, seed, cols, waterLevel) {
  const group = new THREE.Group();
  group.name = 'road-barriers';
  // Filled by compile(). `segments` is the array game.js holds a reference to,
  // so a recompile refills it IN PLACE and never hands out a new one.
  const segments = [];
  let panels = [];            // parallel to `segments`: vertex range + debris seed
  let byId = new Map();

  /**
   * HOW MUCH OF THE ROAD CARRIES A TIMBER FENCE.
   *
   * The old rule was `fbm(...) > -0.02`, an eyeballed threshold against a noise
   * function whose distribution nobody had measured. It produced 46% coverage
   * in long blocks, and the hero frame landed in one of the holes: the nearest
   * post to the car was 64 m away and not one fence vertex projected inside the
   * viewport. So the coverage is a NUMBER rather than a threshold — the gate is
   * the (1 - COVER) quantile of the noise sampled along these very routes,
   * which pins the fraction of road that carries fence no matter what the noise
   * does. In target_01 the post-and-rail runs almost continuously on both sides,
   * broken only by field gates and the bridge approach.
   */
  const COVER = 0.94;
  const FREQ = 0.0030;      // ~330 m per cycle: long runs, occasional gates
  const noiseAt = (s, side) =>
    fbm(s * FREQ + side * 17.3, seed * 0.011, { octaves: 2, seed: seed + 613 });

  const vals = [];
  for (const route of routes) {
    for (let i = 0; i < route.samples.length; i += 2) {
      vals.push(noiseAt(route.samples[i].s, 1), noiseAt(route.samples[i].s, -1));
    }
  }
  vals.sort((a, b) => a - b);
  const GATE = vals.length
    ? vals[clamp(Math.floor((1 - COVER) * vals.length), 0, vals.length - 1)]
    : -1;

  // A barrier must never run across a carriageway. Spurs leave the main route
  // at a T, and without this check the line marches straight over the junction
  // and out the other side, which reads as a bug rather than a farm.
  //
  // The test has to ignore the barrier's OWN stretch of road — it is standing a
  // couple of metres off it by construction — but only the own stretch, so it
  // skips a window of arc length on the owning route and tests everything else
  // properly.
  const CELL = 24;
  const grid = new Map();
  routes.forEach((route, ri) => {
    route.samples.forEach((sm, i) => {
      const k = `${Math.floor(sm.x / CELL)},${Math.floor(sm.z / CELL)}`;
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push({ sm, ri, i });
    });
  });
  const overRoad = (x, z, ri, i, n, skip, clearance) => {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    for (let u = -1; u <= 1; u++) {
      for (let v = -1; v <= 1; v++) {
        const l = grid.get(`${ci + u},${cj + v}`);
        if (!l) continue;
        for (const e of l) {
          if (e.ri === ri) {
            const d = Math.abs(e.i - i);
            if (Math.min(d, n - d) <= skip) continue;
          }
          if (Math.hypot(e.sm.x - x, e.sm.z - z) < e.sm.hw + e.sm.verge + clearance) return true;
        }
      }
    }
    return false;
  };

  /**
   * THE WHOLE LAYOUT, AS A PURE FUNCTION OF THE TERRAIN — and it has to be a
   * function, because the terrain is not finished when this module runs.
   *
   * bridges.js digs the lakes (water.js `carveLakes`) and it runs AFTER
   * createRoadNetwork. Measured, in the wildlife frame: at barrier-build time
   * the ground beside the road read 24.8 m at every probe distance; by the time
   * anything was rendered the same four points read 9.3 m. The road there runs
   * along the lip of a bluff with the lake sixteen metres below and it was
   * fenced with post-and-rail — a barrier the car goes straight through, over
   * the edge, into the water — because at planning time the bluff did not
   * exist yet. No threshold could have found it.
   *
   * So the layout is built once eagerly (nothing is ever missing, even if the
   * later pass never comes) and then rebuilt ONCE on the first tick if the
   * witness points say the ground moved. Frame one, then never again.
   */
  const compile = () => {
  const strip = new Strip();
  const segs = [];
  const pans = [];
  const witness = [];

  // Bridge decks, as world-space XZ rectangles. Empty on the eager build (the
  // bridges do not exist yet) and populated on the settled rebuild.
  const decks = bridgeDecks(group);
  routes.forEach((route, ri) => {
    const S = route.samples;
    const n = S.length;
    if (n < 8) return;
    const closed = route.closed !== false;
    const ds = route.ds;
    const total = closed ? n * ds : (n - 1) * ds;
    // Arc length of road the keep-out test forgives on the owning route: far
    // enough that a barrier never trips over its own carriageway, short enough
    // that it still notices the other leg of a hairpin.
    const skip = Math.max(3, Math.round(26 / ds));

    // WHERE THE BRIDGES ARE — by asking, once they exist.
    //
    // Three heuristics failed here first, and it is worth saying why so that
    // nobody tries them again.
    //
    //  1. `sm.wet`, which `describe` sets where the ORIGINAL terrain put water
    //     under the route. Zero samples on either alpine preset: this world's
    //     bridges are the other kind — water.js `planLakes` picks a spot and
    //     digs a tarn UNDER the finished road, from bridges.js, after this
    //     module has run. The deck is not somewhere the road met water; it is
    //     somewhere water was brought to the road.
    //  2. Water beside the road. The carve is kept twelve metres clear of the
    //     centreline (`ROAD_IN`), and the tarns carry their own local level —
    //     measured at all four alpine bridges, 30 to 40 m above the biome's.
    //  3. Road standing clear of the ground on BOTH flanks. True of all four
    //     real bridges, and also of every embankment and ridge crest on the
    //     route: at any threshold that found the bridges it also turned a third
    //     of the world's timber into steel.
    //
    // The decks are simply objects in the scene by the time the settled rebuild
    // runs, so read them instead of guessing. Cross-module, and deliberately
    // so: it is read-only, it is the only source that is actually right, and if
    // bridges.js ever stops naming its decks 'bridge' this degrades to no
    // approach guardrails rather than to wrong ones.
    const { onDeck, wetD } = deckDistances(route, decks);

    for (const side of [1, -1]) {
      // --- 1. march the stations -----------------------------------------
      //
      // MARCHED IN ARC LENGTH, not per sample. Stations are ~3 m apart, so a
      // "one post per sample, skip if closer than BAY" loop can only ever
      // produce bays of 6 m — double what the reference shows. Interpolating
      // between the two bracketing samples puts the post exactly where the bay
      // wants it and lets the bay length be a design decision again.
      const st = [];
      for (let s = 0; s < total; s += BAY) {
        const f = s / ds;
        const i0 = Math.floor(f) % n;
        const i1 = closed ? (i0 + 1) % n : Math.min(i0 + 1, n - 1);
        const t = f - Math.floor(f);
        const a = S[i0], b = S[i1];
        // The deck itself belongs to bridges.js, which builds its own timber
        // railing along it. A second barrier out there would either duplicate
        // that or hang over open water.
        if (onDeck[i0] || onDeck[i1]) { st.push(null); continue; }

        let nx = lerp(a.nx, b.nx, t), nz = lerp(a.nz, b.nz, t);
        const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
        let tx = lerp(a.tx, b.tx, t), tz = lerp(a.tz, b.tz, t);
        const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        const e = {
          s, i0, t, a, b, nx, nz, tx, tz,
          cx: lerp(a.x, b.x, t), cz: lerp(a.z, b.z, t),
          hw: lerp(a.hw, b.hw, t), verge: lerp(a.verge, b.verge, t),
          wetD: lerp(wetD[i0], wetD[i1], t),
          guard: false,
        };

        // --- does this station earn a guardrail? ---
        // `ks` is curvature already smoothed over 24 m — raw k at 3 m stations
        // carries enough sampling noise to invent corners that are not there.
        const ks = lerp(a.ks ?? a.k, b.ks ?? b.k, t);
        const r = 1 / Math.max(Math.abs(ks), 1e-6);
        const outside = -Math.sign(ks) || 1;
        // Bridge approach: both sides, but stopping short of the abutment so
        // the steel never grows out of the bridge's own timber wing walls.
        if (e.wetD > G_ABUTMENT && e.wetD < G_APPROACH) { e.guard = true; e.spec = true; }
        else {
          // WHAT A GUARDRAIL IS ACTUALLY FOR: stopping the car leaving the
          // STAGE. So the question at every station is "how far does the ground
          // fall on this side" — see `sideProfile` for why that has to be a
          // profile and not a probe.
          const roadY = lerp(a.y, b.y, t) + LIFT;
          const base = e.hw + e.verge;
          const p = sideProfile(terrain, e.cx, e.cz, nx, nz, side, base, roadY);
          e.bank = p.bank;
          // 1. A SHARP CORNER WITH SOMEWHERE TO FALL BEYOND IT. The client's own
          // rule, so it is never rationed and never gated by the coverage noise.
          //
          // The old gate was 90 m and its "or a drop" arm only applied between 55 and
          // 90 — so a 100 m bend on the lip of a bank got nothing at all unless
          // the ranked-ravine budget happened to reach it, and it never did,
          // because the budget was spent on the deepest drops on the map. That
          // is exactly the hole the client walked into before the first bridge.
          if (side === outside && (r < G_ALWAYS || (r < G_SHARP && costlyToLeave(p)))) {
            e.guard = true; e.spec = true;
          }
          // 2. A FAST corner above a real ravine — too wide for rule 1 to call
          // sharp, but the car arrives at it flat out. Only a CANDIDATE: see the
          // budget below. Left un-rationed once, this world's roads run round
          // lakes and along hillsides for most of their length and the frame
          // came back with a kilometre of steel where the reference's signature
          // post-and-rail should be.
          if (side === outside && r < G_FAST) e.haz = p.hazard;
          // One witness in twenty METRES OF ROAD. The old test keyed the witness
          // count off `segs.length`, which is still zero while the first side of
          // the first route is being marched — so the whole of that side
          // contributed exactly ONE witness point, and whether the settled
          // rebuild happened at all came down to whether the lakes moved that
          // single spot. Keying it off the station count instead spreads the
          // witnesses evenly over every side of every route.
          if (witness.length < 400 && st.length % 5 === 0) {
            const u = side * (base + 13);
            const wx = e.cx + nx * u, wz = e.cz + nz * u;
            witness.push([wx, wz, terrain.heightAt(wx, wz)]);
          }
        }
        st.push(e);
      }

      // --- 2. ration the steel --------------------------------------------
      //
      // "Do not put guardrails everywhere; they should read as a deliberate
      // safety measure at the dangerous places." The drop rule on its own does
      // not respect that: in the wildlife world the road runs round a lake for
      // most of its length, every metre of it genuinely is above a sixteen
      // metre bank, and honouring that put steel on 78% of the route. True, and
      // completely wrong — a stage where everything is guarded tells the driver
      // nothing, and the timber fence is the reference's signature.
      //
      // So the drop rule is a ranking, not a test. The client's own two cases
      // (bridge approach, corner tighter than 90 m) are taken in full; whatever
      // budget is left goes to the steepest drops first and runs out.
      {
        let live = 0;
        for (const e of st) if (e) live++;
        let budget = Math.round(live * G_BUDGET);
        for (const e of st) if (e && e.spec) budget--;
        const cliffs = st.filter((e) => e && !e.spec && (e.haz ?? 0) > G_CLIFF)
          .sort((p, q) => q.haz - p.haz);
        for (let i = 0; i < cliffs.length && budget > 0; i++, budget--) cliffs[i].guard = true;
      }

      // --- 3. tidy the guardrail runs -------------------------------------
      // A guardrail two bays long is not a safety measure, it is litter; and a
      // real one starts a little before the hazard and ends a little after it.
      // So: erode runs shorter than G_MINRUN, then dilate what survives by one
      // bay at each end.
      //
      // ...EXCEPT WHERE THE CLIENT'S RULE PUT IT. The audit found the last hole
      // here: a 108 m bend at s = 2904 on the lip of a 15 m bank earned two bays
      // and the erosion swept both away, leaving the one thing the client asked
      // us to check for — a sharp corner over a drop with no barrier. A run that
      // contains a `spec` station is never eroded; the dilation below then turns
      // those two bays into a four-bay, 17 m guardrail, which is short but is
      // exactly what a real stage puts on a single bad bend.
      const m = st.length;
      const at = (i) => (closed ? ((i % m) + m) % m : (i < 0 || i >= m ? -1 : i));
      const flag = new Uint8Array(m);
      for (let i = 0; i < m; i++) flag[i] = st[i] && st[i].guard ? 1 : 0;
      const kept = flag.slice();
      for (let i = 0; i < m; i++) {
        if (!flag[i]) continue;
        const pj = at(i - 1);
        if (pj >= 0 && flag[pj] && pj !== i) continue;   // not the start of a run
        let run = 0, spec = false;
        while (run < m) {
          const j = at(i + run);
          if (j < 0 || !flag[j]) break;
          if (st[j].spec) spec = true;
          run++;
        }
        if (run < G_MINRUN && !spec) {
          for (let k = 0; k < run; k++) { const j = at(i + k); if (j >= 0) kept[j] = 0; }
        }
      }
      const dil = kept.slice();
      for (let i = 0; i < m; i++) {
        if (!kept[i]) continue;
        for (const d of [-1, 1]) { const j = at(i + d); if (j >= 0) dil[j] = 1; }
      }
      for (let i = 0; i < m; i++) if (st[i]) st[i].guard = !!dil[i];

      // --- 4. place and emit ----------------------------------------------
      let prev = null;
      for (let q = 0; q < m; q++) {
        const e = st[q];
        if (!e) { prev = null; continue; }
        const guard = e.guard;
        // A timber fence is a field boundary standing back in the meadow; a
        // guardrail is part of the road. Their offsets say so.
        //
        // ...unless the meadow is now a lake. When water.js digs the tarns the
        // shoreline moves, and the offset that was a grassy verge at planning
        // time can be six metres under. The baseline frame had a hundred metres
        // of post-and-rail standing IN the water beside the hero corner, and
        // the first version of the settled rebuild simply deleted it — correct,
        // and a much worse picture, because that fence following the shore is
        // the reference's signature.
        //
        // So the line walks INWARD until it finds a post base that stands clear
        // of the water. Two things make that always succeed where it should:
        // the walk goes right in to the verge, and the base is clamped to the
        // road's own shoulder (below), so where the lake laps against the fill
        // the fence ends up standing on the embankment at road level — which is
        // exactly where a fence beside a reservoir road is.
        // THE RAIL IS BOLTED TO THE CARRIAGEWAY AS BUILT, NOT AS DESIGNED.
        //
        // `sectionY` is the design plane; the emitted ribbon is `drapeY` of it,
        // which lifts the edge above the ground by up to 0.67 m at the contact
        // patches. A beam referenced to the design plane sinks into the road it
        // is protecting by exactly that lift. So the reference is the drawn edge
        // vertex, carried outboard of it on the design section's own camber
        // (the post stands past the last vertex the ribbon emits).
        const roadEdgeY = (sm, uu) => {
          const ap = sm._apron;
          if (!ap) return sectionY(sm, capU(sm, uu));
          const s = ap[uu < 0 ? -1 : 1];
          return s.yE + (sectionY(sm, capU(sm, uu)) - sectionY(sm, s.e));
        };
        const roadYAt = (uu) => lerp(roadEdgeY(e.a, uu), roadEdgeY(e.b, uu), e.t);
        // ...AND THE POST STANDS ON WHAT IS DRAWN UNDER IT.
        //
        // This used to read `terrain.heightAt` — neither the terrain mesh nor,
        // where G_OFFSET actually puts the post, the surface it is standing on
        // at all: 1.35 m outboard of the verge is the road's OWN batter, a metre
        // of fill above the hillside. Measured on the shipped build, 8.8% of
        // posts floated clear of the drawn ground (worst 10.9 m, at (412, 193))
        // and 31.3% were buried more than 0.6 m in it. Ask the earthworks first
        // and the terrain only outside them.
        const footGround = (px, pz) => {
          const ua = (px - e.a.x) * e.a.nx + (pz - e.a.z) * e.a.nz;
          const ub = (px - e.b.x) * e.b.nx + (pz - e.b.z) * e.b.nz;
          const oa = drawnSection(e.a, ua, _secA);
          const ob = drawnSection(e.b, ub, _secB);
          return (oa || ob) ? lerp(_secA.y, _secB.y, e.t) : groundY(terrain, px, pz);
        };
        const off0 = guard ? G_OFFSET : 2.15;
        let off = off0, x = 0, z = 0, g = 0, ok = false;
        // Best offset that clears the water but leaves the post standing on
        // nothing — kept so this walk can never delete a bay that the old rule
        // would have placed. `audit()` owes 221 bay-stations and misses none;
        // trading a floating post for a hole in a guardrail is not a fix.
        let bx = 0, bz = 0, bg = 0, bo = 0, bok = false;
        for (; off > 0.5; off -= 0.45) {
          const uu = side * (e.hw + e.verge + off);
          x = e.cx + e.nx * uu; z = e.cz + e.nz * uu;
          const grd = footGround(x, z);
          // A post never sinks more than FOOT_DROP below the carriageway. It
          // keeps the fence following the ground over ordinary undulation, and
          // stops it walking down a bank or disappearing under a lake.
          g = Math.max(grd - 0.14, roadYAt(uu) - FOOT_DROP);
          if (g <= waterLevel + 0.25) continue;
          if (!bok) { bok = true; bx = x; bz = z; bg = g; bo = off; }
          // ...but FOOT_DROP is a floor, not a foundation. Inside a hairpin the
          // batter is capped to stop neighbouring sections overlapping, so it can
          // stop a few centimetres short of where G_OFFSET wants the post and the
          // next drawn thing is the hillside eleven metres below. Measured: the
          // worst four posts in this world hung 10.4-11.4 m in the air, all of
          // them at (389..412, 186..193). Walking one step further in puts the
          // foot back on the road's own earthworks, which is where a fence beside
          // a fill embankment actually stands.
          if (g - grd < 0.5) { ok = true; break; }
        }
        if (!ok && bok) { x = bx; z = bz; g = bg; off = bo; ok = true; }
        if (!ok) { prev = null; continue; }
        const u = side * (e.hw + e.verge + off);
        // Timber is gated by the coverage noise; steel is a deliberate act and
        // is never interrupted by it.
        if (!guard && noiseAt(e.s, side) <= GATE) { prev = null; continue; }
        if (overRoad(x, z, ri, e.i0, n, skip, guard ? 0.5 : 1.4)) { prev = null; continue; }

        if (guard) {
          // Bolted to the shoulder: the beam tracks the CARRIAGEWAY, and the
          // post reaches down to whatever the ground is doing underneath it.
          const roadY = roadYAt(u);
          const foot = Math.max(Math.min(g, roadY) - 0.10, roadY - 1.70);
          const top = roadY + G_POST_TOP;
          barBox(strip, x, (foot + top) * 0.5, z, e.tx, e.tz,
            G_POST_R, G_POST_R, (top - foot) * 0.5, cols.steelPost, cols.steelTop);
          g = roadY;
        } else {
          barBox(strip, x, g + POST_H * 0.5, z, e.tx, e.tz, POST_R, POST_R, POST_H * 0.5,
            // The cap is the giveaway from above: in the reference it is a
            // bright orange square sitting proud of the rails, one per bay.
            cols.post, cols.postTop);
        }

        const cur = { x, z, g, guard, nx: e.nx * side, nz: e.nz * side };
        // Rails only span a bay whose two ends agree about what they are. A
        // fence that stops and a guardrail that starts is exactly what a real
        // stage looks like at the mouth of a bridge.
        if (prev && prev.guard === guard && Math.hypot(x - prev.x, z - prev.z) < BAY * 1.9) {
          const dx = x - prev.x, dz = z - prev.z;
          const l = Math.hypot(dx, dz) || 1;
          const ax = dx / l, az = dz / l;
          const mx = (x + prev.x) * 0.5, mz = (z + prev.z) * 0.5;
          const my = (prev.g + g) * 0.5;
          const v0 = strip.count;
          if (guard) {
            // ONE box, and the glint lives on its top face.
            //
            // The version before this put a separate bright crease along the
            // middle of the beam, on the theory that a W-beam has one. At this
            // camera height the whole beam is under two pixels wide, so the
            // crease did not sit INSIDE the beam — it antialiased over all of
            // it, and the guardrail rendered as a lavender wire. Detail smaller
            // than the object it is detailing is not detail, it is a repaint.
            // Per-bay tone, +/-5%. A W-beam is bolted together out of separate
            // pressed sections and no two of them have weathered alike; without
            // this the run is one unbroken value for four hundred pixels, which
            // is most of why it reads as a ruled line.
            const bt = 1 + (((Math.imul(segs.length + 1, 2654435761) >>> 0) / 4294967296) - 0.5) * 0.10;
            barBox(strip, mx, my + (G_LO + G_HI) * 0.5, mz, ax, az,
              l * 0.5, G_BEAM_T, (G_HI - G_LO) * 0.5,
              _jc.copy(cols.steelDark).multiplyScalar(bt),
              _sc.copy(cols.steelGlint).multiplyScalar(bt), false);
          } else {
            for (const h of RAILS) {
              // the rail follows the ground: its centre is the mean of the two
              // post heights, so a fence on a slope steps down with the slope
              barBox(strip, mx, my + h, mz, ax, az, l * 0.5, RAIL_T, RAIL_H,
                cols.rail, cols.railTop, false);
            }
          }
          const id = segs.length;
          segs.push({
            x: mx, z: mz, dx: ax, dz: az, half: l * 0.5,
            // Unit normal pointing AWAY from the road. A guardrail deflection
            // needs to know which way is back onto the stage, and a collision
            // needs to know which face was struck; both are this vector.
            nx: cur.nx, nz: cur.nz,
            kind: guard ? 'guard' : 'fence', broken: false, id,
          });
          pans.push({
            v0, v1: strip.count,
            cx: mx, cy: my + (guard ? (G_LO + G_HI) * 0.5 : RAILS[1]), cz: mz,
            ax, az, ox: cur.nx, oz: cur.nz, len: l,
          });
        }
        prev = cur;
      }
    }
  });

    return { strip, segs, pans, witness };
  };

  // ------------------------------------------------------------------ meshes
  let plan = compile();
  let pos = null;
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true, side: THREE.DoubleSide,
  }));
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.name = 'road-barriers-mesh';
  // Never culled, for two reasons: the barrier network spans the whole map so
  // its bounding sphere is the map anyway, and this mesh carries the fallback
  // clock below — which only ticks on frames where it is actually drawn.
  mesh.frustumCulled = false;
  group.add(mesh);

  /** Adopt a freshly compiled layout: geometry, ids, and the caller's array. */
  const adopt = (next) => {
    plan = next;
    mesh.geometry.dispose();
    mesh.geometry = next.strip.geometry();
    pos = mesh.geometry.attributes.position;
    mesh.visible = next.strip.count > 0;
    segments.length = 0;
    for (const sg of next.segs) segments.push(sg);
    panels = next.pans;
    byId = new Map();
    for (const sg of segments) byId.set(sg.id, sg);
  };
  adopt(plan);

  /**
   * Rebuild once, on the first tick, if the ground moved under us. See the note
   * above compile(). Guarded so it can only ever happen before anything has
   * been broken — recompiling would renumber the segments.
   */
  let settled = false;
  const eagerDecks = bridgeDecks(group).length;
  const resettle = () => {
    if (settled) return;
    settled = true;
    let moved = false;
    for (const w of plan.witness) {
      if (Math.abs(terrain.heightAt(w[0], w[1]) - w[2]) > 0.6) { moved = true; break; }
    }
    // ...OR A BRIDGE APPEARED. This is the client's "there are no guardrails
    // before the first bridge", and it was never a threshold problem: the decks
    // do not EXIST when this module runs (bridges.js is two constructors later),
    // so the eager layout cannot contain a single bridge approach, and whether
    // the rebuild that would add them ran at all came down to whether a lake
    // happened to move one of the witness points. Counting decks answers the
    // question directly — if there are more of them now than there were, the
    // approach guardrails are missing and the layout has to be rebuilt.
    if (!moved && bridgeDecks(group).length <= eagerDecks) return;
    try { adopt(compile()); } catch { /* keep the eager layout rather than none */ }
  };

  // ------------------------------------------------------------------ debris
  const debMat = new THREE.MeshLambertMaterial({ flatShading: true });
  const deb = new THREE.InstancedMesh(splinterGeom(), debMat, DEBRIS_POOL);
  deb.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(DEBRIS_POOL * 3), 3);
  deb.castShadow = true;
  deb.receiveShadow = false;
  deb.frustumCulled = false;
  deb.name = 'barrier-debris';
  deb.visible = false;
  group.add(deb);

  const P = [];
  for (let i = 0; i < DEBRIS_POOL; i++) {
    P.push({
      live: false, age: 0, rest: false,
      px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0,
      rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0, sc: 1,
    });
  }
  let cursor = 0, live = 0;
  const _d = new THREE.Object3D();
  const _c = new THREE.Color();
  // Everything below hides behind `dirty`: with no debris in flight the whole
  // system costs one boolean test per frame.
  let dirty = false;

  const emit = (panel, speed, rng) => {
    const heft = clamp(speed / 18, 0.5, 1.25);
    const count = 7 + Math.floor(rng() * 4);
    for (let i = 0; i < count; i++) {
      const slot = cursor;
      const p = P[slot];
      cursor = (cursor + 1) % DEBRIS_POOL;
      if (!p.live) live++;
      const a = (rng() - 0.5) * panel.len;
      p.live = true; p.rest = false; p.age = 0;
      p.px = panel.cx + panel.ax * a + panel.ox * (rng() - 0.5) * 0.4;
      p.py = panel.cy + (rng() - 0.4) * 0.6;
      p.pz = panel.cz + panel.az * a + panel.oz * (rng() - 0.5) * 0.4;
      // Thrown outward and up, with a share of the car's direction of travel
      // along the rail. THE FIRST VERSION OF THESE NUMBERS PUT SPLINTERS FORTY
      // METRES INTO THE MEADOW — a fence bay weighs thirty kilos and holds no
      // energy; what it does is burst, drop, and skitter a few metres. The
      // wreckage has to stay recognisably AT the hole it came from, or the
      // player never connects the debris with the gap they just made.
      const out = (1.3 + rng() * 2.0) * heft;
      const along = (rng() - 0.5) * 3.2 * heft;
      p.vx = panel.ox * out + panel.ax * along;
      p.vz = panel.oz * out + panel.az * along;
      p.vy = (2.4 + rng() * 2.6) * heft;
      p.rx = rng() * TAU; p.ry = rng() * TAU; p.rz = rng() * TAU;
      p.wx = (rng() - 0.5) * 15; p.wy = (rng() - 0.5) * 11; p.wz = (rng() - 0.5) * 15;
      p.sc = 0.55 + rng() * 0.75;
      _c.copy(cols.rail).multiplyScalar(0.82 + rng() * 0.42);
      deb.instanceColor.setXYZ(slot, _c.r, _c.g, _c.b);
    }
    deb.instanceColor.needsUpdate = true;
    dirty = true;
  };

  const step = (dt) => {
    if (!dirty) return;
    const h = Math.min(dt, 1 / 30);
    let any = false;
    for (let i = 0; i < DEBRIS_POOL; i++) {
      const p = P[i];
      if (!p.live) { _d.scale.setScalar(0); _d.updateMatrix(); deb.setMatrixAt(i, _d.matrix); continue; }
      any = true;
      p.age += h;
      if (!p.rest) {
        p.vy -= 17 * h;
        p.px += p.vx * h; p.py += p.vy * h; p.pz += p.vz * h;
        p.rx += p.wx * h; p.ry += p.wy * h; p.rz += p.wz * h;
        // A touch proud of the turf: a splinter lying flat is 0.86 x 0.15 m and
        // the grass swallowed most of them at rest, which threw away the whole
        // point of debris — the wreckage is the evidence of the gap.
        const gy = groundY(terrain, p.px, p.pz) + 0.10;
        if (p.py <= gy) {
          p.py = gy;
          if (Math.abs(p.vy) < 1.6) {
            // Settled. Lay it flat — a splinter standing on end after it has
            // stopped moving is the tell that this is a particle system.
            p.rest = true; p.vx = p.vy = p.vz = 0; p.wx = p.wy = p.wz = 0;
          } else {
            p.vy = -p.vy * 0.30;
            p.vx *= 0.55; p.vz *= 0.55;
            p.wx *= 0.45; p.wy *= 0.7; p.wz *= 0.45;
          }
        }
      } else {
        // ease the last of the tumble out so it lies down rather than snapping
        p.rx = lerp(p.rx, Math.round(p.rx / Math.PI) * Math.PI, Math.min(1, h * 9));
        p.rz = lerp(p.rz, Math.round(p.rz / Math.PI) * Math.PI, Math.min(1, h * 9));
      }
      const fade = p.age > DEBRIS_LIFE - DEBRIS_FADE
        ? clamp((DEBRIS_LIFE - p.age) / DEBRIS_FADE, 0, 1) : 1;
      if (p.age >= DEBRIS_LIFE) { p.live = false; live--; }
      _d.position.set(p.px, p.py, p.pz);
      _d.rotation.set(p.rx, p.ry, p.rz);
      _d.scale.setScalar(p.live ? p.sc * fade : 0);
      _d.updateMatrix();
      deb.setMatrixAt(i, _d.matrix);
    }
    deb.instanceMatrix.needsUpdate = true;
    deb.visible = live > 0;
    if (!any || live <= 0) { dirty = false; deb.visible = false; }
  };

  /** xorshift, so a break looks the same every time the same bay is hit. */
  const rngFor = (id) => {
    let s = (Math.imul(id + 1, 2654435761) ^ seed) >>> 0;
    return () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  };

  /**
   * The car hit barrier `id` at `speed` m/s. Returns true if THIS hit destroyed
   * it, which is the signal game.js needs to punch the car's speed and let it
   * through; false means the barrier held and the car should be deflected.
   */
  const hit = (id, speed = Infinity) => {
    const seg = byId.get(id);
    if (!seg || seg.kind !== 'fence' || seg.broken) return false;
    if (!(speed >= BREAK_SPEED)) return false;
    seg.broken = true;
    const pn = panels[id];
    // Collapse the bay's rails onto their own centre: zero-area triangles,
    // invisible, no buffer resize, no draw call churn, bounding sphere intact.
    for (let v = pn.v0; v < pn.v1; v++) pos.setXYZ(v, pn.cx, pn.cy, pn.cz);
    pos.needsUpdate = true;
    emit(pn, speed, rngFor(id));
    return true;
  };

  let extDriven = false;
  const update = (dt) => { extDriven = true; resettle(); step(dt); };

  // Fallback clock, hung on the MESH — three only calls onBeforeRender for
  // things it actually draws, so the same hook on the Group never fired once
  // and the settled-terrain rebuild below silently never happened.
  //
  // `update` belongs to game.js, but until it is wired the debris would hang
  // motionless in the air, which looks far more broken than no feature at all.
  // Disarms itself the first time anything calls update().
  let lastT = -1;
  mesh.onBeforeRender = () => {
    resettle();
    if (extDriven || !dirty) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    if (lastT < 0) { lastT = now; return; }
    const dt = Math.min(0.05, Math.max(0, now - lastT));
    lastT = now;
    step(dt);
  };

  const reset = () => {
    for (const seg of segments) seg.broken = false;
    for (let i = 0; i < DEBRIS_POOL; i++) P[i].live = false;
    live = 0; dirty = true; step(1 / 60);
  };

  return {
    group, segments, hit, update, reset,
    /** Diagnostics only. */
    get counts() {
      return {
        fence: segments.filter((s) => s.kind === 'fence').length,
        guard: segments.filter((s) => s.kind === 'guard').length,
      };
    },
    breakSpeed: BREAK_SPEED,
  };
}

/**
 * EARTHWORKS AUDIT — "are there vertical walls in this world, and whose?"
 *
 * The client's complaint was a photograph of a height change made as a single
 * vertical polygon. This walks the route and, at every station, takes the
 * PERPENDICULAR PROFILE of the surface the camera actually sees — the road
 * ribbon where the ribbon covers the ground, the terrain everywhere else — and
 * reports the steepest step in it.
 *
 * The profile is assembled from the apron point lists CACHED ON THE SAMPLES by
 * `buildRibbonMesh`, so this measures the mesh that shipped, not a re-derivation
 * of it.
 *
 * Every step is attributed. `road` steps are between two points of the ribbon
 * (shoulder, batter face, bench); `land` steps are between two terrain samples
 * outside the earthworks, which belong to whoever owns `terrain.heightAt` — in
 * this build water.js, which replaces it with a basin-carving version. Without
 * that split the number is meaningless: a road cut into a cliff is not a road
 * bug.
 *
 * Returns { stations, road: {...}, land: {...}, apron: {...}, worst, text }.
 */
function auditSlopes(routes, terrain, opts = {}) {
  const OUT = opts.out ?? 60;      // profile half-width, metres
  const STEP = opts.step ?? 2;     // profile resolution outside the earthworks
  const every = opts.every ?? 1;   // stations to skip
  const WALL = opts.wall ?? 1.0;   // tan 45 deg — the client's own threshold

  const roadSteep = [], landSteep = [], widths = [], rawSteep = [];
  const wHist = new Array(9).fill(0);
  let rawMax = 0, rawWall = 0;
  let stations = 0, roadWall = 0, landWall = 0, benches = 0, unlanded = 0, wetWall = 0;
  let worst = null;

  for (const route of routes) {
    const S = route.samples;
    for (let i = 0; i < S.length; i += every) {
      const sm = S[i];
      const ap = sm._apron;
      if (!ap) continue;
      stations++;
      // The comment below says "the VISIBLE surface" and it now means it: the
      // batter is built against the drawn terrain, so auditing it against the
      // analytic field would attribute facets to whichever of the two happened
      // to be higher at that sample rather than to whichever one the camera sees.
      const gr = (u) => groundY(terrain, sm.x + sm.nx * u, sm.z + sm.nz * u);

      // --- assemble the profile, most negative offset first -----------------
      const prof = [];   // [signed u, y, 'road' | 'land']
      for (const side of [-1, 1]) {
        const a = ap[side];
        const reach = a.pts[a.pts.length - 1][0];
        widths.push(reach - a.pts[0][0]);
        benches += a.benches;
        if (!a.landed) unlanded++;
        const land = [];
        for (let d = Math.ceil(reach / STEP) * STEP; d <= OUT; d += STEP) land.push([side * d, gr(side * d), 'land']);
        // THE VISIBLE SURFACE, not the ribbon's own vertex. Where the batter
        // lies below the raw ground — the whole inboard half of any cutting —
        // the terrain triangle is what the camera sees, so the profile takes the
        // higher of the two and attributes the point to whoever won. Auditing
        // the ribbon's buried vertices instead would report a tidy 39 degree cut
        // face nobody can see, which is how an audit comes to disagree with a
        // screenshot.
        const face = a.pts.map((p) => {
          const t = gr(side * p[0]);
          return t > p[1] + 0.02 ? [side * p[0], t, 'land'] : [side * p[0], p[1], 'road'];
        });
        if (side < 0) { land.reverse(); prof.push(...land, ...face.reverse()); }
        else {
          // The carriageway itself, from ITS OWN left edge to ITS OWN right one.
          // The two sides do not share a half width — the ragged hem wanders
          // independently — and a first version ran this range from |ap[1].e| on
          // BOTH sides. Where the left hem happened to be the wider of the two
          // that put a carriageway sample one centimetre inboard of the left
          // verge point, and the audit's headline number became a 17:1 "wall"
          // that was a 0.18 m camber drop measured over a 0.01 m baseline. The
          // du guard below is the belt to this brace.
          const row = sm._row;
          for (let q = 0; q < row.u.length; q++) prof.push([row.u[q], row.y[q], 'road']);
          prof.push(...face, ...land);
        }
      }

      // --- the ribbon's OWN geometry, buried or not --------------------------
      // The profile above reports the VISIBLE surface, which is the right answer
      // to "does this world have walls in it" but hides what the road builds: on
      // a cutting the batter sits below the raw ground and every step it makes is
      // attributed to the terrain that covers it. The brief's complaint was about
      // the BATTER, so measure that too — the apron point list as built, with no
      // terrain substitution anywhere.
      for (const side of [-1, 1]) {
        const pts = ap[side].pts;
        for (let q = 1; q < pts.length; q++) {
          const du = pts[q][0] - pts[q - 1][0];
          if (du < 0.2) continue;
          const g = Math.abs(pts[q][1] - pts[q - 1][1]) / du;
          if (g > rawMax) rawMax = g;
          if (q === 1) continue;   // the shoulder is measured separately below
        }
        let m = 0;
        for (let q = 1; q < pts.length; q++) {
          const du = pts[q][0] - pts[q - 1][0];
          if (du < 0.2) continue;
          m = Math.max(m, Math.abs(pts[q][1] - pts[q - 1][1]) / du);
        }
        rawSteep.push(m);
        if (m > WALL) rawWall++;
        const w = pts[pts.length - 1][0] - pts[0][0];
        wHist[Math.min(wHist.length - 1, Math.floor(w / 4))]++;
      }

      // --- steepest step, attributed ---------------------------------------
      // STEEPEST GRADIENT OVER A FIXED BASELINE, not between adjacent samples.
      // The profile is not evenly sampled: the carriageway carries 66 slice
      // boundaries about 0.17 m apart while the terrain outside is read every
      // 2 m. A previous version compared neighbours and threw away any pair
      // closer than 0.2 m to kill quantisation noise — which silently discarded
      // EVERY carriageway pair, so the road surface could kick up a metre and
      // score zero. Comparing each point with the nearest earlier point at least
      // BASE metres back is scale-free: it answers "over any half metre of this
      // profile, what is the worst rise?" the same way on both meshes.
      const BASE = 0.5;
      let rMax = 0, lMax = 0, rAt = 0, rPair = null;
      let p0 = 0;
      for (let q = 1; q < prof.length; q++) {
        while (p0 + 1 < q && prof[q][0] - prof[p0 + 1][0] >= BASE) p0++;
        const du = prof[q][0] - prof[p0][0];
        if (du < BASE * 0.5) continue;
        const g = Math.abs(prof[q][1] - prof[p0][1]) / du;
        // Attributed to the road only when the whole span is ribbon.
        let allRoad = true;
        for (let m = p0; m <= q && allRoad; m++) if (prof[m][2] !== 'road') allRoad = false;
        if (allRoad) { if (g > rMax) { rMax = g; rAt = prof[q][0]; rPair = [prof[p0], prof[q]]; } }
        else if (g > lMax) lMax = g;
      }
      if (rMax > WALL && sm.wet) wetWall++;
      roadSteep.push(rMax); landSteep.push(lMax);
      if (rMax > WALL) roadWall++;
      if (lMax > WALL) landWall++;
      if (!worst || rMax > worst.grad) worst = { grad: rMax, at: rAt, i, wet: !!sm.wet, pair: rPair, route: route === routes[0] ? 'main' : 'spur', prof };
    }
  }

  const pct = (a, p) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const deg = (g) => +(Math.atan(g) * 180 / Math.PI).toFixed(1);
  const R = {
    p50: +pct(roadSteep, 0.5).toFixed(2), p90: +pct(roadSteep, 0.9).toFixed(2),
    max: +Math.max(0, ...roadSteep).toFixed(2), over45: roadWall, over45onDecks: wetWall,
  };
  const L = {
    p50: +pct(landSteep, 0.5).toFixed(2), p90: +pct(landSteep, 0.9).toFixed(2),
    max: +Math.max(0, ...landSteep).toFixed(2), over45: landWall,
  };
  const RAW = {
    p50: +pct(rawSteep, 0.5).toFixed(2), p90: +pct(rawSteep, 0.9).toFixed(2),
    max: +rawMax.toFixed(2), over45: rawWall,
  };
  const A = {
    medianWidth: +pct(widths, 0.5).toFixed(1), p90Width: +pct(widths, 0.9).toFixed(1),
    maxWidth: +Math.max(0, ...widths).toFixed(1), benches, unlanded,
  };

  const lines = [];
  lines.push(`  stations profiled       ${stations}  (+-${OUT} m perpendicular, ${STEP} m resolution)`);
  lines.push('');
  lines.push('  steepest step per station, as a gradient (1.00 = 45 deg)');
  lines.push(`    ROAD earthworks       p50 ${R.p50} (${deg(R.p50)} deg)  p90 ${R.p90} (${deg(R.p90)} deg)  max ${R.max} (${deg(R.max)} deg)`);
  lines.push(`      stations over 45 deg  ${R.over45} of ${stations}`);
  lines.push(`    TERRAIN beyond them   p50 ${L.p50} (${deg(L.p50)} deg)  p90 ${L.p90} (${deg(L.p90)} deg)  max ${L.max} (${deg(L.max)} deg)`);
  lines.push(`      stations over 45 deg  ${L.over45} of ${stations}   <- terrain.heightAt owner, not roads.js`);
  lines.push('');
  lines.push('  ...and the BATTER AS BUILT, ignoring where terrain buries it');
  lines.push(`    apron faces           p50 ${RAW.p50} (${deg(RAW.p50)} deg)  p90 ${RAW.p90} (${deg(RAW.p90)} deg)  max ${RAW.max} (${deg(RAW.max)} deg)`);
  lines.push(`      sides over 45 deg     ${RAW.over45} of ${stations * 2}`);
  lines.push('');
  lines.push(`  embankment footprint    median ${A.medianWidth} m  p90 ${A.p90Width} m  max ${A.maxWidth} m`);
  lines.push(`  benches cut             ${A.benches}      batters that ran out of room: ${A.unlanded}`);
  lines.push(`  footprint histogram     ${wHist.map((v, k) => `${k * 4}-${k * 4 + 4}m:${v}`).join('  ')}`);
  if (worst) {
    lines.push('');
    lines.push(`  worst ROAD step: ${worst.grad.toFixed(2)} (${deg(worst.grad)} deg) at offset ${worst.at.toFixed(1)} m, ${worst.route} station ${worst.i}${worst.wet ? ' (BRIDGE DECK)' : ''}`);
    if (worst.pair) lines.push(`    between offset ${worst.pair[0][0].toFixed(2)} m at ${worst.pair[0][1].toFixed(2)} m and offset ${worst.pair[1][0].toFixed(2)} m at ${worst.pair[1][1].toFixed(2)} m`);
    lines.push('  profile across that station (offset m -> height m, * = road ribbon):');
    let row = '   ';
    for (const p of worst.prof) {
      if (Math.abs(p[0]) > 44) continue;
      row += ` ${p[0] >= 0 ? '+' : ''}${p[0].toFixed(0)}:${p[1].toFixed(1)}${p[2] === 'road' ? '*' : ''}`;
      if (row.length > 96) { lines.push(row); row = '   '; }
    }
    if (row.trim()) lines.push(row);
  }
  return { stations, road: R, land: L, raw: RAW, apron: A, widthHist: wHist, worst: worst && { grad: worst.grad, at: worst.at, i: worst.i }, text: lines.join('\n') };
}

/**
 * THE CHECK. Walks every metre of every route and reports every place where
 * leaving the road would cost the driver the stage but no steel barrier stands
 * there. Diagnostics only — nothing in the game reads it — but it is the thing
 * that answers "check that ALL sharp corners have metal guardrails", and it is
 * meant to be run and quoted, not trusted.
 *
 * A station is OWED a guardrail when, on one side:
 *   · the road is on a bridge approach (within G_APPROACH of a deck), or
 *   · that side is the OUTSIDE of a corner tighter than G_ALWAYS, or
 *   · that side is the OUTSIDE of a corner tighter than G_SHARP and the ground
 *     there falls away far enough to be costly (see `costlyToLeave`).
 *
 * It is SATISFIED when a segment of kind 'guard' lies within G_NEAR of the point
 * the guardrail would stand on. Timber does not count: the car goes through it.
 *
 * Returns { ok, owed, missing, runs, text } — `text` is the report to quote.
 */
function auditBarriers(routes, terrain, group, segments) {
  const decks = bridgeDecks(group);
  const guards = segments.filter((s) => s.kind === 'guard');
  // Bucket the steel so the proximity test is O(1) per station rather than O(n).
  const CELL = 16;
  const grid = new Map();
  for (const s of guards) {
    // A bay is up to ~4.4 m long; stamp both ends and the middle.
    for (const f of [-1, 0, 1]) {
      const x = s.x + s.dx * s.half * f, z = s.z + s.dz * s.half * f;
      const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push([x, z]);
    }
  }
  const guardNear = (x, z) => {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    let best = Infinity;
    for (let u = -1; u <= 1; u++) {
      for (let v = -1; v <= 1; v++) {
        const l = grid.get(`${ci + u},${cj + v}`);
        if (!l) continue;
        for (const p of l) {
          const d = Math.hypot(p[0] - x, p[1] - z);
          if (d < best) best = d;
        }
      }
    }
    return best;
  };

  const rows = [];
  let owed = 0, missing = 0, unguardedCliff = 0;
  routes.forEach((route, ri) => {
    const S = route.samples;
    const n = S.length;
    if (n < 8) return;
    const { onDeck, wetD } = deckDistances(route, decks);
    for (const side of [1, -1]) {
      // Walked at the barrier's own bay pitch, so a "missing" run is countable
      // in bays and directly comparable with what compile() emits.
      const closed = route.closed !== false;
      const total = closed ? n * route.ds : (n - 1) * route.ds;
      let run = null;
      const flush = () => {
        if (run && run.bays >= 1) rows.push(run);
        run = null;
      };
      for (let s = 0; s < total; s += BAY) {
        const f = s / route.ds;
        const i0 = Math.floor(f) % n;
        const i1 = closed ? (i0 + 1) % n : Math.min(i0 + 1, n - 1);
        const t = f - Math.floor(f);
        const a = S[i0], b = S[i1];
        if (onDeck[i0] || onDeck[i1]) { flush(); continue; }   // bridges.js owns the deck
        let nx = lerp(a.nx, b.nx, t), nz = lerp(a.nz, b.nz, t);
        const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
        const cx = lerp(a.x, b.x, t), cz = lerp(a.z, b.z, t);
        const hw = lerp(a.hw, b.hw, t), verge = lerp(a.verge, b.verge, t);
        const wd = lerp(wetD[i0], wetD[i1], t);
        const ks = lerp(a.ks ?? a.k, b.ks ?? b.k, t);
        const r = 1 / Math.max(Math.abs(ks), 1e-6);
        const outside = -Math.sign(ks) || 1;
        const roadY = lerp(a.y, b.y, t) + LIFT;
        const base = hw + verge;
        const p = sideProfile(terrain, cx, cz, nx, nz, side, base, roadY);

        let why = null;
        if (wd > G_ABUTMENT && wd < G_APPROACH) why = 'bridge approach';
        else if (side === outside && r < G_ALWAYS) why = 'hairpin';
        else if (side === outside && r < G_SHARP && costlyToLeave(p)) why = 'sharp corner over a drop';
        const u = side * (base + G_OFFSET);
        const d = guardNear(cx + nx * u, cz + nz * u);
        // NOT OWED, BUT WORTH KNOWING. A ravine deeper than G_CLIFF beside a
        // stretch too straight to be a corner is not in the client's rule and is
        // deliberately left to the timber — the post-and-rail running along the
        // shore is the reference's signature and a kilometre of steel instead of
        // it has been tried and was much worse. Counted anyway, so the trade is
        // visible rather than silent.
        if (!why && p.hazard > G_CLIFF && d > G_NEAR) unguardedCliff++;
        if (!why) { flush(); continue; }
        owed++;
        if (d <= G_NEAR) { flush(); continue; }
        missing++;
        if (run && run.why === why && run.side === side && run.ri === ri
            && s - run.sEnd <= BAY * 1.5) {
          run.bays++; run.sEnd = s;
        } else {
          flush();
          run = {
            ri, side, why, bays: 1, s: Math.round(s), sEnd: s,
            x: Math.round(cx), z: Math.round(cz),
            r: Math.round(r), bank: +p.bank.toFixed(1), haz: +p.hazard.toFixed(1),
            near: Math.round(d),
          };
        }
      }
      flush();
    }
  });

  rows.sort((p, q) => q.bays - p.bays);
  const lines = [
    `ROUTE BARRIER AUDIT  (${routes.length} routes, `
    + `${segments.filter((s) => s.kind === 'guard').length} steel bays, `
    + `${segments.filter((s) => s.kind === 'fence').length} timber bays, `
    + `${decks.length} bridge decks)`,
    `rule: guardrail owed on the OUTSIDE of any corner < ${G_ALWAYS} m, or < ${G_SHARP} m`
    + ` with a bank > ${G_DROP} m / a ravine, and within ${G_APPROACH} m of a bridge deck`,
    `owed ${owed} bay-stations, unprotected ${missing} (${(100 * missing / Math.max(1, owed)).toFixed(1)}%)`,
    `not owed but noted: ${unguardedCliff} bay-stations beside a ravine deeper than`
    + ` ${G_CLIFF} m on road too straight to be a corner — timber by design`,
  ];
  if (!rows.length) lines.push('no unprotected hazard found — PASS');
  for (const w of rows.slice(0, 24)) {
    lines.push(`  MISSING ${String(w.bays).padStart(3)} bays  route ${w.ri} side ${w.side > 0 ? '+' : '-'}`
      + `  s=${String(w.s).padStart(5)} m  at (${w.x}, ${w.z})`
      + `  r=${w.r > 9000 ? '   inf' : String(w.r).padStart(4) + ' m'}`
      + `  bank=${String(w.bank).padStart(5)} m  ravine=${String(w.haz).padStart(5)} m`
      + `  nearest steel ${w.near > 900 ? 'none' : w.near + ' m'}  [${w.why}]`);
  }
  if (rows.length > 24) lines.push(`  ...and ${rows.length - 24} shorter runs`);
  return { ok: missing === 0, owed, missing, unguardedCliff, runs: rows, text: lines.join('\n') };
}

function buildFurniture(ctx, routes, colours) {
  const { palette, terrain, seed } = ctx;
  const group = new THREE.Group();
  group.name = 'road-furniture';
  const colliders = [];
  const posts = [];
  const boards = [];
  const kerbs = [];
  const wall = new Strip();

  const wallCol = new THREE.Color(palette.rock).lerp(new THREE.Color(palette.rockShadow), 0.42);
  const wallTop = new THREE.Color(palette.roadEdge).lerp(new THREE.Color(palette.rock), 0.30);

  for (const route of routes) {
    const S = route.samples;
    const n = S.length;
    let sinceMarker = 1e9, sinceBoard = 1e9, sinceKerb = 1e9;
    for (let i = 0; i < n; i++) {
      const sm = S[i];
      sinceMarker += route.ds; sinceBoard += route.ds; sinceKerb += route.ds;
      if (sm.wet) continue;
      const ak = Math.abs(sm.k);
      const outside = -Math.sign(sm.k) || 1;
      const heading = Math.atan2(sm.tz, sm.tx);

      // marker posts: gentle-to-medium bends only, widely spaced
      if (ak > 1 / 170 && ak < 1 / 55 && sinceMarker > 30) {
        sinceMarker = 0;
        const u = outside * (sm.hw + sm.verge + 0.30);
        posts.push({
          x: sm.x + sm.nx * u, z: sm.z + sm.nz * u,
          y: sectionY(sm, capU(sm, u)) - 0.30, r: heading,
        });
      }
      // kerb blocks: only the genuinely tight stuff
      if (ak > 1 / 65 && sinceKerb > 2.9) {
        sinceKerb = 0;
        const u = outside * (sm.hw + sm.verge * 0.55);
        kerbs.push({
          x: sm.x + sm.nx * u, z: sm.z + sm.nz * u,
          y: sectionY(sm, capU(sm, u)) - 0.06, r: heading,
        });
      }
      // corner boards at hairpins
      if (ak > 1 / 38 && sinceBoard > 20) {
        sinceBoard = 0;
        const u = outside * (sm.hw + sm.verge + 2.2);
        const x = sm.x + sm.nx * u, z = sm.z + sm.nz * u;
        boards.push({ x, z, y: sectionY(sm, capU(sm, u)) - 0.55, r: heading });
        // TAGGED. core/collision.js infers a material from the radius when none
        // is declared, and its rule is `r < 0.95 -> trunk` — correct for every
        // other producer in the world, because props.js only ever makes a solid
        // collider for a tree over 13.5 m tall. This one is a plywood signboard
        // standing 2.2 m outside the verge, exactly where a car running wide
        // goes, and untagged it hit like a mature fir: 25 m/s down to 3.7 m/s
        // and 74 degrees out of shape, off a marker board.
        colliders.push({ x, z, r: 0.7, kind: 'post' });
      }
    }

    // Retaining wall on the outside of hairpins where the ground falls away.
    for (let i = 0; i < n - 1; i++) {
      const A = S[i], B = S[i + 1];
      if (A.wet || B.wet) continue;
      if (Math.abs(A.k) < 1 / 44 || Math.abs(B.k) < 1 / 44) continue;
      if (Math.sign(A.k) !== Math.sign(B.k)) continue;
      const side = -Math.sign(A.k);
      const uA = capU(A, side * (A.hw + A.verge + 0.30));
      const uB = capU(B, side * (B.hw + B.verge + 0.30));
      const yA = sectionY(A, uA), yB = sectionY(B, uB);
      const gA = terrain.heightAt(A.x + A.nx * uA * 1.6, A.z + A.nz * uA * 1.6);
      const gB = terrain.heightAt(B.x + B.nx * uB * 1.6, B.z + B.nz * uB * 1.6);
      if (gA > yA - 0.7) continue; // ground is not falling away — no wall needed
      const topA = yA + 0.42, topB = yB + 0.42;
      const botA = Math.max(gA - 0.7, topA - 3.4), botB = Math.max(gB - 0.7, topB - 3.4);
      const ax = A.x + A.nx * uA, az = A.z + A.nz * uA;
      const bx = B.x + B.nx * uB, bz = B.z + B.nz * uB;
      const ox = A.nx * side * 0.40, oz = A.nz * side * 0.40;
      wall.quad([ax + ox, topA, az + oz], [ax + ox, botA, az + oz],
        [bx + ox, topB, bz + oz], [bx + ox, botB, bz + oz], wallCol);
      wall.quad([ax, topA, az], [ax + ox, topA, az + oz],
        [bx, topB, bz], [bx + ox, topB, bz + oz], wallTop);
    }
  }

  // Warm timber. The palette trunk colour is the right family but too dark and
  // too cool on its own for sunlit rails, so it is lifted toward the measured
  // reference timber (ART_DIRECTION §6, `timber #a8763f`).
  // Sampled off target_01 with tools/road_scan.mjs / crop.mjs: the sunlit rails
  // sit around #b07c42 and the post caps closer to #e0a050. Vertical timber
  // barely catches this light rig, so the material has to start bright or the
  // fence renders as a dark line and the client's most recognisable piece of
  // roadside furniture disappears into the meadow.
  const timber = new THREE.Color(palette.trunk ?? 0x6b4a30).lerp(new THREE.Color(0xb07c42), 0.95);
  // Steel, and it has to stay STEEL. The temptation is to warm it toward the
  // meadow so it sits in the palette, but a warm grey rail beside a warm brown
  // fence is two of the same object; the whole point of a guardrail is that the
  // driver clocks it as "this one will not give" from a hundred metres. So it
  // is pushed the other way — a touch of the sky's blue in it — and it earns
  // its place in the frame with a single bright crease along the top rather
  // than by being pale all over, which would blow the %bright measurement.
  // MEASURED, NOT PICKED. 0x8e979f is what "cool grey" looks like in a swatch,
  // and under this light rig — full sun on an upward-facing face plus the sky
  // term — every top face of it clipped toward white and the guardrail rendered
  // as a lavender pipe lying beside the road. The body is therefore two stops
  // down from the swatch: it is the LIT result that has to be mid grey, not the
  // albedo. Kept cool (blue ahead of red) so it never reads as weathered timber.
  // PRE-COMPENSATED FOR THE LIGHT RIG, and this is not optional.
  //
  // renderer.js lights an upward-facing face with a warm sun, a strongly blue
  // hemisphere, and a blue-tinted bounce fill at 1.85x; grade.js then lifts blue
  // again on the dark end. Measured off an actual frame, the transfer from
  // albedo to pixel on a horizontal face is (0.43, 0.49, 1.03) in linear — blue
  // gets two and a half times what red does. Grass survives that because it has
  // green to spare. A NEUTRAL grey does not: 0x8e979f, an unremarkable cool grey
  // in a swatch, rendered as rgb(98,109,160). Lilac. The only object in the
  // frame belonging to no palette at all, and the eye went straight to it.
  //
  // So this is not the colour of the guardrail. It is the colour that BECOMES
  // the guardrail — a dark cool grey, about rgb(86,94,106) on screen. To
  // re-derive it after any lighting change: sample the beam's top face in a
  // shot, divide the linear pixel by the linear albedo to get the transfer,
  // then divide the wanted pixel colour by that transfer.
  //
  // Two rounds of that solve, checked against the frame each time: 0x8e979f
  // gave rgb(98,109,160), 0x6e725c gave rgb(103,112,108) — right hue, but level
  // with the pale dust of the shoulder it stands on, so the barrier vanished
  // wherever it was not against grass. Down another eighth of a stop.
  const steel = new THREE.Color(0x64665b);
  const barrierCols = {
    post: timber.clone().multiplyScalar(0.94),
    // The cap is the giveaway from above: in the reference it is a bright
    // orange square sitting proud of the rails, one per bay.
    postTop: timber.clone().multiplyScalar(1.34),
    rail: timber,
    railTop: timber.clone().multiplyScalar(1.14),
    steel,
    steelDark: steel.clone().multiplyScalar(0.82),
    // The post HEAD has to be darker than the beam it stands in. Brighter and
    // every post turns into a bright dot; the row of dots then reads as
    // reflective markers and the beam between them disappears.
    steelTop: steel.clone().multiplyScalar(0.78),
    // The whole "slightly glinting" budget, spent on the one face the camera
    // actually sees. A third above the body is enough to separate the beam from
    // its own posts and from the shoulder it stands on; more and it is a wire.
    steelGlint: steel.clone().multiplyScalar(1.34),
    steelPost: steel.clone().multiplyScalar(0.70),
  };
  const barriers = buildBarriers(routes, terrain, seed ?? 1337, barrierCols,
    ctx.biome?.waterLevel ?? -Infinity);
  group.add(barriers.group);

  const mat = new THREE.MeshLambertMaterial({ flatShading: true });
  const dummy = new THREE.Object3D();
  const acc = palette.accents ?? [0xffffff];

  const instance = (geom, list, colourFor, cast = true) => {
    if (!list.length) return;
    const inst = new THREE.InstancedMesh(geom, mat, list.length);
    const cols = new Float32Array(list.length * 3);
    list.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, -p.r, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      const c = colourFor(i);
      cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
    });
    inst.instanceColor = new THREE.InstancedBufferAttribute(cols, 3);
    inst.castShadow = cast;
    inst.receiveShadow = false;
    inst.frustumCulled = false;
    group.add(inst);
  };

  const white = new THREE.Color(palette.roadEdge).lerp(new THREE.Color(0xffffff), 0.5);
  const red = new THREE.Color(acc[0]);
  const boardCol = new THREE.Color(acc[1] ?? acc[0]);
  instance(markerGeom(), posts, (i) => (i % 3 === 0 ? red : white));
  instance(kerbGeom(), kerbs, (i) => (i % 2 ? red : white), false);
  instance(boardGeom(), boards, () => boardCol);

  if (wall.count) {
    const m = new THREE.Mesh(wall.geometry(), new THREE.MeshLambertMaterial({
      vertexColors: true, flatShading: true, side: THREE.DoubleSide,
    }));
    m.castShadow = true;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.name = 'hairpin-walls';
    group.add(m);
  }

  return { group, colliders, barriers };
}

// ---------------------------------------------------------------------------
// Spatial index for the O(1) queries game.js makes every frame
// ---------------------------------------------------------------------------

class RoadIndex {
  constructor(cell = 26) {
    this.cell = cell;
    this.map = new Map();
    this.samples = [];
  }
  add(route) {
    for (let k = 0; k < route.samples.length; k++) {
      const sm = route.samples[k];
      // Remember which route this station belongs to and where in it, so
      // heightAt() can blend toward the next station along.
      sm._route = route;
      sm._k = k;
      const i = this.samples.length;
      this.samples.push(sm);
      const key = `${Math.floor(sm.x / this.cell)},${Math.floor(sm.z / this.cell)}`;
      let l = this.map.get(key);
      if (!l) this.map.set(key, (l = []));
      l.push(i);
    }
  }
  nearest(x, z) {
    const ci = Math.floor(x / this.cell), cj = Math.floor(z / this.cell);
    let best = null, bestD = Infinity;
    for (let u = -1; u <= 1; u++) {
      for (let v = -1; v <= 1; v++) {
        const l = this.map.get(`${ci + u},${cj + v}`);
        if (!l) continue;
        for (const i of l) {
          const sm = this.samples[i];
          const dx = x - sm.x, dz = z - sm.z;
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = sm; }
        }
      }
    }
    return best ? { sm: best, d: Math.sqrt(bestD) } : null;
  }
}

// ---------------------------------------------------------------------------
// Spurs — one or two short branches so the place reads as inhabited without
// turning the map into a web.
// ---------------------------------------------------------------------------

function buildSpur(ctx, main, rng, tStart) {
  const { terrain, biome } = ctx;
  const cost = makeCost(terrain, biome);
  const S = main.samples;
  const i0 = Math.floor(clamp(tStart, 0, 0.999) * S.length);
  const a = S[i0];
  if (a.wet) return null;
  const side = rng.sign();
  const len = rng.float(220, 420);
  const step = 12;
  let x = a.x, z = a.z;
  let dirx = side * a.nx, dirz = side * a.nz;
  const pts = [{ x, z }];
  for (let d = step; d < len; d += step) {
    const base = Math.atan2(dirz, dirx);
    let bestAng = base, bestC = Infinity;
    for (const da of [-0.34, -0.17, 0, 0.17, 0.34]) {
      const ang = base + da;
      const px = x + Math.cos(ang) * step * 2.4, pz = z + Math.sin(ang) * step * 2.4;
      const c = cost(px, pz) + Math.abs(da) * 16;
      if (c < bestC) { bestC = c; bestAng = ang; }
    }
    dirx = Math.cos(bestAng); dirz = Math.sin(bestAng);
    x += dirx * step; z += dirz * step;
    if (Math.max(Math.abs(x), Math.abs(z)) > biome.size * 0.5 - 120) break;
    if (terrain.heightAt(x, z) < biome.waterLevel + 1.5) break;
    // never let a branch wander back and cross its parent
    if (d > 90) {
      let near = Infinity;
      for (let q = 0; q < S.length; q += 2) {
        const dd = Math.hypot(S[q].x - x, S[q].z - z);
        if (dd < near) near = dd;
      }
      if (near < 34) break;
    }
    pts.push({ x, z });
  }
  if (pts.length < 7) return null;
  let p = resample(pts, 6, false);
  p = smoothOpen(p, 8, 0.32);
  p[0] = { x: a.x, z: a.z };
  p = resample(p, 3.0, false);
  // Start at the parent road's edge so the junction is a clean T, not a cross.
  const trim = a.hw + a.verge * 0.5;
  let cut = 0;
  while (cut < p.length - 8 && Math.hypot(p[cut].x - a.x, p[cut].z - a.z) < trim) cut++;
  return p.slice(cut);
}

// ---------------------------------------------------------------------------

export function createRoadNetwork(ctx) {
  const group = new THREE.Group();
  group.name = 'roads';

  const { terrain, biome, palette, seed } = ctx;
  const style = STYLE[biome.id] ?? STYLE.alpine;
  const rng = new Rng((Math.imul((seed ?? 1337) + 7, 2654435761) >>> 0));

  const mainPts = buildRoute(ctx, style, rng);
  const main = describe(ctx, mainPts, {
    closed: true,
    width: style.width,
    verge: style.verge,
    kinds: style.kinds,
    surfSeed: (seed ?? 1337) + 31,
    smoothSigma: 9,
    deckRise: 2.6,
  });

  const routes = [main];
  const spurRoutes = [];
  for (let i = 0; i < (style.spurs ?? 0); i++) {
    const sp = buildSpur(ctx, main, rng, rng.float(0, 1));
    if (!sp) continue;
    const desc = describe(ctx, sp, {
      closed: false,
      width: style.width * 0.70,
      verge: style.verge * 0.85,
      kinds: [style.kinds[1], style.kinds[1]],
      surfSeed: (seed ?? 1337) + 97 + i,
      smoothSigma: 8,
      deckRise: 2.2,
    });
    spurRoutes.push(desc);
    routes.push(desc);
  }

  // ---- colours ----
  //
  // Grass, for everything that has to disappear into the meadow. The ground
  // ramp runs dark-low to pale-high, so the middle of it is the colour of the
  // turf the road actually runs through.
  const ramp = palette.ground ?? [0x5faa3c];
  const grass = new THREE.Color(ramp[Math.min(ramp.length - 1, 2)]);
  // THE MISSING BLUE — AND THE UNIT BUG THAT TURNED IT INTO A GREY KERB.
  //
  // The intent is right: the reference's meadow greens measure 0x17 (23) of blue
  // and everything this module blends into the meadow needs it, or the fringe of
  // the road reads as khaki. The arithmetic was not. `grass.b` is a channel of a
  // THREE.Color built from a hex literal, so with colour management on it holds a
  // LINEAR value — 0x1a of sRGB blue is linear 0.0103 — and it was being compared
  // against, and then overwritten with, 23/255 = 0.0902 as if it were sRGB. Nine
  // times too much blue, injected into every colour that touches the turf.
  //
  // Measured consequence, scanned across the hero frame: the outermost apron
  // facet — the one whose whole job is to disappear into the meadow — rendered
  // rgb(111,127,92) at saturation 0.28, a metre-wide grey-olive band down both
  // sides of the road, against the terrain's own grass at rgb(76,100,15) and
  // 0.85. Three separate rounds of this file have chased that band by repainting
  // the shoulder, the cut face and the fill face. It was never any of them: it
  // was 0.09 of linear blue where 0.01 was meant.
  //
  // Expressed as a colour so the units cannot drift again: the floor IS the hex.
  const MIN_GRASS_B = new THREE.Color(0x000017).b;
  if (grass.b < MIN_GRASS_B) grass.b = MIN_GRASS_B;

  const colours = {};
  for (const k of new Set(style.kinds)) {
    const c = surfaceColour(palette, k);
    colours[k] = c;
    // A rut is the same earth, damper and packed hard: darker, a touch cooler.
    // Not much darker, though — push it far and two crisp bands read as painted
    // lane markings, which is the opposite of what they are for.
    // ART_DIRECTION §3 calls the ruts "highly visible and essential". Against
    // the target's two near-black bands ours were a suggestion; 0.66 is dark
    // enough to read from 200 m up and still short of the painted-lane-marking
    // look that a harder push produces.
    // ...WHICH IS NOW THE BRAID'S JOB, NOT THE BAND'S. A 1.3 m band at 0.66 of
    // the surface tone is 34% down over eighteen pixels of screen: from 200 m up
    // that is not a rut, it is a soft dark stripe, and the client's note that
    // the road "looks like nothing in particular" is partly about exactly this —
    // the reference's ruts are 0.4-0.7 m lines with crisp edges, eight or nine
    // of them braided across the carriageway, and no band anywhere is uniformly
    // a third darker than its neighbour. So the bands now carry only a whisper
    // of tone and `braid` draws the lines. The two deepest braid lines sit on
    // the two GEOMETRIC ruts (RUT_U), so the line and the light-catching dip
    // still agree about where the wheels went.
    colours[`${k}:rut`] = c.clone().multiplyScalar(0.93).lerp(new THREE.Color(palette.rockShadow), 0.05);
    colours[`${k}:rutSoft`] = c.clone().multiplyScalar(0.97);
    // The strip between the ruts nobody drives on: lighter, slightly greened.
    colours[`${k}:centre`] = c.clone().lerp(grass, 0.07).multiplyScalar(1.02);
    // Thrown grit and dust piles up at the edges — the palest part of the road.
    // ...but not by much. The carriageway edge is ALSO the part the crown tilts
    // most steeply toward the sun, so it arrives brighter than the middle before
    // any colour is added: measured rgb(214,151,80) against the interior's
    // rgb(176,133,62), a 21% cream rim following both sides of the road, which
    // target_01 does not have anywhere.
    colours[`${k}:edge`] = c.clone().lerp(new THREE.Color(palette.roadEdge), 0.06).multiplyScalar(0.95);
  }
  const base = colours[style.kinds[0]];
  /**
   * THE EDGE RAMP HAS TO GO THROUGH DARK, NOT THROUGH PALE.
   *
   * Every previous attempt at this shoulder was a straight lerp between the road
   * and the meadow, and every one of them came out GREY: ochre and green are
   * near enough complementary that a half-and-half mix has no saturation left,
   * and at 0.55 grass it rendered a pale grey ring (the client's "kerb"), while
   * at 0.78 grass — the fix for that — it rendered a cold grey-olive apron two
   * or three metres wide down both sides of the carriageway. Measured on the
   * lake_bridge frame it was the most conspicuous thing about our road after the
   * flat tone: a concrete kerb on a dirt rally stage.
   *
   * In target_01 the sequence from carriageway to meadow is dust, then DARKER
   * dust, then a dark line where the turf takes hold, then grass — it darkens
   * across the transition and never desaturates. So every mix here multiplies
   * DOWN as it moves toward the turf, and the road's own texture (grit, wear,
   * the grass creep noise in buildRibbonMesh) carries the rest.
   */
  //
  // AND IT HAS TO OVER-CORRECT, because the skirt is not lit like the road.
  // Measured on the lake_bridge frame, the apron rendered rgb(159,135,93) at
  // saturation 0.41 beside a carriageway at rgb(176,133,62) and 0.66 — nearly
  // the same luminance, half the saturation, and 50% more blue. The extra blue
  // is not in the material: the skirt facets slope down and away from the sun,
  // so they are lit mostly by the sky term, which is cold. A colour that has to
  // survive being lit by the sky has to start warmer and darker than the tone
  // it is trying to look like.
  // ...and the material follows the geometry: no grass in it at all. The 10% of
  // turf that used to be mixed in here was the other half of the grey — ochre
  // and green are near enough complementary that even a tenth of it costs real
  // chroma, and the shoulder has the road's own grass-creep noise outside it to
  // do the greening where the turf has actually taken hold.
  colours.shoulder = base.clone().multiplyScalar(0.90);
  /**
   * THE FACET THAT HAS TO BE THE MEADOW. It lies flat ON the terrain at the toe
   * of the batter, so if it does not render as the turf beside it the road ends
   * on a visible line — which is the whole complaint this apron exists to answer.
   *
   * It is matched by SCANLINE, not by swatch, because the grade's saturation
   * expansion is not per-channel: measured, the same material blue of 0.013 in
   * the working space came out as 2 of 255 while 0.090 came out as 92. A channel
   * below the pixel's own luminance gets pushed toward zero and one near it
   * survives, so "the swatch has some blue in it" says nothing about whether the
   * frame will. The two numbers that matter are what the terrain's grass renders
   * beside this facet, rgb(76,100,15) at saturation 0.85, and what this facet
   * rendered before the match: rgb(130,147,0) at 1.00 — half a stop too bright,
   * and acid because the last of its blue had been squeezed out.
   */
  colours.blend = grass.clone().multiplyScalar(0.55).lerp(base, 0.06);
  colours.blend.b = Math.max(colours.blend.b, new THREE.Color(0x000022).b);
  // A CUT FACE IS EARTH, NOT ROCK. `palette.rock` is 0x7d7268 — a cold grey —
  // and at 0.45 of the road tone it rendered rgb(157,136,100): a pale grey-tan
  // apron two or three metres wide following the inside of every corner where
  // the road is benched into the hill. Read at 8x against target_01 that is the
  // single largest silhouette difference left at the road's edge; the reference
  // has bare warm earth there and nothing grey anywhere near a road. So the cut
  // face is now the road's own dust, damp and a shade darker, with a little of
  // the trunk brown in it for the raw-soil cast.
  colours.cut = skyLit(base.clone().multiplyScalar(0.92)).lerp(new THREE.Color(palette.trunk), 0.18);
  // A fill embankment is half grassed over — but it is grassed over DAMP EARTH,
  // so it darkens toward the turf rather than washing out into it.
  colours.fill = skyLit(base.clone().multiplyScalar(0.72)).lerp(grass, 0.12);

  // ---- meshes ----
  const ribbons = [buildRibbonMesh(ctx, main, colours, 'road-main')];
  for (const sp of spurRoutes) ribbons.push(buildRibbonMesh(ctx, sp, colours, 'road-spur'));
  for (const r of ribbons) group.add(r);
  const furniture = buildFurniture(ctx, routes, colours);
  group.add(furniture.group);

  // ---- queries ----
  // THE INDEX HAS TO BE ABLE TO REACH THE TOE OF THE EARTHWORKS.
  //
  // `nearest` scans the 3x3 block of cells around the query point, so it is only
  // GUARANTEED to find a station within one cell width. At 26 m that was fine
  // for a query that gave up at hw + verge (~7 m); now that the answer covers
  // the batter — which marches up to APRON_MAX past the verge — a point 30 m out
  // would have found the station in some cells and not in others, which is the
  // same "sometimes road, sometimes terrain" flicker in a new place. Size the
  // cell from the profiles that were actually built.
  let reachMax = 0;
  for (const r of routes) {
    for (const sm of r.samples) {
      const P = sm._prof;
      if (P) reachMax = Math.max(reachMax, -P.u[0], P.u[P.u.length - 1]);
    }
  }
  const index = new RoadIndex(Math.max(26, Math.ceil(reachMax + 3)));
  for (const r of routes) index.add(r);

  const isOnRoad = (x, z) => {
    const h = index.nearest(x, z);
    return !!h && h.d <= h.sm.hw + 0.6;
  };
  const gripAt = (x, z) => {
    const h = index.nearest(x, z);
    if (!h || h.d > h.sm.hw + h.sm.verge) return 1.0;
    const g = GRIP[h.sm.surf] ?? 0.9;
    return h.d > h.sm.hw ? g * 0.86 : g;
  };
  const isBlocked = (x, z) => {
    const h = index.nearest(x, z);
    return !!h && h.d <= h.sm.hw + h.sm.verge + 6.0;
  };
  /**
   * THE HEIGHT OF THE ROAD, MEANING THE HEIGHT OF THE TRIANGLES.
   *
   * Two things changed here and they are the whole of this round's road fix.
   *
   * 1. It reads the emitted cross-section (`drawnSection`, fed by the row and
   *    apron caches the mesh builder writes) instead of `sectionY`. `sectionY`
   *    is the DESIGN plane; the built ribbon is `drapeY` of it, which lifts a
   *    vertex above the ground rather than let the terrain spear the road, by up
   *    to a couple of metres. The query knew nothing about that lift, so the
   *    physics put the wheel on the design plane and the player watched it sink
   *    into the gravel: mean 0.125 m, p95 0.415 m, max 0.674 m over the road.
   *
   * 2. It answers over the WHOLE drawn footprint, not just `hw + verge`. Past
   *    that it used to return null, the physics fell through to the terrain, and
   *    the surface still being DRAWN there was the road's own shoulder and
   *    batter — up to nine metres of it above the ground it was standing on.
   *    Binned by lateral offset, u = ±8..9 was the worst place in the world to
   *    put a wheel: 0.41-0.55 m mean sink, 8.9 m worst, and 76-84% of samples
   *    with the physics on a different surface from the renderer. That band is
   *    the outside edge of the carriageway — where a rally driver spends the
   *    corner — which is why this reads to the player as "the car falls through
   *    the edge of the road".
   *
   * Null now means one thing only: roads.js draws nothing here, so ask the
   * terrain.
   */
  const heightAt = (x, z) => {
    const h = index.nearest(x, z);
    if (!h) return null;
    const a = h.sm;
    const ua = (x - a.x) * a.nx + (z - a.z) * a.nz;

    // Longitudinal position between this station and the next one along. The
    // ribbon is a quad strip, so between two stations the surface — and its
    // outer edge — are linear in exactly this parameter.
    const route = a._route;
    let b = null, t = 0;
    if (route && a._k !== undefined) {
      const arr = route.samples;
      t = ((x - a.x) * a.tx + (z - a.z) * a.tz) / (route.ds || 3);   // -0.5..0.5 typically
      const j = a._k + (t >= 0 ? 1 : -1);
      b = (j >= 0 && j < arr.length) ? arr[j]
        : (route.closed ? arr[((j % arr.length) + arr.length) % arr.length] : null);
    }

    const okA = drawnSection(a, ua, _secA);
    if (!b) return okA ? _secA.y : null;
    const ub = (x - b.x) * b.nx + (z - b.z) * b.nz;
    const okB = drawnSection(b, ub, _secB);
    if (!okA && !okB) return null;

    const w = Math.min(1, Math.abs(t));
    // The toe of the earthworks wanders by a metre or two from station to
    // station, so the footprint boundary is interpolated along the quad exactly
    // as the height is. Testing it against either station alone puts a step in
    // the answer where the mesh has a sliver.
    const reach = _secA.reach * (1 - w) + _secB.reach * w;
    if (Math.abs(ua) * (1 - w) + Math.abs(ub) * w > reach) return null;
    const y = _secA.y * (1 - w) + _secB.y * w;

    // ...AND THE ANSWER IS THE TOPMOST DRAWN SURFACE, NOT THE RIBBON'S OWN
    // VERTEX.
    //
    // In a cutting the lip clamp deliberately lets the hillside win the last of
    // the carriageway edge — "a ragged green tongue biting into the ochre", which
    // is what an unsurfaced road's boundary does — and the shoulder is capped at
    // 1:2 rather than hoisted to meet the cut face. Both are correct as pictures
    // and both mean the terrain triangle, not the ribbon, is the thing a wheel
    // would touch. Measured: 31 of 2400 contact patches had the drawn terrain
    // standing over the ribbon, by 1.27 m on average and 2.15 m at (-90, 285),
    // and every one of them was a place the car fell through the road into the
    // hill. `auditSlopes` has always profiled the road as the higher of the two;
    // now the query does too, and for the same reason.
    const g = groundY(terrain, x, z);
    return g > y ? g : y;
  };

  /**
   * Outermost lateral offset at which roads.js still draws a surface, at the
   * station nearest (x, z). bridges.js asked for this by name: its deck is wider
   * than the carriageway and it needs to know where the road's own surface stops
   * rather than guessing a half width.
   *
   * Signed input, unsigned answer, taken on the side the point is on — the two
   * sides of a station rarely reach the same distance. Exactly on the centre
   * line it returns the SMALLER of the two, which is the only width that is
   * covered on both sides.
   */
  const outerEdgeAt = (x, z) => {
    const h = index.nearest(x, z);
    const P = h && h.sm._prof;
    if (!P) return null;
    const n = P.u.length;
    const u = (x - h.sm.x) * h.sm.nx + (z - h.sm.z) * h.sm.nz;
    if (u > 0) return P.u[n - 1];
    if (u < 0) return -P.u[0];
    return Math.min(-P.u[0], P.u[n - 1]);
  };
  const surfaceAt = (x, z) => {
    const h = index.nearest(x, z);
    if (!h || h.d > h.sm.hw + h.sm.verge) return null;
    return { kind: h.sm.surf, grip: GRIP[h.sm.surf] ?? 0.9 };
  };

  const S = main.samples;
  const sample = (t) => {
    const n = S.length;
    const i = ((Math.floor(t * n) % n) + n) % n;
    const sm = S[i];
    return { x: sm.x, z: sm.z, heading: Math.atan2(-sm.tz, sm.tx) };
  };

  /**
   * Point `metres` further along the main route from whatever point is closest
   * to (x, z). Used by the capture autopilot so screenshots keep the car on the
   * road, and available to anything else that wants to follow the racing line.
   *
   * Search is windowed around the last hit, so repeated calls while driving are
   * O(window) rather than O(route).
   */
  let _lastIdx = 0;
  const lookAhead = (x, z, metres = 30) => {
    const n = S.length;
    if (!n) return null;
    const scan = (from, to) => {
      let bi = -1, bd = Infinity;
      for (let k = from; k < to; k++) {
        const i = ((k % n) + n) % n;
        const dx = x - S[i].x, dz = z - S[i].z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; bi = i; }
      }
      return { bi, bd };
    };
    // Try a local window first; fall back to a full scan if we have strayed.
    const W = 90;
    let { bi, bd } = scan(_lastIdx - W, _lastIdx + W);
    if (bd > 140 * 140) ({ bi, bd } = scan(0, n));
    _lastIdx = bi;

    const a = S[bi];
    const off = Math.sqrt(bd);

    // RECOVERY. The lead is how far along the route the follower aims; on the
    // road, long is smooth. Once the car has run wide, a long lead points at a
    // spot it can already reach without ever coming back — the follower tracks
    // the road happily from fifty metres out in the rough and the shot has no
    // road in it. Shortening the lead in proportion to how far off we are turns
    // the target back into "get on the road", and it costs nothing while on it.
    const slack = Math.max(0, off - a.hw * 0.5);
    const m = Math.max(6, metres * clamp(1 - slack / 26, 0.20, 1));

    const step = Math.max(1, Math.round(m / Math.max(0.5, main.ds)));
    const t = S[(bi + step) % n];
    return {
      x: t.x, z: t.z,
      heading: Math.atan2(-t.tz, t.tx),
      dist: off,
      onRoad: off <= a.hw + a.verge,
      surf: a.surf,
    };
  };

  /**
   * Where the postcard is taken.
   *
   * The old rule was "start 135 m before the TIGHTEST corner on the circuit".
   * Two things were wrong with it. A capture runs at full throttle, so the
   * tightest corner on the map is precisely the one the autopilot cannot hold —
   * the car left the road at t≈5 s and spent the hero frame in the scree. And
   * nothing in the score cared about ALTITUDE, so the shot happened wherever
   * the tightest corner was, pale bank included.
   *
   * The rule NOW, measured rather than guessed (tools/route_probe.mjs reports
   * the radius under the car and the turning inside the frame at the preset's
   * settle time):
   *
   *   · the shutter opens ~230 m along the route, so score the road AROUND
   *     THERE, not around the start;
   *   · the car must be MID-CORNER — radius under it in the 50-120 m band. A
   *     460 m radius is a straight line at this camera height and that is
   *     exactly what the last round shipped;
   *   · the ±115 m of route the camera can see has to turn ~2.6 rad, and
   *     ideally CHANGE DIRECTION inside the frame, which is the S the client
   *     reference is built on;
   *   · only the first 130 m has to be gentle — that is the run-up the car
   *     needs to get on the road and up to speed. After that a corner is not a
   *     hazard, it is the photograph.
   */
  let _spawnIdx = -1;
  let _spawnDiag = null;
  const spawn = () => {
    const n = S.length;
    const half = biome.size * 0.5;
    // A 9 s capture from a standstill covers ~230-270 m at rally pace; a run
    // with a real corner in it scrubs speed, so the shutter lands nearer 230.
    const runN = Math.max(8, Math.round(400 / main.ds));
    // Where the shutter opens, in metres along the route.
    //
    // This is the single most load-bearing number in the whole scorer and it
    // was wrong. The old value — 272 m at the hero's 9 s settle — came from one
    // trace on a route with far fewer corners in it. tools/route_probe.mjs now
    // reports the car's station directly, and on the current routes it is:
    //
    //     lake_bridge   7 s -> 155 m      hero_alpine  9 s -> 221 m
    //     wildlife     10 s -> 237 m  (throttle 0.8)
    //
    // Scoring the hero at 272 m is scoring a piece of road fifty metres past
    // the one that ends up in the picture, which is exactly how a spawn with a
    // measured 7.6 m sagitta photographed at 1.4 m — a straight line.
    //
    // So the stations are DERIVED from the fitted v(d) below rather than
    // hard-coded, and each one is scored across a tolerance band: the tape's
    // handbrake flick and each world's own corners move the settle point by
    // tens of metres, and a spawn scored at a single station is a spawn scored
    // at the wrong one.
    const SETTLE = [{ t: 7.0, w: 0.22 }, { t: 9.0, w: 0.56 }, { t: 10.0, w: 0.22 }];
    // The green band of the ground ramp. Anything much above this is the pale
    // upper alp, and the frame loses its saturation.
    const GREEN = 34;

    // WHAT THE CAR CAN ACTUALLY HOLD.
    //
    // The capture autopilot never lifts, so the car's speed is a function of one
    // thing: how far it has run. Fitted to tools/route_trace.mjs on a clean run
    // (d/v pairs 6/11.3, 12/16.0, 21/20.5, 45/28.2, 150/35.8, 273/41):
    //
    //     v(d) = V·tanh( sqrt(2·A₀·d) / V )
    //
    // — constant-power-ish. REFITTED this round against tools/route_probe.mjs,
    // which reads the car's station off the live scene at settle time instead
    // of off a hand-taken trace: A₀ = 10.6 predicted 184/261/301 m at the three
    // settle times against a measured 155/221/237, a 20-27% overshoot, and
    // every one of those metres came out of the composition. A₀ = 7.5 predicts
    // 152/223/261, which is inside the noise for the two presets that run flat
    // out and long only for wildlife, whose tape holds 0.8 throttle.
    const A0 = 7.5, V_MAX = 42;
    const vAt = (metres) =>
      V_MAX * Math.tanh(Math.sqrt(2 * A0 * Math.max(1, metres)) / V_MAX);
    /** Distance covered from a standstill after `t` seconds of that model. */
    const dAt = (t) => {
      let d = 0;
      for (let s = 0; s < t; s += 0.02) d += vAt(d) * 0.02;
      return d;
    };
    // Each settle time, spread over a ±16% tolerance band so the winning spawn
    // is one whose road photographs well over a STRETCH rather than at a point.
    const SHUTTERS = [];
    for (const { t, w } of SETTLE) {
      const m = dAt(t);
      // ±8%. The band existed because the old speed model was 20-27% long; with
      // v(d) refitted it lands within 3% of the measured station, so a wide
      // band now only blurs the score across road the camera never sees.
      for (const [f, fw] of [[0.92, 0.25], [1.0, 0.50], [1.08, 0.25]]) {
        SHUTTERS.push({ m: m * f, w: w * fw });
      }
    }
    // Every capture tape does its scripted handbrake flick in the opening
    // seconds — the hero preset's runs from 4.4 s to 5.2 s, which lands between
    // roughly 50 m and 130 m along the route. With the rear axle let go there is
    // no cornering force to be had, so that stretch has to be much more open
    // than grip alone would demand or the car spears off and never comes back.
    const flick = (d) => (d > 45 && d < 140 ? 1.9 : 1);

    // THE SHAPE THAT ENDS UP IN THE PICTURE.
    //
    // Scoring curvature over the whole run does not work: a stretch can bank up
    // a perfectly respectable 1.6 rad of turning two hundred metres behind the
    // car and still be ruler-straight in the frame.
    //
    // And the frame is NOT centred on the car, NOR is it anything like as big as
    // it feels. MEASURED, by projecting route stations through the actual
    // capture camera (tools/route_probe.mjs reports `window`): at the hero
    // preset's settle time the road is on screen from 21 m BEHIND the car to
    // 45 m in front of it. Sixty-six metres. That is the entire picture.
    //
    // Every earlier version of this scoring reasoned about 140-260 m windows
    // and kept choosing beautiful hairpins that were off the top of the frame
    // while the car sat on a 300 m sweeper photographing as a ruled line.
    // Nothing outside ±30 m of the car exists as far as the composition goes.
    //
    // RE-MEASURED. The old 66 m window starting 21 m behind the car was taken
    // from one preset on one route. Projecting every station through the three
    // alpine capture cameras now gives, in metres behind/ahead of the car:
    //
    //     hero_alpine [-33, +27]   lake_bridge [-36, +57]   wildlife [-24, +21]
    //
    // The old window therefore ran 27 m PAST the right-hand edge of the hero
    // frame, and that overhang is where its 11.6 m of sagitta was hiding: the
    // corner it scored was off the side of the picture, and the road that was
    // actually in shot bowed 2.7 m. The window is now the intersection of all
    // three — the road every alpine preset can see — so a corner that scores
    // here is a corner that is in the photograph.
    const frameN = Math.max(4, Math.round(48 / main.ds));
    const frameBack = Math.round(24 / main.ds);
    // How far the road should bow away from the straight line across the frame.
    // Over a 48 m chord, 7 m of sagitta is an arc of about 41 m radius, which
    // is the sweep target_01 draws through the middle of its frame. (Sagitta
    // scales with the SQUARE of the chord, so the old 12 m over 66 m is 6.3 m
    // over 48 m — this is the same corner, restated for the real window.)
    const SAG_WANT = 7.0;
    const SAG_MIN = 2.5;
    // The hero settle station, in samples — the one the diagnostics quote and
    // the one `departure` integrates out to. Derived, like the shutters, from
    // the fitted v(d) instead of a hard-coded 272.
    const endN = Math.max(4, Math.round(dAt(9.0) / main.ds));
    // The middle of the visible road ahead of the car.
    const aimN = endN + Math.round(22 / main.ds);
    // THE CORNER ITSELF. The car cannot sit at the apex of a 45 m radius at
    // 41 m/s — but it does not have to. The visible road only reaches 21 m
    // behind it, so the corner may START at the shutter: twenty metres of
    // unmet lateral demand is under two metres of slide, and the picture is
    // a car turning in with the corner wrapping away in front of it.
    const CAR_LO = 40, CAR_HI = 300;
    const AIM_LO = 32, AIM_HI = 80;

    // How much OTHER road there is within 70 m of a station — the "two legs of
    // the same road in one frame" the reference is built on. Memoised per
    // station: the shutter band is nine photographs now, and recomputing an
    // O(n) neighbour count inside each of them turned the spawn search from
    // half a million operations into four million.
    const _dens = new Int32Array(n).fill(-1);
    const density = (i) => {
      if (_dens[i] >= 0) return _dens[i];
      const x = S[i].x, z = S[i].z;
      let c = 0;
      for (let k = 0; k < n; k += 3) {
        if (Math.hypot(S[k].x - x, S[k].z - z) < 70) c++;
      }
      return (_dens[i] = c);
    };

    /**
     * HOW BENT IS THE ROAD IN THE PICTURE — measured the way the eye measures
     * it, as the distance the ribbon departs from the straight line joining the
     * two ends of the visible window. This replaces integrated |curvature|,
     * which is a bad proxy twice over: it cannot tell an S from an arc (both
     * score high, only one is bent away from its chord), and it is dominated by
     * sampling noise. A window scoring 2.09 rad of "turning" photographed as a
     * ruler-straight road; its sagitta was four metres.
     *
     * Returns { sag, ess } — the largest departure in metres, and the largest
     * departure on the OTHER side, which is what makes an S an S.
     */
    const bendOf = (w0) => {
      const a = S[(((w0 % n) + n) % n)];
      const b = S[(((w0 + frameN) % n) + n) % n];
      let ex = b.x - a.x, ez = b.z - a.z;
      const l = Math.hypot(ex, ez) || 1;
      ex /= l; ez /= l;
      let lo = 0, hi = 0;
      for (let k = 1; k < frameN; k++) {
        const p = S[(((w0 + k) % n) + n) % n];
        // signed perpendicular offset from the chord
        const d = (p.x - a.x) * ez - (p.z - a.z) * ex;
        if (d > hi) hi = d;
        if (d < lo) lo = d;
      }
      return { sag: Math.max(hi, -lo), ess: Math.min(hi, -lo) };
    };

    // --- how green is the ground, really? -----------------------------------
    // Height is only a proxy: the meadow also carries gold-green sun-baked
    // patches and grey limestone outcrops, and a frame that lands on those is
    // just as washed out as one up on the scree. If the terrain will tell us
    // what colour it painted a point, ask it; otherwise fall back to height.
    const swatch = (() => { try { return terrain._swatches?.(); } catch { return null; } })();
    const _gc = new THREE.Color();
    const verdant = (x, z, h) => {
      if (!swatch || typeof biome.colorAt !== 'function') return null;
      try {
        _gc.setRGB(1, 1, 1);
        biome.colorAt(_gc, swatch, h, terrainSlope(terrain, x, z, 6), x, z, seed ?? 0);
      } catch { return null; }
      // green channel clearly ahead of the other two = saturated meadow
      return clamp((_gc.g - Math.max(_gc.r, _gc.b) * 0.93) * 5, 0, 1);
    };

    // Two smoothings of curvature, because two different things read it.
    //
    //  · smoothK (40 m) is what the EYE reads from 200 m up: one noisy station
    //    is not a corner, and the apex test has to agree with the photograph.
    //  · driveK (12 m) is what the CAR reads. A 28 m radius kink thirty metres
    //    long is invisible to the 40 m filter and threw the car eighteen metres
    //    into the meadow — every departure traced last cycle was one of these.
    const blurK = (metres) => {
      const out = new Float64Array(n);
      const r = Math.max(1, Math.round(metres / 2 / main.ds));
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let d = -r; d <= r; d++) s += S[(((i + d) % n) + n) % n].k;
        out[i] = s / (2 * r + 1);
      }
      return out;
    };
    const smoothK = blurK(40);
    const driveK = blurK(12);

    // Prefix sums so a 360 m window costs O(1) instead of O(runN) per candidate.
    const P = (n + 1);
    const cumH = new Float64Array(P), cumG = new Float64Array(P);
    const cumK = new Float64Array(P), cumS = new Float64Array(P);
    let anyGreen = false;
    for (let i = 0; i < n; i++) {
      const q = S[i];
      const g = verdant(q.x, q.z, q.yT);
      if (g !== null) anyGreen = true;
      cumH[i + 1] = cumH[i] + q.yT;
      cumG[i + 1] = cumG[i] + (g ?? 0);
      // SMOOTHED, not raw. Raw curvature at 3 m stations carries ±0.005 of
      // sampling noise, and |k| summed over a 140 m window turns that into 0.7
      // rad of pure noise — more than a third of the turning the window is
      // supposed to be measuring. Every "shape" score computed from raw k was
      // reading dither, which is how a ruler-straight road scored 1.87 rad.
      cumK[i + 1] = cumK[i] + Math.abs(smoothK[i]) * main.ds;
      cumS[i + 1] = cumS[i] + smoothK[i] * main.ds;   // SIGNED: catches the S
    }
    const win = (cum, j, len) => {
      const a = ((j % n) + n) % n;
      return a + len <= n ? cum[a + len] - cum[a] : cum[n] - cum[a] + cum[(a + len) % n];
    };
    /**
     * WILL THE CAR STILL BE ON THE ROAD WHEN THE SHUTTER OPENS?
     *
     * One state variable — y, how far the car is from the centreline — and one
     * equation:
     *
     *     y'' = clamp( v²κ + correction , ±grip ) − v²κ
     *
     * Following the road at all costs v²κ of the tyres' budget. The autopilot's
     * correction gets whatever is LEFT, and in a corner the car cannot hold
     * there is nothing left: the term clamps, the two v²κ do not cancel, and the
     * car runs wide at a constant rate for as long as the corner lasts. That
     * saturation is the whole point. The first version of this used an
     * unsaturated spring-damper, which pinned any excursion to unmet/K_P — it
     * predicted 3.4 m for a run that tools/route_trace.mjs measured at 33 m,
     * and cheerfully sent the car into a field every time.
     *
     * Returns the worst departure, in metres, over the run up to the shutter.
     */
    // CALIBRATION. The model is the right SHAPE — it ranks candidates correctly
    // — but it is optimistic in magnitude, because it knows nothing about the
    // autopilot's reaction lag, the scripted flick, or weight transfer. Against
    // tools/route_probe.mjs, which reads the car's actual distance from the
    // centreline out of the live scene at settle time:
    //
    //     hero_alpine  model 1.1 m -> measured 5.9 m
    //     wildlife     model 2.3 m -> measured 8.3 m
    //
    // Consistently a factor of 3-5, so the prediction is scaled before it is
    // judged. Without this the gate waves through spawns that put the car in a
    // field with the road behind it — which is exactly what wildlife shipped.
    const A_GRIP = 6.4, K_P = 1.2, K_D = 2.2, DEP_CAL = 3.4;
    const departure = (j) => {
      let y = 0, dy = 0, peak = 0;
      for (let k = 0; k <= endN; k++) {
        const i = (j + k) % n;
        const d = k * main.ds;
        const v = vAt(d);
        const dt = main.ds / Math.max(v, 4);
        // With the rear axle let go there is no cornering force to be had.
        const grip = A_GRIP / flick(d);
        const track = v * v * driveK[i];               // to stay on the line
        const corr = -(K_P * y + K_D * dy);            // to get back to it
        dy += (clamp(track + corr, -grip, grip) - track) * dt;
        y += dy * dt;
        const a = Math.abs(y);
        if (a > peak) peak = a;
      }
      return peak * DEP_CAL;
    };

    /**
     * Everything about the photograph taken `shutter` metres along the route.
     * Split out of the candidate loop because there is more than one
     * photograph: the alpine capture presets settle at 7 s, 9 s and 10 s and
     * all three use this one spawn point.
     */
    const band = (r, lo, hi, fall) => (r < lo ? clamp(r / lo, 0, 1)
      : r <= hi ? 1 : clamp(1 - (r - hi) / fall, 0, 1));
    const frameScore = (j, shutter) => {
      const eN = Math.max(4, Math.round(shutter / main.ds));
      const aN = eN + Math.round(22 / main.ds);
      const w0 = j + eN - frameBack;
      const bend = bendOf(w0);
      const car = S[(j + eN) % n];

      // The composition: a road that curves and folds back through the frame,
      // not a straight line vanishing off one edge. Over the 66 m of ribbon
      // the camera can actually see, 12 m of sagitta is a corner that fills
      // the picture; the frame we shipped last round measured 3.6 m.
      const shape = clamp((bend.sag - SAG_MIN) / (SAG_WANT - SAG_MIN), 0, 1)
        * clamp(1 - Math.max(0, bend.sag - SAG_WANT * 1.7) / 26, 0, 1);

      // THE HERO CORNER, AND THE TURN-IN. What works is a corner that CLOSES UP
      // in front of the car. The car cannot be at the apex of anything tight —
      // at 41 m/s a 100 m radius asks for 17 m/s² and the tyres have 8 — but it
      // can be at the TURN-IN: the road ahead tightening out of a fast approach,
      // the car just starting to slide, everything still on the road. Measured:
      // a radius closing from 224 m to 82 m across the shutter put the car 2.8 m
      // off the centreline; one already at 69 m put it 6.7 m past the edge.
      const rCar = 1 / Math.max(Math.abs(smoothK[(j + eN) % n]), 1e-6);
      const rAim = 1 / Math.max(Math.abs(smoothK[(j + aN) % n]), 1e-6);
      const turnIn = clamp((rCar / Math.max(rAim, 1) - 1.3) / 1.7, 0, 1);
      const apex = band(rAim, AIM_LO, AIM_HI, 110) * 0.60
        + band(rCar, CAR_LO, CAR_HI, 260) * 0.15
        + turnIn * 0.25;

      // A CHANGE OF DIRECTION INSIDE THE FRAME. If the ribbon leaves its chord
      // on BOTH sides it draws an S across the image instead of one arc.
      const ess = clamp(bend.ess / 3.5, 0, 1);

      // THE ROAD FOLDING BACK THROUGH THE FRAME. The reference's top-left is two
      // legs of the same road sixty metres apart with a wall of conifers between
      // them; that is what fills a picture with route. `density` counts every
      // third station within 70 m, so each count is 9 m of road: ~140 m is the
      // car's own stretch and anything past that is a SECOND piece of road.
      const fold = clamp((density((j + eN) % n) * 9 - 140) / 160, 0, 1);

      // A timber bridge over blue water is the hero landmark of half the client
      // references — but only if it is in the photograph, not in the run-up.
      let deck = 0;
      for (let k = -frameBack; k < frameN - frameBack; k++) {
        if (S[(((j + eN + k) % n) + n) % n].wet) deck++;
      }
      const span = clamp((deck * main.ds) / 26, 0, 1)
        * (1 - clamp((deck * main.ds) / 200, 0, 1));

      // Reweighted now that the window is honest. `shape` is the only term that
      // has been checked against the photograph — a spawn scoring 7.8 on it
      // measured 11.6 m of sagitta in the captured frame — so it leads. `fold`
      // is raised because the reference puts 35% of its pixels on road against
      // our 26%, and the only way to get there at this camera height is a
      // second leg of the same road inside the frame.
      return shape * 175 + apex * 135 + ess * 90 + fold * 120 + span * 130;
    };

    let best = -1, bestScore = -Infinity, pool = 0;
    for (let j = 0; j < n; j++) {
      const st = S[j];
      if (st.wet || st.yT < biome.waterLevel + 3) continue;

      let hMax = -Infinity, wet = 0;
      for (let k = 0; k < runN; k += 2) {
        const q = S[(j + k) % n];
        // A bridge in the run is not a disqualification — it is the hero
        // landmark of half the client references.
        if (q.wet) wet++;
        else if (q.yT > hMax) hMax = q.yT;
      }
      if (hMax === -Infinity) continue;

      // The car has to be ON THE ROAD in the photograph. Half the carriageway
      // is 7.5 m, so 5 m of departure is a car sitting on the outside line with
      // its outer wheels in the dust — the rally pose — and 10 m is a car in a
      // field with the road behind it. Scored rather than gated, so that a
      // route on which nothing is perfectly clean still lands on its best
      // stretch instead of falling through to sample zero.
      const dep = departure(j);
      const hold = clamp(1 - Math.max(0, dep - 2.5) / 5.0, 0, 1);
      if (hold <= 0) continue;

      const hAvg = win(cumH, j, runN) / runN;
      const byHeight = clamp(1 - Math.max(0, hAvg - GREEN) / 30, 0, 1)
        * clamp(1 - Math.max(0, hMax - GREEN * 1.7) / 45, 0, 1);
      const green = anyGreen
        ? byHeight * 0.35 + (win(cumG, j, runN) / runN) * 0.65
        : byHeight;
      if (green <= 0) continue;

      const end = S[(j + endN) % n];
      const rim = Math.max(Math.abs(end.x), Math.abs(end.z)) / half;
      const open = 1 - clamp(terrainSlope(terrain, end.x, end.z, 22) * 2.4, 0, 1);

      // A little water crossing in the run is a bonus; a long causeway is not.
      const bridge = clamp(wet / 12, 0, 1) * (1 - clamp(wet / 60, 0, 1));

      // THE PICTURE, at every settle time the capture presets use. The alpine
      // presets open the shutter at 7 s, 9 s and 10 s, which is 190 m, 272 m
      // and 310 m along the route — three quite different photographs from one
      // spawn point. Scoring only the 9 s frame is what left lake_bridge (7 s)
      // looking at a diagonal stripe while the hero frame got its hairpin.
      const comp = SHUTTERS.reduce((acc, sh) => acc + sh.w * frameScore(j, sh.m), 0);

      // `hold` multiplies rather than adds: a beautiful corner the car cannot
      // stay on is not a photograph of a corner, it is a photograph of a field.
      const score = hold * (green * 100 + comp + open * 10 + bridge * 45)
        - Math.max(0, rim - 0.62) * 40;
      pool++;
      if (score > bestScore) { bestScore = score; best = j; }
    }
    if (best < 0) {
      for (let i = 0; i < n; i++) {
        if (!S[i].wet && S[i].yT > biome.waterLevel + 3) { best = i; break; }
      }
      if (best < 0) best = 0;
    }
    const sm = S[best];
    _spawnIdx = best;
    _spawnDiag = {
      idx: best, score: +bestScore.toFixed(1), pool,
      dep: +departure(best).toFixed(1),
      rCar: Math.round(1 / Math.max(Math.abs(smoothK[(best + endN) % n]), 1e-6)),
      rAim: Math.round(1 / Math.max(Math.abs(smoothK[(best + aimN) % n]), 1e-6)),
      sag: +bendOf(best + endN - frameBack).sag.toFixed(1),
      ess: +bendOf(best + endN - frameBack).ess.toFixed(1),
      comp: SHUTTERS.map((sh) => Math.round(frameScore(best, sh.m))),
      fold: +clamp((density((best + endN) % n) * 9 - 140) / 160, 0, 1).toFixed(2),
    };
    // Project convention (see entities/vehicle.js): forward = (cos h, 0, -sin h).
    // So a tangent (tx, tz) maps to atan2(-tz, tx), NOT atan2(tz, tx) — the
    // wrong sign mirrors the car off the route the instant it spawns.
    return { x: sm.x, z: sm.z, heading: Math.atan2(-sm.tz, sm.tx) };
  };

  return {
    group,
    /** Diagnostics only — nothing in the game reads these. */
    _samples: S,
    get _spawnIndex() { return _spawnIdx; },
    get _spawnDiag() { return _spawnDiag; },
    _ds: main.ds,
    isOnRoad,
    gripAt,
    isBlocked,
    sample,
    lookAhead,
    spawn,
    heightAt,
    /**
     * Outermost lateral offset (metres, unsigned) at which this module still
     * draws a surface at the station nearest (x, z), or null off the network.
     * `heightAt` answers everywhere inside it and null everywhere outside it, so
     * the two are the same boundary described two ways.
     */
    outerEdgeAt,
    surfaceAt,
    length: main.length,
    colliders: furniture.colliders,
    /**
     * BREAKABLE FENCES AND FIXED GUARDRAILS.
     *
     *   segments: [{ x, z, dx, dz, half, kind:'fence'|'guard', broken, id }]
     *     Every barrier bay in the world, as a centre point, a unit direction
     *     along it and a half-length. `broken` is live — it flips the instant
     *     hit() destroys the bay, so a collision loop can skip it for free.
     *
     *   hit(id, speed) -> boolean
     *     Report an impact. Returns TRUE only if this hit destroyed the bay,
     *     which is the signal to let the car through and take ~25% off its
     *     speed. Returns false for a guardrail (never breaks — deflect and
     *     slide), for an already-broken bay, and for a timber bay hit below
     *     `breakSpeed` (7 m/s).
     *
     *   update(dt)
     *     Animates the debris. Costs one boolean test per frame when there is
     *     none in flight.
     */
    barriers: furniture.barriers,
    /** Points the bridge builder needs: places where the route crosses water. */
    waterCrossings: main.crossings.concat(...spurRoutes.map((r) => r.crossings)),
    /**
     * ROUTE SAFETY AUDIT — diagnostics only, and the answer to "check that ALL
     * sharp corners have metal guardrails". Walks every route and reports every
     * place a barrier is owed. See `auditBarriers`.
     */
    audit: () => auditBarriers(routes, terrain, group, furniture.barriers.segments),
    /**
     * EARTHWORKS AUDIT — the answer to "height changes are vertical walls".
     * Walks the route, takes a perpendicular profile of the visible surface at
     * every station, and reports the steepest step split into the part the road
     * built and the part the terrain owns. See `auditSlopes`.
     */
    auditSlopes: (opts) => auditSlopes(routes, terrain, opts),
    /** Triangle cost of the ribbons, so the surface texture can be priced. */
    get _meshStats() {
      const out = { slices: SLICES.length, subrows: SUBROWS, tris: 0, ribbons: [] };
      for (const r of ribbons) {
        const t = r.geometry.attributes.position.count / 3;
        out.tris += t;
        out.ribbons.push({ name: r.name, tris: t });
      }
      return out;
    },
  };
}
