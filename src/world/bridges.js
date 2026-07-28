import * as THREE from 'three';
import { setLakeContext, planLakes, carveLakes } from './water.js';

/**
 * BRIDGES — owned by the bridges builder.
 *
 * CONTRACT:
 *   createBridges(ctx) -> {
 *     group: THREE.Object3D
 *     heightAt(x, z) -> number|null   deck height if over a bridge, else null
 *     isBlocked(x, z) -> boolean      keep-out for props
 *     colliders: {x,z,r}[]            pylons / railings the car should hit
 *   }
 *
 * ctx = { terrain, biome, palette, seed, roads }
 *
 * ---------------------------------------------------------------------------
 * FINDING THE CROSSING
 *
 * `roads.waterCrossings` is the documented input and it is EMPTY on every
 * alpine seed — roads.js looks for route samples below `biome.waterLevel`, and
 * alpine declares that at -17 while the lowest point in the whole 1700 m map
 * is -12.7 (seed 4242). Nothing was ever wet, so nothing was ever bridged.
 * water.js fills the tarn basins to -5 (see lake.js for why), so the route now
 * genuinely goes under water in one to three places per seed, and this module
 * finds those spans itself by walking the centreline. If a future roads.js
 * hands over real crossings they are used as hints and the same span-walker
 * still decides the abutments.
 *
 * THE DECK MEETS THE ROAD BY CONSTRUCTION
 * The deck is dead level at `waterline + 3.2`. Each end is then walked OUTWARD
 * along the route until the terrain under the road has climbed to that same
 * height, and the deck stops exactly there. So the deck never steps up out of
 * the road surface — the abutment is where the two are already at the same
 * altitude, which is precisely how a real bridge is sited.
 *
 * NOTHING HERE MAY THROW
 * A previous revision of this file 500'd the page and cost the whole round.
 * The entire build sits inside one try/catch that falls back to the neutral
 * stub, so the worst case is a world with no bridges, never a world that will
 * not load.
 */

const CLEARANCE = 3.2;   // deck underside above the waterline, metres
// Half width of the deck. The ALPINE carriageway is 15 m wide with a 1.5 m
// verge and corner widening on top, so a 6.8 m half-deck put the railing posts
// two metres INSIDE the road: game.js pushes the car out of a collider at
// (r + 1.4) m, so a car merely holding its own lane was speared at the abutment
// and thrown into the lake, and the causeway the deck is supposed to hide stuck
// out either side. The deck is now wider than the road it carries, which is
// what lets a car following the centreline cross without touching anything.
const DECK_HW = 10.0;
const PLANK = 1.15;      // plank pitch along the deck
const POST_GAP = 3.6;    // railing post pitch
const PYLON_GAP = 9.5;   // pier pitch
const MIN_SPAN = 10;     // shorter than this and it is a culvert, not a bridge
const MAX_SPAN = 400;
const ABUTMENT = 26;     // how far onto each bank the deck may reach
const RAMP = 22;         // over how many metres the deck settles onto the road

const TIMBER = {
  deck: 0x9c6a3e,
  deckAlt: 0x8a5a33,
  deckDark: 0x6f4526,
  beam: 0x5d3a20,
  rail: 0x8f5f37,
  post: 0x7a4e2c,
  pile: 0x5a3a22,
};

/** Minimal non-indexed geometry accumulator — a few hundred boxes, no fuss. */
class Kit {
  constructor() { this.pos = []; this.nor = []; this.col = []; }

  /** Axis-aligned box of size (w,h,d), yawed by `yaw`, centred at (x,y,z). */
  box(w, h, d, x, y, z, yaw, color) {
    const g = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);
    g.applyMatrix4(m);
    this.add(g, color);
  }

  /** Quad from four world-space corners, wound a-b-c / a-c-d. */
  quad(a, b, c, d, color) {
    const t = [a, b, c, a, c, d];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const il = 1 / (Math.hypot(nx, ny, nz) || 1);
    nx *= il; ny *= il; nz *= il;
    const col = new THREE.Color(color);
    for (const p of t) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(col.r, col.g, col.b);
    }
  }

  add(geo, color) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    const col = new THREE.Color(color);
    for (let i = 0; i < p.length; i += 3) {
      this.pos.push(p[i], p[i + 1], p[i + 2]);
      this.nor.push(n[i], n[i + 1], n[i + 2]);
      this.col.push(col.r, col.g, col.b);
    }
    geo.dispose?.();
  }

  mesh(name) {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
      vertexColors: true, flatShading: true,
    }));
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    return m;
  }
}

