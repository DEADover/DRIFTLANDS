#!/usr/bin/env node
/**
 * WHERE THE 28 MILLISECONDS GO
 * -----------------------------
 * tools/frametime.mjs established the shape of the problem on the real
 * machine: JS costs 1.4 ms a frame and the GPU costs 28, so the game presents
 * at 39 fps on a 120 Hz display and 44% of frames change how many refresh
 * intervals they occupy. That alternation is the "jerky camera" — the camera
 * maths is not involved at all.
 *
 * This tool takes the same live page apart. It measures GPU time for the frame
 * with one thing changed at a time, using the same timer-query path, so each
 * line is a real before/after on real hardware rather than an opinion about
 * which effect is expensive.
 *
 *   node tools/gpu-breakdown.mjs --base http://127.0.0.1:5230
 */
import { chromium } from 'playwright';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5230', width: 1512, height: 900, dpr: 2, frames: 90 };
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--dpr') args.dpr = Number(av[++i]);
  else if (a === '--frames') args.frames = Number(av[++i]);
}

const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({
  viewport: { width: args.width, height: args.height }, deviceScaleFactor: args.dpr,
});
await page.goto(args.base, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GAME?.roads, null, { timeout: 60000 });
await page.click('#play');

// A GPU timer harness that renders N frames back to back and returns the median
// GPU millisecond count. Installed once; every scenario below calls it.
await page.evaluate(() => {
  const g = window.__GAME;
  const gl = g.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  window.__HASEXT = !!ext;

  window.__measure = async (frames) => {
    const out = [];
    for (let i = 0; i < frames; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      g.render();
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      // Let the query land: spin frames until it is available.
      for (let k = 0; k < 12; k++) {
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)
          && !gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        out.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      }
      gl.deleteQuery(q);
    }
    out.sort((a, b) => a - b);
    const info = g.renderer.info.render;
    return { ms: out[Math.floor(out.length / 2)] ?? 0, n: out.length,
             calls: info.calls, tris: info.triangles };
  };
});

if (!(await page.evaluate(() => window.__HASEXT))) {
  console.log('EXT_disjoint_timer_query_webgl2 unavailable — cannot attribute GPU time.');
  await browser.close();
  process.exit(1);
}

// ---------------------------------------------------- what is in the scene
const census = await page.evaluate(() => {
  const g = window.__GAME;
  const rows = [];
  const bucket = new Map();
  g.scene.traverse((o) => {
    const geo = o.geometry;
    if (!geo || !o.visible) return;
    const idx = geo.index ? geo.index.count : (geo.attributes.position?.count ?? 0);
    const per = idx / 3;
    const n = o.isInstancedMesh ? o.count : 1;
    const tris = per * n;
    // Attribute it to the nearest named ancestor: that is the module that
    // built it, which is the unit a fix would be made in.
    let named = o, hops = 0;
    while (named && !named.name && hops < 6) { named = named.parent; hops++; }
    const key = named?.name || o.type;
    const b = bucket.get(key) ?? { tris: 0, objs: 0, inst: 0 };
    b.tris += tris; b.objs++; if (o.isInstancedMesh) b.inst += o.count;
    bucket.set(key, b);
  });
  for (const [k, v] of bucket) rows.push([k, v.tris, v.objs, v.inst]);
  rows.sort((a, b) => b[1] - a[1]);
  const light = g.lights?.sun ?? null;
  return {
    rows: rows.slice(0, 16),
    total: rows.reduce((s, r) => s + r[1], 0),
    shadow: light?.shadow
      ? { size: [light.shadow.mapSize.width, light.shadow.mapSize.height],
          type: g.renderer.shadowMap.type, auto: g.renderer.shadowMap.autoUpdate }
      : null,
    pixelRatio: g.renderer.getPixelRatio(),
    drawing: g.renderer.getDrawingBufferSize(new (g.camera.camera.position.constructor)()),
  };
});

