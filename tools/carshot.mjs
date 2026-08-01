#!/usr/bin/env node
/**
 * THE CAR, CLOSE ENOUGH TO JUDGE.
 *
 * The capture presets cannot get closer than about 20 m because the chase
 * camera's near plane is 14 m — it is tuned for a depth buffer that post.js
 * reconstructs view-space position from, and moving it is not this module's
 * call. So this tool boots a preset, waits for the car to settle, and only THEN
 * pushes the near plane in and the camera down onto the car for a single frame.
 * Nothing it changes survives the render.
 *
 *   node tools/carshot.mjs --base http://127.0.0.1:5224 --out shots/car
 *   node tools/carshot.mjs --pitch 20 --dist 8 --yaw 0.9
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const av = process.argv.slice(2);
const args = {
  base: 'http://127.0.0.1:5173', preset: 'car_plan', out: 'shots/car',
  w: 1600, h: 1200, views: null,
};
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--preset') args.preset = av[++i];
  else if (a === '--out') args.out = av[++i];
  else if (a === '--w') args.w = +av[++i];
  else if (a === '--h') args.h = +av[++i];
  else if (a === '--views') args.views = av[++i];
  // Force the worst pose tools/wheelbox.mjs found, so the residual
  // tyre-in-bodywork it reports can be LOOKED AT rather than argued about.
  else if (a === '--lean') args.lean = Number(av[++i] ?? 0.29);
  else if (a === '--drop') args.drop = Number(av[++i] ?? -0.30);
}

// pitch (deg from horizontal), distance (m), yaw (rad, world-fixed like the game)
const VIEWS = {
  plan: { pitch: 52, dist: 9.5, yaw: Math.PI * 0.25, label: 'the in-game angle, magnified' },
  three_quarter: { pitch: 24, dist: 9.0, yaw: Math.PI * 0.62, label: 'front three-quarter' },
  rear_quarter: { pitch: 22, dist: 9.0, yaw: -Math.PI * 0.42, label: 'rear three-quarter' },
  side: { pitch: 8, dist: 10.5, yaw: Math.PI * 0.5, label: 'flank — arch gap and sills' },
  top: { pitch: 86, dist: 9.0, yaw: Math.PI * 0.25, label: 'plan silhouette' },
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: args.w, height: args.h } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${args.base}/?shot=${args.preset}&hud=0`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 240000 });

await mkdir(args.out, { recursive: true });
const wanted = args.views ? args.views.split(',') : Object.keys(VIEWS);

for (const name of wanted) {
  const v = VIEWS[name];
  if (!v) { console.log(`  ? unknown view ${name}`); continue; }
  await page.evaluate(({ pitch, dist, yaw, lean, drop }) => {
    const g = window.__GAME;
    if (lean !== undefined || drop !== undefined) {
      const v = g.carView;
      if (lean !== undefined) v.body.rotation.x = lean;
      if (drop !== undefined) v.body.position.y = drop;
      v.root.updateMatrixWorld(true);
    }
    // The ChaseCamera's own update() is a spring solve with framing clamps tuned
    // for a 78 m stand-off; at 9 m it puts the car off the bottom of frame. This
    // places the camera by hand instead. Nothing here runs game.update(), so the
    // car and the world stay exactly where the preset left them.
    const cam = g.camera.camera;
    const car = g.carView.root.position;
    const fy = car.y + 0.72;
    const p = (pitch * Math.PI) / 180;
    cam.position.set(
      car.x + Math.cos(p) * Math.cos(yaw) * dist,
      fy + Math.sin(p) * dist,
      car.z + Math.cos(p) * Math.sin(yaw) * dist,
    );
    cam.lookAt(car.x, fy, car.z);
    cam.near = 0.4;
    cam.fov = 30;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    // post.js reads this to decide what counts as "the distance" for its blur.
    cam.userData.focusDistance = dist;
    g.render(); g.render();
  }, { ...v, lean: args.lean, drop: args.drop });
  const buf = await page.screenshot({ type: 'png' });
  await writeFile(path.join(args.out, `${name}.png`), buf);
  console.log(`  ✓ ${name.padEnd(14)} ${v.label}`);
}

if (errors.length) {
  console.log(`PAGE ERRORS (${errors.length}):`);
  for (const e of errors.slice(0, 6)) console.log(`  ${e.slice(0, 200)}`);
}
await browser.close();
console.log(`→ ${wanted.length} views in ${args.out}`);
process.exit(errors.length ? 1 : 0);
