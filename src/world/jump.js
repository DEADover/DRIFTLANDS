import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { lakeColors } from './water.js';

/**
 * THE JUMP — one built set-piece per stage: a take-off crest, a stream, a
 * landing ramp.
 *
 * CONTRACT:
 *   createJump(ctx) -> {
 *     group: THREE.Object3D
 *     heightAt(x, z) -> number|null   ramp/landing surface, null off it
 *     isBlocked(x, z) -> boolean      prop keep-out
 *     colliders: {x,z,r}[]            empty by design — see WHY NOTHING IS SOLID
 *     site: { x, z, heading, gap }    diagnostics
 *   }
 *
 * ctx = { terrain, biome, palette, seed, roads, water }
 *
 * WHERE IT GOES IN game.groundAt's CHAIN
 * --------------------------------------
 * `groundAt` resolves bridges -> roads -> terrain and takes the TOPMOST DRAWN
 * surface. This module's crown is an EMBANKMENT BUILT ON THE CARRIAGEWAY, so it
 * is drawn over the ribbon and over the terrain, and it therefore belongs at the
 * top of the same max — folded into the ROAD branch, not ahead of it as a
 * separate case. Two reasons it must be the road branch and not a bridge-style
 * branch of its own:
 *
 *   1. The bridge branch returns a hard UP normal, because a deck is level. A
 *      jump ramp is nothing BUT gradient: `_stepVertical` resolves gravity along
 *      `g.normal`, so with UP the car would climb a 1:4 face for free and get
 *      nothing back down the landing. The road branch takes its normal from
 *      central differences over `surfaceHeight`, which is exactly right here —
 *      provided `surfaceHeight` is taught about the ramp too. Wire BOTH.
 *   2. `onRoad: true` is the truth. The crown is the carriageway, ochre and
 *      graded; the grip, the dust colour and the tyre note should not change
 *      because the road has been built up four metres.
 *
 * See the report / the `WIRING` note at the foot of this file for the exact
 * three lines.
 *
 * ---------------------------------------------------------------------------
 * THE PHYSICS THIS IS SIZED TO — MEASURED, NOT ASSUMED
 *
 * `game.js _stepVertical` integrates `_carVY -= 22 * dt` and then CLAMPS:
 *
 *     if (this._carY <= ground) { this._carY = ground; this._carVY = 0; }
 *
 * The clamp runs every frame the wheels are down, so a car climbing a ramp
 * arrives at the lip with `_carVY` EXACTLY ZERO. **The ramp angle contributes
 * nothing to the launch.** There is no upward impulse anywhere in the build —
 * a jump here is a horizontal throw off a ledge, and its range is set by two
 * numbers only: how high the lip stands over the surface it lands on, and how
 * fast the car is going.
 *
 *     t = sqrt(2 * drop / 22)          range = speed * t
 *
 * Measured on this route (tools/jump-site.mjs, autopilot at aggression 0.85,
 * full throttle): the car crosses the chosen straight at 39.6 m/s and holds it
 * to within 0.3 m/s over the whole 322 m. So the design point is 39.6 m/s and
 * every constant below is derived from it. What the build actually does with
 * them (tools/jump-test.mjs, the real vehicle at the real 60 Hz step):
 *
 *   target  take-off   air     flown   landed at   on
 *   39.6      37.8    0.600 s  22.9 m    22.8 m    the landing ramp, past the crest
 *   31.7      31.2    0.600    19.4      19.0      the bank face, 3.5 m past the water
 *   23.8      23.3    0.667    16.8      16.4      the bank face, 0.9 m past the water
 *   19.8      19.8    0.700    15.3      15.0      WET, 0.5 m short
 *
 * So the 15.5 m of water is cleared from about 21 m/s — 53% of the speed the
 * straight is really driven at — comfortably at 80%, and at 100% the car comes
 * down past the landing crest onto the run-out. That is the client's fairness
 * bar with room to spare, and it is where the gap width came from: 20 m would
 * need 68% and 24 m would need 82%, which stops being a jump and starts being a
 * gate.
 *
 * The climb costs 1.8 m/s, measured, not estimated: the approach face is 1:4 at
 * its steepest and `_stepVertical` only bleeds speed hard past a 0.53 slope, so
 * 0.25 stays well clear of the wall and all that is paid is g*sin(theta) over
 * 30 m. Landing speed is HIGHER than take-off speed in every row above — the
 * run-out gives it all back.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STREAM IS A FORD AND NOT A CHASM
 *
 * The obvious build — cut the road, put a gorge in the hole — cannot be done
 * from this module and should not be faked. `roads.heightAt` answers with the
 * ribbon wherever the ribbon is drawn, and the ribbon is a mesh roads.js owns;
 * nothing here can put a hole in either without reaching into another owner's
 * geometry at runtime. So the road stays whole and the stream crosses it the
 * way a stream actually crosses a rally road: as a ford. The gap between the
 * two revetments is 13 m of water lying on the carriageway, the channel is
 * incised into the meadow on the uphill side, and on the downhill side — where
 * this route runs along the lip of a 10 m fall to the tarn — it goes over as a
 * cascade. Which is also why the car being short is survivable: you land in a
 * hand's depth of water on a road, not in a river.
 *
 * NOTHING HERE MAY THROW. bridges.js learned this the expensive way; the whole
 * build sits in one try/catch and the fallback is a world with no jump.
 */

const clamp = THREE.MathUtils.clamp;
/** Boundary tolerance for `heightAt`. See the note in it. */
const EDGE = 1e-6;

// ---------------------------------------------------------------------------
// THE EARTHWORK, in metres. Every one of these answers to the ballistics note
// above; do not move one without re-running tools/jump-test.mjs.
// ---------------------------------------------------------------------------

const LIP_H = 5.0;      // take-off lip over the carriageway
const LAND_H = 1.55;    // landing crest over the carriageway
const GAP = 15.5;       // lip to the toe of the landing bank — the water
const TABLE = 2.6;      // flat top before the lip, so the car leaves level
/** A timber sill at the water's edge, so the far bank reads as built. Low
 *  enough that clipping it on a short jump is a bump, not a wall — and it is
 *  the height every "does it clear" number below is measured to. */
const LAND_TOE = 0.30;

