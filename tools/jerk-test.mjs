#!/usr/bin/env node
/**
 * WHAT THE PLAYER ACTUALLY SEES MOVE
 * ----------------------------------
 * Three rounds of camera-jerk hunting used metrics that could not see the
 * defect, for one reason each:
 *
 *   - worst per-frame yaw/pitch: the camera is WORLD-FIXED, so on shake-free
 *     frames the worst yaw change is 0.0002 deg. It is a shake meter.
 *   - worst focus-point step/acceleration: the focus is a spring in METRES. It
 *     is smooth by construction and says nothing about how far the WORLD slid
 *     across the screen between two frames the player was shown.
 *   - and the killer: tools/camera-test.mjs drives the game at a FIXED 1/120 —
 *     exactly `FIXED_DT`. The accumulator in game.update() then consumes
 *     exactly one step per call, forever. The variable-frame case, which is the
 *     only case that exists in the browser, was never once measured.
 *
 * A jerk is not a camera property. It is a property of the SEQUENCE OF IMAGES.
 * So measure the images: project a lattice of FIXED WORLD POINTS through the
 * live camera once per RENDERED frame and look at how many pixels they move.
 * That is the optical flow the eye integrates, and it folds in every cause at
 * once — camera translation, FOV, zoom, time scale, and how much simulated time
 * the frame actually advanced.
 *
 * Metrics, all per rendered frame, at 1280x720:
 *
 *   flow      median |screen displacement| of the lattice, px/frame
 *   flowJerk  |flow[i] - flow[i-1]| / max(flow, eps)  — the RELATIVE step
 *             change. This is the one that matters: the eye reads a change in
 *             apparent speed, not an absolute pixel count. 0.0 = perfectly
 *             even motion, 1.0 = the world moved twice as far this frame as
 *             last frame.
 *   carJerk   second difference of the CAR's screen position, px/frame^2
 *   projJerk  second difference of the projection matrix, per frame
 *
 * Driven with a REALISTIC variable frame clock (see `frameClock`), because a
 * fixed clock hides the whole class of bug. Deterministic: the jitter comes
 * from a seeded LCG, never Math.random or the wall clock.
 *
 *   node tools/jerk-test.mjs --base http://127.0.0.1:5221
 *   node tools/jerk-test.mjs --clock fixed120     # what camera-test.mjs saw
 *   node tools/jerk-test.mjs --json after.json --baseline before.json
 */
import { chromium } from 'playwright';
import { writeFile, readFile, mkdir } from 'node:fs/promises';

