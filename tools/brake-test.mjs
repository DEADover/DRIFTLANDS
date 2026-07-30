#!/usr/bin/env node
/**
 * BRAKING GROUND TRUTH
 * --------------------
 * Drives `src/entities/vehicle.js` directly in Node — no browser, no renderer,
 * no world. The vehicle model is plain JS and needs nothing but `three`, so the
 * only thing between the numbers and the tyre model is this file.
 *
 * Why this exists: the client says "it is too hard to brake at high speed".
 * That is a claim about metres and seconds, so it gets answered in metres and
 * seconds, against the real-car reference (~1.0 g on tarmac, 0.6-0.7 g on
 * gravel) — not by raising `brakeForce` until it feels better.
 *
 *   node tools/brake-test.mjs                 # baseline vs working tree
 *   node tools/brake-test.mjs --before HEAD~1
 *   node tools/brake-test.mjs --only after
 *
 * Deterministic: fixed 1/120 step, no clock, no random.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const av = process.argv.slice(2);
const args = { before: 'baseline', only: null };
for (let i = 0; i < av.length; i++) {
  if (av[i] === '--before') args.before = av[++i];
  else if (av[i] === '--only') args.only = av[++i];
}

const DT = 1 / 120;
const G = 9.81;

/** The surfaces the game actually puts under the car (roads.js GRIP + game.js). */
const SURFACES = [
  ['tarmac', 1.00],
  ['gravel', 0.80],
  ['dirt', 0.72],
  ['sand', 0.63],
  ['snow', 0.54],
  ['ice', 0.40],
];
const SPEEDS = [20, 30, 40];

/** Real-car reference deceleration, g, for the same surface class. */
const REAL_G = { tarmac: 1.00, gravel: 0.65, dirt: 0.60, sand: 0.50, snow: 0.30, ice: 0.15 };

async function loadModule(rev) {
  if (rev === null) return import(path.join(ROOT, 'src/entities/vehicle.js'));
  // The temp copy has to live inside the project so that `import 'three'`
  // still resolves against the project's node_modules.
  const tmp = path.join(ROOT, 'tools', `.vehicle-${rev.replace(/[^\w]/g, '_')}.mjs`);
  const src = execSync(`git show ${rev}:src/entities/vehicle.js`, { cwd: ROOT, maxBuffer: 1 << 24 });
  writeFileSync(tmp, src);
  try { return await import(tmp); } finally { setTimeout(() => { try { unlinkSync(tmp); } catch {} }, 0); }
}

function makeCar(Vehicle, grip) {
  const v = new Vehicle();
  v.reset(0, 0, 0);              // heading 0 => forward is +X
  v.surfaceGrip = grip;
  return v;
}

/**
 * Straight-line stop from `v0`. Returns time, distance and the deceleration
 * profile. Speed is TOTAL speed, so a car that brakes itself sideways is
 * honestly penalised — sideways is not stopping.
 */
function stopTest(Vehicle, grip, v0) {
  const v = makeCar(Vehicle, grip);
  v.velocity.set(v0, 0, 0);
  const input = { throttle: 0, brake: 1, steer: 0, handbrake: 0 };
  let t = 0, prev = v0, peak = 0, sum = 0, n = 0;
  const x0 = v.position.x, z0 = v.position.z;
  let firstFull = null;           // time until 90% of peak decel is reached
  while (t < 20) {
    v.step(DT, input);
    t += DT;
    const s = v.velocity.length();
    const d = (prev - s) / DT;
    if (t > 0.02) { peak = Math.max(peak, d); sum += d; n++; }
    prev = s;
    if (s < 0.5) break;
  }
  for (const _ of [0]) void _;
  const dist = Math.hypot(v.position.x - x0, v.position.z - z0);
  // Re-run to find how long the car takes to reach 90% of its own peak: a brake
  // that ramps in slowly reads as "weak" even when the steady number is fine.
  {
    const w = makeCar(Vehicle, grip);
    w.velocity.set(v0, 0, 0);
    let tt = 0, p = v0;
    while (tt < 3) {
      w.step(DT, input);
      tt += DT;
      const s = w.velocity.length();
      if ((p - s) / DT >= peak * 0.9) { firstFull = tt; break; }
      p = s;
    }
  }
  return {
    v0, time: t, dist,
    peakG: peak / G,
    meanG: (v0 - Math.max(prev, 0)) / t / G,
    riseT: firstFull,
    driftDeg: (v.driftAngle * 180) / Math.PI,
  };
}