/** Approach face. The smoothstep doubles the mean slope at its midpoint, so the
 *  run has to be 1.5x what a straight 1:4 would need to keep the MAXIMUM at
 *  0.25 — well under `_stepVertical`'s 0.53 speed-bleed wall. */
const APPROACH = (1.5 * LIP_H) / 0.25;              // 30.0 m

/**
 * THE LANDING, and why it is LOW.
 *
 * With no launch impulse the flight is a falling parabola, so the trajectory is
 * already on its way down when it reaches the far bank and it keeps steepening.
 * A tall landing crest is therefore worse than a short one: the arc runs into
 * its UPHILL face and the car lands into a rise. Sized so the design trajectory
 * passes 0.35 m OVER the crest and comes down on the far side —
 *
 *     crest 1.55 m at s = 21.0     design arc there: 1.76 m
 *
 * — and the run-out is then a shallow 1:8 rather than matched to the arc,
 * because a run-out matched to the arc is tangent to it and the car grazes all
 * the way to the bottom before it touches (measured: it did exactly that, and
 * landed 24.2 m out on ground 8 cm above the road, which is a jump with no
 * landing ramp in it).
 */
const LAND_FACE = (LAND_H - LAND_TOE) / 0.227;      // 5.5 m
const LAND_RUN = LAND_H / 0.125;                    // 12.4 m

/** Half width of the crown.
 *
 * MEASURED, not chosen: roads.js runs its post-and-rail fence at u = 9.1-9.5 m
 * along the whole of this straight (tools/_q.mjs). An embankment with a battered
 * flank wide enough to reach 4.6 m of height would bury sixty metres of it, so
 * the flanks are timber crib walls instead — near vertical, the way a built-up
 * road really is retained — and the crown stops a clear half metre inside the
 * fence line. 8.3 m either side is still 16.6 m of top, against an 11 m
 * carriageway: the racing line is never near an edge. */
const CROWN_HW_MAX = 8.3;
/** Crib-wall batter: 1 in 8, which is what a timber crib is built to. */
const CRIB_BATTER = 0.125;

/** How far the ramp footprint reaches beyond the earthwork, so the surface
 *  hands back to the road with a 4 cm lip rather than a step. */
const APRON = 5.0;

const S0 = -(APPROACH + TABLE + APRON);
const S1 = GAP + LAND_FACE + LAND_RUN + APRON;

/** Node pitch of the (s, u) lattice. The mesh and `heightAt` share it, so the
 *  query is the drawn triangle and not an approximation of it. */
const DS = 1.05;
const DU = 0.83;

// ---------------------------------------------------------------------------
// THE STREAM
// ---------------------------------------------------------------------------

/** Water surface over the carriageway at the ford. A hand's depth: deep enough
 *  to read as water from a camera 50 degrees off the horizontal, shallow enough
 *  that landing in it is a splash. */
const FORD_D = 0.14;
/** How far up- and downstream the channel is drawn. */
const UP_REACH = 46;
const DOWN_REACH = 58;
/** Nothing is carved inside this distance of the centreline: roads.js built its
 *  ribbon, its shoulders and its fence feet against the terrain as it was, and
 *  planLakes keeps off the corridor for exactly the same reason. */
const CORRIDOR = 11.0;

// ---------------------------------------------------------------------------
// COLOUR. ART_DIRECTION section 6, alpine: road #c9a45f, grass #5faa3c-#7cc24a.
// The crown is the carriageway, so it is the road's own ochre; the earth flanks
// are that ochre taken down and warmed, which is what a fresh cut in a dirt road
// looks like; the timber is the same species bridges.js uses for its rails, so a
// crib wall and a bridge parapet are the same wood.
// ---------------------------------------------------------------------------

const OCHRE = 0xc9a45f;
const EARTH = 0x9a7a48;
const EARTH_DK = 0x7d6038;

/**
 * THE CROWN'S COLOUR IS TAKEN OFF THE ROAD, NOT OFF THE SPEC.
 *
 * ART_DIRECTION section 6 gives alpine road #c9a45f, and painting the crown with
 * it produced a bright orange plateau sitting in a muted olive-ochre carriageway
 * — conspicuously a different material laid on top of the road rather than the
 * road built up. roads.js does not ship the spec colour either; it pulls the
 * ribbon part of the way onto it from the palette's grey-brown and then shades
 * every quad. So this reads the ribbon's OWN vertex colours near the site and
 * averages them. Whatever roads.js decides the road looks like this seed, the
 * ramp is the same thing four metres higher.
 */
function roadColourNear(roads, x, z, fallback) {
  const out = new THREE.Color(fallback);
  try {
    let r = 0, g = 0, b = 0, n = 0;
    roads.group.traverse((o) => {
      const geo = o.isMesh && o.geometry;
      const pos = geo?.attributes?.position, col = geo?.attributes?.color;
      if (!pos || !col) return;
      for (let i = 0; i < pos.count; i += 7) {
        const dx = pos.getX(i) - x, dz = pos.getZ(i) - z;
        if (dx * dx + dz * dz > 3600) continue;
        r += col.getX(i); g += col.getY(i); b += col.getZ(i); n++;
      }
    });
    if (n > 40) out.setRGB(r / n, g / n, b / n);
  } catch { /* the fallback is the spec ochre; never worth throwing over */ }
  return out;
}
const TIMBER = 0x8f5f37;
const TIMBER_DK = 0x6b4526;
const TIMBER_HI = 0xa8734a;
const STONE = 0x8f9099;
const STONE_DK = 0x6c6d75;

// ---------------------------------------------------------------------------
// Geometry accumulator — same shape as the one in bridges.js, for the same
// reason: a few thousand flat-shaded triangles, one mesh, no fuss.
// ---------------------------------------------------------------------------

class Kit {
  constructor() { this.pos = []; this.nor = []; this.col = []; }

  /** Quad from four world-space corners, wound a-b-c / a-c-d. */
  quad(a, b, c, d, color) {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }

