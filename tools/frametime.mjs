#!/usr/bin/env node
/**
 * WHAT THE MACHINE ACTUALLY DOES, ON THE REAL CLOCK
 * -------------------------------------------------
 * Every previous jerk hunt in this project measured the SIMULATION. tools/
 * camera-test.mjs drives game.update() at a fixed 1/120; tools/jerk-test.mjs
 * improved on that by driving a jittered synthetic clock and projecting a
 * lattice — but it still calls game.update() in a `for` loop as fast as node
 * can push it. NEITHER OF THEM HAS EVER SEEN A REAL FRAME.
 *
 * The client is on a 120 Hz ProMotion MacBook Pro and reports the game "feels
 * like it is lagging". On that machine a lattice metric taken from a synthetic
 * clock is not evidence of anything: the question is whether the browser can
 * finish a frame inside the display's refresh interval and whether it presents
 * those frames at even spacing. So this tool runs the ACTUAL PAGE, with the
 * ACTUAL requestAnimationFrame loop from main.js, in a HEADED Chromium on the
 * real GPU and the real display, and records, per rendered frame:
 *
 *   raf      the rAF timestamp delta — the cadence the display was driven at
 *   upd      wall time inside game.update()
 *   ren      wall time inside game.render()
 *   gpu      GPU time for the frame, via EXT_disjoint_timer_query_webgl2
 *   calls    renderer.info.render.calls
 *   tris     renderer.info.render.triangles
 *   heap     performance.memory.usedJSHeapSize, to expose allocation rate
 *   carPx    the car's position in device pixels, for optical jerk
 *
 * HEADED IS NOT OPTIONAL. Headless Chromium falls back to SwiftShader, a
 * software rasteriser: it would report a GPU cost that has nothing to do with
 * an M-series Mac, and its rAF is not vsync-locked, so the cadence — the whole
 * point of this tool — would be fabricated.
 *
 *   node tools/frametime.mjs --base http://127.0.0.1:5230
 *   node tools/frametime.mjs --seconds 25 --json after.json --baseline before.json
 *   node tools/frametime.mjs --headless          # CPU-only numbers, no cadence
 */
import { chromium } from 'playwright';
import { writeFile, readFile } from 'node:fs/promises';

const av = process.argv.slice(2);
const args = {
  base: 'http://127.0.0.1:5230', seconds: 20, width: 1512, height: 900, dpr: 2,
  headless: false, warmup: 4,
};
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--seconds') args.seconds = Number(av[++i]);
  else if (a === '--width') args.width = Number(av[++i]);
  else if (a === '--height') args.height = Number(av[++i]);
  else if (a === '--dpr') args.dpr = Number(av[++i]);
  else if (a === '--warmup') args.warmup = Number(av[++i]);
  else if (a === '--headless') args.headless = true;
  else if (a === '--json') args.json = av[++i];
  else if (a === '--baseline') args.baseline = av[++i];
  else if (a === '--label') args.label = av[++i];
}

const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f2 = (x) => x.toFixed(2);

const browser = await chromium.launch({
  headless: args.headless,
  args: [
    // Ask for the real thing. Without these Chromium may still pick the
    // software path even in a headed window on some macOS setups.
    '--use-angle=metal',
    '--enable-gpu-rasterization',
    '--ignore-gpu-blocklist',
    // The timer query extension is what gives us honest GPU cost.
    '--enable-webgl-draft-extensions',
  ],
});
const page = await browser.newPage({
  viewport: { width: args.width, height: args.height },
  deviceScaleFactor: args.dpr,
});

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(args.base, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GAME?.roads, null, { timeout: 60000 });

// Start the race the way a player does, then hold the throttle down. The
// keyboard path is deliberate: it exercises the same input object the player
// uses, and it supplies the user gesture WebAudio needs, so the audio graph is
// running during the measurement exactly as it is in a real session.
await page.click('#play');
await page.keyboard.down('ArrowUp');