/**
 * TRAIL BRAKING — the drift must survive the fix.
 * Enter a corner at 30 m/s, hold steer, then brake. Measure how much yaw the
 * car develops. If braking gets strong enough to plant the car, this number
 * collapses and the game is broken even though the stopping table looks great.
 */
function trailBrakeTest(Vehicle, grip, { brake = 0.7, steer = 0.8, handbrake = 0, v0 = 30 } = {}) {
  const v = makeCar(Vehicle, grip);
  v.velocity.set(v0, 0, 0);
  let peakYaw = 0, peakBeta = 0, t = 0;
  // A second of steady cornering first, so the measurement is the BRAKE's
  // contribution to rotation, not the corner entry's.
  while (t < 1.0) { v.step(DT, { throttle: 0.4, brake: 0, steer, handbrake: 0 }); t += DT; }
  const yaw0 = Math.abs(v.yawRate), beta0 = v.driftAngle;
  t = 0;
  while (t < 2.0) {
    v.step(DT, { throttle: 0, brake, steer, handbrake });
    t += DT;
    peakYaw = Math.max(peakYaw, Math.abs(v.yawRate));
    peakBeta = Math.max(peakBeta, v.driftAngle);
  }
  return {
    yaw0, peakYaw, beta0Deg: (beta0 * 180) / Math.PI,
    peakBetaDeg: (peakBeta * 180) / Math.PI,
    endSpeed: v.velocity.length(),
  };
}

/**
 * BRAKING STABILITY — the number the client is actually feeling.
 *
 * Nobody brakes in a laboratory straight line. They brake on the way into a
 * corner with a bit of lock on. If the rear lets go the instant the pedal goes
 * down, the *usable* brake is far weaker than the straight-line table says, and
 * the player learns to feather it — which is exactly "the speed drops too
 * slowly at high speed".
 *
 * So: hold a modest steer, apply `brake`, and report both what was shed and how
 * far the car rotated. Slip past ~55 deg with no handbrake asked for is a spin,
 * not a drift.
 */
function stabilityTest(Vehicle, grip, { v0 = 40, steer = 0.2, brake = 1, secs = 1.5 } = {}) {
  const v = makeCar(Vehicle, grip);
  v.velocity.set(v0, 0, 0);
  let t = 0, peakBeta = 0, at1 = null;
  while (t < secs) {
    v.step(DT, { throttle: 0, brake, steer, handbrake: 0 });
    t += DT;
    peakBeta = Math.max(peakBeta, v.driftAngle);
    if (at1 === null && t >= 1.0) at1 = v.velocity.length();
  }
  return {
    shed1s: v0 - (at1 ?? v.velocity.length()),
    peakBetaDeg: (peakBeta * 180) / Math.PI,
    endSpeed: v.velocity.length(),
  };
}

/**
 * USABLE BRAKE — the largest brake input that still leaves the car pointed
 * where it is going (peak slip under 30 deg) while turning in at 40 m/s, and
 * the deceleration that input actually delivers. This is the honest answer to
 * "how hard can I brake at speed", and it is the number the fix has to move.
 */
function usableBrake(Vehicle, grip, opts = {}) {
  let lo = 0, hi = 1;
  const ok = (b) => stabilityTest(Vehicle, grip, { ...opts, brake: b }).peakBetaDeg < 30;
  if (ok(1)) { lo = 1; }
  else for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
  const r = stabilityTest(Vehicle, grip, { ...opts, brake: lo });
  return { brake: lo, shed1s: r.shed1s, g: r.shed1s / G, peakBetaDeg: r.peakBetaDeg };
}

/**
 * STOPPING OUT OF A SLIDE. This is a drift game: the player is rarely pointed
 * where they are going when they reach for the brake. Brake force acts along
 * the body axis, so at 30 deg of slip only cos(30) of it opposes travel — and
 * below vx 0.4 m/s the model used to read the brake as REVERSE.
 */
function slideStopTest(Vehicle, grip, betaDeg, v0 = 30) {
  const v = makeCar(Vehicle, grip);
  const b = (betaDeg * Math.PI) / 180;
  // heading 0, velocity rotated by beta => the car is travelling sideways-ish
  v.velocity.set(v0 * Math.cos(b), 0, v0 * Math.sin(b));
  v.heading = 0;
  let t = 0, prev = v0;
  const input = { throttle: 0, brake: 1, steer: 0, handbrake: 0 };
  while (t < 12 && v.velocity.length() > 0.5) { v.step(DT, input); t += DT; prev = v.velocity.length(); }
  return { betaDeg, time: t, meanG: (v0 - prev) / t / G };
}