  /**
   * A quad that is GUARANTEED to face the way you meant it to.
   *
   * Winding by hand cost this module a whole render: the crown was emitted
   * a-b-c over the (s, u) lattice, whose cross product comes out with a negative
   * y for this frame's handedness, so five metres of earthwork was back-face
   * culled and the shot came back showing a flat road with a stack of logs lying
   * on it. Every face here now declares the direction it is supposed to look in
   * and the winding is derived, not asserted.
   */
  facing(a, b, c, d, color, ox, oy, oz) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * ox + ny * oy + nz * oz >= 0) this.quad(a, b, c, d, color);
    else this.quad(a, d, c, b, color);
  }

  /** Two triangles of a lattice cell, both facing up. */
  top(a, b, c, d, color) { this.facing(a, b, c, d, color, 0, 1, 0); }

  tri(a, b, c, color) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const il = 1 / (Math.hypot(nx, ny, nz) || 1);
    nx *= il; ny *= il; nz *= il;
    const col = new THREE.Color(color);
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(col.r, col.g, col.b);
    }
  }

  box(w, h, d, x, y, z, yaw, color) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z));
    const gg = g.toNonIndexed ? g.toNonIndexed() : g;
    const p = gg.attributes.position.array, n = gg.attributes.normal.array;
    const col = new THREE.Color(color);
    for (let i = 0; i < p.length; i += 3) {
      this.pos.push(p[i], p[i + 1], p[i + 2]);
      this.nor.push(n[i], n[i + 1], n[i + 2]);
      this.col.push(col.r, col.g, col.b);
    }
    g.dispose?.();
  }

  mesh(name, opts = {}) {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
      vertexColors: true, flatShading: true, ...opts,
    }));
    m.name = name;
    m.castShadow = opts.castShadow !== false;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    return m;
  }
}

const smooth = (t) => { const q = clamp(t, 0, 1); return q * q * (3 - 2 * q); };

/** Softmin, so the landing crest is a rounded ridge instead of a knife edge a
 *  car can come down astride. k = 5 rounds it over about 1.5 m. */
function softmin(a, b, k = 5) {
  return -Math.log(Math.exp(-k * a) + Math.exp(-k * b)) / k;
}

/** Height of the earthwork above the carriageway, `s` metres past the lip. */
function profile(s) {
  if (s <= -(APPROACH + TABLE) || s >= GAP + LAND_FACE + LAND_RUN) return 0;
  if (s <= 0) {
    if (s >= -TABLE) return LIP_H;
    return LIP_H * smooth((s + APPROACH + TABLE) / APPROACH);
  }
  if (s < GAP) return 0;                       // the water: no surface at all
  const a = s - GAP;
  const up = LAND_TOE + (LAND_H - LAND_TOE) * (a / LAND_FACE);
  const down = LAND_H * (1 - (a - LAND_FACE) / LAND_RUN);
  return Math.max(0, softmin(up, down));
}

// ===========================================================================
// SITING
// ===========================================================================

/**
 * Walk the route and find the one place this belongs.
 *
 * A jump wants four things at once and they do not often coincide, so all four
 * are scored rather than filtered:
 *
 *   STRAIGHT   — the footprint is 76 m long and is queried through a FIXED
 *                frame (see `heightAt`), so the centreline may not wander more
 *                than a metre from the chord over that length. That is also
 *                exactly the condition for the car arriving straight.
 *   FAST       — a long low-curvature run before the site, because approach
 *                speed is the whole of the range. Scored as the length of the
 *                straight the site sits in, with the site placed two thirds of
 *                the way along it so the car has finished accelerating.
 *   LEVEL      — a road grade under 4%, or the drop from the lip is not the
 *                drop the ballistics were computed from.
 *   A STREAM   — one side of the road distinctly higher than the other over
 *                thirty metres. That is where a stream can come from and where
 *                it can go, and without it the water is an invention.
 */
function chooseSite(ctx) {
  const { roads, terrain, bridges } = ctx;
  const N = 900;
  const S = [];
  for (let i = 0; i < N; i++) {
    const p = roads.sample(i / N);
    if (!p) return null;
    S.push(p);
  }
  const ds = roads.length / N;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  // Length of the low-curvature run each station belongs to, and how far into it
  // the station is. Radius over 220 m is the same threshold tools/jump-site.mjs
  // used to find the 322 m straight this ships on.
  const KMAX = 1 / 220;
  const straight = new Array(N).fill(false);
  for (let i = 0; i < N; i++) {
    straight[i] = Math.abs(wrap(S[(i + 1) % N].heading - S[i].heading)) / ds <= KMAX;
  }
  const runLen = new Array(N).fill(0);
  const runPos = new Array(N).fill(0);
  for (let i = 0; i < N; i++) {
    if (!straight[i]) continue;
    let a = 0, b = 0;
    while (a < N && straight[(i - a - 1 + N) % N]) a++;
    while (b < N && straight[(i + b + 1) % N]) b++;
    runLen[i] = (a + b + 1) * ds;
    runPos[i] = (a + 0.5) / (a + b + 1);
  }

  let best = null;
  for (let i = 0; i < N; i++) {
    if (runLen[i] < 150) continue;
    // Two thirds along the straight: the car is up to speed, and there is still
    // room to gather it up before the next corner.
    if (runPos[i] < 0.45 || runPos[i] > 0.85) continue;

    const p = S[i];
    const fx = Math.cos(p.heading), fz = -Math.sin(p.heading);
    const nx = -fz, nz = fx;

    // Chord deviation over the footprint. The frame is straight; the road must
    // be too.
    let dev = 0;
    for (let k = -Math.ceil(-S0 / ds); k <= Math.ceil(S1 / ds); k++) {
      const q = S[(i + k + N) % N];
      dev = Math.max(dev, Math.abs((q.x - p.x) * nx + (q.z - p.z) * nz));
    }
    if (dev > 1.1) continue;

    // Grade, and no bridge anywhere near.
    const y0 = roads.heightAt(p.x + fx * S0, p.z + fz * S0);
    const y1 = roads.heightAt(p.x + fx * S1, p.z + fz * S1);
    if (y0 == null || y1 == null) continue;
    if (Math.abs(y1 - y0) / (S1 - S0) > 0.04) continue;
    let bridged = false;
    for (let k = -30; k <= 30 && !bridged; k += 3) {
      if (bridges?.heightAt?.(p.x + fx * k, p.z + fz * k) != null) bridged = true;
    }
    if (bridged) continue;

    // The stream line: how much lower one flank is than the other at 30 m.
    const hi = terrain.drawnHeightAt(p.x + nx * 30, p.z + nz * 30);
    const lo = terrain.drawnHeightAt(p.x - nx * 30, p.z - nz * 30);
    const fall = Math.abs(hi - lo);
    if (fall < 3.5) continue;

    const score = runLen[i] * 0.02 + fall * 0.9 - dev * 4;
    if (!best || score > best.score) {
      best = {
        i, t: i / N, x: p.x, z: p.z, heading: p.heading,
        fx, fz, nx, nz, dev, fall, runLen: runLen[i], runPos: runPos[i],
        // +1 when the HIGH ground is on the +n side. The stream runs from there.
        side: hi >= lo ? 1 : -1,
        score,
      };
    }
  }
  return best;
}

