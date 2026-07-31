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
 *   6  THE SCORE IS ONE NUMBER — see below
 *
 * ---------------------------------------------------------------------------
 * SECTION 6: ONE SCOREBOARD
 *
 * The game used to show two drift scores that disagreed. The HUD banked a
 * finished slide (peak, times a payout multiplier, dropping anything under
 * PAYOUT_MIN) into a corner total it owned privately; core/race.js separately
 * bucketed the raw rises of game.driftScore. On a three-lap alpine race those
 * came out at 242.04 and 1222.51.
 *
 * The ledger now lives in fx/feel.js, which exists with or without a DOM, and
 * both the HUD and race.js read it. This section proves that, with numbers,
 * against a driven race rather than against an argument:
 *
 *   1  corner TOTAL == sum of the lap table's drift column == race total,
 *      sampled every frame of a five-lap race, not just at the flag
 *   2  `?hud=0` scores identically to `?hud=1` — the same race is driven in two
 *      browser pages and every figure is diffed
 *   3  the BEST and TOP DRIFT marks come off the same banked per-lap values
 *   4  a slide under PAYOUT_MIN banks nothing, anywhere: every driftEnd in the
 *      race is recorded and the bank is reconciled against them exactly
 *   5  the chain multiplier is applied ONCE (bank rises by the raw peak, not by
 *      peak * mul), and the ladder still reaches x100 at 45 s
 *
 * A DRIFT-HAPPY PILOT drives it. The plain autopilot is smooth enough that
 * almost nothing it does clears PAYOUT_MIN — a three-lap race banked one single
 * slide — which would make every figure below zero and every check vacuous. So
 * the pilot yanks the handbrake in anything tighter than 0.2 of steering lock.
 * It is a pure function of sim state: no clock, no RNG, same race every run.
 *
 * Exit code is 1 if any check fails or the page threw.
 */
import { chromium } from 'playwright';
// The floor is imported, never duplicated: a test that hardcodes the constant
// it exists to verify fails the moment the constant is tuned, which is exactly
// what happened when PAYOUT_MIN moved 110 -> 33 with the base scoring rate.
import { PAYOUT_MIN } from '../src/fx/feel.js';
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
  g.__wired = true;
