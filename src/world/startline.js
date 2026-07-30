import * as THREE from 'three';
import { GeoBuilder, derivePalette } from './buildkit.js';

/**
 * START / FINISH GATE — the geometry, and the geometry only.
 *
 * CONTRACT:
 *   createStartLine(ctx) -> {
 *     group:    THREE.Object3D    named 'startline'; caller adds it to the world
 *     gate:     {                 the LINE, in world xz. See race.js.
 *       x, z,                     centre of the line
 *       fx, fz,                   unit FORWARD along the route (the gate normal)
 *       ax, az,                   unit ACROSS the road (the line's own direction)
 *       half,                     half-length of the line, metres
 *       y,                        road height at the centre
 *       t,                        parameter along roads.sample(), 0..1
 *     },
 *     colliders: {x,z,r}[]        the two gantry posts, for whoever wants them
 *   }
 *
 * ctx = { roads, terrain, bridges, palette, biome }
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS SEPARATE FROM race.js
 *
 * race.js is pure arithmetic on positions and times and has no THREE import at
 * all, which is what makes it testable without a scene. This file is the
 * opposite: nothing but geometry. Splitting them means the lap logic can be
 * exercised head-on by tools/race-test.mjs against a gate descriptor that is
 * six numbers, and the gate can be re-art-directed without anyone re-reading
 * the crossing test.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE IS A DRIVABLE SURFACE.
 *
 * The chequered strip is PAINT: every one of its corners is placed at
 * `roads.heightAt()` + 0.06 m, so it drapes over the carriageway's camber and
 * banking instead of sitting on it as a slab. 0.06 m is the same order as the
 * skidmark lift (0.075 m in fx/skidmarks.js) and a third of the wheel radius'
 * visible threshold; the car's tyres pass through it exactly the way they pass
 * through their own skid marks, which is to say invisibly at a 78 m camera.
 *
 * Everything else — posts, beam, banner, marker boards — is clear of the
 * carriageway or three metres above it, and no mesh here is named so that
 * dev/probe.js's DRIVABLE filter picks it up. There is deliberately no
 * `heightAt` on this module: the gate must never be a thing the car stands on,
 * so there is nothing for game.js's topmost-drawn-surface chain to consult.
 */

const clamp = THREE.MathUtils.clamp;

/**
 * WHERE THE LINE GOES.
 *
 * A start gate belongs on a straight, and it belongs where the car can see it
 * coming. Two constraints fix it:
 *
 *  - AHEAD of the spawn, never behind it. The car is placed by game.js at
 *    `roads.spawn()`; putting the line behind that point makes lap 1 shorter
 *    than laps 2-5 by however far behind it sits, and a lap table whose first
 *    row is measured over a different distance from the rest is a lap table
 *    that cannot be read. Ahead, every one of the five laps is exactly one
 *    circuit of the route.
 *  - 15 to 48 m ahead. Under 15 m and the car's own 4.2 m length is a
 *    meaningful fraction of its distance from the line, which is the only way
 *    the "which side am I on" test at t=0 could ever be ambiguous. Past 48 m
 *    the staging run-up starts to feel like part of the lap.
 *
 * Within that window: the straightest station wins (a banner over a hairpin
 * reads as a mistake), and any station whose surface is a bridge deck or is off
 * the road network entirely is rejected outright.
 */
