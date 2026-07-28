import * as THREE from 'three';
import { Rng, fbm } from '../core/rng.js';
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

function surfaceColour(palette, kind) {
  const road = new THREE.Color(palette.road);
  const edge = new THREE.Color(palette.roadEdge);
  const dark = new THREE.Color(palette.rockShadow);
  const ochre = new THREE.Color(OCHRE);
  const c = road.clone();
  switch (kind) {
    case 'tarmac': return c.lerp(dark, 0.55).multiplyScalar(0.70);
    case 'gravel': return c.lerp(ochre, 0.94).lerp(edge, 0.12);
    case 'dirt': return c.lerp(ochre, 0.94).multiplyScalar(0.93);
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
const BANK_MAX = 7;  // longest batter/blend skirt we will build
const SKIRT_MIN = 1.6; // the shoulder ALWAYS gets this much soft blend
const RUT_DEPTH = 0.11; // how deep the wheel ruts are worn in

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

/** March outward until the batter face meets the terrain. */
function batterWidth(terrain, px, pz, dirx, dirz, base, yEdge, cutSlope, fillSlope) {
  for (let d = 1.2; d <= BANK_MAX; d += 1.2) {
    const t = terrain.heightAt(px + dirx * (base + d), pz + dirz * (base + d));
    const dy = t - yEdge;
    const allowed = (dy > 0 ? cutSlope : fillSlope) * d;
    if (Math.abs(dy) <= allowed) return d;
  }
  return BANK_MAX;
}

class Strip {
  constructor() { this.pos = []; this.col = []; }
  /** a,b on section i; c,d on section i+1; a and c share a lateral station. */
  quad(a, b, c, d, col) {
    // orient so the face normal points up (walls are drawn double sided)
    const ux = d[0] - a[0], uy = d[1] - a[1], uz = d[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const ny = uz * vx - ux * vz;
    if (ny >= 0) { this.tri(a, d, c, col); this.tri(a, b, d, col); }
    else { this.tri(a, c, d, col); this.tri(a, d, b, col); }
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

  const bwL = new Float64Array(n), bwR = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const sm = S[i];
    const base = sm.hw + sm.verge;
    if (sm.wet) { bwL[i] = 1.2; bwR[i] = 1.2; continue; }
    // inside a bend the earthworks must shrink or neighbouring sections overlap
    const inner = Math.max(0, 0.45 / Math.max(Math.abs(sm.k), 1e-5) - base);
    const capL = sm.k > 0 ? inner : BANK_MAX;
    const capR = sm.k < 0 ? inner : BANK_MAX;
    bwL[i] = Math.min(capL, batterWidth(terrain, sm.x, sm.z, sm.nx, sm.nz, base, sectionY(sm, base), 1.05, 0.75));
    bwR[i] = Math.min(capR, batterWidth(terrain, sm.x, sm.z, -sm.nx, -sm.nz, base, sectionY(sm, -base), 1.05, 0.75));
    // The skirt is never allowed to vanish: without a few metres of soft blend
    // the carriageway ends in a clean straight line, which is exactly the "cut
    // out and pasted on" look the client rejected.
    bwL[i] = Math.max(bwL[i], Math.min(capL, SKIRT_MIN));
    bwR[i] = Math.max(bwR[i], Math.min(capR, SKIRT_MIN));
  }
  const BL = blurRing(bwL, 3, 2, closed), BR = blurRing(bwR, 3, 2, closed);

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

  /**
   * DRAPE. The carriageway is a designed surface — crown, camber, ruts, the
   * bench tilt — but the ground underneath it is a jittered mesh with ~10 m
   * triangles, and a designed plane WILL be speared by it: a high vertex two
   * metres off the centre line pokes a green tongue straight across the road,
   * and the ribbon reads as chopped into pieces.
   *
   * Rather than jacking the whole road into the air to clear its worst bump —
   * which we cannot afford, because game.js still stands the car on RAW terrain
   * height (`groundAt`) and any lift is a gap under the wheels — every vertex
   * is simply not allowed to go below the ground beneath it. Where the design
   * clears the ground, the design wins and the section is crisp; where it does
   * not, the road drapes over the bump like a graded dirt track actually does.
   * Nothing can poke through, and the surface never leaves the car behind.
   */
  const drape = (sm, u) => {
    const cu = capU(sm, u);
    const px = sm.x + sm.nx * cu, pz = sm.z + sm.nz * cu;
    // Sampled at the vertex AND around it. A terrain triangle is ~10 m across
    // while the carriageway quads are 3 m by 2 m, so a high ground vertex can
    // sit BETWEEN two road stations, above the quad that spans them, and shows
    // as a green tongue lying across the ochre. Taking the worst ground within
    // a couple of metres closes the gap the interpolation leaves; on a 1:10
    // slope it costs 0.16 m of extra height, which is inside the ±0.45 m the
    // car's raw-terrain ground contact can absorb.
    let g = terrain.heightAt(px, pz);
    for (const [ax, az] of [[sm.nx, sm.nz], [-sm.nx, -sm.nz], [sm.tx, sm.tz], [-sm.tx, -sm.tz]]) {
      const h = terrain.heightAt(px + ax * 1.7, pz + az * 1.7);
      if (h > g) g = h;
    }
    return Math.max(sectionY(sm, cu), g + LIFT);
  };

  for (let i = 0; i < last; i++) {
    const A = S[i], B = S[(i + 1) % n];
    const tone = {
      road: colours[A.surf],
      rut: colours[`${A.surf}:rut`],
      rutSoft: colours[`${A.surf}:rutSoft`],
      centre: colours[`${A.surf}:centre`],
      edge: colours[`${A.surf}:edge`],
    };

    // --- carriageway, ruts included ----------------------------------------
    // The ruts wander: a slow lateral drift with arc length, so they are never
    // two rails at a constant gauge. Half a metre of sway over ~60 m reads, at
    // this camera height, as tracks worn by cars that took different lines.
    const swayA = Math.sin(A.s * 0.031) * 0.05 + Math.sin(A.s * 0.011 + 2.1) * 0.035;
    const swayB = Math.sin(B.s * 0.031) * 0.05 + Math.sin(B.s * 0.011 + 2.1) * 0.035;
    // The outermost station of the carriageway wanders with arc length, so the
    // ochre silhouette itself is irregular rather than a ruled line with a
    // ragged fringe pinned to it.
    const hemA = [1 + ragged(A, -1) * 0.13, 1 + ragged(A, 1) * 0.13];
    const hemB = [1 + ragged(B, -1) * 0.13, 1 + ragged(B, 1) * 0.13];
    // Every lateral station goes through the same warp: the racing-line drift
    // and spread from `rutLine`, plus the slow arc-length sway. The window
    // inside `warpU` pins the outermost station, so the ochre silhouette is
    // untouched while the worn band swings across it through the corner.
    const put = (sm, uf, sway, hem) => {
      const a = Math.abs(uf);
      let f = warpU(uf, sm.rutShift ?? 0, sm.rutSpread ?? 1);
      if (a > 0.19 && a < 0.7) f += sway * Math.sign(uf);
      if (a >= 0.999) f *= hem[uf > 0 ? 1 : 0];
      return { u: f * sm.hw, y: drape(sm, f * sm.hw) };
    };
    for (let j = 0; j < BANDS.length; j++) {
      const [u0, u1, kind] = BANDS[j];
      const a0 = put(A, u0, swayA, hemA), a1 = put(A, u1, swayA, hemA);
      const b0 = put(B, u0, swayB, hemB), b1 = put(B, u1, swayB, hemB);
      b.quad(
        st(A, a0.u, a0.y), st(A, a1.u, a1.y),
        st(B, b0.u, b0.y), st(B, b1.u, b1.y),
        jitter(tone[kind], i * 11 + j, kind === 'rut' ? 0.10 : 0.075)
      );
    }

    for (const side of [1, -1]) {
      // --- shoulder: carriageway edge -> soft skirt -> untouched ground ------
      //
      // No gutter, no kerb lip, no vertical face. The section walks outward in
      // three steps, each one lower and greener than the last, and the LAST one
      // lands exactly on the terrain it is standing on. That is what stops the
      // ribbon reading as a slab: there is nowhere left for a step to hide.
      const hmA = side > 0 ? hemA[1] : hemA[0];
      const hmB = side > 0 ? hemB[1] : hemB[0];
      const eA = side * A.hw * hmA, eB = side * B.hw * hmB;
      const rgA = 1 + ragged(A, side) * 0.5;
      const rgB = 1 + ragged(B, side) * 0.5;
      const wA = (side > 0 ? BL[i] : BR[i]) * rgA;
      const wB = (side > 0 ? BL[(i + 1) % n] : BR[(i + 1) % n]) * rgB;

      const vA = side * (A.hw * hmA + A.verge * rgA);
      const vB = side * (B.hw * hmB + B.verge * rgB);
      const yEA = drape(A, eA), yEB = drape(B, eB);
      // shoulder height: half way from the carriageway edge down to the ground,
      // and never below the ground it is standing on
      const gvA = terrain.heightAt(A.x + A.nx * capU(A, vA), A.z + A.nz * capU(A, vA));
      const gvB = terrain.heightAt(B.x + B.nx * capU(B, vB), B.z + B.nz * capU(B, vB));
      const yVA = Math.max(lerp(drape(A, vA), gvA + LIFT, 0.5), gvA + 0.03);
      const yVB = Math.max(lerp(drape(B, vB), gvB + LIFT, 0.5), gvB + 0.03);

      b.quad(st(A, eA, yEA), st(A, vA, yVA), st(B, eB, yEB), st(B, vB, yVB),
        jitter(colours.shoulder, i * 5 + (side > 0 ? 0 : 3), 0.09));

      // The skirt: two facets marching out to meet the ground exactly. A cut
      // face shows raw earth, a fill face is already half grassed over.
      const baseA = A.hw * hmA + A.verge * rgA, baseB = B.hw * hmB + B.verge * rgB;
      let pA = [vA, yVA], pB = [vB, yVB];
      // Three facets, not two: earth, then half-grassed, then grass. The extra
      // step is what turns the last hard tonal edge into a gradient — with two
      // the road still ended on a visible line at this camera height.
      for (const f of [0.42, 0.74, 1.0]) {
        const uA = side * (baseA + wA * f), uB = side * (baseB + wB * f);
        const cA = capU(A, uA), cB = capU(B, uB);
        const tA = terrain.heightAt(A.x + A.nx * cA, A.z + A.nz * cA);
        const tB = terrain.heightAt(B.x + B.nx * cB, B.z + B.nz * cB);
        // land ON the ground at the last facet, a hair above so it wins the
        // depth test against the terrain triangle underneath it
        const yA = f === 1 ? tA + 0.02 : Math.max(lerp(yVA, tA, f * 0.95), tA + 0.03);
        const yB = f === 1 ? tB + 0.02 : Math.max(lerp(yVB, tB, f * 0.95), tB + 0.03);
        const cutting = tA > yEA + 0.5;
        const earth = cutting ? colours.cut : colours.fill;
        const face = f === 1 ? colours.blend
          : (f > 0.5 ? earth.clone().lerp(colours.blend, 0.55) : earth);
        b.quad(st(A, pA[0], pA[1]), st(A, uA, yA), st(B, pB[0], pB[1]), st(B, uB, yB),
          jitter(face, i * 13 + (side > 0 ? 1 : 2) + Math.round(f * 64), 0.10));
        pA = [uA, yA]; pB = [uB, yB];
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
 * POST-AND-RAIL FENCE — ART_DIRECTION §4.1, and the single most recurring piece
 * of furniture in the client set: warm brown timber following the road's curve,
 * sometimes both sides, running off over a hill.
 *
 * Built as geometry rather than instances because every bay is a different
 * length and a different slope: the posts are planted on the TERRAIN (not on
 * the road plane, which is up to a third of a metre above it on a bench) and
 * the rails are stretched between consecutive post tops, so the whole line
 * follows the ground the way a real fence does instead of floating level.
 */
function buildFence(strip, routes, terrain, seed, colPost, colRail) {
  // Stylised, not scale-accurate. At a 50-degree camera 200 m up, a real 0.15 m
  // fence post is two pixels of nothing; the references draw chunky timber that
  // reads instantly, so the posts are ~0.34 m square and the rails 0.24 m thick.
  const SPACING = 4.4;      // bay length
  const POST_H = 1.55;
  const POST_R = 0.17;      // half-width of the square post
  const RAILS = [0.66, 1.20];
  const RAIL_T = 0.12;      // rail half-thickness
  const RAIL_H = 0.17;      // rail half-height

  /** An axis-aligned-to-the-road box: four sides plus the top the camera sees. */
  const box = (strip, cx, cy, cz, ax, az, halfA, halfB, halfH, col, top) => {
    const bx = -az, bz = ax;                       // the other horizontal axis
    const ux = ax * halfA, uz = az * halfA;
    const vx = bx * halfB, vz = bz * halfB;
    const c = [
      [cx - ux - vx, cz - uz - vz], [cx + ux - vx, cz + uz - vz],
      [cx + ux + vx, cz + uz + vz], [cx - ux + vx, cz - uz + vz],
    ];
    const lo = cy - halfH, hi = cy + halfH;
    for (let q = 0; q < 4; q++) {
      const p = c[q], r = c[(q + 1) % 4];
      strip.quad([p[0], hi, p[1]], [p[0], lo, p[1]], [r[0], hi, r[1]], [r[0], lo, r[1]],
        q % 2 ? col.clone().multiplyScalar(0.84) : col);
    }
    strip.quad([c[0][0], hi, c[0][1]], [c[1][0], hi, c[1][1]],
      [c[3][0], hi, c[3][1]], [c[2][0], hi, c[2][1]], top);
  };

  // A fence must never run across a carriageway. Spurs leave the main route at
  // a T, and without this check the fence line marches straight over the
  // junction and out the other side, which reads as a bug rather than a farm.
  const CELL = 24;
  const grid = new Map();
  for (const route of routes) {
    for (const sm of route.samples) {
      const k = `${Math.floor(sm.x / CELL)},${Math.floor(sm.z / CELL)}`;
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(sm);
    }
  }
  const overRoad = (x, z, own) => {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    for (let u = -1; u <= 1; u++) {
      for (let v = -1; v <= 1; v++) {
        const l = grid.get(`${ci + u},${cj + v}`);
        if (!l) continue;
        for (const sm of l) {
          if (sm === own) continue;
          const d = Math.hypot(sm.x - x, sm.z - z);
          if (d < sm.hw + sm.verge + 1.6) return true;
        }
      }
    }
    return false;
  };

  for (const route of routes) {
    const S = route.samples;
    const n = S.length;
    if (n < 8) continue;
    for (const side of [1, -1]) {
      let prev = null;
      let since = 1e9;
      for (let i = 0; i < n; i++) {
        const sm = S[i];
        since += route.ds;
        // Long runs with long gaps, decided by arc length so the same stretch
        // of road always carries the same fence.
        const on = fbm(sm.s * 0.0042 + side * 17.3, seed * 0.011,
          { octaves: 2, seed: seed + 613 }) > -0.02;
        if (!on || sm.wet || since < SPACING) {
          if (!on || sm.wet) prev = null;
          continue;
        }
        const u = side * (sm.hw + sm.verge + 2.3);
        const x = sm.x + sm.nx * u, z = sm.z + sm.nz * u;
        if (overRoad(x, z, sm)) { prev = null; continue; }
        since = 0;
        const g = terrain.heightAt(x, z) - 0.14;   // planted, never floating
        const cur = { x, z, g, tx: sm.tx, tz: sm.tz };

        box(strip, x, g + POST_H * 0.5, z, sm.tx, sm.tz, POST_R, POST_R, POST_H * 0.5,
          colPost, colPost.clone().multiplyScalar(1.10));

        if (prev && Math.hypot(x - prev.x, z - prev.z) < SPACING * 2.4) {
          const dx = x - prev.x, dz = z - prev.z;
          const l = Math.hypot(dx, dz) || 1;
          const ax = dx / l, az = dz / l;
          const mx = (x + prev.x) * 0.5, mz = (z + prev.z) * 0.5;
          for (const h of RAILS) {
            // the rail follows the ground: its centre is the mean of the two
            // post heights, so a fence on a slope steps down with the slope
            const my = (prev.g + g) * 0.5 + h;
            box(strip, mx, my, mz, ax, az, l * 0.5, RAIL_T, RAIL_H,
              colRail, colRail.clone().multiplyScalar(1.08));
          }
        }
        prev = cur;
      }
    }
  }
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
  const fence = new Strip();

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
        colliders.push({ x, z, r: 0.7 });
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
  const timber = new THREE.Color(palette.trunk ?? 0x6b4a30).lerp(new THREE.Color(0xa8763f), 0.85);
  buildFence(fence, routes, terrain, seed ?? 1337,
    timber.clone().multiplyScalar(0.86), timber);

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

  if (fence.count) {
    const m = new THREE.Mesh(fence.geometry(), new THREE.MeshLambertMaterial({
      vertexColors: true, flatShading: true, side: THREE.DoubleSide,
    }));
    m.castShadow = true;
    m.receiveShadow = false;
    m.matrixAutoUpdate = false;
    m.name = 'road-fences';
    group.add(m);
  }

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

  return { group, colliders };
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
    for (const sm of route.samples) {
      const i = this.samples.length;
      this.samples.push(sm);
      const k = `${Math.floor(sm.x / this.cell)},${Math.floor(sm.z / this.cell)}`;
      let l = this.map.get(k);
      if (!l) this.map.set(k, (l = []));
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
    colours[`${k}:rut`] = c.clone().multiplyScalar(0.66).lerp(new THREE.Color(palette.rockShadow), 0.18);
    // The feathered lip of the rut, so it has no hard boundary.
    colours[`${k}:rutSoft`] = c.clone().multiplyScalar(0.84).lerp(new THREE.Color(palette.rockShadow), 0.08);
    // The strip between the ruts nobody drives on: lighter, slightly greened.
    colours[`${k}:centre`] = c.clone().lerp(grass, 0.10).multiplyScalar(1.03);
    // Thrown grit and dust piles up at the edges — the palest part of the road.
    colours[`${k}:edge`] = c.clone().lerp(new THREE.Color(palette.roadEdge), 0.26);
  }
  const base = colours[style.kinds[0]];
  colours.shoulder = base.clone().lerp(grass, 0.55);
  colours.blend = grass.clone().lerp(base, 0.07);
  colours.cut = new THREE.Color(palette.rock).lerp(base, 0.45);
  colours.fill = grass.clone().lerp(base, 0.30);

  // ---- meshes ----
  group.add(buildRibbonMesh(ctx, main, colours, 'road-main'));
  for (const sp of spurRoutes) group.add(buildRibbonMesh(ctx, sp, colours, 'road-spur'));
  const furniture = buildFurniture(ctx, routes, colours);
  group.add(furniture.group);

  // ---- queries ----
  const index = new RoadIndex(26);
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
  const heightAt = (x, z) => {
    const h = index.nearest(x, z);
    if (!h || h.d > h.sm.hw + h.sm.verge) return null;
    const u = (x - h.sm.x) * h.sm.nx + (z - h.sm.z) * h.sm.nz;
    return sectionY(h.sm, u);
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
    // MEASURED, not assumed: with the run-up kept open the hero tape puts the
    // car 273 m along the route at its 9 s settle time. Get this wrong by 40 m
    // and the whole frame is scored around the wrong piece of road.
    const endN = Math.max(4, Math.round(272 / main.ds));
    // Where the shutter opens, in metres along the route, for each alpine
    // capture preset — lake_bridge settles at 7 s, hero_alpine at 9 s and
    // wildlife at 10 s. Weighted toward the hero, which is the judged frame.
    const SHUTTERS = [{ m: 190, w: 0.22 }, { m: 272, w: 0.56 }, { m: 315, w: 0.22 }];
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
    // — constant-power-ish, within a metre per second everywhere. The earlier
    // sqrt(2·5.6·d) fit was 25% low at 30 m, which understated the lateral
    // demand of the opening corners by half and let the run-up throw the car
    // thirty metres into the meadow.
    const A0 = 10.6, V_MAX = 42;
    const vAt = (metres) =>
      V_MAX * Math.tanh(Math.sqrt(2 * A0 * Math.max(1, metres)) / V_MAX);
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
    // Nothing outside ±50 m of the car exists as far as the composition goes.
    const frameN = Math.max(4, Math.round(66 / main.ds));
    const frameBack = Math.round(21 / main.ds);
    // How far the road should bow away from the straight line across the frame.
    // Over 66 m of visible ribbon, 12 m of sagitta is a corner of about 45 m
    // radius — it fills the frame with arc. The shipped frame measured 3.6 m.
    const SAG_WANT = 12;
    // The middle of the visible road ahead of the car.
    const aimN = endN + Math.round(22 / main.ds);
    // THE CORNER ITSELF. The car cannot sit at the apex of a 45 m radius at
    // 41 m/s — but it does not have to. The visible road only reaches 21 m
    // behind it, so the corner may START at the shutter: twenty metres of
    // unmet lateral demand is under two metres of slide, and the picture is
    // a car turning in with the corner wrapping away in front of it.
    const CAR_LO = 40, CAR_HI = 300;
    const AIM_LO = 32, AIM_HI = 80;

    const density = (x, z) => {
      let c = 0;
      for (let k = 0; k < n; k += 3) {
        if (Math.hypot(S[k].x - x, S[k].z - z) < 70) c++;
      }
      return c;
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
    const A_GRIP = 6.4, K_P = 1.2, K_D = 2.2;
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
      return peak;
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
      const shape = clamp((bend.sag - 6) / (SAG_WANT - 6), 0, 1)
        * clamp(1 - Math.max(0, bend.sag - SAG_WANT * 1.6) / 40, 0, 1);

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
      const ess = clamp(bend.ess / 6, 0, 1);

      // THE ROAD FOLDING BACK THROUGH THE FRAME. The reference's top-left is two
      // legs of the same road sixty metres apart with a wall of conifers between
      // them; that is what fills a picture with route. `density` counts every
      // third station within 70 m, so each count is 9 m of road: ~140 m is the
      // car's own stretch and anything past that is a SECOND piece of road.
      const fold = clamp((density(car.x, car.z) * 9 - 140) / 160, 0, 1);

      // A timber bridge over blue water is the hero landmark of half the client
      // references — but only if it is in the photograph, not in the run-up.
      let deck = 0;
      for (let k = -frameBack; k < frameN - frameBack; k++) {
        if (S[(((j + eN + k) % n) + n) % n].wet) deck++;
      }
      const span = clamp((deck * main.ds) / 26, 0, 1)
        * (1 - clamp((deck * main.ds) / 200, 0, 1));

      return shape * 120 + apex * 170 + ess * 90 + fold * 80 + span * 130;
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
      fold: +clamp((density(S[(best + endN) % n].x, S[(best + endN) % n].z) * 9 - 140) / 160, 0, 1).toFixed(2),
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
    surfaceAt,
    length: main.length,
    colliders: furniture.colliders,
    /** Points the bridge builder needs: places where the route crosses water. */
    waterCrossings: main.crossings.concat(...spurRoutes.map((r) => r.crossings)),
  };
}