`;

/**
 * SECTION 6, run in the page. Shared verbatim between the ?hud=1 and ?hud=0
 * loads — if the two pages ran different code the diff would prove nothing.
 */
const SCORE = `
  const g = window.__GAME;
  if (!g.__wired) { __WIRE__ }
  const race = g.race;
  const DT = 1 / 60;

  race.closeTable();
  race.restart(g);

  /**
   * Deterministic drift pilot. Reads sim state only — no clock, no RNG — so the
   * same inputs come out in the same order on both pages.
   */
  const pilot = () => {
    const inp = g.autopilotInput({ throttle: 1, aggression: 1.15 });
    if (Math.abs(inp.steer) > 0.20 && g.vehicle.speed > 11) {
      inp.handbrake = 1; inp.brake = 0; inp.throttle = 1;
    }
    return inp;
  };

  // Every slide the race produces, and what the bank did about it. Wrapping the
  // event is the only way to see a slide the ledger THREW AWAY — feel.js is
  // right not to publish those, and this test is the one thing that needs them.
  const slides = [];
  const ev = g.feel.event.bind(g.feel);
  g.feel.event = (name, payload) => {
    if (name !== 'driftEnd') return ev(name, payload);
    const before = g.feel.bank, mul = g.feel.chainMultiplier;
    const r = ev(name, payload);
    slides.push({ peak: payload?.score ?? 0, rise: g.feel.bank - before, mul });   // rise is in whole points
    return r;
  };

  // Sampled every frame of the race: the three numbers that must never differ.
  let worstColumn = 0, worstHud = 0, samples = 0;
  const drive = (frames) => {
    for (let i = 0; i < frames && race.state !== 'finished'; i++) {
      g.update(DT, pilot());
      if (race.state !== 'running') continue;
      const m = race.model();
      const column = m.laps.reduce((a, l) => a + l.drift, 0) + m.lapDrift;
      worstColumn = Math.max(worstColumn, Math.abs(column - m.bank));
      if (g.hud) worstHud = Math.max(worstHud, Math.abs(g.hud.total - m.bank));
      samples++;
    }
  };
  drive(60 * BUDGET);

  // THE RENDERED TABLE, SCRAPED. The race ends with the overlay open, so this
  // is the actual DOM the player is looking at — not the model behind it.
  const dom = (() => {
    const root = document.getElementById('raceResults');
    if (!root) return null;
    const cells = [...root.querySelectorAll('.row')].map((r) => ({
      time: r.querySelector('b:not(.d)')?.textContent ?? '',
      drift: r.querySelector('b.d')?.textContent ?? '',
      flags: [...r.querySelectorAll('.flag')].map((f) => f.textContent.trim()).filter(Boolean),
    }));
    const num = (t) => Number(String(t).replace(/[^0-9]/g, ''));
    return {
      open: root.classList.contains('on'),
      rows: cells,
      columnSum: cells.reduce((a, c) => a + (c.drift === '—' ? 0 : num(c.drift)), 0),
      footDrift: num(root.querySelector('[data-footdrift]')?.textContent),
      footDriftTxt: root.querySelector('[data-footdrift]')?.textContent ?? '',
      verdict: root.querySelector('[data-verdict]')?.textContent ?? '',
      bestRows: cells.map((c, i) => (c.flags.includes('BEST') ? i + 1 : 0)).filter(Boolean),
      topRows: cells.map((c, i) => (c.flags.includes('TOP') ? i + 1 : 0)).filter(Boolean),
    };
  })();

  const m = race.model();
  const T = race.totals;
  const banked = slides.filter((s) => s.rise > 0);
  const dropped = slides.filter((s) => s.rise === 0);

  return {
    state: race.state,
    laps: race.laps.map((l) => ({ n: l.n, time: l.time, drift: l.drift })),
    totals: { time: T.time, drift: T.drift, best: T.best, bestDrift: T.bestDrift },
    bank: race.driftTotal,
    feelBank: g.feel.bank,
    feelBest: g.feel.best,
    hudTotal: g.hud ? g.hud.total : null,
    hudBest: g.hud ? g.hud.best : null,
    hudPresent: !!g.hud,
    dom,
    samples, worstColumn, worstHud,
    slides: slides.length,
    bankedCount: banked.length,
    droppedCount: dropped.length,
    bankedSum: banked.reduce((a, s) => a + Math.round(s.peak), 0),
    droppedSum: dropped.reduce((a, s) => a + s.peak, 0),
    droppedMax: dropped.reduce((a, s) => Math.max(a, s.peak), 0),
    bankedMin: banked.reduce((a, s) => Math.min(a, s.peak), Infinity),
    // The double-multiplier probe: the bank must rise by the RAW peak.
    multResidual: banked.reduce((a, s) => Math.max(a, Math.abs(s.rise - Math.round(s.peak))), 0),
    maxMul: banked.reduce((a, s) => Math.max(a, s.mul), 1),
  };
`;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const errors = [];

/** t=0 so the car is exactly where roads.spawn() put it and nothing has been
 *  driven yet — the race must start from the same pose the player gets. */
async function openStage(hud) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => errors.push(`[hud=${hud}] ${e}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`[hud=${hud}] ${m.text()}`); });
  await p.goto(`${args.base}/?shot=hero_alpine&t=0&hud=${hud}`, { waitUntil: 'load', timeout: 120000 });
  await p.waitForFunction('window.__SHOT_READY === true', null, { timeout: 180000 });
  return p;
}

const page = await openStage(1);

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

// ---------------------------------------------------------------------------
// SECTION 6 — one scoreboard. Same scripted race, two pages, hud on and off.
const scoreSrc = SCORE
  .replace('__WIRE__', WIRE.replace('LAPS_TOTAL', String(args.laps)))
  .replace('BUDGET', String(args.budget * (args.laps + 1)));
