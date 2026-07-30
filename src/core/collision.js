/**
 * CONTRACT — src/core/collision.js
 * ================================
 * The whole of the car's contact with the solid world. No three.js, no scene,
 * no FX, no audio: plain numbers in, a mutated vehicle and a list of events out.
 * That is deliberate — it is what lets this file be unit-tested headless
 * (`node tools/collide-test.mjs`) and what keeps game.js down to two lines.
 *
 *   import { resolveCollisions, MATERIALS } from './core/collision.js';
 *   const hits = resolveCollisions(vehicle, world, dt);
 *
 *   world.barriers  -> { segments: [{x,z,dx,dz,half,nx,nz,kind,broken,id}],
 *                        hit(id, closingSpeed) -> boolean }      // roads.js
 *   world.colliders(x, z) -> iterable of { x, z, r, kind? }      // props/bridges/landmarks
 *   world.groundAt(x, z)  -> { height, normal, onRoad, onBridge } // optional, only for event.y
 *
 *   returns [{ type:'impact', kind, speed, carSpeed, x, y, z, nx, nz,
 *              depth, spin, broke }]
 *
 * `speed` is the CLOSING speed along the contact normal — the same quantity
 * game.js used to hand to feel/audio, so those call sites are unchanged.
 *
 * Deterministic: no Math.random, no Date.now, no iteration over a Map/Set whose
 * order depends on insertion from a non-deterministic source. The screenshot
 * harness depends on this.
 *
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The v0 model was a 1.5 m circle, an instantaneous position push-out and
 * `velocity *= 0.45`. Five things were wrong with it and each one is answered
 * below:
 *
 *  1. A CIRCLE cannot tell a nose-on hit from a side-swipe, its corners catch on
 *     nothing, and at r = 1.5 m against a 1.9 m-wide car it collided with things
 *     the car visually cleared by 0.55 m on each flank. -> the chassis is now an
 *     oriented box, 4.20 x 1.90 m, tested exactly (§ GEOMETRY).
 *  2. NO ANGULAR RESPONSE — both paths only damped yaw (`yawRate *= 0.5`).
 *     Clipping a rail with a corner at 30 m/s has to spin the car; that is the
 *     entire feel of hitting something in a rally game. -> a real 2D rigid-body
 *     impulse at the real contact point, with the lever arm to the centre of
 *     mass driving BOTH the linear and the angular change (§ IMPULSE).
 *  3. NO MATERIAL CLASSES — a sapling, a forty-year-old fir and a boulder were
 *     all `velocity *= 0.45`. -> § MATERIALS.
 *  4. TUNNELLING — one discrete test at the end-of-step position. -> the step is
 *     rewound and replayed in bounded slices (§ SWEEP).
 *  5. THE PUSH-OUT WAS UNPHYSICAL — applied at the centre of mass, which is
 *     precisely why there was no spin. -> gone.
 */

// ---------------------------------------------------------------------------
// CHASSIS
// ---------------------------------------------------------------------------
// The drawn car (entities/car.js) is 4.2 m long over the bumpers on a 2.70 m
// wheelbase (game.js carPose uses A = 1.35 half wheelbase) and 1.84 m over the
// arches. Rounding the collision box to 1.90 m wide keeps the mirrors honest
// without making the car catch on scenery it visually clears.
export const CHASSIS = {
  halfLength: 2.10,        // m, nose to centre
  halfWidth: 0.95,         // m, centreline to flank
  mass: 1180,              // kg — DEFAULT_TUNE.mass in entities/vehicle.js
  // YAW INERTIA. A 4.2 x 1.9 m plate is I = m(L^2+W^2)/12 = 1180*21.25/12
  // = 2090 kg m^2. The handling model does NOT use that: DEFAULT_TUNE has
  // `inertiaScale: 1.30`, i.e. Iz = 1534 kg m^2, 27% under the plate value,
  // because a lower inertia makes the car rotate more eagerly and that is the
  // arcade drift model's whole premise. Collisions read the SAME number, so the
  // yaw a hit injects and the yaw the drift model then damps are in the same
  // units. Overridden per-vehicle from `vehicle.tune` when present.
  inertia: 1180 * 1.30,    // 1534 kg m^2
};

// Barrier collision thickness. roads.js draws a guardrail beam at G_BEAM_T =
// 0.195 m half-thickness on 0.20 m posts, and a timber rail at RAIL_T = 0.10 m
// on the same posts. The thing the car hits is the post line, not the beam
// face, so both take the post radius plus a little: thin enough that the car
// can still get properly close, thick enough that the swept solver has
// something to catch.
const BARRIER_HALF_T = { guard: 0.24, fence: 0.20 };

