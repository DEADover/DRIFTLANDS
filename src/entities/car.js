import * as THREE from 'three';
import { mergeGeometries } from '../world/props.js';

/**
 * THE HERO CAR — a Group B rally hatch seen from a long way up.
 *
 * It is TINY on screen (~4% of frame width), so the read order is brutal:
 *   1. plan-view SILHOUETTE — a wide, blocky, arch-flared rectangle with a
 *      wing hanging off the back. Nothing tapered, nothing subtle.
 *   2. VALUE — a bright saturated body against a dark glasshouse and near-black
 *      wheels. Three values, big areas, hard edges.
 *   3. MOTION — the roll, the squat, the opposite lock on the front wheels.
 *      At this scale, visible counter-steer is most of why a drift reads as a
 *      drift rather than as a car pointing the wrong way.
 *
 * All geometry is boxes and prisms with flat shading. No textures.
 */

const BODY_LEN = 4.15;
// Works rally livery, from the client's car reference: white shell, red and
// blue spine stripes, gold wheel centres, amber indicators.
const LIVERY_RED = 0xe4302c;
const LIVERY_BLUE = 0x1c56b8;
const WHEEL_GOLD = 0xc8912f;
const AMBER = 0xff7a1a;

const BODY_W = 1.80;
const ARCH_W = 2.14;      // arches stick out past the body — widens the plan view

function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** A thin slab rotated about Z — windscreens, backlights, spoiler blades. */
function slab(len, thick, width, x, y, z, rotZ) {
  const g = new THREE.BoxGeometry(len, thick, width);
  g.rotateZ(rotZ);
  g.translate(x, y, z);
  return g;
}

