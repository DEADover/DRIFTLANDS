#!/usr/bin/env node
/**
 * A CLOSE LOOK AT AN ANIMAL, FRAMED BY FINDING ONE.
 *
 * The `wildlife` capture preset was written to frame a herd beside the road.
 * The world has moved under it since: the frame it produces now is mostly empty
 * carriageway with a couple of unidentifiable specks at the edge. That is the
 * same failure as the `jump_alpine` preset, which no longer frames the jump —
 * a preset is a fixed camera pointed at a world that keeps changing, and it
 * rots silently.
 *
 * So do not aim a camera at where an animal used to be. Ask the game where its
 * animals ARE, put the camera on one, and render that. The world is
 * deterministic from its seed, so "the first deer of species N" is the same
 * deer in every run, and a before/after is a fair comparison.
 *
 *   node tools/faunashot.mjs --out shots/fauna-before
 *   node tools/faunashot.mjs --out shots/fauna-after --base http://127.0.0.1:5203
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5230', out: 'shots/fauna', zoom: 14, n: 5 };
for (let i = 0; i < av.length; i++) {
  if (av[i] === '--base') args.base = av[++i];
  else if (av[i] === '--out') args.out = av[++i];
  else if (av[i] === '--zoom') args.zoom = Number(av[++i]);
  else if (av[i] === '--n') args.n = Number(av[++i]);
}
await mkdir(args.out, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

await page.goto(args.base, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GAME?.animals, null, { timeout: 180000 });

/**
 * FREEZE THE SIMULATION FIRST.
 *
 * This is an interactive page, so main.js is running a live rAF loop. Every
 * frame it calls game.update(), which drives the chase camera back to the car
 * and re-renders — so a camera placed from the outside is overwritten before
 * the screenshot is taken. Symptom: five different species, five identical
 * pictures of the start line. Silencing update() leaves render() drawing
 * whatever camera we last set.
 *
 * It has to happen BEFORE the positions are read, too: the animals walk, so a
 * position sampled from a running world is stale by the time the camera gets
 * there, and the shot frames the hillside the deer was standing on.
 */
await page.evaluate(() => { window.__GAME.update = () => {}; });

// One entry per distinct instanced mesh in the fauna group — that is one per
// species per variant, which is exactly the set worth looking at.
const species = await page.evaluate(() => {
  const g = window.__GAME;
  const out = [];
  for (const o of g.animals.group.children) {
    if (!o.isInstancedMesh || !o.count) continue;
    const geo = o.geometry;
    const idx = geo.index ? geo.index.count : geo.attributes.position.count;
    const buf = o.instanceMatrix.array;
    out.push({
      name: o.name || 'unnamed',
      count: o.count,
      trisEach: Math.round(idx / 3),
      // First instance's translation: deterministic from the seed.
      at: [buf[12], buf[13], buf[14]],
    });
  }
  return out;
});

console.log('fauna in this world:');
for (const s of species) {
  console.log(`  ${s.name.padEnd(18)} x${String(s.count).padStart(4)}  ${s.trisEach} tris each`);
}

const shots = species.slice(0, args.n);
for (const s of shots) {
  await page.evaluate(({ at, zoom }) => {
    const g = window.__GAME;
    document.getElementById('title')?.remove();
    document.getElementById('ui')?.style.setProperty('display', 'none');
    /**
     * Place the PERSPECTIVE CAMERA directly, not the chase camera.
     *
     * Driving ChaseCamera to a point does not put that point in the middle of
     * the frame: it is a framing rig, with a velocity lead, a drift push and an
     * NDC framing box that deliberately push the subject off centre. Asked to
     * look at a deer it produced a wide shot of a forest with no deer in it.
     * For an inspection shot we want the lens pointed at the thing, so set the
     * camera's own transform and leave the rig out of it. Same pitch as the
     * game (52 deg) so the silhouette is read the way a player reads it.
     */
    const cam = g.camera.camera;
    const pitch = g.camera.pitch, yaw = g.camera.yaw;
    const d = zoom;
    /**
     * PULL THE NEAR PLANE IN FIRST. The chase camera runs near=14, because post.js
     * reconstructs view-space position from this depth buffer and precision there
     * is worth more than headroom when the lens always sits 78 m out. Put the
     * camera 14 m from a deer and the deer is exactly ON the near plane and is
     * clipped away — which is what happened: two runs of this tool produced
     * beautifully framed pictures of a forest and of a start line with no animal
     * in either.
     */
    cam.near = 0.5;
    cam.updateProjectionMatrix();
    const horiz = Math.cos(pitch) * d, vert = Math.sin(pitch) * d;
    cam.position.set(at[0] + Math.cos(yaw) * horiz, at[1] + vert, at[2] + Math.sin(yaw) * horiz);
    cam.lookAt(at[0], at[1] + 0.6, at[2]);
    cam.updateMatrixWorld();
    cam.userData.focusDistance = d;
    g.lights.follow({ x: at[0], y: at[1], z: at[2] });
    g.post.setCamera?.(cam);
    g.post.render();
    g.post.render();
  }, { at: s.at, zoom: args.zoom });

  const file = `${args.out}/${s.name}.png`;
  await page.screenshot({ path: file });
  console.log(`  -> ${file}   (at ${s.at.map(v=>Math.round(v)).join(', ')})`);
}

await writeFile(`${args.out}/summary.json`, JSON.stringify({ species, errors: errs }, null, 2));
if (errs.length) console.log('PAGE ERRORS:', errs.slice(0, 3));
await browser.close();