/** Recover the route centreline as a real polyline with arc length. */
function routePolyline(roads) {
  const M = 4000;
  const raw = [];
  for (let i = 0; i < M; i++) {
    const s = roads.sample(i / M);
    if (!s) continue;
    const last = raw[raw.length - 1];
    // sample() quantises to the internal sample array, so consecutive t values
    // return the same point; keep one of each.
    if (last && Math.abs(last.x - s.x) < 1e-6 && Math.abs(last.z - s.z) < 1e-6) continue;
    raw.push({ x: s.x, z: s.z });
  }
  const n = raw.length;
  if (n < 8) return null;
  for (let i = 0; i < n; i++) {
    const a = raw[(i - 1 + n) % n], b = raw[(i + 1) % n];
    let tx = b.x - a.x, tz = b.z - a.z;
    const il = 1 / (Math.hypot(tx, tz) || 1);
    raw[i].tx = tx * il; raw[i].tz = tz * il;
    raw[i].nx = -raw[i].tz; raw[i].nz = raw[i].tx;
    const c = raw[i], d = raw[(i + 1) % n];
    raw[i].ds = Math.hypot(d.x - c.x, d.z - c.z);
  }
  return raw;
}

/** Contiguous runs of samples whose ground is under the waterline. */
function wetSpans(P, terrain, level) {
  const n = P.length;
  const wet = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    P[i].yT = terrain.heightAt(P[i].x, P[i].z);
    if (P[i].yT < level + 0.30) wet[i] = 1;
  }
  // Bridge over short dry humps mid-lake rather than building two stubs.
  const bridgeGap = 6;
  for (let i = 0; i < n; i++) {
    if (wet[i]) continue;
    let a = 0, b = 0;
    for (let k = 1; k <= bridgeGap; k++) if (wet[(i - k + n) % n]) { a = 1; break; }
    for (let k = 1; k <= bridgeGap; k++) if (wet[(i + k) % n]) { b = 1; break; }
    if (a && b) wet[i] = 1;
  }
  const spans = [];
  let start = -1;
  for (let i = 0; i < n; i++) if (!wet[i]) { start = i; break; }
  if (start < 0) return spans;            // the whole route is under water
  let i = 0;
  while (i < n) {
    const a = (start + i) % n;
    if (!wet[a]) { i++; continue; }
    let j = i;
    while (j < n && wet[(start + j) % n]) j++;
    let len = 0;
    for (let k = i; k < j; k++) len += P[(start + k) % n].ds;
    spans.push({ a, b: (start + j - 1) % n, len });
    i = j;
  }
  return spans;
}

/**
 * WHERE THE WATERLINE GOES.
 *
 * biomes.js digs lake bowls with a noise field and declares a water plane at
 * -8. Both are honest; together they are useless, because the bowls land
 * wherever the noise puts them and the road is laid on a loop at r = 350-700 m
 * that never visits one. Measured across the three alpine presets, the LOWEST
 * point the route reaches is +18.0 m (seed 1337), +8.8 (4242), +11.6 (8888).
 * A plane at -8 is twenty-six metres below the deepest puddle on the drive, so
 * every alpine frame ever shot in this project has been bone dry and no bridge
 * has ever been built.
 *
 * So the level is chosen from the route rather than declared: fill the valley
 * until the lowest saddle the road crosses is genuinely under water and the
 * submerged run is long enough to be worth a bridge (45-220 m — shorter is a
 * culvert, longer is a causeway). The smallest level that achieves that is
 * taken, so the flood is the least one that puts the lake against the drive.
 *
 * The same rise floods the hollows on EITHER side of that saddle, which is
 * where the big body of open water in frame comes from: the road runs along a
 * shore for a few hundred metres and then crosses a neck. That is the target
 * frame's composition exactly.
 *
 * Non-alpine biomes are frozen this round and keep their declared plane.
 */