/** Trapezoid prism along X: a wedge that reads as a bonnet or roof taper. */
function wedge(len, hFront, hBack, wFront, wBack, x, y, z) {
  const g = new THREE.BufferGeometry();
  const hl = len / 2;
  const fw = wFront / 2, bw = wBack / 2;
  const v = [
    [-hl, 0, -bw], [-hl, 0, bw], [-hl, hBack, bw], [-hl, hBack, -bw],
    [hl, 0, -fw], [hl, 0, fw], [hl, hFront, fw], [hl, hFront, -fw],
  ];
  const idx = [
    0, 1, 2, 0, 2, 3,       // back
    4, 7, 6, 4, 6, 5,       // front
    1, 5, 6, 1, 6, 2,       // +z side
    0, 3, 7, 0, 7, 4,       // -z side
    3, 2, 6, 3, 6, 7,       // top
    0, 4, 5, 0, 5, 1,       // bottom
  ];
  const pos = new Float32Array(idx.length * 3);
  for (let i = 0; i < idx.length; i++) {
    const p = v[idx[i]];
    pos[i * 3] = p[0] + x; pos[i * 3 + 1] = p[1] + y; pos[i * 3 + 2] = p[2] + z;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export function buildCarMesh({ body = 0xf2f3f5, accent = 0xffffff } = {}) {
  const root = new THREE.Group();
  root.name = 'car';

  const bodyMat = new THREE.MeshLambertMaterial({ color: body, flatShading: true });
  const darkBody = new THREE.MeshLambertMaterial({
    color: new THREE.Color(body).multiplyScalar(0.74), flatShading: true,
  });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0x141c26, flatShading: true });
  const trimMat = new THREE.MeshLambertMaterial({ color: 0x1c1f25, flatShading: true });
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff4d2 });
  const tailMat = new THREE.MeshBasicMaterial({ color: 0x8a1616 });

  // ---------------------------------------------------------------- body tub
  // Main tub, plus a lower rocker that is narrower — the step reads as a
  // shadow line down each flank from above.
  const tub = box(BODY_LEN, 0.60, BODY_W, 0, 0.72, 0);
  const rocker = box(BODY_LEN - 0.5, 0.32, BODY_W - 0.30, -0.05, 0.44, 0);
  const bonnet = box(1.42, 0.16, BODY_W - 0.10, 1.30, 1.05, 0);
  const nose = wedge(0.72, 0.50, 0.66, BODY_W - 0.34, BODY_W - 0.10, 2.36, 0.46, 0);
  const bodyGeo = mergeGeometries([tub, rocker, bonnet, nose]);
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.castShadow = true;
  root.add(bodyMesh);

  // ----------------------------------------------------------- wheel arches
  // Blistered arches: the single biggest silhouette cue that this is a rally
  // car and not a shoebox. They make the plan view read wide-hipped.
  const archParts = [];
  for (const [ax, aw, ah] of [[1.34, 1.16, 0.40], [-1.32, 1.24, 0.44]]) {
    for (const s of [1, -1]) {
      const zc = s * (BODY_W / 2 + 0.02);
      archParts.push(box(aw, ah, (ARCH_W - BODY_W) / 2 + 0.16, ax, 0.86, zc));
      archParts.push(box(aw * 0.74, 0.16, (ARCH_W - BODY_W) / 2 + 0.06, ax, 1.06, zc));
    }
  }
  // Deliberately much darker than the body: at 4% of frame width a 25% value
  // step vanishes, and the flares are the whole point of the plan silhouette.
  const archMat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(body).multiplyScalar(0.34), flatShading: true,
  });
  const arches = new THREE.Mesh(mergeGeometries(archParts), archMat);
  arches.castShadow = true;
  root.add(arches);

  // ------------------------------------------------------------- glasshouse
  // From 61 degrees up, the roof panel hides anything under it. So the glass
  // has to BE the visible surface: a raked windscreen and backlight that face
  // the camera, with the body-colour roof panel a short bar between them. That
  // dark-light-dark banding is what makes the car read as a car and not a brick.
  const cabinMesh = new THREE.Mesh(mergeGeometries([
    box(2.10, 0.46, BODY_W - 0.14, -0.55, 1.24, 0),           // cabin sides
  ]), bodyMat);
  cabinMesh.castShadow = true;
  root.add(cabinMesh);

  // The glass must be TWO bands, not one mass. The side band is deliberately
  // narrower and shorter than the roof so it tucks out of sight from directly
  // above; only the raked screens face the camera.
  root.add(new THREE.Mesh(mergeGeometries([
    slab(0.86, 0.10, BODY_W - 0.24, 0.32, 1.40, 0, -0.62),    // windscreen
    slab(0.56, 0.10, BODY_W - 0.30, -1.44, 1.42, 0, 0.72),    // backlight
    box(1.18, 0.32, BODY_W - 0.20, -0.60, 1.34, 0),           // side glass band
  ]), glassMat));

  // Roof: a short bright bar between the two dark panels, wide enough to cap
  // the side glass so the cabin does not read as one black hole.
  root.add(new THREE.Mesh(mergeGeometries([
    box(1.28, 0.14, BODY_W - 0.10, -0.60, 1.60, 0),
    box(0.34, 0.09, 0.46, 0.18, 1.66, 0),                     // roof vent
    box(0.62, 0.20, BODY_W - 0.16, -1.92, 1.10, 0),           // boot deck
  ]), bodyMat));

  // ------------------------------------------------------ rally furniture
  // Roof-height rear wing on two stalks: it breaks the rectangle and gives the
  // tail a wide horizontal bar that is unmistakable from directly above.
  root.add(new THREE.Mesh(mergeGeometries([
    box(0.40, 0.08, ARCH_W - 0.06, -2.18, 1.42, 0),
    box(0.11, 0.30, 0.11, -2.12, 1.26, 0.62),
    box(0.11, 0.30, 0.11, -2.12, 1.26, -0.62),
  ]), trimMat));
  root.add(new THREE.Mesh(mergeGeometries([
    box(0.44, 0.11, 0.07, -2.18, 1.47, (ARCH_W - 0.06) / 2),
    box(0.44, 0.11, 0.07, -2.18, 1.47, -(ARCH_W - 0.06) / 2),
  ]), trimMat));

  // Front splitter, light-pod bar, bonnet scoop, mirrors.
  root.add(new THREE.Mesh(mergeGeometries([
    box(0.46, 0.09, ARCH_W - 0.14, 2.42, 0.34, 0),
    box(0.34, 0.10, 1.52, 2.28, 1.10, 0),
    box(0.18, 0.09, 0.26, 0.72, 1.30, ARCH_W / 2 + 0.02),
    box(0.18, 0.09, 0.26, 0.72, 1.30, -ARCH_W / 2 - 0.02),
  ]), trimMat));

  root.add(new THREE.Mesh(mergeGeometries([
    box(0.40, 0.10, 0.50, 1.46, 1.14, 0),                     // bonnet scoop
  ]), trimMat));

  // Four rally light pods, wide and flat so their TOP faces read from above.
  const pods = [];
  for (const z of [-0.57, -0.19, 0.19, 0.57]) pods.push(box(0.30, 0.11, 0.30, 2.28, 1.18, z));
  root.add(new THREE.Mesh(mergeGeometries(pods), lightMat));

  root.add(new THREE.Mesh(mergeGeometries([
    box(0.12, 0.18, 0.42, 2.64, 0.82, 0.55),
    box(0.12, 0.18, 0.42, 2.64, 0.82, -0.55),
  ]), lightMat));

  root.add(new THREE.Mesh(mergeGeometries([
    box(0.10, 0.13, 0.20, 2.62, 0.68, 0.86),
    box(0.10, 0.13, 0.20, 2.62, 0.68, -0.86),
  ]), new THREE.MeshBasicMaterial({ color: AMBER })));

  // Tail lights sit on the very back edge, tall enough to catch the camera
  // even at 61 degrees — they are the only thing that says "braking".
  const tails = new THREE.Mesh(mergeGeometries([
    box(0.13, 0.24, 0.58, -2.14, 0.94, 0.56),
    box(0.13, 0.24, 0.58, -2.14, 0.94, -0.56),
  ]), tailMat);
  root.add(tails);

  // ------------------------------------------------------------------ livery
  //
  // Works Group-B scheme from the client reference: a RED and a BLUE stripe
  // running side by side straight down the car's spine — bonnet, roof, boot —
  // plus a red-over-blue flash along each flank. On a white shell this is the
  // single most recognisable thing about the car, and at this camera height the
  // spine stripes are most of what identifies it as the player.
  const SPINE_W = 0.20;      // width of one stripe
  const SPINE_Z = 0.115;     // half-gap: the two stripes sit shoulder to shoulder

  const spine = (col, zSign) => new THREE.Mesh(mergeGeometries([
    box(1.26, 0.03, SPINE_W, 1.33, 1.135, zSign * SPINE_Z),   // bonnet
    box(1.30, 0.03, SPINE_W, -0.60, 1.675, zSign * SPINE_Z),  // roof
    box(0.60, 0.03, SPINE_W, -1.92, 1.205, zSign * SPINE_Z),  // boot deck
  ]), new THREE.MeshBasicMaterial({ color: col }));
  root.add(spine(LIVERY_RED, 1));
  root.add(spine(LIVERY_BLUE, -1));

  // Flank flash: red band over a blue band, at door height, both sides.
  const flank = (col, y) => new THREE.Mesh(mergeGeometries([
    box(2.55, 0.075, 0.03, -0.15, y, BODY_W / 2 + 0.005),
    box(2.55, 0.075, 0.03, -0.15, y, -BODY_W / 2 - 0.005),
  ]), new THREE.MeshBasicMaterial({ color: col }));
  root.add(flank(LIVERY_RED, 0.95));
  root.add(flank(LIVERY_BLUE, 0.87));

  // ----------------------------------------------------------------- wheels
  // Chunky gravel tyres. 12 sides so the rim reads faceted, not smooth.
  const tyreGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.42, 12);
  tyreGeo.rotateX(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.44, 8);
  rimGeo.rotateX(Math.PI / 2);
  const spokeGeo = mergeGeometries([
    box(0.46, 0.10, 0.46, 0, 0, 0),
    box(0.10, 0.46, 0.46, 0, 0, 0),
  ]);
  const tyreMat = new THREE.MeshLambertMaterial({ color: 0x14161a, flatShading: true });
  const rimMat = new THREE.MeshLambertMaterial({ color: WHEEL_GOLD, flatShading: true });

  const wheels = [];
  const hubs = [];
  const wz = ARCH_W / 2 - 0.14;
  const positions = [
    [1.34, 0.46, wz], [1.34, 0.46, -wz],
    [-1.32, 0.46, wz], [-1.32, 0.46, -wz],
  ];
  for (const [x, y, z] of positions) {
    const steerNode = new THREE.Group();      // yaw only — steering
    const spinNode = new THREE.Group();       // roll only — rotation
    const tyre = new THREE.Mesh(tyreGeo, tyreMat);
    tyre.castShadow = true;
    spinNode.add(tyre);
    spinNode.add(new THREE.Mesh(rimGeo, rimMat));
    const spokes = new THREE.Mesh(spokeGeo, rimMat);
    spokes.position.z = z > 0 ? 0.02 : -0.02;
    spinNode.add(spokes);
    steerNode.add(spinNode);
    steerNode.position.set(x, y, z);
    root.add(steerNode);
    wheels.push(steerNode);
    hubs.push(spinNode);
  }

  return { root, wheels, hubs, bodyMesh, tails, bodyMat, tailMat };
}

