#!/usr/bin/env node
/**
 * HEADLESS COLLISION BENCH
 * ------------------------
 * Drives src/core/collision.js with synthetic worlds and prints what the car
 * comes out the other side with. No three.js, no browser, no game.js: the whole
 * point of the module having a plain-numbers interface is that this file can
 * exist.
 *
 *   node tools/collide-test.mjs
 *   node tools/collide-test.mjs --csv          # machine-readable
 *
 * Exit code is 1 if any case fails its assertion, so a retune that breaks the
 * feel cannot land quietly.
 */
import {
  resolveCollisions, penetrationAt, MATERIALS, CHASSIS, classifyCollider,
} from '../src/core/collision.js';

const CSV = process.argv.includes('--csv');
const DEG = 180 / Math.PI;

// --- the fake vehicle ------------------------------------------------------
// Only the fields collision.js touches. `step` here is vehicle.js's last three
// lines and nothing else — no drive, no tyres, no drag — so every number below
// is attributable to the collision and to nothing but the collision.
function makeCar(x, z, heading, vx, vz, yawRate = 0) {
  return {
    tune: { mass: 1180, inertiaScale: 1.30 },
    position: { x, y: 0, z },
    velocity: { x: vx, y: 0, z: vz },
    heading, yawRate,
    lastImpact: 0, contactCount: 0,
    impactDir: { set() {} },
    commits: 0,
    commitExternalResolve() { this.commits++; },
    integrate(dt) {
      // DEFAULT_TUNE.yawDamp = 0.95 is the one piece of the handling model
      // reproduced here (torque -= yawRate * yawDamp * Iz, i.e. a 1.05 s time
      // constant). Without it the heading integrates without bound and the
      // reported heading change is a number about the length of the test run
      // rather than about the collision.
      this.yawRate *= Math.exp(-0.95 * dt);
      this.yawRate = Math.max(-3.6, Math.min(3.6, this.yawRate));
      this.heading += this.yawRate * dt;
      this.position.x += this.velocity.x * dt;
      this.position.z += this.velocity.z * dt;
    },
  };
}

const speedOf = (c) => Math.hypot(c.velocity.x, c.velocity.z);

// --- worlds ----------------------------------------------------------------
const flatGround = () => ({ height: 0, normal: { x: 0, y: 1, z: 0 }, onRoad: true, onBridge: false });

/**
 * A run of contiguous bays along +x, centred on the origin, exactly as roads.js
 * lays them: BAY = 4.4 m pitch, half = 2.2, outward normal toward -z (the car's
 * side). BREAK_SPEED = 7 m/s is roads.js's own constant.
 */
function railWorld(kind, bays = 7, zLine = 0) {
  const segments = [];
  for (let i = 0; i < bays; i++) {
    segments.push({
      x: (i - (bays - 1) / 2) * 4.4, z: zLine, dx: 1, dz: 0, half: 2.2,
      nx: 0, nz: -1, kind, broken: false, id: i,
    });
  }
  const broken = [];
  return {
    barriers: {
      segments,
      hit(id, speed) {
        const s = segments[id];
        if (!s || s.kind !== 'fence' || s.broken) return false;
        if (!(speed >= 7)) return false;
        s.broken = true; broken.push({ id, speed });
        return true;
      },
      broken,
    },
    colliders: () => [],
    groundAt: flatGround,
  };
}

function propWorld(list) {
  return {
    barriers: { segments: [], hit: () => false },
    colliders: () => list,
    groundAt: flatGround,
  };
}

// --- runner ----------------------------------------------------------------
/**
 * Runs until 1.2 s after the first contact (or `maxT`), which is the window a
 * player actually experiences: long enough for the yaw the hit injected to have
 * played out under damping, short enough that the reported heading change is
 * about the collision and not about how long the loop ran.
 */