// ---------------------------------------------------------------------------
// MATERIALS
// ---------------------------------------------------------------------------
/**
 * Every number here was set by driving the case in tools/collide-test.mjs and
 * reading the exit speed, so each one is quoted against its measurement.
 *
 *   restitution  e in the normal impulse. Exit speed off a square hit is e * v.
 *   friction     Coulomb mu at the contact. LOW = you slide along the face.
 *   spin         Fraction of the GEOMETRIC contact lever that becomes rotation.
 *                Why it is not 1: the exact rigid-body answer for a front
 *                corner into a trunk at 25 m/s is 15.3 rad/s — 2.4 revolutions
 *                per second. vehicle.js clamps yawRate at +/-3.6 rad/s, so four
 *                fifths of that is discarded on the next line anyway, and what
 *                survives reads on screen as a teleport rather than a spin. The
 *                lever is softened in BOTH the effective mass and the applied
 *                torque, which is the exact physics of a contact patch that
 *                smears toward the centreline instead of a mathematical point —
 *                so the solution stays self-consistent and the contact still
 *                separates. 0.12 puts that same corner hit at 2.8 rad/s.
 *   spinCap      rad/s ceiling on ONE contact's yaw change. Below vehicle.js's
 *                own 3.6 clamp on purpose, so the player still has yaw
 *                authority left to catch the slide.
 *   absorb       Extra speed bleed, applied as (1 - absorb * headOn^2) where
 *                headOn = |closing| / |contact speed|. Squared so a graze is
 *                free and only a square hit pays. This is the crumple that the
 *                normal impulse alone does not model.
 *   deflect      0..1. After the impulse, any speed still driving into the
 *                surface is turned along it by this fraction (§ NO-GRIND).
 *                1.0 on steel: the rail keeps you on the stage. 0.15 on a
 *                trunk: a tree is where the run ends.
 *   eventSpeed   Closing m/s below which no event is reported. Mirrors the old
 *                `if (closing > 4)` gate in game.js — a kerbstone scrape must
 *                not shake the camera.
 */
export const MATERIALS = {
  /**
   * STEEL GUARDRAIL. Never breaks — roads.js only ever returns true from
   * hit() for a timber bay. This is the one that has to feel like it SAVES you:
   * a 15 deg clip at 30 m/s must slide and must not stop. Measured: exit 28.0
   * m/s, 93% of entry. mu = 0.09 is the only thing standing between that
   * tangential slide and a stop. e = 0.18 keeps a square hit from welding the
   * car to the beam without flinging it back across the road.
   *
   * spin 0.030 is the lowest number in the table, and the geometry of the case
   * is why: the beam catches the front corner, so the torque straightens the
   * nose along the rail. At 0.05 the same 15 deg clip produced 0.58 rad/s,
   * which under the handling model's own yaw damping (yawDamp 0.95) integrates
   * to 35 deg — the rail rotates you past parallel and spits you back across
   * the road. 0.030 gives 0.35 rad/s, about 21 deg: parallel, plus a shove
   * toward the racing line. That is the "it saves you" feel, and a torque is
   * doing it rather than a scripted nudge.
   */
  guard: {
    restitution: 0.18, friction: 0.09, spin: 0.030, spinCap: 1.20,
    absorb: 0.10, deflect: 1.00, eventSpeed: 3.5,
  },

  /**
   * TIMBER FENCE, HOLDING. Below roads.js's BREAK_SPEED (7 m/s) the bay stands
   * and the car scrapes along it. Grippier and deader than steel — post-and-rail
   * catches, it does not guide.
   */
  fence: {
    restitution: 0.12, friction: 0.34, spin: 0.10, spinCap: 1.40,
    absorb: 0.26, deflect: 0.70, eventSpeed: 3.0,
    breakable: true,
    // Smashed bay: the car goes through and pays a quarter of its speed, which
    // is the brief's number. Delivered as a real impulse of m * closing *
    // breakCost along the normal — that IS the momentum the timber carried
    // away — so the lever arm still gives the shunt a little rotation (0.4 rad/s
    // for a 12 m/s corner-first break) instead of a pure scalar multiply.
    breakCost: 0.25, breakSpin: 0.10, breakSpinCap: 0.60,
  },

  /**
   * MATURE TREE. Immovable, and the run's momentum ends here. Square on at 25
   * m/s the car exits at 3.8 m/s BACKWARDS (e 0.30 gives 7.5, absorb 0.50 halves
   * it): not "55% shaved off", stopped. Squarely on the front-left corner it
   * exits at 3.6 and spins at 2.82 rad/s — that is the headline number and the
   * one the whole module exists for.
   *
   * mu = 0.52 is the number that took the most finding. FRICTION AT A CORNER
   * CONTACT TORQUES THE CAR THE OTHER WAY: the normal impulse swings the nose
   * away from the trunk, and friction dragging that same corner backwards swings
   * it back. Measured on an oblique corner clip at 25 m/s (trunk 0.27 m outboard
   * of the flank line, which is the clip a player really gets), the two cancel
   * almost exactly at mu 0.72 — 0.19 rad/s, so the car simply stopped and did
   * not spin at all. 0.72 -> 0.60 -> 0.52 -> 0.45 gives 0.27 / 0.54 / 0.72 /
   * 0.87 rad/s and 47 / 53 / 57 / 60% of entry speed kept. 0.52 is where the
   * clip reads as a rally moment: 43% of the speed gone and 30 deg out of shape,
   * with the car still moving.
   *
   * deflect 0.15 stops the dead-on case feeling like the old hard stop: there is
   * always a little slide past the trunk, so the car is never welded to it.
   */
  trunk: {
    restitution: 0.30, friction: 0.52, spin: 0.12, spinCap: 3.20,
    absorb: 0.50, deflect: 0.15, eventSpeed: 3.0,
  },

  /**
   * BOULDER / MASONRY. Immovable like a trunk but deader — stone does not flex,
   * so less bounce (e 0.30 -> 0.20) and more scrape (mu 0.52 -> 0.85, and here
   * the torque cancellation described above is WANTED: you grind to a halt
   * against a boulder, you do not pirouette off it), and it throws the car less
   * because a boulder's contact is broad, not a point (spin 0.12 -> 0.08).
   * Measured, same front-left corner at 25 m/s: 2.04 m/s out and 1.75 rad/s
   * against the trunk's 3.59 and 2.82.
   */
  rock: {
    restitution: 0.20, friction: 0.85, spin: 0.08, spinCap: 2.40,
    absorb: 0.58, deflect: 0.30, eventSpeed: 3.0,
  },

  /**
   * SAPLING. Yields: no depenetration, no impulse, no spin — the car drives
   * through and the tree loses. 2.5% of speed means 30 m/s -> 29.25, which is
   * exactly "barely registers". Kept as a class (rather than "not a collider at
   * all") so the props owner can mark young trees solid-but-soft and get a
   * thump and a leaf burst out of the event stream for free.
   */
  sapling: {
    yields: true, yieldCost: 0.025, eventSpeed: 6.0,
    restitution: 0, friction: 0, spin: 0, spinCap: 0, absorb: 0, deflect: 0,
  },

  /** BUSH / HEDGE. As a sapling, slightly draggier — you feel the mass of it. */
  bush: {
    yields: true, yieldCost: 0.045, eventSpeed: 8.0,
    restitution: 0, friction: 0, spin: 0, spinCap: 0, absorb: 0, deflect: 0,
  },

  /**
   * FENCE POST / MARKER / SIGN. Solid enough to hear and to knock the nose, far
   * too light to end anything. Used only when a collider declares kind:'post'.
   */
  post: {
    restitution: 0.10, friction: 0.30, spin: 0.09, spinCap: 0.90,
    absorb: 0.14, deflect: 0.85, eventSpeed: 4.0,
  },
};

