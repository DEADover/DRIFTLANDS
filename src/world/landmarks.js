import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { GeoBuilder, derivePalette } from './buildkit.js';

/**
 * LANDMARKS — the built world.
 *
 * CONTRACT:
 *   createLandmarks(ctx) -> {
 *     group: THREE.Object3D
 *     isBlocked(x, z) -> boolean
 *     colliders: {x,z,r}[]
 *   }
 *
 * ctx = { terrain, biome, palette, seed, roads, water }
 *
 * ---------------------------------------------------------------------------
 * DOCTRINE — restraint.
 *
 * The references contain ONE to THREE buildings per frame, never a village.
 * A landmark's job is to give the eye a man-made anchor and a sense of scale
 * against 15 m conifers; a fourth chalet adds nothing and costs the frame its
 * wilderness. So this file places a hard-capped number of set pieces and then
 * stops, and everything it places is chosen for how it reads FROM ABOVE — roof
 * plane, yard, wood pile — because at a 50 degree camera the roof is 80% of
 * what you see of a house.
 *
 * Placement uses only the roads contract (`isOnRoad`, `isBlocked`, `sample`):
 * a chalet wants an OPEN, FLAT shelf a short walk off the route, and a corner
 * board wants the outside of a real corner, two metres past the road edge —
 * which is found by stepping outward until `isOnRoad` goes false rather than by
 * assuming a road width.
 */

const clamp = THREE.MathUtils.clamp;

// ---------------------------------------------------------------------------
// PIECES
// ---------------------------------------------------------------------------

/**
 * Alpine chalet. Stone plinth, plastered ground floor, timber upper storey with
 * a balcony, and a broad low-pitched roof with deep eaves — the eaves matter
 * because from above they are the silhouette.
 */
