import * as THREE from 'three';
import { Rng } from '../core/rng.js';

/**
 * WATER — stylised alpine lakes.
 *
 * CONTRACT (game.js depends on this):
 *   new Water(palette, biome)   // optional 3rd arg: terrain
 *   .mesh        THREE.Object3D added to the scene
 *   .update(dt)
 *   .contains(x, z, height) -> boolean
 *
 * ---------------------------------------------------------------------------
 * HOW THE SHORELINE IS MADE
 *
 * v0 was one giant quad at biome.waterLevel. Two things were wrong with that:
 * the level sat below the floor of the world so nothing was ever wet, and even
 * where it wasn't, a single quad has no idea how deep the water under it is,
 * so every pixel of the lake was the same blue right up to a hard geometric
 * edge.
 *
 * This version bakes depth into the mesh. The surface is a 5 m lattice clipped
 * to the flooded cells, carrying a per-vertex `aDepth` = surface minus bed.
 * That one attribute buys everything the reference shows:
 *
 *   - a pale cyan shelf in the first couple of metres, cobalt in the middle;
 *   - a foam line that follows the true waterline, because depth -> 0 there,
 *     rather than a ring drawn at some fixed radius;
 *   - transparency that fades in with shallowness, so the bed and any rock
 *     standing in the water read through the shallows and vanish in the deeps.
 *
 * The shoreline itself is never drawn as an edge at all: the terrain is opaque
 * and higher than the surface everywhere outside the lake, so it clips the
 * water for us and the outline is exactly as organic as the ground is.
 *
 * WHY THE BUILD IS DEFERRED
 * game.js constructs Water as `new Water(palette, biome)` — no terrain, no
 * seed — so at construction time there is no way to ask how deep anything is.
 * bridges.js IS handed {terrain, seed} and is built immediately afterwards, so
 * it parks that context in lake.js and the lattice is built on the first
 * update(), which always runs before the first render. Pass terrain as a third
 * constructor argument and it builds eagerly instead.
 */

// ---------------------------------------------------------------------------
// LAKE CONTEXT — the handshake between this file and bridges.js.
//
// These two modules have to agree on exactly one number, the surface height, or
// the bridge floats over a dry valley / drowns in a lake. game.js builds the
// Water with `new Water(palette, biome)` — no terrain, no roads, no seed — and
// hands bridges.js the full ctx one line later, so bridges.js parks it here and
// this file picks it up on its first update(). It lived in a third module last
// round; folding it in keeps the whole water subsystem inside the two files
// that are actually owned together.
//
// WHY THE LEVEL IS CHOSEN, NOT DECLARED
// -------------------------------------
// biomes.js declares alpine `waterLevel: -8` and digs lake bowls down to -30,
// which does produce lakes — 3-6% of the map — but they are wherever the bowl
// noise happens to put them and the ROUTE NEVER TOUCHES ONE. Measured over the
// three alpine presets: the lowest point the road reaches is +18.0 m (seed
// 1337), +8.8 (4242), +11.6 (8888), all of them twenty to fifty metres above a
// -8 water plane. So the lake was always half a kilometre off in a corner, the
// hero frame never contained a drop of water, `wetSpans` came back empty and
// not one bridge was ever built.
//
// bridges.js therefore picks the level off the route itself (see chooseLevel):
// the valley fills to a little above the lowest saddle the road crosses, so
// there is water against the drive by construction on every seed, and the road
// dips into it at exactly one place — which is where the bridge goes.
let CTX = null;

export function setLakeContext(ctx) {
  CTX = ctx
    ? {
        terrain: ctx.terrain, biome: ctx.biome, seed: ctx.seed,
        level: ctx.level, roads: ctx.roads, plan: ctx.plan ?? null,
      }
    : null;
}

export function getLakeContext(biome) {
  if (!CTX) return null;
  if (biome && CTX.biome && CTX.biome.id !== biome.id) return null;
  return CTX;
}

/** The height the visible water surface actually sits at, in metres. */
export function lakeLevel(biome) {
  const c = getLakeContext(biome);
  if (c && Number.isFinite(c.level)) return c.level;
  return biome?.waterLevel ?? -3;
}

/**
 * Stylised water colours. Taken off the reference frame rather than the
 * palette: the palette's alpine blue is a touch grey-green and the client
 * image is an unapologetic saturated cobalt with cyan shallows.
 */
export const LAKE_COLORS = {
  alpine: {
    deep: 0x0a4cae,
    mid: 0x1275d6,
    shallow: 0x39a8e4,
    shore: 0x74d0ee,
    foam: 0xf2fbff,
  },
};

export function lakeColors(biome, palette) {
  const c = LAKE_COLORS[biome?.id];
  if (c) return c;
  return {
    deep: palette.waterDeep,
    mid: palette.water,
    shallow: palette.water,
    shore: palette.waterFoam,
    foam: palette.waterFoam,
  };
}

// ===========================================================================
// TARN PLANNING AND BASIN CARVING
//
// THE PROBLEM THIS SOLVES
// -----------------------
// A lake is only visible where the ground is below the waterline, and alpine's
// ground is not below anything the road ever sees. biomes.js digs bowls with a
// noise field; roads.js lays its loop on a completely independent one; the two
// never meet. Measured on the three alpine presets, the nearest open water to
// the car at the moment the shutter opens was 60 m, 260 m and 560 m, and the
// hero frame contained an 8% sliver of blue in one corner. Raising the plane
// does not fix it — filling the valley high enough to reach the hero camera
// puts a quarter of the ROAD under water, which is a swamp, not a rally stage.
//
// So the basins are dug where the drive is. A chain of tarns is planted along
// the route at a fixed stride, each one offset to alternating sides, and the
// ground inside each is pulled down to a bed a few metres below the road. The
// road itself is protected by a guard band keyed on distance to the centreline,
// so the carriageway always stands on its own causeway and the road ribbon —
// which roads.js has already built by the time this runs — never ends up
// floating over a hole.
//
// Every third station is a NECK instead: two lobes, one either side, with the
// guard tightened to a bridge deck's width. That is the crossing, and it is
// where bridges.js puts the timber.
//
// WHY THIS LIVES HERE AND NOT IN terrain.js
// The lake owns the shape of its own basin, and terrain.js has no idea a lake
// exists. This module is handed the live Terrain through the context, so it
// deforms the mesh it was given and wraps heightAt() so that physics, props,
// animals and the camera all agree with what is on screen. Nothing outside the
// two water files is edited.
// ===========================================================================

