#!/usr/bin/env node
/**
 * WHAT A SMALLER SHADOW MAP ACTUALLY COSTS THE PICTURE.
 *
 * tools/gpu-breakdown.mjs measured the 4096x4096 sun shadow at 4.41 ms of a
 * 14.90 ms frame — 30% of the whole GPU budget, and the largest single item
 * left after the prop scatter was tiled. Dropping it to 2048 would buy back
 * enough to let the frame governor hold full resolution at 60 fps instead of
 * falling to 1x, which is a far better trade than halving every pixel in the
 * frame... IF the shadows still look right.
 *
 * renderer.js argues for 4k in a comment: at a +/-78..120 m fitted frustum it
 * gives 0.055 m per texel, "so contact points stay attached and the edges read
 * as deliberate hard graphics". That is a claim about the image, so settle it
 * with images rather than with an opinion: same preset, same frame, one
 * variable.
 *
 *   node tools/shadow-ab.mjs --base http://127.0.0.1:5230
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5230', preset: 'hero_alpine', out: 'shots/shadow-ab',
  sizes: [4096, 3072, 2048, 1536] };
for (let i = 0; i < av.length; i++) {
  if (av[i] === '--base') args.base = av[++i];
  else if (av[i] === '--preset') args.preset = av[++i];
  else if (av[i] === '--out') args.out = av[++i];
}
await mkdir(args.out, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('PAGE ERROR', String(e)));

// The capture preset renders a fixed number of fixed-step frames and then
// stops, so both shots are the identical instant of the identical world and
// the ONLY difference between the files is the shadow map size.
await page.goto(`${args.base}/?shot=${args.preset}&hud=0`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__SHOT_READY === true, null, { timeout: 120000 });

const rows = [];
for (const size of args.sizes) {
  const info = await page.evaluate(async (s) => {
    const g = window.__GAME;
    g.lights.sun.shadow.mapSize.set(s, s);
    g.lights.sun.shadow.map?.dispose();
    g.lights.sun.shadow.map = null;
    // The penumbra is expressed in metres and converted to texels, so it has to
    // be recomputed or the smaller map would also silently change the blur.
    g.lights._basisDirty = true;
    g.lights.follow(g.camera._focus);
    g.render();
    g.render();

    const gl = g.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    let ms = null;
    if (ext) {
      const out = [];
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        g.render();
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        for (let k = 0; k < 12; k++) {
          if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
          await new Promise((r) => requestAnimationFrame(r));
        }
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
          out.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        }
        gl.deleteQuery(q);
      }
      out.sort((a, b) => a - b);
      ms = out[Math.floor(out.length / 2)] ?? null;
    }
    return { ms, radius: g.lights.sun.shadow.radius,
             metresPerTexel: (2 * g.lights._half) / s };
  }, size);

  const file = `${args.out}/shadow-${size}.png`;
  await page.screenshot({ path: file });
  rows.push([size, info, file]);
  console.log(`${String(size).padStart(5)}  gpu ${info.ms == null ? '  n/a' : info.ms.toFixed(2)} ms`
    + `  ${info.metresPerTexel.toFixed(3)} m/texel  pcf radius ${info.radius.toFixed(1)}  -> ${file}`);
}

await writeFile(`${args.out}/index.json`, JSON.stringify(rows, null, 2));
await browser.close();