/** Coasting: throttle and brake both shut. Engine braking only. */
function coastTest(Vehicle, grip, v0) {
  const v = makeCar(Vehicle, grip);
  v.velocity.set(v0, 0, 0);
  let t = 0;
  const input = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  while (t < 6 && v.velocity.length() > v0 - 10) { v.step(DT, input); t += DT; }
  return { dv: v0 - v.velocity.length(), t, g: (v0 - v.velocity.length()) / t / G };
}

/**
 * WHERE THE BRAKE FORCE GOES. Replays one frame of hard braking at the loads
 * the car settles at, and reports how much of the commanded brake force each
 * axle can actually hold. This is the diagnostic that says whether the answer
 * is "more force" or "a different limit".
 */
function biasAudit(Vehicle, grip, v0) {
  const v = makeCar(Vehicle, grip);
  v.velocity.set(v0, 0, 0);
  const input = { throttle: 0, brake: 1, steer: 0, handbrake: 0 };
  // settle the weight transfer filter
  for (let i = 0; i < 60; i++) v.step(DT, input);
  const d = v.brakeDiag;
  if (!d) return null;
  return d;
}

// ---------------------------------------------------------------------------

function fmt(n, w = 6, d = 2) { return (n === null || n === undefined ? '--' : n.toFixed(d)).padStart(w); }

async function runAll(mod) {
  const { Vehicle } = mod;
  const stops = [];
  for (const [name, grip] of SURFACES) {
    for (const v0 of SPEEDS) stops.push({ name, grip, ...stopTest(Vehicle, grip, v0) });
  }
  const trails = [];
  for (const [name, grip] of [['tarmac', 1.0], ['gravel', 0.80], ['dirt', 0.72]]) {
    trails.push({ name, ...trailBrakeTest(Vehicle, grip) });
    trails.push({ name: name + '+hb', ...trailBrakeTest(Vehicle, grip, { handbrake: 1, brake: 0 }) });
  }
  const stab = [];
  for (const [name, grip] of SURFACES.slice(0, 4)) {
    stab.push({ name, full: stabilityTest(Vehicle, grip), usable: usableBrake(Vehicle, grip) });
  }
  const slides = [0, 15, 30, 45, 60, 85].map((b) => slideStopTest(Vehicle, 0.80, b));
  const coasts = SURFACES.slice(0, 3).map(([name, grip]) => ({ name, ...coastTest(Vehicle, grip, 40) }));
  const bias = SURFACES.slice(0, 3).map(([name, grip]) => ({ name, d: biasAudit(Vehicle, grip, 40) }));
  return { stops, trails, coasts, bias, stab, slides };
}

const before = args.only === 'after' ? null : await runAll(await loadModule(args.before));
const after = args.only === 'before' ? null : await runAll(await loadModule(null));

const L = console.log;

L('');
L('STOPPING — full brake, no steer, total speed to below 0.5 m/s.  Reference: a real car');
L('is ~1.0 g on tarmac and 0.6-0.7 g on gravel; this is ARCADE so it may sit above that,');
L('but the SHAPE (tarmac > gravel > dirt > snow > ice) has to hold.');
L('');
L('                        BEFORE                          AFTER');
L('  surf   grip  v0   time   dist  peakG  meanG      time   dist  peakG  meanG    real g');
for (let i = 0; i < (before ?? after).stops.length; i++) {
  const b = before?.stops[i], a = after?.stops[i];
  const r = b ?? a;
  L(`  ${r.name.padEnd(6)} ${r.grip.toFixed(2)} ${String(r.v0).padStart(3)}  ` +
    `${fmt(b?.time, 5)}s ${fmt(b?.dist, 6, 1)}m ${fmt(b?.peakG, 6)} ${fmt(b?.meanG, 6)}    ` +
    `${fmt(a?.time, 5)}s ${fmt(a?.dist, 6, 1)}m ${fmt(a?.peakG, 6)} ${fmt(a?.meanG, 6)}   ` +
    `${fmt(REAL_G[r.name], 5)}`);
}

L('');
L('BRAKE RISE — seconds from brake application to 90% of the car\'s own peak decel.');
for (const v0 of SPEEDS) {
  const b = before?.stops.find((s) => s.name === 'gravel' && s.v0 === v0);
  const a = after?.stops.find((s) => s.name === 'gravel' && s.v0 === v0);
  L(`  gravel ${String(v0).padStart(3)} m/s   before ${fmt(b?.riseT, 6, 3)} s    after ${fmt(a?.riseT, 6, 3)} s`);
}