function chalet(rng, K, o = {}) {
  const b = new GeoBuilder();
  // ROUND 4. Two complaints, both fair: the house dominated the hero frame, and
  // its roof was a bare maroon slab — 12 triangles of flat colour occupying an
  // eighth of the screen. At a 50 degree camera the roof IS the building, so
  // either it carries detail or the building has none.
  //
  // Smaller (a real alpine farmhouse is 6-7 m on the ridge, not 8), and the
  // roof now has courses, a fascia, a ridge beam and purlin ends, so the plane
  // breaks into four values instead of one.
  const W = o.w ?? rng.float(5.8, 7.0);       // along X (ridge direction)
  const D = o.d ?? rng.float(4.6, 5.6);       // across Z
  const plinth = rng.float(0.6, 1.0);
  const h1 = rng.float(2.5, 2.9);
  const h2 = rng.float(1.9, 2.3);

  // Plinth — deliberately oversized and sunk, so a chalet on a slight slope
  // never shows daylight under a corner.
  b.box(W * 1.04, plinth + 1.6, D * 1.04, K.stoneDark, { y: (plinth + 1.6) / 2 - 1.6 });
  // Ground floor: pale plaster.
  b.box(W, h1, D, K.plaster, { y: plinth + h1 / 2 });
  // Door and two shuttered windows on the long face. Small, but they are the
  // difference between "a house" and "a box with a lid".
  for (const sz of [1, -1]) {
    const fz = sz * (D / 2 + 0.02);
    if (sz > 0) b.box(0.85, 1.7, 0.10, K.woodDark, { x: -W * 0.22, y: plinth + 0.85, z: fz });
    for (const wx of [W * 0.10, W * 0.34]) {
      // Deep, nearly unlit glass with a timber surround. `K.glass` neat is the
      // sky colour and at 6 px it fired off as two cyan pixels per window — the
      // brightest chroma in the frame, on a building meant to sit back.
      b.box(0.66, 0.66, 0.10, K.glass.clone().lerp(K.stoneDark, 0.62), { x: sz * wx, y: plinth + h1 * 0.62, z: fz });
      b.box(0.14, 0.74, 0.09, K.woodDark, { x: sz * wx - 0.40, y: plinth + h1 * 0.62, z: fz + sz * 0.02 });
      b.box(0.14, 0.74, 0.09, K.woodDark, { x: sz * wx + 0.40, y: plinth + h1 * 0.62, z: fz + sz * 0.02 });
    }
  }
  // Upper storey: dark timber, slightly proud of the plaster.
  b.box(W * 1.02, h2, D * 1.03, K.wood, { y: plinth + h1 + h2 / 2 });
  // Balcony: a deck board, a rail and a row of balusters. From above the deck
  // and the rail read as two concentric rectangles, which is exactly the note
  // an alpine chalet gives at this distance.
  const bY = plinth + h1 + h2 * 0.30;
  b.box(W * 1.16, 0.16, D * 1.20, K.woodPale, { y: bY });
  b.box(W * 1.16, 0.14, 0.12, K.woodDark, { y: bY + 0.62, z: D * 0.60 });
  b.box(W * 1.16, 0.14, 0.12, K.woodDark, { y: bY + 0.62, z: -D * 0.60 });
  for (let i = 0; i < 7; i++) {
    const x = (i / 6 - 0.5) * W * 1.10;
    b.box(0.09, 0.62, 0.09, K.woodDark, { x, y: bY + 0.31, z: D * 0.60 });
  }

  // Roof: wide eaves, shallow-ish pitch, warm tile.
  // Eaves pulled right in (1.16/1.30 -> 1.05/1.12). The old overhang was wider
  // than the balcony below it, so the deck, the rail and the whole timber upper
  // storey were hidden and the house read as a roof sitting on a plinth.
  const rw = W * 1.05, rd = D * 1.12, rh = rng.float(1.9, 2.4);
  const top = plinth + h1 + h2;
  b.gable(rw, rh, rd, K.roofTile, { y: top });
  const pitch = Math.atan2(rh, rd / 2);
  // Shingle courses: two darker bands lying across each slope. They sit a few
  // centimetres proud, so from above the roof reads as a shingled plane with a
  // repeating rhythm instead of one poster-flat lozenge.
  for (const side of [1, -1]) {
    for (const t of [0.34, 0.68]) {
      b.box(rw * 0.99, 0.09, 0.34, K.roofCourse, {
        y: top + rh * (1 - t) + 0.07,
        z: side * (rd / 2) * t,
        rx: side * pitch,
      });
    }
    // Fascia along the eave — a rim, so the roof has an edge rather than just
    // stopping. Plus three purlin ends poking out beyond it.
    // Mid timber, not woodDark. At near-black a 26 cm fascia became a hard
    // black bar running the width of the house — the heaviest line in the frame.
    b.box(rw * 1.02, 0.24, 0.16, K.wood, { y: top - 0.12, z: side * rd * 0.5 });
    for (const f of [-0.32, 0, 0.32]) {
      b.box(0.16, 0.16, 0.5, K.wood, { x: rw * f, y: top - 0.06, z: side * (rd * 0.5 + 0.16) });
    }
  }
  // Ridge beam, and its two ends projecting past the gables.
  b.box(rw * 1.06, 0.24, 0.44, K.roofDark, { y: top + rh - 0.09 });
  // Chimney: stone stack with a pale cap.
  const cx = W * rng.float(-0.28, 0.28);
  b.box(0.72, 2.0, 0.72, K.stone, { x: cx, y: top + rh * 0.55, z: D * 0.16 });
  b.box(0.94, 0.18, 0.94, K.stoneDark, { x: cx, y: top + rh * 0.55 + 1.05, z: D * 0.16 });

  return { geo: b.build(), r: Math.max(rw, rd) * 0.45, height: top + rh };
}

