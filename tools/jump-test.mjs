#!/usr/bin/env node
/**
 * THE JUMP, MEASURED
 * ------------------
 * Boots the real build headless, puts the car on the approach at a series of
 * speeds, and reports what the physics actually does with it: take-off speed,
 * LAUNCH VERTICAL SPEED, apex ABOVE THE LIP, air time, distance cleared, landing
 * fall speed, whether the stream was cleared and where it came down.
 *
 * The car is driven, not teleported through the air — every row below is
 * `game.update(dt, input)` at the real 60 Hz step with the real vehicle model,
 * so anything the tyres, the slope bleed or the suspension do to the number is
 * in the number.
 *
 * THREE THINGS THIS TOOL PROVES, not asserts:
 *
 *   1. APEX OVER THE LIP. Before the launch fix this was 0.00 m at every
 *      approach speed, because `_stepVertical` zeroed `_carVY` on every grounded
 *      frame and the ramp's angle contributed nothing. It is the single number
 *      that says whether the car launches or walks off a ledge.
 *   2. THE ORDINARY-ROAD CONTROL (--control). Carrying the ground's rate of rise
 *      makes every crest in the world a potential launcher, so the same run is
 *      measured over the whole route with the jump's footprint excluded. If that
 *      airtime moved, the stage became a trampoline and the gate is wrong.
 *   3. SLOW MOTION DOES NOT MOVE THE CAR (--slowmo). Physics runs on a fixed
 *      1/120 accumulator, so time scaling may only change how many frames the
 *      same steps are spread over. Same jump, slow-mo on and off, same landing.
 *
 * Every mode runs against ONE binary: `game.noLaunch` reproduces the pre-launch
 * behaviour exactly, so "before" and "after" are the same build measuring itself.
 *
 *   node tools/jump-test.mjs --base http://127.0.0.1:5218
 *   node tools/jump-test.mjs --base ... --before        # the old model
 *   node tools/jump-test.mjs --base ... --control 150   # ordinary road, both
 *   node tools/jump-test.mjs --base ... --slowmo        # the A/B trajectory
 *
 * Exit code 1 on a page error, or if the design point (the measured approach
 * speed) fails to clear the water.
 */
import { chromium } from 'playwright';