const runScore = (p) => p.evaluate(
  (src) => new Function(`return (async () => {${src}})()`)(), scoreSrc);

/**
 * BOTH SIDES GET A VIRGIN PAGE.
 *
 * The first run of this reused the checks page for the hud=1 side and the two
 * totals came out 3624.99 against 2183.72 — which looks exactly like the bug
 * being tested and was nothing of the sort. Sections 1-5 teleport the car
 * around the map, un-lap it, restart it and pause it, so by the time the
 * scoring race starts that page is 700 s of simTime and a different world state
 * away from a fresh one. `restart()` puts the car back on the line; it does not
 * rewind the clock. Two pages that have not been driven are the only pair whose
 * difference means what this check says it means.
 */
const onPage = await openStage(1);
const on = await runScore(onPage);
const offPage = await openStage(0);
const off = await runScore(offPage);

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

// ---------------------------------------------------------------------- score
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sc = [];
const okS = (name, pass, detail) => sc.push({ name, pass: !!pass, detail });

const sumD = on.laps.reduce((a, l) => a + l.drift, 0);
const sumT = on.laps.reduce((a, l) => a + l.time, 0);

okS('the scoring race finished and actually drifted',
  on.state === 'finished' && on.laps.length === args.laps && on.slides > 20
    && on.bankedCount > 3,
  `laps=${on.laps.length} slides=${on.slides} banked=${on.bankedCount} dropped=${on.droppedCount}`);

// ---- 1: one number ---------------------------------------------------------
okS('corner TOTAL == lap column == race total, at the flag',
  near(on.hudTotal, on.bank) && near(sumD, on.bank) && near(on.totals.drift, sumD)
    && near(on.feelBank, on.bank),
  `hud=${on.hudTotal.toFixed(6)} column=${sumD.toFixed(6)} race=${on.totals.drift.toFixed(6)} feel=${on.feelBank.toFixed(6)}`);
okS('…and at every frame of the race, not just at the flag',
  on.worstColumn < 1e-9 && on.worstHud < 1e-9 && on.samples > 5000,
  `${on.samples} frames sampled · worst |column-bank|=${on.worstColumn.toExponential(2)} · worst |hudTotal-bank|=${on.worstHud.toExponential(2)}`);

// ---- 2: ?hud=0 -------------------------------------------------------------
const lapDiff = on.laps.map((l, i) => Math.abs(l.drift - (off.laps[i]?.drift ?? NaN)));
okS('?hud=0 scores exactly what ?hud=1 scores',
  off.hudPresent === false && on.hudPresent === true
    && off.laps.length === on.laps.length
    && lapDiff.every((d) => d === 0)
    && off.totals.drift === on.totals.drift && off.bank === on.bank,
  `hud=1 ${on.bank.toFixed(6)}  hud=0 ${off.bank.toFixed(6)}  Δ=${(on.bank - off.bank).toExponential(2)}  per-lap Δ max=${Math.max(...lapDiff)}`);
okS('…and the same laps, in the same times, with the same marks',
  off.totals.best === on.totals.best && off.totals.bestDrift === on.totals.bestDrift
    && off.laps.every((l, i) => l.time === on.laps[i].time),
  `best lap ${on.totals.best}/${off.totals.best} · top drift ${on.totals.bestDrift}/${off.totals.bestDrift}`);

// ---- 3: the marks ----------------------------------------------------------
const argMin = (a, f) => a.reduce((b, l) => (f(l) < f(b) ? l : b));
const argMax = (a, f) => a.reduce((b, l) => (f(l) > f(b) ? l : b));
okS('BEST and TOP DRIFT are read off the banked per-lap values',
  on.totals.best === argMin(on.laps, (l) => l.time).n
    && on.totals.bestDrift === argMax(on.laps, (l) => l.drift).n,
  `best=lap ${on.totals.best} (${time(argMin(on.laps, (l) => l.time).time)}) · top drift=lap ${on.totals.bestDrift} (${argMax(on.laps, (l) => l.drift).drift.toFixed(2)})`);