const clamp = THREE.MathUtils.clamp;

/** Tyre radius — must match the CylinderGeometry used to build the wheels. */
const WHEEL_R = 0.46;

/**
 * How deep the deepest wheel is allowed to sit before the seating lift reacts.
 *
 * Seating to exactly zero sounds right and is not: the lift is a MAXIMUM over
 * four wheels, so whichever wheel's ground query reads highest raises the other
 * three with it. While the height query and the drawn mesh still disagree by
 * about half a metre at wheel spacing, that overpayment showed up as a median
 * 0.221 m of FLOAT — half a tyre of daylight under a parked car, with the
 * shadow visibly detached.
 *
 * A tolerance buys some of that back for a penetration nobody can see at this
 * camera height, and the exchange rate is measured:
 *
 *   SEAT_TOL   median float   wheel samples deeper than 0.10 m
 *     0.00       -0.221 m                13.5%
 *     0.06       -0.168 m                17.1%
 *     0.15       -0.098 m                27.4%
 *
 * 0.06 because the complaint on the table is sinking, not hovering. This whole
 * constant is a symptom of the query, not a design choice: when roads and
 * terrain report the surface they actually draw, the four wheels stop
 * disagreeing by half a metre, the overpayment disappears, and this should come
 * down to a couple of centimetres.
 */
