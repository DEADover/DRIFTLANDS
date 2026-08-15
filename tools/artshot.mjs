#!/usr/bin/env node
/**
 * THE BEFORE/AFTER FOR AN ART PASS.
 *
 * The client's note, and it is a better diagnosis than the one it replaced:
 * the world is too ANGULAR, the animals are geometric solids rather than
 * animals, and the water reads as separate polygons of different blues rather
 * than as water. Measured, the budget says why — 6.9M triangles go to flowers
 * and grass at 1-3 px on screen, and all 346 animals together get 33,344.
 *
 * So this captures the three frames that answer those three complaints, from a
 * given build, into a named directory. Run it once before the work and once
 * after and the argument is settled by a picture rather than by a claim.
 *
 *   node tools/artshot.mjs --out shots/art-before
 *   node tools/artshot.mjs --out shots/art-after --base http://127.0.0.1:5201
 *
 * The presets are fixed-step captures, so the same preset at the same warmup is
 * the same instant of the same world every time. The only variable is the code.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5230', out: 'shots/art', width: 1280, height: 720 };
for (let i = 0; i < av.length; i++) {
  if (av[i] === '--base') args.base = av[++i];
  else if (av[i] === '--out') args.out = av[++i];
}
await mkdir(args.out, { recursive: true });

/**
 * Each entry is a full frame plus one detail crop, because the complaints live
 * at two different scales: "the world is angular" is visible in the frame, and
 * "the deer is a cylinder" is not.
 *   crop: [x, y, w, h] in the 2560x1440 shot, and a zoom factor.
 *
 * THE CROP RECTS ARE CHOSEN BY LOOKING AT THE FRAME, not guessed. The first
 * version of this file guessed, and `lake_bridge` came out framing trees and
 * road with no water in it — a water audit that could not see water.
 */
const SHOTS = [
  { preset: 'hero_alpine', crop: [980, 300, 700, 450], zoom: 2.6, what: 'trees, rocks, road' },
  { preset: 'lake_bridge', crop: [1700, 450, 700, 450], zoom: 2.6, what: 'water surface' },
  { preset: 'wildlife', crop: [900, 480, 700, 450], zoom: 2.6, what: 'animal silhouettes' },
];

/**
 * Crop from the WRITTEN PNG, not from the live canvas.
 *
 * This tool used to call `drawImage(canvas, ...)` in the page. A WebGL drawing
 * buffer is cleared once it has been composited unless the context was created
 * with `preserveDrawingBuffer`, and this one is not — so the readback produced
 * three blank white images, and the tool reported success on all three. The
 * "before" capture for a whole art round was taken with it, and the blank files
 * were only noticed because a builder went looking at them.
 *
 * page.screenshot() reads the composited page rather than the GL buffer, so the
 * full frames were always sound. Cropping those is both correct and free.
 */
async function cropPng(browser, srcPath, outPath, [x, y, w, h], zoom) {
  const data = 'data:image/png;base64,' + (await readFile(srcPath)).toString('base64');
  const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
  const url = await page.evaluate(async ({ data, x, y, w, h, zoom }) => {
    const img = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = data; });
    const c = document.createElement('canvas');
    c.width = Math.round(w * zoom); c.height = Math.round(h * zoom);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }, { data, x, y, w, h, zoom });
  await page.close();
  await writeFile(outPath, Buffer.from(url.split(',')[1], 'base64'));
  // A crop that is one flat colour is almost always a framing or readback bug,
  // and it is exactly the failure that went unnoticed last time. Say so.
  const buf = Buffer.from(url.split(',')[1], 'base64');
  return buf.length;
}

const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'],
});
const summary = [];

for (const s of SHOTS) {
  const page = await browser.newPage({
    viewport: { width: args.width, height: args.height }, deviceScaleFactor: 2,
  });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`${args.base}/?shot=${s.preset}&hud=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__SHOT_READY === true, null, { timeout: 420000 });

  const full = `${args.out}/${s.preset}.png`;
  await page.screenshot({ path: full });

  const info = await page.evaluate(() => ({ ...window.__SHOT_INFO }));
  await page.close();

  const bytes = await cropPng(browser, full, `${args.out}/${s.preset}-detail.png`, s.crop, s.zoom);
  if (bytes < 4000) {
    console.log(`  !! ${s.preset}-detail.png is ${bytes} bytes — almost certainly blank. `
      + `Check the crop rect and the readback path.`);
  }

  summary.push({ preset: s.preset, what: s.what, triangles: info.triangles,
                 drawCalls: info.drawCalls, errors: errs.length });
  console.log(`${s.preset.padEnd(14)} ${String(info.triangles).padStart(9)} tris  `
    + `${String(info.drawCalls).padStart(4)} calls  ${errs.length ? 'ERRORS' : 'ok'}  -> ${full}`);
}

await writeFile(`${args.out}/summary.json`, JSON.stringify(summary, null, 2));
await browser.close();