// ===========================================================================
// BUILD
// ===========================================================================

export function createJump(ctx) {
  try {
    return build(ctx);
  } catch (e) {
    console.warn('[jump] disabled:', e);
    return stub();
  }
}

function stub() {
  const group = new THREE.Group();
  group.name = 'jump';
  return {
    group,
    heightAt: () => null,
    isBlocked: () => false,
    colliders: [],
    site: null,
  };
}

function build(ctx) {
  const { terrain, roads, palette, biome, seed = 1337 } = ctx;
  if (!roads?.sample || !roads?.heightAt) return stub();

  const site = chooseSite(ctx);
  if (!site) return stub();

  const group = new THREE.Group();
  group.name = 'jump';
  const rng = new Rng(seed * 7919 + 104729);

  const CROWN_C = roadColourNear(roads, site.x, site.z, OCHRE);
  const FLANK_C = CROWN_C.clone().multiplyScalar(0.80).lerp(new THREE.Color(EARTH), 0.35);
  const FLANK_D = CROWN_C.clone().multiplyScalar(0.58).lerp(new THREE.Color(EARTH_DK), 0.35);

  const { x: ox, z: oz, fx, fz, nx, nz } = site;
  const toWorld = (s, u) => [ox + fx * s + nx * u, oz + fz * s + nz * u];

  /**
   * THE CROWN STOPS WHERE THE ROAD'S OWN SURFACE STOPS.
   *
   * 8.3 m was chosen off the fence line (u = 9.1-9.5 here) and that is the right
   * ceiling — but `roads.outerEdgeAt` measures 6.9 m at some stations of this
   * very straight and over 10 m at others, and where the ribbon is narrow the
   * band between it and the crown edge is built on TERRAIN, which is drawn half
   * a metre under the ribbon that is still painted over it. Measured: 0.66 m of
   * ribbon standing proud of the apron at s = -7.5, u = 8.5. Taking the minimum
   * the ribbon reaches anywhere in the footprint means the earthwork is always
   * built on road, never on the crack beside it — and it narrows the crown from
   * 16.6 m to 13.3 m, which also stops the thing reading as a loading dock.
   */
  const CROWN_HW = (() => {
    let hw = CROWN_HW_MAX;
    for (let s = S0; s <= S1; s += 1.0) {
      const [wx, wz] = toWorld(s, 0);
      const e = roads.outerEdgeAt?.(wx, wz);
      if (Number.isFinite(e)) hw = Math.min(hw, e - 0.25);
    }
    return Math.max(6.0, hw);
  })();

  /** The surface this earthwork is built ON: whatever is already drawn there. */
  const baseAt = (x, z) => {
    const r = roads.heightAt(x, z);
    return r != null ? r : terrain.drawnHeightAt(x, z);
  };

  // -------------------------------------------------------------------------
  // THE LATTICE. Drawn and queried off the same node table, so `heightAt` IS
  // the triangle on screen — the discipline bridges.js proved it needs.
  // -------------------------------------------------------------------------
  //
  // The s-nodes are TWO uniform runs, not one: the take-off lip and the far
  // bank have to fall exactly ON a node, or the cell that straddles each of them
  // is neither drawn nor answered and the water silently grows by a node pitch
  // at both ends. Measured before this was split: a nominal 13.0 m gap queried
  // as 15.0 m, which is two whole metres of range the ballistics never budgeted.
  const nA = Math.max(2, Math.round((0 - S0) / DS) + 1);
  const nL = Math.max(2, Math.round((S1 - GAP) / DS) + 1);
  const sNodes = new Float64Array(nA + nL);
  for (let j = 0; j < nA; j++) sNodes[j] = S0 + (j * (0 - S0)) / (nA - 1);
  for (let j = 0; j < nL; j++) sNodes[nA + j] = GAP + (j * (S1 - GAP)) / (nL - 1);
  const NS = nA + nL;
  const JVOID = nA - 1;                     // the one cell with no surface in it
  const NU = Math.round((2 * CROWN_HW) / DU) + 1;
  const sAt = (j) => sNodes[j];
  const uAt = (k) => -CROWN_HW + (k * 2 * CROWN_HW) / (NU - 1);

  const Y = new Float64Array(NS * NU);
  const BASE = new Float64Array(NS * NU);
  for (let j = 0; j < NS; j++) {
    const s = sAt(j);
    const h = profile(s);
    for (let k = 0; k < NU; k++) {
      const [wx, wz] = toWorld(s, uAt(k));
      const b = baseAt(wx, wz);
      BASE[j * NU + k] = b;
      // 4 cm proud even where the earthwork has died away, so the crown never
      // z-fights the ribbon it is lying on.
      Y[j * NU + k] = b + Math.max(h, 0.04);
    }
  }

  const lipY = (() => {
    // The lip's own height, taken at the centreline, is the number every
    // measurement in the report is quoted against.
    const [wx, wz] = toWorld(-0.5, 0);
    return baseAt(wx, wz) + LIP_H;
  })();
  const fordY = (() => {
    const [wx, wz] = toWorld(GAP * 0.5, 0);
    return baseAt(wx, wz) + FORD_D;
  })();

  // -------------------------------------------------------------------------
  // heightAt — the same two triangles the mesh emits for this cell.
  // -------------------------------------------------------------------------
  function heightAt(x, z) {
    const dx = x - ox, dz = z - oz;
    const s = dx * fx + dz * fz;
    const u = dx * nx + dz * nz;
    // The footprint owns its own closing edges, to a micron. Sampling exactly on
    // one is not a corner case a probe has to avoid — it is where the crown meets
    // the road, and the audit walks it.
    if (s <= S0 - EDGE || s >= S1 + EDGE) return null;
    if (u <= -CROWN_HW - EDGE || u >= CROWN_HW + EDGE) return null;
    // A MICRON OF TOLERANCE AT THE TWO EDGES OF THE GAP.
    //
    // `s` is a dot product of (p - origin) with the frame's forward vector, and
    // the frame's normal is only perpendicular to it to within rounding — so a
    // point sitting exactly ON the lip comes back as s = +1e-17, fell into the
    // water test, and was answered `null` five metres under a crown that is
    // drawn there. The sink audit found it at exactly s = 0, u in +/-8.2:
    // 5.000 m of invisible hole, one micron wide. The drawn cell owns its own
    // closing edge; so does the query.
    if (s > EDGE && s < GAP - EDGE) return null;     // the water

    let j, a;
    if (s < GAP * 0.5) {
      const f = clamp(((s - S0) / (0 - S0)) * (nA - 1), 0, nA - 1);
      j = Math.min(nA - 2, Math.floor(f)); a = f - j;
    } else {
      const f = clamp(((s - GAP) / (S1 - GAP)) * (nL - 1), 0, nL - 1);
      const jj = Math.min(nL - 2, Math.floor(f));
      j = nA + jj; a = f - jj;
    }
    const fk = clamp(((u + CROWN_HW) / (2 * CROWN_HW)) * (NU - 1), 0, NU - 1);
    const k = Math.min(NU - 2, Math.floor(fk));
    const b = fk - k;
    const y00 = Y[j * NU + k], y10 = Y[(j + 1) * NU + k];
    const y01 = Y[j * NU + k + 1], y11 = Y[(j + 1) * NU + k + 1];
    // Split a-b-c / a-c-d on the 00-11 diagonal, exactly as the mesh does.
    return a + b <= 1
      ? y00 + (y10 - y00) * a + (y01 - y00) * b
      : y11 + (y01 - y11) * (1 - a) + (y10 - y11) * (1 - b);
  }

  // -------------------------------------------------------------------------
  // MESH — the crown, the crib walls, the lip face.
  // -------------------------------------------------------------------------
  const earth = new Kit();
  const timber = new Kit();

  const P = (j, k) => {
    const [wx, wz] = toWorld(sAt(j), uAt(k));
    return [wx, Y[j * NU + k], wz];
  };
  const B = (j, k) => {
    const [wx, wz] = toWorld(sAt(j), uAt(k));
    return [wx, BASE[j * NU + k] - 0.55, wz];
  };

  for (let j = 0; j < NS - 1; j++) {
    if (j === JVOID) continue;
    const hMid = 0.5 * (profile(sAt(j)) + profile(sAt(j + 1)));
    for (let k = 0; k < NU - 1; k++) {
      const a = P(j, k), b = P(j + 1, k), c = P(j + 1, k + 1), d = P(j, k + 1);
      // THE CROWN IS THE ROAD, AND IT HAS TO LOOK LIKE IT.
      //
      // The first version painted the whole top one flat ochre and the render
      // came back with a 16 m wide orange plateau that read as a loading dock.
      // ART_DIRECTION section 3 is explicit that what makes a surface read as
      // driven-on is the RUTS, not the colour — so the ramp carries the same two
      // pairs the carriageway does, on the car's own 1.84 m track, plus a little
      // per-row grain so a flat top still has facet character at this camera.
      const uu = Math.abs(0.5 * (uAt(k) + uAt(k + 1)));
      const rut = Math.exp(-(((uu - 2.1) / 0.85) ** 2)) * 0.16
        + Math.exp(-(((uu - 5.3) / 1.05) ** 2)) * 0.075;
      const grain = ((j * 7 + k * 3) % 5) * 0.008;
      const shade = (uu > CROWN_HW - 1.3 && hMid > 0.2 ? FLANK_C : CROWN_C)
        .clone().multiplyScalar(1 - rut - grain);
      earth.top(a, b, c, d, shade);
    }
  }

  /**
   * A RETAINING FACE, BUILT IN COURSES.
   *
   * One quad from crown to toe is a slab, and that is what the first render
   * showed: two black-brown containers either side of the carriageway. A crib
   * wall is stacked timber, and the thing that says so at this camera is the
   * horizontal line every 0.72 m with the value alternating across it. Splitting
   * the face by HEIGHT (not by station, which was the first mistake — that
   * courses it the wrong way, along the road) costs six quads a metre and buys
   * the whole read.
   */
  const COURSE = 0.72;
  const facePanel = (t0, t1, b0, b1, kit, outX, outZ, dark) => {
    const drop = Math.max(t0[1] - b0[1], t1[1] - b1[1]);
    const n = Math.max(1, Math.min(9, Math.round(drop / COURSE)));
    const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    for (let c = 0; c < n; c++) {
      const p = c / n, q = (c + 1) / n;
      const col = dark
        ? (c & 1 ? FLANK_D : FLANK_C)
        : (c & 1 ? TIMBER : TIMBER_HI);
      kit.facing(
        lerp3(t1, b1, p), lerp3(t0, b0, p), lerp3(t0, b0, q), lerp3(t1, b1, q),
        col, outX, 0, outZ,
      );
    }
  };

  const wallFace = (j, k, kit, dark, batter) => {
    const top0 = P(j, k), top1 = P(j + 1, k);
    const out = k === 0 ? -1 : 1;
    const drop0 = top0[1] - BASE[j * NU + k];
    const drop1 = top1[1] - BASE[(j + 1) * NU + k];
    const o0 = drop0 * batter * out, o1 = drop1 * batter * out;
    const f0 = [top0[0] + nx * o0, BASE[j * NU + k] - 0.5, top0[2] + nz * o0];
    const f1 = [top1[0] + nx * o1, BASE[(j + 1) * NU + k] - 0.5, top1[2] + nz * o1];
    facePanel(top0, top1, f0, f1, kit, nx * out, nz * out, dark);
  };

  for (let j = 0; j < NS - 1; j++) {
    if (j === JVOID) continue;
    const h = 0.5 * (profile(sAt(j)) + profile(sAt(j + 1)));
    const kit = h > 0.7 ? timber : earth;
    wallFace(j, 0, kit, h <= 0.7, CRIB_BATTER);
    wallFace(j, NU - 1, kit, h <= 0.7, CRIB_BATTER);
  }

  // The lip: a timber crib face across the full width, dropping to the ford.
  const faceAcross = (j, kit, sign, dark = false) => {
    for (let k = 0; k < NU - 1; k++) {
      facePanel(P(j, k + 1), P(j, k), B(j, k), B(j, k + 1),
        kit, fx * sign, fz * sign, dark);
    }
  };
  faceAcross(JVOID, timber, 1);       // the take-off lip
  faceAcross(JVOID + 1, timber, -1);  // the far bank's sill
  // Closing aprons at the two far ends, so the 4 cm lip has an edge and not a
  // hole you can see the sky through.
  faceAcross(0, earth, -1, true);
  faceAcross(NS - 1, earth, 1, true);

  // One capping beam along the lip, proud of the crown. It is the edge the eye
  // reads the take-off point from, and at this camera an unmarked drop simply
  // disappears into the shadow of its own wall.
  {
    const [wx, wz] = toWorld(-0.22, 0);
    timber.box(2 * CROWN_HW - 0.3, 0.34, 0.52, wx, lipY + 0.05, wz, site.heading, TIMBER_HI);
    const [lx, lz] = toWorld(GAP + 0.30, 0);
    timber.box(2 * CROWN_HW - 0.3, 0.30, 0.62, lx,
      baseAt(lx, lz) + LAND_TOE + 0.06, lz, site.heading, TIMBER);
  }

  // -------------------------------------------------------------------------
  // THE STREAM.
  //
  // The channel runs across the road along +/- n, out of the high flank and
  // over the low one. Upstream it is incised into the meadow; at the road it is
  // the ford; downstream it falls away with the hillside as a cascade. The
  // carve is a subtraction on terrain.heightAt, exactly the technique
  // water.js/carveLakes uses for a tarn — and, for the same reason, it stops
  // dead at the road corridor, because roads.js built its shoulders and its
  // fence feet against the ground as it was.
  // -------------------------------------------------------------------------
  const hiSide = site.side;                    // +1: high ground on the +n side

  /**
   * THE STREAM'S OWN FRAME.
   *   a — metres along the watercourse, POSITIVE UPSTREAM (toward the high side)
   *   b — metres along the road from the middle of the ford
   * so the wetted band at the road is exactly `b` in +/-GAP/2, which is the hole
   * in the earthwork, and nothing else has to be kept in step by hand.
   */
  const chanCoords = (x, z) => {
    const dx = x - ox, dz = z - oz;
    return {
      along: (dx * nx + dz * nz) * hiSide,
      across: dx * fx + dz * fz - GAP * 0.5,
    };
  };
  const chanWorld = (a, b) => {
    const su = GAP * 0.5 + b, uu = a * hiSide;
    return [ox + fx * su + nx * uu, oz + fz * su + nz * uu];
  };

  /** A brook does not run in a ruled line. Two octaves, seeded, and pinned to
   *  zero at the ford so the wetted band stays inside the earthwork's hole. */
  const meander = (a) => {
    const g = 1 - Math.exp(-((a / 26) ** 2));
    return g * (Math.sin(a * 0.085 + 1.7) * 2.6 + Math.sin(a * 0.21 - 0.4) * 1.0);
  };

  /**
   * Half width. Wide and shallow where it crosses — that is what a ford IS —
   * and narrow where it is cutting. GAP/2 at the road is not a coincidence: the
   * water fills the hole in the earthwork exactly, so the thing the car jumps
   * and the thing it would land in are the same 15.5 m.
   */
  const chanHW = (a) => 3.4 + (GAP * 0.5 - 3.4) * Math.exp(-((a / 15) ** 2));

  const natural = (x, z) => terrain.drawnHeightAt(x, z);
  const roadY = baseAt(...chanWorld(0, 0));

  /**
   * THE WATER SURFACE, LEVEL ACROSS AND MONOTONE ALONG.
   *
   * The first version sampled the ground under every lattice point and held the
   * surface a fixed depth above it, which is not a stream — it is a blue sheet
   * laid over a hillside, and it looked exactly like one. Water has one height
   * per cross-section and it only ever goes downhill.
   *
   * Upstream the surface is a RUNNING MAXIMUM of (meadow - 0.5): the road's own
   * cut ditch is 1.6 m below the ford here, so the reach behind the crossing is
   * a pond held up by the embankment and spilling over the ford — which is what
   * a stream dammed by a road actually does — and it only starts climbing again
   * where the shelf comes up past the ford. Downstream it is a running MINIMUM,
   * so it follows the 10 m fall to the tarn straight down as rapids.
   */
  const NL = Math.round(UP_REACH + DOWN_REACH) + 1;
  const level = new Float64Array(NL);
  const lvlIdx = (a) => clamp(Math.round(a + DOWN_REACH), 0, NL - 1);
  {
    const G = (a) => natural(...chanWorld(a, meander(a)));
    let up = fordY;
    for (let a = 0; a <= UP_REACH; a++) {
      if (a > CORRIDOR) up = Math.max(up, G(a) - 0.5);
      level[lvlIdx(a)] = up;
    }
    let dn = fordY;
    for (let a = 0; a >= -DOWN_REACH; a--) {
      if (-a > CORRIDOR) dn = Math.min(dn, G(a) - 0.4);
      level[lvlIdx(a)] = dn;
    }
  }
  const levelAt = (a) => {
    const f = clamp(a + DOWN_REACH, 0, NL - 1.001);
    const i = Math.floor(f), t = f - i;
    return level[i] * (1 - t) + level[i + 1] * t;
  };

  /** How deep the bed is cut below the surface, and where the cut is allowed. */
  const cutDepth = (a) => {
    const m = Math.abs(a);
    if (m <= CORRIDOR) return 0;                 // roads.js owns this ground
    const on = smooth((m - CORRIDOR) / 8);
    const off = 1 - smooth((m - (a > 0 ? UP_REACH - 12 : DOWN_REACH - 14)) / 12);
    return (a > 0 ? 1.05 : 1.45) * on * off;
  };

  /** The bed this module wants under the water at (a, b). */
  const bedAt = (a, b) => {
    const w = chanHW(a);
    const r = Math.abs(b - meander(a)) / w;
    if (r >= 1) return Infinity;                 // outside the channel: no cut
    return levelAt(a) - cutDepth(a) * (1 - r * r);
  };

  const baseHeight = terrain.heightAt.bind(terrain);
  const carved = (x, z) => {
    const h = baseHeight(x, z);
    const { along, across } = chanCoords(x, z);
    if (along > UP_REACH || along < -DOWN_REACH) return h;
    const bed = bedAt(along, across);
    return bed < h ? bed : h;
  };
  terrain.heightAt = carved;
  redisplace(terrain, carved, palette);

  // Water. Opaque and flat-shaded on purpose: this is a shallow, fast brook, not
  // the still glass water.js draws for a tarn, and an opaque ribbon is what keeps
  // the ford legible where it is only 14 cm deep over an ochre road.
  const C = lakeColors(biome, palette);
  const water = new Kit();
  buildStream(water, { chanWorld, chanHW, meander, levelAt, natural, C, fordY });

  // Boulders along the waterline, and marker boards on the approach.
  const stone = new Kit();
  dressStream(stone, { chanWorld, chanHW, meander, levelAt, natural, rng });
  dressApproach(timber, { toWorld, heightAt, CROWN_HW });

  for (const [kit, name, opts] of [
    [earth, 'jumpramp-earth', {}],
    [timber, 'jump-timber', {}],
    [stone, 'jump-stone', {}],
    [water, 'jump-water', { castShadow: false }],
  ]) {
    const m = kit.mesh(name, opts);
    if (m) group.add(m);
  }

  // -------------------------------------------------------------------------
  // WHY NOTHING IS SOLID
  //
  // `core/collision.js` resolves colliders in XZ ONLY — it never looks at the
  // car's height. A collider anywhere under the flight path would therefore
  // swat a car that is four metres above it. So the crib walls, the sill and the
  // boulders are drawn and not solid, and the shape of the earthwork does all
  // the work: the crown is 16.6 m wide against an 11 m carriageway, and its
  // flanks are a fall, which is a far better teacher than a bump.
  // -------------------------------------------------------------------------
  const colliders = [];

  const meanderOf = meander;
  const chanHWOf = chanHW;

  /** Prop keep-out: the whole footprint, plus the channel, plus the flight path. */
  const isBlocked = (x, z) => {
    const dx = x - ox, dz = z - oz;
    const s = dx * fx + dz * fz;
    const u = dx * nx + dz * nz;
    if (s > S0 - 6 && s < S1 + 6 && Math.abs(u) < CROWN_HW + 6) return true;
    // BOTH REACHES. The first version only kept props off the upstream side and
    // the capture came back with two mature conifers standing in the middle of
    // the cascade — props.js scatters on terrain.heightAt, which this module has
    // just moved, so anything inside the carve has to be claimed here or it is
    // planted on a riverbed.
    const { along, across } = chanCoords(x, z);
    if (along > UP_REACH + 6 || along < -(DOWN_REACH + 6)) return false;
    return Math.abs(across - meanderOf(along)) < chanHWOf(along) + 3.0;
  };

  return {
    group,
    heightAt,
    isBlocked,
    colliders,
    site: {
      x: site.x, z: site.z, heading: site.heading, gap: GAP,
      t: site.t, straightLength: site.runLen, chordDeviation: site.dev,
      lipY, fordY, lipHeight: LIP_H, landingHeight: LAND_H,
      drop: LIP_H - LAND_H, crossFall: site.fall,
    },
  };
}

