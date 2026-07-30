#!/usr/bin/env node
/**
 * LIVE INTEGRATION PROBE
 * ----------------------
 * tools/collide-test.mjs proves the physics against synthetic obstacles. This
 * proves the WIRING against the real world: the real prop grid, the real 2500
 * barrier bays, the real ground query, with the autopilot driving the route.
 *
 * It monkey-patches `Game.prototype.step` in the page — it does NOT edit
 * game.js, which belongs to the lead — so the snippet at the bottom of the
 * builder's report is literally the code being exercised here.
 *
 *   node tools/collide-live.mjs --base http://127.0.0.1:5212 --seconds 90
 *
 * Reports: exceptions, impacts by material, solver cost, and — the one that
 * matters — how much of the run the car spent stuck under 3 m/s, because the
 * defect this module replaces was "prop collision hard-stops the car".
 */
import { chromium } from 'playwright';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5173', seconds: 90, biome: 'alpine' };
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--seconds') args.seconds = Number(av[++i]);
  else if (a === '--biome') args.biome = av[++i];
  // --baseline leaves game.js's own collision code in place, so the same drive
  // can be scored before and after. Any "stuck" number is only meaningful
  // against it.
  else if (a === '--baseline') args.baseline = true;
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${args.base}/?shot=hero_alpine&hud=0`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 180000 });

const out = await page.evaluate(async ({ seconds, biome, baseline }) => {
  const { resolveCollisions } = await import('/src/core/collision.js');
  const g = window.__GAME;
  g.loadBiome(biome, 1337);

  // ---- THE WIRING, exactly as game.js will carry it ----------------------
  const world = {
    get barriers() { return g.roads.barriers; },
    colliders: (x, z) => g._nearbyColliders(x, z),
    groundAt: (x, z) => g.groundAt(x, z),
  };

  const stats = {
    impacts: {}, worst: 0, solverMs: 0, steps: 0, stuck: 0, samples: 0,
    maxSpeed: 0, stuckAt: null, stuckTouch: null,
  };
  const orig = g.step.bind(g);
  const THREE_clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const patched = function (dt, input) {
    const v = this.vehicle;
    v._braking = input.brake > 0;
    const surf = this.surfaceAt(v.position.x, v.position.z);
    v.surfaceGrip = surf.grip;
    this.surface = surf;
    v.step(dt, input);

    const t0 = performance.now();
    const hits = resolveCollisions(v, world, dt);
    stats.solverMs += performance.now() - t0;
    stats.steps++;
    for (const h of hits) {
      stats.impacts[h.kind] = (stats.impacts[h.kind] ?? 0) + 1;
      stats.worst = Math.max(stats.worst, h.speed);
      if (h.speed > 6) {
        this.feel.event('impact', { speed: h.speed, kind: h.kind });
        this.audio.event('impact', { speed: h.speed, kind: h.kind });
        this.camera.addShake(Math.min(0.75, h.speed * 0.035));
      }
    }

    this._stepVertical(dt);
    const lim = this.biome.size / 2 - 40;
    v.position.x = THREE_clamp(v.position.x, -lim, lim);
    v.position.z = THREE_clamp(v.position.z, -lim, lim);
    if (v.isDrifting) this.driftScore += v.driftAngle * v.speed * dt * 6;
    this.simTime += dt;
  };
  g.step = baseline ? orig : patched;

  // ---- drive ------------------------------------------------------------
  const DT = 1 / 120;
  const n = Math.round(seconds / DT);
  const { penetrationAt } = await import('/src/core/collision.js');
  for (let i = 0; i < n; i++) {
    const input = g.autopilotInput({ throttle: 1, aggression: 1 });
    g.step(DT, input);
    if (i % 12 === 0 && i * DT > 3) {   // skip the standing start
      stats.samples++;
      const v = g.vehicle;
      const s = v.speed;
      stats.maxSpeed = Math.max(stats.maxSpeed, s);
      if (s < 3) {
        stats.stuck++;
        if (!stats.stuckAt) {
          const gd = g.groundAt(v.position.x, v.position.z);
          stats.stuckAt = {
            t: +(i * DT).toFixed(1),
            x: Math.round(v.position.x), z: Math.round(v.position.z),
            surface: g.surfaceAt(v.position.x, v.position.z).kind,
            slope: +Math.hypot(gd.normal.x, gd.normal.z).toFixed(3),
            groundY: +gd.height.toFixed(1),
            waterLevel: g.biome.waterLevel,
            pen: +penetrationAt(v.position.x, v.position.z, v.heading, world).toFixed(3),
            onRoad: g.roads.isOnRoad?.(v.position.x, v.position.z) ?? null,
          };
        }
      }
    }
  }
  stats.stuckPct = (stats.stuck / stats.samples) * 100;
  stats.usPerStep = (stats.solverMs * 1000) / stats.steps;
  stats.barriers = g.roads.barriers.segments.length;
  stats.broken = g.roads.barriers.segments.filter((s) => s.broken).length;
  stats.colliders = g.colliders.length;
  stats.finalSpeed = g.vehicle.speed;
  return stats;
}, { seconds: args.seconds, biome: args.biome, baseline: !!args.baseline });

await browser.close();

console.log('');
console.log(`biome ${args.biome}   ${args.seconds} s of autopilot at 1/120`);
console.log(`  world: ${out.colliders} prop colliders, ${out.barriers} barrier bays`);
console.log(`  solver: ${out.usPerStep.toFixed(1)} us per physics step (${out.steps} steps)`);
console.log(`  impacts: ${JSON.stringify(out.impacts)}   worst closing ${out.worst.toFixed(1)} m/s`);
console.log(`  timber bays smashed: ${out.broken}`);
console.log(`  time under 3 m/s: ${out.stuckPct.toFixed(1)}%   peak ${out.maxSpeed.toFixed(1)} m/s   final ${out.finalSpeed.toFixed(1)} m/s`);
if (errors.length) {
  console.log('');
  console.log(`PAGE ERRORS (${errors.length}):`);
  for (const e of errors.slice(0, 8)) console.log('  ' + e);
  process.exit(1);
}
console.log('  stuck first at: ' + JSON.stringify(out.stuckAt));
console.log('  no page errors');