const SEAT_TOL = 0.02;

/**
 * How far a wheel may extend below its static position to reach the ground.
 *
 * A real rally car has ~0.20 m of droop; this is the visual equivalent. Bounded
 * on purpose: past the stroke the wheel stays in the air, which is what should
 * happen when the car is cocked over a crest or hanging a wheel off a verge.
 */
const DROOP_MAX = 0.20;
/** Scratch vector for per-wheel ground queries; avoids a per-frame allocation. */
const _wp = new THREE.Vector3();

/**
 * Visual layer over the Vehicle physics.
 *
 * Everything here is read from telemetry the vehicle already publishes — this
 * class never changes the simulation, it only tells the truth about it louder:
 * roll into the slide, dive under brakes, squat on power, suspension travel
 * over terrain, wheel spin, and opposite lock on the front axle.
 */
export class CarView {
  constructor(opts) {
    const built = buildCarMesh(opts);
    this.root = built.root;
    this.wheels = built.wheels;
    this.hubs = built.hubs;
    this.tails = built.tails;
    this.bodyMat = built.bodyMat;

    /**
     * TWO NODES, BECAUSE THEY ARE TWO DIFFERENT THINGS.
     *
     *   chassis — where the car IS. Carries the ground pose only, and the wheels
     *             are on it, so a wheel moves when and only when the ground
     *             under the car moves.
     *   body    — how the car LOOKS. Carries dive, squat and roll into a slide,
     *             plus the spring ride height. Purely cosmetic, and the wheels
     *             are NOT on it.
     *
     * They used to be one node, with the wheels under it, and that was quietly
     * expensive: a cosmetic lean rotated the wheels too. Measured, +0.30 rad of
     * weight-transfer roll — a value with no physical meaning at all, chosen for
     * how it reads — moved the four wheels by -0.42, +0.47, -0.49 and +0.41 m in
     * world Y, nearly a tyre diameter of spread. The old code compensated the
     * node's TRANSLATION on each wheel and never its ROTATION, so the seating
     * lift then levitated the whole car to put the deepest wheel back on the
     * ground. With the lean zeroed and nothing else changed, that lift never
     * fired at all over 60 s of driving and the wheel-to-wheel disagreement
     * collapsed from a 0.378 m median to 0.037 m: nine tenths of the problem was
     * self-inflicted here, and no amount of work on the ground queries could
     * have touched it.
     */
    this.chassis = new THREE.Group();
    this.body = new THREE.Group();
    while (this.root.children.length) this.body.add(this.root.children[0]);
    // The wheels ride with the ground, not with the lean.
    for (const w of this.wheels) this.chassis.add(w);
    this.chassis.add(this.body);
    this.root.add(this.chassis);

    this.suspension = this.wheels.map(() => 0);
    /** Low-passed rigid lift that seats the deepest wheel (see update()). */
    this._seatLift = 0;
    /** Low-passed per-wheel spring extension toward the ground (see update()). */
    this._droop = [0, 0, 0, 0];
    this.wheelSpin = 0;
    this._roll = 0;
    this._pitch = 0;
    this._bodyY = 0;

    // Headlights: a spot per side, cheap but they sell the dusk biomes.
    this.headlight = new THREE.SpotLight(0xfff0d0, 0, 90, 0.42, 0.5, 1.2);
    this.headlight.position.set(2.4, 0.8, 0);
    this.headlightTarget = new THREE.Object3D();
    this.headlightTarget.position.set(40, -6, 0);
    this.headlight.target = this.headlightTarget;
    this.root.add(this.headlight, this.headlightTarget);
  }