// ---------------------------------------------------------------------------
// TERRAIN
// ---------------------------------------------------------------------------

/**
 * Push the terrain mesh onto the carved field.
 *
 * Identical in kind to `carveLakes`: replace `terrain.heightAt`, then move every
 * vertex onto it. `drawnHeightAt` caches per-vertex heights keyed on the
 * IDENTITY of `heightAt` (terrain.js `_cornerY`), so swapping the function is
 * also what invalidates the cache — the drawn triangle and the analytic field
 * stay the same surface, which is the only reason the sink audit can pass over a
 * carve at all.
 */
function redisplace(terrain, field, palette) {
  const mesh = terrain.mesh;
  const posAttr = mesh?.geometry?.attributes?.position;
  if (!posAttr) return;
  const pos = posAttr.array;
  for (let i = 0; i < pos.length; i += 3) pos[i + 1] = field(pos[i], pos[i + 2]);
  posAttr.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingSphere();
}

// ---------------------------------------------------------------------------
// WATER
// ---------------------------------------------------------------------------

/**
 * The stream: a ford band lying on the carriageway, an incised reach upstream,
 * and a cascade down the low flank.
 *
 * The surface is NOT one level. A brook's water follows its bed, and this one
 * drops ten metres in the fifty past the road — so the level is sampled from the
 * ground under it and held a fixed depth above, which is what makes the cascade
 * read as falling rather than as a blue plank lying on a hill.
 */