// ---------------------------------------------------------------------------
// MATERIAL INFERENCE
// ---------------------------------------------------------------------------
// The legacy prop colliders are bare {x, z, r}: props.js, bridges.js and
// landmarks.js all predate this module and none of them carries a `kind`. The
// radius is the only signal, and it turns out to be a clean one, because the two
// producers do not overlap:
//
//   props.js `solidTree`  r = trunkR * scale * 0.34, gated on trunkR >= 0.55 AND
//                         a REAL height of 13.5 m. Every tree collider in the
//                         world is therefore already a mature trunk; saplings
//                         are drawn and not solid. Surveyed over five biomes
//                         (tools/collide-survey.mjs): alpine/forest n = 13273,
//                         p50 0.29 m, p90 0.34 m; winter p50 0.34.
//   props.js rocks        r = scale * 0.36, gated on scale > 2.7, so r > 0.97 by
//                         construction. Surveyed: the 1.0-1.7 m band, 600 of
//                         alpine's 13273, and 210 of desert's 288.
//   landmarks.js          r = 1.54 - 2.43 m (barn and shed footprints).
//   bridges.js            pylons and railing stubs.
//
// So: below 0.95 m it is a trunk, at or above it is stone or masonry. Note this
// is the OPPOSITE of the naive "big radius = tree" reading — in this world the
// big colliders are boulders and buildings and the small ones are forty-year-old
// firs. `sapling` and `bush` are unreachable by inference on purpose and are
// only selected when a collider declares them.
const TRUNK_MAX_R = 0.95;

/** @returns {keyof MATERIALS} */
export function classifyCollider(c) {
  if (c.kind && MATERIALS[c.kind]) return c.kind;
  return c.r < TRUNK_MAX_R ? 'trunk' : 'rock';
}

// ---------------------------------------------------------------------------
// SOLVER CONSTANTS
// ---------------------------------------------------------------------------
// SWEEP. The longest slice the car may advance before we look for contacts.
// The thinnest thing in the world is a timber rail at 0.40 m across (2 *
// BARRIER_HALF_T.fence). Measured: a square 40 m/s crossing of a rail line in
// one 1/60 s step is 0.557 m deep by the time a single end-of-step test sees it
// — deeper than the rail is thick, which is the tunnelling defect exactly.
// At 0.12 m the same crossing is caught 0.057 m in, a tenth as far, and the
// cost is six slices in the very worst case and one at any normal speed.
const MAX_ADVANCE = 0.12;
const MAX_SUBSTEPS = 8;          // 0.96 m of swept travel; beyond that we slice dt evenly

// Resolution iterations per slice. Four is enough for a car wedged in the
// corner of two rail bays; the point of the bound is that resolving one contact
// must never be allowed to shove the car through a second one indefinitely.
const MAX_ITER = 4;

