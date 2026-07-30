#!/usr/bin/env node
/**
 * RACE GROUND TRUTH
 * -----------------
 * Boots the real build headless, wires core/race.js into the live Game exactly
 * as game.js will (four lines, replicated below in `WIRE`), then drives it and
 * asserts what a lap counter has to be true of.
 *
 *   node tools/race-test.mjs --base http://127.0.0.1:5216
 *   node tools/race-test.mjs --base ... --laps 2     # short run, logic only
 *   node tools/race-test.mjs --base ... --json out.json
 *
 * Proves, in order:
 *   1  one full autopilot lap registers exactly ONE lap — not zero, not two
 *   2  driving backwards over the line UN-LAPS (and cannot mint a free lap)
 *   3  five laps end the race and the crossing after that does nothing
 *   4  the lap times sum to the total, and the per-lap drift scores do too
 *   5  the pause key stops simTime advancing and resumes cleanly
 *
 * Exit code is 1 if any check fails or the page threw.
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const av = process.argv.slice(2);
// A lap of the alpine route measures 113 s of sim time under the autopilot
// (route 3577 m, 3.65 s of it staging). 300 s is two and a half times that —
// enough slack for a bad line, tight enough that a stuck car fails fast.
const args = { base: 'http://127.0.0.1:5173', laps: 5, budget: 300 };
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--laps') args.laps = Number(av[++i]);
  else if (a === '--budget') args.budget = Number(av[++i]);   // sim seconds per lap cap
  else if (a === '--json') args.json = av[++i];
}

/**
 * THE WIRING UNDER TEST. This is character-for-character what game.js gets —
 * if the shell's four lines and these four ever disagree, the test is lying.
 */
const WIRE = `
  const g = window.__GAME;
  const { createRace } = await import('/src/core/race.js');
  g.capture = false;                       // a real session, not a screenshot
  g.race = createRace({ lapsTotal: LAPS_TOTAL });
  g.race.attach(g);
  const inner = g.update.bind(g);
  g.update = (dt, input) => {
    if (g.race.paused) return;             // game.js: first line of update()
    inner(dt, input);
    g.race.update(g);                      // game.js: last line of update()
  };
`;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// t=0 so the car is exactly where roads.spawn() put it and nothing has been
// driven yet — the race must start from the same pose the player gets.
await page.goto(`${args.base}/?shot=hero_alpine&t=0`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 180000 });