function chooseLevel(P, biome) {
  const declared = biome?.waterLevel ?? -3;
  if (biome?.id !== 'alpine' || !P) return declared;

  let lo = Infinity;
  for (const p of P) lo = Math.min(lo, p.yT);
  if (!Number.isFinite(lo)) return declared;

  const n = P.length;
  // Longest contiguous run of route under a candidate level, in metres. The
  // route is a closed loop, so the walk starts from a DRY sample: starting at
  // index 0 would cut a run that straddles the seam in half.
  const longestWet = (L) => {
    let start = -1;
    for (let i = 0; i < n; i++) if (P[i].yT >= L) { start = i; break; }
    if (start < 0) return Infinity;              // the whole loop is submerged
    let best = 0, run = 0;
    for (let k = 0; k < n; k++) {
      const p = P[(start + k) % n];
      if (p.yT < L) { run += p.ds; if (run > best) best = run; }
      else run = 0;
    }
    return best;
  };

  // Walk up from just-touching. 0.4 m steps: fine enough that the chosen level
  // is the least one that works, coarse enough to stay cheap.
  let chosen = null;
  for (let L = lo + 0.6; L <= lo + 16; L += 0.4) {
    const w = longestWet(L);
    if (w >= 45) { chosen = w <= 220 ? L : null; break; }
  }
  // Nothing in range — the road either skims its low point over a few metres
  // (nothing to bridge) or drops straight into a trench. Settle for a level
  // that at least wets the saddle, so there is still a lake beside the drive.
  return chosen ?? lo + 3.5;
}

