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

export function buildCarMesh({ body = 0xef4d4d, accent = 0xffffff } = {}) {
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
  ]), darkBody));
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
  ]), darkBody));

  // Four rally light pods, wide and flat so their TOP faces read from above.
  const pods = [];
  for (const z of [-0.57, -0.19, 0.19, 0.57]) pods.push(box(0.30, 0.11, 0.30, 2.28, 1.18, z));
  root.add(new THREE.Mesh(mergeGeometries(pods), lightMat));

  root.add(new THREE.Mesh(mergeGeometries([
    box(0.12, 0.18, 0.42, 2.64, 0.82, 0.55),
    box(0.12, 0.18, 0.42, 2.64, 0.82, -0.55),
  ]), lightMat));

  // Tail lights sit on the very back edge, tall enough to catch the camera
  // even at 61 degrees — they are the only thing that says "braking".
  const tails = new THREE.Mesh(mergeGeometries([
    box(0.13, 0.24, 0.58, -2.14, 0.94, 0.56),
    box(0.13, 0.24, 0.58, -2.14, 0.94, -0.56),
  ]), tailMat);
  root.add(tails);

  // Livery: a bonnet/deck spine plus two roof bars. Pure readability at range.
  root.add(new THREE.Mesh(mergeGeometries([
    box(1.24, 0.03, 0.17, 1.34, 1.135, 0.34),                 // bonnet stripes
    box(1.24, 0.03, 0.17, 1.34, 1.135, -0.34),
    box(0.56, 0.03, 0.26, -1.92, 1.205, 0),                   // boot spine
    box(1.14, 0.03, 0.22, -0.62, 1.675, 0.42),                // roof bars
    box(1.14, 0.03, 0.22, -0.62, 1.675, -0.42),
  ]), new THREE.MeshBasicMaterial({ color: accent })));

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
  const rimMat = new THREE.MeshLambertMaterial({ color: 0xe8c34a, flatShading: true });

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

    this.chassis = new THREE.Group();
    // Reparent everything under a chassis node so we can lean and bounce it.
    while (this.root.children.length) this.chassis.add(this.root.children[0]);
    this.root.add(this.chassis);

    this.suspension = this.wheels.map(() => 0);
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
  update(dt, v, ground, sampleHeight) {
    const k = (rate) => 1 - Math.exp(-rate * Math.max(dt, 1e-5));

    // Suspension: the vehicle owns the vertical spring (so the feel layer can
    // read landing impacts from it); we just consume the deflection.
    const ride = v.updateVertical ? v.updateVertical(dt, ground.height) : 0;

    this.root.position.set(v.position.x, ground.height, v.position.z);
    this.root.rotation.y = v.heading;

    // ---- weight transfer ---------------------------------------------------
    // Roll comes from real lateral acceleration, not a slip proxy, so it loads
    // up as the car takes a set and unwinds as the slide is caught.
    const targetRoll = clamp(-(v.rollAccel ?? 0) * 0.030 - (v.lateralSlip ?? 0) * 0.10, -0.30, 0.30);
    const targetPitch = clamp(-(v.pitchAccel ?? 0) * 0.0135, -0.10, 0.10);
    this._roll += (targetRoll - this._roll) * k(11);
    this._pitch += (targetPitch - this._pitch) * k(9);

    // Conform to the ground normal so the car hugs hills.
    const n = ground.normal;
    const slopeX = Math.atan2(n.x, n.y);
    const slopeZ = Math.atan2(n.z, n.y);
    const c = Math.cos(-v.heading), s = Math.sin(-v.heading);
    const localPitch = slopeX * c - slopeZ * s;
    const localRoll = slopeX * s + slopeZ * c;

    this.chassis.rotation.z = this._pitch - localPitch;
    this.chassis.rotation.x = this._roll + localRoll;

    // Body rides on the springs: dive, squat and terrain bounce.
    this._bodyY += (ride - this._bodyY) * k(20);
    this.chassis.position.y = clamp(this._bodyY, -0.30, 0.30);

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
      // Wheels stay planted: undo the body's vertical move, add corner load.
      w.position.y = 0.46 - this.chassis.position.y + this.suspension[i];
      this.hubs[i].rotation.z = -this.wheelSpin;
    }

    // ---- plant each wheel on its own patch of ground -----------------------
    //
    // The line above only undoes the chassis's vertical TRANSLATION. The wheels
    // are children of the chassis, so they also inherit its roll and pitch
    // ROTATION, which swings the outer wheels down through the terrain on any
    // camber or under any body roll — that is the sinking you can see.
    //
    // Rather than trying to invert the tilt analytically, measure it: put the
    // wheel where the transform actually left it, ask the world how high the
    // ground is at that exact point, and correct the difference. Costs four
    // height samples a frame.
    if (sampleHeight) {
      this.root.updateMatrixWorld(true);
      for (let i = 0; i < 4; i++) {
        const w = this.wheels[i];
        w.getWorldPosition(_wp);
        const want = sampleHeight(_wp.x, _wp.z) + WHEEL_R;
        // The travel has to be generous in BOTH directions. An earlier version
        // allowed only 0.12 m of drop, which made wheels hang up to 0.87 m in
        // the air whenever the ground fell away — off a camber, over a road
        // cut, on the inside of a bank. Track the surface up and down; the
        // range below is wide enough to cover the worst facet a wheel can
        // straddle without ever letting one float or bury.
        w.position.y += clamp(want - _wp.y, -0.75, 0.75);
      }
    }

    // ---- lights ------------------------------------------------------------
    const braking = !!v._braking || (v.speed > 4 && (v.pitchAccel ?? 0) < -5);
    this.tails.material.color.setHex(braking ? 0xff4242 : 0x8a1616);
  }
}
