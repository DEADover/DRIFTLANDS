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
    shore: 0x5fc0e6,
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

// THE CAMERA IS WORLD-FIXED, AND THAT DECIDES WHERE THE LAKES GO.
//
// ChaseCamera keeps yaw at pi/4 and never rotates with the car (followYaw = 0),
// so the frame is always the same trapezoid of ground on the -X/-Z side of the
// focus point: about 70 m across at the car, 150 m deep, and NOTHING else. A
// tarn a hundred metres to the north-east of the road is a tarn that exists,
// costs its triangles, and is never once on screen.
//
// Measured on lake_bridge with the basins offset to alternating sides: open
// water was inside the frame for 34% of the lap and there was a 1.3 km stretch
// with none at all. Alternating sides is exactly the wrong rule — it throws
// half of them behind the lens on purpose. So the side is chosen by which way
// the camera looks, and the basin is pushed a further sixty metres down-view so
// it lands in the middle of the frame rather than under the car.
const VIEW_YAW = Math.PI * 0.25;
const VIEW_X = -Math.cos(VIEW_YAW);
const VIEW_Z = -Math.sin(VIEW_YAW);

const CARVE = {
  CELL: 5,            // distance-field resolution, metres
  // 155 m of stride with basins three to five hundred metres across floods the
  // whole map: the plan view came back a maze of blue with green ribbons in it,
  // and the hero frame was a road running down an isthmus with open water on
  // BOTH sides (shots/i1/hero_alpine_t8.png). A tarn every two hundred and
  // forty metres is still water inside the first half-kilometre of the drive,
  // and it leaves meadow between them.
  STRIDE: 240,        // route metres between tarns
  VIEW_PUSH: 58,      // metres down-view to slide a scenic basin
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
  // MEASURED, not guessed. With the shore 55 m off the centreline the
  // autopilot left the road at 146 km/h on hero_alpine and ploughed 76 m out
  // into eight metres of water; every frame from t=13 to the end of the tape
  // was blue. A rally car running wide out of a fast corner uses eighty metres,
  // so that is where the water starts. It costs nothing in the picture: the
  // frame reaches a hundred and fifty metres down-view, and it is which
  // DIRECTION the basin sits in, not how far, that decides whether it is seen.
  // A LONG GENTLE RAMP, AND A SHORT HARD APRON.
  //
  // These two bands do different jobs and used to be one. The DIG ramp decides
  // where the bed drops away; stretched over seventy metres it puts a genuine
  // shallow shelf against the bank, so a car that runs wide meets a foot of
  // water and drives out of it, which is a rally hazard rather than a drowning.
  // The APRON is the hard guarantee: inside it the ground is filled clear of the
  // waterline whatever the meadow was doing, so the run-off itself is never
  // flooded. Measured before the apron existed: the autopilot left hero_alpine
  // at 146 km/h, ploughed 76 m out into eight metres of water, and every frame
  // to the end of the tape was blue.
  // TRIED AND REVERTED: 30/108 with a 60 m apron. It does put more blue in
  // frame — lake_bridge went from three frames in six to four — but at
  // hero_alpine t=12 the car ran wide out of the fast left and ended up sitting
  // in open water surrounded by boulders (shots/i18/hero_alpine_t12.png). A dry
  // frame is a worse picture; a car swimming is a worse GAME, and this is a
  // playable demo. The shore stays where the run-off ends.
  // MEASURED AGAIN, AND THE ABOVE IS WRONG — not about the run-off, about the
  // FRAME. At 40/116 with a 76 m apron the plan view (tools/watermap.mjs) shows
  // a dry corridor a hundred and sixty metres wide following the entire loop,
  // and the capture camera's ground footprint is a hundred metres across by a
  // hundred and twenty deep. The lake therefore begins, on every seed, a few
  // metres PAST the far edge of the picture: thirty-eight basins, six bridges,
  // a hundred and ten thousand triangles of lattice, and 0.0% blue in eighteen
  // consecutive frames across all three presets (tools/waterprobe.mjs).
  //
  // The run-off argument was sound and the answer to it was wrong. Holding the
  // water eighty metres away is not the only way to stop a car swimming; the
  // reference does it with a rocky rim between the road and the shore, which
  // costs no frame at this camera angle because a three-metre bank seen from
  // fifty-two degrees down occludes almost nothing behind it. So the corridor
  // comes in to where the water is READABLE, and the RIM below is what keeps
  // the car out of it.
  // 40/116 -> 22/60 halved the corridor and changed nothing measurable: the
  // median shore offset came down from 70 m to 55 m and the frame was still
  // 0.0% blue on all eighteen shots. The plan view at capture time
  // (shots/map/hero_alpine_t8_zoom.png) shows the reason — the camera's ground
  // footprint is a 120 m square whose near corner sat about twenty-five metres
  // short of the lake. The corridor has to be narrower than HALF the frame, not
  // merely narrower than it was.
  //
  // The carriageway is 15 m wide, so its edge is 7.5 m out and the verge ends
  // at 9. An apron to 27 m leaves eighteen metres of dry run-off past the
  // verge, the rim crests at 27 and the water starts around 36 — which is
  // about where the reference puts it either side of its bridge.
  // AND NARROWER STILL, because the frame is smaller than anyone assumed.
  // Unprojecting the four screen corners onto the ground at capture time
  // (tools/watermap.mjs) gives a footprint of about 80 m across by 55 m deep at
  // the car — not the 70 x 150 the old note claimed. Rendering the lattice as
  // opaque magenta (tools/watervis.mjs) confirmed it from the other end: with
  // the shore 36 m out the geometry covered 0.00 / 0.66 / 0.01 per cent of the
  // three hero frames. There is no siting trick that fixes that. In a frame
  // eighty metres wide, water thirty-six metres from the centreline is water
  // you will never photograph.
  //
  // So the lake comes to the verge. The carriageway is 15 m wide and the verge
  // ends at 9; ground is held dry to 18, the rim crests at 19 and the water
  // starts around 25. That is one road-width of shoulder — which is what the
  // reference has beside its bridge, and it is the rim below, not distance,
  // that keeps a car out of the lake.
  // ROAD_OUT is the BANK ANGLE, and 30 m made a cliff. Eight and a half metres
  // of cut reached in twenty gave a 1:2.4 face: no pale shelf, no submerged
  // rocks, no lily pads, and the foam compressed into a hard glowing zigzag
  // piping along the whole shore. Reaching full depth at sixty-eight instead
  // puts the same waterline in the same place but with a shelf you can see
  // through, which is where everything the reference shows lives.
  ROAD_IN: 12,        // no carve within this of the centreline...
  // A LONG SHALLOW APPROACH IS THE REAL GUARD, not the rim. Three and a half
  // metres of bank did not turn a rally car at a hundred km/h and it never
  // will; what decides whether a car that ran wide is a splash or a drowning is
  // how deep the water it lands in is. Reaching full depth only at a hundred
  // and twenty-five metres puts about half a metre of water sixty metres off
  // the centreline — measured, that is exactly where hero_alpine's car came to
  // rest in 4.7 m and stayed. The basin still reaches its full eight and a half
  // metres in the middle, because the ellipse ramp multiplies this one; it is
  // only the shore nearest the road that is shallow, which is also where the
  // reference puts its pale band and its lily pads.
  ROAD_OUT: 125,      // ...full depth beyond this
  APRON_IN: 11,       // ground held clear of the water out to here...
  APRON_OUT: 26,      // ...tapering to nothing here
  // THE RIM. A band of ground just outside the apron, raised to a hump above
  // the causeway. It is the thing that stops a car that ran wide: it arrives at
  // a bank climbing at about 1:7 and either climbs it and stops, or is turned
  // by it — instead of arriving at a shelf that slopes gently INTO the water.
  // It is also, and not incidentally, exactly what the reference frame has
  // along its whole left-hand shore: a grey rock lip between the meadow and the
  // blue, never a beach running smoothly under.
  // GENTLE, OR IT IS A SLAB. At 4.6 m gained over ten metres the rim's inner
  // face is a 1:2.2 wall standing at the verge, and Lambert shading turns every
  // one of those 8.7 m facets into a charcoal wedge lying beside the road —
  // conspicuous, and read as tarmac rather than as ground
  // (shots/i2/lake_bridge_t4.png). Disabling the bed repaint changed nothing,
  // so it is the geometry and not the colour. Two metres gained over fourteen
  // is a swell that still turns a car and that the light can find.
  // TALLER, BUT NOT STEEPER. 2.2 m did not turn anything: on hero_alpine the
  // autopilot loses the car at t=11 (it did at baseline too, into a forest),
  // and with the lake where it now is the car ploughed over the rim and drowned
  // in eight metres of water — every frame from t=16 to the end of the tape was
  // 73% blue with the car on the bottom (shots/i11/hero_alpine_t16.png). Three
  // and a half metres gained over eighteen is the same 1:5 face that stayed out
  // of the picture, with half as much again to climb.
  RIM_IN: 16,         // rim starts here (just past the apron's taper)...
  RIM_PEAK: 34,       // ...crests here...
  RIM_OUT: 52,        // ...and is gone by here, into open water
  RIM_H: 3.5,         // metres of hump above the causeway fill
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
  // These have to be INSIDE the deck's half width (8.6 m), or the crossing is
  // not a crossing. At 6.5/13 the ground stayed dry to thirteen metres, the
  // deck spanned eight and a half of them, and what the player met was a wide
  // brown slab lying on a grass shoulder with the lake starting six metres
  // beyond the railing — visible in shots/i9/crop_deck.png. Cut to inside the
  // planks and the water runs under the timber, which is the whole picture.
  NECK_IN: 4.0,
  NECK_OUT: 7.6,
  // Spurs need the same courtesy as the main route. At 5/22 a branch road ran
  // straight into a tarn and stopped at the waterline like a slipway — visible
  // at the bottom of shots/i18/hero_alpine_t12.png.
  SPUR_IN: 9,
  SPUR_OUT: 36,
  FREEBOARD: 3.0,     // road surface above the tarn it runs beside
  NECK_FREEBOARD: 5.5,
  // How far the run-off beside the carriageway is held above the waterline.
  // Water is a fair hazard; it should be something you reach by getting it
  // badly wrong, not by taking a normal line through a fast corner.
  CAUSEWAY: 1.6,
  // A crossing is different: the strip of ground between the lobes is meant to
  // vanish under the planks, so it is held only just clear of the water.
  NECK_CAUSEWAY: 0.5,
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
  const stats = { scenicTried: 0, scenicOk: 0, neckTried: 0, neckOk: 0, clashDropped: 0 };
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
    let lo = Infinity, hi = -Infinity;
    // TOTAL turning, not the angle between the endpoints. An S through the
    // crossing has its two ends parallel and scored zero by the endpoint test,
    // which is how a deck came to be laid round a hairpin: the planks followed
    // the road, the road turned ninety degrees over the span, and what the
    // player met was a banana of timber he slid off the outside of.
    let bend = 0;
    for (let k = -reach; k <= reach; k++) {
      const p = P[(station + k + n * 4) % n];
      lo = Math.min(lo, p.yT); hi = Math.max(hi, p.yT);
      if (k > -reach) {
        const q = P[(station + k - 1 + n * 4) % n];
        bend += Math.abs(Math.atan2(p.tx * q.tz - p.tz * q.tx, p.tx * q.tx + p.tz * q.tz));
      }
    }
    return (hi - lo) + bend * 150;
  };

  /**
   * Lowest carriageway within R metres of (cx, cz), anywhere on the loop.
   *
   * A basin laid out in the camera's frame has no "its own stretch of road" —
   * the loop may come past it twice, or slice a corner off it — so the only
   * safe reading is the lowest tarmac the basin can actually reach. Sampling
   * every fourth station is plenty at this radius.
   */
  const roadLowNear = (cx, cz, R) => {
    let lo = Infinity;
    const R2 = R * R;
    for (let i = 0; i < n; i += 4) {
      const p = P[i];
      const dx = p.x - cx, dz = p.z - cz;
      if (dx * dx + dz * dz > R2) continue;
      if (p.yT < lo) lo = p.yT;
    }
    return lo;
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
  const mk = (p, side, Ra, Rc, o, level, neck, station, push = 0) => ({
    x: p.x + p.nx * o * side + VIEW_X * push,
    z: p.z + p.nz * o * side + VIEW_Z * push,
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
    // TRIED AND REJECTED: phasing this off the distance the car has covered at
    // each preset's settle time (201 m on lake_bridge, 285 on hero_alpine, 318
    // on wildlife — tools/dist.mjs). It does not work, and the reason is worth
    // recording. The camera is world-fixed: what is AHEAD on the road is only
    // in frame when the road happens to be heading toward -X/-Z. Sliding the
    // chain to put a crossing thirty metres in front of the car put it thirty
    // metres BEHIND the lens on lake_bridge and the frame came back emptier
    // than before. Three hundred metres is kept because it is the measured best
    // over the ladder of settle times, not because it suits one shutter.
    s0 = cum[bi] + 250;
  }

  for (let s = s0; s < s0 + total - 40; s += CARVE.STRIDE) {
    const nominal = stationAt(((s % total) + total) % total);
    // Every third station is a crossing. One bridge on a four-kilometre loop is
    // a bridge nobody ever sees: the camera reaches about 200 m, so a landmark
    // has to recur every few hundred metres to be part of the drive at all.
    // EVERY OTHER STATION, not every third. At a 240 m stride every third
    // station is a crossing every seven hundred and twenty metres, and the
    // player is stopped, crashed or out of shot long before then: measured on
    // hero_alpine the car covers about four hundred metres in the twelve
    // seconds before the autopilot loses it. A bridge every four hundred and
    // eighty metres is one you actually meet.
    const neck = (ord % 2) === 0;
    ord++;

    if (neck) {
      // Slide the crossing along the route to the flattest, straightest spot
      // within half a stride. This is the same fix as making the deck wide: a
      // car following the centreline has to arrive square to the bridge.
      // Search half a stride either way, not sixty metres: on a loop with two
      // hairpins a narrow window has no straight in it at all, and the deck
      // gets built in whichever bend was least bad.
      // THE SEARCH WINDOW IS IN METRES, AND THE FIRST ONE MAY ONLY GO FORWARD.
      //
      // "half a stride either way" was written as +-150 STATIONS, and P is
      // resampled at about three metres, so the window was +-450 m — nearly a
      // quarter of the loop. Measured on hero_alpine: the chain is phased to
      // put the first crossing three hundred metres past the start line, and
      // the flatness search moved it to a hundred and fifty metres BEHIND it
      // (route index 1284 against a spawn at 1359, tools/_dir.mjs). The player
      // drives away from the only bridge he was ever going to see.
      const perSample = total / n;
      const KW = Math.max(4, Math.round(75 / perSample));
      const kLo = ord === 1 ? 0 : -KW;      // ord was ++'d above; 1 is the first
      let station = nominal, best = Infinity;
      const kStep = Math.max(1, Math.round(KW / 24));
      for (let k = kLo; k <= KW; k += kStep) {
        const c = (nominal + k + n * 4) % n;
        const cost = crossingCost(c, Math.round(90 / perSample) * 3);
        if (cost < best) { best = cost; station = c; }
      }
      const p = P[station];
      // HOW LONG THE CROSSING IS. At 34-46 m the wet run came out around forty
      // metres and the deck, once its abutments were added, was a stub you were
      // over before you noticed it. The reference's bridge is a landmark that
      // occupies a good part of the frame; a hundred metres of span is what
      // that takes at this camera height.
      const Ra = 56 + rng.float() * 18;         // half the crossing's length
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
      stats.neckTried++;
      let made = null;
      for (const Rc of [130, 110, 92, 76, 62]) {
        const a = mk(p, 1, Ra, Rc, Rc * 0.50, level, true, station);
        const b = mk(p, -1, Ra, Rc, Rc * 0.50, level, true, station);
        if (basinCost(terrain, a, level) < 20 && basinCost(terrain, b, level) < 20) {
          made = [a, b];
          break;
        }
      }
      if (made) { stats.neckOk++; lakes.push(...made); crossings.push({ station, level, Ra, sFromSpawn: s - s0 }); }
      continue;
    }

    // A TARN IN THE FRAME, NOT MERELY BESIDE THE ROAD.
    //
    // The previous rule offset the basin along the road's own normal, to
    // alternating sides. On a world-fixed camera that is a coin toss: half of
    // them land behind the lens, and when the road happens to run parallel to
    // the view direction the normal points straight out of frame and NONE of it
    // is seen. So the basin is laid out in the CAMERA's frame instead — centred
    // down-view of the road, its long axis across the picture — and it is the
    // road guard, not the ellipse, that keeps the carriageway dry.
    stats.scenicTried++;
    const cand = [];
    // across-view axis, i.e. the screen-horizontal direction on the ground
    const CX = -VIEW_Z, CZ = VIEW_X;
    for (const ds of [0, -70, 70]) {
      const st = (nominal + ds + n * 4) % n;
      const p = P[st];
      for (const D of [120, 96, 74]) {              // metres down-view
        for (const Rc of [128, 104, 84]) {            // half depth along view
          const Ra = Rc * 1.5;                        // half width across view
          const cx = p.x + VIEW_X * D, cz = p.z + VIEW_Z * D;
          // The waterline has to clear the LOWEST carriageway the basin can
          // reach, or the far end of the lake ends up over the road.
          const lo = roadLowNear(cx, cz, Math.max(Ra, Rc) * 1.45);
          if (!Number.isFinite(lo)) continue;
          const level = lo - CARVE.FREEBOARD;
          const L = {
            x: cx, z: cz,
            tx: CX, tz: CZ, nx: VIEW_X, nz: VIEW_Z,
            Ra, Rc, o: D, level, floor: level - CARVE.DEPTH,
            neck: false, station: st,
          };
          const cost = basinCost(terrain, L, level);
          // Bigger and nearer the road is better when the digging costs the
          // same: a tarn you drive past beats a tarn on the horizon.
          const score = cost - Rc * 0.05 + D * 0.012;
          cand.push({ L, score });
        }
      }
    }
    // TWO CANDIDATES, NOT ONE.
    //
    // The best site for a station is very often the same hollow the previous
    // station already took, and the overlap pass then throws the newcomer away
    // — fourteen of forty-four basins on lake_bridge died that way, and they
    // died in clusters, which is what left a kilometre of the loop with nothing
    // wet in shot. Offering the runner-up as well, provided it is a genuinely
    // different hollow, costs nothing when the first one fits and fills the gap
    // when it does not.
    cand.sort((a, b) => a.score - b.score);
    const picked = [];
    for (const c of cand) {
      if (c.score >= 34) break;
      if (picked.some((q) => Math.hypot(q.L.x - c.L.x, q.L.z - c.L.z) < 190)) continue;
      picked.push(c);
      if (picked.length === 2) break;
    }
    for (const c of picked) { stats.scenicOk++; lakes.push(c.L); }
  }
  if (!lakes.length) return null;


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
  //
  // SHRINK BEFORE YOU DROP. The stations are two hundred metres apart and the
  // basins are three hundred metres across, so on a route with real relief
  // almost every neighbouring pair conflicts — and a straight drop threw away
  // more than half of them, which is how tightening the spacing came out with
  // LESS water on screen than before. A tarn two thirds the size still fills
  // the frame; no tarn at all is a kilometre of dry driving.
  const setRadii = (L) => {
    L.Rmax = Math.max(L.Ra, L.Rc) * 1.30;
    L.R2out = L.Rmax * L.Rmax;
    L.hx = Math.abs(L.tx) * L.Ra + Math.abs(L.nx) * L.Rc;
    L.hz = Math.abs(L.tz) * L.Ra + Math.abs(L.nz) * L.Rc;
  };
  for (const L of lakes) setRadii(L);
  // WHAT COUNTS AS TOUCHING.
  //
  // Rmax is 1.3x the LONGER semi-axis, so at 0.82 two basins were declared in
  // conflict five hundred metres apart — further than either of them holds any
  // water. Twenty-six of sixty-four candidates on lake_bridge were thrown away
  // by that test, in clusters, which is what left kilometre-long stretches of
  // the loop with nothing wet in shot. Water only reaches about 85% of the
  // ellipse, so this is the distance at which the WET parts can actually meet.
  const overlap = (A, B) => Math.hypot(A.x - B.x, A.z - B.z) < (A.Rmax + B.Rmax) * 0.58;
  /** Does L clash with anything already kept? Returns 'ok' | 'shrink'. */
  const clash = (L, kept) => {
    for (const K of kept) {
      if (K.dead || !overlap(L, K)) continue;
      // Merging pulls both to the LOWER surface, which only ever gives the road
      // beside them more freeboard, so it is safe to be generous — and a pair of
      // merged basins reads as one big irregular lake instead of two discs. Only
      // a crossing is fussy: dragging its lobes down turns the neck into a gorge
      // and the deck fascia into a timber wall.
      const tol = (L.neck || K.neck) ? 3.5 : 7.0;
      if (Math.abs(L.level - K.level) <= tol) {
        const lo = Math.min(L.level, K.level);
        L.level = lo; K.level = lo;
      } else if (K.neck) {
        return 'shrink';
      } else if (L.neck) {
        K.dead = true;
      } else {
        return 'shrink';
      }
    }
    return 'ok';
  };
  const kept = [];
  for (const L of lakes) {
    let ok = false;
    for (let t = 0; t < 4; t++) {
      if (clash(L, kept) === 'ok') { ok = true; break; }
      if (L.neck || L.Rc < 55) break;      // a neck may not be shrunk here: the
      L.Ra *= 0.74; L.Rc *= 0.74;          // deck is already sized to its lobes
      setRadii(L);
    }
    if (ok) kept.push(L); else stats.clashDropped++;
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
  // A CROSSING IS A PLACE, NOT A WHOLE LOBE.
  //
  // The neck's keep-out is four to seven metres, because the water has to run
  // under the planks. That was applied over the ENTIRE lobe — 66 x 162 m of it
  // — so a crossing put the waterline at the verge for a hundred and thirty
  // metres of road in each direction. With a crossing every four hundred and
  // eighty metres the loop drowned: hero_alpine t14 came back 82% blue with the
  // car swimming and no road in shot (shots/i7/hero_alpine_t12.png).
  //
  // `w` is one at the crossing station and falls to zero about forty metres
  // along the lobe, and every band below is interpolated on it. So the deck
  // still spans open water and the same lobe still makes a big lake, but the
  // road meets that lake only where the bridge is.
  const neckW = (L, dx, dz) => {
    if (!L.neck) return 0;
    return 1 - sstep(0.34, 0.78, Math.abs((dx * L.tx + dz * L.tz) / L.Ra));
  };
  const mix = (a, b, t) => a + (b - a) * t;
  const guardOf = (L, x, z, w) => {
    const dr = dRoute(x, z);
    const g = sstep(
      mix(CARVE.ROAD_IN, CARVE.NECK_IN, w),
      mix(CARVE.ROAD_OUT, CARVE.NECK_OUT, w),
      dr,
    );
    return g * sstep(CARVE.SPUR_IN, CARVE.SPUR_OUT, dSpur(x, z));
  };

  const raw = terrain.heightAt.bind(terrain);
  const carved = (x, z) => {
    let h = raw(x, z);
    // THE CAUSEWAY IS BUILT, NOT MERELY SPARED.
    //
    // The guard band says "do not DIG here". That is not the same as "this is
    // dry": where the meadow beside the road happens to sit below the waterline
    // already, sparing it just leaves it flooded, and the first thing that
    // happens is the car runs wide out of a fast corner into ten metres of
    // water and never comes out. Measured on hero_alpine before this: the car
    // left the road at t=12 and every frame from t=13 to the end of the tape
    // was a hundred per cent blue.
    //
    // So inside the guard the ground is FILLED to a metre and a half of
    // freeboard, tapering to nothing by the time the guard opens. The level was
    // chosen three metres under the lowest carriageway the basin can reach, so
    // this fill is always below the road surface and never buries it.
    let fillTo = -Infinity, fillK = 0;
    let neckTo = -Infinity, neckK = 0, underNeck = false;
    for (let i = 0; i < lakes.length; i++) {
      const L = lakes[i];
      const dx = x - L.x, dz = z - L.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > L.R2out) continue;
      const ua = (dx * L.tx + dz * L.tz) / L.Ra;
      const uc = (dx * L.nx + dz * L.nz) / L.Rc;
      const u = Math.hypot(ua, uc);
      // A WIDE FLOOR, NOT A CONE. Ramping the cut from nothing at the rim to
      // full depth only at a third of the radius meant the water reached about
      // 80% of the ellipse and was under a metre over most of that, so a basin
      // three hundred metres across held a puddle sixty metres wide. The bowl
      // now has a real floor and the ramp is the bank.
      const dig = sstep(1.02, 0.62, u);
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
      const w = neckW(L, dx, dz);
      const nk = w > 0.35;
      const g = guardOf(L, x, z, w);
      // The causeway fill. Runs wherever the basin reaches, INCLUDING the
      // stretch the guard protects from digging — that is the whole point.
      if (u < 1.25) {
        // A CROSSING HAS ITS OWN, MUCH NARROWER APRON. Running the scenic
        // fifty-metre apron through a neck raises the ground either side of the
        // causeway clear of the water, which is precisely the condition
        // bridges.js tests for when it decides there is anything to bridge —
        // and every deck in the world silently stopped being built.
        const ain = mix(CARVE.APRON_IN, CARVE.NECK_IN, w);
        const aout = mix(CARVE.APRON_OUT, CARVE.NECK_OUT, w);
        // The apron follows the spurs too, or a branch road walks into the lake.
        const dr0 = dRoute(x, z);
        // The rim rides on the same fill field as the apron — one band of
        // raised ground running from the verge out to open water, flat at
        // causeway height under the run-off and humped where it meets the
        // shore. Doing it as a second pass gave a visible step where the two
        // met; as one height profile it is a bank.
        const rimP = (1 - w)
          * sstep(CARVE.RIM_IN, CARVE.RIM_PEAK, dr0)
          * (1 - sstep(CARVE.RIM_PEAK, CARVE.RIM_OUT, dr0));
        const k = Math.max(
          1 - sstep(ain, aout, dr0),
          rimP,
          nk ? 0 : 1 - sstep(CARVE.SPUR_IN, CARVE.SPUR_OUT, dSpur(x, z)),
        ) * (1 - sstep(0.98, 1.25, u));
        if (nk) {
          if (u < 1.12) underNeck = true;
          const need = L.level + CARVE.NECK_CAUSEWAY;
          if (need > neckTo) neckTo = need;
          if (k > neckK) neckK = k;
        } else {
          const need = L.level + mix(CARVE.CAUSEWAY, CARVE.NECK_CAUSEWAY, w)
                     + CARVE.RIM_H * rimP;
          if (need > fillTo) fillTo = need;
          if (k > fillK) fillK = k;
        }
      }
      if (dig <= 0 && berm <= 0) continue;
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
    // A CROSSING OVERRULES ITS NEIGHBOURS' APRONS.
    //
    // The apron is a fifty-metre band of filled ground either side of the road,
    // and the thing bridges.js tests for before it lays a deck is open water
    // thirteen metres off the centreline. A scenic tarn whose apron happens to
    // reach across a neck therefore quietly fills in the very water the bridge
    // is meant to span — measured: three of five planned crossings on
    // lake_bridge came back +1.6 m dry at exactly the apron's height, and no
    // deck was built at any of them. Inside a neck, only the neck's own narrow
    // apron counts.
    if (underNeck) {
      if (neckK > 0 && h < neckTo) h += (neckTo - h) * neckK;
    } else if (fillK > 0 && h < fillTo) {
      h += (fillTo - h) * fillK;
    }
    return h;
  };

  return {
    lakes, crossings, raw, stats, heightAt: carved, dRoute, dSpur,
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
      // THE REPAINT KEEPS OFF THE ROAD CORRIDOR ENTIRELY.
      //
      // The bank branch below re-runs biome.colorAt() with the face's CURRENT
      // slope, and the carve makes the ground beside a narrow causeway steep —
      // so every facet within twenty metres of the verge came back rock, and
      // what the frame had was two charcoal slabs lying along the road, read at
      // this camera height as tarmac (shots/i3/lake_bridge_t4.png). Both
      // branches now stop at the apron; there is no water inside it anyway, and
      // the meadow beside the road is not this module's to recolour.
      if (plan.dRoute(mx, mz) < keepOutOf(L, mx, mz)) continue;
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
        // DAMPED SLOPE. colorAt keys its rock swatch on slope, and the carve
        // makes a bank steeper than the meadow that was there — so a shore that
        // is still grass came back scree, and at this camera height a band of
        // scree beside the road reads as tarmac. The point of this branch is to
        // keep the meadow's colour on ground the lake merely moved; passing the
        // carved slope defeats it.
        biome.colorAt(c, cols, h0, slope * 0.35, mx, mz, seed);
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

/**
 * How close to the centreline this basin is allowed to come.
 *
 * A crossing has to reach the deck edge — the water runs UNDER the planks, and
 * holding it back is what turns a bridge into a brown slab on a grass shoulder.
 * But a neck's lobe is a hundred and thirty metres long, and applying the
 * crossing's six-metre keep-out over the whole of it painted a charcoal band of
 * "wetted bank" down the verge for the entire lobe, on a stretch of road with
 * no bridge anywhere near it (shots/i9/lake_bridge.png; disabling the repaint
 * removed it exactly). So it is six metres AT the crossing and the scenic
 * apron's width everywhere else, on the same falloff the carve uses.
 *
 * The repaint and the lattice clip must return the same number or the
 * difference shows up as a band of wetted gravel with no water on it.
 */
function keepOutOf(L, x, z) {
  const wide = CARVE.APRON_OUT + 6;
  if (!L.neck) return wide;
  const w = 1 - sstep(0.34, 0.78, Math.abs(((x - L.x) * L.tx + (z - L.z) * L.tz) / L.Ra));
  return 6.4 + (wide - 6.4) * (1 - w);
}

/**
 * Which basin owns this square metre — the one whose normalised elliptical
 * radius is smallest. Used to split the lattice between touching basins so no
 * two patches overlap; `nearestLake` below answers a different question (am I
 * inside any basin at all) and both are needed.
 */
function nearestByRadius(lakes, x, z) {
  let best = null, bu = Infinity;
  for (let i = 0; i < lakes.length; i++) {
    const L = lakes[i];
    const dx = x - L.x, dz = z - L.z;
    if (dx * dx + dz * dz > L.R2out * 2.2) continue;
    const ua = (dx * L.tx + dz * L.tz) / L.Ra;
    const uc = (dx * L.nx + dz * L.nz) / L.Rc;
    const u = Math.hypot(ua, uc);
    if (u < bu) { bu = u; best = L; }
  }
  return best;
}

// The lattice emits water wherever `own` is set, and `own` is u <= 1.18 — so a
// disc at u = 1.0 leaves a ring of open water that levelAt(), contains() and
// therefore the whole prop/animal keep-out believe is dry land. Measured: deer
// standing in the lake off the near shore in shots/i3/lake_bridge_t4.png. The
// two thresholds have to be the same number.
const OWN_U = 1.18;

function nearestLake(lakes, x, z) {
  for (let i = 0; i < lakes.length; i++) {
    const L = lakes[i];
    const dx = x - L.x, dz = z - L.z;
    if (dx * dx + dz * dz > L.R2out) continue;
    const ua = (dx * L.tx + dz * L.tz) / L.Ra;
    const uc = (dx * L.nx + dz * L.nz) / L.Rc;
    if (ua * ua + uc * uc <= OWN_U * OWN_U) return L;
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
    // SIGNED horizontal metres to the waterline: positive out in the water,
    // negative up the bank. This, not depth, is what sets the width of the
    // shelf and the foam — on a bed sloping at 1:15 a 70 cm depth band is ten
    // metres wide on screen, which is why keying either off depth alone painted
    // the whole lake white.
    float sg = vShore;
    // THE WATERLINE IS DRAWN, NOT SAMPLED.
    //
    // Both the depth field and the terrain mesh are grids — 4 m and 8.7 m — so
    // the line where they cross is a staircase, and it is a staircase in the
    // most conspicuous colour on screen because the foam sits on it. Perturbing
    // the shore distance by a couple of metres of noise costs one texture-free
    // fetch and turns every one of those steps into a bay or a spit. Two
    // octaves: the coarse one makes the inlets, the fine one chews the lip.
    sg += (noise(vWorld * 0.011) - 0.5) * 9.0
        + (noise(vWorld * 0.042) - 0.5) * 3.4
        + (noise(vWorld * 0.155) - 0.5) * 1.3
        // A fourth octave under the lattice cell. The three above are all
        // coarser than the 4 m grid, so they move the whole waterline about
        // without touching the thing that is actually conspicuous: the foam
        // lip landing inside one cell and following its diagonal, which reads
        // as a regular 45-degree zigzag of white piping round the whole lake.
        + (noise(vWorld * 0.46) - 0.5) * 1.05;
    float s = max(sg, 0.0);

    // --- shelf -> shallow -> mid -> deep ------------------------------------
    // Alpine tarns are 2-6 m deep, so a ramp authored for a nine-metre lake
    // never reaches its own deep colour and the whole body reads as one pale
    // cyan. The shelf is a couple of metres wide and then it is straight into
    // cobalt, which is what the reference does.
    // A WIDER SHELF. The bank is a 1:4 shelf now rather than the 1:2 wall it
    // was, and on the old ramp the whole of it was past uMid within nine metres
    // of the shore — so the frame had grass, a white line, and cobalt, with
    // none of the pale blue band the reference carries all along its near
    // shore. These widths are horizontal metres, and they are chosen to match
    // the bathymetry the carve actually makes.
    vec3 col = uShore;
    col = mix(col, uShallow, smoothstep(0.5, 7.0, s));
    col = mix(col, uMid,     smoothstep(6.0, 22.0, s));
    col = mix(col, uDeep,    smoothstep(2.6, 7.0, d));

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
    float edge = 0.30 + chew * 0.80 + chew2 * 0.35;
    // Dies off on BOTH sides of the waterline. Before it was keyed on an
    // unsigned distance, so every vertex the lattice carried past the shore
    // read as "zero metres from the water" and got the full lip — which on a
    // shelving bank is a twenty-metre snowfield, not a wave.
    float lip  = (1.0 - smoothstep(0.0, edge, s)) * smoothstep(-1.1, -0.1, sg);
    float wash = (1.0 - smoothstep(edge, edge + 1.3, s)) * (0.03 + 0.11 * chew2)
               * step(0.0, sg);
    // ABSENT along stretches of shore. An unbroken white piping all the way
    // round the lake is the single loudest tell that the water is a decal; the
    // reference only really foams where the water meets rock.
    // RARER AND QUIETER. At 0.66 with a gate opening at 0.40 the lip ran
    // unbroken round every shore, and the bloom pass turned it into a glowing
    // cyan-white piping that was the single loudest thing in the frame. The
    // reference only foams where the water meets rock; everywhere else its
    // shoreline is simply grass meeting blue.
    float gate = smoothstep(0.52, 0.95, chew * 0.75 + chew2 * 0.45);
    float foam = clamp(lip + wash, 0.0, 1.0) * gate;
    col = mix(col, uFoam, foam * 0.40);

    // --- sun glitter --------------------------------------------------------
    // Sparse and restrained. At 1.1x this fed the bloom pass two soft white
    // blobs the size of a car in every crossing frame, which read as smudges on
    // the lens rather than as sun on water.
    float glint = pow(max(0.0, noise(p * 7.0 + uTime * 0.22)), 26.0);
    col += uSun * glint * 0.45 * smoothstep(0.6, 3.0, d);

    // Near-opaque past the shelf; glassy right at the edge so the bed and any
    // rock standing in the shallows read through.
    float alpha = mix(0.80, 0.97, smoothstep(0.4, 2.6, d));
    alpha = max(alpha, foam * 0.70);
    // THE LATTICE CLIPS ITSELF.
    //
    // It carries a ring of dry vertices past the waterline on purpose, so the
    // shoreline is cut by the opaque terrain rather than by a mesh boundary.
    // But the terrain is rendered at 8-9 m facets and the depth field is
    // analytic, so on any gentle bank the mesh sits up to a metre below what
    // the depth field thinks, and the surface pokes out over dry ground. Fading
    // the ring out over the last metre and a half costs nothing where the
    // terrain does its job and saves the picture where it does not.
    alpha *= smoothstep(-1.5, 0.05, sg);
    if (alpha < 0.02) discard;

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
      // (see keepOutOf) — six metres at the crossing, the apron's width along
      // the rest of the lobe.
      // ONE CELL, ONE PATCH.
      //
      // Every basin used to emit its own lattice clipped to its own ellipse, so
      // where two touched, patch A's ring of dry vertices lay across patch B's
      // open water — and since the shader draws foam wherever the shore
      // distance is near zero, the seam came out as a dead straight white
      // streak across the lake, twice as loud as any real shoreline. The cells
      // are therefore split between the basins by nearest normalised radius, so
      // no two patches ever cover the same ground, and the DEPTH field is left
      // unclipped so the distance transform still measures to the real
      // waterline rather than to a patch boundary.
      const own = new Uint8Array(M * M);
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
          // THE WATERLINE HAS TO CLOSE INSIDE THE PATCH.
          //
          // Triangles are only emitted out to u = 1.18, but the DIG stops at
          // 1.02 — so wherever the natural meadow happened to lie below the
          // waterline between the two, the lattice ran to its own boundary and
          // stopped, and what the frame had was a dead straight elliptical edge
          // of open water lying across the hillside (shots/i12/wildlife.png,
          // which is the 0.6 zoom preset and shows it at full size). Tapering
          // the depth to zero at 1.14 puts the shoreline a clear cell inside
          // the boundary; the shader's shore noise, +-7 m of it, is what makes
          // that arc read as a shore rather than as an arc.
          if (u > 0.98) d = Math.min(d, (1.14 - u) * L.Rc * 0.5);
          // Never over the road — but RAMPED, not cut. A hard clip put the
          // waterline exactly on a 4 m lattice edge and the shore came out as a
          // sawtooth of white foam running parallel to the carriageway; the
          // ramp lands the zero crossing wherever it falls inside a cell.
          const dr = plan.dRoute(x, z);
          const keep = keepOutOf(L, x, z);
          if (dr < keep) d = Math.min(d, (dr - keep) * 0.55);
          depth[j * M + i] = d;
          if (u <= OWN_U && nearestByRadius(plan.lakes, x, z) === L) {
            own[j * M + i] = 1;
            if (d > 0) wet++;
          }
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
      // SIGNED, both ways. Positive inside the water, NEGATIVE out on the bank.
      //
      // Only seeding the wet side was the single worst thing in the frame. The
      // lattice deliberately carries a 2.5 m ring of dry vertices past the
      // waterline so the terrain does the clipping, and the terrain mesh has
      // 8-9 m facets that cut the corner off every bank shoulder — so on a
      // gentle shelf twenty metres of that ring showed through, all of it with
      // shore distance pinned at zero, and the shader painted every pixel of it
      // pure foam. The lake came out ringed by a forty-metre snowfield.
      // With the distance signed, that band is simply OUTSIDE the water: the
      // shader fades it out instead of lighting it up, and the lattice clips
      // itself rather than trusting a mesh that is a metre out.
      const E = M - 1;
      const dW = new Float32Array(M * M);
      const dD = new Float32Array(M * M);
      for (let k = 0; k < dW.length; k++) {
        const wetk = depth[k] > 0;
        dW[k] = wetk ? 1e5 : 0;
        dD[k] = wetk ? 0 : 1e5;
      }
      chamfer(dW, M, cell);
      chamfer(dD, M, cell);
      const shore = new Float32Array(M * M);
      for (let j = 0; j < M; j++) {
        for (let i = 0; i < M; i++) {
          const k = j * M + i;
          const d = depth[k];
          const dx = (depth[k + (i < E ? 1 : 0)] - depth[k - (i > 0 ? 1 : 0)]) / (cell * ((i > 0 && i < E) ? 2 : 1));
          const dz = (depth[k + (j < E ? M : 0)] - depth[k - (j > 0 ? M : 0)]) / (cell * ((j > 0 && j < E) ? 2 : 1));
          const g = Math.hypot(dx, dz);
          const fine = g > 1e-4 ? d / g : d * 40;
          // The chamfer is quantised to the 4 m cell, far too coarse for a
          // half-metre foam lip; the depth/slope estimate is continuous and is
          // accurate precisely in the first cell, where it matters. Use it
          // there and the transform beyond.
          shore[k] = d > 0
            ? (dW[k] >= cell ? dW[k] : Math.min(fine, cell))
            : (dD[k] >= cell ? -dD[k] : Math.max(fine, -cell));
        }
      }

      const F = {
        depth, shore, VN: M, N: E, cell, x0, z0, level: L.level,
        keepOut: (x, z) => plan.dRoute(x, z) < (L.neck ? 13 : 15),
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
          const k = j * M + i;
          if (!(own[k] | own[k + 1] | own[k + M] | own[k + M + 1])) continue;
          const a = depth[k], b = depth[k + 1];
          const c = depth[k + M], e = depth[k + M + 1];
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
        // A CLEAR METRE UNDER, for the same reason the bed repaint stays a
        // metre under: the pads are placed off the analytic depth field on a
        // 4 m grid while the ground you SEE is a mesh with 8.7 m facets that
        // cuts the corner off every bank. Pads sited in half a metre of
        // analytic water came out lying on green grass several metres up the
        // shore, a raft of leaves floating over a meadow.
        if (d < 1.15 || d > 2.4) continue;
        // Rafts, never a sprinkle — and only in the corner of a bay, so a wide
        // shelf does not come out carpeted in leaves.
        if (F.shore && F.shore[j * VN + i] > 15) continue;
        if (rng.float() > 0.009) continue;
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
          if (dd < 0.95 || dd > 2.9) continue;
          const R = 0.70 + rng.float() * 0.60;
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
      // Squash and dent it: perfect icosahedra read as dice, not granite. But
      // NOT flat — squashing to 0.42 and then letting place() scale y by
      // another 0.7 gave boulders three tenths as tall as they were wide, and
      // at this camera angle a stone that flat is a scrap of paper lying on the
      // grass, not a rock. The whole world has a problem with those this round;
      // the lake is not going to add to it.
      const sy = 0.62 + rng.float() * 0.38;
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
        .premultiply(new THREE.Matrix4().makeScale(r, r * (0.85 + rng.float() * 0.5), r))
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
        // AND KEEP IT AT THE SHORE. These rates were tuned when the bed fell
        // away over twenty metres; the bank is now a seventy-metre shelf, so
        // the same probability per cell covered an acre of shallows and the
        // lake came back looking like a scree slope with water in it
        // (shots/ladder_hero/hero_alpine_t12.png). Rocks belong where the water
        // meets something, not spread evenly over the shelf.
        const sh = shore[j * VN + i];
        if (sh > 20) continue;
        const near = 1 - sh / 20;
        // Emergent rocks only in genuinely shallow water. Deeper than that the
        // surface is 97% opaque, so all you see is the cap and the boulder
        // reads as a stone floating in mid-lake rather than standing in it.
        const emergent = d < 1.6;
        if (rng.float() > (emergent ? 0.018 : 0.007) * (0.3 + near * near)) continue;
        const x = x0 + i * cell + (rng.float() - 0.5) * cell;
        const z = z0 + j * cell + (rng.float() - 0.5) * cell;
        // Not under the bridge deck, and not on the knife of ground the road
        // crosses a neck on: a boulder there is a boulder inside the timber.
        if (F.keepOut && F.keepOut(x, z)) continue;
        const r = emergent ? 1.0 + rng.float() * 1.9 : 1.0 + rng.float() * 1.3;
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
          // Never below zero: the shore attribute is signed now, and a negative
          // value means "outside the water", which the shader fades to nothing.
          // Stamping the rock's own footprint negative would punch a hole in the
          // lake around every boulder.
          const e = Math.max(0.05, Math.hypot(dx, dz) - st.r);
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