  setHeadlights(on) {
    this.headlight.intensity = on ? 260 : 0;
    this._lightsOn = on;
  }

  /**
   * @param {import('./vehicle.js').Vehicle} v
   * @param {{normal: THREE.Vector3, height: number}} ground
   */
  /**
   * @param {(x:number,z:number)=>number} [sampleHeight] world ground height
   *        query, used to seat each wheel individually. Optional so the view
   *        still works standalone, but the game always supplies it.
   */
  /** Drop the seating filters; used on respawn so the car does not arrive mid-lift. */
  resetSeating() {
    this._seatLift = 0;
    this._droop = [0, 0, 0, 0];
    this._bodyY = 0;
    this._roll = 0;
    this._pitch = 0;
  }

  update(dt, v, ground, sampleHeight) {
    const k = (rate) => 1 - Math.exp(-rate * Math.max(dt, 1e-5));

    // Suspension: the vehicle owns the vertical spring (so the feel layer can
    // read landing impacts from it); we just consume the deflection.
    const ride = v.updateVertical ? v.updateVertical(dt, ground.height) : 0;

    this.root.position.set(v.position.x, ground.height, v.position.z);
    const pose = ground.pose;
    this.root.rotation.y = v.heading;

    // ---- weight transfer ---------------------------------------------------
    // Roll comes from real lateral acceleration, not a slip proxy, so it loads
    // up as the car takes a set and unwinds as the slide is caught.
    const targetRoll = clamp(-(v.rollAccel ?? 0) * 0.030 - (v.lateralSlip ?? 0) * 0.10, -0.30, 0.30);
    const targetPitch = clamp(-(v.pitchAccel ?? 0) * 0.0135, -0.10, 0.10);
    this._roll += (targetRoll - this._roll) * k(11);
    this._pitch += (targetPitch - this._pitch) * k(9);

    // Orientation comes from the CONTACT-PATCH PLANE (see Game.carPose), not
    // from a terrain normal sampled under the car's centre. Those two disagree
    // on every gradient, and the disagreement is what used to bury or float the
    // wheels: the body tilted by one amount while the wheels needed another.
    //
    // Dynamic squat and roll are added ON TOP as small offsets, so weight
    // transfer still reads without ever breaking contact.
    // THE GROUND PITCH WAS APPLIED UPSIDE DOWN, AND IT IS THE SINKING.
    //
    // A rotation about local z maps a point at local x to y' = x*sin(theta).
    // The wheels sit at x = +1.34 (front) and -1.32 (rear), so a climb — where
    // carPose reports pitch > 0, nose up — needs theta > 0. It was applied as
    // -gp, which drove the uphill axle straight into the hill.
    //
    // MEASURED before the flip, by reading the world position of the four wheel
    // nodes and comparing the bottom of each tyre against the triangle beneath
    // it (tools/probe.mjs --only wheels, 1560 samples along the route):
    //
    //                 FL      FR      RL      RR
    //   climbing     +0.690  +0.670  -0.103  -0.112
    //   descending   +0.030  -0.077  +0.366  +0.301
    //
    // Equal and opposite front to rear, and the pair swaps when the gradient
    // does: the exact signature of a mirrored pitch. 62.3% of wheel samples were
    // more than 0.10 m inside the ground, mean 0.265 m, worst 2.58 m. That is
    // several times larger than the height-query error everyone had been
    // hunting, and it is why the car appeared to sink specifically on climbs and
    // descents rather than uniformly.
    const gp = pose?.pitch ?? 0;
    const gr = pose?.roll ?? 0;
    this.chassis.rotation.z = gp;
    // The ground ROLL was mirrored too, and it hid behind the pitch error until
    // that one was fixed. Same test, same evidence: with `+ gr` the four wheels
    // showed a clean left-to-right gradient (FL +0.114, FR +0.031, RL -0.078,
    // RR -0.114) that is the algebraic signature of the draw disagreeing with
    // the ride-height solve about which side of the car the roll lifts. With
    // `- gr`: p95 0.817 -> 0.546 m, max 1.835 -> 1.510, deeper than 0.10 m
    // 45.4% -> 39.6%. Better on every aggregate, so it is not a wash.
    this.chassis.rotation.x = -gr;

    // Weight transfer and the springs move the BODY over the wheels, which is
    // what they do on a real car. Nothing here reaches the contact patches, so
    // none of it can lift a tyre off the road any more.
    this.body.rotation.z = this._pitch;
    this.body.rotation.x = this._roll;
    this._bodyY += (ride - this._bodyY) * k(20);
    this.body.position.y = clamp(this._bodyY, -0.30, 0.30);

    // ---- wheels ------------------------------------------------------------
    const spinRate = (Math.abs(v.longSpeed ?? v.speed) * (1 + (v.wheelSpinBoost ?? 0) * 1.6)) / 0.46;
    this.wheelSpin += spinRate * dt;

    // Counter-steer: v.steer already contains the assist, and in a slide that
    // is opposite lock. Amplify it a touch — at this camera height a few
    // degrees of wheel angle is invisible, and this is the drift's signature.
    const steerVis = clamp((v.steer ?? 0) * 1.30, -0.78, 0.78);

    const rollN = clamp((v.rollAccel ?? 0) / 11, -1, 1);
    const pitchN = clamp((v.pitchAccel ?? 0) / 11, -1, 1);
    for (let i = 0; i < 4; i++) {
      const front = i < 2 ? 1 : -1;
      const leftSide = i % 2 === 0 ? 1 : -1;
      const corner = (pitchN * front * 0.055) + (rollN * leftSide * 0.05);
      this.suspension[i] += (corner - this.suspension[i]) * k(12);
      const w = this.wheels[i];
      w.rotation.set(0, i < 2 ? steerVis : 0, 0);
      // No "undo the body's vertical move" term any more: the body moves on its
      // own node now, so there is nothing here to cancel.
      w.position.y = 0.46 + this.suspension[i];
      this.hubs[i].rotation.z = -this.wheelSpin;
    }

    /**
     * SEAT THE WHOLE CAR, ONCE, AFTER THE TRANSFORM IS FINAL.
     *
     * Game.carPose already solves a ride height at which no wheel is under its
     * ground — but it can only account for the tilt it knows about, the ground
     * plane. Everything added here is invisible to it: the weight-transfer lean
     * (up to ±0.30 rad, which at a 0.93 m half-track is ±0.27 m of wheel travel),
     * the spring ride height, and the per-corner suspension load. Measured, that
     * is exactly the residual left after the pitch and roll signs were fixed —
     * about 0.1 m, in the shape of whichever corner was loaded at the time.
     *
     * So ask the finished scene graph where the wheels actually ended up, and
     * lift the ROOT until the deepest one is on the ground. This is not the old
     * per-wheel correction pass that had to be removed: that one moved each
     * wheel independently and so fought the chassis transform every frame. This
     * is a single rigid translation of the entire car, which cannot fight
     * anything — it changes no angle and no relative position.
     *
     * Lift only, never push down: a wheel hanging in space over a crest or a
     * verge is correct and must stay hanging. Capped, because one bad ground
     * sample must not launch the car up the screen.
     */
    if (sampleHeight) {
      this.root.updateMatrixWorld(true);
      let lift = 0;
      for (let i = 0; i < 4; i++) {
        this.wheels[i].getWorldPosition(_wp);
        const need = sampleHeight(_wp.x, _wp.z) - (_wp.y - WHEEL_R) - SEAT_TOL;
        if (need > lift) lift = need;
      }
      // Smoothed, or facet-to-facet steps in the mesh arrive as a jolt. The rise
      // is quick because ground can only push; the release is slower.
      const want = lift > 0 ? Math.min(lift, 0.55) : 0;
      this._seatLift += (want - this._seatLift) * k(lift > 0 ? 30 : 12);
      this.root.position.y += this._seatLift;

      /**
       * DROOP — the springs take up what the rigid body cannot.
       *
       * Seating the deepest wheel is the right thing to do with a RIGID car, and
       * it necessarily leaves the other three in the air: a 4.2 x 1.9 m
       * rectangle resting on a faceted surface touches at one corner and hangs
       * at the rest. Measured with the ground query now exact, that was a median
       * 0.109-0.154 m of daylight under the other wheels — real rigid-body
       * behaviour, and it reads on screen as a hovering car.
       *
       * A real car does not hover, because its suspension extends. So extend it:
       * each wheel is allowed to drop toward its own ground, within a bounded
       * travel. This is NOT the per-wheel correction pass that had to be deleted.
       * That one moved wheels to make up for a chassis placed by a different
       * rule, so the two fought every frame. This runs after the chassis is
       * final, only ever extends, and is clamped to a real suspension stroke —
       * past the stroke the wheel stays in the air, which is exactly what should
       * happen when a car is cocked over a crest.
       */
      this.root.updateMatrixWorld(true);
      /**
       * A CAR IN THE AIR HANGS ON ITS STOPS.
       *
       * DROOP_MAX is 0.20 m, which is right for a wheel hanging off a verge and
       * is 4 px at this camera — below the threshold at which anything reads. In
       * FLIGHT the springs are at full extension, and that is one of the few
       * airborne cues a top-down camera can actually show, so the stroke opens up
       * to 0.34 m (7 px per wheel, 14 px across the silhouette) whenever the pose
       * says the car is committed to a flight. `pose.airW` is the same
       * height-weighted term the airborne attitude uses, so this cannot fire on
       * the micro-hops that ordinary fast driving is full of.
       */
      const droopMax = DROOP_MAX + 0.14 * (pose?.airW ?? 0);
      for (let i = 0; i < 4; i++) {
        this.wheels[i].getWorldPosition(_wp);
        const gap = (_wp.y - WHEEL_R) - sampleHeight(_wp.x, _wp.z);
        const droop = clamp(gap, 0, droopMax);
        this._droop[i] += (droop - this._droop[i]) * k(18);
        this.wheels[i].position.y -= this._droop[i];
      }
    }

    // ---- lights ------------------------------------------------------------
    const braking = !!v._braking || (v.speed > 4 && (v.pitchAccel ?? 0) < -5);
    this.tails.material.color.setHex(braking ? 0xff4242 : 0x8a1616);
  }
}
