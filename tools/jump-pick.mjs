#!/usr/bin/env node
/**
 * WHAT IS THAT THING ON SCREEN? — raycast a screenshot pixel back into the scene.
 *
 * The client reported "a stick sticking out in the middle of the bridge". A
 * defect you can only see in a PNG is useless until you know which module drew
 * it, and reading world geometry by eye off a 60-degree camera is guesswork.
 * This casts a ray through a given screen pixel of a `shoot.mjs` preset frame
 * and prints the hit object's ancestry, name, world position and bounding box.
 *
 *   node tools/jump-pick.mjs --base http://127.0.0.1:5220 --preset jump_alpine \
 *        --t 106.9 --px 1620 --py 300
 */
import { chromium } from 'playwright';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5173', preset: 'jump_alpine', t: null, w: 1920, h: 1080, pts: [] };
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--preset') args.preset = av[++i];
  else if (a === '--t') args.t = av[++i];
  else if (a === '--w') args.w = Number(av[++i]);
  else if (a === '--h') args.h = Number(av[++i]);
  else if (a === '--at') args.pts.push(av[++i].split(',').map(Number));
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: args.w, height: args.h } });
page.on('pageerror', (e) => console.error('PAGEERROR', String(e)));
const url = `${args.base}/?shot=${args.preset}&hud=0` + (args.t ? `&t=${args.t}` : '');
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 180000 });

const res = await page.evaluate(async ({ pts, w, h }) => {
  const g = window.__GAME;
  const THREE = window.THREE ?? (await import('/node_modules/three/build/three.module.js'));
  const cam = g.camera.camera ?? g.camera.cam ?? g.camera;
  const rc = new THREE.Raycaster();
  const out = [];
  for (const [px, py] of pts) {
    const ndc = new THREE.Vector2((px / w) * 2 - 1, -(py / h) * 2 + 1);
    rc.setFromCamera(ndc, cam);
    const hits = rc.intersectObject(g.scene, true).filter((x) => x.object.visible);
    const rows = hits.slice(0, 4).map((hit) => {
      const chain = [];
      for (let o = hit.object; o; o = o.parent) chain.push(o.name || o.type);
      const box = new THREE.Box3().setFromObject(hit.object);
      return {
        px, py,
        chain: chain.reverse().join(' > '),
        point: [+hit.point.x.toFixed(2), +hit.point.y.toFixed(2), +hit.point.z.toFixed(2)],
        instanceId: hit.instanceId ?? null,
        size: [+(box.max.x - box.min.x).toFixed(2), +(box.max.y - box.min.y).toFixed(2), +(box.max.z - box.min.z).toFixed(2)],
        boxY: [+box.min.y.toFixed(2), +box.max.y.toFixed(2)],
      };
    });
    out.push(...rows);
  }
  return { cam: [+cam.position.x.toFixed(1), +cam.position.y.toFixed(1), +cam.position.z.toFixed(1)], out };
}, args);

console.log('camera at', res.cam.join(', '));
for (const r of res.out) {
  console.log(`(${r.px},${r.py}) -> ${r.chain}`);
  console.log(`        hit ${r.point.join(', ')}  inst=${r.instanceId}  objSize ${r.size.join(' x ')}  y ${r.boxY.join('..')}`);
}
await browser.close();
