#!/usr/bin/env node
/**
 * CAN THE CAR GET OUT?
 * --------------------
 * Parks the real car at a set of known-hostile poses in the real world and
 * holds the throttle down for 15 s. For each one it reports whether the car
 * left, how long it took, and how fast it was going when the clock stopped.
 *
 *   node tools/stuck-test.mjs --base http://127.0.0.1:5222
 *   node tools/stuck-test.mjs --no-rescue          # physics only, watchdog off
 *   node tools/stuck-test.mjs --only cliff_lip --trace
 *
 * WHY IT EXISTS. Three separate agents reported "the car gets stuck" and all
 * three named a different cause, because until this tool there was no way to
 * put the car on a specific piece of ground and watch. Every other harness in
 * tools/ drives the route, so a trap only shows up as a percentage.
 *
 * `--no-rescue` is the important switch. The 5 s auto-rescue in game.js will
 * pick the car up off almost anything, which is right for a player and useless
 * for a measurement: a fix that only works because a teleport is behind it is
 * not a fix. Run both. `escaped` under `--no-rescue` is the number that means
 * the physics can free itself.
 *
 * The spots are FOUND, not hard-coded, from the seeded world — so this keeps
 * measuring the same kinds of place if the terrain is regenerated.
 */
import { chromium } from 'playwright';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5222', biome: 'alpine', seed: 1337, seconds: 15 };
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--biome') args.biome = av[++i];
  else if (a === '--seed') args.seed = Number(av[++i]);
  else if (a === '--seconds') args.seconds = Number(av[++i]);
  else if (a === '--only') args.only = av[++i];
  else if (a === '--no-rescue') args.noRescue = true;
  else if (a === '--trace') args.trace = true;
  // Not a stuck test at all — the third defect this round, kept here because it
  // needs the same booted page and the same "drive it and look" apparatus.
  else if (a === '--flags') args.flags = true;
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

/**
 * IS `onGround` TRUE?
 * -------------------
 * Drives the route autopilot and, every frame, compares the flag against the
 * only thing that can settle it: how far the car's own height is above the
 * ground under it. Reports the two ways it can lie, plus the jump and the first
 * bridge crossing frame by frame.
 */
if (args.flags) {
  const r = await page.evaluate(async (A) => {
    const g = window.__GAME;
    g.loadBiome(A.biome, A.seed);
    // `?.` so this same tool can be pointed at a build from before the rescue
    // moved into game.js — that is the whole point of a before/after harness.
    if (g.respawnCar) g.respawnCar();
    else { const sp = g.roads.spawn(); g.vehicle.reset(sp.x, sp.z, sp.heading); g.resetPose(); }
    const v = g.vehicle;
    const dt = 1 / 60;
    const rows = [];
    let liesGrounded = 0, liesAirborne = 0, n = 0, maxLie = 0;
    for (let f = 0; f < A.seconds * 60; f++) {
      g.update(dt, g.autopilotInput({ throttle: 1, aggression: 0.95 }));
      const q = g.groundAt(v.position.x, v.position.z);
      const air = (g._carY ?? q.height) - q.height;
      n++;
      // "says grounded with daylight under it" and "says airborne while sitting
      // on the surface". The second has to be `air <= 0` and not some tolerance:
      // a 2 cm hop off a facet crest IS airborne and reporting it is correct —
      // 15.2% of a fast lap is spent that way and carPose already fades the
      // flight attitude in over 0.25 m for exactly that reason.
      if (v.onGround && air > 0.25) { liesGrounded++; maxLie = Math.max(maxLie, air); }
      if (!v.onGround && air <= 0) liesAirborne++;
      rows.push([+(f * dt).toFixed(3), +air.toFixed(3), v.onGround ? 1 : 0,
        v.ballisticAir ? 1 : 0, q.onBridge ? 1 : 0, +v.airTime.toFixed(3), +v.speed.toFixed(1)]);
    }
    return { rows, liesGrounded, liesAirborne, n, maxLie: +maxLie.toFixed(2) };
  }, args);

  const pc = (k) => ((100 * k) / r.n).toFixed(2) + '%';
  console.log('');
  console.log(`onGround TRUTH — ${args.seconds} s of route autopilot, ${r.n} frames`);
  console.log(`  says GROUNDED with more than 0.25 m of daylight: ${r.liesGrounded} frames (${pc(r.liesGrounded)}), worst ${r.maxLie} m`);
  console.log(`  says AIRBORNE with no daylight at all:          ${r.liesAirborne} frames (${pc(r.liesAirborne)})`);
  // The longest continuous flight in the run, with the frames either side of it.
  let best = null, run = null;
  for (const row of r.rows) {
    if (row[1] > 0.5) { run = run ?? { a: row[0], h: 0 }; run.b = row[0]; run.h = Math.max(run.h, row[1]); }
    else if (run) { if (!best || run.b - run.a > best.b - best.a) best = run; run = null; }
  }
  const show = (title, from, to) => {
    console.log(`  ${title}`);
    console.log('      t       air m  onGround  ballisticAir  onBridge  airTime  m/s');
    for (const row of r.rows) {
      if (row[0] < from || row[0] > to) continue;
      console.log(`    ${String(row[0]).padStart(6)}  ${String(row[1]).padStart(7)}  ` +
        `${String(row[2]).padStart(8)}  ${String(row[3]).padStart(12)}  ${String(row[4]).padStart(8)}  ` +
        `${String(row[5]).padStart(7)}  ${String(row[6]).padStart(5)}`);
    }
  };
  if (best) show(`the longest flight (apex ${best.h.toFixed(2)} m), take-off through landing:`, best.a - 0.12, best.b + 0.12);
  const br = r.rows.find((row) => row[4] === 1);
  if (br) show('the first bridge crossing:', br[0] - 0.08, br[0] + 0.25);
  await browser.close();
  if (errors.length) { console.log('PAGE ERRORS:'); for (const e of errors.slice(0, 8)) console.log('  ' + e); }
  process.exit(errors.length ? 1 : 0);
}