const SLOP = 0.005;              // m of penetration left alone — stops contact chatter
const MAX_PUSH = 0.40;           // m per contact. Never teleport: a push bigger than
                                 // this is a degenerate case (car spawned inside a
                                 // rock), and walking it out over several frames
                                 // beats a jump.
// ...and a budget for the WHOLE step, which is what actually bounds the worst
// case. A barrier's penetration is measured along its face normal, and that is
// only a true overlap while the car is on one side of it: smash a timber bay at
// 45 degrees, carry on, and the neighbouring bay reports the car's 2.16 m
// diagonal reach across the line as "depth 1.81 m". Measured — that is a real
// case and it was a 1.8 m teleport. 0.60 m per step is 72 m/s of separation
// rate at the shell's 1/120, so nothing legitimate ever touches this, and the
// straddle walks itself out over three frames instead of jumping.
const MAX_PUSH_STEP = 0.60;
const REST_SPEED = 0.35;         // m/s of closing below which restitution is dropped,
                                 // so a car resting against a rail does not buzz.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// GEOMETRY
// ---------------------------------------------------------------------------
// Frame conventions, copied from entities/vehicle.js so the two agree exactly:
//   heading psi rotates about +Y
//   forward = ( cos psi, -sin psi )   in (x, z)
//   right   = ( sin psi,  cos psi )
//   yawRate > 0 rotates toward the car's LEFT
// The velocity of a point at offset r from the centre of mass is therefore
//   v + ( w * rz, -w * rx )
// and a force F at r makes a yaw torque of ( rz*Fx - rx*Fz ). Both follow from
// Omega x r with Omega = (0, w, 0); they are written out inline below rather
// than wrapped, because getting a sign wrong here is invisible and fatal.

/** Reused contact record — one per solver, never escapes. */
const _hit = {
  nx: 0, nz: 0,       // unit normal, pointing OUT of the obstacle toward the car
  cx: 0, cz: 0,       // contact point, world
  depth: 0,           // penetration, m
  obj: null, kind: '', seg: null,
};

/**
 * Oriented box (car) versus circle (prop).
 *
 * The closest point on the box to the circle centre is the contact point, which
 * is what makes a corner behave like a corner: clip a trunk with the front-left
 * and the contact sits 2.1 m ahead and 0.95 m left of the centre of mass, and
 * that lever arm is the spin.
 */
function obbVsCircle(px, pz, fx, fz, rx, rz, ox, oz, orad, out) {
  const dx = ox - px, dz = oz - pz;
  const l = dx * fx + dz * fz;                 // longitudinal, + = ahead
  const s = dx * rx + dz * rz;                 // lateral, + = car's right
  const lc = clamp(l, -CHASSIS.halfLength, CHASSIS.halfLength);
  const sc = clamp(s, -CHASSIS.halfWidth, CHASSIS.halfWidth);
  const dl = l - lc, ds = s - sc;
  const d2 = dl * dl + ds * ds;

  let nl, ns, depth, pl, ps;
  if (d2 > 1e-9) {
    if (d2 >= orad * orad) return false;
    const d = Math.sqrt(d2);
    nl = dl / d; ns = ds / d;                  // car surface -> obstacle centre
    depth = orad - d;
    pl = lc; ps = sc;
  } else {
    // Centre is INSIDE the box (deep overlap, or a big boulder swallowing the
    // car). Expel along the nearest face — anything else pushes the car further
    // in and the next iteration makes it worse.
    const el = CHASSIS.halfLength - Math.abs(l);
    const es = CHASSIS.halfWidth - Math.abs(s);
    if (el < es) { nl = Math.sign(l) || 1; ns = 0; depth = orad + el; pl = nl * CHASSIS.halfLength; ps = s; }
    else { nl = 0; ns = Math.sign(s) || 1; depth = orad + es; pl = l; ps = ns * CHASSIS.halfWidth; }
  }

  // Back to world. The normal the solver wants points AWAY from the obstacle.
  out.nx = -(nl * fx + ns * rx);
  out.nz = -(nl * fz + ns * rz);
  out.cx = px + pl * fx + ps * rx;
  out.cz = pz + pl * fz + ps * rz;
  out.depth = depth;
  return true;
}

/**
 * Oriented box (car) versus oriented box (barrier bay), 2D separating axis.
 *
 * DETECTION uses all four axes, because that is what SAT requires to be sound.
 * The SEPARATION direction, though, is forced to the bay's own face normal
 * (roads.js publishes it as seg.nx/nz, "away from the road") rather than to the
 * minimal axis. Bays abut end to end at a 4.4 m pitch, so a minimal-axis MTV
 * that happened to pick the bay's LONG axis would push the car lengthwise
 * straight into its neighbour, and the two would hand the car back and forth.
 * Any separating axis is a valid push; only the minimal one is optimal, and
 * optimal is worth less here than stable.
 */