const CARVE = {
  CELL: 5,            // distance-field resolution, metres
  STRIDE: 280,        // route metres between tarns
  // The guard band is also the BANK. Ramping from untouched ground to eight
  // metres of cut over sixteen metres put a 1:1.4 wall of green right at the
  // verge — from this camera a cliff, and the shore-distance estimate the foam
  // and the pale shelf are keyed on collapses on a wall like that. Seventy
  // metres for the same drop is a bank you can read as a bank.
  // Also the RUN-OFF. The autopilot runs a good forty metres wide out of a fast
  // corner; measured, it spent three seconds of every ninety in open water when
  // the shore sat twenty-five metres off the verge. Water is a fair hazard, but
  // it should be something you reach by getting it wrong, not by taking a
  // normal line.
  ROAD_IN: 33,        // no carve within this of the centreline...
  ROAD_OUT: 88,       // ...full depth beyond this
  // AT A CROSSING THE WATER GOES UNDER THE ROAD, not up to it.
  //
  // Leaving nine metres of dry causeway either side of the centreline meant the
  // waterline never got within fifteen metres of the deck: the "bridge" was a
  // wide brown slab lying across a shallow trench, with its piles planted in
  // grass. Cutting to within a couple of metres of the centreline leaves the
  // road ribbon — which roads.js built before this ran and cannot be moved —
  // spanning the gap on a knife of ground, and the deck, which is wider than
  // the road and its verge together, covers it completely. What you see is
  // timber over open water with the trestles standing in it.
  NECK_IN: 6.5,
  NECK_OUT: 13.0,
  SPUR_IN: 5,
  SPUR_OUT: 22,
  FREEBOARD: 3.0,     // road surface above the tarn it runs beside
  NECK_FREEBOARD: 5.5,
  DEPTH: 8.5,         // bed below the surface at the middle
};

const sstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

/** Two-pass chamfer distance transform over a square grid of zero-seeds. */
function chamfer(d, N, C) {
  const a = C, b = C * Math.SQRT2;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + a);
      if (j > 0) v = Math.min(v, d[k - N] + a);
      if (i > 0 && j > 0) v = Math.min(v, d[k - N - 1] + b);
      if (i < N - 1 && j > 0) v = Math.min(v, d[k - N + 1] + b);
      d[k] = v;
    }
  }
  for (let j = N - 1; j >= 0; j--) {
    for (let i = N - 1; i >= 0; i--) {
      const k = j * N + i;
      let v = d[k];
      if (i < N - 1) v = Math.min(v, d[k + 1] + a);
      if (j < N - 1) v = Math.min(v, d[k + N] + a);
      if (i < N - 1 && j < N - 1) v = Math.min(v, d[k + N + 1] + b);
      if (i > 0 && j < N - 1) v = Math.min(v, d[k + N - 1] + b);
      d[k] = v;
    }
  }
}

function sampler(d, N, C, half) {
  return (x, z) => {
    const fi = (x + half) / C, fj = (z + half) / C;
    const i = Math.floor(fi), j = Math.floor(fj);
    if (i < 0 || j < 0 || i >= N - 1 || j >= N - 1) return 1e5;
    const u = fi - i, v = fj - j, k = j * N + i;
    return (d[k] * (1 - u) + d[k + 1] * u) * (1 - v)
         + (d[k + N] * (1 - u) + d[k + N + 1] * u) * v;
  };
}

/**
 * Plan the chain of tarns and return the carve field.
 *
 * @param {{terrain, biome, seed, roads}} ctx
 * @param {Array}  P   route polyline, each entry {x,z,nx,nz,ds,yT}
 * @returns {null|{lakes, crossings, heightAt, distToRoad}}
 */