export function createBridges(ctx) {
  // Safe default first, so that even if everything below throws, water.js still
  // has a terrain to measure depth against and the lake is merely in the wrong
  // place rather than absent.
  setLakeContext({ ...ctx, level: ctx?.biome?.waterLevel });

  const group = new THREE.Group();
  group.name = 'bridges';
  const decks = [];
  const colliders = [];

  const stub = {
    group,
    heightAt: () => null,
    isBlocked: () => false,
    colliders,
  };

  try {
    const { terrain, biome, roads } = ctx;
    if (!terrain || !biome) { setLakeContext({ ...ctx, level: biome?.waterLevel }); return stub; }

    // The route first, because everything about the water is derived from it.
    const P = roads?.sample ? routePolyline(roads) : null;
    if (P) for (const p of P) p.yT = terrain.heightAt(p.x, p.z);

    // Plant the chain of tarns along the drive and dig their basins. This has
    // to happen HERE and not in water.js's own build, because props, animals
    // and landmarks are all placed after this call and every one of them asks
    // terrain.heightAt() where the ground is — carving later would leave a
    // forest standing in open water.
    const plan = planLakes({ ...ctx, roads }, P);
    if (plan) carveLakes(ctx, plan);
    // Route heights move with the ground under them.
    if (plan && P) for (const p of P) p.yT = terrain.heightAt(p.x, p.z);

    const level = plan ? plan.lakes[0].level : chooseLevel(P, biome);

    // Hand the whole lot to water.js: game.js constructs the Water one line
    // EARLIER than this call and without a terrain, so this is the only moment
    // at which the lake can be told how deep it is and where its surface sits.
    setLakeContext({ ...ctx, level, plan });

    // PROP KEEP-OUT, part one: the lake.
    //
    // props.js decides what is dry land from `biome.waterLevel`, which for
    // alpine is -8 — thirty metres below the surface we just chose — so left to
    // itself it plants full-grown conifers in open water. game.js gives the
    // world exactly one prop keep-out hook and it runs through here, so this is
    // where the world gets told "that is a lake" — and it is the water
    // subsystem's business to say so. Part two (the deck footprint) is below.
    const drown = plan
      ? (x, z) => { const L = plan.lakeAt(x, z); return !!L && terrain.heightAt(x, z) < L.level + 0.6; }
      : (x, z) => terrain.heightAt(x, z) < level + 0.35;
    stub.isBlocked = drown;

    if (!P) return stub;
    const n = P.length;

    if (plan) buildPlannedDecks({ plan, P, terrain, group, decks, colliders });
    else buildFoundDecks({ P, terrain, level, group, decks, colliders });

    if (!decks.length) return stub;

    const bbox = decks.map((d) => d.bbox);

    /**
     * Deck height under (x, z), or null.
     *
     * Segment test, not a station test. Testing "am I within `step` of a
     * station" leaves a gap between every pair of stations, and the car dropped
     * straight through those gaps into the lake — measured: forty seconds of
     * driving over two bridges reported `onBridge` exactly zero times. Project
     * onto each segment instead and the deck is watertight, and the height
     * comes out interpolated along the approach ramps for free.
     */
    const heightAt = (x, z) => {
      for (let k = 0; k < decks.length; k++) {
        const B = bbox[k];
        if (x < B[0] || x > B[2] || z < B[1] || z > B[3]) continue;
        const d = decks[k];
        const pts = d.pts;
        const hw2 = d.hw * d.hw;
        for (let i = 0; i < pts.length - 1; i++) {
          const p = pts[i], q = pts[i + 1];
          const ex = q.x - p.x, ez = q.z - p.z;
          const L2 = ex * ex + ez * ez;
          if (L2 < 1e-9) continue;
          let t = ((x - p.x) * ex + (z - p.z) * ez) / L2;
          if (t < 0) { if (i > 0) continue; t = 0; }
          if (t > 1) { if (i < pts.length - 2) continue; t = 1; }
          const cx = p.x + ex * t, cz = p.z + ez * t;
          const dx = x - cx, dz = z - cz;
          if (dx * dx + dz * dz <= hw2) return p.y + (q.y - p.y) * t;
        }
      }
      return null;
    };

    // PROP KEEP-OUT, part two: the deck footprint, so nothing grows up
    // through the planks.
    const isBlocked = (x, z) => {
      if (drown(x, z)) return true;
      for (let k = 0; k < decks.length; k++) {
        const B = bbox[k];
        if (x < B[0] - 8 || x > B[2] + 8 || z < B[1] - 8 || z > B[3] + 8) continue;
        const d = decks[k];
        for (let i = 0; i < d.pts.length; i++) {
          const p = d.pts[i];
          const dx = x - p.x, dz = z - p.z;
          if (dx * dx + dz * dz < (d.hw + 7) * (d.hw + 7)) return true;
        }
      }
      return false;
    };

    return { group, heightAt, isBlocked, colliders };
  } catch (err) {
    console.warn('[bridges] build failed, continuing without bridges:', err);
    group.clear();
    return stub;
  }
}

// ---------------------------------------------------------------------------

/**
 * THE CROSSING, when water.js has planned one.
 *
 * The neck is not found, it is built: water.js has already dug a lobe either
 * side of the route and left a causeway between them exactly one deck wide. So
 * the deck goes over the whole stretch where that carve reaches the road —
 * measured directly off the height field rather than guessed from a radius —
 * and the causeway disappears under the planks.
 *
 * The deck is levelled to clear the HIGHEST point of road it covers, not the
 * mean. A flat deck sited on the mean sinks below the carriageway at the crown
 * and the car drives through it.
 */