function obbVsBarrier(px, pz, fx, fz, rx, rz, seg, out) {
  const HL = CHASSIS.halfLength, HW = CHASSIS.halfWidth;
  const bhl = seg.half, bht = BARRIER_HALF_T[seg.kind] ?? 0.22;
  const dx = seg.dx, dz = seg.dz;              // unit, along the bay
  const ex = -dz, ez = dx;                     // unit, across the bay
  const px_ = seg.x - px, pz_ = seg.z - pz;    // car -> bay centre

  // sep(axis) = |centre offset| - car extent - bay extent
  const axes = [fx, fz, rx, rz, dx, dz, ex, ez];
  for (let i = 0; i < 8; i += 2) {
    const ax = axes[i], az = axes[i + 1];
    const off = Math.abs(px_ * ax + pz_ * az);
    const carP = HL * Math.abs(fx * ax + fz * az) + HW * Math.abs(rx * ax + rz * az);
    const barP = bhl * Math.abs(dx * ax + dz * az) + bht * Math.abs(ex * ax + ez * az);
    if (off > carP + barP) return false;
  }

  // Separate along the bay's face normal, oriented toward the car.
  let nx = seg.nx ?? ex, nz = seg.nz ?? ez;
  const inv = 1 / (Math.hypot(nx, nz) || 1);
  nx *= inv; nz *= inv;
  if (px_ * nx + pz_ * nz > 0) { nx = -nx; nz = -nz; }   // point away from the bay

  const off = Math.abs(px_ * nx + pz_ * nz);
  const carP = HL * Math.abs(fx * nx + fz * nz) + HW * Math.abs(rx * nx + rz * nz);
  const barP = bhl * Math.abs(dx * nx + dz * nz) + bht * Math.abs(ex * nx + ez * nz);
  out.depth = carP + barP - off;
  if (out.depth <= 0) return false;
  out.nx = nx; out.nz = nz;

  // CONTACT POINT = the car's support point along -n, i.e. the part of the
  // chassis deepest into the barrier. A corner gives a corner and a big lever;
  // a face square onto the beam gives TWO tied vertices, and taking the
  // midpoint of the tie is what makes a square nose-on hit produce zero spin
  // while a corner clip produces all of it. The 0.12 cosine gate is 7 degrees:
  // inside that the hit reads as flat and should not flick the car.
  const fn = fx * nx + fz * nz, rn = rx * nx + rz * nz;
  const sl = Math.abs(fn) < 0.12 ? 0 : -Math.sign(fn);
  const sw = Math.abs(rn) < 0.12 ? 0 : -Math.sign(rn);
  out.cx = px + sl * HL * fx + sw * HW * rx;
  out.cz = pz + sl * HL * fz + sw * HW * rz;
  return true;
}

// ---------------------------------------------------------------------------
// BARRIER BROAD PHASE
// ---------------------------------------------------------------------------
// game.js walked all 2504 bays of the desert route every physics step. A lazy
// uniform hash over the bay centres costs one build per world load and turns
// that into the four or five bays actually within reach. Keyed on the segments
// array itself plus a cheap signature, because roads.js `reset()` refills the
// SAME array in place and the cache must notice.
const _barCache = new WeakMap();
const BAR_CELL = 32;

function barrierGrid(segments) {
  // roads.js `compile()` refills this array IN PLACE (`segments.length = 0`
  // then push), so array identity alone is not enough to notice a rebuild — the
  // settled-terrain recompile would leave us holding a grid full of dead bays.
  // Four sampled coordinates plus the count is cheap and has never collided.
  const n = segments.length;
  const sig = n === 0 ? 0
    : n + segments[0].x * 0.001 + segments[n >> 2].z * 0.007
    + segments[n >> 1].x * 0.013 + segments[n - 1].z * 0.019;
  const got = _barCache.get(segments);
  if (got && got.sig === sig) return got.grid;

  const grid = new Map();
  for (const s of segments) {
    // A bay is at most `half` from its centre in any direction; stamp its AABB.
    const ex = Math.abs(s.dx) * s.half + 0.4, ez = Math.abs(s.dz) * s.half + 0.4;
    const i0 = Math.floor((s.x - ex) / BAR_CELL), i1 = Math.floor((s.x + ex) / BAR_CELL);
    const j0 = Math.floor((s.z - ez) / BAR_CELL), j1 = Math.floor((s.z + ez) / BAR_CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = i * 73856093 ^ j * 19349663;
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(s);
      }
    }
  }
  _barCache.set(segments, { sig, grid });
  return grid;
}

// ---------------------------------------------------------------------------
// SOLVER SCRATCH — module-scope so a 120 Hz step allocates nothing.
// ---------------------------------------------------------------------------
const _props = [];
const _bars = [];
const _done = new Set();         // obstacles already charged an impulse this call
const _cand = {
  nx: 0, nz: 0, cx: 0, cz: 0, depth: 0, obj: null, kind: '', seg: null,
};

function adopt(dst, src, obj, kind, seg) {
  dst.nx = src.nx; dst.nz = src.nz; dst.cx = src.cx; dst.cz = src.cz;
  dst.depth = src.depth; dst.obj = obj; dst.kind = kind; dst.seg = seg;
}