export function planLakes(ctx, P) {
  const { terrain, biome, seed = 1337, roads } = ctx;
  if (biome?.id !== 'alpine' || !P || P.length < 32 || !terrain) return null;

  const size = biome.size ?? 1700;
  const half = size / 2;
  const C = CARVE.CELL;
  const N = Math.ceil(size / C) + 1;

  // --- distance to the main centreline ------------------------------------
  const dRg = new Float32Array(N * N).fill(1e5);
  for (const p of P) {
    const i = Math.round((p.x + half) / C), j = Math.round((p.z + half) / C);
    if (i < 0 || j < 0 || i >= N || j >= N) continue;
    dRg[j * N + i] = 0;
  }
  chamfer(dRg, N, C);
  const dRoute = sampler(dRg, N, C, half);

  // --- distance to any SPUR (roads.js draws branches this module never sees,
  //     and a spur hanging over a lake is the same broken picture as the main
  //     road hanging over one). Coarser grid: a spur only needs a keep-out.
  const CS = 10, NS = Math.ceil(size / CS) + 1;
  const dSg = new Float32Array(NS * NS).fill(1e5);
  if (roads?.isBlocked) {
    for (let j = 0; j < NS; j++) {
      const z = -half + j * CS;
      for (let i = 0; i < NS; i++) {
        const x = -half + i * CS;
        if (dRoute(x, z) > 30 && roads.isBlocked(x, z)) dSg[j * NS + i] = 0;
      }
    }
    chamfer(dSg, NS, CS);
  }
  const dSpur = sampler(dSg, NS, CS, half);

  // --- stations ------------------------------------------------------------
  const n = P.length;
  const cum = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) { cum[i] = total; total += P[i].ds; }
  const stationAt = (s) => {
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m + 1; else hi = m; }
    return lo;
  };

  const rng = new Rng(((seed * 2654435761) ^ 0x7a4e) >>> 0);
  const lakes = [];
  const crossings = [];
  let ord = 0;

  // Lowest ground the ROAD reaches over an along-route window. The waterline is
  // set from this, not from the station itself: a tarn 400 m long sits beside
  // 400 m of road, and if the road dips four metres over that frontage a level
  // taken at the midpoint puts water over the carriageway.
  const roadLow = (station, reach) => {
    let lo = Infinity;
    const steps = Math.ceil(reach);
    for (let k = -steps; k <= steps; k++) {
      const p = P[(station + k + n * 4) % n];
      if (p.yT < lo) lo = p.yT;
    }
    return lo;
  };

  // How straight and how level the road is over ±reach. A crossing wants both:
  // the deck is a straight, dead-flat object, so siting it on a crest or in a
  // bend is what puts the car's line off the planks.
  const crossingCost = (station, reach) => {
    let lo = Infinity, hi = -Infinity, bend = 0;
    const a = P[(station - reach + n * 4) % n], b = P[(station + reach) % n];
    for (let k = -reach; k <= reach; k++) {
      const p = P[(station + k + n * 4) % n];
      lo = Math.min(lo, p.yT); hi = Math.max(hi, p.yT);
    }
    bend = Math.acos(Math.max(-1, Math.min(1, a.tx * b.tx + a.tz * b.tz)));
    return (hi - lo) + bend * 55;
  };

  /** Lowest and highest ground the road reaches over ±reach samples. */
  const roadBand = (station, reach) => {
    let lo = Infinity, hi = -Infinity;
    const steps = Math.ceil(reach);
    for (let k = -steps; k <= steps; k++) {
      const p = P[(station + k + n * 4) % n];
      if (p.yT < lo) lo = p.yT;
      if (p.yT > hi) hi = p.yT;
    }
    return [lo, hi];
  };

  /** Elliptical basin in the route frame: long across the road, short along it. */
  const mk = (p, side, Ra, Rc, o, level, neck, station) => ({
    x: p.x + p.nx * o * side,
    z: p.z + p.nz * o * side,
    tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz,
    Ra, Rc, o, level, floor: level - CARVE.DEPTH, neck, station,
  });

  // WHERE THE CHAIN STARTS.
  //
  // Phase matters. Stations laid from an arbitrary origin put the first bridge
  // wherever the modulo happens to land, and on a four-kilometre loop that is
  // usually two kilometres from anywhere the player will be in the first
  // minute — which is exactly how the crossing came to be a thing that existed
  // in the world and had never once appeared on screen. The chain is therefore
  // phased off the START LINE, with the first crossing about three hundred
  // metres in: a stage's signature landmark belongs early, where it is met
  // rather than merely present.
  let s0 = 0;
  const sp = roads?.spawn?.();
  if (sp) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = (P[i].x - sp.x) ** 2 + (P[i].z - sp.z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    s0 = cum[bi] + 300;
  }

  for (let s = s0; s < s0 + total - 40; s += CARVE.STRIDE) {
    const nominal = stationAt(((s % total) + total) % total);
    // Every third station is a crossing. One bridge on a four-kilometre loop is
    // a bridge nobody ever sees: the camera reaches about 200 m, so a landmark
    // has to recur every few hundred metres to be part of the drive at all.
    const neck = (ord % 3) === 0;
    ord++;

    if (neck) {
      // Slide the crossing along the route to the flattest, straightest spot
      // within half a stride. This is the same fix as making the deck wide: a
      // car following the centreline has to arrive square to the bridge.
      let station = nominal, best = Infinity;
      for (let k = -70; k <= 70; k += 5) {
        const c = (nominal + k + n * 4) % n;
        const cost = crossingCost(c, 60);
        if (cost < best) { best = cost; station = c; }
      }
      const p = P[station];
      const Ra = 34 + rng.float() * 12;         // short along the road: a neck
      // The waterline has to clear the lowest road the lobes touch, but no
      // lower: a level dragged down by a dip eighty metres away turns a neck
      // into a gorge, and the deck fascia into a ten-metre timber wall.
      const level = Math.max(
        roadLow(station, Ra * 1.3) - CARVE.NECK_FREEBOARD,
        p.yT - 8.5,
      );
      // A neck needs water on BOTH sides or it is not a crossing, just a bay,
      // so it is the WORSE of the two banks that has to be acceptable. Shrink
      // the lobes until both fit rather than giving up on the crossing.
      let made = null;
      for (const Rc of [162, 138, 116, 96, 78]) {
        const a = mk(p, 1, Ra, Rc, Rc * 0.50, level, true, station);
        const b = mk(p, -1, Ra, Rc, Rc * 0.50, level, true, station);
        if (basinCost(terrain, a, level) < 20 && basinCost(terrain, b, level) < 20) {
          made = [a, b];
          break;
        }
      }
      if (made) { lakes.push(...made); crossings.push({ station, level, Ra }); }
      continue;
    }

    // A tarn beside the drive. Centred at 0.72 of its own half width, so the
    // basin reaches ACROSS the centreline and it is the road guard, not the
    // ellipse, that decides where the shore lands: offsetting the whole ellipse
    // clear of the road put the waterline eighty metres out, past the frame.
    let best = null, bestCost = Infinity;
    for (const ds of [0, -60, 60]) {
      const st = (nominal + ds + n * 4) % n;
      const p = P[st];
      for (const side of [(ord & 1) ? 1 : -1, (ord & 1) ? -1 : 1]) {
        for (const Rc of [150, 126, 104]) {
          // A tarn's frontage may not be longer than the stretch of road it can
          // stay level with. Take the frontage the ellipse wants, and shorten
          // it until the carriageway along it rises and falls by less than a
          // dozen metres — otherwise the far end of the lake ends up twenty
          // metres below the road and the bank between them is a quarry face.
          let Ra = 175 + Rc * 0.6;
          let lo = 0;
          for (let t = 0; t < 6; t++) {
            const [l, h] = roadBand(st, Ra * 0.85);
            lo = l;
            if (h - l < 12 || Ra < 100) break;
            Ra *= 0.78;
          }
          const level = lo - CARVE.FREEBOARD;
          const L = mk(p, side, Ra, Rc, Rc * 0.72, level, false, st);
          const cost = basinCost(terrain, L, level);
          // Bigger is better when it costs the same, so bias by basin size.
          const score = cost - Rc * 0.045 - Ra * 0.02;
          if (score < bestCost) { bestCost = score; best = L; }
        }
      }
    }
    if (best && bestCost < 20) lakes.push(best);
  }
  if (!lakes.length) return null;

  for (const L of lakes) {
    L.Rmax = Math.max(L.Ra, L.Rc) * 1.30;
    L.R2out = L.Rmax * L.Rmax;
    // axis-aligned half extents, for patch bounding boxes
    L.hx = Math.abs(L.tx) * L.Ra + Math.abs(L.nx) * L.Rc;
    L.hz = Math.abs(L.tz) * L.Ra + Math.abs(L.nz) * L.Rc;
  }

  // ONE BODY OF WATER HAS ONE SURFACE — AND A CROSSING OUTRANKS A VIEW.
  //
  // Basins are sited independently and each takes its level from the road it
  // sits beside, so two that touch arrive with different surface heights. On
  // screen that is unmistakable and horrible: a hard zigzag seam where one
  // lattice cuts the other, a fifty-metre band of foam along it, and the rocks
  // of the higher tarn hanging in the air over the lower one.
  //
  // Where the disagreement is small, both are pulled to the LOWER level —
  // lowering a tarn only ever gives its stretch of road more freeboard — and
  // what comes out is one big irregular lake instead of a row of discs. Where
  // it is large, they cannot be one lake at all: pulling a crossing's lobes
  // down to a neighbour ten metres lower turns the neck into a gorge and the
  // deck fascia into a timber wall the height of a house. So the crossing keeps
  // its level and the merely scenic tarn is dropped.
  const overlap = (A, B) => Math.hypot(A.x - B.x, A.z - B.z) < (A.Rmax + B.Rmax) * 0.82;
  const kept = [];
  for (const L of lakes) {
    let reject = false;
    for (const K of kept) {
      if (K.dead || !overlap(L, K)) continue;
      if (Math.abs(L.level - K.level) <= 3.5) {
        const lo = Math.min(L.level, K.level);
        L.level = lo; K.level = lo;
      } else if (K.neck) {
        reject = true; break;
      } else if (L.neck) {
        K.dead = true;
      } else {
        reject = true; break;
      }
    }
    if (!reject) kept.push(L);
  }
  const live = kept.filter((L) => !L.dead);
  lakes.length = 0;
  lakes.push(...live);
  if (!lakes.length) return null;
  for (const L of lakes) L.floor = L.level - CARVE.DEPTH;
  for (let i = crossings.length - 1; i >= 0; i--) {
    const c = crossings[i];
    const lobes = lakes.filter((L) => L.neck && L.station === c.station);
    if (lobes.length < 2) { crossings.splice(i, 1); continue; }
    c.level = Math.min(lobes[0].level, lobes[1].level);
  }

  // --- the carve -----------------------------------------------------------
  const guardOf = (L, x, z) => {
    const dr = dRoute(x, z);
    const g = L.neck
      ? sstep(CARVE.NECK_IN, CARVE.NECK_OUT, dr)
      : sstep(CARVE.ROAD_IN, CARVE.ROAD_OUT, dr);
    return g * sstep(CARVE.SPUR_IN, CARVE.SPUR_OUT, dSpur(x, z));
  };

  const raw = terrain.heightAt.bind(terrain);
  const carved = (x, z) => {
    let h = raw(x, z);
    for (let i = 0; i < lakes.length; i++) {
      const L = lakes[i];
      const dx = x - L.x, dz = z - L.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > L.R2out) continue;
      const ua = (dx * L.tx + dz * L.tz) / L.Ra;
      const uc = (dx * L.nx + dz * L.nz) / L.Rc;
      const u = Math.hypot(ua, uc);
      const dig = sstep(0.98, 0.36, u);
      // A ring that guarantees the shoreline CLOSES inside the disc. The water
      // lattice is clipped to the disc, so if the natural ground outside it is
      // below the waterline the lake ends in a wall of blue. This only ever
      // raises ground, and only where it was already too low — most of the way
      // round it does nothing at all.
      // Wide and gentle. The terrain mesh has 8.7 m facets; a berm that gains
      // its metre and a half over ten metres of ground is a ridge the mesh
      // cannot resolve, and everything placed analytically on top of it — the
      // shore boulders especially — ends up hanging in the air beside it.
      const berm = sstep(0.58, 0.88, u) * (1 - sstep(0.98, 1.38, u));
      if (dig <= 0 && berm <= 0) continue;
      const g = guardOf(L, x, z);
      if (g <= 0) continue;
      if (dig > 0) {
        const k = dig * g;
        // The bed keeps a fifth of whatever relief the meadow had. A dead flat
        // floor gives a dead flat depth field, and depth is what drives the
        // colour ramp — the whole body then comes out one slab of cobalt with
        // a stripe of cyan round the edge.
        const relief = Math.max(-2.5, Math.min(5.0, (h - L.level) * 0.30));
        const target = L.level + 3.0 - (L.level + 3.0 - (L.floor + relief)) * k;
        if (target < h) h = target;
      }
      if (berm > 0) {
        const need = L.level + 1.5;
        if (h < need) h += (need - h) * berm * g;
      }
    }
    return h;
  };

  return {
    lakes, crossings, raw, heightAt: carved, dRoute, dSpur,
    lakeAt: (x, z) => nearestLake(lakes, x, z),
  };
}