if ((after ?? before).bias.some((x) => x.d)) {
  L('');
  L('WHERE THE BRAKE FORCE GOES — one frame of full braking from 40 m/s, settled.');
  L('  "held" is what the tyre can actually take; anything commanded past it is thrown away.');
  L('                     front                          rear                    total');
  L('  surf     Fz     cmd    cap    held      Fz     cmd    cap    held        N     g');
  for (const side of [['BEFORE', before], ['AFTER', after]]) {
    if (!side[1]) continue;
    L(`  --- ${side[0]}`);
    for (const { name, d } of side[1].bias) {
      if (!d) { L(`  ${name.padEnd(7)} (no diag in this revision)`); continue; }
      const total = Math.abs(d.fxFront) + Math.abs(d.fxRear) + d.drag;
      L(`  ${name.padEnd(7)}${fmt(d.Fzf, 6, 0)}  ${fmt(-d.fxFrontCmd, 6, 0)} ${fmt(d.frontCap, 6, 0)} ${fmt(-d.fxFront, 6, 0)}   ` +
        `${fmt(d.Fzr, 6, 0)}  ${fmt(-d.fxRearCmd, 6, 0)} ${fmt(d.rearCap, 6, 0)} ${fmt(-d.fxRear, 6, 0)}   ` +
        `${fmt(total, 7, 0)} ${fmt(total / 1180 / G, 5)}`);
    }
  }
}

L('');
L('BRAKING INTO A CORNER — 40 m/s, steer 0.2 held, 1.5 s. THE HEADLINE FOR TASK B:');
L('slip past 55 deg with no handbrake is a spin, and a spin is why the player stops');
L('using the brake. "usable" is the biggest brake input that keeps peak slip under 30 deg.');
L('                     BEFORE                                AFTER');
L('  surf     full: shed/1s  peakSlip | usable  g       full: shed/1s  peakSlip | usable  g');
for (let i = 0; i < (before ?? after).stab.length; i++) {
  const b = before?.stab[i], a = after?.stab[i];
  const r = b ?? a;
  const row = (x) => x
    ? `${fmt(x.full.shed1s, 7, 1)}  ${fmt(x.full.peakBetaDeg, 7, 1)} | ${fmt(x.usable.brake, 5)} ${fmt(x.usable.g, 5)}`
    : '        --       -- |    --    --';
  L(`  ${r.name.padEnd(7)} ${row(b)}    ${row(a)}`);
}

L('');
L('STOPPING OUT OF A SLIDE — gravel, 30 m/s, full brake, no steer.');
L('  slip  before time  meanG   |  after time  meanG');
for (let i = 0; i < (before ?? after).slides.length; i++) {
  const b = before?.slides[i], a = after?.slides[i];
  L(`  ${String((b ?? a).betaDeg).padStart(3)}d  ${fmt(b?.time, 8)}s ${fmt(b?.meanG, 6)}   |  ${fmt(a?.time, 7)}s ${fmt(a?.meanG, 6)}`);
}

L('');
L('COASTING — engine braking only, from 40 m/s.');
for (let i = 0; i < (before ?? after).coasts.length; i++) {
  const b = before?.coasts[i], a = after?.coasts[i];
  L(`  ${(b ?? a).name.padEnd(7)} before ${fmt(b?.g, 5, 3)} g     after ${fmt(a?.g, 5, 3)} g`);
}

L('');
L('DRIFT PROVOCATION — 1 s of steady cornering at 30 m/s, then 2 s of the input named.');
L('The drift IS the game: peak slip angle must NOT collapse.');
L('                          BEFORE                     AFTER');
L('  case          yawRate  slip@entry  peakSlip     yawRate  peakSlip   endSpeed');
for (let i = 0; i < (before ?? after).trails.length; i++) {
  const b = before?.trails[i], a = after?.trails[i];
  const r = b ?? a;
  L(`  ${r.name.padEnd(12)} ${fmt(b?.peakYaw, 6, 2)}  ${fmt(b?.beta0Deg, 8, 1)}  ${fmt(b?.peakBetaDeg, 8, 1)}    ` +
    `${fmt(a?.peakYaw, 6, 2)}  ${fmt(a?.peakBetaDeg, 8, 1)}   ${fmt(a?.endSpeed, 7, 1)}`);
}
L('');
