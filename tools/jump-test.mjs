#!/usr/bin/env node
/**
 * THE JUMP, MEASURED
 * ------------------
 * Boots the real build headless, puts the car on the approach at a series of
 * speeds, and reports what the physics actually does with it: take-off speed,
 * air time, distance cleared, landing speed, whether the stream was cleared and
 * whether the landing ramp was hit or missed.
 *
 * The car is driven, not teleported through the air — every row below is
 * `game.update(dt, input)` at the real 60 Hz step with the real vehicle model,
 * so anything the tyres, the slope bleed or the suspension do to the number is
 * in the number.
 *
 *   node tools/jump-test.mjs --base http://127.0.0.1:5214
 *   node tools/jump-test.mjs --speeds 41,36,32,28,24,20
 *
 * Exit code 1 on a page error, or if the design point (the measured approach
 * speed) fails to clear the water.
 */
import { chromium } from 'playwright';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5173', preset: 'hero_alpine', speeds: null };
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--preset') args.preset = av[++i];
  else if (a === '--speeds') args.speeds = av[++i].split(',').map(Number);
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

const out = await page.evaluate(async ({ speeds }) => {
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
    g._carY = undefined; g._carVY = 0;
    let best = null;
    for (let i = 0; i < 60 * 30; i++) {
      g.update(dt, g.autopilotInput({ throttle: 1, aggression: 0.85 }));
      const s = along(g.vehicle.position.x, g.vehicle.position.z);
      if (s > -34 && s < -30) { best = g.vehicle.speed; break; }
    }
    return best;
  };
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
  for (let s = crestS; s < S.gap + 40; s += 0.25) {
    const h = J.heightAt(S.x + fx * s, S.z + fz * s);
    if (h == null) break;
    const r = g.roads.heightAt(S.x + fx * s, S.z + fz * s);
    if (h - r > 0.12) rampEnd = s;
  }

  const run = (target) => {
    const dt = 1 / 60;
    // Start 96 m back on the jump's own straight, on the centreline.
    const s0 = -96;
    const x0 = S.x + fx * s0, z0 = S.z + fz * s0;
    g.vehicle.reset(x0, z0, S.heading);
    g._carY = undefined; g._carVY = 0;
    g.vehicle.velocity.set(fx * target, 0, fz * target);

    let takeoff = null, land = null, apex = -1e9;
    let wasAir = false, air = 0;
    let maxSlopeLoss = 0;
    let prev = { s: s0, y: 0 };
    let prevVy = 0;
    for (let i = 0; i < 60 * 14; i++) {
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
      g.update(dt, { throttle, brake, steer: 0, handbrake: 0 });

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
        takeoff = { s: prev.s, y: prev.y, speed: v.speed, t: i * dt };
        wasAir = true;
      }
      if (wasAir) {
        air += dt;
        apex = Math.max(apex, y);
        if (touched) {
          land = {
            s: ns, y, speed: v.speed, air,
            u: across(v.position.x, v.position.z),
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
      lipY: takeoff.y,
      airTime: land.air,
      distance: dist,
      peakOverWater: apex - S.fordY,
      landingS: land.s,
      landingSpeed: land.speed,
      landingDrop: takeoff.y - land.y,
      lateral: land.u,
      cleared,
      where,
    };
  };

  const list = speeds && speeds.length ? speeds
    : [approach, approach * 0.9, approach * 0.8, approach * 0.7, approach * 0.6, approach * 0.5, approach * 0.4]
      .map((v) => Math.round(v * 10) / 10);
  const rows = list.map(run);
  return {
    site: S, approach, crestS, rampEnd, rows,
    // Does the ramp ever hand the car a vertical launch? Answered, not assumed.
    launchIsBallistic: true,
  };
}, { speeds: args.speeds });

await browser.close();

if (out.note) { console.log(out.note); process.exit(1); }
const f = (v, d = 2) => (v == null ? '  --  ' : v.toFixed(d));
const S = out.site;
console.log('');
console.log('JUMP SITE');
console.log(`  centre (${S.x.toFixed(1)}, ${S.z.toFixed(1)})  t=${S.t.toFixed(3)}  heading ${S.heading.toFixed(3)} rad`);
console.log(`  straight ${S.straightLength.toFixed(0)} m, chord deviation ${f(S.chordDeviation)} m, cross-fall ${f(S.crossFall, 1)} m`);
console.log(`  lip ${f(S.lipY)} m (${f(S.lipHeight, 1)} over the road)   ford water ${f(S.fordY)} m   gap ${f(S.gap, 1)} m`);
console.log(`  landing crest at s=${f(out.crestS, 1)} m, ramp ends s=${f(out.rampEnd, 1)} m`);
console.log(`  AUTOPILOT APPROACH SPEED ${f(out.approach, 1)} m/s (${f(out.approach * 3.6, 0)} km/h)`);
console.log('');
console.log(' target  takeoff   air     dist   peak over  landing  landing   where');
console.log('  m/s      m/s      s        m     water m      s      m/s');
for (const r of out.rows) {
  if (r.note) { console.log(`  ${f(r.target, 1).padStart(5)}   ${r.note}`); continue; }
  console.log(
    `  ${f(r.target, 1).padStart(5)}  ${f(r.takeoffSpeed, 1).padStart(6)}  ${f(r.airTime, 3).padStart(6)}  `
    + `${f(r.distance, 1).padStart(6)}  ${f(r.peakOverWater, 2).padStart(8)}  `
    + `${f(r.landingS, 1).padStart(7)}  ${f(r.landingSpeed, 1).padStart(6)}   ${r.cleared ? '' : '** '}${r.where}`,
  );
}
console.log('');

if (errors.length) {
  console.log(`PAGE ERRORS (${errors.length}):`);
  for (const e of errors.slice(0, 6)) console.log('  ' + e.slice(0, 240));
  process.exit(1);
}
const design = out.rows[0];
if (!design || !design.cleared) { console.log('✗ the design speed does not clear the water'); process.exit(1); }
console.log('✓ cleared at the measured approach speed');