/** Open-fronted timber woodshed with a stacked log wall. */
function woodshed(rng, K) {
  const b = new GeoBuilder();
  const W = rng.float(3.4, 4.4), D = rng.float(2.4, 3.0), H = rng.float(2.0, 2.4);
  // ROUND 4. This shed was reading in the hero frame as a ROOF FLOATING IN THE
  // GRASS: the mono-pitch slab overhung by 16% and 24% on a building whose only
  // other mass was four 26 cm posts, so from above the roof hid everything that
  // held it up. The overhang is now a hand's width, the two ends are boarded so
  // the shed has visible sides, and the log stack fills the opening — the
  // building reads as a solid object with a lid on it.
  b.box(W, 0.3, D, K.wood, { y: 0.15 });
  b.box(W, H * 0.94, 0.26, K.wood, { y: H * 0.47, z: -D / 2 + 0.1 });       // back wall
  for (const sx of [-1, 1]) {                                               // boarded ends
    b.box(0.22, H * 0.92, D * 0.96, K.woodPale, { x: sx * (W / 2 - 0.1), y: H * 0.46 });
  }
  for (const sx of [-1, 1]) b.box(0.20, H * 0.80, 0.20, K.wood, { x: sx * (W / 2 - 0.3), y: H * 0.40, z: D / 2 - 0.18 });
  // Mono-pitch roof, tilted toward the open front. Two boards, not one slab.
  // Weathered GREY shingle, not the chalet's tile. Two maroon lozenges lying in
  // the same patch of grass was most of why the shed read as a second, floating
  // roof rather than as an outbuilding.
  b.box(W * 1.06, 0.20, D * 1.10, K.shedRoof, { y: H + 0.12, rx: 0.20 });
  // Three battens across the fall of the roof. Without them the mono-pitch is
  // one unbroken rectangle, which is the shape that read as "floating slab".
  for (const f of [-0.32, 0, 0.32]) {
    b.box(W * 1.07, 0.09, 0.20, K.shedRoofDark, { y: H + 0.14 + f * -0.20 * 1.02, z: D * 1.10 * f, rx: 0.20 });
  }
  b.box(W * 1.07, 0.10, 0.26, K.wood, { y: H + 0.30, z: -D * 0.34, rx: 0.20 });
  b.box(W * 1.07, 0.16, 0.16, K.wood, { y: H - 0.02, z: D * 0.56, rx: 0.20 });
  // Log ends — a stack of short cylinders facing out is unmistakable at
  // any distance and sells the building as lived-in.
  const rows = 3, cols = 5;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      b.cyl(0.20, 0.20, D * 0.72, 5, r % 2 ? K.woodPale : K.dead, {
        rx: Math.PI / 2,
        x: -W * 0.32 + (c / (cols - 1)) * W * 0.64 + rng.float(-0.04, 0.04),
        y: 0.44 + r * 0.42,
        z: 0.08,
      });
    }
  }
  // Two logs rolled out onto the grass. Nothing sells a yard like clutter.
  for (let i = 0; i < 2; i++) {
    b.cyl(0.20, 0.22, rng.float(1.2, 1.8), 5, K.dead, {
      rz: Math.PI / 2, ry: rng.float(0, 3.14),
      x: rng.float(-W * 0.3, W * 0.3), y: 0.20, z: D * rng.float(0.62, 0.85),
    });
  }
  return { geo: b.build(), r: Math.max(W, D) * 0.6, height: H + 0.4 };
}

/** Post-and-rail yard panel, one span. Ridge along local X. */
function fencePanel(rng, K, span) {
  const b = new GeoBuilder();
  b.box(0.22, 1.5, 0.22, K.wood, { x: -span / 2, y: 0.75 });
  b.box(0.22, 1.5, 0.22, K.wood, { x: span / 2, y: 0.75 });
  b.box(span, 0.16, 0.13, K.woodPale, { y: 1.16 });
  b.box(span, 0.16, 0.13, K.woodPale, { y: 0.68 });
  return { geo: b.build(), r: 0, height: 1.5 };
}

/**
 * Corner marker board — a tall red-and-white striped panel on a post, canted
 * back toward the camera so a high tilted view sees the striped FACE and not a
 * thin edge. Deliberately taller and narrower than the road builder's low
 * chevrons, so where both appear they read as different objects.
 */
function markerBoard(rng, K) {
  const b = new GeoBuilder();
  const H = 2.3;
  b.box(0.20, H, 0.20, K.woodDark, { y: H / 2 });
  // 5 alternating bands, tilted back 22 degrees about X.
  const bands = 5;
  const bh = 0.42;
  for (let i = 0; i < bands; i++) {
    b.box(0.95, bh, 0.13, i % 2 ? K.white : K.signRed, {
      y: H * 0.42 + i * bh, z: -0.14, rx: -0.38,
    });
  }
  return { geo: b.build(), r: 0.4, height: H };
}

// ---------------------------------------------------------------------------
// PLACEMENT
// ---------------------------------------------------------------------------