const report = await page.evaluate(async ({ wire, lapsTotal, budget }) => {
  // eslint-disable-next-line no-new-func
  await new Function(`return (async () => {${wire.replace('LAPS_TOTAL', lapsTotal)}})()`)();
  const g = window.__GAME;
  const race = g.race;
  const out = { checks: [], gate: null, laps: [], log: [] };
  const ok = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail });

  const DT = 1 / 60;
  const drive = (seconds, opts = {}) => {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      g.update(DT, g.autopilotInput({ throttle: 1, aggression: opts.aggression ?? 0.9 }));
      if (opts.until && opts.until()) return true;
    }
    return false;
  };
  /** Put the car at a point and let the race see it — a pure crossing probe. */
  const place = (x, z, heading) => {
    g.vehicle.reset(x, z, heading);
    g.resetPose();
    race.update(g);
  };

  const G = race.gate;
  out.gate = {
    x: +G.x.toFixed(2), z: +G.z.toFixed(2),
    fx: +G.fx.toFixed(4), fz: +G.fz.toFixed(4),
    half: +G.half.toFixed(2), y: +G.y.toFixed(2),
    t: +G.t.toFixed(5),
    aheadOfSpawn: null,
    routeLength: +g.roads.length.toFixed(1),
  };
  {
    const sp = g.roads.spawn();
    // Arc distance from spawn to the gate, forward along the route.
    const L = g.roads.length;
    let t0 = 0, best = Infinity;
    for (let i = 0; i < 2000; i++) {
      const s = g.roads.sample(i / 2000);
      const d = (s.x - sp.x) ** 2 + (s.z - sp.z) ** 2;
      if (d < best) { best = d; t0 = i / 2000; }
    }
    let dt = G.t - t0; if (dt < 0) dt += 1;
    out.gate.aheadOfSpawn = +(dt * L).toFixed(1);
  }

  // ---------------------------------------------------------------- 1: one lap
  out.log.push(`start: state=${race.state} laps=${race.laps.length}`);
  const startedIn = (() => {
    const hit = drive(30, { until: () => race.state === 'running' });
    return hit ? +g.simTime.toFixed(2) : null;
  })();
  ok('staging: the first crossing starts the race and completes no lap',
    race.state === 'running' && race.laps.length === 0 && race.crossings === 1,
    `state=${race.state} laps=${race.laps.length} crossings=${race.crossings} t=${startedIn}`);

  const gotLap1 = drive(budget, { until: () => race.laps.length >= 1 });
  ok('one driven circuit registers exactly ONE lap',
    gotLap1 && race.laps.length === 1,
    `laps=${race.laps.length} simTime=${g.simTime.toFixed(1)}`);

  // …and does not quietly become two a few seconds later.
  const lapsAt1 = race.laps.length;
  drive(6);
  ok('the same crossing does not register twice',
    race.laps.length === lapsAt1,
    `laps=${race.laps.length} rejected=${race.rejected}`);

  // -------------------------------------------------------------- 2: backwards
  // Geometry, not luck. Two primitives:
  //
  //   moveTo(s)  repositions the car to signed distance `s` along the route
  //              direction WITHOUT passing the gate, by hopping 300 m out to
  //              the side first — the gate is 32 m long, so a crossing point at
  //              u = 300 is off the end of the segment and is not a pass. It
  //              also charges the away guard.
  //   crossTo(s) moves straight to `s`, which IS a pass if the sign changed.
  //
  // So a backward pass is expressible without driving the wrong way round a
  // 3.5 km route, and without a radius or a timer deciding anything.
  const H = Math.atan2(-G.fz, G.fx);
  const at = (s, u = 0) => [G.x + G.fx * s + G.ax * u, G.z + G.fz * s + G.az * u, H];
  let cur = 0, curU = 0;
  // Steps of 2.5 m — under the module's 12 m teleport threshold, so these read
  // as driving rather than as a respawn.
  const goto = (s, u) => {
    const n = Math.max(1, Math.ceil(Math.hypot(s - cur, u - curU) / 2.5));
    const s0 = cur, u0 = curU;
    for (let i = 1; i <= n; i++) place(...at(s0 + (s - s0) * i / n, u0 + (u - u0) * i / n));
    cur = s; curU = u;
  };
  const crossTo = (s) => goto(s, 0);
  const moveTo = (s) => { goto(cur, 300); goto(s, 300); goto(s, 0); };

  const before = { laps: race.laps.length, crossings: race.crossings };
  moveTo(90);
  ok('stepping around the gate is not a pass',
    race.crossings === before.crossings && race.laps.length === before.laps,
    `crossings=${race.crossings} laps=${race.laps.length}`);

  crossTo(-3);
  ok('a backward crossing UN-LAPS the most recent lap',
    race.laps.length === before.laps - 1 && race.crossings === before.crossings - 1
      && race.unlaps === 1,
    `laps ${before.laps} -> ${race.laps.length}, crossings ${before.crossings} -> ${race.crossings}`);

  moveTo(90);
  crossTo(-3);
  ok('un-lapping out of lap 1 returns the race to staging',
    race.state === 'staging' && race.crossings === 0 && race.unlaps === 2,
    `state=${race.state} crossings=${race.crossings}`);

  // Reversing and coming forward again must NOT mint a lap.
  moveTo(-90);
  crossTo(3);
  ok('the forward pass after un-lapping re-starts the race, it does not bank a lap',
    race.state === 'running' && race.laps.length === 0 && race.crossings === 1,
    `state=${race.state} laps=${race.laps.length}`);

  // A straddle: cross forward and immediately back without going anywhere. The
  // away guard must drop both, leaving the ledger untouched.
  const beforeStraddle = { c: race.crossings, l: race.laps.length, r: race.rejected };
  crossTo(-4);
  crossTo(4);
  crossTo(-4);
  ok('wobbling on the line changes nothing (60 m away-guard)',
    race.crossings === beforeStraddle.c && race.laps.length === beforeStraddle.l
      && race.rejected === beforeStraddle.r + 3,
    `crossings=${race.crossings} laps=${race.laps.length} rejected+=${race.rejected - beforeStraddle.r}`);

  // A respawn — main.js's R key and its auto-rescue both do exactly this —
  // must not be read as a pass of the line in either direction.
  const beforeTp = { c: race.crossings, l: race.laps.length, s: race.state };
  place(...at(-140));                                   // one 144 m jump
  place(...at(60));                                     // and one straight through
  ok('a respawn straight through the line is not a crossing',
    race.crossings === beforeTp.c && race.laps.length === beforeTp.l
      && race.state === beforeTp.s,
    `crossings=${race.crossings} laps=${race.laps.length} state=${race.state}`);
  cur = 60; curU = 0;

  // ------------------------------------------------------------ 3: five laps
  // A clean race from the line, driven end to end. `restart` also unpauses: a
  // finished race leaves the table open, and with it open the shell's early
  // return means nothing advances at all.
  race.closeTable();
  race.restart(g);
  ok('restart puts the race back to staging with an empty table',
    race.state === 'staging' && race.laps.length === 0 && race.totals.time === 0,
    `state=${race.state} laps=${race.laps.length}`);

  const t0race = g.simTime;
  const finished = drive(budget * (lapsTotal + 1), { until: () => race.state === 'finished' });
  out.laps = race.laps.map((l) => ({ n: l.n, time: l.time, drift: l.drift }));
  ok(`${lapsTotal} laps end the race`,
    finished && race.state === 'finished' && race.laps.length === lapsTotal,
    `state=${race.state} laps=${race.laps.length} sim=${(g.simTime - t0race).toFixed(1)}s`);

  // The crossing AFTER the last one does nothing at all.
  const snap = JSON.stringify(race.laps.map((l) => [l.time, l.drift]));
  cur = 0;
  moveTo(-90);
  crossTo(3);
  ok('the crossing after the final lap does nothing',
    race.laps.length === lapsTotal && race.state === 'finished'
      && race.ignoredAfterFinish >= 1
      && JSON.stringify(race.laps.map((l) => [l.time, l.drift])) === snap,
    `laps=${race.laps.length} ignoredAfterFinish=${race.ignoredAfterFinish}`);

  // -------------------------------------------------------------- 4: the sums
  const T = race.totals;
  const sumT = race.laps.reduce((a, l) => a + l.time, 0);
  const sumD = race.laps.reduce((a, l) => a + l.drift, 0);
  ok('lap times sum to the total',
    Math.abs(sumT - T.time) < 1e-9 && Math.abs(sumT - (race.finishT - race.raceStartT)) < 1e-9,
    `sum=${sumT.toFixed(6)} total=${T.time.toFixed(6)} finish-start=${(race.finishT - race.raceStartT).toFixed(6)}`);
  ok('per-lap drift scores sum to the total',
    Math.abs(sumD - T.drift) < 1e-6,
    `sum=${sumD.toFixed(4)} total=${T.drift.toFixed(4)}`);
  // And the total banked over the race is what game.js's own accumulator paid
  // out between the first and last crossing — the buckets lose nothing.
  ok('the drift buckets account for every point banked in the race',
    T.drift <= race.driftTotal + 1e-6 && T.drift > 0,
    `race=${T.drift.toFixed(1)} cumulative=${race.driftTotal.toFixed(1)}`);

  out.totals = {
    time: T.time, drift: T.drift, best: T.best, bestDrift: T.bestDrift,
    driftCumulative: race.driftTotal,
  };

  // ----------------------------------------------------------------- 5: pause
  race.closeTable();
  race.restart(g);
  drive(20);
  const key = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
  const tBefore = g.simTime;
  key('KeyL');
  const pausedFlag = race.paused;
  for (let i = 0; i < 240; i++) g.update(DT, g.autopilotInput({ throttle: 1 }));
  const tPaused = g.simTime;
  key('KeyL');
  const resumedFlag = race.paused;
  for (let i = 0; i < 240; i++) g.update(DT, g.autopilotInput({ throttle: 1 }));
  const tAfter = g.simTime;
  ok('L pauses: simTime does not advance while the table is open',
    pausedFlag === true && tPaused === tBefore,
    `paused=${pausedFlag} simTime ${tBefore.toFixed(3)} -> ${tPaused.toFixed(3)} over 240 frames`);
  ok('L resumes: simTime advances again, by the 4 s that were asked for',
    resumedFlag === false && Math.abs((tAfter - tPaused) - 4) < 0.05,
    `simTime ${tPaused.toFixed(3)} -> ${tAfter.toFixed(3)}`);
  ok('the results overlay is in the DOM and closes again',
    !!document.getElementById('raceResults')
      && !document.getElementById('raceResults').classList.contains('on'),
    'raceResults present, class "on" removed');

  return out;
}, { wire: WIRE, lapsTotal: args.laps, budget: args.budget });