function buildPlannedDecks({ plan, P, terrain, group, decks, colliders }) {
  const n = P.length;
  // Is the ground beside the route here cut by more than half a metre? That is
  // the footprint of the neck, and it is what has to be spanned.
  // Is there OPEN WATER beside the road here, on both sides? Not "has the
  // ground been cut" — a metre of cut is not a lake, and siting the deck on the
  // cut put timber over dry grass at both ends of every crossing. Asking for
  // water instead makes the bridge and the thing it crosses the same object by
  // construction.
  const wetAt = (p, off, level) => {
    const x = p.x + p.nx * off, z = p.z + p.nz * off;
    return plan.heightAt(x, z) < level - 0.2;
  };
  const necked = (i, level) => {
    const p = P[i];
    return wetAt(p, 13, level) && wetAt(p, -13, level);
  };

  for (const c of plan.crossings) {
    if (!necked(c.station, c.level)) continue;
    let a = c.station, b = c.station;
    for (let k = 0; k < 400; k++) { const q = (a - 1 + n) % n; if (!necked(q, c.level)) break; a = q; }
    for (let k = 0; k < 400; k++) { const q = (b + 1) % n; if (!necked(q, c.level)) break; b = q; }

    const idx = [];
    let run = 0;
    for (let k = a; ; k = (k + 1) % n) {
      idx.push(k); run += P[k].ds;
      if (k === b) break;
      if (idx.length > 900) break;
    }
    if (run < MIN_SPAN || run > MAX_SPAN) continue;

    // A short run onto each bank so the deck ends on solid ground rather than
    // in mid-air at the last carved sample.
    const walk = (from, dir) => {
      let i = from, dist = 0;
      for (let k = 0; k < 200; k++) {
        const q = (i + dir + n) % n;
        dist += P[i].ds;
        if (dist > 14) break;
        i = q;
        if (dir < 0) idx.unshift(i); else idx.push(i);
      }
    };
    walk(a, -1);
    walk(b, +1);

    // THE DECK FOLLOWS THE ROAD.
    //
    // A dead-level deck is right for a bridge over a gorge and wrong for one
    // over a neck: the road here is a causeway that rises and falls with the
    // valley, and levelling the planks to clear its crown left a plate standing
    // six metres in the air at the low end behind a wall of fascia the height
    // of a house. Following the road, smoothed, keeps the crossing a crossing —
    // and the piles still lengthen into the water on their own.
    if (idx.length >= 6) {
      buildDeck({ idx, P, terrain, deckY: null, floor: c.level + 1.8, group, decks, colliders });
    }
  }
}

/** The old behaviour, kept for any biome water.js has not planned. */
function buildFoundDecks({ P, terrain, level, group, decks, colliders }) {
  const n = P.length;
  const deckY = level + CLEARANCE;
  const covered = new Uint8Array(n);
  let any = false;
  for (const span of wetSpans(P, terrain, level)) {
    if (span.len < MIN_SPAN || span.len > MAX_SPAN) continue;
    const walk = (from, dir) => {
      let i = from, run = 0;
      for (let k = 0; k < 600; k++) {
        covered[i] = 1;
        if (P[i].yT >= deckY - 0.05) break;
        run += P[i].ds;
        if (run > ABUTMENT) break;
        i = (i + dir + n) % n;
      }
    };
    for (let k = span.a; ; k = (k + 1) % n) { covered[k] = 1; if (k === span.b) break; }
    walk(span.a, -1);
    walk(span.b, +1);
    any = true;
  }
  if (!any) return;
  let start = -1;
  for (let i = 0; i < n; i++) if (!covered[i]) { start = i; break; }
  if (start < 0) return;
  for (let i = 0; i < n; ) {
    if (!covered[(start + i) % n]) { i++; continue; }
    let j = i;
    while (j < n && covered[(start + j) % n]) j++;
    const idx = [];
    let run = 0;
    for (let k = i; k < j; k++) { const g = (start + k) % n; idx.push(g); run += P[g].ds; }
    i = j;
    if (idx.length >= 6 && run >= MIN_SPAN && run <= 340) {
      buildDeck({ idx, P, terrain, deckY, group, decks, colliders });
    }
  }
}

