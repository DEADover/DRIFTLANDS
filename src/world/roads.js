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

/** Per-biome road character: width, verge, and the two surfaces it alternates. */
const STYLE = {
  alpine: { width: 8.0, verge: 1.05, kinds: ['tarmac', 'gravel'], spurs: 2 },
  autumn: { width: 7.4, verge: 1.20, kinds: ['gravel', 'dirt'], spurs: 2 },
  desert: { width: 8.6, verge: 1.60, kinds: ['dirt', 'sand'], spurs: 2 },
  coast: { width: 7.8, verge: 1.05, kinds: ['tarmac', 'gravel'], spurs: 1 },
  winter: { width: 8.4, verge: 1.30, kinds: ['snow', 'ice'], spurs: 2 },
};

/**
 * All road colour derives from the palette — no new hexes leak in here. The
 * surface is the palette road colour pushed toward the rock shadow (tarmac,
 * dirt) or toward the verge colour (gravel, sand, snow, ice).
 */
function surfaceColour(palette, kind) {
  const road = new THREE.Color(palette.road);
  const edge = new THREE.Color(palette.roadEdge);
  const dark = new THREE.Color(palette.rockShadow);
  const c = road.clone();
  switch (kind) {
    case 'tarmac': return c.lerp(dark, 0.55).multiplyScalar(0.70);
    case 'gravel': return c.lerp(edge, 0.28);
    case 'dirt': return c.lerp(dark, 0.30).multiplyScalar(0.92);
    case 'sand': return c.lerp(edge, 0.50);
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
  const hiCap = biome.id === 'desert' ? 200 : 66;
  return function cost(x, z) {
    const h = terrain.heightAt(x, z);
    const s = terrainSlope(terrain, x, z, 8);
    let c = s * s * 300 + s * 12;
    const sub = wl + 2.0 - h;
    if (sub > 0) c += wetScale * (85 + sub * 9.0);
    if (h > hiCap) c += (h - hiCap) * (h - hiCap) * 0.028 + (h - hiCap) * 1.2;
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
 * Step 3 — the corner plan. A rally stage is a RHYTHM: a straight to breathe,
 * a long sweeper you can hold sideways, a hairpin that demands the handbrake, a
 * chicane that flips the car the other way. Direction alternates so drifts link.
 */
function cornerPlan(rng, L) {
  const feats = [];
  let s = rng.float(0, 60);
  let sign = rng.sign();
  const bag = ['sweeper', 'sweeper', 'sweeper', 'hairpin', 'chicane',
    'kink', 'hairpin', 'straight', 'kink'];
  let guard = 0;
  while (s < L - 140 && guard++ < 200) {
    const kind = rng.pick(bag);
    if (kind === 'hairpin') {
      const sg = rng.float(30, 40);
      feats.push({ s, sigma: sg, amp: sign * rng.float(1.45, 1.85) * sg });
      s += sg * 2 + rng.float(150, 250);
    } else if (kind === 'chicane') {
      const sg = rng.float(30, 42);
      const a = rng.float(0.55, 0.85) * sg;
      feats.push({ s, sigma: sg, amp: sign * a });
      feats.push({ s: s + sg * 2.0, sigma: sg, amp: -sign * a });
      s += sg * 2.0 + rng.float(160, 240);
    } else if (kind === 'sweeper') {
      const sg = rng.float(95, 150);
      feats.push({ s, sigma: sg, amp: sign * rng.float(0.30, 0.52) * sg });
      s += sg * 1.5 + rng.float(150, 300);
    } else if (kind === 'kink') {
      const sg = rng.float(42, 62);
      feats.push({ s, sigma: sg, amp: sign * rng.float(0.32, 0.50) * sg });
      s += sg * 1.6 + rng.float(140, 230);
    } else {
      s += rng.float(200, 320); // a genuine straight
    }
    sign = -sign;
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
  pts = limitCurvature(pts, 17, 120);
  pts = separate(pts, 38, 26, 16);
  pts = deloop(pts);
  pts = limitCurvature(pts, 17, 60);
  pts = smoothRing(pts, 3, 0.18);
  stage('final', pts);
  return resample(pts, 3.0);
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

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      x: pts[i].x, z: pts[i].z, s: s[i], y: y[i], yT: yT[i],
      tx: f.tx[i], tz: f.tz[i], nx: f.nx[i], nz: f.nz[i], k: f.k[i],
      bank: bank[i], surf: surf[i], hw: halfWs[i], verge,
      wet: deckMask[i] > 0.02,
    };
  }
  return { samples: out, length: L, closed, crossings, ds };
}

// ---------------------------------------------------------------------------
// Mesh building
// ---------------------------------------------------------------------------

const LIFT = 0.16;   // above the terrain profile — kills z-fighting
const CROWN = 0.12;  // camber drop at the carriageway edge
const GUTTER = 0.35; // dark lip between the verge and the earthworks
const BANK_MAX = 5;  // longest batter face we will build

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

function sectionY(sm, u) {
  const t = clamp(u / sm.hw, -2, 2);
  return sm.y + LIFT - sm.bank * u - CROWN * Math.min(1, t * t);
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

/** Lateral stations across the carriageway, as fractions of the half width. */
const LANES = [-1.0, -0.64, -0.28, 0.28, 0.64, 1.0];

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
    const base = sm.hw + sm.verge + GUTTER;
    if (sm.wet) { bwL[i] = 1.2; bwR[i] = 1.2; continue; }
    // inside a bend the earthworks must shrink or neighbouring sections overlap
    const inner = Math.max(0, 0.45 / Math.max(Math.abs(sm.k), 1e-5) - base);
    const capL = sm.k > 0 ? inner : BANK_MAX;
    const capR = sm.k < 0 ? inner : BANK_MAX;
    bwL[i] = Math.min(capL, batterWidth(terrain, sm.x, sm.z, sm.nx, sm.nz, base, sectionY(sm, base), 1.05, 0.75));
    bwR[i] = Math.min(capR, batterWidth(terrain, sm.x, sm.z, -sm.nx, -sm.nz, base, sectionY(sm, -base), 1.05, 0.75));
  }
  const BL = blurRing(bwL, 3, 2, closed), BR = blurRing(bwR, 3, 2, closed);

  /** A vertex on the section, with the inside-of-corner cap applied. */
  const st = (sm, u, y) => {
    const cu = capU(sm, u);
    return [sm.x + sm.nx * cu, y === undefined ? sectionY(sm, cu) : y, sm.z + sm.nz * cu];
  };

  for (let i = 0; i < last; i++) {
    const A = S[i], B = S[(i + 1) % n];
    const road = colours[A.surf];
    const track = colours[`${A.surf}:track`];

    for (let j = 0; j < LANES.length - 1; j++) {
      const isTrack = j === 1 || j === 3;
      b.quad(
        st(A, LANES[j] * A.hw), st(A, LANES[j + 1] * A.hw),
        st(B, LANES[j] * B.hw), st(B, LANES[j + 1] * B.hw),
        jitter(isTrack ? track : road, i * 7 + j, 0.055)
      );
    }

    for (const side of [1, -1]) {
      const eA = side * A.hw, eB = side * B.hw;
      const vA = side * (A.hw + A.verge), vB = side * (B.hw + B.verge);
      const gA = side * (A.hw + A.verge + GUTTER), gB = side * (B.hw + B.verge + GUTTER);
      const yVA = sectionY(A, capU(A, vA)) - 0.08, yVB = sectionY(B, capU(B, vB)) - 0.08;
      const yGA = sectionY(A, capU(A, gA)) - 0.26, yGB = sectionY(B, capU(B, gB)) - 0.26;

      const DBG_V = new THREE.Color(side > 0 ? 0xff0000 : 0x0000ff);
      const DBG_G = new THREE.Color(side > 0 ? 0xffff00 : 0x00ffff);
      b.quad(st(A, eA), st(A, vA, yVA), st(B, eB), st(B, vB, yVB), DBG_V);
      b.quad(st(A, vA, yVA), st(A, gA, yGA), st(B, vB, yVB), st(B, gB, yGB), DBG_G);

      // --- earthworks: the batter face, sampled against the ground so it can
      // never float free of it. Two facets is enough at this camera height.
      const wA = side > 0 ? BL[i] : BR[i];
      const wB = side > 0 ? BL[(i + 1) % n] : BR[(i + 1) % n];
      const baseA = A.hw + A.verge + GUTTER, baseB = B.hw + B.verge + GUTTER;
      let pA = [gA, yGA], pB = [gB, yGB];
      let face = colours.fill;
      for (const f of [0.5, 1.0]) {
        const uA = side * (baseA + wA * f), uB = side * (baseB + wB * f);
        const cA = capU(A, uA), cB = capU(B, uB);
        const tA = terrain.heightAt(A.x + A.nx * cA, A.z + A.nz * cA) - 0.30;
        const tB = terrain.heightAt(B.x + B.nx * cB, B.z + B.nz * cB) - 0.30;
        const yA = lerp(yGA, tA, f), yB = lerp(yGB, tB, f);
        if (f === 0.5) face = tA > yGA + 0.35 ? colours.cut : colours.fill;
        b.quad(st(A, pA[0], pA[1]), st(A, uA, yA), st(B, pB[0], pB[1]), st(B, uB, yB),
          new THREE.Color(side > 0 ? (f === 1 ? 0xff00ff : 0x880088) : (f === 1 ? 0x00ff00 : 0x008800)));
        pA = [uA, yA]; pB = [uB, yB];
      }
    }
  }

  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -6,
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

function buildFurniture(ctx, routes, colours) {
  const { palette, terrain } = ctx;
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
  const colours = {};
  for (const k of new Set(style.kinds)) {
    const c = surfaceColour(palette, k);
    colours[k] = c;
    const track = c.clone();
    if (k === 'tarmac') track.multiplyScalar(0.86);
    else track.lerp(new THREE.Color(palette.roadEdge), 0.15);
    colours[`${k}:track`] = track;
  }
  colours.verge = new THREE.Color(palette.roadEdge);
  colours.gutter = new THREE.Color(palette.roadEdge).lerp(new THREE.Color(palette.rockShadow), 0.55);
  colours.cut = new THREE.Color(palette.rock).lerp(new THREE.Color(palette.roadEdge), 0.20);
  colours.fill = new THREE.Color(palette.ground[0]).lerp(new THREE.Color(palette.rock), 0.42);

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
    return { x: sm.x, z: sm.z, heading: Math.atan2(sm.tz, sm.tx) };
  };

  /**
   * Start on the approach to the best hairpin on the circuit. A hairpin folds
   * the ribbon back on itself, so a single 160 m-wide frame contains the
   * approach, the apex and the exit — the road stays in shot even when the car
   * runs wide, and it is the art-of-rally postcard composition besides.
   */
  const spawn = () => {
    const n = S.length;
    const half = biome.size * 0.5;
    const lead = Math.max(6, Math.round(135 / main.ds));
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
      const sm = S[i];
      if (sm.wet) continue;
      const corner = Math.abs(sm.k);
      if (corner < 1 / 60) continue;
      const j = ((i - lead) % n + n) % n;   // where we would actually start
      const st = S[j];
      if (st.wet || st.yT < biome.waterLevel + 3) continue;
      const rim = Math.max(Math.abs(st.x), Math.abs(st.z)) / half;
      const open = 1 - clamp(terrainSlope(terrain, st.x, st.z, 22) * 2.4, 0, 1);
      // how much road is nearby? a folded route fills the frame
      let near = 0;
      for (let k = 0; k < n; k += 3) {
        const d = Math.hypot(S[k].x - st.x, S[k].z - st.z);
        if (d < 130) near++;
      }
      const score = corner * 260 + open * 5 + near * 0.35 - Math.max(0, rim - 0.62) * 34;
      if (score > bestScore) { bestScore = score; best = j; }
    }
    if (best < 0) {
      for (let i = 0; i < n; i++) {
        if (!S[i].wet && S[i].yT > biome.waterLevel + 3) { best = i; break; }
      }
      if (best < 0) best = 0;
    }
    const sm = S[best];
    return { x: sm.x, z: sm.z, heading: Math.atan2(sm.tz, sm.tx) };
  };

  return {
    group,
    isOnRoad,
    gripAt,
    isBlocked,
    sample,
    spawn,
    heightAt,
    surfaceAt,
    length: main.length,
    colliders: furniture.colliders,
    /** Points the bridge builder needs: places where the route crosses water. */
    waterCrossings: main.crossings.concat(...spurRoutes.map((r) => r.crossings)),
  };
}