const av = process.argv.slice(2);
const args = {
  base: 'http://127.0.0.1:5221', preset: 'hero_alpine', seconds: 150,
  clock: 'raf60', shots: 0, out: 'shots/jerk',
};
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--preset') args.preset = av[++i];
  else if (a === '--seconds') args.seconds = Number(av[++i]);
  else if (a === '--clock') args.clock = av[++i];
  else if (a === '--json') args.json = av[++i];
  else if (a === '--baseline') args.baseline = av[++i];
  else if (a === '--shots') args.shots = Number(av[++i]);
  else if (a === '--out') args.out = av[++i];
  else if (a === '--window') args.window = av[++i].split(',').map(Number);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${args.base}/?shot=${args.preset}&hud=0`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 180000 });

/**
 * Install the measurement rig in the page and hand back a stepper, so the shot
 * mode can drive frame-by-frame from node and screenshot whichever frames it
 * likes without re-running the sim.
 */
await page.evaluate(async ({ clock }) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const g = window.__GAME;
  const cam = g.camera.camera;
  const W = 1280, H = 720;

  /**
   * THE FRAME CLOCK. A browser does not hand you 1/60 exactly and it never has.
   * `raf60` is a 60 Hz vsync with the ±1.5 ms of scheduling jitter a real tab
   * shows, plus the occasional dropped frame — which is the ordinary case, not
   * an edge case. `fixed60`/`fixed120` are the sterile clocks the previous
   * rounds measured under. Seeded LCG: no Math.random, no wall clock, and two
   * runs agree to the last digit.
   */
  let s = 0x2f6e2b1 >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const frameClock = () => {
    if (clock === 'fixed60') return 1 / 60;
    if (clock === 'fixed120') return 1 / 120;
    if (clock === 'raf120') return 1 / 120 + (rnd() - 0.5) * 0.0012;
    // raf60: vsync ±1.5 ms, and 1 frame in 60 is a double-length dropped frame.
    const drop = rnd() < 1 / 60;
    return (drop ? 2 / 60 : 1 / 60) + (rnd() - 0.5) * 0.003;
  };

  // THE FLOW GAUGE — a 5x5 grid of FIXED SCREEN POSITIONS.
  //
  // First attempt used a ring of world points around the car and took the
  // median displacement. That is a broken gauge: as the ring rotates through
  // the frustum, points enter and leave the visible set, and since points at
  // different depths move at wildly different pixel rates under a 52-degree
  // tilt, the median jumped by 2x on membership changes alone. It invented
  // jerks the renderer never produced.
  //
  // Fixed screen positions cannot do that. Each frame, unproject the 25 grid
  // points onto the ground plane through the CURRENT camera and remember the
  // world points; next frame, project those same world points through the NEW
  // camera. The displacement at each grid cell is then literally the optical
  // flow the player's eye tracks at that part of the screen, the membership
  // never changes, and every cell is always defined because a camera pitched
  // 52 degrees down has every ray hitting the ground plane.
  const GRID = [];
  for (let gy = -0.8; gy <= 0.81; gy += 0.4) {
    for (let gx = -0.8; gx <= 0.81; gx += 0.4) GRID.push({ x: gx, y: gy });
  }
  const v3 = new THREE.Vector3();
  const ray = new THREE.Vector3();
  /** Unproject an NDC point onto the horizontal plane y=py. Never returns null. */
  const onPlane = (ndcX, ndcY, py, out) => {
    ray.set(ndcX, ndcY, 0.5).unproject(cam).sub(cam.position);
    // Guard a near-horizontal ray: clamp the parameter so a grazing cell lands
    // far away rather than behind the camera.
    const t = Math.min(4000, (py - cam.position.y) / Math.min(-1e-3, ray.y));
    out.x = cam.position.x + ray.x * t;
    out.y = py;
    out.z = cam.position.z + ray.z * t;
  };
  const toPx = (x, y, z, out) => {
    v3.set(x, y, z).project(cam);
    out.x = (v3.x * 0.5 + 0.5) * W;
    out.y = (0.5 - v3.y * 0.5) * H;
    out.vis = Math.abs(v3.x) <= 1.35 && Math.abs(v3.y) <= 1.35;
  };

  const rows = [];
  let prevPts = null, prevFlow = null, prevVel = null, prevCar = null, prevCarStep = null;
  let prevProj = null, prevProjStep = null;
  const scratch = { x: 0, y: 0, vis: false };

  window.__RIG = {
    rows,
    frame: 0,
    simTime: 0,
    step() {
      const dt = frameClock();
      const accBefore = g.accumulator;
      // The time scale that THIS frame's sim advance was computed with. It has
      // to be read BEFORE update(), because feel.update() runs inside it and
      // rewrites timeScale for the NEXT frame — reading it afterwards made the
      // frame that hit-stop engages on look like a residual of 7.9 when it was
      // a perfectly ordinary full-speed frame.
      const ts = g.feel.timeScale ?? 1;
      g.update(dt, g.autopilotInput({ throttle: 1, aggression: 0.85 }));
      const v = g.vehicle;
      const tsAfter = g.feel.timeScale ?? 1;
      // How much SIM TIME this rendered frame advanced, expressed in units of
      // FIXED_DT. Under the old accumulator this was an integer that wandered;
      // under the substep loop it is exactly dt*ts/FIXED_DT every time. The
      // fractional part is the whole diagnosis.
      const steps = g._substeps !== undefined
        ? +((g._substeps * g._substepDt) * 120).toFixed(3)
        : Math.round((accBefore + dt * ts - g.accumulator) * 120);
      this.simTime += dt;

      // --- optical flow at 25 fixed screen positions ------------------------
      let flow = 0;
      if (prevPts) {
        // Same physical points, two cameras: the difference is exactly the
        // pixels the world slid under that part of the screen.
        const d = [];
        for (const p of prevPts) {
          toPx(p.wx, p.wy, p.wz, scratch);
          d.push(Math.hypot(scratch.x - p.px, scratch.y - p.py));
        }
        d.sort((a, b) => a - b);
        flow = d[d.length >> 1];
      }
      const py = g.camera._focus.y;
      const pts = [];
      for (const q of GRID) {
        onPlane(q.x, q.y, py, v3);
        const wx = v3.x, wy = v3.y, wz = v3.z;
        pts.push({ wx, wy, wz, px: (q.x * 0.5 + 0.5) * W, py: (0.5 - q.y * 0.5) * H });
      }
      prevPts = pts;

      let flowJerk = 0;
      if (prevFlow !== null && prevPts) {
        flowJerk = Math.abs(flow - prevFlow) / Math.max(0.75, flow, prevFlow);
      }
      prevFlow = flow;

      // THE HEADLINE METRIC. `flow` alone is unfair to a dropped frame: if the
      // frame took twice as long, the world SHOULD have slid twice as far, and
      // that is not a jerk, it is correct rendering. Divide by the real frame
      // time and you have the APPARENT WORLD VELOCITY in px/s — which a correct
      // renderer holds constant across any frame-time pattern. Its relative
      // frame-to-frame change is judder and nothing else.
      const vel = flow / dt;
      let velJerk = 0;
      if (prevVel !== null && prevPts) {
        velJerk = Math.abs(vel - prevVel) / Math.max(60, vel, prevVel);
      }
      prevVel = vel;

      // --- car's own screen position ---------------------------------------
      const cy = (g._carY ?? v.position.y) + 0.7;
      toPx(v.position.x, cy, v.position.z, scratch);
      const car = { x: scratch.x, y: scratch.y };
      let carJerk = 0;
      if (prevCar) {
        const st = { x: car.x - prevCar.x, y: car.y - prevCar.y };
        if (prevCarStep) carJerk = Math.hypot(st.x - prevCarStep.x, st.y - prevCarStep.y);
        prevCarStep = st;
      }
      prevCar = car;

      // --- the projection matrix itself ------------------------------------
      const pe = cam.projectionMatrix.elements;
      let projJerk = 0;
      if (prevProj) {
        const st = [];
        for (let i = 0; i < 16; i++) st.push(pe[i] - prevProj[i]);
        if (prevProjStep) {
          let m = 0;
          for (let i = 0; i < 16; i++) m = Math.max(m, Math.abs(st[i] - prevProjStep[i]));
          projJerk = m;
        }
        prevProjStep = st;
      }
      prevProj = Array.from(pe);

      rows.push({
        f: this.frame++, t: this.simTime, dt, steps, ts, tsAfter,
        flow, flowJerk, vel, velJerk, carJerk, projJerk,
        speed: v.speed, fov: cam.fov,
        shake: g.camera.shakeAmount ?? 0,
        air: g._airborne ? 1 : 0,
        carX: car.x, carY: car.y,
      });
      return dt;
    },
  };
}, { clock: args.clock });

// Run the sim.
const N = Math.round(args.seconds * (args.clock === 'fixed120' || args.clock === 'raf120' ? 120 : 60));
await page.evaluate((n) => { for (let i = 0; i < n; i++) window.__RIG.step(); }, N);

const report = await page.evaluate(() => {
  const rows = window.__RIG.rows;
  // Skip the first 30 frames: the rig's own priming, not the game's behaviour.
  const R = rows.slice(30);
  const stats = (get) => {
    const a = R.map(get).filter((x) => Number.isFinite(x));
    const s = a.slice().sort((x, y) => x - y);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { mean: a.reduce((x, y) => x + y, 0) / a.length, p50: q(0.5), p95: q(0.95), p999: q(0.999), max: s[s.length - 1] };
  };
  const worst = (key, n = 12) => R.slice().sort((a, b) => b[key] - a[key]).slice(0, n)
    .map((r) => ({ f: r.f, t: +r.t.toFixed(3), v: +r[key].toFixed(4), dt: +(r.dt * 1000).toFixed(2), steps: r.steps, ts: +r.ts.toFixed(3), flow: +r.flow.toFixed(2), speed: +r.speed.toFixed(1), shake: +r.shake.toFixed(3), fov: +r.fov.toFixed(3), air: r.air }));

  // THE RESIDUAL. `steps` is the sim time this rendered frame advanced, in
  // units of FIXED_DT. What matters is not its value but whether it TRACKS THE
  // FRAME'S OWN DURATION. `want` is what the frame should have advanced;
  // `residual` is the fraction it was short or long by, and it is the defect
  // itself expressed as one number. A fixed-step accumulator with no
  // interpolation produces a residual of up to 50%; advancing the frame's own
  // time produces exactly zero.
  const resid = R.map((r) => {
    const want = (r.dt * r.ts) * 120;
    return Math.abs(r.steps - want) / Math.max(0.25, want);
  });
  const rs = resid.slice().sort((a, b) => a - b);
  const residual = {
    mean: resid.reduce((a, b) => a + b, 0) / resid.length,
    p50: rs[rs.length >> 1], p95: rs[Math.floor(rs.length * 0.95)], max: rs[rs.length - 1],
    over10pct: resid.filter((x) => x > 0.1).length,
  };
  // Frames where the world did not advance AT ALL — the slow-motion stutter.
  const frozen = R.filter((r) => r.steps === 0).length;

  // Split the apparent-speed jerk by whether the frame's residual was large.
  const evenJ = [], unevenJ = [];
  for (let i = 1; i < R.length; i++) {
    (resid[i] > 0.1 ? unevenJ : evenJ).push(R[i].velJerk);
  }
  const mm = (a) => a.length ? { n: a.length, mean: a.reduce((x, y) => x + y, 0) / a.length, max: Math.max(...a) } : null;

  return {
    frames: R.length,
    flow: stats((r) => r.flow),
    flowJerk: stats((r) => r.flowJerk),
    velJerk: stats((r) => r.velJerk),
    carJerk: stats((r) => r.carJerk),
    projJerk: stats((r) => r.projJerk),
    residual, frozen,
    byStepChange: { even: mm(evenJ), uneven: mm(unevenJ) },
    worstVelJerk: worst('velJerk'),
    worstVelJerkCalm: R.filter((r) => Math.abs(r.ts - 1) < 1e-6).slice()
      .sort((a, b) => b.velJerk - a.velJerk).slice(0, 12)
      .map((r) => ({ f: r.f, t: +r.t.toFixed(3), v: +r.velJerk.toFixed(4), dt: +(r.dt * 1000).toFixed(2), steps: r.steps, ts: +r.ts.toFixed(3), flow: +r.flow.toFixed(2), speed: +r.speed.toFixed(1), shake: +r.shake.toFixed(3), fov: +r.fov.toFixed(3), air: r.air })),
    worstFlowJerk: worst('flowJerk'),
    worstCarJerk: worst('carJerk'),
    worstProjJerk: worst('projJerk'),
    tsFrames: R.filter((r) => Math.abs(r.ts - 1) > 1e-6).length,
    rows: R.map((r) => [r.f, +r.t.toFixed(4), +(r.dt * 1000).toFixed(3), r.steps, +r.ts.toFixed(4),
      +r.flow.toFixed(3), +r.vel.toFixed(1), +r.velJerk.toFixed(4), +r.carJerk.toFixed(3),
      +r.speed.toFixed(2), +r.fov.toFixed(3), +r.shake.toFixed(3), r.air,
      +r.carX.toFixed(2), +r.carY.toFixed(2)]),
  };
});

// --window a,b prints the raw per-frame trace, which is how you actually see
// what a jerk frame is doing rather than guessing from a summary.
if (args.window) {
  const [a, b] = args.window;
  console.log('');
  console.log('  RAW TRACE   frame        t   dt ms   steps      ts    flow    px/s  velJerk  carJerk   speed     fov   shake air   carX    carY');
  for (const r of report.rows) {
    if (r[0] < a || r[0] > b) continue;
    console.log(`            ${String(r[0]).padStart(7)} ${String(r[1]).padStart(8)} ${String(r[2]).padStart(7)} ` +
      `${String(r[3]).padStart(7)} ${String(r[4]).padStart(7)} ${String(r[5]).padStart(7)} ${String(r[6]).padStart(7)} ` +
      `${String(r[7]).padStart(8)} ${String(r[8]).padStart(8)} ${String(r[9]).padStart(7)} ${String(r[10]).padStart(7)} ` +
      `${String(r[11]).padStart(7)} ${String(r[12]).padStart(3)} ${String(r[13]).padStart(6)} ${String(r[14]).padStart(7)}`);
  }
}

// --- optional: shoot the frames around the worst events ---------------------
if (args.shots) {
  await mkdir(args.out, { recursive: true });
  // The worst CAR-screen jerks are the ones worth looking at: the world behind
  // the car is drawn by a camera on a continuous clock and slides smoothly, so
  // the defect shows up as the car moving unevenly AGAINST it. Shoot a run of
  // consecutive frames around each and crop tight to the car so a 4 px stutter
  // is actually visible on a 1280-wide plate.
  const targets = [...new Set(report.worstCarJerk.slice(0, args.shots).map((w) => w.f))];
  const last = Math.max(...targets) + 3;
  const wanted = new Set();
  for (const f of targets) for (let k = -3; k <= 3; k++) wanted.add(f + k);

  const p2 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await p2.goto(`${args.base}/?shot=${args.preset}&hud=0`, { waitUntil: 'load', timeout: 120000 });
  await p2.waitForFunction('window.__SHOT_READY === true', null, { timeout: 180000 });
  await p2.evaluate(({ clock }) => {
    let s = 0x2f6e2b1 >>> 0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    window.__CLK = () => {
      if (clock === 'fixed60') return 1 / 60;
      if (clock === 'fixed120') return 1 / 120;
      if (clock === 'raf120') return 1 / 120 + (rnd() - 0.5) * 0.0012;
      const drop = rnd() < 1 / 60;
      return (drop ? 2 / 60 : 1 / 60) + (rnd() - 0.5) * 0.003;
    };
  }, { clock: args.clock });

  for (let i = 0; i <= last; i++) {
    await p2.evaluate(() => {
      const g = window.__GAME;
      g.update(window.__CLK(), g.autopilotInput({ throttle: 1, aggression: 0.85 }));
    });
    if (!wanted.has(i)) continue;
    await p2.evaluate(() => { window.__GAME.render(); window.__GAME.render(); });
    const owner = targets.reduce((a, b) => (Math.abs(b - i) < Math.abs(a - i) ? b : a));
    const tag = `${String(owner).padStart(6, '0')}_${i - owner >= 0 ? '+' : ''}${i - owner}`;
    await p2.screenshot({ path: `${args.out}/f${tag}.png` });
    // A crop centred on where the car is SUPPOSED to be — a fixed screen rect,
    // so any movement inside it is the car moving relative to the frame.
    const r = report.rows.find((x) => x[0] === owner);
    void r;
    const box = await p2.evaluate(() => {
      const g = window.__GAME, c = g.camera.camera;
      const v = g.vehicle;
      const p = new (Object.getPrototypeOf(c.position).constructor)(
        v.position.x, (g._carY ?? v.position.y) + 0.7, v.position.z).project(c);
      return { x: (p.x * 0.5 + 0.5) * 1280, y: (0.5 - p.y * 0.5) * 720 };
    });
    void box;
    await p2.screenshot({
      path: `${args.out}/crop${tag}.png`,
      clip: { x: 470, y: 250, width: 340, height: 220 },
    });
  }
  await p2.close();
  console.log(`shot ${wanted.size} frames around ${targets.join(', ')} -> ${args.out}/`);
}

await browser.close();

const L = console.log;
const f4 = (v) => (v === undefined || v === null ? '   --' : v.toFixed(4));
let base = null;
if (args.baseline) { try { base = JSON.parse(await readFile(args.baseline, 'utf8')); } catch {} }

L('');
L(`SCREEN-MOTION JERK   clock=${args.clock}  ${report.frames} rendered frames  preset=${args.preset}`);
L('');
L('  metric                        mean      p50      p95     p99.9      max' + (base ? '      (was max)' : ''));
const row = (k, name) => L(`  ${name.padEnd(26)} ${f4(report[k].mean).padStart(8)} ${f4(report[k].p50).padStart(8)} ` +
  `${f4(report[k].p95).padStart(8)} ${f4(report[k].p999).padStart(8)} ${f4(report[k].max).padStart(8)}` +
  (base?.[k] ? `      ${f4(base[k].max)}` : ''));
row('velJerk', 'APPARENT-SPEED JERK');
row('flow', 'world flow px/frame');
row('flowJerk', 'flow jerk (relative)');
row('carJerk', 'car screen px/frame^2');
row('projJerk', 'projection matrix d2');
L('');
L('  SIM-TIME RESIDUAL — |sim time this frame advanced - the frame\'s own duration| / duration.');
L('  This is the defect itself as one number. Zero means every rendered frame');
L('  represents exactly its own slice of time; anything else is judder.');
L(`      mean ${f4(report.residual.mean)}   p50 ${f4(report.residual.p50)}   p95 ${f4(report.residual.p95)}   max ${f4(report.residual.max)}` +
  (base?.residual ? `      (was max ${f4(base.residual.max)})` : ''));
L(`      frames over 10% short/long:  ${report.residual.over10pct} / ${report.frames}` +
  (base?.residual ? `   was ${base.residual.over10pct} / ${base.frames}` : ''));
L(`      frames where the world did NOT advance at all:  ${report.frozen}` +
  (base ? `   was ${base.frozen}` : ''));
if (report.byStepChange.even && report.byStepChange.uneven) {
  const e = report.byStepChange.even, u = report.byStepChange.uneven;
  L(`  APPARENT-SPEED JERK, split by residual:`);
  L(`      residual under 10%   n=${String(e.n).padStart(6)}   mean ${f4(e.mean)}   max ${f4(e.max)}`);
  L(`      residual over  10%   n=${String(u.n).padStart(6)}   mean ${f4(u.mean)}   max ${f4(u.max)}`);
}
L(`  frames with timeScale != 1: ${report.tsFrames}`);
L('');
const table = (title, list) => {
  L('');
  L(`  ${title}`);
  L('    frame        t     jerk   dt ms  steps     ts    flow   speed   shake     fov  air');
  for (const w of list) {
    L(`  ${String(w.f).padStart(7)} ${String(w.t).padStart(8)} ${f4(w.v).padStart(8)} ${String(w.dt).padStart(7)} ` +
      `${String(w.steps).padStart(6)} ${String(w.ts).padStart(6)} ${String(w.flow).padStart(7)} ${String(w.speed).padStart(7)} ` +
      `${String(w.shake).padStart(7)} ${String(w.fov).padStart(7)} ${String(w.air).padStart(4)}`);
  }
};
table('WORST APPARENT-SPEED JERK — the frames to go and look at', report.worstVelJerk);
table('WORST APPARENT-SPEED JERK on frames with timeScale == 1', report.worstVelJerkCalm);

L('');
L('  WORST FLOW JERK');
L('    frame        t     jerk   dt ms  steps     ts    flow   speed   shake     fov  air');
for (const w of report.worstFlowJerk) {
  L(`  ${String(w.f).padStart(7)} ${String(w.t).padStart(8)} ${f4(w.v).padStart(8)} ${String(w.dt).padStart(7)} ` +
    `${String(w.steps).padStart(6)} ${String(w.ts).padStart(6)} ${String(w.flow).padStart(7)} ${String(w.speed).padStart(7)} ` +
    `${String(w.shake).padStart(7)} ${String(w.fov).padStart(7)} ${String(w.air).padStart(4)}`);
}
L('');
L('  WORST CAR-SCREEN JERK');
L('    frame        t   px/f^2   dt ms  steps     ts    flow   speed   shake     fov  air');
for (const w of report.worstCarJerk) {
  L(`  ${String(w.f).padStart(7)} ${String(w.t).padStart(8)} ${f4(w.v).padStart(8)} ${String(w.dt).padStart(7)} ` +
    `${String(w.steps).padStart(6)} ${String(w.ts).padStart(6)} ${String(w.flow).padStart(7)} ${String(w.speed).padStart(7)} ` +
    `${String(w.shake).padStart(7)} ${String(w.fov).padStart(7)} ${String(w.air).padStart(4)}`);
}

if (errors.length) {
  L('');
  L(`PAGE ERRORS (${errors.length}):`);
  for (const e of errors.slice(0, 6)) L(`  ${e.slice(0, 200)}`);
}
if (args.json) await writeFile(args.json, JSON.stringify(report, null, 2));
L('');
if (errors.length) { L('x page errors'); process.exit(1); }
L('ok');