function run(name, { car, world, dt = 1 / 120, maxT = 3.0, settle = 1.2, expect }) {
  const h0 = car.heading;
  const v0 = speedOf(car);
  let peakYaw = 0, deepest = 0, contacts = 0, broke = 0;
  const kinds = new Set();
  let tFirst = -1, maxResidual = 0;
  let discreteDepth = 0;      // what a single end-of-step test would have seen

  let teleport = 0;           // worst single-step depenetration, metres
  for (let t = 0; t < maxT; t += dt) {
    car.integrate(dt);
    const bx = car.position.x, bz = car.position.z;
    // A/B for the swept solver: how deep the car would already be if we only
    // ever tested the end-of-step pose, which is what the old code did.
    discreteDepth = Math.max(discreteDepth,
      penetrationAt(car.position.x, car.position.z, car.heading, world));
    const evs = resolveCollisions(car, world, dt);
    // How far the solver moved the car on top of its own motion. The old
    // push-out was unbounded; this must stay under MAX_PUSH_STEP.
    teleport = Math.max(teleport, Math.hypot(car.position.x - bx, car.position.z - bz));
    for (const e of evs) {
      contacts++; kinds.add(e.kind); deepest = Math.max(deepest, e.depth);
      if (e.broke) broke++;
      if (tFirst < 0) tFirst = t;
    }
    // The solver has run; nothing solid may still be inside the car.
    maxResidual = Math.max(maxResidual,
      penetrationAt(car.position.x, car.position.z, car.heading, world));
    peakYaw = Math.max(peakYaw, Math.abs(car.yawRate));
    if (tFirst >= 0 && t > tFirst + settle) break;
  }

  const v1 = speedOf(car);
  let dh = (car.heading - h0) % (Math.PI * 2);
  if (dh > Math.PI) dh -= Math.PI * 2;
  if (dh < -Math.PI) dh += Math.PI * 2;
  const resid = penetrationAt(car.position.x, car.position.z, car.heading, world);

  const row = {
    name,
    vIn: v0, vOut: v1, kept: v0 > 0 ? v1 / v0 : 0,
    dHeadingDeg: dh * DEG,
    yawOut: car.yawRate, peakYaw,
    depthResolved: deepest, depthDiscrete: discreteDepth,
    residual: resid, maxResidual, teleport,
    contacts, broke, kinds: [...kinds].join('+') || '-',
  };
  row.pass = expect ? expect(row, car, world) : true;
  return row;
}

const rows = [];
const add = (...a) => rows.push(run(...a));

// ===========================================================================
// 1. HEAD-ON INTO A GUARDRAIL
// The rail runs along +x at z = 0; the car drives straight at it from z < 0.
// heading = -90 deg makes forward = (0, +1).
// ===========================================================================
for (const v of [10, 20, 35]) {
  add(`guard head-on ${v} m/s`, {
    car: makeCar(0, -6, -Math.PI / 2, 0, v),
    world: railWorld('guard'),
    expect: (r) => r.contacts > 0 && r.residual < 0.02 && r.vOut < v * 0.45,
  });
}

// ===========================================================================
// 2. 15-DEGREE GLANCE ON A GUARDRAIL AT 30 m/s
// MUST slide, MUST NOT stop. This is the case the whole `guard` material was
// tuned around.
// ===========================================================================
{
  const a = 15 / DEG, v = 30;
  add('guard 15deg glance 30 m/s', {
    car: makeCar(-14, -2.2, -a, v * Math.cos(a), v * Math.sin(a)),
    world: railWorld('guard', 11),
    expect: (r) => r.contacts > 0 && r.kept > 0.80 && r.residual < 0.02,
  });
}

// ===========================================================================
// 3. FRONT-LEFT CORNER INTO A TRUNK AT 25 m/s
// heading = 0 -> forward = (+1, 0), right = (0, +1), so the car's LEFT is -z.
// A 0.35 m trunk (props.js p50 is 0.29, p90 0.34) sitting on the left flank
// line at z = -0.95 is clipped by the corner and nothing else.
// ===========================================================================
add('trunk front-left corner 25 m/s', {
  car: makeCar(-14, 0, 0, 25, 0),
  world: propWorld([{ x: 0, z: -0.95, r: 0.35 }]),
  expect: (r) => r.contacts > 0 && r.peakYaw > 1.5 && r.residual < 0.02,
});
// Same corner, but the trunk 0.27 m further out, so the contact normal is
// oblique rather than straight up the car's nose. This is the tree-clip a
// player actually has: it spins AND it lets you drive on.
add('trunk corner CLIP oblique 25 m/s', {
  car: makeCar(-14, 0, 0, 25, 0),
  world: propWorld([{ x: 0, z: -1.22, r: 0.35 }]),
  expect: (r) => r.contacts > 0 && r.peakYaw > 0.5 && r.kept > 0.45,
});