function pickGateT(roads, bridges) {
  const L = roads.length;
  if (!(L > 0)) return 0;

  const spawn = roads.spawn();
  // Public API only: `roads._samples` is documented as diagnostics, so the
  // station is found by scanning `sample()` rather than by reading it.
  const N = Math.max(600, Math.round(L / 1.5));
  let t0 = 0, best = Infinity;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const s = roads.sample(t);
    const d = (s.x - spawn.x) ** 2 + (s.z - spawn.z) ** 2;
    if (d < best) { best = d; t0 = t; }
  }

  // Curvature over a 12 m chord: long enough to ignore the sampling dither the
  // route module warns about (±0.005 rad/m at 3 m stations), short enough to
  // still see a real corner.
  const CHORD = 12;
  const curv = (t) => {
    const a = roads.sample(((t - CHORD / 2 / L) % 1 + 1) % 1);
    const b = roads.sample(((t + CHORD / 2 / L) % 1 + 1) % 1);
    let d = b.heading - a.heading;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) / CHORD;
  };

  let bestT = ((t0 + 24 / L) % 1 + 1) % 1, bestK = Infinity, found = false;
  for (let d = 15; d <= 48; d += 1.5) {
    const t = ((t0 + d / L) % 1 + 1) % 1;
    const s = roads.sample(t);
    if (roads.heightAt(s.x, s.z) == null) continue;         // off the drawn road
    if (bridges?.heightAt?.(s.x, s.z) != null) continue;    // never over a span
    const k = curv(t);
    if (k < bestK) { bestK = k; bestT = t; found = true; }
  }
  if (!found) return ((t0 + 24 / L) % 1 + 1) % 1;
  return bestT;
}

/**
 * HOW WIDE THE LINE IS.
 *
 * Wide enough that a car which has run onto the grass still trips it — a lap
 * counter that only fires on the racing line is a lap counter that punishes the
 * player for the exact thing the game rewards. Narrow enough that no OTHER leg
 * of the route can reach across it: the route module guarantees the loop never
 * brushes past itself, and this measures how much clearance that guarantee
 * actually bought here and takes a little under half of it.
 *
 * 16 m is the cap. The carriageway is 11 m and the drawn earthworks reach about
 * 9 m either side of the centre, so 16 m is already several metres of open
 * hillside past anything a driver would call "the road".
 */
function gateHalfWidth(roads, gx, gz, gt) {
  const L = roads.length;
  const N = Math.max(400, Math.round(L / 3));
  let near = Infinity;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    // Skip the 90 m of route either side of the gate — that is the gate's own
    // stretch, not a different leg.
    let dt = Math.abs(t - gt);
    dt = Math.min(dt, 1 - dt);
    if (dt * L < 90) continue;
    const s = roads.sample(t);
    const d = Math.hypot(s.x - gx, s.z - gz);
    if (d < near) near = d;
  }
  return clamp(near * 0.45, 8, 16);
}

/** Outward from the centre until the module stops drawing a surface. */
function drawnEdge(roads, cx, cz, ax, az, limit = 14) {
  let e = 0;
  for (let u = 0.25; u <= limit; u += 0.25) {
    if (roads.heightAt(cx + ax * u, cz + az * u) == null) break;
    e = u;
  }
  return e;
}

/** Outward from the centre until we are off the carriageway proper. */
function carriagewayEdge(roads, cx, cz, ax, az, limit = 10) {
  let e = 0;
  for (let u = 0.25; u <= limit; u += 0.25) {
    if (!roads.isOnRoad(cx + ax * u, cz + az * u)) break;
    e = u;
  }
  return e;
}