// ---------------------------------------------------------------------------
// THE ENTRY POINT
// ---------------------------------------------------------------------------
/**
 * Resolve everything the car touched during the step that just ran.
 *
 * Call it immediately after `vehicle.step(dt, input)`, before anything else
 * reads the position. The start of the swept segment is reconstructed rather
 * than passed in: vehicle.step ends with `position += velocity * dt` and
 * `heading += yawRate * dt` using the POST-update velocity and yaw rate, so
 * `position - velocity * dt` is the exact pre-step pose, not an approximation.
 * That is worth one comment and saves the shell a line of bookkeeping.
 *
 * @param {import('../entities/vehicle.js').Vehicle} vehicle
 * @param {{barriers?:object, colliders?:(x:number,z:number)=>Iterable, groundAt?:Function}} world
 * @param {number} dt
 * @returns {Array<object>} impact events, newest last
 */
export function resolveCollisions(vehicle, world, dt) {
  const events = [];
  if (!world || !(dt > 0)) return events;

  const mass = vehicle.tune?.mass ?? CHASSIS.mass;
  const inertia = vehicle.tune?.mass !== undefined
    ? vehicle.tune.mass * (vehicle.tune.inertiaScale ?? 1.30)
    : CHASSIS.inertia;
  const invM = 1 / mass, invI = 1 / inertia;

  // --- rewind to the top of the step -----------------------------------------
  let vx = vehicle.velocity.x, vz = vehicle.velocity.z, w = vehicle.yawRate;
  let px = vehicle.position.x - vx * dt;
  let pz = vehicle.position.z - vz * dt;
  let ang = vehicle.heading - w * dt;

  // --- broad phase, once, about the middle of the sweep ----------------------
  // The sweep is under 0.4 m at the shell's 1/120 step and the prop grid cell is
  // 24 m, so one query at the midpoint covers the whole path with room to spare.
  const midX = px + vx * dt * 0.5, midZ = pz + vz * dt * 0.5;

  _props.length = 0;
  if (world.colliders) for (const c of world.colliders(midX, midZ)) _props.push(c);

  _bars.length = 0;
  const B = world.barriers;
  if (B?.segments?.length) {
    // A 3x3 block of 32 m cells around the sweep. The car's diagonal is 4.6 m
    // and the longest bay is 6.1 m, so a bay whose CENTRE is up to a cell away
    // can still reach us; three cells covers that several times over and the
    // slack costs nothing because the cells are almost always empty.
    const grid = barrierGrid(B.segments);
    const i0 = Math.floor((midX - BAR_CELL) / BAR_CELL), i1 = Math.floor((midX + BAR_CELL) / BAR_CELL);
    const j0 = Math.floor((midZ - BAR_CELL) / BAR_CELL), j1 = Math.floor((midZ + BAR_CELL) / BAR_CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const a = grid.get(i * 73856093 ^ j * 19349663);
        if (!a) continue;
        for (const s of a) if (!s.broken && !_bars.includes(s)) _bars.push(s);
      }
    }
  }

  // Nothing within reach: the overwhelmingly common case, and it must be free.
  if (_props.length === 0 && _bars.length === 0) {
    vehicle._collideBrushed = null;
    return events;
  }

  _done.clear();
  // Which yielding props the car was already inside LAST step, so one pass
  // through a bush is one thump and not eighteen. Rebuilt every call; null
  // whenever the car is not touching scenery, which is almost always.
  const brushedPrev = vehicle._collideBrushed ?? null;
  let brushedNow = null;

  // --- SWEEP: replay the step in slices no longer than MAX_ADVANCE ------------
  const travel = Math.hypot(vx, vz) * dt;
  const slices = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil(travel / MAX_ADVANCE)));
  const h = dt / slices;
  let pushBudget = 0;            // metres of depenetration spent this step

  for (let sl = 0; sl < slices; sl++) {
    // Advance on the CURRENT velocity, not the original one: an impulse applied
    // in an earlier slice must change where the rest of the step goes. That is
    // the difference between continuous resolution and four discrete tests.
    px += vx * h; pz += vz * h; ang += w * h;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const fx = Math.cos(ang), fz = -Math.sin(ang);
      const rx = Math.sin(ang), rz = Math.cos(ang);

      // -- find the deepest contact ------------------------------------------
      _cand.depth = 0; _cand.obj = null; _cand.seg = null;

      for (const c of _props) {
        if (!obbVsCircle(px, pz, fx, fz, rx, rz, c.x, c.z, c.r, _hit)) continue;
        const kind = classifyCollider(c);
        if (MATERIALS[kind].yields) {
          // Yielding scenery never enters the depenetration contest — the car
          // drives through it. `_done` keeps it to one charge per STEP.
          if (_done.has(c)) continue;
          _done.add(c);
          const mat = MATERIALS[kind];
          const sp = Math.hypot(vx, vz);
          // CHARGE THE PASS, NOT THE FRAME. The chassis is 4.2 m long, so a
          // 30 m/s brush past a sapling overlaps it for 18 physics steps;
          // taking yieldCost on every one of them turned "barely registers"
          // into a 48% speed loss. Spreading the cost over the length of car
          // that has to get past it is frame-rate independent and sums to
          // exactly yieldCost over the whole pass: 30 -> 29.25 m/s.
          const passLen = 2 * CHASSIS.halfLength + 2 * c.r;
          const f = 1 - mat.yieldCost * Math.min(1, (sp * dt) / passLen);
          vx *= f; vz *= f;
          if (!brushedPrev?.has(c) && sp >= mat.eventSpeed) {
            events.push(makeEvent(world, kind, sp, sp, _hit, 0, false));
          }
          (brushedNow ??= new Set()).add(c);
          continue;
        }
        if (_hit.depth > _cand.depth) adopt(_cand, _hit, c, kind, null);
      }

      for (const s of _bars) {
        if (s.broken) continue;
        if (!obbVsBarrier(px, pz, fx, fz, rx, rz, s, _hit)) continue;
        if (_hit.depth > _cand.depth) adopt(_cand, _hit, s, s.kind, s);
      }

      if (!_cand.obj) break;

      // -- resolve it ---------------------------------------------------------
      const mat = MATERIALS[_cand.kind] ?? MATERIALS.rock;
      const nx = _cand.nx, nz = _cand.nz;
      const arx = _cand.cx - px, arz = _cand.cz - pz;     // com -> contact

      // Velocity of the contact point: v + Omega x r, Omega = (0, w, 0).
      const cvx = vx + w * arz, cvz = vz - w * arx;
      const vn = cvx * nx + cvz * nz;                     // < 0 = closing
      const closing = Math.max(0, -vn);
      const carSpeed = Math.hypot(vx, vz);
      const already = _done.has(_cand.obj);

      // -- does the bay break? ------------------------------------------------
      let broke = false;
      if (!already && mat.breakable && closing > 0 && B?.hit) {
        broke = B.hit(_cand.seg.id, closing) === true;
      }

      if (broke) {
        // Through it. No depenetration — the bay is gone. The momentum the
        // timber carried away IS the impulse, so it still gets a lever arm.
        const J = mass * closing * mat.breakCost;
        applyImpulse(J * nx, J * nz, arx, arz, invM, invI,
          mat.breakSpin, mat.breakSpinCap, (dvx, dvz, dw) => {
            vx += dvx; vz += dvz; w += dw;
          });
        _done.add(_cand.obj);
        events.push(makeEvent(world, 'fence', closing, carSpeed, _cand, w, true));
        vehicle.contactCount = (vehicle.contactCount ?? 0) + 1;
        continue;                                          // rescan: it is gone now
      }

      // -- depenetrate --------------------------------------------------------
      // Never further than the overlap actually measured, never more than
      // MAX_PUSH in one go, and never more than MAX_PUSH_STEP across the step.
      const push = Math.min(Math.max(0, _cand.depth - SLOP), MAX_PUSH,
        MAX_PUSH_STEP - pushBudget);
      pushBudget += push;
      px += nx * push; pz += nz * push;

      if (closing <= 1e-4) {
        // Overlapping but already separating (a previous iteration fixed it, or
        // the car is being carried out by another contact). Position only.
        _done.add(_cand.obj);
        // Nothing left to do to this contact and nothing else was deeper, so
        // the remaining iterations would re-find it and do nothing. Stop.
        if (push <= 0) break;
        continue;
      }

      // -- the impulse --------------------------------------------------------
      // Softened lever (see MATERIALS.spin) used in the effective mass AND in
      // the torque, so the pair stays a consistent rigid-body solution: the
      // contact really does end up separating.
      const g = mat.spin;
      const levN = (arz * nx - arx * nz) * g;
      const kN = invM + levN * levN * invI;
      const e = closing > REST_SPEED ? mat.restitution : 0;
      const Jn = ((1 + e) * closing) / kN;

      // Coulomb friction along the contact's own tangential slide direction.
      let tx = cvx - vn * nx, tz = cvz - vn * nz;
      const tl = Math.hypot(tx, tz);
      let Jt = 0;
      if (tl > 1e-4) {
        tx /= tl; tz /= tl;
        const levT = (arz * tx - arx * tz) * g;
        const kT = invM + levT * levT * invI;
        Jt = -Math.min(tl / kT, mat.friction * Jn);        // opposes the slide
      } else { tx = 0; tz = 0; }

      const Jx = Jn * nx + Jt * tx, Jz = Jn * nz + Jt * tz;
      let spinApplied = 0;
      applyImpulse(Jx, Jz, arx, arz, invM, invI, g, mat.spinCap, (dvx, dvz, dw) => {
        vx += dvx; vz += dvz; w += dw; spinApplied = dw;
      });

      // -- crumple ------------------------------------------------------------
      // The normal impulse models a rebound, not a wreck. `absorb` is the energy
      // that went into bending things, and it is weighted by headOn^2 so a graze
      // is free (0.26^2 = 7% of the coefficient at 15 degrees) and only a square
      // hit pays the full price.
      const headOn = carSpeed > 0.5 ? clamp(closing / carSpeed, 0, 1) : 1;
      const keep = 1 - mat.absorb * headOn * headOn;
      vx *= keep; vz *= keep;

      // -- NO-GRIND GUARANTEE -------------------------------------------------
      // An obstacle deflects the car; it never welds it to the scenery. If the
      // centre of mass is still driving into the surface after all of the above
      // (it can be — the rotation that was supposed to carry the contact clear
      // is capped), take that component out and hand `deflect` of it back along
      // the face. On steel that is the whole thing: you lose nothing and leave
      // pointing down the road. On a trunk it is a sixth, which is just enough
      // that the car crawls clear instead of parking against the bark.
      const vnC = vx * nx + vz * nz;
      if (vnC < 0) {
        vx -= nx * vnC; vz -= nz * vnC;
        if (mat.deflect > 0 && tl > 1e-4) {
          const give = -vnC * mat.deflect;
          vx += tx * give; vz += tz * give;
        }
      }

      // -- report -------------------------------------------------------------
      if (!already) {
        _done.add(_cand.obj);
        vehicle.contactCount = (vehicle.contactCount ?? 0) + 1;
        if (closing >= mat.eventSpeed) {
          events.push(makeEvent(world, _cand.kind, closing, carSpeed, _cand, spinApplied, false));
        }
      }
    }
  }

  // --- write back ------------------------------------------------------------
  vehicle.position.x = px;
  vehicle.position.z = pz;
  vehicle.velocity.x = vx;
  vehicle.velocity.z = vz;
  vehicle.heading = ang;
  vehicle.yawRate = clamp(w, -3.6, 3.6);       // the same clamp vehicle.step uses
  vehicle._collideBrushed = brushedNow;

  // Sticky telemetry that fx/feel.js reads off the vehicle rather than off the
  // event stream (it has its own 0.30 s debounce and picks the worst hit in the
  // window). Kept in sync so feel and audio need no wiring change at all.
  for (const ev of events) {
    if (ev.speed > (vehicle.lastImpact ?? 0)) {
      vehicle.lastImpact = ev.speed;
      vehicle.impactDir?.set?.(ev.nx, 0, ev.nz);
    }
  }

  // Hand the pose back to vehicle.js. Its `_resolveExternal` shim exists to
  // reconstruct an impulse when SOMETHING ELSE moved the car without telling it
  // — which was exactly what the old game.js push-out did. We just did the job
  // properly, so tell it the new pose is ours and it must not second-guess it;
  // otherwise it rebuilds velocity and yaw from the pre-contact state next frame
  // and everything above is thrown away.
  if (vehicle.commitExternalResolve) vehicle.commitExternalResolve();
  else if (vehicle._lastPos) {                 // older vehicle.js: do it by hand
    vehicle._lastPos.copy(vehicle.position);
    vehicle._lastVel.copy(vehicle.velocity);
    vehicle._lastYawRate = vehicle.yawRate;
  }

  return events;
}