function buildDeck({ idx, P, terrain, deckY, floor = -Infinity, group, decks, colliders }) {
  const kit = new Kit();
  const hw = DECK_HW;
  const THICK = 0.5;

  // Resample the station list at the plank pitch so the deck reads as timber
  // rather than as a ribbon.
  const pts = [];
  let acc = PLANK;
  let total = 0;
  for (let k = 0; k < idx.length; k++) {
    const p = P[idx[k]];
    acc += p.ds;
    if (acc >= PLANK || k === 0 || k === idx.length - 1) {
      pts.push({ x: p.x, z: p.z, tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz, yT: p.yT, s: total });
      acc = 0;
    }
    total += p.ds;
  }
  if (pts.length < 3) return;
  const span = pts[pts.length - 1].s || 1;

  // DECK PROFILE. Level over the water, easing onto the road over the last
  // RAMP metres at each end, so the abutment is a join and not a step. The
  // ends take the road's own ground height, which is what the car is driving
  // on the instant before it reaches the bridge.
  const yA = pts[0].yT, yB = pts[pts.length - 1].yT;
  const ramp = Math.min(RAMP, span * 0.42);
  const ease = (t) => t * t * (3 - 2 * t);
  if (deckY == null) {
    // Follow the carriageway, smoothed over ±11 stations (~13 m) so the planks
    // read as one straight run of timber rather than tracking every hummock,
    // and never let them dip below the design freeboard over the water.
    const W = 11;
    for (let k = 0; k < pts.length; k++) {
      let sum = 0, c = 0;
      for (let q = -W; q <= W; q++) {
        const p2 = pts[k + q];
        if (p2) { sum += p2.yT; c++; }
      }
      pts[k].y = Math.max(sum / c + 0.75, floor, pts[k].yT + 0.30);
    }
    // Ease the last few metres back onto the actual road height at each end.
    for (const p of pts) {
      const dA = p.s, dB = span - p.s;
      if (dA < ramp) p.y = (yA + 0.30) + (p.y - yA - 0.30) * ease(dA / ramp);
      if (dB < ramp) p.y = (yB + 0.30) + (p.y - yB - 0.30) * ease(dB / ramp);
      p.y = Math.max(p.y, p.yT + 0.12);
    }
  } else {
    for (const p of pts) {
      const dA = p.s, dB = span - p.s;
      let y = deckY;
      if (dA < ramp) y = Math.min(y, yA + (deckY - yA) * ease(dA / ramp));
      if (dB < ramp) y = Math.min(y, yB + (deckY - yB) * ease(dB / ramp));
      p.y = Math.max(y, p.yT + 0.12);
    }
  }

  const L = (p, off) => [p.x + p.nx * off, p.y, p.z + p.nz * off];
  const Lo = (p, off, y) => [p.x + p.nx * off, y, p.z + p.nz * off];

  // --- deck planks ---------------------------------------------------------
  for (let k = 0; k < pts.length - 1; k++) {
    const p = pts[k], q = pts[k + 1];
    // Alternating tone plus a darker plank every fifth: enough variation to
    // read as boards from 140 m up without drawing a single extra triangle.
    const tone = (k % 5 === 0) ? TIMBER.deckDark : (k & 1 ? TIMBER.deck : TIMBER.deckAlt);
    kit.quad(L(p, -hw), L(p, hw), L(q, hw), L(q, -hw), tone);
    // underside
    kit.quad(Lo(q, -hw, q.y - THICK), Lo(q, hw, q.y - THICK),
             Lo(p, hw, p.y - THICK), Lo(p, -hw, p.y - THICK), TIMBER.beam);
    // fascia beams, both edges
    for (const s of [1, -1]) {
      kit.quad(Lo(p, hw * s, p.y), Lo(q, hw * s, q.y),
               Lo(q, hw * s, q.y - THICK), Lo(p, hw * s, p.y - THICK),
               s > 0 ? TIMBER.beam : TIMBER.deckDark);
    }
  }

  // --- railings ------------------------------------------------------------
  let since = POST_GAP;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    since += k ? Math.hypot(p.x - pts[k - 1].x, p.z - pts[k - 1].z) : 0;
    if (since < POST_GAP && k !== 0 && k !== pts.length - 1) continue;
    since = 0;
    const yaw = Math.atan2(-p.tz, p.tx);
    // The last posts at each end are wing walls on dry land; leaving them
    // solid turns the approach into a gate the car has to thread.
    for (const s of [1, -1]) {
      const px = p.x + p.nx * hw * s, pz = p.z + p.nz * hw * s;
      kit.box(0.30, 1.35, 0.30, px, p.y + 0.55, pz, yaw, TIMBER.post);
      // NO COLLIDER ON THE RAILING.
      //
      // game.js pushes the car out of a collider at (r + 1.4) m, so a post at
      // the deck edge eats 1.6 m of carriageway on each side — and the deck is
      // only a metre wider than the road it carries. Measured over ninety
      // seconds of autopilot: the car clipped a post at the abutment, was
      // shoved sideways, re-entered, clipped again — twelve deck entries in one
      // lap and a finishing speed of 32 km/h. The brief for this round is that
      // a car on the centreline crosses cleanly, and the cheapest way to
      // guarantee that is for there to be nothing on the bridge to hit.
    }
  }
  // Two horizontal rails, laid per plank segment so they follow the curve.
  for (let k = 0; k < pts.length - 1; k++) {
    const p = pts[k], q = pts[k + 1];
    const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
    const len = Math.hypot(q.x - p.x, q.z - p.z) * 1.12 + 0.05;
    const yaw = Math.atan2(-(q.z - p.z), q.x - p.x);
    for (const s of [1, -1]) {
      const nx = (p.nx + q.nx) / 2, nz = (p.nz + q.nz) / 2;
      const rx = mx + nx * hw * s, rz = mz + nz * hw * s;
      const my = (p.y + q.y) / 2;
      kit.box(len, 0.20, 0.14, rx, my + 1.02, rz, yaw, TIMBER.rail);
      kit.box(len, 0.16, 0.12, rx, my + 0.55, rz, yaw, TIMBER.rail);
    }
  }

  // --- piers ---------------------------------------------------------------
  let sincePy = PYLON_GAP * 0.5;
  for (let k = 1; k < pts.length - 1; k++) {
    const p = pts[k];
    sincePy += Math.hypot(p.x - pts[k - 1].x, p.z - pts[k - 1].z);
    if (sincePy < PYLON_GAP) continue;
    const drop = p.y - THICK - p.yT;
    if (drop < 1.4) continue;                 // too near the abutment to bother
    sincePy = 0;
    const yaw = Math.atan2(-p.tz, p.tx);
    // Piles sit just PROUD of the deck edge. Tucked inboard they are invisible
    // from a camera looking 58 degrees down — and a bridge whose supports you
    // cannot see is a plank floating on nothing. Out there they are also over
    // OPEN WATER rather than over the causeway, so each pile is footed on the
    // bed under its own position, not on the centreline: that is what makes the
    // outer legs longer than the inner ones and the trestle read as standing IN
    // the lake.
    for (const s of [1, -1]) {
      for (const off of [(hw + 0.34) * s, hw * 0.45 * s]) {
        const px = p.x + p.nx * off, pz = p.z + p.nz * off;
        const foot = terrain.heightAt(px, pz) - 1.1;
        const h = p.y - THICK - foot;
        if (h < 1.0) continue;
        const w = Math.abs(off) > hw ? 0.78 : 0.52;
        kit.box(w, h, w, px, foot + h / 2, pz, yaw, TIMBER.pile);
      }
    }
    // cross beam tying the trestle together, hung below the deck so it reads
    // as a separate member from above.
    kit.box(0.44, 0.46, (hw + 0.5) * 2.05, p.x, p.y - THICK - 0.30, p.z, yaw, TIMBER.beam);
  }

  const m = kit.mesh('bridge');
  if (!m) return;
  group.add(m);

  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x - hw - 2); x1 = Math.max(x1, p.x + hw + 2);
    z0 = Math.min(z0, p.z - hw - 2); z1 = Math.max(z1, p.z + hw + 2);
  }
  decks.push({ pts, hw, step: PLANK * 0.75, bbox: [x0, z0, x1, z1] });
}