function buildStream(kit, o) {
  const { chanWorld, chanHW, meander, levelAt, natural, C, fordY } = o;
  const deep = new THREE.Color(C.deep);
  const mid = new THREE.Color(C.mid);
  const shallow = new THREE.Color(C.shallow);
  const foam = new THREE.Color(C.foam);

  const A0 = -DOWN_REACH, A1 = UP_REACH;
  const NA = 150, NB = 17;
  const aAt = (i) => A0 + (i * (A1 - A0)) / (NA - 1);
  // Normalised across-channel, so the lattice follows the meander and the width.
  const rAt = (j) => -1 + (j * 2) / (NB - 1);

  const P = new Float64Array(NA * NB * 3);
  const D = new Float64Array(NA * NB);
  for (let i = 0; i < NA; i++) {
    const a = aAt(i), w = chanHW(a), m = meander(a), y = levelAt(a);
    for (let j = 0; j < NB; j++) {
      const r = rAt(j);
      const b = m + r * w;
      const [wx, wz] = chanWorld(a, b);
      const g = natural(wx, wz);
      // The last sixth of the width eases the surface down onto the ground.
      // A pool held back by a road embankment has no bank on the ditch side to
      // clip against, and a level sheet ending in mid-air is the one thing that
      // reads instantly as a mistake; a shallow margin does not.
      const e = Math.max(0, (Math.abs(r) - 0.84) / 0.16);
      const surf = y - (y - Math.min(y, g)) * e * e;
      const k = (i * NB + j) * 3;
      P[k] = wx; P[k + 1] = surf; P[k + 2] = wz;
      D[i * NB + j] = surf - g;
    }
  }

  const col = new THREE.Color();
  const colourOf = (i, j) => {
    const d = D[i * NB + j];
    const a = aAt(i), r = Math.abs(rAt(j));
    if (d > 1.2) col.copy(deep).lerp(mid, 0.30);
    else if (d > 0.5) col.copy(mid);
    else col.copy(shallow).lerp(mid, 0.4);
    // White where it is working: over the ford's stones, along the margins, and
    // all the way down the cascade. ART_DIRECTION section 5 — foam rings and
    // rapids are what stop water reading as a painted shape.
    const rapids = a < -CORRIDOR ? Math.min(0.62, (-a - CORRIDOR) / 26) : 0;
    const margin = smooth((r - 0.72) / 0.28) * 0.42;
    const splash = Math.abs(a) < CORRIDOR ? 0.16 : 0;
    return col.lerp(foam, Math.min(0.8, Math.max(rapids, margin, splash)));
  };

  const pt = (i, j) => { const k = (i * NB + j) * 3; return [P[k], P[k + 1], P[k + 2]]; };
  for (let i = 0; i < NA - 1; i++) {
    for (let j = 0; j < NB - 1; j++) {
      const d0 = D[i * NB + j], d1 = D[(i + 1) * NB + j];
      const d2 = D[i * NB + j + 1], d3 = D[(i + 1) * NB + j + 1];
      // Nothing where the bed is out of the water — the brook ends where the
      // ground comes up through it, which is the only waterline worth drawing.
      if (Math.max(d0, d1, d2, d3) < 0.03) continue;
      const c = colourOf(i, j).clone().lerp(colourOf(i + 1, j + 1), 0.5);
      kit.top(pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1), c);
    }
  }
}