// ===========================================================================
// 4. SIDE-ON INTO A TRUNK (T-BONE) AT 25 m/s
// Same heading, but the car is travelling sideways to its right. Reported
// twice: dead on the centre of the flank (lever arm exactly zero, so the
// correct answer is a huge speed loss and NO spin) and at the front axle line,
// which is where a T-bone really lands.
// ===========================================================================
add('trunk T-bone mid-flank 25 m/s', {
  car: makeCar(0, -14, 0, 0, 25),
  world: propWorld([{ x: 0, z: 0, r: 0.35 }]),
  expect: (r) => r.contacts > 0 && r.vOut < 8 && r.peakYaw < 0.35,
});
add('trunk T-bone front axle 25 m/s', {
  car: makeCar(0, -14, 0, 0, 25),
  world: propWorld([{ x: 1.35, z: 0, r: 0.35 }]),
  expect: (r) => r.contacts > 0 && r.vOut < 10 && r.peakYaw > 0.8,
});

// ===========================================================================
// 5. TIMBER FENCE — holds at 5 m/s, smashes at 12 m/s (roads.js BREAK_SPEED 7)
// ===========================================================================
add('fence head-on 5 m/s (holds)', {
  car: makeCar(0, -6, -Math.PI / 2, 0, 5),
  world: railWorld('fence'),
  expect: (r, c, w) => r.contacts > 0 && w.barriers.broken.length === 0 && r.residual < 0.02,
});
add('fence head-on 12 m/s (breaks)', {
  car: makeCar(0, -6, -Math.PI / 2, 0, 12),
  world: railWorld('fence'),
  expect: (r, c, w) => w.barriers.broken.length === 1 && r.broke === 1 && r.kept > 0.6,
});
// Corner-first at 45 deg: closing is 8.5 m/s, still over BREAK_SPEED, and the
// lever arm means the smash kicks the car sideways instead of just scaling its
// speed — which is the whole reason a break is delivered as an impulse.
{
  const a = 45 / DEG, v = 12;
  add('fence 45deg corner 12 m/s (breaks)', {
    car: makeCar(-6, -6, -a, v * Math.cos(a), v * Math.sin(a)),
    world: railWorld('fence', 9),
    expect: (r, c, w) => w.barriers.broken.length >= 1 && r.broke >= 1 && r.peakYaw > 0.1,
  });
}

// ===========================================================================
// 6. SAPLING AT 30 m/s — must barely register
// ===========================================================================
add('sapling 30 m/s', {
  car: makeCar(-14, 0, 0, 30, 0),
  world: propWorld([{ x: 0, z: 0, r: 0.30, kind: 'sapling' }]),
  expect: (r) => r.kept > 0.94 && r.peakYaw < 0.05,
});

// ===========================================================================
// 7. TUNNELLING — one 1/60 s step at 40 m/s (0.667 m of travel per step)
//   (a) running ALONG a rail bay, 0.15 m laterally into it
//   (b) crossing the rail line square on
// Both must register the contact and end the step outside the barrier.
// `depthDiscrete` is what a single end-of-step test would have had to dig the
// car out of; `depthResolved` is what the swept solver actually saw.
// ===========================================================================
// Along the rail at 40.0 m/s total, drifting into it at 5 m/s (7.2 deg) so the
// clip is real. 0.667 m of travel per step, bays 4.4 m long: nothing may slip
// between two bays, and no frame may end with the car inside the beam.
add('rail pass ALONG at 40 m/s, dt=1/60', {
  car: makeCar(-26, -2.4, 0, 39.69, 5.0),
  world: railWorld('guard', 15),
  dt: 1 / 60, maxT: 1.6, settle: 1.0,
  expect: (r, c) => r.contacts > 0 && r.maxResidual < 0.02
    && r.kept > 0.75 && c.position.z < 0,      // never ended up behind the rail
});
// Square across the rail line at 40 m/s. The car cannot geometrically tunnel a
// 4.2 x 1.9 m box through a rail in 0.667 m — the OBB alone fixes that — but a
// discrete end-of-step test still finds it 0.56 m in, deeper than the beam is
// thick, and has to teleport it back out. The sweep catches it at 0.06.
add('rail CROSS at 40 m/s, dt=1/60', {
  car: makeCar(0, -1.30, 0, 0, 40),
  world: railWorld('guard', 15),
  dt: 1 / 60, maxT: 1.6, settle: 1.0,
  expect: (r) => r.contacts > 0 && r.maxResidual < 0.02 && r.depthResolved < 0.20,
});