await browser.close();

// ---------------------------------------------------------------------- print
const line = (s) => console.log(s);
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const time = (s) => {
  if (!Number.isFinite(s)) return '—';
  const cs = Math.round(s * 100);
  const m = Math.floor(cs / 6000);
  return `${m ? m + ':' : ''}${String(Math.floor((cs % 6000) / 100)).padStart(m ? 2 : 1, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

line('');
line('GATE');
line(`  centre (${report.gate.x}, ${report.gate.z})  normal (${report.gate.fx}, ${report.gate.fz})`);
line(`  half-length ${report.gate.half} m   road height ${report.gate.y} m`);
line(`  ${report.gate.aheadOfSpawn} m ahead of roads.spawn()   route ${report.gate.routeLength} m round`);

line('');
line('LAP TABLE');
line('   LAP        TIME        DRIFT');
const best = report.totals?.best, bestD = report.totals?.bestDrift;
for (const l of report.laps) {
  const marks = [l.n === best ? 'BEST' : '', l.n === bestD ? 'TOP DRIFT' : ''].filter(Boolean).join('  ');
  line(`    ${String(l.n).padStart(2, '0')}   ${time(l.time).padStart(9)}   ${f2(l.drift).padStart(10)}   ${marks}`);
}
if (report.totals) {
  line(`   ---------------------------------`);
  line(`  TOTAL   ${time(report.totals.time).padStart(9)}   ${f2(report.totals.drift).padStart(10)}`);
}

line('');
line('CHECKS');
let failed = 0;
for (const c of report.checks) {
  if (!c.pass) failed++;
  line(`  ${c.pass ? '✓' : '✗'} ${c.name}`);
  line(`      ${c.detail}`);
}

if (errors.length) {
  line('');
  line(`PAGE ERRORS (${errors.length}):`);
  for (const e of errors.slice(0, 8)) line(`  ${e.slice(0, 220)}`);
}

if (args.json) await writeFile(args.json, JSON.stringify(report, null, 2));

line('');
if (errors.length) { line('✗ page errors'); process.exit(1); }
if (failed) { line(`✗ ${failed} of ${report.checks.length} checks failed`); process.exit(1); }
line(`✓ all ${report.checks.length} checks passed`);