const av = process.argv.slice(2);
const args = {
  base: 'http://127.0.0.1:5173', preset: 'hero_alpine', speeds: null,
  before: false, control: 0, slowmo: false,
};
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--preset') args.preset = av[++i];
  else if (a === '--speeds') args.speeds = av[++i].split(',').map(Number);
  else if (a === '--before') args.before = true;
  else if (a === '--control') args.control = Number(av[i + 1]?.startsWith('--') ? 150 : av[++i]);
  else if (a === '--slowmo') args.slowmo = true;
  else if (a === '--json') args.json = av[++i];
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${args.base}/?shot=${args.preset}&hud=0`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 180000 });

const out = await page.evaluate(async ({ speeds, before, control, slowmo }) => {
  const g = window.__GAME;
  const J = g.jump;
  if (!J?.site) return { note: 'no jump sited' };
  const S = J.site;
  const fx = Math.cos(S.heading), fz = -Math.sin(S.heading);
  const nx = -fz, nz = fx;
  /** Station along the jump's own frame: 0 is the take-off lip. */
  const along = (x, z) => (x - S.x) * fx + (z - S.z) * fz;
  const across = (x, z) => (x - S.x) * nx + (z - S.z) * nz;

  // The APPROACH SPEED the autopilot really arrives at, for the design column.
  const measureApproach = () => {
    // drive from a long way back on the route, autopilot, full throttle
    const dt = 1 / 60;
    const startT = (S.t - 0.075 + 1) % 1;
    const p = g.roads.sample(startT);
    g.vehicle.reset(p.x, p.z, p.heading);
    g.resetPose();
    let best = null;
    for (let i = 0; i < 60 * 30; i++) {
      g.update(dt, g.autopilotInput({ throttle: 1, aggression: 0.85 }));
      const s = along(g.vehicle.position.x, g.vehicle.position.z);
      if (s > -34 && s < -30) { best = g.vehicle.speed; break; }
    }
    return best;
  };
  g.noLaunch = !!before;
  const approach = measureApproach();

  /** Profile of the drawn landing surface, for classifying where a car came down. */
  const surf = (s) => {
    const x = S.x + fx * s, z = S.z + fz * s;
    const j = J.heightAt(x, z);
    return { jump: j, ground: g.groundAt(x, z).height };
  };
  // The far edge of the water and the landing crest, read off the module itself.
  let crestS = 0, crestY = -1e9;
  for (let s = S.gap; s < S.gap + 30; s += 0.25) {
    const h = J.heightAt(S.x + fx * s, S.z + fz * s);
    if (h != null && h - surf(s).ground + 0 > -1e9) {
      const rel = h - g.roads.heightAt(S.x + fx * s, S.z + fz * s);
      if (rel > crestY) { crestY = rel; crestS = s; }
    }
  }
  let rampEnd = crestS;
  for (let s = crestS; s < S.gap + 60; s += 0.25) {
    const h = J.heightAt(S.x + fx * s, S.z + fz * s);
    if (h == null) break;
    const r = g.roads.heightAt(S.x + fx * s, S.z + fz * s);
    if (h - r > 0.12) rampEnd = s;
  }

  const run = (target, opts = {}) => {
    const dt = 1 / 60;
    g.noLaunch = opts.before ?? !!before;
    if (g.feel) g.feel.slowMoEnabled = opts.slowMo !== false;
    // Start 96 m back on the jump's own straight, on the centreline.
    const s0 = -96;
    const x0 = S.x + fx * s0, z0 = S.z + fz * s0;
    g.vehicle.reset(x0, z0, S.heading);
    g.resetPose();
    g.vehicle.velocity.set(fx * target, 0, fz * target);
    // A/B RUNS MUST START FROM THE SAME CLOCK. The fixed-step accumulator keeps
    // a remainder between calls and `feel` keeps whatever time scale the last
    // run left it in; leaving either alone moved the landing by 0.33 m between
    // two runs that were supposed to be identical, which would have been read as
    // slow motion changing the trajectory when it was the harness's own state.
    g.accumulator = 0;
    g.feel?.reset?.();
    const jump0 = g.feel?.jumpCount ?? 0;
    // The trajectory, keyed by FIXED STEP INDEX rather than by frame. This is
    // the only honest way to A/B slow motion: the physics advances in 1/120
    // steps and a frame consumes two of them at 1x and less than one at 0.4x,
    // so comparing per-FRAME samples compares different step counts and reports
    // a third of a metre of "difference" that is the harness's own sampling.
    const trace = new Map();
    const stepBase = Math.round(g.simTime * 120);

    let takeoff = null, land = null, apex = -1e9;
    let wasAir = false, air = 0;
    let peakScale = 1, slowFrames = 0;
    let prev = { s: s0, y: 0 };
    let prevVy = 0;
    // 14 s of SIM time; in slow motion the same sim second costs more frames, so
    // the frame budget has to be scaled or the flight is cut off mid-air.
    let sim = 0;
    for (let i = 0; i < 60 * 60 && sim < 14; i++) {
      const v = g.vehicle;
      const s = along(v.position.x, v.position.z);
      // Hold the target speed on the run-in; once past the lip the driver is
      // flat out, exactly as a real one would be.
      let throttle = 1, brake = 0;
      if (s < -2) {
        const e = target - v.speed;
        throttle = Math.max(0, Math.min(1, 0.25 + e * 0.6));
        brake = e < -1.2 ? Math.min(1, -e * 0.3) : 0;
      }
      const ts = g.feel?.timeScale ?? 1;
      peakScale = Math.min(peakScale, ts);
      if (ts < 0.995) slowFrames++;
      g.update(dt, { throttle, brake, steer: 0, handbrake: 0 });
      sim += dt * ts;

      const ns = along(v.position.x, v.position.z);
      const y = g._carY;
      // AIRBORNE IS `_carY` OVER THE GROUND, NOT `vehicle.onGround`.
      //
      // `onGround` is written twice per step: vehicle.updateVertical sets it
      // from the SUSPENSION (`_bodyY < suspTravel * 0.92`) and _stepVertical
      // sets it from the ballistic clamp. The suspension one wins in the read,
      // and over a gap the body takes a third of a second to extend — so the
      // first version of this tool reported the car leaving the ground 13 m past
      // the lip, on the far bank. The clamp condition itself is unambiguous.
      //
      // ...AND TOUCHDOWN IS THE CLAMP FIRING, not `_carY` reaching the ground.
      // A car that comes down on a 1:8 run-out at 38 m/s meets ground falling at
      // 4.8 m/s while its own fall restarts from zero, so it floats a few
      // centimetres over the ramp for the next ten metres. Testing a height
      // threshold called that a continuing flight and reported the landing 12 m
      // late. `_carVY` only ever INCREASES when the clamp resets it, so that is
      // the unambiguous signal.
      const gh = g.groundAt(v.position.x, v.position.z).height;
      const vy = g._carVY ?? 0;
      const airborne = y > gh + 0.05;
      const touched = wasAir && (vy > prevVy + 1e-6 || y <= gh + 0.005);
      if (airborne && !wasAir && ns > -6) {
        takeoff = { s: prev.s, y: prev.y, speed: v.speed, t: i * dt, vy };
        wasAir = true;
      }
      if (wasAir) {
        air += dt * ts;
        apex = Math.max(apex, y);
        trace.set(Math.round(g.simTime * 120) - stepBase, [v.position.x, v.position.z, y]);
        if (touched) {
          land = {
            s: ns, y, speed: v.speed, air, fall: -prevVy,
            u: across(v.position.x, v.position.z),
            x: v.position.x, z: v.position.z,
          };
          break;
        }
      }
      prev = { s: ns, y };
      prevVy = vy;
    }
    if (!takeoff) return { target, note: 'never left the ground' };
    if (!land) return { target, takeoff, note: 'never came down' };
    const dist = land.s - takeoff.s;
    // The ford's water spans 0 .. gap in this frame.
    const cleared = land.s >= S.gap;
    const where = !cleared ? 'WATER'
      : land.s < crestS ? 'bank face'
        : land.s <= rampEnd ? 'landing ramp' : 'road past the ramp';
    return {
      target,
      takeoffSpeed: takeoff.speed,
      takeoffS: takeoff.s,
      launchVY: takeoff.vy,
      lipY: takeoff.y,
      airTime: land.air,
      distance: dist,
      apexOverLip: apex - takeoff.y,
      peakOverWater: apex - S.fordY,
      landingS: land.s,
      landingSpeed: land.speed,
      landingFall: land.fall,
      landingDrop: takeoff.y - land.y,
      lateral: land.u,
      landX: land.x, landZ: land.z,
      peakScale, slowFrames,
      trace: [...trace.entries()],
      jumpEvents: (g.feel?.jumpCount ?? 0) - jump0,
      cleared,
      where,
    };
  };

  const list = speeds && speeds.length ? speeds
    : [approach, approach * 0.9, approach * 0.8, approach * 0.7, approach * 0.6, approach * 0.5, approach * 0.4]
      .map((v) => Math.round(v * 10) / 10);
  const rows = list.map((t) => run(t));

  // ------------------------------------------------------------------ control
  /**
   * ORDINARY ROAD. The same autopilot lap with the jump's footprint excluded,
   * measuring what the launch model does to ground that was never meant to throw
   * anything: peak airtime, peak launch velocity, and — the number the gate is
   * actually set from — the longest continuous steep climb the route presents.
   */
  const controlRun = (noLaunch, seconds) => {
    const dt = 1 / 60;
    g.noLaunch = noLaunch;
    const p = g.roads.sample(0.02);
    g.vehicle.reset(p.x, p.z, p.heading);
    g.resetPose();
    let peakAir = 0, peakVY = 0, peakRise = 0, peakGate = 0, air = 0, wasAir = false;
    let where = null, nJumps = 0;
    // TOTAL airborne time, not just the peak: the two drives DIVERGE (a launch
    // changes the line, and from then on they are different laps), so a single
    // worst-case event is not a like-for-like comparison. The share of the run
    // spent off the ground is.
    let totalAir = 0, sampled = 0;
    if (g.feel) g.feel.slowMoEnabled = true;
    const fx0 = g.feel?.jumpCount ?? 0;
    let fxAt = fx0; const fxWhere = [];
    // How often the SUSTAINED-CLIMB gate opens at all. This is the number that
    // says whether ordinary road texture can pass for a ramp: every kerb, rut
    // edge and facet the car crosses is a candidate, and only a real climb
    // accumulates enough rise.
    let gateOpens = 0, gateWasOpen = false;
    const sites = [];
    let riseWhere = null;
    for (let i = 0; i < seconds * 60; i++) {
      g.update(dt, g.autopilotInput({ throttle: 1, aggression: 0.85 }));
      const v = g.vehicle;
      const s = along(v.position.x, v.position.z);
      const u = across(v.position.x, v.position.z);
      // The jump's own footprint, generously: 110 m before the toe to 110 m past
      // the run-out and 40 m either side of the centreline.
      const inside = s > -110 && s < 110 && Math.abs(u) < 40;
      // THE COUNTER HAS TO BE READ EVERY FRAME, INSIDE THE FOOTPRINT TOO.
      // Reading it only outside made the real jump's own firework surface as a
      // stray on the first frame the car left the exclusion zone — reported at
      // (465, 149), which is s = 110.4 m, one metre past the boundary.
      const jc = g.feel?.jumpCount ?? 0;
      if (jc > fxAt) {
        if (!inside) {
          const gg = g.groundAt(v.position.x, v.position.z);
          fxWhere.push([Math.round(v.position.x), Math.round(v.position.z),
            gg.onBridge ? 'bridge' : gg.onRoad ? 'road' : 'off-road']);
        }
        fxAt = jc;
      }
      if (inside) { wasAir = false; air = 0; continue; }
      if ((g._rampRise ?? 0) > peakRise) {
        peakRise = g._rampRise;
        const gg = g.groundAt(v.position.x, v.position.z);
        riseWhere = [Math.round(v.position.x), Math.round(v.position.z),
          gg.onBridge ? 'bridge' : gg.onRoad ? 'road' : 'off-road'];
      }
      peakGate = Math.max(peakGate, g._rampGate ?? 0);
      const open = (g._rampGate ?? 0) > 0;
      if (open && !gateWasOpen) gateOpens++;
      gateWasOpen = open;
      const y = g._carY, gh = g.groundAt(v.position.x, v.position.z).height;
      const airborne = y > gh + 0.05;
      if (airborne) {
        if (!wasAir) {
          const vy = g._carVY ?? 0;
          peakVY = Math.max(peakVY, vy);
          if (vy > 4) {
            nJumps++;
            const gg = g.groundAt(v.position.x, v.position.z);
            sites.push({
              vy: +vy.toFixed(2), x: Math.round(v.position.x), z: Math.round(v.position.z),
              spd: +v.speed.toFixed(1),
              kind: gg.onBridge ? 'bridge' : gg.onRoad ? 'road' : 'off-road',
            });
          }
        }
        air += dt;
        if (air > peakAir) { peakAir = air; where = [Math.round(v.position.x), Math.round(v.position.z)]; }
      } else air = 0;
      wasAir = airborne;
      sampled += dt;
      if (airborne) totalAir += dt;
    }
    sites.sort((a, b) => b.vy - a.vy);
    return {
      peakAir, peakVY, peakRise, peakGate, where, nJumps, riseWhere,
      airFrac: sampled > 0 ? totalAir / sampled : 0,
      fxEvents: fxWhere.length, fxTotal: (g.feel?.jumpCount ?? 0) - fx0, fxWhere, gateOpens,
      sites: sites.slice(0, 6),
    };
  };
  const controls = control > 0
    ? { after: controlRun(false, control), before: controlRun(true, control) }
    : null;

  // ------------------------------------------------------------------ slow-mo
  let slow = null;
  if (slowmo) {
    // A THROWAWAY WARM-UP FIRST. The vehicle carries gear and engine state
    // across `reset()`, so the run that follows the 15.8 m/s row of the sweep
    // arrives at the lip in a different gear from one that follows a 39.5 m/s
    // run — worth 2.1 cm of flight, which is otherwise indistinguishable from
    // slow motion moving the car.
    run(approach, { slowMo: false });
    const on = run(approach, { slowMo: true });
    const off = run(approach, { slowMo: false });
    // A NULL CONTROL. Two runs with slow motion OFF are, by construction, the
    // same experiment twice; whatever they differ by is the harness's own noise
    // floor, and the on-vs-off figure only means anything above it.
    const off2 = run(approach, { slowMo: false });
    // Compare the flights STEP FOR STEP, on the step indices both observed.
    const cmp = (p, q) => {
      const A = new Map(p.trace), B = new Map(q.trace);
      let worst = 0, shared = 0, first = null, prof = [];
      for (const [k, a] of [...A].sort((p2, q2) => p2[0] - q2[0])) {
        const b = B.get(k);
        if (!b) continue;
        shared++;
        const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        if (d > 1e-4 && first === null) first = [k, d];
        prof.push([k, +d.toFixed(5)]);
        worst = Math.max(worst, d);
      }
      return { worst, shared, first, prof };
    };
    const ab = cmp(on, off);
    const nul = cmp(off, off2);
    delete on.trace; delete off.trace;
    slow = { on, off, worst: ab.worst, shared: ab.shared, first: ab.first, prof: ab.prof.slice(0, 8),
      nullWorst: nul.worst, nullShared: nul.shared };
  }

  g.noLaunch = false;
  if (g.feel) g.feel.slowMoEnabled = true;
  return { site: S, approach, crestS, rampEnd, rows, controls, slow, before };
}, {
  speeds: args.speeds, before: args.before, control: args.control, slowmo: args.slowmo,
});

await browser.close();

if (out.note) { console.log(out.note); process.exit(1); }
const f = (v, d = 2) => (v == null ? '  --  ' : v.toFixed(d));
const S = out.site;
console.log('');
console.log(`JUMP SITE${out.before ? '   [--before: launch disabled]' : ''}`);
console.log(`  centre (${S.x.toFixed(1)}, ${S.z.toFixed(1)})  t=${S.t.toFixed(3)}  heading ${S.heading.toFixed(3)} rad`);
console.log(`  straight ${S.straightLength.toFixed(0)} m, chord deviation ${f(S.chordDeviation)} m, cross-fall ${f(S.crossFall, 1)} m`);
console.log(`  lip ${f(S.lipY)} m (${f(S.lipHeight, 1)} over the road)   ford water ${f(S.fordY)} m   gap ${f(S.gap, 1)} m`);
console.log(`  landing crest at s=${f(out.crestS, 1)} m, ramp ends s=${f(out.rampEnd, 1)} m`);
console.log(`  AUTOPILOT APPROACH SPEED ${f(out.approach, 1)} m/s (${f(out.approach * 3.6, 0)} km/h)`);
console.log('');
console.log(' target  takeoff  launch    apex     air    flown   landing  landing   where');
console.log('  m/s      m/s     vy m/s  over lip   s       m      fall     s');
for (const r of out.rows) {
  if (r.note) { console.log(`  ${f(r.target, 1).padStart(5)}   ${r.note}`); continue; }
  console.log(
    `  ${f(r.target, 1).padStart(5)}  ${f(r.takeoffSpeed, 1).padStart(6)}  ${f(r.launchVY, 2).padStart(6)}  `
    + `${f(r.apexOverLip, 2).padStart(7)}  ${f(r.airTime, 3).padStart(6)}  ${f(r.distance, 1).padStart(6)}  `
    + `${f(r.landingFall, 1).padStart(6)}  ${f(r.landingS, 1).padStart(6)}   ${r.cleared ? '' : '** '}${r.where}`
    + `   [${r.jumpEvents} fx, min ts ${f(r.peakScale, 2)}]`,
  );
}
console.log('');

if (out.controls) {
  const c = out.controls;
  console.log('ORDINARY ROAD CONTROL — autopilot lap, jump footprint excluded');
  console.log('                       before      after');
  console.log(`  peak airtime        ${f(c.before.peakAir, 3).padStart(7)} s  ${f(c.after.peakAir, 3).padStart(7)} s`);
  console.log(`  peak launch vy      ${f(c.before.peakVY, 2).padStart(7)}    ${f(c.after.peakVY, 2).padStart(7)}   m/s`);
  console.log(`  share of the drive airborne ${(c.before.airFrac * 100).toFixed(2).padStart(6)}%   ${(c.after.airFrac * 100).toFixed(2).padStart(6)}%`);
  console.log(`  launches over 4 m/s ${String(c.before.nJumps).padStart(7)}    ${String(c.after.nJumps).padStart(7)}`);
  console.log(`  SLOW-MO / FIREWORKS ${String(c.before.fxEvents).padStart(7)}    ${String(c.after.fxEvents).padStart(7)}   <- must be 0: no ramp out here`);
  console.log(`  longest steep climb ${f(c.after.peakRise, 3).padStart(7)} m at ${JSON.stringify(c.after.riseWhere)}`);
  console.log(`  peak gate reached   ${f(c.after.peakGate, 3).padStart(7)}   opened ${c.after.gateOpens} times in ${args.control} s of flat-out driving`);
  for (const s of c.after.sites) console.log(`    launch ${f(s.vy, 2)} m/s at (${s.x}, ${s.z}) ${s.kind} @ ${s.spd} m/s`);
  console.log(`  (celebrations on the ramp itself, for scale: ${c.after.fxTotal - c.after.fxEvents})`);
  for (const w of c.after.fxWhere) console.log(`    STRAY FX at (${w[0]}, ${w[1]}) ${w[2]}`);
  console.log('');
}

if (out.slow) {
  const on = out.slow.on, off = out.slow.off;
  console.log('SLOW MOTION vs THE TRAJECTORY — same jump, same inputs');
  console.log(`  slow-mo OFF   landing s ${f(off.landingS, 4)} m   world (${f(off.landX, 3)}, ${f(off.landZ, 3)})   air ${f(off.airTime, 4)} s`);
  console.log(`  slow-mo ON    landing s ${f(on.landingS, 4)} m   world (${f(on.landX, 3)}, ${f(on.landZ, 3)})   air ${f(on.airTime, 4)} s`);
  console.log(`  landing delta ${f(Math.abs(on.landingS - off.landingS), 6)} m   (frame-sampled; 1 frame at 1x is 2 physics steps = 0.33 m)`);
  console.log(`  WORST POSITION DIFFERENCE, on vs off, over ${out.slow.shared} shared physics steps: ${out.slow.worst.toExponential(2)} m`);
  console.log(`  null control, off vs off,       over ${out.slow.nullShared} shared physics steps: ${out.slow.nullWorst.toExponential(2)} m`);
  console.log(`  first step where they differ by over 0.1 mm: ${out.slow.first ? out.slow.first[0] : 'none'}`);
  console.log(`  time scale reached ${f(on.peakScale, 3)} over ${on.slowFrames} frames (off: ${f(off.peakScale, 3)}, ${off.slowFrames})`);
  console.log('');
}

if (errors.length) {
  console.log(`PAGE ERRORS (${errors.length}):`);
  for (const e of errors.slice(0, 6)) console.log('  ' + e.slice(0, 240));
  process.exit(1);
}
const design = out.rows[0];
if (!design || !design.cleared) { console.log('✗ the design speed does not clear the water'); process.exit(1); }
console.log('✓ cleared at the measured approach speed');
