#!/usr/bin/env node
/**
 * THE CROWD, AS NUMBERS
 * ---------------------
 * Boots the real build headless and asks the questions the client's rule turns
 * into. Every one of them is a count, not an impression:
 *
 *   · is every spectator behind a METAL guardrail (kind === 'guard')?
 *   · is any of them on the road side of it?
 *   · does any of them touch the barrier geometry, in any pose the shader can
 *     put them in?
 *   · do their feet touch the ground that is actually DRAWN under them?
 *     (measured by raycasting the real triangles, exactly as auditBarrierFeet
 *     does for the posts — floating props are this project's recurring defect)
 *   · what does the feature cost in draw calls, triangles and CPU?
 *
 *   node tools/crowd-test.mjs
 *   node tools/crowd-test.mjs --preset lake_bridge
 *   node tools/crowd-test.mjs --all            # every alpine-ish preset
 *   node tools/crowd-test.mjs --json out.json
 *
 * Exit code is 1 if any hard rule is broken, so a crowd on the carriageway
 * cannot ship past a critic.
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5173', presets: ['crowd_alpine'], frames: 600 };
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--preset') args.presets = [av[++i]];
  else if (a === '--all') args.presets = ['crowd_alpine', 'hero_alpine', 'lake_bridge', 'winter_pass', 'autumn_forest'];
  else if (a === '--frames') args.frames = Number(av[++i]);
  else if (a === '--json') args.json = av[++i];
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});

const report = {};
let failed = false;

for (const preset of args.presets) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${args.base}/?shot=${preset}&hud=0`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 240000 });

  const r = await page.evaluate(async ({ frames }) => {
    const P = await import('/src/dev/probe.js');
    const g = window.__GAME;
    const crowd = g.crowd;
    const people = crowd._people;
    const segs = g.roads.barriers.segments;
    const guards = segs.filter((s) => s.kind === 'guard');
    const out = { preset: null, count: crowd.count, stats: crowd.stats };

    // ---- geometry the answers depend on ---------------------------------
    // roads.js: G_POST_R = 0.20 (post half-thickness), G_BEAM_T = 0.195 (beam
    // half-thickness), so the barrier occupies +/-0.20 m about its own line.
    const BARRIER_HALF = 0.20;

    /** Distance from (x,z) to a barrier bay, and the signed offset outboard. */
    const toSeg = (s, x, z) => {
      const dx = x - s.x, dz = z - s.z;
      let t = dx * s.dx + dz * s.dz;
      if (t > s.half) t = s.half; else if (t < -s.half) t = -s.half;
      const qx = dx - s.dx * t, qz = dz - s.dz * t;
      return { d: Math.hypot(qx, qz), out: qx * s.nx + qz * s.nz };
    };

    // ---- the model's own reach, from the geometry that is really drawn ----
    //
    // Not a constant copied out of crowd.js: the vertex buffer is read back and
    // the shader's pose is replayed on the CPU at the extremes it can reach
    // (arms fully raised, full lean, flag at the end of its swing), so "does a
    // spectator touch the rail" is answered about the shape the GPU actually
    // draws rather than about the rest pose.
    const geo = crowd.group.children[0]?.geometry;
    const pos = geo ? geo.attributes.position.array : new Float32Array(0);
    const part = geo ? geo.attributes.aPart.array : new Float32Array(0);
    const piv = geo ? geo.attributes.aPivot.array : new Float32Array(0);
    const nv = pos.length / 3;

    const rotX = (p, pv, a) => {
      const dx = p[0] - pv[0], dy = p[1] - pv[1], dz = p[2] - pv[2];
      const c = Math.cos(a), s = Math.sin(a);
      p[0] = pv[0] + dx; p[1] = pv[1] + dy * c - dz * s; p[2] = pv[2] + dy * s + dz * c;
    };
    const rotZ = (p, pv, a) => {
      const dx = p[0] - pv[0], dy = p[1] - pv[1], dz = p[2] - pv[2];
      const c = Math.cos(a), s = Math.sin(a);
      p[0] = pv[0] + dx * c - dy * s; p[1] = pv[1] + dx * s + dy * c; p[2] = pv[2] + dz;
    };
    const ZERO = [0, 0, 0];
    const v = [0, 0, 0], pv = [0, 0, 0];
    /** Worst |x| and |z| of any vertex over the whole animation range. */
    const reachOf = (spec, T, ex) => {
      let rx = 0, rz = 0, minY = 0;
      const ph = spec[0], sw = spec[1], armRest = spec[2], acc = spec[3];
      for (let i = 0; i < nv; i++) {
        v[0] = pos[i * 3]; v[1] = pos[i * 3 + 1]; v[2] = pos[i * 3 + 2];
        pv[0] = piv[i * 3]; pv[1] = piv[i * 3 + 1]; pv[2] = piv[i * 3 + 2];
        const pt = part[i];
        if (pt > 1.5 && pt < 3.5) {
          const sd = pt < 2.5 ? 1 : -1;
          const wave = 0.72 + 0.28 * Math.sin(T * 8.5 + ph * 2.3 + sd);
          const raise = armRest + ex * (2.35 - armRest) * wave;
          rotX(v, pv, Math.sin(T * 1.15 + ph) * (0.05 + sw * 0.7));
          rotZ(v, pv, sd * raise);
        } else if (pt > 0.5 && pt < 1.5) {
          rotX(v, pv, Math.sin(T * 0.83 + ph * 1.7) * 0.07 - ex * 0.15);
          rotZ(v, pv, Math.sin(T * 0.61 + ph) * 0.09);
        } else if (pt > 3.5) {
          if (acc < 0.5) { v[0] = pv[0]; v[1] = pv[1]; v[2] = pv[2]; }
          else {
            const h = v[1] - pv[1];
            v[0] += Math.sin(T * 2.9 + ph * 3.1) * (0.05 + ex * 0.10) * h;
            v[2] += Math.sin(T * 2.1 + ph * 1.9 + 1.1) * (0.035 + ex * 0.08) * h;
            v[1] += ex * 0.14;
          }
        }
        rotZ(v, ZERO, Math.sin(T * (0.62 + sw * 3.0) + ph) * (0.026 + sw * 0.30 + ex * 0.055));
        rotX(v, ZERO, Math.sin(T * 0.47 + ph * 2.7) * (0.016 + sw * 0.14));
        v[1] += Math.max(0, Math.sin(T * 6.6 + ph)) * ex * 0.15;
        if (Math.abs(v[0]) > rx) rx = Math.abs(v[0]);
        if (Math.abs(v[2]) > rz) rz = Math.abs(v[2]);
        if (v[1] < minY) minY = v[1];
      }
      return { rx, rz, minY };
    };

    // ---- per-spectator measurements --------------------------------------
    const surf = P.makeRaycastSurface(g.scene);
    const spec4 = [0, 0, 0, 0];
    const rows = [];
    // Sixteen phases of the animation, at full excitement: the worst pose the
    // shader can put anybody in.
    const PHASES = 16;
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      spec4[0] = p.phase; spec4[1] = p.sway; spec4[2] = p.arm; spec4[3] = p.acc;
      let rx = 0, rz = 0, minY = 0;
      for (let k = 0; k < PHASES; k++) {
        const q = reachOf(spec4, (k / PHASES) * 12.0, 1.0);
        if (q.rx > rx) rx = q.rx;
        if (q.rz > rz) rz = q.rz;
        if (q.minY < minY) minY = q.minY;
      }
      // Worst-case horizontal reach in WORLD space: the model's local x runs
      // along the rail and its local z faces it, so the yaw matters.
      const s = p.scale;
      const worldReach = Math.hypot(rx, rz) * s;   // conservative: a disc

      // nearest guard bay, and nearest bay of any kind
      let bestG = null, dG = Infinity, outG = 0;
      for (const q of guards) {
        const m = toSeg(q, p.x, p.z);
        if (m.d < dG) { dG = m.d; bestG = q; outG = m.out; }
      }
      let dAny = Infinity;
      for (const q of segs) {
        const m = toSeg(q, p.x, p.z);
        if (m.d < dAny) dAny = m.d;
      }

      const hit = surf(p.x, p.z);
      rows.push({
        i, x: p.x, z: p.z, y: p.y, scale: s,
        reach: worldReach,
        dGuard: dG,
        outward: outG,                                  // >0 = away from the road
        clearance: dAny - BARRIER_HALF - worldReach,    // <0 means it touches steel
        onRoad: g.roads.isOnRoad(p.x, p.z),
        onSurface: g.roads.surfaceAt(p.x, p.z) != null,
        // Asked NOW, when water.js has resolved its plan — which it had not when
        // the crowd was built. This is the check crowd.js cannot make itself.
        inWater: (() => {
          try { return g.water.contains(p.x, p.z, p.y + 0.4) === true; } catch { return false; }
        })(),
        drawn: hit ? hit.y : null,
        gap: hit ? hit.y - p.y : null,                  // >0 = feet under the ground
        kind: hit ? hit.kind : null,
        footDip: minY * s,                              // lowest the pose takes a vertex
      });
    }

    const num = (a) => a.filter((q) => Number.isFinite(q)).sort((x, y) => x - y);
    const q = (a, f) => (a.length ? a[Math.floor(f * (a.length - 1))] : null);
    const gaps = num(rows.map((r) => (r.gap == null ? NaN : Math.abs(r.gap))));
    const signed = num(rows.map((r) => (r.gap == null ? NaN : r.gap)));
    const clears = num(rows.map((r) => r.clearance));
    const dg = num(rows.map((r) => r.dGuard));

    out.checks = {
      total: rows.length,
      withinGuard5m: rows.filter((r) => r.dGuard <= 5.0).length,
      maxDistToGuard: dg.length ? dg[dg.length - 1] : null,
      roadSideOfBarrier: rows.filter((r) => r.outward <= 0).length,
      onRoad: rows.filter((r) => r.onRoad).length,
      onRoadSurface: rows.filter((r) => r.onSurface).length,
      touchingBarrier: rows.filter((r) => r.clearance < 0).length,
      inWater: rows.filter((r) => r.inWater).length,
      minClearance: clears.length ? clears[0] : null,
      p05Clearance: q(clears, 0.05),
      noGroundHit: rows.filter((r) => r.drawn == null).length,
      footGap: {
        mean: gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length),
        p50: q(gaps, 0.5), p95: q(gaps, 0.95),
        max: gaps.length ? gaps[gaps.length - 1] : null,
        signedMin: signed.length ? signed[0] : null,
        signedMax: signed.length ? signed[signed.length - 1] : null,
        over5cm: rows.filter((r) => r.gap != null && Math.abs(r.gap) > 0.05).length,
      },
      worstFoot: rows.slice().sort((a, b) => Math.abs(b.gap ?? 0) - Math.abs(a.gap ?? 0))
        .slice(0, 6).map((r) => ({ x: +r.x.toFixed(1), z: +r.z.toFixed(1), gap: +(r.gap ?? 0).toFixed(3), kind: r.kind })),
      worstClearance: rows.slice().sort((a, b) => a.clearance - b.clearance)
        .slice(0, 6).map((r) => ({ x: +r.x.toFixed(1), z: +r.z.toFixed(1), c: +r.clearance.toFixed(3) })),
      maxPoseDip: Math.min(...rows.map((r) => r.footDip)),
    };

    // ---- draw calls and triangles ----------------------------------------
    // The frame is measured whole (post.js turns autoReset off and resets once
    // per frame), so this includes the shadow pass and every scene pass the
    // post chain makes. A/B by hiding the one mesh.
    const measure = () => {
      g.render(); g.render();                 // warm the program cache
      g.render();
      return { calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles };
    };
    const withCrowd = measure();
    crowd.group.visible = false;
    const without = measure();
    crowd.group.visible = true;
    const again = measure();
    out.cost = {
      calls: withCrowd.calls, callsWithout: without.calls,
      addedCalls: withCrowd.calls - without.calls,
      tris: withCrowd.tris, trisWithout: without.tris,
      addedTris: withCrowd.tris - without.tris,
      repeatCalls: again.calls,
      geometryTris: crowd.stats.tris,
    };

    // ---- CPU cost of update() --------------------------------------------
    // Driven along the route rather than parked, so the grid lookup visits the
    // busy cells as well as the empty ones.
    const fake = { position: { x: 0, y: 0, z: 0 }, speed: 26 };
    const path = [];
    for (let k = 0; k < frames; k++) {
      const s = g.roads.sample(k / frames);
      path.push([s.x, s.z]);
    }
    // warm up
    for (let k = 0; k < 200; k++) {
      fake.position.x = path[k % frames][0]; fake.position.z = path[k % frames][1];
      crowd.update(1 / 120, fake);
    }
    const t0 = performance.now();
    for (let k = 0; k < frames; k++) {
      fake.position.x = path[k][0]; fake.position.z = path[k][1];
      crowd.update(1 / 120, fake);
    }
    const t1 = performance.now();
    // ...and the same thing sitting still in the middle of the biggest knot,
    // which is the worst case for the excitement scan.
    let heavy = 0, heavyAt = null;
    for (let k = 0; k < frames; k++) {
      const c = path[k];
      let n = 0;
      for (const p of people) {
        const dx = p.x - c[0], dz = p.z - c[1];
        if (dx * dx + dz * dz < 34 * 34) n++;
      }
      if (n > heavy) { heavy = n; heavyAt = c; }
    }
    fake.position.x = heavyAt[0]; fake.position.z = heavyAt[1];
    for (let k = 0; k < 200; k++) crowd.update(1 / 120, fake);
    const t2 = performance.now();
    for (let k = 0; k < frames; k++) crowd.update(1 / 120, fake);
    const t3 = performance.now();

    out.cpu = {
      frames,
      msPerFrameDriving: (t1 - t0) / frames,
      msPerFrameWorstCase: (t3 - t2) / frames,
      worstCaseNeighbours: heavy,
    };

    // ---- the reaction ----------------------------------------------------
    // Excitement has to rise for the people the car goes past, stay at zero for
    // everybody else, and decay when it leaves. Read straight off the attribute
    // the shader consumes.
    const ex = crowd.group.children[0].geometry.attributes.aExcite;
    for (let k = 0; k < ex.array.length; k++) ex.array[k] = 0;
    fake.position.x = heavyAt[0]; fake.position.z = heavyAt[1]; fake.speed = 30;
    crowd.update(1 / 120, fake);
    let lit = 0, litFar = 0, peak = 0;
    for (let k = 0; k < ex.array.length; k++) {
      if (ex.array[k] <= 0) continue;
      lit++;
      if (ex.array[k] > peak) peak = ex.array[k];
      const dx = people[k].x - heavyAt[0], dz = people[k].z - heavyAt[1];
      if (dx * dx + dz * dz > 34 * 34) litFar++;
    }
    // ...and it decays once the car is gone.
    fake.position.x = heavyAt[0] + 5000; fake.position.z = heavyAt[1];
    let decaySteps = 0;
    for (; decaySteps < 2000; decaySteps++) {
      crowd.update(1 / 120, fake);
      let any = false;
      for (let k = 0; k < ex.array.length; k++) if (ex.array[k] > 0) { any = true; break; }
      if (!any) break;
    }
    // Crawling past should barely register.
    for (let k = 0; k < ex.array.length; k++) ex.array[k] = 0;
    fake.position.x = heavyAt[0]; fake.position.z = heavyAt[1]; fake.speed = 1;
    crowd.update(1 / 120, fake);
    let slowPeak = 0;
    for (let k = 0; k < ex.array.length; k++) if (ex.array[k] > slowPeak) slowPeak = ex.array[k];
    out.reaction = {
      excitedAtSpeed: lit, excitedOutsideRadius: litFar, peak,
      decayFrames: decaySteps, decaySeconds: decaySteps / 120,
      peakAtWalkingPace: slowPeak,
      updateRangesLength: ex.updateRanges.length,
    };

    // ---- allocation ------------------------------------------------------
    // Not a proof, but it catches the obvious: run 3000 updates and watch the
    // heap. `performance.memory` is Chromium-only, which is what we are in.
    if (performance.memory) {
      const before = performance.memory.usedJSHeapSize;
      for (let k = 0; k < 3000; k++) {
        fake.position.x = path[k % frames][0]; fake.position.z = path[k % frames][1];
        crowd.update(1 / 120, fake);
      }
      out.heapDeltaBytesPer3000Updates = performance.memory.usedJSHeapSize - before;
    }

    // ---- determinism -----------------------------------------------------
    // Rebuild the same biome from the same seed and hash the population. If this
    // ever differs, something in the crowd is reading a clock or Math.random and
    // every screenshot comparison in the project is worthless.
    const hash = (list) => {
      let h = 2166136261 >>> 0;
      for (const p of list) {
        for (const v of [p.x, p.z, p.y, p.yaw, p.scale, p.phase, p.arm, p.acc]) {
          const q = Math.round(v * 4096) | 0;
          h = Math.imul(h ^ (q & 0xffff), 16777619) >>> 0;
          h = Math.imul(h ^ (q >>> 16), 16777619) >>> 0;
        }
      }
      return h;
    };
    const h1 = hash(people);
    const biome = g.biome.id, seed = g.seed;
    g.loadBiome(biome, seed);
    const h2 = hash(g.crowd._people);
    out.determinism = { hash: h1, rebuildHash: h2, same: h1 === h2, count2: g.crowd.count };

    return out;
  }, { frames: args.frames });

  r.preset = preset;
  r.pageErrors = errors;
  report[preset] = r;
  await page.close();
}

