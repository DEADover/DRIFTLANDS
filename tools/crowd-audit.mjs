#!/usr/bin/env node
/**
 * DOES THE CROWD OBEY THE CLIENT'S ONE RULE?
 *
 * "чтобы они стояли за железными заборами" — spectators stand behind METAL
 * guardrails and nowhere else. This is an independent check of that, written
 * without reference to the module's own test, because a builder's own harness
 * shares the builder's assumptions: if it decided a spectator is "behind" the
 * rail using the same sign convention that placed it there, the test cannot
 * fail. So everything here is derived from the world instead — the actual
 * instance matrices in the scene graph, the actual barrier list, and the actual
 * drawn ground under each pair of feet.
 *
 * Checks, in the order they would embarrass us:
 *   1. every spectator is near a segment with kind === 'guard'  (the rule)
 *   2. none of them is on the ROAD side of that segment          (the rule)
 *   3. none is standing in the carriageway                       (the rule)
 *   4. none floats above or sinks into the ground it stands on
 *   5. none intersects the guardrail it is standing behind
 *   6. what it costs: meshes, draw calls, triangles, update() time, allocation
 *
 *   node tools/crowd-audit.mjs --base http://127.0.0.1:5230
 */
import { chromium } from 'playwright';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5230', near: 6.0 };
for (let i = 0; i < av.length; i++) {
  if (av[i] === '--base') args.base = av[++i];
  else if (av[i] === '--near') args.near = Number(av[++i]);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(args.base, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GAME?.crowd, null, { timeout: 120000 });

const r = await page.evaluate(async (near) => {
  const g = window.__GAME;
  const crowd = g.crowd;
  const segs = g.roads.barriers.segments;
  const guards = segs.filter((s) => s.kind === 'guard');
  const fences = segs.filter((s) => s.kind !== 'guard');

  // ---- where each spectator actually is, read from the instance matrices ----
  const mesh = crowd.group.children.find((o) => o.isInstancedMesh);
  const pos = [];
  if (mesh) {
    const buf = mesh.instanceMatrix.array;
    for (let i = 0; i < mesh.count; i++) {
      const m = i * 16;
      pos.push([buf[m + 12], buf[m + 13], buf[m + 14]]);
    }
  }

  /** Distance from p to the finite segment, plus which side of it p is on. */
  const toSeg = (p, s) => {
    const dx = p[0] - s.x, dz = p[2] - s.z;
    const along = Math.max(-s.half, Math.min(s.half, dx * s.dx + dz * s.dz));
    const px = s.x + s.dx * along, pz = s.z + s.dz * along;
    // Segment normal (dz, -dx): the sign of this says which side.
    const side = (p[0] - s.x) * s.dz - (p[2] - s.z) * s.dx;
    return { d: Math.hypot(p[0] - px, p[2] - pz), side, along };
  };

  const out = {
    spectators: pos.length,
    guardBays: guards.length, fenceBays: fences.length,
    nearestIsGuard: 0, nearestIsFence: 0, orphan: 0,
    onRoadSide: 0, onRoad: 0, insideRail: 0,
    worstFloat: 0, worstSink: 0, floaters: 0, sunk: 0,
    examples: [],
  };

  for (const p of pos) {
    // Nearest bay of ANY kind. Asking "is there a guard nearby" would pass a
    // spectator standing at a timber fence that happens to be 6 m from a
    // guardrail; the honest question is which barrier they are actually at.
    let best = null, bestD = Infinity;
    for (const s of segs) {
      const t = toSeg(p, s);
      if (t.d < bestD) { bestD = t.d; best = { s, ...t }; }
    }
    if (!best || bestD > near) { out.orphan++; continue; }
    if (best.s.kind === 'guard') out.nearestIsGuard++; else out.nearestIsFence++;

    // Which side is the ROAD on? Take the road centre nearest this bay and use
    // the same normal, so "behind" is defined by the world and not by whatever
    // convention the builder used.
    const roadSide = (best.s.x - (best.s.x - best.s.dz * 10)) * 0 + 0; // placeholder
    void roadSide;
    // Probe 3 m either side of the bay and ask the road network which one is
    // carriageway. That is ground truth and needs no convention at all.
    const nx = best.s.dz, nz = -best.s.dx;
    const aOn = g.roads.isOnRoad?.(best.s.x + nx * 3.5, best.s.z + nz * 3.5) === true;
    const bOn = g.roads.isOnRoad?.(best.s.x - nx * 3.5, best.s.z - nz * 3.5) === true;
    if (aOn !== bOn) {
      const roadPositive = aOn;             // +normal points at the road
      const specPositive = best.side > 0;
      if (roadPositive === specPositive) {
        out.onRoadSide++;
        if (out.examples.length < 6) {
          out.examples.push({ why: 'road side', at: [Math.round(p[0]), Math.round(p[2])] });
        }
      }
    }
    if (g.roads.isOnRoad?.(p[0], p[2]) === true) out.onRoad++;
    // A guardrail is about 0.5 m deep; anyone closer than that is inside it.
    if (best.s.kind === 'guard' && bestD < 0.75) out.insideRail++;

    // ---- feet against the ground actually drawn under them ----
    const ground = g.groundAt(p[0], p[2]).height;
    const gap = p[1] - ground;
    if (gap > 0.12) { out.floaters++; if (gap > out.worstFloat) out.worstFloat = gap; }
    if (gap < -0.12) { out.sunk++; if (-gap > out.worstSink) out.worstSink = -gap; }
  }

  // ---------------------------------------------------------------- the cost
  const before = g.renderer.info.render.calls;
  g.render();
  const withCrowd = { calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles };
  crowd.group.visible = false;
  g.render();
  const without = { calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles };
  crowd.group.visible = true;
  void before;

  // update() cost and whether it allocates. 600 calls with no new objects
  // should leave the heap flat to within noise.
  const heap0 = performance.memory?.usedJSHeapSize ?? 0;
  const t0 = performance.now();
  for (let i = 0; i < 600; i++) {
    crowd.update(1 / 60, { position: g.vehicle.position, speed: g.vehicle.speed });
  }
  const perCall = (performance.now() - t0) / 600;
  const heapDelta = ((performance.memory?.usedJSHeapSize ?? 0) - heap0) / 600;

  return {
    ...out,
    stats: crowd.stats,
    meshes: crowd.group.children.filter((o) => o.isInstancedMesh).length,
    drawCalls: withCrowd.calls - without.calls,
    triangles: withCrowd.tris - without.tris,
    updateMs: perCall,
    bytesPerUpdate: heapDelta,
  };
}, args.near);

await browser.close();

const line = (k, v) => console.log(k.padEnd(28) + v);
console.log('\n=== CROWD AUDIT (independent of the module\'s own test) ===');
line('spectators', r.spectators.toLocaleString());
line('guard bays / timber bays', `${r.guardBays} / ${r.fenceBays}`);
console.log('\n-- the client\'s rule --');
line('nearest bay is STEEL', `${r.nearestIsGuard}  (${(100 * r.nearestIsGuard / Math.max(1, r.spectators)).toFixed(1)}%)`);
line('nearest bay is TIMBER', `${r.nearestIsFence}   <- must be 0`);
line('no bay within range', `${r.orphan}   <- must be 0`);
line('on the ROAD side', `${r.onRoadSide}   <- must be 0`);
line('standing on the road', `${r.onRoad}   <- must be 0`);
line('inside the rail itself', `${r.insideRail}   <- must be 0`);
console.log('\n-- standing on the ground --');
line('floating >0.12 m', `${r.floaters}  worst ${r.worstFloat.toFixed(3)} m`);
line('sunk >0.12 m', `${r.sunk}  worst ${r.worstSink.toFixed(3)} m`);
console.log('\n-- what it costs --');
line('instanced meshes', r.meshes);
line('draw calls added', r.drawCalls);
line('triangles added', r.triangles.toLocaleString());
line('update() per call', `${r.updateMs.toFixed(4)} ms`);
line('heap per update()', `${r.bytesPerUpdate.toFixed(1)} bytes`);
line('module self-report', JSON.stringify(r.stats));
if (errors.length) console.log('\nPAGE ERRORS\n' + errors.slice(0, 4).join('\n'));

const fail = r.nearestIsFence || r.orphan || r.onRoadSide || r.onRoad || r.insideRail;
console.log(fail ? '\nFAIL — the placement rule is broken above.' : '\nPASS — every spectator is behind steel.');
process.exit(fail ? 1 : 0);