/** Faceted boulders along the waterline — ART_DIRECTION section 4, item 5. */
function dressStream(kit, o) {
  const { chanWorld, chanHW, meander, levelAt, natural, rng } = o;
  for (let n = 0; n < 46; n++) {
    const a = -DOWN_REACH * 0.92 + rng.float() * (UP_REACH + DOWN_REACH) * 0.92;
    const w = chanHW(a);
    // Standing in the shallows or sitting on the bank, never mid-channel: a
    // boulder in the middle of a ford is a thing the car would land on.
    const side = rng.float() < 0.5 ? -1 : 1;
    const b = meander(a) + side * w * (0.80 + rng.float() * 0.55);
    const [wx, wz] = chanWorld(a, b);
    const g = natural(wx, wz);
    if (g > levelAt(a) + 2.2) continue;
    const r = 0.45 + rng.float() * 1.05;
    kit.box(r * 1.9, r * 1.6, r * 1.7, wx, g + r * 0.30, wz,
      rng.float() * Math.PI, rng.float() < 0.45 ? STONE_DK : STONE);
  }
  // A cobbled bed under the ford, so the crossing has a floor and not a road.
  for (let n = 0; n < 11; n++) {
    const a = (rng.float() * 2 - 1) * 9;
    const b = (rng.float() * 2 - 1) * (GAP * 0.42);
    const [wx, wz] = chanWorld(a, b);
    const g = natural(wx, wz);
    if (g > levelAt(a) + 0.1) continue;
    kit.box(1.4 + rng.float(), 0.30, 1.1 + rng.float() * 0.6, wx, g + 0.14, wz,
      rng.float() * Math.PI, rng.float() < 0.5 ? STONE_DK : STONE);
  }
}