await browser.close();

const f = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v) ? '  --  ' : Number(v).toFixed(d));
for (const [preset, r] of Object.entries(report)) {
  const c = r.checks, s = r.stats;
  console.log('');
  console.log(`CROWD — ${preset}`);
  console.log(`  spectators ${r.count}   guard bays ${s.guardBays}   runs ${s.runs}   flags ${s.flags}   meshes ${s.meshes}`);
  console.log(`  geometry   ${s.trisPerSpectator} tris each, ${s.tris} total`);
  console.log('');
  console.log('  RULE                                            value        must be');
  console.log(`    behind a kind:'guard' bay (<= 5 m)            ${String(c.withinGuard5m).padStart(6)}/${String(c.total).padEnd(6)} 100%`);
  console.log(`    furthest any spectator is from steel          ${f(c.maxDistToGuard, 2).padStart(6)} m      <= 5.00`);
  console.log(`    on the ROAD side of their barrier             ${String(c.roadSideOfBarrier).padStart(6)}        0`);
  console.log(`    on the carriageway (isOnRoad)                 ${String(c.onRoad).padStart(6)}        0`);
  console.log(`    on any road surface incl. verge               ${String(c.onRoadSurface).padStart(6)}        0`);
  console.log(`    touching barrier geometry, worst pose         ${String(c.touchingBarrier).padStart(6)}        0`);
  console.log(`      min clearance to steel                     ${f(c.minClearance, 3).padStart(6)} m      > 0`);
  console.log(`      5th percentile clearance                   ${f(c.p05Clearance, 3).padStart(6)} m`);
  console.log(`    no drawn ground under them                    ${String(c.noGroundHit).padStart(6)}        0`);
  console.log('');
  console.log('  FEET vs the triangles that are actually drawn (raycast)');
  console.log(`    |gap| mean ${f(c.footGap.mean)}   p50 ${f(c.footGap.p50)}   p95 ${f(c.footGap.p95)}   MAX ${f(c.footGap.max)} m`);
  console.log(`    signed range ${f(c.footGap.signedMin)} .. ${f(c.footGap.signedMax)} m   (+ = feet under the ground)`);
  console.log(`    over 5 cm: ${c.footGap.over5cm} of ${c.total}`);
  console.log(`    worst: ${c.worstFoot.map((w) => `${w.gap} at (${w.x}, ${w.z}) [${w.kind}]`).join('   ')}`);
  console.log(`    deepest any animated vertex goes below the feet plane: ${f(c.maxPoseDip)} m`);
  console.log('');
  console.log('  COST');
  console.log(`    draw calls  ${r.cost.callsWithout} -> ${r.cost.calls}   ADDED ${r.cost.addedCalls}   (budget 3)`);
  console.log(`    triangles   ${r.cost.trisWithout} -> ${r.cost.tris}   ADDED ${r.cost.addedTris}   (geometry ${r.cost.geometryTris}, budget 40000)`);
  console.log(`    crowd.update  driving ${f(r.cpu.msPerFrameDriving, 4)} ms/frame   worst case ${f(r.cpu.msPerFrameWorstCase, 4)} ms/frame (${r.cpu.worstCaseNeighbours} in range)   budget 0.25`);
  if (r.heapDeltaBytesPer3000Updates !== undefined) {
    console.log(`    heap delta over 3000 updates: ${r.heapDeltaBytesPer3000Updates} bytes`);
  }
  console.log('');
  console.log('  REACTION (aExcite, the attribute the shader reads)');
  console.log(`    excited by a car at 30 m/s: ${r.reaction.excitedAtSpeed}   outside the 34 m radius: ${r.reaction.excitedOutsideRadius}   peak ${f(r.reaction.peak, 2)}`);
  console.log(`    peak at walking pace: ${f(r.reaction.peakAtWalkingPace, 2)}   decays to zero in ${f(r.reaction.decaySeconds, 2)} s   pending upload ranges ${r.reaction.updateRangesLength}`);
  console.log(`  DETERMINISM  hash ${r.determinism.hash} vs ${r.determinism.rebuildHash} on rebuild — ${r.determinism.same ? 'IDENTICAL' : 'DIFFERENT'}`);
  if (r.pageErrors.length) console.log(`    PAGE ERRORS: ${r.pageErrors.slice(0, 4).join(' | ')}`);

  const bad = [];
  if (c.withinGuard5m !== c.total) bad.push('spectators not behind a guardrail');
  if (c.roadSideOfBarrier > 0) bad.push('spectators on the road side of the barrier');
  if (c.onRoad > 0 || c.onRoadSurface > 0) bad.push('spectators on the road');
  if (c.touchingBarrier > 0) bad.push('spectators intersecting the barrier');
  if (c.noGroundHit > 0) bad.push('spectators with no drawn ground under them');
  if (c.inWater > 0) bad.push(`${c.inWater} spectators standing in water`);
  if (c.footGap.max > 0.12) bad.push(`foot gap ${c.footGap.max.toFixed(2)} m`);
  if (r.cost.addedCalls > 3) bad.push(`${r.cost.addedCalls} draw calls`);
  if (r.cost.geometryTris > 40000) bad.push(`${r.cost.geometryTris} triangles`);
  if (r.cpu.msPerFrameWorstCase > 0.25) bad.push(`${r.cpu.msPerFrameWorstCase.toFixed(3)} ms/frame`);
  if (r.reaction.excitedOutsideRadius > 0) bad.push('excitement outside the reaction radius');
  if (r.reaction.excitedAtSpeed === 0 && r.count > 0) bad.push('no reaction to the car at all');
  if (r.reaction.updateRangesLength > 1) bad.push('update ranges accumulating');
  if (!r.determinism.same) bad.push('NOT DETERMINISTIC');
  if (r.pageErrors.length) bad.push('page errors');
  if (bad.length) { failed = true; console.log(`  FAIL: ${bad.join('; ')}`); }
  else console.log('  PASS');
}

if (args.json) await writeFile(args.json, JSON.stringify(report, null, 1));
process.exit(failed ? 1 : 0);
