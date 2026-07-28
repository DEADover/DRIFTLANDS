import * as THREE from 'three';
import { setLakeContext, lakeLevel } from './lake.js';

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
// Half width of the deck. The carriageway is 8 m wide with a 1.05 m verge, so
// anything under ~6.6 puts the railing posts inside the road: game.js pushes
// the car out of a collider at (r + 1.4) m, and with the posts at 5.6 a car
// merely running wide on its own carriageway was being speared at the abutment
// and thrown off the bridge into the lake. Measured before the change: the
// preset drive hit 139 km/h, collided at the bridge mouth, and dropped to 50.
const DECK_HW = 6.8;
const PLANK = 1.15;      // plank pitch along the deck
const POST_GAP = 3.6;    // railing post pitch
const PYLON_GAP = 9.5;   // pier pitch
const MIN_SPAN = 10;     // shorter than this and it is a culvert, not a bridge
const MAX_SPAN = 400;
const ABUTMENT = 26;     // how far onto each bank the deck may reach
const RAMP = 15;         // over how many metres the deck settles onto the road

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

export function createBridges(ctx) {
  // Hand the terrain to water.js (see lake.js): game.js constructs the Water
  // one line earlier without one, and the lake needs to know how deep it is.
  setLakeContext(ctx);

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
    if (!terrain || !biome) return stub;
    const level = lakeLevel(biome);

    // PROP KEEP-OUT, part one: the lake.
    //
    // props.js decides what is dry land from `biome.waterLevel`, which for
    // alpine is -17, so with the lake filled to -5 it happily plants full-grown
    // conifers eight metres under the surface. game.js gives the world exactly
    // one prop keep-out hook and it runs through here, so this is where the
    // world gets told "that is a lake" — and it is the water subsystem's
    // business to say so. Part two (the deck footprint) is added below.
    const drown = level + 0.35;
    stub.isBlocked = (x, z) => terrain.heightAt(x, z) < drown;

    if (!roads?.sample) return stub;
    const P = routePolyline(roads);
    if (!P) return stub;
    const n = P.length;

    const deckY = level + CLEARANCE;

    // Mark every route sample the deck has to cover: the wet span itself plus
    // the approach on each bank, walked outward until the ground has climbed
    // to the deck (or ABUTMENT metres, whichever comes first — a bank that
    // shelves gently must not turn the bridge into a viaduct).
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
        return i;
      };
      for (let k = span.a; ; k = (k + 1) % n) { covered[k] = 1; if (k === span.b) break; }
      walk(span.a, -1);
      walk(span.b, +1);
      any = true;
    }
    if (!any) return stub;

    // Merge into runs. Two spans a hundred metres apart on the same lake would
    // otherwise produce overlapping decks stacked on each other.
    let start = -1;
    for (let i = 0; i < n; i++) if (!covered[i]) { start = i; break; }
    if (start < 0) return stub;
    for (let i = 0; i < n; ) {
      if (!covered[(start + i) % n]) { i++; continue; }
      let j = i;
      while (j < n && covered[(start + j) % n]) j++;
      const idx = [];
      let run = 0;
      for (let k = i; k < j; k++) {
        const g = (start + k) % n;
        idx.push(g);
        run += P[g].ds;
      }
      i = j;
      if (idx.length >= 6 && run >= MIN_SPAN && run <= 340) {
        buildDeck({ idx, P, terrain, deckY, group, decks, colliders });
      }
    }

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
      if (terrain.heightAt(x, z) < drown) return true;
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

function buildDeck({ idx, P, terrain, deckY, group, decks, colliders }) {
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
  for (const p of pts) {
    const dA = p.s, dB = span - p.s;
    let y = deckY;
    if (dA < ramp) y = Math.min(y, yA + (deckY - yA) * ease(dA / ramp));
    if (dB < ramp) y = Math.min(y, yB + (deckY - yB) * ease(dB / ramp));
    p.y = Math.max(y, p.yT + 0.12);
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
    const endish = p.s < 9 || (span - p.s) < 9;
    for (const s of [1, -1]) {
      const px = p.x + p.nx * hw * s, pz = p.z + p.nz * hw * s;
      kit.box(0.30, 1.35, 0.30, px, p.y + 0.55, pz, yaw, TIMBER.post);
      if (!endish) colliders.push({ x: px, z: pz, r: 0.22 });
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
    const bed = p.yT;
    const drop = p.y - THICK - bed;
    if (drop < 1.4) continue;                 // too near the abutment to bother
    sincePy = 0;
    const yaw = Math.atan2(-p.tz, p.tx);
    const foot = bed - 1.1;
    const h = p.y - THICK - foot;
    // Piles sit just PROUD of the deck edge. Tucked inboard they are invisible
    // from a camera looking 58 degrees down — and a bridge whose supports you
    // cannot see is a plank floating on nothing.
    for (const s of [1, -1]) {
      const off = (hw + 0.34) * s;
      kit.box(0.78, h, 0.78, p.x + p.nx * off, foot + h / 2, p.z + p.nz * off, yaw, TIMBER.pile);
      // inner pile of the trestle, raked in a little
      const off2 = hw * 0.42 * s;
      kit.box(0.52, h, 0.52, p.x + p.nx * off2, foot + h / 2, p.z + p.nz * off2, yaw, TIMBER.pile);
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