/** Chevron boards on the approach — ART_DIRECTION section 4, item 2. A jump you
 *  cannot see coming is not fair, and at this camera the crest hides itself. */
function dressApproach(kit, o) {
  const { toWorld, heightAt, CROWN_HW } = o;
  // The foot goes on the module's OWN answer, not on a lattice index: the
  // s-nodes are two runs with a hole between them and indexing them as if they
  // were one uniform table is how a post ends up buried at the far end.
  const post = (s, u, h, col) => {
    const [wx, wz] = toWorld(s, u);
    const y = heightAt(wx, wz);
    if (y == null) return;
    kit.box(0.20, h, 0.20, wx, y + h * 0.5, wz, 0, TIMBER_DK);
    kit.box(0.95, 0.62, 0.16, wx, y + h + 0.30, wz, 0, col);
  };
  for (let n = 0; n < 4; n++) {
    const s = -APPROACH - TABLE + 2 + n * 5.5;
    post(s, CROWN_HW - 0.9, 1.15, n & 1 ? 0xe8e2d2 : 0xc0392b);
    post(s, -CROWN_HW + 0.9, 1.15, n & 1 ? 0xe8e2d2 : 0xc0392b);
  }
}

/*
 * ---------------------------------------------------------------------------
 * WIRING — game.js, four short edits, all of them in the height chain.
 *
 *   import { createJump } from './world/jump.js';
 *
 *   // loadBiome(), after createLandmarks and BEFORE PropScatter: the carve has
 *   // to land before anything is scattered on the ground it moves.
 *   this.jump = createJump({ ...ctx, roads: this.roads, water: this.water });
 *   this.worldGroup.add(this.jump.group);
 *
 *   const blocked = (x, z) =>
 *     this.roads.isBlocked(x, z) || this.bridges.isBlocked(x, z)
 *     || this.landmarks.isBlocked(x, z) || this.jump.isBlocked(x, z);
 *
 *   // surfaceHeight() AND groundAt(), identically — the ramp is an embankment
 *   // built on the carriageway, so it joins the road's side of the max. Both,
 *   // or the central-difference normal reads the ribbon buried under the ramp
 *   // and the car climbs a 1:4 face for free.
 *   let road = this.roads.heightAt?.(x, z);
 *   const ramp = this.jump?.heightAt(x, z);
 *   if (ramp != null && (road == null || ramp > road)) road = ramp;
 *
 * `colliders` is empty and stays empty; see WHY NOTHING IS SOLID above.
 * ---------------------------------------------------------------------------
 */