console.log('\n=== SCENE CENSUS (triangles actually in the scene graph) ===');
console.log('group'.padEnd(26) + 'triangles'.padStart(12) + 'objects'.padStart(9) + 'instances'.padStart(11));
for (const [k, t, o, i] of census.rows) {
  console.log(k.padEnd(26) + Math.round(t).toLocaleString().padStart(12)
    + String(o).padStart(9) + (i ? String(i) : '-').padStart(11));
}
console.log('TOTAL'.padEnd(26) + Math.round(census.total).toLocaleString().padStart(12));
console.log(`shadow map ${census.shadow ? census.shadow.size.join('x') : 'none'}`
  + `  autoUpdate=${census.shadow?.auto}  pixelRatio=${census.pixelRatio}`);

// ------------------------------------------------------------- scenarios
//
// Cumulative on purpose: each row turns one more thing off and the DELTA
// column is that thing's cost. Turning each off in isolation would double-count
// anything two effects share (they both pay for the same overdraw).
//
// Shipped as source and rebuilt with `new Function` in the page, because a
// playwright `evaluate` argument cannot carry a closure.
const scale = (p) => `g => {
  g.renderer.setPixelRatio(${p});
  const s = g.renderer.getSize({ set(x, y) { this.x = x; this.y = y; return this; } });
  g.post.setSize(s.x, s.y);
}`;

const scenarios = [
  ['baseline (pixelRatio 2)', 'g => {}'],
  ['shadow map 4096 -> 2048',
    'g => { g.lights.sun.shadow.mapSize.set(2048, 2048); g.lights.sun.shadow.map?.dispose(); g.lights.sun.shadow.map = null; }'],
  ['+ no post (scene straight to canvas)',
    `g => {
      const cam = g.camera.camera;
      g.render = () => { g.renderer.setRenderTarget(null); g.renderer.render(g.scene, cam); };
    }`],
  ['+ pixelRatio 1.5', scale(1.5)],
  ['+ pixelRatio 1.0', scale(1)],
  ['-- from here: scene cost only --', 'g => {}'],
  ['+ props hidden', 'g => { g.props.group.visible = false; }'],
];

const legacy = [
  ['pixelRatio 1 (a quarter of the pixels)', scale(1)],
  ['+ shadows off',
    `g => {
      g.renderer.shadowMap.enabled = false;
      g.scene.traverse(o => { if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) m.needsUpdate = true;
      } });
    }`],
  ['+ no post (scene straight to canvas)',
    `g => {
      const cam = g.camera.camera;
      g.render = () => { g.renderer.setRenderTarget(null); g.renderer.render(g.scene, cam); };
    }`],
  ['+ props hidden', 'g => { g.props.group.visible = false; }'],
  ['+ terrain hidden', 'g => { g.terrain.mesh.visible = false; }'],
  ['+ roads hidden', 'g => { g.roads.group.visible = false; }'],
];
void legacy;

/**
 * WARM UP BEFORE THE FIRST SCENARIO — this tool lied once without it.
 *
 * The first measurement used to be taken seconds after the world was built,
 * while shader programs were still compiling and the driver was still uploading
 * geometry. It read 14.90 ms; the second scenario read 10.50 and the 4.41 ms
 * difference was credited to the change made between them (a smaller shadow
 * map). Interleaving the two settings afterwards showed the shadow map costs
 * nothing measurable in this scene — the whole "saving" was the page settling
 * down. A cumulative harness attributes every drift to whatever it happened to
 * change, so the drift has to be spent before the first row is read.
 */
await page.waitForTimeout(6000);
await page.evaluate((n) => window.__measure(n), Math.min(60, args.frames));

console.log('\n=== GPU TIME, ONE MORE THING OFF PER ROW ===');
console.log('scenario'.padEnd(40) + 'gpu ms'.padStart(9) + 'delta'.padStart(9)
  + 'calls'.padStart(8) + 'tris drawn'.padStart(14));
let prev = null;
for (const [name, src] of scenarios) {
  await page.evaluate((s) => { new Function('return ' + s)()(window.__GAME); }, src);
  const r = await page.evaluate((n) => window.__measure(n), args.frames);
  const delta = prev == null ? '' : `${r.ms - prev >= 0 ? '+' : ''}${(r.ms - prev).toFixed(2)}`;
  console.log(name.padEnd(40) + r.ms.toFixed(2).padStart(9) + delta.padStart(9)
    + String(r.calls).padStart(8) + r.tris.toLocaleString().padStart(14));
  prev = r.ms;
}

await browser.close();
