#!/usr/bin/env node
/**
 * TIMBER FENCE — DOES IT BREAK THE WAY YOU ACTUALLY HIT IT?
 *
 * The complaint was that wooden fences are too hard to break, "and even on a
 * side collision". That second clause is the whole problem: the break test used
 * the closing speed along the contact NORMAL, and the way a player meets a
 * barrier in a drifting game is sideways at a shallow angle, where the normal
 * component is a couple of m/s while the car is carrying twenty along the rail.
 *
 * So this sweeps APPROACH ANGLE, not just speed, and reports how many bays came
 * out. A fence that only breaks at 90 degrees is the bug.
 *
 *   node tools/collide-fence.mjs
 */
import { resolveCollisions, MATERIALS, CHASSIS } from '../src/core/collision.js';

const BREAK_LOAD = 3.5;   // mirrors roads.js BREAK_SPEED

function railWorld(kind, bays = 13) {
  const segments = [];
  for (let i = 0; i < bays; i++) {
    segments.push({
      x: (i - (bays - 1) / 2) * 4.4, z: 0, dx: 1, dz: 0, half: 2.2,
      nx: 0, nz: -1, kind, broken: false, id: i,
    });
  }
  const broken = [];
  return {
    barriers: {
      segments,
      hit(id, load) {
        const s = segments[id];
        if (!s || s.kind !== 'fence' || s.broken) return false;
        if (!(load >= BREAK_LOAD)) return false;
        s.broken = true; broken.push({ id, load });
        return true;
      },
      broken,
    },
    colliders: () => [],
    groundAt: () => ({ height: 0, normal: { x: 0, y: 1, z: 0 }, onRoad: true, onBridge: false }),
  };
}

function makeCar(x, z, heading, vx, vz) {
  return {
    position: { x, y: 0, z },
    velocity: { x: vx, y: 0, z: vz, length: () => Math.hypot(vx, vz) },
    heading, yawRate: 0,
    tune: { mass: CHASSIS.mass, inertiaScale: 1.30 },
    onGround: true, speed: Math.hypot(vx, vz),
    commitExternalResolve() {},
  };
}

/**
 * Drive at the rail from `deg` off parallel. 0 deg = sliding straight along it,
 * 90 deg = square into it. The car is aimed along its own velocity, which is the
 * gentlest possible case; a real drift arrives crossed up and loads it harder.
 */
function run(deg, v, dt = 1 / 120, seconds = 2.0) {
  const a = (deg * Math.PI) / 180;
  const vx = v * Math.cos(a), vz = v * Math.sin(a);
  // Start clear of the rail and let the sweep carry the car into it.
  const world = railWorld('fence');
  const car = makeCar(-18, -3.2, a, vx, vz);
  let peakLoad = 0, events = 0;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    car.position.x += car.velocity.x * dt;
    car.position.z += car.velocity.z * dt;
    car.heading += car.yawRate * dt;
    car.speed = Math.hypot(car.velocity.x, car.velocity.z);
    car.velocity.length = () => Math.hypot(car.velocity.x, car.velocity.z);
    const hits = resolveCollisions(car, world, dt);
    for (const h of hits) { events++; if (h.speed > peakLoad) peakLoad = h.speed; }
  }
  return {
    bays: world.barriers.broken.length,
    exit: Math.hypot(car.velocity.x, car.velocity.z),
    kept: Math.hypot(car.velocity.x, car.velocity.z) / v,
    peakLoad, events,
  };
}

const f = (x, d = 2) => x.toFixed(d);
console.log('');
console.log('TIMBER FENCE — bays knocked out vs APPROACH ANGLE (0 = sliding along the rail)');
console.log(`  break load ${BREAK_LOAD}, tangential share ${MATERIALS.fence.tangentialBreak ?? 0}`);
console.log('');
for (const v of [8, 15, 25, 35]) {
  const cells = [];
  for (const deg of [5, 10, 20, 30, 45, 60, 90]) {
    const r = run(deg, v);
    cells.push(`${String(deg).padStart(2)}deg:${String(r.bays).padStart(2)}`);
  }
  console.log(`  ${String(v).padStart(2)} m/s   ${cells.join('  ')}`);
}
console.log('');
console.log('DETAIL at 25 m/s');
console.log('  angle   bays   exit m/s   kept   peak closing   events');
for (const deg of [5, 10, 15, 20, 30, 45, 60, 90]) {
  const r = run(deg, 25);
  console.log(`  ${String(deg).padStart(3)}    ${String(r.bays).padStart(4)}     ${f(r.exit)}    ${f(r.kept * 100, 0)}%      ${f(r.peakLoad)}      ${r.events}`);
}
console.log('');
console.log('A NUDGE MUST STILL HOLD — square on, low speed');
console.log('  v m/s   bays   exit m/s');
for (const v of [1.5, 2.5, 3.5, 5, 7]) {
  const r = run(90, v, 1 / 120, 3.0);
  console.log(`  ${f(v, 1).padStart(5)}   ${String(r.bays).padStart(4)}     ${f(r.exit)}`);
}
console.log('');
console.log('GUARDRAIL MUST NEVER BREAK');
for (const deg of [10, 45, 90]) {
  const a = (deg * Math.PI) / 180;
  const world = railWorld('guard');
  const car = makeCar(-18, -3.2, a, 35 * Math.cos(a), 35 * Math.sin(a));
  for (let i = 0; i < 240; i++) {
    car.position.x += car.velocity.x / 120; car.position.z += car.velocity.z / 120;
    car.heading += car.yawRate / 120;
    car.speed = Math.hypot(car.velocity.x, car.velocity.z);
    car.velocity.length = () => Math.hypot(car.velocity.x, car.velocity.z);
    resolveCollisions(car, world, 1 / 120);
  }
  console.log(`  ${String(deg).padStart(2)}deg at 35 m/s -> bays broken ${world.barriers.broken.length} (must be 0)`);
}
console.log('');