const out = await page.evaluate(async (A) => {
  const g = window.__GAME;
  g.loadBiome(A.biome, A.seed);

  const slopeAt = (x, z) => {
    const q = g.groundAt(x, z);
    return Math.hypot(q.normal.x, q.normal.z);
  };
  const headTo = (from, to) => Math.atan2(-(to.z - from.z), to.x - from.x);

  // ---- FIND THE HOSTILE PLACES --------------------------------------------
  const S = g.roads._samples;
  const spots = [];

  // 1-2. The steepest terrain within 60 m of the route, which is where a car
  // that misses a corner ends up. Two poses: nose into it, and across it.
  {
    let best = null;
    for (let i = 0; i < S.length; i += 3) {
      const sm = S[i];
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2;
        for (const r of [18, 26, 34]) {
          const x = sm.x + Math.cos(th) * r, z = sm.z + Math.sin(th) * r;
          const sl = slopeAt(x, z);
          if (!best || sl > best.sl) best = { x, z, sl };
        }
      }
    }
    const n = g.groundAt(best.x, best.z).normal;
    const down = Math.atan2(-n.z, n.x);
    spots.push({ id: 'cliff_uphill', x: best.x, z: best.z, heading: down + Math.PI, note: `slope ${best.sl.toFixed(3)}` });
    spots.push({ id: 'cliff_across', x: best.x, z: best.z, heading: down + Math.PI / 2, note: `slope ${best.sl.toFixed(3)}` });
  }

  // 3. Nosed into a prop. The chassis is 4.2 m long, so 1.9 m short of the
  // trunk with the nose on it is a contact, not an overlap.
  {
    let found = null;
    for (let i = 0; i < S.length && !found; i += 5) {
      const sm = S[i];
      for (const c of g.collisionWorld.colliders(sm.x, sm.z) ?? []) {
        if (c.r == null) continue;
        const d = Math.hypot(c.x - sm.x, c.z - sm.z);
        if (d > 8 && d < 26) { found = { c, sm }; break; }
      }
    }
    if (found) {
      const { c, sm } = found;
      const h = headTo(sm, c);
      spots.push({
        id: 'prop_nose', x: c.x - Math.cos(h) * 2.0, z: c.z + Math.sin(h) * 2.0,
        heading: h, note: `trunk r=${c.r.toFixed(2)} at (${c.x.toFixed(0)}, ${c.z.toFixed(0)})`,
      });
    }
  }

  // 4. In the water at the foot of the bank, pointing at the shore. The old
  // "drive out of a lake onto a road above it" defect lives here.
  const wl = g.biome?.waterLevel;
  if (wl !== undefined) {
    let best = null;
    const lim = g.biome.size / 2 - 60;
    for (let x = -lim; x <= lim; x += 14) {
      for (let z = -lim; z <= lim; z += 14) {
        if (g.groundAt(x, z).height >= wl - 1.2) continue;   // want submerged
        // steepest shore within a short reach
        for (let a = 0; a < 8; a++) {
          const th = (a / 8) * Math.PI * 2;
          const sx = x + Math.cos(th) * 10, sz = z + Math.sin(th) * 10;
          const rise = g.groundAt(sx, sz).height - g.groundAt(x, z).height;
          if (rise > 3 && (!best || rise > best.rise)) best = { x, z, rise, h: Math.atan2(-(sz - z), sx - x) };
        }
      }
    }
    if (best) spots.push({ id: 'lake_bank', x: best.x, z: best.z, heading: best.h, note: `bank +${best.rise.toFixed(1)} m` });
  }

  // 5. A bridge abutment, approached from the side — the car should not be able
  // to drive up the end of a deck, and must not weld itself to it either.
  {
    const decks = g.bridges?.spans ?? g.bridges?._spans ?? null;
    let p = null;
    for (let i = 0; i < S.length && !p; i++) {
      if (g.bridges.heightAt(S[i].x, S[i].z) != null) p = S[i];
    }
    if (p) {
      // 9 m off to the side, pointing back at the deck
      const j = Math.min(S.length - 1, S.indexOf(p) + 4);
      const dx = S[j].x - p.x, dz = S[j].z - p.z, L = Math.hypot(dx, dz) || 1;
      const nx = -dz / L, nz = dx / L;
      const x = p.x + nx * 9, z = p.z + nz * 9;
      spots.push({ id: 'bridge_abutment', x, z, heading: Math.atan2(-(p.z - z), p.x - x), note: 'facing the deck' });
    }
    void decks;
  }

  // 6. The map border, driving straight at it. game.js clamps position there,
  // which is a wall that no collision or slope rule knows about.
  {
    const lim = g.biome.size / 2 - 40;
    spots.push({ id: 'map_border', x: lim - 6, z: 0, heading: 0, note: `clamp at ${lim}` });
  }

  // ---- DRIVE OUT OF EACH ---------------------------------------------------
  const dt = 1 / 60;
  // ESCAPED MEANS GOT AWAY, NOT WENT FAST. A speed threshold calls a car in
  // water stuck (2.4/s of drag caps it at 3.2 m/s at full throttle) and calls a
  // car driving a 2 m/s circle in a barrier pocket free. Distance from the pose
  // it was parked in answers both.
  const ESCAPE = 25;               // m from the start
  const results = [];
  for (const s of spots) {
    if (A.only && s.id !== A.only) continue;
    g.noRescue = !!A.noRescue;
    g.rescues = 0;
    g.vehicle.reset(s.x, s.z, s.heading);
    g.resetPose();
    const v = g.vehicle;
    const trace = [];
    let escapedAt = null, maxSpeed = 0, path = 0;
    let px = v.position.x, pz = v.position.z;
    for (let f = 0; f < A.seconds * 60; f++) {
      g.update(dt, { throttle: 1, brake: 0, steer: 0, handbrake: 0 });
      maxSpeed = Math.max(maxSpeed, v.speed);
      path += Math.hypot(v.position.x - px, v.position.z - pz);
      px = v.position.x; pz = v.position.z;
      if (escapedAt === null && Math.hypot(v.position.x - s.x, v.position.z - s.z) >= ESCAPE) {
        escapedAt = f * dt;
      }
      if (A.trace && f % 15 === 0) {
        trace.push([+(f * dt).toFixed(2), +v.speed.toFixed(2),
          +Math.hypot(v.position.x - s.x, v.position.z - s.z).toFixed(1),
          +(v.groundSlope ?? 0).toFixed(2), v.onGround ? 1 : 0, +v._grindTime.toFixed(2)]);
      }
    }
    results.push({
      id: s.id, note: s.note,
      at: [+s.x.toFixed(1), +s.z.toFixed(1)],
      slope0: +slopeAt(s.x, s.z).toFixed(3),
      escapedAt: escapedAt === null ? null : +escapedAt.toFixed(2),
      endSpeed: +v.speed.toFixed(2), maxSpeed: +maxSpeed.toFixed(2),
      moved: +Math.hypot(v.position.x - s.x, v.position.z - s.z).toFixed(1),
      path: +path.toFixed(1), rescues: g.rescues, trace,
    });
  }
  g.noRescue = false;
  return results;
}, args);