// Instrument the live loop from inside the page. game.update and game.render
// are replaced with timing wrappers; the rAF loop in main.js keeps calling
// whatever is on the object, so it picks these up without a reload.
await page.evaluate(({ warmup, seconds }) => {
  const g = window.__GAME;
  const gl = g.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');

  const rec = { raf: [], vsync: [], upd: [], ren: [], gpu: [], calls: [], tris: [], heap: [], car: [], prog: [] };
  window.__REC = rec;
  window.__DONE = false;

  const rawUpdate = g.update.bind(g);
  const rawRender = g.render.bind(g);
  const v3 = new (g.camera.camera.position.constructor)();

  let last = -1;
  let t0 = -1;
  // One query in flight at a time; a GPU timer query cannot be read back in
  // the same frame it was issued without stalling the pipeline, which would
  // itself change the number being measured.
  let pending = null;

  g.update = (dt, input) => {
    const a = performance.now();
    rawUpdate(dt, input);
    rec.upd.push(performance.now() - a);
  };

  g.render = () => {
    if (ext && !pending) {
      pending = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, pending);
    }
    const a = performance.now();
    rawRender();
    rec.ren.push(performance.now() - a);
    if (ext && pending) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      const q = pending;
      pending = null;
      // Read it back on a later frame.
      window.__PENDING_Q = window.__PENDING_Q || [];
      window.__PENDING_Q.push(q);
    }
  };

  const drain = () => {
    const qs = window.__PENDING_Q || [];
    while (qs.length) {
      const q = qs[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      if (!disjoint) rec.gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
      qs.shift();
    }
  };

  // A second rAF, registered after main.js's, samples the state main.js just
  // produced. Registering our own callback rather than wrapping theirs keeps
  // the loop in main.js untouched — the thing being measured stays the thing
  // that ships.
  //
  // THE INTERVAL THAT MATTERS IS BETWEEN FRAMES THE PLAYER WAS SHOWN, not
  // between rAF callbacks. Once the frame governor is in, most rAF callbacks
  // render nothing, and counting those would report the display's refresh rate
  // as the game's frame rate — flattering and false. `rendered` is bumped by
  // the render wrapper above, so this only samples on frames that were drawn.
  let seen = -1;
  let lastAny = -1;
  const tick = (now) => {
    if (t0 < 0) t0 = now;
    const elapsed = (now - t0) / 1000;
    // The display's own period has to come from EVERY callback, including the
    // ones the governor renders nothing on — otherwise, once pacing is in, the
    // shortest interval seen is the game's frame period and every frame reads
    // as exactly one refresh whatever the truth is.
    if (lastAny >= 0 && elapsed > warmup) rec.vsync.push(now - lastAny);
    lastAny = now;
    const drawn = rec.ren.length;
    if (drawn === seen) { requestAnimationFrame(tick); return; }
    seen = drawn;
    if (last >= 0 && elapsed > warmup) {
      rec.raf.push(now - last);
      const info = g.renderer.info.render;
      rec.calls.push(info.calls);
      rec.tris.push(info.triangles);
      rec.prog.push(g.renderer.info.programs?.length ?? 0);
      if (performance.memory) rec.heap.push(performance.memory.usedJSHeapSize / 1048576);
      // Where the car is on screen, in device pixels — the only jerk metric
      // that describes what the eye is given.
      v3.copy(g.vehicle.position).project(g.camera.camera);
      rec.car.push([
        (v3.x * 0.5 + 0.5) * window.innerWidth * window.devicePixelRatio,
        (-v3.y * 0.5 + 0.5) * window.innerHeight * window.devicePixelRatio,
      ]);
    }
    last = now;
    if (ext) drain();
    if (elapsed > warmup + seconds) { window.__DONE = true; return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.__HASEXT = !!ext;
}, { warmup: args.warmup, seconds: args.seconds });

await page.waitForFunction(() => window.__DONE === true, null,
  { timeout: (args.warmup + args.seconds + 30) * 1000 });

const rec = await page.evaluate(() => ({
  ...window.__REC,
  pacer: window.__GAME.pacer ? { ...window.__GAME.pacer.stats } : null,
  hasExt: window.__HASEXT,
  dpr: window.devicePixelRatio,
  size: [window.innerWidth, window.innerHeight],
  speed: window.__GAME.vehicle.speed,
}));
await browser.close();

// ---------------------------------------------------------------- analysis
const raf = rec.raf;
const fps = raf.map((d) => 1000 / d);

// THE CADENCE TEST. A display shows frames at fixed instants; the only thing
// the page controls is whether it has one ready. So the honest question is not
// "what is the average fps" but "how many refresh intervals does each frame
// last, and does that number keep changing". A run that alternates 1,2,1,2 has
// a fine average and looks terrible.
const refresh = pct(rec.vsync.length ? rec.vsync : raf, 5);   // shortest interval seen ~= one vsync
const quanta = raf.map((d) => d / refresh);
const rounded = quanta.map((q) => Math.max(1, Math.round(q)));
let switches = 0;
for (let i = 1; i < rounded.length; i++) if (rounded[i] !== rounded[i - 1]) switches++;
const hist = new Map();
for (const q of rounded) hist.set(q, (hist.get(q) ?? 0) + 1);

// Optical jerk on the real clock: second difference of the car's screen
// position, in device pixels per frame squared.
const carJerk = [];
for (let i = 2; i < rec.car.length; i++) {
  const a = rec.car[i - 2], b = rec.car[i - 1], c = rec.car[i];
  carJerk.push(Math.hypot(c[0] - 2 * b[0] + a[0], c[1] - 2 * b[1] + a[1]));
}

const cpu = rec.upd.map((u, i) => u + (rec.ren[i] ?? 0));
const budget = refresh;
const overBudget = raf.filter((d) => d > refresh * 1.5).length;

const out = {
  label: args.label ?? null,
  size: rec.size, dpr: rec.dpr, backbuffer: [rec.size[0] * rec.dpr, rec.size[1] * rec.dpr],
  frames: raf.length,
  speedKph: Math.round(rec.speed * 3.6),
  refreshMs: refresh,
  fps: { mean: mean(fps), p50: pct(fps, 50), p5: pct(fps, 5), min: Math.min(...fps) },
  rafMs: { mean: mean(raf), p50: pct(raf, 50), p95: pct(raf, 95), max: Math.max(...raf) },
  quantaHist: [...hist.entries()].sort((a, b) => a[0] - b[0])
    .map(([q, n]) => [q, n, +(100 * n / rounded.length).toFixed(1)]),
  quantaSwitchPct: +(100 * switches / Math.max(1, rounded.length - 1)).toFixed(1),
  updMs: { mean: mean(rec.upd), p95: pct(rec.upd, 95), max: Math.max(...rec.upd) },
  renMs: { mean: mean(rec.ren), p95: pct(rec.ren, 95), max: Math.max(...rec.ren) },
  cpuMs: { mean: mean(cpu), p95: pct(cpu, 95), max: Math.max(...cpu) },
  gpuMs: rec.gpu.length
    ? { mean: mean(rec.gpu), p95: pct(rec.gpu, 95), max: Math.max(...rec.gpu), n: rec.gpu.length }
    : null,
  cpuOverBudgetPct: +(100 * cpu.filter((c) => c > budget).length / cpu.length).toFixed(1),
  longFramePct: +(100 * overBudget / raf.length).toFixed(1),
  drawCalls: rec.calls.length ? pct(rec.calls, 50) : 0,
  triangles: rec.tris.length ? pct(rec.tris, 50) : 0,
  programs: rec.prog.length ? pct(rec.prog, 50) : 0,
  heapMB: rec.heap.length
    ? { start: rec.heap[0], end: rec.heap[rec.heap.length - 1],
        mbPerSec: (Math.max(...rec.heap) - rec.heap[0]) / args.seconds }
    : null,
  carJerkPx: { mean: mean(carJerk), p95: pct(carJerk, 95), max: Math.max(...carJerk) },
  errors: errors.length,
  pacer: rec.pacer,
};

const line = (k, v) => console.log(k.padEnd(22) + v);
console.log(`\n=== FRAME TIME, REAL LOOP ${args.headless ? '(HEADLESS — cadence is fiction)' : '(headed, real GPU)'} ===`);
line('backbuffer', `${out.backbuffer[0]}x${out.backbuffer[1]} (dpr ${out.dpr})`);
line('frames / speed', `${out.frames} @ ${out.speedKph} km/h`);
line('fps', `mean ${f2(out.fps.mean)}  p50 ${f2(out.fps.p50)}  p5 ${f2(out.fps.p5)}  min ${f2(out.fps.min)}`);
line('frame interval ms', `p50 ${f2(out.rafMs.p50)}  p95 ${f2(out.rafMs.p95)}  max ${f2(out.rafMs.max)}`);
line('one refresh ~', `${f2(out.refreshMs)} ms  (${Math.round(1000 / out.refreshMs)} Hz)`);
line('vsyncs per frame', out.quantaHist.map(([q, , p]) => `${q}x:${p}%`).join('  '));
line('cadence switches', `${out.quantaSwitchPct}% of frames change their vsync count`);
line('update ms', `mean ${f2(out.updMs.mean)}  p95 ${f2(out.updMs.p95)}  max ${f2(out.updMs.max)}`);
line('render ms (CPU)', `mean ${f2(out.renMs.mean)}  p95 ${f2(out.renMs.p95)}  max ${f2(out.renMs.max)}`);
if (out.gpuMs) line('render ms (GPU)', `mean ${f2(out.gpuMs.mean)}  p95 ${f2(out.gpuMs.p95)}  max ${f2(out.gpuMs.max)}`);
else line('render ms (GPU)', 'EXT_disjoint_timer_query_webgl2 unavailable');
line('JS over budget', `${out.cpuOverBudgetPct}% of frames exceed one refresh on the CPU alone`);
line('long frames', `${out.longFramePct}% took >1.5 refreshes`);
line('draw calls / tris', `${out.drawCalls} / ${out.triangles}  (${out.programs} programs)`);
if (out.heapMB) line('heap MB', `${f2(out.heapMB.start)} -> ${f2(out.heapMB.end)}, +${f2(out.heapMB.mbPerSec)} MB/s`);
line('car jerk px/f^2', `mean ${f2(out.carJerkPx.mean)}  p95 ${f2(out.carJerkPx.p95)}  max ${f2(out.carJerkPx.max)}`);
if (out.pacer) {
  line('governor', `${out.pacer.n} vsync/frame, scale ${out.pacer.scale}x, `
    + `target ${(1 / (out.pacer.n * out.pacer.period)).toFixed(1)} fps`);
}
line('page errors', String(out.errors));
if (errors.length) console.log(errors.slice(0, 5).join('\n'));

if (args.baseline) {
  const base = JSON.parse(await readFile(args.baseline, 'utf8'));
  console.log('\n--- against baseline ---');
  const cmp = (name, a, b, better = 'lower') => {
    const d = b - a;
    const mark = (better === 'lower' ? d < 0 : d > 0) ? 'better' : (d === 0 ? '=' : 'WORSE');
    console.log(`${name.padEnd(22)}${f2(a)} -> ${f2(b)}   ${mark}`);
  };
  cmp('fps mean', base.fps.mean, out.fps.mean, 'higher');
  cmp('cadence switch %', base.quantaSwitchPct, out.quantaSwitchPct);
  cmp('cpu p95 ms', base.cpuMs.p95, out.cpuMs.p95);
  if (base.gpuMs && out.gpuMs) cmp('gpu p95 ms', base.gpuMs.p95, out.gpuMs.p95);
  cmp('car jerk mean', base.carJerkPx.mean, out.carJerkPx.mean);
  cmp('long frame %', base.longFramePct, out.longFramePct);
}

if (args.json) {
  await writeFile(args.json, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${args.json}`);
}