// ===========================================================================
// EXTRA EVIDENCE — the two defects the brief calls out by name
// ===========================================================================
// A rock is not a tree: same geometry, different material.
add('rock front-left corner 25 m/s', {
  car: makeCar(-14, 0, 0, 25, 0),
  world: propWorld([{ x: 0, z: -0.95, r: 1.20 }]),
});
// Head-on vs corner on the SAME trunk: the circle model could not tell these
// apart at all.
add('trunk square nose 25 m/s', {
  car: makeCar(-14, 0, 0, 25, 0),
  world: propWorld([{ x: 0, z: 0, r: 0.35 }]),
});
// THE PHANTOM WIDTH. A 0.30 m trunk whose centre is 1.45 m off the centreline
// clears the 0.95 m flank by 0.20 m and is hit by nothing. The old 1.5 m circle
// reached 1.80 m and stopped the car dead on it.
add('clearance: trunk 0.20 m off the flank, 30 m/s', {
  car: makeCar(-14, 0, 0, 30, 0),
  world: propWorld([{ x: 0, z: 1.45, r: 0.30 }]),
  maxT: 1.2,
  expect: (r) => r.contacts === 0 && r.kept > 0.999,
});

// --- report ----------------------------------------------------------------
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '  -  ');

if (CSV) {
  console.log('case,vIn,vOut,kept,dHeadingDeg,yawOut,peakYaw,depthResolved,depthDiscrete,residual,maxResidual,teleport,contacts,broke,kinds,pass');
  for (const r of rows) {
    console.log([r.name, f(r.vIn), f(r.vOut), f(r.kept, 3), f(r.dHeadingDeg, 1), f(r.yawOut, 3),
      f(r.peakYaw, 3), f(r.depthResolved, 4), f(r.depthDiscrete, 4), f(r.residual, 4), f(r.maxResidual, 4), f(r.teleport, 4),
      r.contacts, r.broke, r.kinds, r.pass].join(','));
  }
} else {
  console.log('');
  console.log(`chassis ${CHASSIS.halfLength * 2} x ${CHASSIS.halfWidth * 2} m   `
    + `m ${CHASSIS.mass} kg   Iz ${CHASSIS.inertia.toFixed(0)} kg m^2 `
    + `(plate m(L^2+W^2)/12 = ${(CHASSIS.mass * (4.2 ** 2 + 1.9 ** 2) / 12).toFixed(0)})`);
  console.log('');
  const head = 'case'.padEnd(34)
    + ['v in', 'v out', 'kept', 'd hdg', 'yaw', 'peak', 'pen', 'pen1x', 'move', 'n']
      .map((s) => s.padStart(7)).join('') + '  kind';
  console.log(head);
  console.log('-'.repeat(head.length + 6));
  for (const r of rows) {
    console.log(
      (r.pass === false ? 'X ' : '  ') + r.name.padEnd(32)
      + f(r.vIn, 1).padStart(7) + f(r.vOut, 2).padStart(7)
      + (r.kept * 100).toFixed(0).padStart(6) + '%'
      + f(r.dHeadingDeg, 1).padStart(7)
      + f(r.yawOut, 2).padStart(7) + f(r.peakYaw, 2).padStart(7)
      + f(r.depthResolved, 3).padStart(7) + f(r.depthDiscrete, 3).padStart(7)
      + f(r.teleport, 3).padStart(7)
      + String(r.contacts).padStart(7)
      + '  ' + r.kinds + (r.broke ? ` (broke ${r.broke})` : '')
    );
  }
  console.log('');
  console.log('v in/out m/s   kept = exit speed as a share of entry   d hdg = heading change, deg');
  console.log('yaw = exit yaw rate rad/s   peak = worst during contact   pen = penetration at the');
  console.log('moment the solver resolved it   pen1x = what a single end-of-step test would have');
  console.log('seen instead   move = worst single-step position correction: depenetration (budget');
  console.log('0.60 m) plus the swept re-integration after the impulse changed the velocity');
  console.log('');
  console.log(`inference check: r=0.29 -> ${classifyCollider({ r: 0.29 })}, `
    + `r=0.83 -> ${classifyCollider({ r: 0.83 })}, `
    + `r=1.20 -> ${classifyCollider({ r: 1.20 })}, `
    + `r=2.43 -> ${classifyCollider({ r: 2.43 })}, `
    + `kind:'bush' -> ${classifyCollider({ r: 0.4, kind: 'bush' })}`);
  console.log(`materials: ${Object.keys(MATERIALS).join(', ')}`);
}

const failed = rows.filter((r) => r.pass === false);
if (failed.length) {
  console.error(`\n${failed.length} case(s) FAILED: ${failed.map((r) => r.name).join('; ')}`);
  process.exit(1);
}