await browser.close();

const f = (v, d = 2) => (v === null || v === undefined ? '   --' : v.toFixed(d));
console.log('');
console.log(`STUCK TEST — ${args.biome}/${args.seed}, ${args.seconds} s of full throttle from rest` +
  (args.noRescue ? '   [AUTO-RESCUE OFF]' : ''));
console.log('  spot              at              slope  escaped@  end m/s  max m/s  moved m  resc  note');
for (const r of out) {
  console.log(
    `  ${r.id.padEnd(16)}  (${String(r.at[0]).padStart(6)},${String(r.at[1]).padStart(6)})  ` +
    `${f(r.slope0, 3)}  ${f(r.escapedAt).padStart(8)}  ${f(r.endSpeed).padStart(7)}  ` +
    `${f(r.maxSpeed).padStart(7)}  ${f(r.moved, 1).padStart(7)}  ${f(r.path, 1).padStart(7)}  ` +
    `${String(r.rescues).padStart(4)}  ${r.note}`);
  if (args.trace) {
    for (const t of r.trace) {
      console.log(`      t ${String(t[0]).padStart(5)}  spd ${String(t[1]).padStart(6)}  d ${String(t[2]).padStart(6)}` +
        `  slope ${t[3]}  onGround ${t[4]}  grind ${t[5]}`);
    }
  }
}
const trapped = out.filter((r) => r.escapedAt === null);
console.log('');
console.log(`  ${out.length - trapped.length}/${out.length} escaped` +
  (trapped.length ? `   TRAPPED: ${trapped.map((r) => r.id).join(', ')}` : ''));
if (errors.length) {
  console.log('');
  console.log('PAGE ERRORS:');
  for (const e of errors.slice(0, 8)) console.log('  ' + e);
}
process.exit(errors.length ? 1 : 0);
