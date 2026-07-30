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
 *     the car visually cleared. -> the chassis is now an oriented box, 5.10 x
 *     2.14 m, measured off the scene graph and tested exactly (§ GEOMETRY).
 *  1b. AND A RIGID BOX IS STILL NOT A CAR. A box stops the same way wherever you
 *     hit it, which made a tree a binary: 15% of entry speed at every lateral
 *     offset out to 1.20 m, then a clean miss at 1.40. -> § EDGE COMPLIANCE and
 *     § SHED, which is where most of the trunk's feel now comes from.
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
// MEASURED FROM THE SCENE GRAPH, not from BODY_LEN.
//
// The comment that used to sit here said the drawn car is "4.2 m long over the
// bumpers and 1.84 m over the arches". Both numbers were wrong: BODY_LEN is the
// tub alone, and car.js then hangs a nose wedge out to x = +2.72 and a rear wing
// back to x = -2.38. The bounding box of what is actually drawn is 5.12 x 2.44 m,
// so a 4.20 x 1.90 box left a 0.62 m nose overhang and 0.27 m down each flank
// outside the collision shape — the entire nose, splitter and light bar buried
// themselves in a trunk before anything fired.
//
// The box is now sized to the SOLID car: bumper to bumper, and over the arches.
// It deliberately excludes the wing tips and the mirrors, which are 0.07-0.13 m
// appendages that should not catch on scenery, and it stays inside the drawn
// silhouette so nothing collides with air.
export const CHASSIS = {
  halfLength: 2.55,        // m, nose to centre — the wedge tip at x = 2.72 less
                           // the 0.17 m of taper that is not full width
  halfWidth: 1.07,         // m, centreline to flank — ARCH_W/2, the widest solid
  // EDGE COMPLIANCE. The share of the car's structure standing behind a contact
  // at the very EDGE of a face, against 1.0 in the middle of one. This is the
  // difference between "clipped a tree with the corner" and "hit a tree"; see
  // the long note at the impulse for why the geometry alone cannot supply it.
  // Both numbers were fitted by grid search against a target exit-speed curve,
  // not guessed — the offset sweep printed by tools/collide-test.mjs is the
  // evidence, and the fit is the only combination in the grid with no dip.
  edgeCarry: 0.22,
  crushPower: 1.20,        // carry = 1 - (1 - edgeCarry) * edge^this
  // Past this much of the way out along a face the structure does not merely
  // give — it FOLDS, and the obstacle ends up sitting in the fold (§ SHED).
  // 0.32 of the half-width is 0.34 m, so the inner third of the bumper still
  // stops the car dead and everything outside it is a clip.
  shedEdge: 0.32,

  mass: 1180,              // kg — DEFAULT_TUNE.mass in entities/vehicle.js
  // YAW INERTIA. A 5.1 x 2.14 m plate is I = m(L^2+W^2)/12 = 1180*30.59/12
  // = 3008 kg m^2. The handling model does NOT use that: DEFAULT_TUNE has
  // `inertiaScale: 1.30`, i.e. Iz = 1534 kg m^2, 49% under the plate value,
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
 *   restitution  e in the normal impulse. Exit speed off a square hit is e * v,
 *                so it is near zero on the things that are supposed to stop you
 *                (a trunk bouncing the car back up the road is both odd and, as
 *                § EDGE COMPLIANCE found, the one thing that made the offset
 *                curve non-monotone).
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
 *                separates. Divided by sqrt(carry), so a folding corner still
 *                throws the car: see § EDGE COMPLIANCE.
 *   spinCap      rad/s ceiling on ONE contact's yaw change. Below vehicle.js's
 *                own 3.6 clamp on purpose, so the player still has yaw
 *                authority left to catch the slide.
 *   absorb       Extra speed bleed, applied as (1 - absorb * carry * headOn^2)
 *                where headOn = |closing| / |contact speed|. Squared so an
 *                oblique approach is free; scaled by `carry` so an off-centre
 *                one is too. This is the crumple the normal impulse does not
 *                model.
 *   edgeCarry    Optional per-material override of CHASSIS.edgeCarry. 1.0 on
 *                the barriers, because a rail spreads its load down a beam and
 *                a post line rather than into one bumper corner — and because a
 *                barrier must never be shed.
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
    // NO EDGE COMPLIANCE, and never shed. A W-beam is a continuous member
    // bolted to a post line: it spreads the load down the flank and into the
    // ground instead of concentrating it on one bumper corner, so the corner
    // does not fold round it — and a barrier that could be shed would be a hole
    // in the route. Leaving this at 1.0 is also what keeps the rail behaviour
    // the critic signed off byte-identical to the round that was signed off.
    edgeCarry: 1.0,
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
    edgeCarry: 1.0,          // a rail line, not a point: see `guard`
  },

  /**
   * MATURE TREE. The single most important curve in the file, because "a tree is
   * a stop, not an event" was the round's headline defect. Measured at 25 m/s
   * against a 0.30 m trunk, exit speed as a share of entry, by how far the
   * contact sits off the car's centreline:
   *
   *     0.0   0.2   0.4   0.6   0.8   1.0   1.1   1.2   1.3   1.4 m
   *      3%    0%   12%   25%   41%   61%   68%   72%   92%   miss
   *      0    9deg 35deg 47deg 53deg 51deg 90deg 36deg -14deg
   *
   * Hit one square and the run ends (3% and no heading). Catch one with the
   * outer third of the bumper and it costs you a corner, half your speed and
   * fifty degrees, and you drive on. Before edge compliance that whole row read
   * 15% 15% 15% 15% 15% 14% 15% 16% 63% miss — a binary with a 0.10 m window.
   *
   * restitution 0.06 is a token: it exists so a dead-centre hit reads as 0.75
   * m/s rather than exactly 0.00, which looks like the hard-stop bug this module
   * replaced. Anything higher reverses the car at full carry and puts a dip back
   * in the curve — see § EDGE COMPLIANCE.
   *
   * mu = 0.72, and it means something quite different than it did before edge
   * compliance existed. FRICTION AT A CORNER CONTACT TORQUES THE CAR THE OTHER
   * WAY — the normal impulse swings the nose off the trunk, friction dragging
   * that same corner backwards swings it back — and in the rigid model those
   * two very nearly cancelled, which is what forced mu down to 0.52 last round.
   * With the impulse capped and the shed contact exempt from the no-grind rule
   * the cancellation is weak, and mu now mostly sets how hard a corner clip
   * THROWS you. Re-measured on the same clip (trunk 0.10 m outboard of the
   * flank line) at 25 m/s: mu 0.30 / 0.45 / 0.52 / 0.60 / 0.72 / 0.85 gives
   * 1.20 / 1.65 / 1.86 / 2.10 / 2.46 / 2.85 rad/s of peak yaw, and exit speed
   * barely moves at all (69 / 68 / 68 / 68 / 67 / 67%). 0.72 is bark against
   * sheet steel and it is also where the clip reads best: two thirds of the
   * speed kept and the car pitched properly sideways.
   *
   * deflect 0.15 stops the dead-on case feeling like the old hard stop: there is
   * always a little slide past the trunk, so the car is never welded to it. It
   * only applies to contacts too central to shed — past shedEdge the corner has
   * folded and there is nothing left to deflect off.
   */
  trunk: {
    restitution: 0.06, friction: 0.72, spin: 0.12, spinCap: 3.20,
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
    restitution: 0.08, friction: 0.85, spin: 0.08, spinCap: 2.40,
    absorb: 0.58, deflect: 0.30, eventSpeed: 3.0,
    // A boulder is 1.0-2.4 m across (surveyed) and presents a BROAD face, so a
    // bumper corner cannot fold round it the way it folds round a 0.30 m trunk
    // — more of the car is engaged whatever part of the bumper lands on it.
    // Without this a corner clip on stone came out at 65% of entry against the
    // trunk's 69%, i.e. indistinguishable; at 0.55 it is 44%.
    edgeCarry: 0.55,
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
   * CORNER BOARD / MARKER / SIGN. Now live: roads.js tags the hairpin marker
   * boards `post` (r 0.70), and they stand 2.2 m outside the verge — precisely
   * where a car running wide goes.
   *
   * RETUNED TO YIELD, and the placement is the argument. As a solid material it
   * took a 25 m/s pass down to 15.6 and 31 degrees out of shape: a 1.4 m-wide
   * obstacle you cannot see coming, sitting in the band the game wants you to
   * use. props.js already refuses to make roadside stone solid for exactly this
   * reason ("a rock you cannot see coming, in the band where the game wants you
   * to be, is not a hazard — it is a wall"), and a plywood board on two stakes
   * has far better claim to yielding than a boulder does. So the car mows it
   * down: 6% of speed, no depenetration, no spin, and an event at 5 m/s so the
   * FX owner still gets a bang and a shower of plywood out of it.
   */
  post: {
    yields: true, yieldCost: 0.06, eventSpeed: 5.0,
    restitution: 0, friction: 0, spin: 0, spinCap: 0, absorb: 0, deflect: 0,
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

// SHED (see § SHED at the solver). A folded corner stays folded just long
// enough for the car to get past the thing that folded it: 0.80 s covers the
// 5.1 m of chassis that has to clear at the 8 m/s minimum fold speed, with a
// little over. Bounding it by TIME rather than distance is what stops a shed
// obstacle becoming a hole the player can turn round and drive back through.
const SHED_LIFE = 0.80;          // s
const SHED_MIN_CLOSING = 8;      // m/s — below this a corner dents, it does not fold

const SLOP = 0.005;              // m of penetration left alone — stops contact chatter
const MAX_PUSH = 0.40;           // m per contact. Never teleport: a push bigger than
                                 // this is a degenerate case (car spawned inside a
                                 // rock), and walking it out over several frames
                                 // beats a jump.
// ...and a budget for the WHOLE step, which is what actually bounds the worst
// case. A barrier's penetration is measured along its face normal, and that is
// only a true overlap while the car is on one side of it: smash a timber bay at
// 45 degrees, carry on, and the neighbouring bay reports the car's 2.16 m
// diagonal reach across the line as "depth 1.77 m". Measured — that is a real
// case, and it was a 1.8 m teleport.
//
// Expressed as a RATE rather than a per-step distance, because the thing that
// reads as a teleport is metres per second, not metres per frame: the first
// version budgeted 0.60 m per step, which at the shell's 1/120 is 72 m/s and
// looked exactly like the jump it was meant to prevent. 14 m/s is 0.117 m at
// 1/120 and 0.233 m at 1/60 — still an order of magnitude faster than any
// legitimate overlap can accumulate, since the swept solver never lets a
// contact get deeper than MAX_ADVANCE — and it walks the 1.77 m straddle out
// over 15 frames, an eighth of a second, instead of one.
const MAX_PUSH_RATE = 14;        // m/s of depenetration
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

  // -------------------------------------------------------------------------
  // § SHED — why an off-centre hit can end with the car still moving
  // -------------------------------------------------------------------------
  // Capping the impulse at an off-centre contact is NOT enough on its own, and
  // measuring it is the only way to find that out. The impulse is proportional
  // to the closing speed, so a capped contact leaves the car still closing, it
  // contacts again next step, and the sequence is a geometric decay to a dead
  // stop: with the cap alone, exit speed at every offset from 0.10 to 1.00 m
  // came out at 0-7% — WORSE than the flat 15% it was meant to fix.
  //
  // What actually happens to a car that clips a tree with the outer third of
  // its bumper is that the corner FOLDS, and the tree ends up sitting in the
  // fold. The contact is not weaker, it is gone: the geometry the solver is
  // testing no longer exists. So past `shedEdge` an obstacle delivers its one
  // impulse and is then ignored for the rest of the pass — the car's own bumper
  // corner passes through it, which at this camera height (the car is 4% of the
  // frame) is a few frames of 0.3 m overlap that nobody can see.
  //
  // PROPS ONLY, and only above SHED_MIN_CLOSING. A barrier is a continuous
  // surface whose entire job is keeping the car on the stage — shedding one
  // would put a hole in the route. And a corner that is merely leant on does
  // not fold, so creeping into a trunk on the throttle still stops you dead.
  let shed = vehicle._collideShed ?? null;
  if (shed) {
    for (const [c, t] of shed) {
      const left = t - dt;
      if (left > 0) shed.set(c, left); else shed.delete(c);
    }
    if (shed.size === 0) shed = null;
  }

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
    vehicle._collideShed = shed;      // still ticking down; the pass may resume
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
        if (shed?.has(c)) continue;                  // folded past it — see § SHED
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
        MAX_PUSH_RATE * dt - pushBudget);
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

      // -- EDGE COMPLIANCE ----------------------------------------------------
      // THE FIX FOR "A TREE IS A STOP, NOT AN EVENT".
      //
      // Measured before this existed: exit speed off a 0.30 m trunk at 25 m/s
      // was a FLAT 15% of entry at every lateral offset from 0.00 m to 1.20 m,
      // then 63% at 1.30 and a clean miss at 1.40. A 0.10 m cliff between
      // "lose 85%" and "lose nothing", with only the spin varying in between.
      //
      // The cause is not the material and not `absorb`. It is that a CIRCLE
      // whose centre lies laterally inside the box always finds its closest
      // point on the flat front FACE, so the contact normal is exactly square
      // at every offset out to the half-width. `headOn` is therefore 1.0
      // everywhere, and the headOn^2 weighting that is supposed to make a graze
      // cheap never sees a graze. Only the lever arm varies, which is why only
      // the spin varied. Chamfering the box would not fix it either: measured
      // off car.js, the drawn car really is blunt in plan — the splitter is
      // 2.00 m wide right at the nose against 2.14 m over the arches, a 6 deg
      // bevel.
      //
      // What is actually missing is that the solver treats the car as RIGID, so
      // every contact must remove all of the approach velocity at the contact
      // point, wherever on the car it lands. Real cars do not do that: hit a
      // tree with the middle of the bumper and the whole front structure loads
      // and you stop; hit it with the last 20 cm and the corner folds, sheds
      // the contact, and the car yaws round it and carries on. The impulse a
      // contact can deliver is limited by the structure behind it.
      //
      // `carry` is that: the share of the car standing behind this contact, 1
      // in the middle of a face and `edgeCarry` at its edge. It scales the
      // impulse, the crumple and the no-grind rule together, so one number
      // moves the whole outcome and the curve stays monotone.
      const conL = arx * fx + arz * fz;            // contact point, body frame
      const conS = arx * rx + arz * rz;
      const nL = nx * fx + nz * fz;                // normal, body frame
      const nS = nx * rx + nz * rz;
      // How far ACROSS the contacted face the contact sits: 0 at its middle, 1
      // at its edge. Blended by the normal, so it reads the lateral coordinate
      // on the nose and the longitudinal one on a flank — which is why a T-bone
      // at the B-pillar is full strength and one at the front wheel is not.
      const edge = clamp(
        (Math.abs(conS) / CHASSIS.halfWidth) * Math.abs(nL)
        + (Math.abs(conL) / CHASSIS.halfLength) * Math.abs(nS), 0, 1);
      const carry = 1 - (1 - (mat.edgeCarry ?? CHASSIS.edgeCarry))
        * Math.pow(edge, CHASSIS.crushPower);
      // Does this contact FOLD the corner rather than merely load it? Props
      // only, far enough out, and hard enough. Decided here because the answer
      // changes what the rest of the contact is allowed to do to the car.
      const willShed = !_cand.seg && edge > CHASSIS.shedEdge
        && closing >= SHED_MIN_CLOSING;

      // -- the impulse --------------------------------------------------------
      // Softened lever (see MATERIALS.spin) used in the effective mass AND in
      // the torque, so the pair stays a consistent rigid-body solution: the
      // contact really does end up separating.
      // The linear impulse is discounted by `carry`; the ANGULAR one is not
      // discounted as hard. A corner that folds round a trunk keeps delivering
      // torque for as long as it is crushing — the tree is a pivot — so the
      // rotation survives an impact the structure could not stop. sqrt() makes
      // Δω scale as sqrt(carry) rather than carry: at the very edge that is 47%
      // of the full angular response instead of 22%, which is the difference
      // between being thrown sideways and being nudged.
      const g = mat.spin / Math.sqrt(carry);
      const levN = (arz * nx - arx * nz) * g;
      const kN = invM + levN * levN * invI;
      const e = closing > REST_SPEED ? mat.restitution : 0;
      const Jn = (((1 + e) * closing) / kN) * carry;

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
      // that went into bending things: weighted by headOn^2 so an oblique
      // approach is cheap (0.26^2 = 7% of the coefficient at 15 degrees), and by
      // `carry` so an off-centre one is too — only the corner folded, so only
      // the corner's worth of energy went into folding it.
      const headOn = carSpeed > 0.5 ? clamp(closing / carSpeed, 0, 1) : 1;
      const keep = 1 - mat.absorb * carry * headOn * headOn;
      vx *= keep; vz *= keep;

      // -- NO-GRIND GUARANTEE -------------------------------------------------
      // An obstacle deflects the car; it never welds it to the scenery. If the
      // centre of mass is still driving into the surface after all of the above
      // (it can be — the rotation that was supposed to carry the contact clear
      // is capped), take that component out and hand `deflect` of it back along
      // the face. On steel that is the whole thing: you lose nothing and leave
      // pointing down the road. On a trunk it is a sixth, which is just enough
      // that the car crawls clear instead of parking against the bark.
      //
      // Scaled by `carry` for the same reason the impulse is: a surface can only
      // insist you stop approaching it as hard as the part of the car touching
      // it can push back. Without this the rule undid the whole edge-compliance
      // fix — the capped impulse deliberately leaves the centre of mass still
      // closing, and an unscaled no-grind zeroed exactly that residue and put
      // every offset back to a dead stop.
      //
      // A SHED contact is exempt: the corner has folded, so there is nothing
      // left there to push back with, and the car is going past rather than
      // grinding. Measured — with the rule still firing on a shed contact it
      // removed carry-worth of the residue every step and put a 0.40 m offset
      // hit back to a 4% exit. It is the last thing that was flattening the
      // curve.
      const vnC = willShed ? 0 : vx * nx + vz * nz;
      if (vnC < 0) {
        const was = Math.hypot(vx, vz);
        const take = vnC * carry;
        vx -= nx * take; vz -= nz * take;
        if (mat.deflect > 0 && tl > 1e-4) {
          const give = -take * mat.deflect;
          vx += tx * give; vz += tz * give;
        }
        // REDIRECT, NEVER ADD. Taking a component off the normal and handing the
        // same magnitude to the tangent is not energy-neutral when the车 already
        // had tangential speed — measured, the 15 deg rail glance came out at
        // 106% of entry, i.e. the barrier was accelerating the car. Cap the
        // result at what we walked in with.
        const now = Math.hypot(vx, vz);
        if (now > was && now > 1e-6) { const k = was / now; vx *= k; vz *= k; }
      }

      // -- shed the folded corner ---------------------------------------------
      if (willShed) (shed ??= new Map()).set(_cand.obj, SHED_LIFE);

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
  vehicle._collideShed = shed;

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
