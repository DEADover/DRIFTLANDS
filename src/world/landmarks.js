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
  const W = o.w ?? rng.float(8.5, 11.0);      // along X (ridge direction)
  const D = o.d ?? rng.float(6.5, 8.0);       // across Z
  const plinth = rng.float(0.7, 1.3);
  const h1 = rng.float(2.9, 3.4);
  const h2 = rng.float(2.3, 2.8);

  // Plinth — deliberately oversized and sunk, so a chalet on a slight slope
  // never shows daylight under a corner.
  b.box(W * 1.04, plinth + 1.6, D * 1.04, K.stoneDark, { y: (plinth + 1.6) / 2 - 1.6 });
  // Ground floor: pale plaster.
  b.box(W, h1, D, K.plaster, { y: plinth + h1 / 2 });
  // Upper storey: dark timber, slightly proud of the plaster.
  b.box(W * 1.02, h2, D * 1.03, K.wood, { y: plinth + h1 + h2 / 2 });
  // Balcony band — one dark stripe under the eaves reads as a balcony rail from
  // any angle and costs 12 triangles.
  b.box(W * 1.12, 0.28, D * 1.14, K.woodDark, { y: plinth + h1 + h2 * 0.62 });
  b.box(W * 1.10, 0.22, D * 1.12, K.woodPale, { y: plinth + h1 + h2 * 0.30 });

  // Roof: wide eaves, shallow-ish pitch, warm tile.
  const rw = W * 1.20, rd = D * 1.34, rh = rng.float(2.4, 3.2);
  const top = plinth + h1 + h2;
  b.gable(rw, rh, rd, K.roofTile, { y: top });
  // Ridge cap and a darker gable end give the roof plane two values, so it does
  // not read as one flat lozenge from directly above.
  b.box(rw * 1.01, 0.22, 0.5, K.roofDark, { y: top + rh - 0.08 });
  // Chimney.
  b.box(0.85, 2.0, 0.85, K.stone, { x: W * rng.float(-0.30, 0.30), y: top + rh * 0.55, z: D * 0.16 });

  return { geo: b.build(), r: Math.max(rw, rd) * 0.45, height: top + rh };
}

/** Open-fronted timber woodshed with a stacked log wall. */
function woodshed(rng, K) {
  const b = new GeoBuilder();
  const W = rng.float(4.0, 5.4), D = rng.float(2.8, 3.6), H = rng.float(2.2, 2.7);
  b.box(W, 0.3, D, K.woodDark, { y: 0.15 });
  for (const sx of [-1, 1]) b.box(0.26, H, 0.26, K.wood, { x: sx * (W / 2 - 0.2), y: H / 2, z: -D / 2 + 0.2 });
  for (const sx of [-1, 1]) b.box(0.26, H * 0.86, 0.26, K.wood, { x: sx * (W / 2 - 0.2), y: H * 0.43, z: D / 2 - 0.2 });
  b.box(W, H * 0.9, 0.3, K.woodDark, { y: H * 0.45, z: -D / 2 + 0.1 });
  // Mono-pitch roof, tilted toward the open front.
  b.box(W * 1.16, 0.22, D * 1.24, K.roofDark, { y: H + 0.1, rx: 0.20 });
  // Log ends — a stack of short cylinders facing out is unmistakable at
  // any distance and sells the building as lived-in.
  const rows = 3, cols = 5;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      b.cyl(0.22, 0.22, D * 0.7, 5, r % 2 ? K.woodPale : K.dead, {
        rx: Math.PI / 2,
        x: -W * 0.34 + (c / (cols - 1)) * W * 0.68 + rng.float(-0.05, 0.05),
        y: 0.42 + r * 0.46,
        z: 0.1,
      });
    }
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
  const K = {
    ...P,
    roofDark: P.roofTile.clone().offsetHSL(0, 0.02, -0.10),
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

  for (let i = 0; i < N && homes.length < maxHomes; i += 3) {
    const p = pts[i];
    const nx = -p.tz, nz = p.tx;
    for (const side of rng.bool(0.5) ? [1, -1] : [-1, 1]) {
      const off = rng.float(24, 46);
      const x = p.x + nx * side * off;
      const z = p.z + nz * side * off;
      if (Math.abs(x) > half || Math.abs(z) > half) continue;
      const h = T.heightAt(x, z);
      if (h < wl + 4) continue;
      if (roads.isBlocked(x, z)) continue;
      if (T.normalAt(x, z, 4).y < 0.965) continue;
      if (flatness(x, z, 9) > 1.7) continue;
      let clash = false;
      for (const o of homes) if ((o.x - x) ** 2 + (o.z - z) ** 2 < 420 * 420) clash = true;
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
  return { group, isBlocked, colliders };
}
