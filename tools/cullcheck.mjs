#!/usr/bin/env node
/**
 * IS EVERY PROP INSIDE THE SPHERE THAT DECIDES WHETHER TO DRAW IT?
 *
 * The prop scatter is split into per-tile InstancedMeshes so that three's
 * frustum test can throw away the ~99% of the map that is off screen (see the
 * long note in world/props.js). Each of those meshes carries a bounding sphere
 * we compute ourselves rather than letting three walk every instance matrix on
 * the frame the tile first appears.
 *
 * That sphere is load-bearing in two different ways, and getting it too SMALL
 * fails silently in both:
 *   - WebGLRenderer culls the mesh against it, so props would pop in and out
 *     at the edge of frame;
 *   - InstancedMesh.raycast REJECTS against it before testing any instance, so
 *     ground probes, collision queries and every audit in dev/probe.js would
 *     stop seeing props that are really standing there.
 *
 * Neither shows up as an error. So check the invariant directly: for every
 * instance of every tile, the instance's own transformed bounds must lie inside
 * the tile's declared sphere. Also reports how much slack there is — a sphere
 * that is far too big is correct but culls nothing, which is the other way to
 * get this wrong.
 *
 *   node tools/cullcheck.mjs --base http://127.0.0.1:5230
 */
import { chromium } from 'playwright';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5230' };
for (let i = 0; i < av.length; i++) if (av[i] === '--base') args.base = av[++i];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', String(e)));
await page.goto(args.base, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GAME?.props, null, { timeout: 120000 });

const r = await page.evaluate(() => {
  const g = window.__GAME;
  const out = { meshes: 0, instances: 0, violations: [], worstOver: 0,
                slack: [], noSphere: 0, tris: 0 };
  // Read the instance matrices straight out of the attribute buffer rather than
  // through getMatrixAt: three's Matrix4 is column-major, so the translation is
  // elements 12,13,14 and each basis column's length is that axis's scale.
  // Going through the buffer also avoids allocating 241,030 Matrix4 objects.
  for (const o of g.props.group.children) {
    if (!o.isInstancedMesh) continue;
    out.meshes++;
    const geo = o.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const gc = geo.boundingSphere.center, gr = geo.boundingSphere.radius;
    const sph = o.boundingSphere;
    if (!sph) { out.noSphere++; continue; }
    out.tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3 * o.count;
    let worst = -Infinity;
    const buf = o.instanceMatrix.array;
    for (let i = 0; i < o.count; i++) {
      out.instances++;
      const mat = buf.subarray(i * 16, i * 16 + 16);
      const sx = Math.hypot(mat[0], mat[1], mat[2]);
      const sy = Math.hypot(mat[4], mat[5], mat[6]);
      const sz = Math.hypot(mat[8], mat[9], mat[10]);
      const s = Math.max(sx, sy, sz);
      // Where this instance's geometry centre ends up, and how far its surface
      // reaches from there.
      const cx = mat[0] * gc.x + mat[4] * gc.y + mat[8] * gc.z + mat[12];
      const cy = mat[1] * gc.x + mat[5] * gc.y + mat[9] * gc.z + mat[13];
      const cz = mat[2] * gc.x + mat[6] * gc.y + mat[10] * gc.z + mat[14];
      const reach = Math.hypot(cx - sph.center.x, cy - sph.center.y, cz - sph.center.z) + gr * s;
      const over = reach - sph.radius;
      if (over > worst) worst = over;
      if (over > 1e-4) {
        if (out.violations.length < 8) {
          out.violations.push({ name: o.name, i, over: +over.toFixed(3),
                                reach: +reach.toFixed(2), radius: +sph.radius.toFixed(2) });
        }
        if (over > out.worstOver) out.worstOver = over;
      }
    }
    if (worst > -Infinity) out.slack.push(-worst / sph.radius);
  }
  out.slack.sort((a, b) => a - b);
  out.medianSlackPct = out.slack.length
    ? +(100 * out.slack[Math.floor(out.slack.length / 2)]).toFixed(1) : 0;
  delete out.slack;
  return out;
});

await browser.close();

console.log(`meshes           ${r.meshes}`);
console.log(`instances        ${r.instances.toLocaleString()}`);
console.log(`triangles        ${Math.round(r.tris).toLocaleString()}`);
console.log(`without a sphere ${r.noSphere}`);
console.log(`median slack     ${r.medianSlackPct}%  (sphere bigger than it needs to be)`);
if (r.violations.length) {
  console.log(`\nFAIL — ${r.violations.length}+ instances outside their tile's sphere, worst by ${r.worstOver.toFixed(3)} m`);
  for (const v of r.violations) console.log('  ', JSON.stringify(v));
  process.exit(1);
}
console.log('\nPASS — every instance lies inside the sphere used to cull and to raycast it.');