export function createStartLine({ roads, terrain, bridges, palette, biome }) {
  const group = new THREE.Group();
  group.name = 'startline';

  const gt = pickGateT(roads, bridges);
  const c = roads.sample(gt);
  // Project convention (entities/vehicle.js): forward = (cos h, 0, -sin h). The
  // gate's NORMAL is that forward vector, so "which side of the line am I on" is
  // a dot product with the direction of travel and needs no sign convention of
  // its own.
  const fx = Math.cos(c.heading), fz = -Math.sin(c.heading);
  const ax = -fz, az = fx;                       // along the line, road-left

  const surfY = (x, z) => roads.heightAt(x, z) ?? terrain.drawnHeightAt(x, z);
  const y0 = surfY(c.x, c.z);

  const gate = {
    x: c.x, z: c.z, fx, fz, ax, az,
    half: gateHalfWidth(roads, c.x, c.z, gt),
    y: y0,
    t: gt,
  };

  const K = derivePalette(palette, biome.id);
  const b = new GeoBuilder();

  // ------------------------------------------------------------------ paint
  // The chequered strip. Two rows across the carriageway, drawn as a draped
  // quad grid whose every corner samples the road: on a banked station a flat
  // slab would lift one edge clear of the surface by 0.08 m over a 1.5 m cell,
  // which at this camera is a visible white lip along the road.
  //
  // HOW WIDE THE PAINT IS. `isOnRoad` stops at the carriageway (hw + 0.6 =
  // 6.1 m either side here), but the ribbon keeps DRAWING ochre out over its
  // shoulders and batter for another two to three metres, and shot at 1920 the
  // strip covered barely half of what the eye calls "the road" — it read as a
  // rug laid down the middle rather than as a line across the stage. So it runs
  // to the carriageway plus 2 m, capped at the drawn edge less 0.5 m so it never
  // hangs off the mesh into thin air.
  const carriage = Math.max(3, carriagewayEdge(roads, c.x, c.z, ax, az) - 0.15);
  const drawnR = Math.min(drawnEdge(roads, c.x, c.z, ax, az),
    drawnEdge(roads, c.x, c.z, -ax, -az));
  const road = Math.min(carriage + 2.0, Math.max(carriage, drawnR - 0.5));
  const COLS = 10, ROWS = 2;
  const CELL_L = 1.45;                            // metres along the road
  const LIFT = 0.06;                              // see the essay at the top
  const cellW = (2 * road) / COLS;
  const pt = (u, s) => {
    const x = c.x + ax * u + fx * s;
    const z = c.z + az * u + fz * s;
    return [x, surfY(x, z) + LIFT, z];
  };
  const paint = [];
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const u0 = -road + i * cellW, u1 = u0 + cellW;
      const s0 = -(ROWS / 2) * CELL_L + j * CELL_L, s1 = s0 + CELL_L;
      const A = pt(u0, s0), B = pt(u1, s0), C = pt(u1, s1), D = pt(u0, s1);
      const col = (i + j) % 2 === 0 ? K.white : K.tar;
      paint.push({ quad: [A, B, C, D], color: col });
    }
  }
  const paintGeo = quadGrid(paint);
  const paintMesh = new THREE.Mesh(paintGeo, new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true,
    // Coplanar-with-the-road paint. Without this the strip stipples against the
    // ribbon at 300 m; with it there is no depth fight at any distance.
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
  }));
  paintMesh.name = 'startline-paint';
  // A 0.06 m plate has no silhouette worth a shadow pass and its own shadow
  // would darken the road it is painted on.
  paintMesh.userData.noShadow = true;
  paintMesh.castShadow = false;
  paintMesh.receiveShadow = true;
  group.add(paintMesh);

  // ---------------------------------------------------------------- gantry
  // Post centres just outside the drawn earthworks, so nothing structural
  // stands on a surface the car uses. Capped at 12 m: past that the banner
  // spans more than the frame can hold at this camera.
  const postU = clamp(Math.max(drawnEdge(roads, c.x, c.z, ax, az),
    drawnEdge(roads, c.x, c.z, -ax, -az)) + 0.9, 6.5, 12);

  const POST = 0.52;                 // square section, timber
  const BEAM_Y = 6.0;                // clear of anything the car can jump
  const colliders = [];

  for (const side of [1, -1]) {
    const px = c.x + ax * postU * side, pz = c.z + az * postU * side;
    const py = surfY(px, pz);
    // Sunk 0.9 m. A post on a hillside that is merely placed at the sampled
    // height shows daylight under one corner as soon as the ground falls away;
    // burying it is cheaper than fitting a plinth to the terrain.
    const H = (y0 + BEAM_Y) - py + 0.9;
    b.push(px, py - 0.9 + H / 2, pz, c.heading);
    b.box(POST, H, POST, K.wood);
    b.pop();
    // A raking brace back down to the ground — it is what stops a 6 m timber
    // gantry reading as two flat sticks from directly above.
    const bx = px + ax * 1.6 * side, bz = pz + az * 1.6 * side;
    const by = surfY(bx, bz);
    const bl = Math.hypot(postU * 0 + 1.6, (y0 + BEAM_Y - 1.4) - by);
    b.pushTilt((px + bx) / 2, (by + y0 + BEAM_Y - 1.4) / 2, (pz + bz) / 2,
      Math.atan2(-az * side, ax * side), 0,
      -Math.atan2(1.6, (y0 + BEAM_Y - 1.4) - by) * side);
    b.box(0.26, bl, 0.26, K.woodDark);
    b.pop();
    // No `kind`: core/collision.js infers from radius, and 0.55 m is under its
    // 0.95 m trunk threshold, so a gantry leg behaves like a mature fir — solid,
    // stops you, does not yield. That is right for a buried 0.52 m timber post.
    colliders.push({ x: px, z: pz, r: 0.55 });
  }

  // Head beam across the top.
  b.push(c.x, y0 + BEAM_Y + 0.3, c.z, c.heading);
  b.box(0.46, 0.58, postU * 2 + POST * 2, K.wood);
  // Banner hanging under it. No text — there are no textures in this project —
  // so the panel carries a chequered band instead, which is the same message
  // and survives being 40 px wide.
  const BW = postU * 2 - 0.5;
  b.box(0.16, 1.75, BW, K.signRed, { y: -1.15 });
  // The chequer band. It has to PROTRUDE, not be inset: the first version made
  // it 0.20 m thick against a 0.16 m panel and the shot came back a plain red
  // bar — 2 cm of relief is under a pixel at 78 m, and a coplanar face loses the
  // depth test as often as it wins it. 0.36 m against 0.16 m is 10 cm clear on
  // each side, which is a facet the light can find.
  const cq = 14, cw = BW / cq;
  for (let i = 0; i < cq; i++) {
    b.box(0.36, 0.72, cw, (i % 2 ? K.white : K.tar),
      { y: -1.56, z: -BW / 2 + cw * (i + 0.5) });
  }
  // A pale top rail on the banner, so the panel has an edge from above.
  b.box(0.24, 0.18, BW, K.white, { y: -0.26 });
  b.pop();

  // ------------------------------------------------------- timing markers
  // Two striped boards ON the line itself, at the carriageway edge. These are
  // the thing that tells the player where the line actually is: the banner is
  // six metres up and, at a 52 degree camera, its shadow is what lands on the
  // road, not the banner.
  for (const side of [1, -1]) {
    const u = road + 0.55;
    const mx = c.x + ax * u * side, mz = c.z + az * u * side;
    const my = surfY(mx, mz);
    b.push(mx, my, mz, c.heading);
    b.box(0.30, 0.9, 0.30, K.metalDark, { y: 0.1 });        // buried foot
    for (let i = 0; i < 4; i++) {
      b.box(0.26, 0.34, 0.26, i % 2 ? K.signRed : K.white, { y: 0.45 + i * 0.34 });
    }
    // The beam head — an amber box facing across the road.
    b.box(0.34, 0.26, 0.22, K.signYellow, { y: 1.86 });
    b.pop();
    // `post`: collision.js mows a marker board down for 6% of the car's speed
    // and a bang, rather than stopping it dead. These stand 2.4 m outside the
    // carriageway, which is exactly where a car that has run wide at the line
    // arrives — a wall there would be a punishment, a board is a moment.
    colliders.push({ x: mx, z: mz, r: 0.3, kind: 'post' });
  }

  const geo = b.build();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true,
  }));
  mesh.name = 'startline-gantry';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  return { group, gate, colliders };
}

/** Flat-shaded coloured quads from explicit corner triples. */
function quadGrid(cells) {
  const pos = new Float32Array(cells.length * 18);
  const col = new Float32Array(cells.length * 18);
  let o = 0;
  for (const cell of cells) {
    const [A, B, C, D] = cell.quad;
    const c = cell.color.isColor ? cell.color : new THREE.Color(cell.color);
    for (const p of [A, B, C, A, C, D]) {
      pos[o] = p[0]; pos[o + 1] = p[1]; pos[o + 2] = p[2];
      col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      o += 3;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