/**
 * How much ground this basin would have to move, in metres of average cut.
 *
 * A tarn wants a hollow, not a hillside: cut a bowl into rising ground and you
 * get a bomb crater with a fifteen-metre lip on the uphill side, which from
 * this camera reads as a quarry. The cost is the mean height above the intended
 * waterline, with the steepest quarter of the rim weighted extra — that is the
 * part that turns into the lip.
 */
function basinCost(terrain, L, level) {
  let sum = 0, worst = 0, n = 0;
  for (let a = 0; a < 16; a++) {
    const t = (a / 16) * Math.PI * 2;
    const ca = Math.cos(t), sa = Math.sin(t);
    for (const f of [0.4, 0.75, 1.0]) {
      const ox = ca * L.Ra * f, oz = sa * L.Rc * f;
      const h = terrain.heightAt(
        L.x + L.tx * ox + L.nx * oz,
        L.z + L.tz * ox + L.nz * oz,
      ) - level;
      sum += h; n++;
      if (h > worst) worst = h;
    }
  }
  return sum / n + Math.max(0, worst - 34) * 0.6;
}

/**
 * Push the plan into the world: wrap the height query so every other system
 * agrees with it, then re-drape the terrain mesh that terrain.js already built.
 */
export function carveLakes(ctx, plan) {
  if (!plan) return;
  const { terrain, palette, biome, seed = 1337 } = ctx;
  terrain.heightAt = plan.heightAt;

  const mesh = terrain.mesh;
  const posAttr = mesh?.geometry?.attributes?.position;
  if (!posAttr) return;
  const pos = posAttr.array;
  for (let i = 0; i < pos.length; i += 3) pos[i + 1] = plan.heightAt(pos[i], pos[i + 2]);
  posAttr.needsUpdate = true;

  // Recolour the bed. Under three metres of this water nothing shows through,
  // but the first couple of metres are glassy on purpose, and green meadow
  // grass reading through the shallows is the tell that the lake is a sticker.
  const colAttr = mesh.geometry.attributes.color;
  if (colAttr) {
    const col = colAttr.array;
    // GRANITE, NOT SAND. The reference's tarn is held in grey rock — that is
    // what an alpine lake sits in, and it is also what keeps the shoreline
    // reading as an edge rather than as a beach. Painting the wetted bed with
    // the biome's `sand` swatch gave a pale ochre strand that from this camera
    // was the same colour as the road.
    const silt = new THREE.Color(palette?.rock ?? 0x8f9099).lerp(
      new THREE.Color(palette?.terrain?.sand ?? 0xb9ae92), 0.22,
    );
    const wetc = new THREE.Color(palette?.rockShadow ?? 0x5f6069);
    const c = new THREE.Color();

    // THE BANK KEEPS THE MEADOW'S COLOUR.
    //
    // biomes.js paints the ground off an ALTITUDE ramp, and this carve moves
    // ground down by up to eight metres — which walks the bank straight into
    // the pale, low-altitude end of that ramp. The result was a broad bone-white
    // strand round every tarn that nothing in the reference has and that read,
    // at this camera height, as a beach. So the ground above the waterline is
    // repainted at the altitude it USED to be: the lake changes the shape of the
    // valley, not what is growing on it.
    let cols = null;
    try { cols = terrain._swatches?.(); } catch { cols = null; }
    const repaint = cols && typeof biome?.colorAt === 'function';

    for (let t = 0; t < pos.length; t += 9) {
      const mx = (pos[t] + pos[t + 3] + pos[t + 6]) / 3;
      const my = (pos[t + 1] + pos[t + 4] + pos[t + 7]) / 3;
      const mz = (pos[t + 2] + pos[t + 5] + pos[t + 8]) / 3;
      const L = nearestLake(plan.lakes, mx, mz);
      if (!L) continue;
      const d = L.level - my;
      // Only the wetted bed and a hand's width of strand above it. A band that
      // reached a metre and a half up the bank painted the whole verge — and
      // the meadow beside it — the colour of the road, and from this camera the
      // carriageway stopped being findable at all.
      // A METRE UNDER, not at the waterline.
      //
      // This runs on the terrain MESH — 8.7 m facets — while the water lattice
      // is built from analytic heights on a 4 m grid, so the two disagree by a
      // metre or so along any shelving shore. Painting everything at or below
      // the waterline therefore painted a wide band of ground that the water
      // never actually covered: a grey-white beach round every tarn, the single
      // most conspicuous thing in the frame. Staying a clear metre under the
      // surface keeps the strand inside the water on both accountings, and the
      // waterline itself is left as grass meeting blue, which is what most of
      // the reference's shoreline is anyway.
      if (d < 1.2) {
        if (!repaint || d < -22) continue;
        const h0 = plan.raw(mx, mz);
        if (h0 - my < 1.0) continue;             // barely moved; leave it alone
        // face normal, for the slope term colorAt keys its rock on
        const ux = pos[t + 3] - pos[t], uy = pos[t + 4] - pos[t + 1], uz = pos[t + 5] - pos[t + 2];
        const vx = pos[t + 6] - pos[t], vy = pos[t + 7] - pos[t + 1], vz = pos[t + 8] - pos[t + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const ilen = 1 / (Math.hypot(nx, ny, nz) || 1);
        const slope = 1 - Math.abs(ny * ilen);
        biome.colorAt(c, cols, h0, slope, mx, mz, seed);
        // Keep a touch of the shading the terrain builder baked in, so the bank
        // does not come out as one flat wash beside faceted meadow.
        c.lerp(new THREE.Color(col[t], col[t + 1], col[t + 2]), 0.30);
        for (let v = 0; v < 9; v += 3) { col[t + v] = c.r; col[t + v + 1] = c.g; col[t + v + 2] = c.b; }
        continue;
      }
      // EXACTLY the same keep-out the water lattice uses, or the two disagree
      // and the difference shows up as a wide pale beach of wetted gravel with
      // no water on it — which is what the whole left third of the hero frame
      // had become.
      if (plan.dRoute(mx, mz) < (L.neck ? 10.3 : 18.0)) continue;
      // gravel right at the waterline, darker silt as it drops away
      const k = Math.min(1, sstep(1.2, 2.6, d) * 0.85);
      c.setRGB(col[t], col[t + 1], col[t + 2]);
      c.lerp(silt, k * 0.85).lerp(wetc, Math.min(1, Math.max(0, d / 6)) * 0.5);
      for (let v = 0; v < 9; v += 3) { col[t + v] = c.r; col[t + v + 1] = c.g; col[t + v + 2] = c.b; }
    }
    colAttr.needsUpdate = true;
  }

  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingSphere();
}

function nearestLake(lakes, x, z) {
  for (let i = 0; i < lakes.length; i++) {
    const L = lakes[i];
    const dx = x - L.x, dz = z - L.z;
    if (dx * dx + dz * dz > L.R2out) continue;
    const ua = (dx * L.tx + dz * L.tz) / L.Ra;
    const uc = (dx * L.nx + dz * L.nz) / L.Rc;
    if (ua * ua + uc * uc <= 1.0) return L;
  }
  return null;
}

const VERT = /* glsl */ `
  attribute float aDepth;
  attribute float aShore;
  varying float vDepth;
  varying float vShore;
  varying vec2 vWorld;
  varying vec3 vPos;
  uniform float uTime;
  void main() {
    vDepth = aDepth;
    vShore = aShore;
    vec3 p = position;
    // A slow swell, killed off in the shallows so the waterline stays put.
    float k = smoothstep(0.0, 2.5, aDepth);
    p.y += sin(p.x * 0.055 + uTime * 0.9) * 0.10 * k
         + sin(p.z * 0.041 - uTime * 0.7) * 0.08 * k;
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorld = wp.xz;
    vPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uMid;
  uniform vec3 uShallow;
  uniform vec3 uShore;
  uniform vec3 uFoam;
  uniform vec3 uSun;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  varying float vDepth;
  varying float vShore;
  varying vec2 vWorld;
  varying vec3 vPos;

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
               mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
  }

  void main() {
    float d = max(vDepth, 0.0);
    // Horizontal metres to the waterline. This, not depth, is what sets the
    // width of the shelf and the foam: on a bed sloping at 1:15 a 70 cm depth
    // band is ten metres wide on screen, which is why keying the foam off
    // depth alone painted the whole lake white.
    float s = max(vShore, 0.0);

    // --- shelf -> shallow -> mid -> deep ------------------------------------
    // Alpine tarns are 2-6 m deep, so a ramp authored for a nine-metre lake
    // never reaches its own deep colour and the whole body reads as one pale
    // cyan. The shelf is a couple of metres wide and then it is straight into
    // cobalt, which is what the reference does.
    vec3 col = uShore;
    col = mix(col, uShallow, smoothstep(0.2, 2.2, s));
    col = mix(col, uMid,     smoothstep(2.0, 7.5, s));
    col = mix(col, uDeep,    smoothstep(1.6, 4.8, d));

    // Broad ripple bands. Posterised, because everything else in this world is
    // cut paper and a smooth gradient reads as a different game.
    vec2 p = vWorld * 0.013;
    float w = noise(p + vec2(uTime * 0.05, uTime * 0.032));
    w += 0.5 * noise(p * 2.4 - vec2(uTime * 0.07, 0.0));
    w /= 1.5;
    float band = floor(w * 4.0) / 4.0;
    col = mix(col, col * 1.09, band);

    // --- foam at the waterline ---------------------------------------------
    // A bright lip about half a metre wide, chewed up by two noise octaves so
    // it is ragged and — importantly — ABSENT along stretches of shore. An
    // unbroken white piping all the way round the lake is the single loudest
    // tell that the water is a decal rather than a body of water.
    float chew = noise(vWorld * 0.11 + vec2(uTime * 0.05, uTime * 0.035));
    float chew2 = noise(vWorld * 0.38 - vec2(0.0, uTime * 0.14));
    float edge = 0.12 + chew * 0.40 + chew2 * 0.24;
    float lip  = 1.0 - smoothstep(edge * 0.15, edge, s);
    float wash = (1.0 - smoothstep(edge, edge + 1.1, s)) * (0.04 + 0.12 * chew2);
    float gate = smoothstep(0.22, 0.62, chew * 0.75 + chew2 * 0.45);
    float foam = clamp(lip + wash, 0.0, 1.0) * gate;
    col = mix(col, uFoam, foam * 0.82);

    // --- sun glitter --------------------------------------------------------
    float glint = pow(max(0.0, noise(p * 7.0 + uTime * 0.22)), 16.0);
    col += uSun * glint * 1.1 * smoothstep(0.6, 3.0, d);

    // Near-opaque past the shelf; glassy right at the edge so the bed and any
    // rock standing in the shallows read through.
    float alpha = mix(0.86, 0.97, smoothstep(0.4, 2.6, d));
    alpha = max(alpha, foam * 0.95);

    // Match the scene's exponential fog so the lake recedes correctly.
    float dist = length(vPos - cameraPosition);
    float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    col = mix(col, uFogColor, clamp(f, 0.0, 1.0));

    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`;

export class Water {
  constructor(palette, biome, terrain = null) {
    this.palette = palette;
    this.biome = biome;
    this.terrain = terrain;
    // Placeholder. The real level is not knowable yet — bridges.js has not run,
    // so nobody has looked at where the route goes. _ensureSurface() resolves
    // it before a single triangle is emitted.
    this.level = lakeLevel(biome);

    const C = lakeColors(biome, palette);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color(C.deep) },
        uMid: { value: new THREE.Color(C.mid) },
        uShallow: { value: new THREE.Color(C.shallow) },
        uShore: { value: new THREE.Color(C.shore) },
        uFoam: { value: new THREE.Color(C.foam) },
        uSun: { value: new THREE.Color(palette.sunColor) },
        uFogColor: { value: new THREE.Color(palette.fogColor) },
        uFogDensity: { value: palette.fogDensity },
      },
    });

    this.mesh = new THREE.Group();
    this.mesh.name = 'water';

    // A far sheet so anything beyond the lattice (the sea in coastal biomes,
    // the map rim) still reads as water rather than as a hole.
    const fg = new THREE.PlaneGeometry(biome.size * 2.4, biome.size * 2.4, 1, 1);
    fg.rotateX(-Math.PI / 2);
    const far = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: new THREE.Color(C.deep) }));
    far.position.y = this.level - 0.06;
    far.renderOrder = -1;
    this.mesh.add(far);
    this.far = far;

    this.surface = null;
    this._tries = 0;
    if (terrain) this._ensureSurface();
  }

  /** Build the lattice as soon as somebody has told lake.js about the terrain. */
  _ensureSurface() {
    if (this.surface || this._tries > 240) return;
    this._tries++;
    const ctx = getLakeContext(this.biome);
    const T = this.terrain ?? ctx?.terrain ?? null;
    if (!T) return;
    this.terrain = T;
    // Adopt the level bridges.js settled on, and move the backstop sheet with
    // it. Everything downstream (depth, shore distance, foam) is derived from
    // this number, so it has to be final before the lattice is built.
    this.plan = ctx?.plan ?? null;
    this.level = lakeLevel(this.biome);
    if (this.far) {
      this.far.position.y = this.level - 0.06;
      // The backstop is there for a SEA — the coastal biome, where water runs
      // off past the edge of the heightfield. An alpine tarn sits in a bowl in
      // the middle of the map and the lattice already covers every square metre
      // of it, so out here the sheet can only do harm: a flat unfogged slab of
      // cobalt lying across the whole world at the waterline, ready to poke out
      // through any distant saddle that happens to dip below it.
      this.far.visible = this.biome?.id !== 'alpine';
    }
    const m = this.plan ? this._buildPlanned(T, this.plan) : this._buildSurface(T);
    if (m) {
      m.renderOrder = 4;
      this.mesh.add(m);
      this.surface = m;
    } else {
      this._tries = 999; // no water anywhere in this biome; stop looking.
    }
  }

  /**
   * ONE LATTICE PATCH PER PLANNED TARN.
   *
   * The old builder rasterised the whole 1700 m map and emitted water wherever
   * the ground happened to be under one global plane. That is the right shape
   * for a sea and the wrong one for a chain of tarns at different altitudes:
   * the road climbs and falls forty metres round the loop, so a single plane
   * either misses every basin or drowns the carriageway.
   *
   * Each tarn therefore carries its own surface height and gets its own 4 m
   * patch, clipped to its disc — and, belt and braces, clipped away from the
   * road. The carve already guarantees the causeway stands proud, but the
   * ground under a road is the one place a stray triangle of blue would be
   * unmistakably wrong, so it is masked here too.
   */
  _buildPlanned(T, plan) {
    const pos = [], dep = [], sho = [];
    const acc = this._rockAcc();
    const pads = { rng: new Rng(((getLakeContext(this.biome)?.seed ?? 1337) * 40503) ^ 0x1111), pos: [], col: [] };
    const cell = 4.0;

    for (const L of plan.lakes) {
      const MX = Math.ceil((L.hx * 2) / cell) + 2;
      const MZ = Math.ceil((L.hz * 2) / cell) + 2;
      const M = Math.max(MX, MZ);
      const x0 = L.x - (M - 1) * cell * 0.5, z0 = L.z - (M - 1) * cell * 0.5;
      const depth = new Float32Array(M * M);
      // At a crossing the water is allowed right up to the deck edge (the deck
      // is 10 m half width). Blue immediately either side of the timber is the
      // whole difference between a bridge and a brown slab: hold the water back
      // fifteen metres and the eye reads a ramp lying on grass.
      const keep = L.neck ? 10.3 : 18.0;
      let wet = 0;
      for (let j = 0; j < M; j++) {
        const z = z0 + j * cell;
        for (let i = 0; i < M; i++) {
          const x = x0 + i * cell;
          let d = L.level - T.heightAt(x, z);
          const dx = x - L.x, dz = z - L.z;
          const ua = (dx * L.tx + dz * L.tz) / L.Ra;
          const uc = (dx * L.nx + dz * L.nz) / L.Rc;
          const u = Math.hypot(ua, uc);
          if (u > 1) d = Math.min(d, -3 - (u - 1) * L.Rc);       // clip to the basin
          // Never over the road — but RAMPED, not cut. A hard clip put the
          // waterline exactly on a 4 m lattice edge and the shore came out as a
          // sawtooth of white foam running parallel to the carriageway; the
          // ramp lands the zero crossing wherever it falls inside a cell.
          const dr = plan.dRoute(x, z);
          if (dr < keep) d = Math.min(d, (dr - keep) * 0.55);
          depth[j * M + i] = d;
          if (d > 0) wet++;
        }
      }
      if (wet < 6) continue;

      // HORIZONTAL METRES TO THE WATERLINE — the attribute the shelf colour and
      // the foam are both keyed on, and the one thing the old builder got
      // badly wrong once the banks were steep. Estimating it as depth / bed
      // slope is exact on a gentle shelf and nonsense on a bluff: five metres
      // of water hard against a 1:2 bank came out as "two metres from shore"
      // and the shader painted a fifty-metre collar of pale cyan and foam all
      // the way round every tarn.
      //
      // So it is a real distance transform now — seeded on the dry cells, run
      // over the patch — with the gradient estimate kept only for the first
      // cell, where it is both accurate and finer than the 4 m grid.
      const E = M - 1;
      const dist = new Float32Array(M * M);
      for (let k = 0; k < dist.length; k++) dist[k] = depth[k] > 0 ? 1e5 : 0;
      chamfer(dist, M, cell);
      const shore = new Float32Array(M * M);
      for (let j = 0; j < M; j++) {
        for (let i = 0; i < M; i++) {
          const k = j * M + i;
          const d = depth[k];
          const dx = (depth[k + (i < E ? 1 : 0)] - depth[k - (i > 0 ? 1 : 0)]) / (cell * ((i > 0 && i < E) ? 2 : 1));
          const dz = (depth[k + (j < E ? M : 0)] - depth[k - (j > 0 ? M : 0)]) / (cell * ((j > 0 && j < E) ? 2 : 1));
          const g = Math.hypot(dx, dz);
          const fine = g > 1e-4 ? d / g : d * 40;
          shore[k] = d <= 0 ? fine : (dist[k] >= cell ? dist[k] : Math.min(fine, cell));
        }
      }

      const F = {
        depth, shore, VN: M, N: E, cell, x0, z0, level: L.level,
        keepOut: (x, z) => plan.dRoute(x, z) < 15,
      };
      this._scatterRocksInto(acc, T, F);
      this._scatterPads(pads, F);

      const KEEP = -2.5;
      const push = (i, j) => {
        pos.push(x0 + i * cell, L.level, z0 + j * cell);
        dep.push(depth[j * M + i]);
        sho.push(Math.max(-60, Math.min(60, shore[j * M + i])));
      };
      for (let j = 0; j < E; j++) {
        for (let i = 0; i < E; i++) {
          const a = depth[j * M + i], b = depth[j * M + i + 1];
          const c = depth[(j + 1) * M + i], e = depth[(j + 1) * M + i + 1];
          if (a < KEEP && b < KEEP && c < KEEP && e < KEEP) continue;
          push(i, j); push(i, j + 1); push(i + 1, j);
          push(i + 1, j); push(i, j + 1); push(i + 1, j + 1);
        }
      }
    }

    this._finishRocks(acc);
    this._finishPads(pads);
    if (!pos.length) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(dep), 1));
    geo.setAttribute('aShore', new THREE.BufferAttribute(new Float32Array(sho), 1));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, this.material);
    m.name = 'lakeSurface';
    m.matrixAutoUpdate = false;
    return m;
  }

  /**
   * The clipped lattice. Cells whose four corners are all well clear of the
   * water are skipped, which is 97%+ of the map — a lake costs a few thousand
   * triangles, not a hundred thousand.
   */
  _buildSurface(T) {
    const S = this.biome.size;
    const half = S / 2;
    const cell = 5.0;
    const N = Math.ceil(S / cell);
    const VN = N + 1;

    const depth = new Float32Array(VN * VN);
    let wet = 0;
    for (let j = 0; j < VN; j++) {
      const z = -half + j * cell;
      for (let i = 0; i < VN; i++) {
        const x = -half + i * cell;
        const d = this.level - T.heightAt(x, z);
        depth[j * VN + i] = d;
        if (d > 0) wet++;
      }
    }
    if (wet === 0) return null;

    // Horizontal distance to the waterline, estimated as depth / bed slope.
    // The exact distance transform would be quantised to the 5 m cell, far too
    // coarse for a two-metre foam line; this is continuous and is accurate
    // precisely where it matters, in the first few metres off the shore.
    const shore = new Float32Array(VN * VN);
    for (let j = 0; j < VN; j++) {
      for (let i = 0; i < VN; i++) {
        const k = j * VN + i;
        const d = depth[k];
        const dx = (depth[k + (i < N ? 1 : 0)] - depth[k - (i > 0 ? 1 : 0)]) / (cell * ((i > 0 && i < N) ? 2 : 1));
        const dz = (depth[k + (j < N ? VN : 0)] - depth[k - (j > 0 ? VN : 0)]) / (cell * ((j > 0 && j < N) ? 2 : 1));
        const g = Math.hypot(dx, dz);
        shore[k] = g > 1e-4 ? d / g : d * 40;
      }
    }

    // Boulders in and around the water, and the foam collar they earn.
    // The shore field is stamped BEFORE the lattice is emitted, so the white
    // ring around each rock falls out of the same attribute that draws the
    // shoreline — no second pass, no decal, no sorting problem.
    const acc = this._rockAcc();
    this._scatterRocksInto(acc, T, {
      depth, shore, VN, N, cell, x0: -half, z0: -half, level: this.level,
    });
    this._finishRocks(acc);

    const pos = [];
    const dep = [];
    const sho = [];
    // 2.5 m of headroom: keep a ring of dry vertices so the shoreline
    // triangles exist and the terrain, not the mesh boundary, does the cutting.
    const KEEP = -2.5;
    const push = (i, j) => {
      pos.push(-half + i * cell, this.level, -half + j * cell);
      dep.push(depth[j * VN + i]);
      sho.push(Math.max(-60, Math.min(60, shore[j * VN + i])));
    };
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = depth[j * VN + i], b = depth[j * VN + i + 1];
        const c = depth[(j + 1) * VN + i], e = depth[(j + 1) * VN + i + 1];
        if (a < KEEP && b < KEEP && c < KEEP && e < KEEP) continue;
        push(i, j); push(i, j + 1); push(i + 1, j);
        push(i + 1, j); push(i, j + 1); push(i + 1, j + 1);
      }
    }
    if (!pos.length) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(dep), 1));
    geo.setAttribute('aShore', new THREE.BufferAttribute(new Float32Array(sho), 1));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, this.material);
    m.name = 'lakeSurface';
    m.matrixAutoUpdate = false;
    return m;
  }

  /**
   * SHORE AND SUBMERGED BOULDERS.
   *
   * props.js scatters the meadow's rocks, but it is told to keep out of the
   * lake (see bridges.js isBlocked) — otherwise it plants trees under water.
   * The reference frame is full of grey boulders standing in the shallows with
   * a white collar of foam, so the lake grows its own.
   *
   * Two populations: emergent rocks that break the surface along the shore
   * line, and flatter submerged slabs a metre or two down that read as shapes
   * THROUGH the water, which is what sells the transparency.
   */
  /**
   * LILY PADS.
   *
   * The reference frame has two rafts of them in the shallows off the rocky
   * shore, and they do a job out of all proportion to their size: they are the
   * only thing in the picture that establishes the water as SHALLOW and
   * still — a surface with things floating on it rather than a blue shape. They
   * live in 0.4-2 m of water in loose rafts, never as an even sprinkle.
   */
  _scatterPads(pads, F) {
    const { depth, VN, N, cell, x0, z0, level } = F;
    const { rng } = pads;
    const green = [0x3f7a2e, 0x4c8f36, 0x356a27, 0x5aa03f];
    const c = new THREE.Color();
    for (let j = 2; j < N - 1; j++) {
      for (let i = 2; i < N - 1; i++) {
        const d = depth[j * VN + i];
        if (d < 0.45 || d > 2.1) continue;
        if (rng.float() > 0.030) continue;
        const cx = x0 + i * cell, cz = z0 + j * cell;
        const count = 4 + rng.int(0, 7);
        for (let k = 0; k < count; k++) {
          const a = rng.float() * Math.PI * 2;
          const r = rng.float() * 7.5;
          const px = cx + Math.cos(a) * r, pz = cz + Math.sin(a) * r * 0.8;
          // only where there is still water under it
          const ii = Math.round((px - x0) / cell), jj = Math.round((pz - z0) / cell);
          if (ii < 0 || jj < 0 || ii >= VN || jj >= VN) continue;
          const dd = depth[jj * VN + ii];
          if (dd < 0.30 || dd > 2.6) continue;
          const R = 0.85 + rng.float() * 0.85;
          const rot = rng.float() * Math.PI * 2;
          c.set(green[rng.int(0, 3)]);
          // A pentagon with one notch: a circle at this size is five pixels of
          // flat colour, and the notch is what makes it read as a leaf.
          const S = 5;
          for (let s = 0; s < S; s++) {
            const a0 = rot + (s / S) * Math.PI * 2;
            const a1 = rot + ((s + 1) / S) * Math.PI * 2;
            const k0 = s === 0 ? 0.42 : 1.0;
            const k1 = s === S - 1 ? 0.42 : 1.0;
            pads.pos.push(px, level + 0.07, pz);
            pads.pos.push(px + Math.cos(a0) * R * k0, level + 0.07, pz + Math.sin(a0) * R * k0);
            pads.pos.push(px + Math.cos(a1) * R * k1, level + 0.07, pz + Math.sin(a1) * R * k1);
            for (let v = 0; v < 3; v++) pads.col.push(c.r, c.g, c.b);
          }
        }
      }
    }
  }

  _finishPads(pads) {
    if (!pads.pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pads.pos), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pads.col), 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
      vertexColors: true, flatShading: true, side: THREE.DoubleSide,
    }));
    m.name = 'lilyPads';
    m.renderOrder = 5;         // over the water surface, which is transparent
    m.matrixAutoUpdate = false;
    this.mesh.add(m);
    this.pads = m;
  }

  _rockAcc() {
    const seed = getLakeContext(this.biome)?.seed ?? 1337;
    const rng = new Rng((seed * 2654435761) ^ 0x5eed);
    const proto = [];
    for (let v = 0; v < 5; v++) {
      const g = new THREE.IcosahedronGeometry(1, 0).toNonIndexed();
      const a = g.attributes.position.array;
      // Squash and dent it: perfect icosahedra read as dice, not granite.
      const sy = 0.42 + rng.float() * 0.42;
      for (let i = 0; i < a.length; i += 3) {
        a[i] *= 0.8 + rng.float() * 0.5;
        a[i + 1] *= sy;
        a[i + 2] *= 0.8 + rng.float() * 0.5;
      }
      g.computeVertexNormals();
      proto.push(g);
    }
    return { rng, proto, pos: [], nor: [], col: [] };
  }

  _finishRocks(acc) {
    for (const g of acc.proto) g.dispose();
    if (!acc.pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(acc.pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(acc.nor), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(acc.col), 3));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      vertexColors: true, flatShading: true,
    }));
    m.name = 'lakeRocks';
    m.castShadow = true;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    this.mesh.add(m);
    this.rocks = m;
  }

  _scatterRocksInto(acc, T, F) {
    const { depth, shore, VN, N, cell, x0, z0, level } = F;
    const { rng, proto, pos, nor, col } = acc;
    const P = this.palette;
    const base = new THREE.Color(P.rock ?? 0x8f9099);
    const dark = new THREE.Color(P.rockShadow ?? 0x5f6069);
    const stamps = [];

    const place = (x, z, r, y, lit, collar) => {
      const g = proto[(rng.int(0, 4))];
      const yaw = rng.float() * Math.PI * 2;
      const m = new THREE.Matrix4()
        .makeRotationY(yaw)
        .premultiply(new THREE.Matrix4().makeScale(r, r * (0.7 + rng.float() * 0.6), r))
        .setPosition(x, y, z);
      const nm = new THREE.Matrix3().setFromMatrix4(m).invert().transpose();
      const p = g.attributes.position.array;
      const nn = g.attributes.normal.array;
      const c = base.clone().lerp(dark, rng.float() * 0.55).multiplyScalar(lit);
      const v = new THREE.Vector3(), nv = new THREE.Vector3();
      for (let i = 0; i < p.length; i += 3) {
        v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m);
        nv.set(nn[i], nn[i + 1], nn[i + 2]).applyMatrix3(nm).normalize();
        pos.push(v.x, v.y, v.z);
        nor.push(nv.x, nv.y, nv.z);
        col.push(c.r, c.g, c.b);
      }
      if (collar) stamps.push({ x, z, r: r * 0.95 });
    };

    // Walk the lattice cells and drop rocks where the depth band is right.
    // Every rock SITS ON THE BED: y = bed + a fraction of its radius. Placing
    // them relative to the surface instead left boulders hovering in five
    // metres of water like buoys.
    for (let j = 1; j < N; j++) {
      for (let i = 1; i < N; i++) {
        const d = depth[j * VN + i];
        // Past ~3.5 m the water is opaque, so a rock down there is a rock
        // nobody will ever see — and its foam collar would be a white ring
        // floating on empty blue. Keep the population in the readable band.
        if (d < -0.5 || d > 3.6) continue;
        const emergent = d < 2.0;
        if (rng.float() > (emergent ? 0.055 : 0.030)) continue;
        const x = x0 + i * cell + (rng.float() - 0.5) * cell;
        const z = z0 + j * cell + (rng.float() - 0.5) * cell;
        // Not under the bridge deck, and not on the knife of ground the road
        // crosses a neck on: a boulder there is a boulder inside the timber.
        if (F.keepOut && F.keepOut(x, z)) continue;
        const r = emergent ? 1.0 + rng.float() * 2.1 : 1.2 + rng.float() * 1.8;
        // Centre height above the bed. Emergent rocks break the surface;
        // submerged ones stay a comfortable margin under it.
        const rise = emergent ? r * 0.50 : Math.min(r * 0.38, Math.max(0.2, d - 0.9));
        // SEAT IT ON THE LOWEST GROUND IT COVERS.
        //
        // The bed height here is analytic; the ground you actually SEE is a
        // mesh with 6-12 m facets, which cuts the corner off every ridge and
        // every bank shoulder. A boulder placed on the analytic surface of one
        // of those therefore hangs several metres in the air — measured, three
        // of them visibly floating over the far shore in one frame. Taking the
        // minimum over a facet's worth of ground puts every rock at or below
        // the rendered surface: at worst it is a little buried, which is what
        // boulders look like anyway.
        let bed = level - d;
        for (const [ox, oz] of [[5, 0], [-5, 0], [0, 5], [0, -5], [3.5, 3.5], [-3.5, -3.5]]) {
          const h = T.heightAt(x + ox, z + oz);
          if (h < bed) bed = h;
        }
        // Only something that reaches the surface gets a foam collar.
        const collar = (rise + r * 0.5) - d > -0.7;
        place(x, z, r, bed + rise, emergent ? 1.0 : 0.82, collar);
      }
    }

    // Foam collar. Only the shore field is stamped — stamping the DEPTH field
    // too painted a ten-metre pale shelf around every rock, which at this
    // camera height read as a white blob rather than a wet stone.
    for (const st of stamps) {
      const pad = st.r + 4;
      const i0 = Math.max(0, Math.floor((st.x - x0 - pad) / cell));
      const i1 = Math.min(N, Math.ceil((st.x - x0 + pad) / cell));
      const j0 = Math.max(0, Math.floor((st.z - z0 - pad) / cell));
      const j1 = Math.min(N, Math.ceil((st.z - z0 + pad) / cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * VN + i;
          const dx = (x0 + i * cell) - st.x, dz = (z0 + j * cell) - st.z;
          const e = Math.hypot(dx, dz) - st.r;
          if (e < shore[k]) shore[k] = e;
        }
      }
    }
  }

  update(dt) {
    if (!this.surface) this._ensureSurface();
    this.material.uniforms.uTime.value += dt;
  }

  /**
   * The surface height at (x, z), or null on dry land. With a chain of tarns
   * at different altitudes there is no single waterline, so callers that used
   * to compare against `.level` have to ask per position.
   */
  levelAt(x, z) {
    if (this.plan) {
      const L = nearestLake(this.plan.lakes, x, z);
      return L ? L.level : null;
    }
    return this.level;
  }

  /** True if this world position is under water. */
  contains(x, z, height) {
    const l = this.levelAt(x, z);
    return l != null && height < l;
  }

  /** Metres of water at (x, z); negative on dry land. */
  depthAt(x, z) {
    if (!this.terrain) return 0;
    const l = this.levelAt(x, z);
    if (l == null) return -1;
    return l - this.terrain.heightAt(x, z);
  }
}