/**
 * One impulse, both consequences. `dv = J/m` and `dw = (r x J)/I` come from the
 * SAME J and the SAME lever arm — that is the whole point, and the reason the
 * old code could not spin the car was that it never computed the second one.
 */
function applyImpulse(Jx, Jz, arx, arz, invM, invI, gain, cap, sink) {
  const torque = (arz * Jx - arx * Jz) * gain;     // (r x J)_y
  const dw = clamp(torque * invI, -cap, cap);
  sink(Jx * invM, Jz * invM, dw);
}

/**
 * Deepest overlap between the chassis at an arbitrary pose and anything solid
 * in `world`. Not used by the solver — it is the measurement tools/collide-test
 * .mjs reports as "penetration", and the one-line assertion a debug overlay
 * would want ("is the car inside something right now?").
 */
export function penetrationAt(px, pz, heading, world) {
  const fx = Math.cos(heading), fz = -Math.sin(heading);
  const rx = Math.sin(heading), rz = Math.cos(heading);
  let worst = 0;
  if (world.colliders) {
    for (const c of world.colliders(px, pz)) {
      const kind = classifyCollider(c);
      if (MATERIALS[kind].yields) continue;
      if (obbVsCircle(px, pz, fx, fz, rx, rz, c.x, c.z, c.r, _hit)) {
        worst = Math.max(worst, _hit.depth);
      }
    }
  }
  for (const s of world.barriers?.segments ?? []) {
    if (s.broken) continue;
    if (obbVsBarrier(px, pz, fx, fz, rx, rz, s, _hit)) worst = Math.max(worst, _hit.depth);
  }
  return worst;
}

function makeEvent(world, kind, speed, carSpeed, hit, spin, broke) {
  const g = world.groundAt?.(hit.cx, hit.cz);
  return {
    type: 'impact',
    kind,                       // 'guard' | 'fence' | 'trunk' | 'rock' | 'sapling' | 'bush' | 'post'
    speed,                      // closing speed along the normal, m/s
    carSpeed,                   // the car's speed at the moment of contact, m/s
    x: hit.cx, z: hit.cz,
    y: g?.height ?? 0,          // so particles spawn on the ground, not at y = 0
    nx: hit.nx, nz: hit.nz,     // unit, pointing out of the obstacle
    depth: hit.depth ?? 0,
    spin,                       // rad/s of yaw the hit injected
    broke,                      // true only when this hit destroyed a timber bay
    onRoad: g?.onRoad ?? false,
    onBridge: g?.onBridge ?? false,
  };
}
