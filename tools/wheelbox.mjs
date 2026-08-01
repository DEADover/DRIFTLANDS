#!/usr/bin/env node
/**
 * WHEEL-IN-BODY CLEARANCE
 * -----------------------
 * The client reported that the wheels sink into the car's own frame. At 4% of
 * frame width that is not judgeable by eye, so this measures it as geometry.
 *
 * Every third frame of a driven lap it takes three rings of points on each
 * tyre's surface and pushes them through the real scene graph into BODY-LOCAL
 * space. Body-local is the frame that matters: the wheels hang off `chassis`
 * and the shell off `body`, and those two nodes move relative to each other
 * every frame — weight-transfer roll and pitch, and the spring ride height.
 *
 * Reports, per wheel:
 *   SIDE  the smallest gap between any point on the tyre and the body's flank
 *         at the same station and height, using car.js's exact section query
 *         (`view.halfWidthAt`). Negative = the tyre is inside the bodywork.
 *   ARCH  the gap from the tyre's crown to its flare's inner surface. The flare
 *         rides on the chassis with the wheel, so this is a design constant
 *         minus the wheel's own suspension rise, and is measured from the real
 *         node positions rather than assumed.
 *
 *   node tools/wheelbox.mjs --base http://127.0.0.1:5224 --seconds 130
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5173', preset: 'hero_alpine', seconds: 130 };
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--preset') args.preset = av[++i];
  else if (a === '--seconds') args.seconds = Number(av[++i]);
  else if (a === '--json') args.json = av[++i];
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${args.base}/?shot=${args.preset}&hud=0`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 240000 });

const report = await page.evaluate(async ({ seconds }) => {
  const g = window.__GAME;
  const view = g.carView;
  const NAMES = ['FL', 'FR', 'RL', 'RR'];
  const R = view.archGeom.wheelR, HALF_W = 0.21;

  // What the car costs. Draw calls matter more than triangles here: the whole
  // frame is ~224 calls and the car is one object among thousands.
  const cost = { meshes: 0, tris: 0, parts: [] };
  view.root.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.getAttribute('position');
    const n = o.geometry.index ? o.geometry.index.count / 3 : pos.count / 3;
    cost.meshes++; cost.tris += n;
    cost.parts.push({ name: o.name || '(unnamed)', tris: n });
  });
  cost.frame = { drawCalls: g.stats().drawCalls, triangles: g.stats().triangles };

  // Scratch Vector3 borrowed from the scene graph — no THREE import in-page.
  const p = view.root.position.clone();

  // Tyre surface points, tagged by which face of the tyre they sit on.
  //
  // THE THREE FACES ARE NOT THE SAME QUESTION. Bodywork that ends up between
  // the tyre's inner sidewall and its centre plane is buried inside an opaque
  // tyre, in a slot closed above by the flare and outboard by the tread — there
  // is no camera angle in this game that can see into it. Bodywork that reaches
  // past the OUTER sidewall breaks the surface the camera looks straight at, and
  // that is the only one that is a defect. They are reported apart, and the
  // claim was checked by forcing the worst measured pose and rendering it:
  //   node tools/carshot.mjs --lean 0.29 --drop -0.30 --out shots/car-lean
  const ring = [];
  for (let a = 0; a < 36; a++) {
    const t = (a / 36) * Math.PI * 2;
    for (const zz of [-HALF_W, 0, HALF_W]) {
      ring.push([Math.cos(t) * R, Math.sin(t) * R, zz, zz]);
    }
  }

  const side = NAMES.map(() => ({ gap: 1e9 }));
  const vis = NAMES.map(() => ({ gap: 1e9 }));
  const arch = NAMES.map(() => ({ gap: 1e9 }));
  let penFrames = 0, visFrames = 0, frames = 0;
  let restSide = null, restArch = null, restVis = null;

  const measure = () => {
    const cond = {
      speed: +(g.vehicle.speed * 3.6).toFixed(0),
      air: +(g._pose?.airW ?? 0).toFixed(2),
      onGround: !!g.vehicle.onGround,
      roll: +(view._roll ?? 0).toFixed(3),
      pitch: +(view._pitch ?? 0).toFixed(3),
      bodyY: +(view.body.position.y ?? 0).toFixed(3),
      lift: +(view._seatLift ?? 0).toFixed(3),
    };
    const out = { side: [], vis: [], arch: [], where: [], hit: false, visHit: false };
    for (let i = 0; i < 4; i++) {
      const w = view.wheels[i];
      // FL/RL sit at +z, so their outboard direction along the axle is +z.
      const outboard = i % 2 === 0 ? 1 : -1;
      let worst = 1e9, worstVis = 1e9, whereVis = null;
      for (const [lx, ly, lz, axial] of ring) {
        p.set(lx, ly, lz);
        w.localToWorld(p);
        view.body.worldToLocal(p);
        const half = view.halfWidthAt(p.x, p.y);
        if (half < 0) continue;                 // no bodywork at this station/height
        const gap = Math.abs(p.z) - half;
        if (gap < worst) worst = gap;
        if (axial * outboard > 0 && gap < worstVis) {
          worstVis = gap;
          whereVis = { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +Math.abs(p.z).toFixed(2), half: +half.toFixed(2) };
        }
      }
      if (worst < 0) out.hit = true;
      if (worstVis < 0) out.visHit = true;
      out.side.push(worst);
      out.vis.push(worstVis);
      out.where.push(whereVis);
      // The flare is rigid on the chassis at the wheel's design station, so the
      // only thing that closes the gap is the wheel's own rise on its node.
      out.arch.push(view.archGeom.gap - Math.max(0, w.position.y - R));
    }
    return { out, cond };
  };

  // A TRUE NEUTRAL POSE. The preset leaves the car mid-corner with lean on it,
  // and a "rest" number taken there is not the model's static clearance — it is
  // whatever corner the tape happened to stop in. Zero the cosmetic nodes, read
  // the geometry, put them back.
  {
    const keep = {
      rx: view.body.rotation.x, rz: view.body.rotation.z, py: view.body.position.y,
      wy: view.wheels.map((w) => w.position.y),
    };
    view.body.rotation.set(0, 0, 0);
    view.body.position.y = 0;
    for (const w of view.wheels) w.position.y = R;
    view.root.updateMatrixWorld(true);
    const m = measure();
    restSide = m.out.side.map((v) => +v.toFixed(3));
    restVis = m.out.vis.map((v) => +v.toFixed(3));
    restArch = m.out.arch.map((v) => +v.toFixed(3));
    view.body.rotation.x = keep.rx; view.body.rotation.z = keep.rz;
    view.body.position.y = keep.py;
    view.wheels.forEach((w, i) => { w.position.y = keep.wy[i]; });
    view.root.updateMatrixWorld(true);
  }

  const dt = 1 / 60;
  const total = Math.round(seconds / dt);
  for (let f = 0; f < total; f++) {
    g.update(dt, g.autopilotInput({ throttle: 1, aggression: 0.85 }));
    if (f % 3) continue;
    frames++;
    const { out, cond } = measure();
    if (out.hit) penFrames++;
    if (out.visHit) visFrames++;
    for (let i = 0; i < 4; i++) {
      if (out.side[i] < side[i].gap) side[i] = { gap: out.side[i], t: +(f * dt).toFixed(2), cond };
      if (out.vis[i] < vis[i].gap) vis[i] = { gap: out.vis[i], t: +(f * dt).toFixed(2), cond, where: out.where[i] };
      if (out.arch[i] < arch[i].gap) arch[i] = { gap: out.arch[i], t: +(f * dt).toFixed(2), cond };
    }
  }

  return {
    frames, penFrames, visFrames, cost,
    rest: { side: restSide, vis: restVis, arch: restArch },
    perWheel: NAMES.map((n, i) => ({ name: n, side: side[i], vis: vis[i], arch: arch[i] })),
    archDesign: view.archGeom.gap,
  };
}, { seconds: args.seconds });

await browser.close();

const f = (v, d = 3) => (v === undefined || v === null ? '  --  ' : v.toFixed(d));
console.log('');
console.log(`CAR COST — ${report.cost.meshes} meshes (= draw calls, doubled by the shadow pass), `
  + `${report.cost.tris} triangles`);
console.log(`  whole frame: ${report.cost.frame.drawCalls} draw calls, ${report.cost.frame.triangles} triangles`);
for (const p of report.cost.parts.sort((a, b) => b.tris - a.tris)) {
  console.log(`    ${String(p.name).padEnd(14)} ${String(p.tris).padStart(6)} tris`);
}

const pct = (n) => ((100 * n) / Math.max(report.frames, 1)).toFixed(1);
console.log('');
console.log(`WHEEL-IN-BODY — ${report.frames} sampled frames`);
console.log(`  any fouling ${report.penFrames} (${pct(report.penFrames)}%)   `
  + `VISIBLE (past the outer sidewall) ${report.visFrames} (${pct(report.visFrames)}%)`);
console.log(`  design arch gap ${f(report.archDesign)} m`);
console.log('');
console.log(`  NEUTRAL POSE   SIDE ${report.rest.side.map((v) => f(v)).join('  ')}`);
console.log(`                 VIS  ${report.rest.vis.map((v) => f(v)).join('  ')}`);
console.log(`                 ARCH ${report.rest.arch.map((v) => f(v)).join('  ')}`);
console.log('');
console.log('  worst over the lap (negative = tyre inside the body):');
console.log('  wheel   SIDE(any)      VIS(outboard)   ARCH');
for (const w of report.perWheel) {
  console.log(`   ${w.name}     ${f(w.side.gap).padStart(9)}      ${f(w.vis.gap).padStart(9)}   `
    + `${f(w.arch.gap).padStart(9)}`);
}
console.log('');
console.log('  worst-case conditions:');
for (const w of report.perWheel) {
  console.log(`    ${w.name} SIDE ${f(w.side.gap)} at ${w.side.t}s: ${JSON.stringify(w.side.cond)}`);
  console.log(`       VIS ${f(w.vis.gap)} at ${w.vis.t}s, on the body at ${JSON.stringify(w.vis.where)}`);
}
if (errors.length) {
  console.log('');
  console.log(`PAGE ERRORS (${errors.length}):`);
  for (const e of errors.slice(0, 6)) console.log(`  ${e.slice(0, 200)}`);
}
if (args.json) await writeFile(args.json, JSON.stringify(report, null, 2));
console.log('');
const worstSide = Math.min(...report.perWheel.map((w) => w.side.gap));
const worstVis = Math.min(...report.perWheel.map((w) => w.vis.gap));
const worstArch = Math.min(...report.perWheel.map((w) => w.arch.gap));
console.log(worstVis < 0 || worstArch < 0
  ? `✗ VISIBLE fouling: outboard ${worstVis.toFixed(3)} m, arch ${worstArch.toFixed(3)} m`
  : `✓ nothing visible fouls: outboard +${worstVis.toFixed(3)} m, arch +${worstArch.toFixed(3)} m`
    + `   (inboard-slot residual ${worstSide.toFixed(3)} m)`);