export function createLandmarks(ctx) {
  const group = new THREE.Group();
  group.name = 'landmarks';
  const { terrain: T, biome: B, palette, seed = 7, roads, water } = ctx;

  const blockers = [];
  const colliders = [];
  const isBlocked = (x, z) => {
    for (let i = 0; i < blockers.length; i++) {
      const b = blockers[i];
      const dx = x - b.x, dz = z - b.z;
      if (dx * dx + dz * dz < b.r * b.r) return true;
    }
    return false;
  };

  if (!T || !roads) return { group, isBlocked, colliders };

  const rng = new Rng((seed ^ 0x1a7d) >>> 0);
  const P = derivePalette(palette, B.id);
  // The palette's `roofTile` is accent0 — the signal red kept for corner boards
  // — darkened by 0.20 of HSL lightness. THREE works in LINEAR space, so that
  // darkening barely bites and the roof rendered as a raspberry lozenge that
  // outshouted the car in its own frame. An alpine roof is weathered
  // timber-red: mostly the wood tone, with the accent only as a tint.
  const tile = P.roofTile.clone().lerp(P.woodDark, 0.62).lerp(P.rust, 0.22);
  const K = {
    ...P,
    roofTile: tile,
    // Only a step down from the ridge tile, not a silhouette. At 0.34 toward
    // stoneDark the woodshed's mono-pitch roof read as a black rectangle
    // dropped on the grass.
    roofDark: tile.clone().lerp(P.stoneDark, 0.18),
    // Outbuildings get weathered grey board, so the yard has two roof
    // materials rather than two copies of the same lozenge.
    // Grey, genuinely. Two thirds rock plus a lick of pale timber came out a
    // warm tan indistinguishable from the walls under it.
    shedRoof: P.rock.clone().lerp(P.plaster, 0.34),
    shedRoofDark: P.rockDark.clone().lerp(P.rock, 0.40),
    // Shingle courses: a step down from the tile, not a black gap. At full
    // roofDark the two bands read as slots cut through the roof.
    roofCourse: tile.clone().lerp(P.stoneDark, 0.30),
  };
  const wl = B.waterLevel ?? 0;
  const half = (B.size / 2) * 0.92;

  const parts = [];   // {geo, x, z, y, yaw, s}
  const emit = (piece, x, y, z, yaw, s = 1) => {
    parts.push({ geo: piece.geo, x, y, z, yaw, s });
  };

  // -- route walk -----------------------------------------------------------
  const N = 600;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const s = roads.sample(i / N);
    pts.push({ x: s.x, z: s.z, tx: Math.cos(s.heading), tz: -Math.sin(s.heading) });
  }

  /** Distance from the road centre out to the point where isOnRoad goes false. */
  const edgeOffset = (x, z, nx, nz) => {
    let d = 2;
    while (d < 26 && roads.isOnRoad(x + nx * d, z + nz * d)) d += 1;
    return d;
  };

  const flatness = (x, z, r) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const h = T.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    return hi - lo;
  };

  // -- 1. CHALETS -----------------------------------------------------------
  // At most `maxHomes` per map, each a good distance from the last, each on a
  // genuinely flat open shelf 22-55 m off the route so it is IN the frame when
  // the car passes but never in the racing line.
  const maxHomes = B.id === 'desert' ? 1 : 2;
  const homes = [];
  const homeGeo = [];
  for (let v = 0; v < 2; v++) homeGeo.push(chalet(new Rng((seed * 977 + v * 31) >>> 0), K));
  const shedGeo = woodshed(new Rng((seed * 613 + 5) >>> 0), K);
  const panelGeo = fencePanel(rng, K, 4.2);

  // Homes are ANCHORED to fixed fractions of the lap and the search spirals
  // OUTWARD from each anchor, taking the nearest shelf that qualifies. Two
  // things this buys over the old "walk from index 0, take the first two hits":
  // the houses can never end up on the same straight, and each one lands as
  // close as the terrain allows to a chosen point on the route rather than
  // wherever the first flat patch happened to be — which was reliably in the
  // opening third of the lap and therefore in none of the capture frames.
  // The anchors are the quarter and three-quarter marks, i.e. the two points
  // furthest from the start line and from each other.
  const anchors = maxHomes === 1 ? [0.24] : [0.24, 0.79];
  const SPAN = Math.round(N * 0.055);   // +/- ~5% of the lap to find a shelf

  for (let slot = 0; slot < anchors.length; slot++) {
   const c = Math.round(anchors[slot] * N);
   for (let k = 0; k <= SPAN * 2 && homes.length === slot; k++) {
    // 0, +1, -1, +2, -2 ... so the nearest qualifying shelf to the anchor wins.
    const i = (c + (k % 2 ? (k + 1) >> 1 : -(k >> 1)) + N) % N;
    const p = pts[i];
    const nx = -p.tz, nz = p.tx;
    for (const side of rng.bool(0.5) ? [1, -1] : [-1, 1]) {
      // Pushed back out to 34-50 m. At 26-38 the house filled an eighth of the
      // hero frame and became its subject; the reference's buildings sit IN the
      // landscape, close enough to share the shot with the road but never
      // competing with the car for the eye.
      const off = rng.float(34, 50);
      const x = p.x + nx * side * off;
      const z = p.z + nz * side * off;
      if (Math.abs(x) > half || Math.abs(z) > half) continue;
      const h = T.heightAt(x, z);
      if (h < wl + 4) continue;
      if (roads.isBlocked(x, z)) continue;
      // Relaxed from 0.965 / 1.7. Alpine's drivable band rolls +/-20 m over
      // 190 m, so a shelf that flat barely exists beside the route and the
      // search ran the whole lap without a single hit.
      if (T.normalAt(x, z, 4).y < 0.945) continue;
      if (flatness(x, z, 9) > 2.8) continue;
      let clash = false;
      for (const o of homes) if ((o.x - x) ** 2 + (o.z - z) ** 2 < 260 * 260) clash = true;
      if (clash) continue;

      // Face the house square to the road: ridge parallel to the tangent.
      const yaw = Math.atan2(p.tz, p.tx) + rng.float(-0.22, 0.22);
      const g = homeGeo[homes.length % homeGeo.length];
      emit(g, x, h - 0.6, z, yaw);
      blockers.push({ x, z, r: g.r + 7 });
      colliders.push({ x, z, r: g.r * 0.8 });

      // Yard furniture: a shed and a short run of fence, both offset toward
      // the road so the group reads as one homestead.
      const sa = yaw + Math.PI / 2;
      const sx = x + Math.cos(sa) * 11 * side, sz = z - Math.sin(sa) * 11 * side;
      if (!roads.isBlocked(sx, sz) && T.heightAt(sx, sz) > wl + 3) {
        emit(shedGeo, sx, T.heightAt(sx, sz) - 0.25, sz, yaw + rng.float(-0.5, 0.5));
        blockers.push({ x: sx, z: sz, r: shedGeo.r + 4 });
        colliders.push({ x: sx, z: sz, r: shedGeo.r * 0.7 });
      }
      for (let k = -2; k <= 2; k++) {
        const fx = x + Math.cos(yaw) * k * 4.2 + Math.cos(sa) * 13 * -side;
        const fz = z - Math.sin(yaw) * k * 4.2 - Math.sin(sa) * 13 * -side;
        if (roads.isBlocked(fx, fz)) continue;
        const fh = T.heightAt(fx, fz);
        if (fh < wl + 2) continue;
        emit(panelGeo, fx, fh - 0.25, fz, yaw);
      }
      homes.push({ x, z });
      break;
    }
   }
  }

  // -- 2. CORNER MARKER BOARDS ---------------------------------------------
  // Only on the outside of REAL corners, and only every 90 m or so. A board on
  // every bend turns a rally stage into a slalom course.
  const boardGeo = markerBoard(rng, K);
  const placed = [];
  const MAXB = 22;
  for (let i = 0; i < N && placed.length < MAXB; i++) {
    const a = pts[(i - 4 + N) % N], c = pts[(i + 4) % N];
    // Turn vector: the change in tangent points INTO the corner, so its
    // negation is the outside — no sign conventions to get wrong.
    let dx = c.tx - a.tx, dz = c.tz - a.tz;
    const m = Math.hypot(dx, dz);
    if (m < 0.30) continue;               // not a corner
    dx = -dx / m; dz = -dz / m;
    const p = pts[i];
    let near = false;
    for (const q of placed) if ((q.x - p.x) ** 2 + (q.z - p.z) ** 2 < 90 * 90) near = true;
    if (near) continue;
    const e = edgeOffset(p.x, p.z, dx, dz) + 1.8;
    const x = p.x + dx * e, z = p.z + dz * e;
    if (Math.abs(x) > half || Math.abs(z) > half) continue;
    const h = T.heightAt(x, z);
    if (h < wl + 0.6) continue;
    if (isBlocked(x, z)) continue;
    // Face the board back down the road at the approaching car.
    emit(boardGeo, x, h - 0.25, z, Math.atan2(-p.tz, p.tx) + Math.PI / 2);
    blockers.push({ x, z, r: 3.0 });
    placed.push({ x, z });
  }

  // -- BAKE -----------------------------------------------------------------
  // One instanced mesh per distinct geometry, so the whole built world costs a
  // handful of draw calls however many pieces end up on the map.
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const byGeo = new Map();
  for (const p of parts) {
    let a = byGeo.get(p.geo);
    if (!a) byGeo.set(p.geo, (a = []));
    a.push(p);
  }
  const dummy = new THREE.Object3D();
  for (const [geo, list] of byGeo) {
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.yaw, 0);
      dummy.scale.setScalar(p.s);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    group.add(inst);
  }

  group.userData.stats = { homes: homes.length, boards: placed.length, pieces: parts.length };
  if (typeof window !== 'undefined') window.__LM = { ...group.userData.stats, at: homes };
  return { group, isBlocked, colliders };
}