okS('the HUD BEST is the largest single slide in the same ledger',
  near(on.hudBest, on.feelBest) && on.feelBest > 0 && on.feelBest <= on.bank,
  `hud.best=${on.hudBest.toFixed(4)} feel.best=${on.feelBest.toFixed(4)}`);

okS('the RENDERED table adds up: its drift column sums to its own footer',
  !!on.dom && on.dom.open && on.dom.columnSum === on.dom.footDrift
    && on.dom.footDrift === Math.round(on.bank)
    && off.dom.columnSum === on.dom.columnSum,
  `column ${on.dom?.columnSum} == footer "${on.dom?.footDriftTxt}" == bank ${Math.round(on.bank)} · hud=0 column ${off.dom?.columnSum}`);
okS('the rendered BEST and TOP marks sit on the rows the model says they do',
  on.dom.bestRows.length === 1 && on.dom.bestRows[0] === on.totals.best
    && on.dom.topRows.length === 1 && on.dom.topRows[0] === on.totals.bestDrift
    && on.dom.verdict.includes(String(Math.round(on.bank)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009')),
  `BEST on row ${on.dom.bestRows} · TOP on row ${on.dom.topRows} · verdict "${on.dom.verdict.trim()}"`);

// ---- 4: PAYOUT_MIN ---------------------------------------------------------
okS('a slide under PAYOUT_MIN banks nothing, anywhere',
  on.droppedCount > 0 && on.droppedMax < PAYOUT_MIN && on.bankedMin >= PAYOUT_MIN
    && on.bankedSum === on.bank && sumD === on.bankedSum,
  `${on.droppedCount} slides dropped worth ${on.droppedSum.toFixed(1)} raw (largest ${on.droppedMax.toFixed(1)}) · ${on.bankedCount} banked (smallest ${on.bankedMin.toFixed(1)}) summing to ${on.bankedSum.toFixed(4)} == bank ${on.bank.toFixed(4)}`);

// ---- 5: the ladder ---------------------------------------------------------
// EXACTLY zero, no tolerance: the ledger banks whole points, so the rise in the
// bank must equal the rounded peak to the unit. A second application of the
// ladder would put this at half a peak or more.
okS('the chain multiplier is applied ONCE — the bank rises by the raw peak',
  on.multResidual === 0 && on.maxMul > 1,
  `max |bankRise - round(peak)| = ${on.multResidual} over ${on.bankedCount} payouts, chain reached x${on.maxMul} (a second application would put this at >= 0.5 x peak)`);

/**
 * THE LADDER, DRIVEN DIRECTLY. No browser: fx/feel.js imports nothing, so the
 * rungs can be walked in node against a stub vehicle that never stops sliding.
 * A driven race cannot reach the top of this table — 45 s of unbroken slide is
 * meant to be a trophy — so the only honest way to check the ceiling is to hold
 * it there deliberately.
 */
const { createFeel } = await import('../src/fx/feel.js');
const ladder = (seconds) => {
  const feel = createFeel({});
  const v = { isDrifting: true, speed: 30, driftAngle: 0.5,
    lastImpact: 0, landImpact: 0, justShifted: 0, position: { x: 0, y: 0, z: 0 } };
  const DT = 1 / 60;
  for (let t = 0; t < seconds; t += DT) feel.update(DT, { vehicle: v });
  return feel;
};
const at45 = ladder(45.2), at44 = ladder(44.0), at9 = ladder(9.1);
okS('the chain ladder still reaches x100 after 45 s of linked drifting',
  at45.chainMultiplier === 100 && at44.chainMultiplier === 60 && at9.chainMultiplier === 6,
  `44.0 s -> x${at44.chainMultiplier} · 45.2 s -> x${at45.chainMultiplier} · 9.1 s -> x${at9.chainMultiplier}`);

// And the payout at the top of the ladder is the slide itself, not the slide
// times a hundred a second time. This is the double-application, isolated.
const top = ladder(45.2);
const bankBefore = top.bank;
top.event('driftEnd', { score: 1000 });
okS('a slide banked at the x100 rung banks 1000, not 99 000',
  top.chainMultiplier === 100 && top.bank - bankBefore === 1000 && top.payoutMult === 100
    && top.payoutBase === 10,
  `mul=x${top.chainMultiplier} peak=1000 -> bank +${top.bank - bankBefore} (the HUD counts up from payoutBase ${top.payoutBase} to ${top.payout})`);

// The floor, isolated: a hair under is worth nothing and exactly on is worth itself.
const floorFeel = createFeel({});
floorFeel.event('driftEnd', { score: PAYOUT_MIN - 0.001 });
const underBank = floorFeel.bank, underSeq = floorFeel.payoutSeq;
floorFeel.event('driftEnd', { score: PAYOUT_MIN });
okS('PAYOUT_MIN is a hard edge and only the ledger owns it',
  underBank === 0 && underSeq === 0 && floorFeel.bank === Math.round(PAYOUT_MIN)
    && floorFeel.payoutSeq === 1 && floorFeel.slideSeq === 2,
  `${PAYOUT_MIN - 0.001} -> bank ${underBank} (slideSeq ${floorFeel.slideSeq}, payoutSeq ${floorFeel.payoutSeq}) · ${PAYOUT_MIN} -> bank ${floorFeel.bank}`);


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
line(`SCORING RACE  (drift pilot, ${args.laps} laps, ?hud=1 vs ?hud=0)`);
line('   LAP        TIME     DRIFT (hud=1)   DRIFT (hud=0)          Δ');
for (const l of on.laps) {
  const o = off.laps.find((x) => x.n === l.n) ?? { drift: NaN };
  const marks = [l.n === on.totals.best ? 'BEST' : '', l.n === on.totals.bestDrift ? 'TOP DRIFT' : '']
    .filter(Boolean).join('  ');
  line(`    ${String(l.n).padStart(2, '0')}   ${time(l.time).padStart(9)}   ${f2(l.drift).padStart(13)}   ${f2(o.drift).padStart(13)}   ${(l.drift - o.drift).toExponential(1).padStart(8)}   ${marks}`);
}
line(`   -------------------------------------------------------------------`);
line(`  TOTAL   ${time(on.totals.time).padStart(9)}   ${f2(sumD).padStart(13)}   ${f2(off.laps.reduce((a, l) => a + l.drift, 0)).padStart(13)}`);
line(`  corner TOTAL (hud.total) ${f2(on.hudTotal)}   ·   feel.bank ${f2(on.feelBank)}   ·   race.driftTotal ${f2(on.bank)}`);
line(`  ${on.slides} slides · ${on.bankedCount} banked · ${on.droppedCount} dropped under PAYOUT_MIN (${f2(on.droppedSum)} raw points discarded, everywhere)`);

line('');
line('CHECKS');
let failed = 0;
for (const c of [...report.checks, ...sc]) {
  if (!c.pass) failed++;
  line(`  ${c.pass ? '✓' : '✗'} ${c.name}`);
  line(`      ${c.detail}`);
}
const nChecks = report.checks.length + sc.length;

if (errors.length) {
  line('');
  line(`PAGE ERRORS (${errors.length}):`);
  for (const e of errors.slice(0, 8)) line(`  ${e.slice(0, 220)}`);
}

if (args.json) await writeFile(args.json, JSON.stringify({ ...report, score: { on, off, checks: sc } }, null, 2));

line('');
if (errors.length) { line('✗ page errors'); process.exit(1); }
if (failed) { line(`✗ ${failed} of ${nChecks} checks failed`); process.exit(1); }
line(`✓ all ${nChecks} checks passed`);
