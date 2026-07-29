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
// MEASURED OFF THE TARGET, NOT PICKED BY EYE (tools/px.mjs, which histograms
// the blue-dominant pixels of a frame). The reference lake and ours were both
// "saturated cobalt" to look at and a long way apart on the numbers:
//
//                    mean RGB        median pixel
//     target       [  5, 103, 173 ]    #0168b9
//     ours (r06)   [  8,  93, 199 ]    #065cb8
//     ours (depth-driven ramp) [8, 60, 183]  #0133b8
//
// The green channel is the whole story. The reference's water is a TEAL cobalt
// — a lake with light in it — and every swatch here was a pure blue, which is
// what made the body read as a painted slab however good the bathymetry under
// it got. Raising green about forty per cent across the ramp, and taking a
// little blue out of the deep end, lands the median on the target's.
export const LAKE_COLORS = {
  alpine: {
    // Re-measured against target_01. Ours was a vivid cobalt that pushed the
    // frame's mean blue to 74 against the reference's 44 — the lake covers a
    // third of the hero frame, so its brightness dominates that statistic and
    // it was also what made the water read as one flat fill. The reference's
    // water is deeper, greener and darker, with a wider deep-to-shallow spread
    // so the surface has somewhere to vary.
    // RE-MEASURED AGAIN, against the pixel populations rather than the whole
    // frame (tools/pop.mjs). Our blue-dominant pixels averaged [23,89,167]
    // against the reference's [8,101,168]: the blue channel was already right
    // and the other two were both wrong in the same direction — fifteen points
    // too much red and twelve too little green, which is a lake lit like a
    // swimming pool rather than one with light in it. The red mostly came in
    // through the pale end of the ramp, so that is where most of it comes out.
    deep: 0x06618f,
    mid: 0x0c86b4,
    shallow: 0x2ba6cc,
    shore: 0x59c2d8,
    // A shade off white. The bloom pass squares whatever the brightest pixel
    // in the frame is, and at 0xf2fbff the foam line was it — a 1.2 m lip came
    // back as a glowing three-metre band of haze along every near shore.
    foam: 0xe6f3fb,
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
  // MEASURED TOO WET. Splitting the hero frame into pixel populations rather
  // than taking one global mean: blue-dominant pixels were 14.1% of
  // hero_alpine, 32.4% of lake_bridge and 47.9% of wildlife, against the
  // reference frame's 11.0%. Averaged over the three that is nearly a third of
  // the picture given to water; the reference gives it a ninth, at the edge of
  // frame, and spends the rest on meadow and on the scattered stone-and-flower
  // detail the client says we are missing. Water is meant to be a feature of
  // the drive, not the drive's backdrop.
  //
  // SPACING AND BRIDGE FREQUENCY ARE TWO DIFFERENT DECISIONS, and tying them
  // together is what made this hard to tune. At a 300 m stride with every third
  // station a crossing, hero_alpine's shutter fell 35 m past a crossing and 265
  // m short of the next scenic station — so the frame had a pair of small lobes
  // in the corner and nothing else, 4.1% blue against the reference's 11.0%,
  // however large the scenic basins were made. The camera reaches perhaps 150 m;
  // a tarn planted 265 m up the road is a tarn nobody photographs.
  //
  // So the stations come back in close, and it is the crossing COUNT that is
  // cut instead: every fifth station is a neck, which at this stride is a
  // bridge every 850 m — still one about 250 m past the start line, because ord
  // begins at zero, and no longer a chain of them owning the frame.
  // ...AND CLOSER STILL, because a station 85 m up the road is a basin planted
  // 85 m up the road, and the lens reaches about sixty. At 170 m hero_alpine's
  // shutter fell midway between two stations and its frame came back 5.8% wet
  // while the ground within 130 m of the car was 11.6% wet: the water existed,
  // it was simply never in front of the camera. A 120 m stride puts a station
  // within sixty metres of wherever the shutter opens.
  STRIDE: 120,        // route metres between tarns
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
  // ...AND A HUNDRED AND TWENTY-FIVE METRES IS OUTSIDE THE PICTURE.
  //
  // Ray-marching the capture camera onto the ground (tools/waterprobe.mjs)
  // gives hero_alpine a footprint of 116 x 112 m with the road through the
  // middle of it. Reaching full dig depth only at 125 m from the centreline
  // therefore means every square metre of lake the lens can see is on the
  // shallowest, driest tenth of the profile — the frame came back 5.3% wet
  // however big the basins were made. Seventy-two metres still leaves half a
  // metre of water fifty metres off the carriageway, which is the run-off
  // hazard this number was chosen for, and puts real depth inside the frame.
  ROAD_OUT: 60,       // ...full depth beyond this
  APRON_IN: 11,       // ground held clear of the water out to here...
  APRON_OUT: 22,      // ...tapering to nothing here
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
  // THE RIM IS WHERE THE WATERLINE IS, and it was fifty-two metres out.
  //
  // Nothing else in this file could put water nearer the road than the rim's
  // outer edge, because inside it the ground is filled clear of the surface
  // whatever the basin wanted. With the capture frame 116 m across and the road
  // running through it, a waterline at 52 m from the centreline is a waterline
  // at the very corner of the picture — which is exactly what every shot came
  // back with. Thirty-eight metres puts the shore about two thirds of the way
  // out to the frame edge, which is where the reference has it, and the hump
  // still stands between the run-off and the water.
  RIM_IN: 13,         // rim starts here (just past the apron's taper)...
  RIM_PEAK: 24,       // ...crests here...
  RIM_OUT: 38,        // ...and is gone by here, into open water
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

// ---------------------------------------------------------------------------
// BATHYMETRY NOISE
//
// "The water looks like a single texture filled with one flat colour." It does,
// and no shader was ever going to fix it, because the colour is driven by DEPTH
// and the depth was constant: one smooth elliptical bowl with a dead-flat floor
// at 8.5 m, over which the ramp saturates at uDeep and stays there for two
// hundred metres. The only variation anywhere in the body was a ±2 m share of
// whatever relief the meadow underneath happened to have, damped to nothing on
// the shelf — which on a basin dug out of a smooth hillside is nothing at all.
//
// A real tarn's bed rolls. These two fields give it something to say:
//
//   bedRoll   ±2.7 m of broad swell, so the open water drifts in tone the way
//             the reference's does instead of holding one value;
//   shoal     a sparse ridged field that lifts the bed to within a metre or two
//             of the surface in a handful of places per basin. That is where
//             the pale water, the stones showing through and the lily pads live
//             — the middle of the lake stops being empty because there is
//             something IN it.
// ---------------------------------------------------------------------------
function vhash(a, b) {
  let n = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  return (vhash(xi, zi) * (1 - u) + vhash(xi + 1, zi) * u) * (1 - v)
       + (vhash(xi, zi + 1) * (1 - u) + vhash(xi + 1, zi + 1) * u) * v;
}

/** Metres the bed rolls up or down here. Wavelengths ~120 m, ~60 m, ~25 m. */
function bedRoll(x, z) {
  return (vnoise(x * 0.0083 + 11.3, z * 0.0083 - 4.1) - 0.5) * 2.6
       + (vnoise(x * 0.0165 - 7.7, z * 0.0165 + 21.9) - 0.5) * 1.9
       + (vnoise(x * 0.041 + 3.5, z * 0.041 + 9.2) - 0.5) * 0.8;
}

/**
 * 0 over most of the bed, 1 on the crest of a shoal.
 *
 * MEASURED, because the first version was too shy to matter. One octave
 * thresholded at 0.6 put only five per cent of a lake's floor within two and a
 * half metres of the surface and none of it within one — so across forty-seven
 * basins the whole world got ninety-one boulders standing on shoals, two per
 * lake, and the middle of the water was as empty as before the field existed.
 *
 * Two octaves combined with a max (so a big slow rise and a small sharp one
 * both count) at a threshold of 0.5 gives 5% of the floor under a metre, 14%
 * under two and a half, and 25% under four. That is a lake with banks in it,
 * not a swamp: three quarters of the surface is still deep open cobalt.
 */
function shoalField(x, z) {
  const a = vnoise(x * 0.0212 + 31.7, z * 0.0212 - 12.3);
  const b = vnoise(x * 0.0098 - 5.1, z * 0.0098 + 27.4);
  const s = Math.max(a, b * 0.96);
  const t = Math.max(0, (s - 0.50) / 0.50);
  return t * t * (3 - 2 * t);
}

/**
 * THE BED PROFILE — depth as a fraction of CARVE.DEPTH at normalised
 * elliptical radius u. This one curve is the whole shape of the lake.
 *
 * WHAT IT REPLACED, AND WHY THAT WAS THE DEFECT.
 * The bed used to be two independent fields multiplied into the ground: a
 * `dig` ramping to full depth from u = 1.02 inwards, and a `berm` that lifted
 * everything between u = 0.58 and 0.88 up to a metre and a half ABOVE the
 * waterline "so the shoreline closes". They overlap over half the basin, and
 * where they overlap they fight: measured on the alpine plan, the bed went
 * from dry at u = 0.80 to four and a quarter metres deep at u = 0.70 — six and
 * a half horizontal metres for four vertical, a 1:1.6 wall running right round
 * every tarn. On a wall like that there is no shallow band to be pale, no
 * shelf for a rock to stand in, no beach, and the foam has nowhere to sit but
 * a hard line. One flat slab of cobalt with a stripe round it is exactly what
 * that bathymetry has to render as; no shader could have saved it.
 *
 * So it is one profile now, and the interesting part of it is the SHELF:
 *
 *   u      0.34   0.60        0.80      0.90        1.12
 *   depth  ▔▔▔▔▔╲             ╲___      ╲___         (dry)
 *          8.5 m  ╲___ 2.9 m ___╲ 0.8 m __╲ 0 ______╲ -2.7 m
 *          floor   the drop      the shelf  beach     bank
 *
 * At the alpine basin sizes (Rc 84-130 m) that is seventeen to twenty-six
 * metres of water under three metres deep — a band tens of pixels wide at the
 * capture camera — then eight to twelve more of beach at about 1:11. That band
 * is where every readable thing in the reference frame lives: the pale
 * turquoise, the stones showing through, the foam, the lily pads.
 *
 * WHERE THE WATERLINE SITS IS ALSO A TONE DECISION. The first version of this
 * curve put it at u = 0.96 against the old profile's effective 0.80, which is
 * forty per cent more water — and the frame went from 10.3% blue pixels to
 * 15.4% against the reference's 10.4%, taking the frame's mean luma up with
 * it. Pulled back to 0.90 the shelf is if anything wider (0.30 of u rather
 * than 0.28) and the lake is a fifth smaller.
 */
/**
 * WHERE THE WATERLINE SITS, as a fraction of the planned ellipse. This is the
 * second and finest of the three levers on how much of the frame is blue, and
 * the cheapest: wetted area goes as the square of it, so 0.90 -> 0.78 is a
 * lake a quarter smaller with the same basin, the same bank, the same shelf
 * profile and the same bridge — the shore simply stands further up the bowl.
 * Nothing downstream has to know: the berm that closes the shoreline sits at
 * u = 0.88-1.02 and is outside the water either way.
 */
const WATERLINE = 0.78;

/**
 * ...AND THE SHELF WAS AUTHORED FOR A BASIN THAT NO LONGER EXISTS.
 *
 * The curve above spent a quarter of the radius getting from the waterline to
 * a third of full depth. On the 84-130 m basins it was written for that is
 * twenty to thirty metres of shallows; on the 94-140 m ones the frame needs,
 * it is thirty-six, and the capture camera only reaches about sixty metres
 * past the road — so every drop of water the lens could see was under a metre
 * deep. The hero frame came back with a wide pale flat showing its own gravel
 * bed through it, which reads as a dried-out lagoon, not as a tarn.
 *
 * The profile is therefore stated in metres from the shore and then converted,
 * because metres are what the picture is made of:
 *
 *     8 m out -> 1 m deep      (the pale shelf: foam, stones, lily pads)
 *    20 m out -> 3 m deep      (cobalt begins)
 *    45 m out -> 8.5 m         (the floor)
 *
 * which on a 140 m basin is the numbers below. That is still a gentle 1:8
 * approach — a car that runs wide meets a foot of water and drives out of it —
 * and it is deep enough to be blue everywhere the camera can actually see.
 */
function bedFrac(u) {
  // The curve is authored against a waterline at 0.90; rescaling the radius is
  // what moves it, so the shape keeps its proportions instead of being squeezed
  // out of existence by editing five thresholds by hand.
  const v = u * (0.90 / WATERLINE);
  if (v <= 0.53) return 1;
  if (v <= 0.735) return 1 - 0.647 * sstep(0.53, 0.735, v);
  if (v <= 0.834) return 0.353 - 0.235 * sstep(0.735, 0.834, v);
  if (v <= 0.90) return 0.118 * (1 - sstep(0.834, 0.90, v));
  return -0.32 * sstep(0.90, 1.12, v);
}

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
    // MEASURED: THE CROSSINGS ARE THE LAKE.
    //
    // tools/waterprobe.mjs walks the capture camera's ground footprint and asks
    // the live world how deep the water is, then attributes each wet sample to
    // the basin that owns it. On all three presets almost every wet pixel came
    // from a CROSSING LOBE and almost none from a scenic tarn: hero 10.7% neck
    // against 2.1% scenic, lake_bridge 17.8 / 0.0, wildlife 10.3 / 0.8, with
    // open water 7 m from the car on wildlife and 13 m on hero. Every knob
    // turned on the scenic tarns above was turning the wrong knob.
    //
    // A lobe has to reach the verge — the water runs under the planks, that is
    // the whole point of a bridge — so the only way to stop crossings owning
    // the frame is to have fewer of them. ord starts at zero, so the FIRST
    // station is still a crossing about two hundred and fifty metres past the
    // start line: the player meets water and crosses it early, which is the
    // thing this chain exists for.
    const neck = (ord % 7) === 0;
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
      // A HUNDRED-METRE SPAN IS A VIADUCT, NOT A TARN CROSSING. Ra is half the
      // wet run the deck has to cover, and at 56-74 the water ran a hundred and
      // ten to a hundred and fifty metres along the road with the shore at the
      // verge for all of it — which is most of what the frame was seeing. The
      // reference's bridge is about seventy metres of timber over a narrow arm
      // of the lake, and it is unmistakably the landmark of the picture at that
      // size. Eighty to a hundred and ten metres of wet run still reads as a
      // real crossing and is nothing like a coastline.
      const Ra = 30 + rng.float() * 12;         // half the crossing's length
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
      // The lobes are the widest water on the map — a hundred and thirty metres
      // of half-depth either side of the deck put open water across two thirds
      // of lake_bridge and nearly half of wildlife. A lobe a hundred metres
      // deep still reaches well past the far end of a hundred-metre span, which
      // is all the crossing needs: what sells a bridge is water UNDER it, not
      // an inland sea at both ends of it.
      // AN ARM OF WATER, NOT A BAY. Rc is how far the lobe reaches away from
      // the road; with the offset at half of it the wet part runs from a
      // quarter-radius past the centreline — which is what puts water under the
      // planks — out to 1.28 Rc on its own side. At 88 that was ninety metres
      // of open water either side of a seventy-metre deck, and on wildlife,
      // whose shutter falls on the first crossing by construction, it filled
      // two thirds of the frame. Sixty-six gives a hundred-and-seventy-metre
      // channel across the whole crossing: unmistakably a lake the bridge goes
      // over, and not the only thing in the picture.
      for (const Rc of [58, 50, 42, 35, 29]) {
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
      // THE MARGIN IS THE MEASUREMENT, NOT THE DISTANCE.
      //
      // Siting the basin at a fixed number of metres down-view was the wrong
      // parameterisation: a 208 m-wide ellipse centred at 134 m has its near
      // WATERLINE thirty metres from the road, so the guard band — not the plan
      // — decided where the shore went, and the shore went to the verge on
      // every seed. Measured: 40.7% of the wildlife frame blue, against the
      // reference's 11.0%, with the road running along the lip of it.
      //
      // The reference does not do that. Its lake sits back with a hundred
      // metres of meadow, boulder field and flowers between the carriageway and
      // the water, and that band is where most of the small detail the client
      // says is missing actually lives. So the near waterline is placed
      // directly: MARGIN metres of dry ground, then the shore, then as much
      // tarn as the basin has in it.
      // And the SCENIC tarns get a little back, because they are the good kind
      // of water: a body set back from the road, with a dry foreground of
      // meadow and boulders between, which is exactly the composition the
      // reference has. It is the crossings that were eating the frame.
      // AND THE MARGIN IS BOUNDED ABOVE BY THE LENS. At 72-96 m the basins were
      // dug, filled and never photographed: hero_alpine's ground was 12.4% wet
      // inside a 130 m radius and the frame came back 4.1% blue, because the
      // capture camera's footprint at the car is about eighty metres across and
      // the near shore had been pushed past the far edge of it. Fifty-six metres
      // is the widest dry foreground that still leaves the water in shot, and it
      // is about what the reference has between its road and its lake.
      for (const MARGIN of [38, 30, 24]) {           // dry metres road -> shore
        for (const Rc of [140, 116, 94]) {            // half depth along view
          // WIDE ACROSS THE PICTURE, SHALLOW INTO IT.
          //
          // The frame is much wider than it is deep in ground terms — the lens
          // reaches perhaps eighty metres across at the car and only a little
          // further away from it — so a basin as wide as it is deep spends most
          // of its water off the sides of the shot. The reference's lake fills
          // the left EDGE of the frame from top to bottom and reaches only a
          // short way into it; that is a body elongated across the view, which
          // is what this ratio makes.
          const Ra = Rc * 1.8;                        // half width across view
          const D = WATERLINE * Rc + MARGIN;          // metres down-view
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
          // same: a tarn you drive past beats a tarn on the horizon. The margin
          // is scored gently — a wide dry foreground is worth having, but not
          // at the price of pushing the water out of shot altogether.
          const score = cost - Rc * 0.05 + MARGIN * 0.02;
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
  // TIGHTER STILL. Falling off only by 0.78 of the lobe's length meant the
  // narrow keep-out — the one that lets water reach the verge — applied over
  // four fifths of a hundred-and-forty-metre lobe. The crossing is a place
  // twenty metres long; past that the lobe should be treated as an ordinary
  // scenic tarn, with the scenic apron and the rim holding the water back.
  const neckW = (L, dx, dz) => {
    if (!L.neck) return 0;
    return 1 - sstep(0.20, 0.52, Math.abs((dx * L.tx + dz * L.tz) / L.Ra));
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
    // The shoal is applied ONCE, after every basin has had its say — see below.
    let shoalShape = 0, shoalLevel = 0;
    for (let i = 0; i < lakes.length; i++) {
      const L = lakes[i];
      const dx = x - L.x, dz = z - L.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > L.R2out) continue;
      const ua = (dx * L.tx + dz * L.tz) / L.Ra;
      const uc = (dx * L.nx + dz * L.nz) / L.Rc;
      const u = Math.hypot(ua, uc);
      // THE BED PROFILE. See bedFrac() — one continuous curve from the floor
      // out to the dry bank, replacing a `dig` and a `berm` that used to be
      // computed separately and fought each other into a wall.
      const bf = bedFrac(u);
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
      if (u > 1.36 || g <= 0) continue;
      // Fade the whole carve out past the rim so the basin blends into the
      // hillside instead of ending on a step. The old profile hard-set every
      // point inside u = 1.02 to level + 3 and did nothing at 1.03, which is a
      // one-cell cliff running right round the lake — and that cliff, not the
      // shader, is why the shoreline read as a cut.
      const k = g * (1 - sstep(1.08, 1.36, u));
      // The bed keeps a share of whatever relief the meadow had, scaled by how
      // deep it is here. A dead flat floor gives a dead flat depth field, and
      // depth is what drives the colour ramp — the whole body then comes out
      // one slab of cobalt. Damping it on the shelf keeps the shelf a shelf:
      // half a metre of wobble in eighty centimetres of water is dry islands.
      // RELIEF ON THE FLOOR ONLY, AND NOT MUCH OF IT.
      //
      // Keeping a share of the meadow's own relief in the bed is what stops the
      // depth field — and therefore the colour ramp — coming out dead flat. But
      // it was clamped at five metres and scaled to full strength by two thirds
      // of the way out, so on any basin sited on high ground it simply filled
      // the shelf in: measured with tools/bath.mjs, the median distance from
      // the waterline to three metres of water was SIX metres, against the
      // fifteen to thirty-five the profile asks for. Tied to bf it is a wobble
      // on the floor, worth a couple of metres where the water is opaque
      // anyway, and worth centimetres on the shelf where the picture is.
      // ...AND THAT IS STILL NOT ENOUGH TO SEE. A share of the meadow's relief
      // is worth having, but a basin dug out of a smooth hillside has almost no
      // relief to share, so the floor came out flat and the whole body of water
      // rendered as one value of uDeep. The two noise fields below are the
      // actual answer to "the water looks like a single texture filled with one
      // flat colour": bedRoll makes the open water drift in depth, and
      // therefore in tone, by a couple of metres over sixty; shoalField lifts
      // it to within a metre or two of the surface in a few places, which is
      // where the pale water, the stones and the lily pads come from.
      // Fade both out on the shelf: half a metre of wobble in eighty
      // centimetres of water is dry islands, and the shelf is where the foam
      // and the waterline live.
      // ...and the shoals keep OFF the shelf entirely. At bf * 2.4 they were at
      // full strength by two metres of water, which is the readable band the
      // pale swatch and the foam live in — so the near shore of every tarn came
      // back as a broad wash of near-white blue and the frame's water pixels
      // averaged [57,91,133] against the reference's [8,101,168]. A shoal
      // belongs out where the water would otherwise be an unbroken slab.
      const shape = Math.min(1, Math.max(0, (bf - 0.26) * 2.7)) * k;
      if (shape > shoalShape) { shoalShape = shape; shoalLevel = L.level; }
      const relief = Math.max(-2.0, Math.min(2.2, (h - L.level) * 0.22))
                     * Math.max(0, bf)
                   + bedRoll(x, z) * shape;
      // The cut is measured from a rim held three metres above the water, so a
      // basin dug into rising ground comes out as a bowl and not as a hole in a
      // hillside. (That reference height is inherited from the profile this
      // replaced; only the CURVE has changed.) Hard-set, not blended toward the
      // natural ground: blending it was tried and half the lakes disappeared,
      // because a basin sited on ground forty metres up never got dug at all.
      const target = L.level + 3.0 - (3.0 + CARVE.DEPTH * bf - relief) * k;
      if (target < h) h = target;
      // CLOSING THE SHORELINE. Out on the bank, ground still under the
      // waterline is lifted clear of it — otherwise a basin dug into a valley
      // ends in a wall of blue at the lattice boundary rather than at a shore.
      // This is the old `berm`, but moved OUTSIDE the water instead of sitting
      // at two thirds of the radius where it used to collide with the cut.
      if (bf < 0) {
        const need = L.level - CARVE.DEPTH * bf;
        const lift = g * sstep(0.88, 1.02, u) * (1 - sstep(1.08, 1.32, u));
        if (h < need) h += (need - h) * lift;
      }
    }
    // THE SHOALS GO IN LAST, AND THAT IS WHY THEY NOW EXIST.
    //
    // Riding them along with each basin's own relief term did almost nothing,
    // and the reason is the `if (target < h) h = target` above: a shoal RAISES
    // the bed, so the moment any neighbouring basin — and with the stations
    // this close most points are inside two or three — offered a deeper target,
    // the rise was thrown away. Measured across forty-seven lakes: a hundred
    // and nine boulders ended up standing on a shoal, two per lake, in a field
    // that was supposed to cover a seventh of every floor.
    //
    // Applied here it is a single unconditional lift of whatever bed the basins
    // between them settled on, capped so the crest always stays about half a
    // metre under water. An island in a tarn this size reads as a bug, and the
    // lattice would have to be re-clipped round it.
    if (shoalShape > 0.02) {
      const dep = shoalLevel - h;
      if (dep > 1.0) {
        const rise = Math.min(shoalField(x, z) * 8.6 * shoalShape, dep - 0.45);
        if (rise > 0) h += rise;
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
    // THE STRAND. The note above is right about the ROAD — an ochre band beside
    // the carriageway reads as more carriageway — and wrong about the shore.
    // The reference's waterline is not grass meeting blue: look at the top of
    // the frame and there is a pale warm band of wet gravel two or three metres
    // wide between the meadow and the water, and it is what stops the shoreline
    // reading as a cut. It was safe to leave it out while the bank was a 1:1.6
    // wall, because a wall has no strand. The bank is 1:11 now.
    // MID TONE, NOT PALE. The first version was the biome's sand barely
    // shaded, and under the semi-transparent last two metres of lattice it
    // mixed with the blue into a wide lavender-grey band that read as haze
    // lying on the shore — conspicuous on wildlife, where the near bank fills
    // a third of the frame. Wet gravel is darker than dry sand anyway.
    const strand = new THREE.Color(palette?.terrain?.sand ?? 0xb9ae92)
      .lerp(new THREE.Color(palette?.rock ?? 0x8f9099), 0.34)
      .lerp(new THREE.Color(palette?.rockShadow ?? 0x5f6069), 0.55);
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
      // BOTH HEIGHT FIELDS, AND BELIEVE THE LOWER ONE.
      //
      // `my` is the mean of three mesh vertices; the lattice asks heightAt() at
      // the centroid. On a 8.7 m facet lying on the shelf those disagree by up
      // to a metre, which is ELEVEN metres of ground at 1:11 — so a band that
      // wide came out unrepainted under water that is deliberately glassy, and
      // lake_bridge's shallows had green meadow legible through them. Taking
      // the deeper reading errs toward painting a little dry gravel at the
      // waterline, which is a strand, and away from green under the water,
      // which is a hole in the illusion.
      // ...AND THAT REASONING HAS THE OCCLUSION BACKWARDS.
      //
      // Taking the deeper of the two readings does keep green out of the
      // shallows — but a facet whose analytic height is a metre under the
      // waterline while its drawn chord stands above it is a facet that
      // OCCLUDES the water lattice. So it got painted wet gravel and then had
      // no water drawn over it, and what the frame gained was a broad pale
      // grey-tan beach lying between the meadow and the blue, hard-edged along
      // every facet boundary — the most conspicuous thing in the wildlife
      // capture and pure invention: the reference has a stony rim, not a
      // sandbank. On the 1:8 bank this profile cuts, one metre of height
      // disagreement is eight metres of ground, so the band was twenty metres
      // wide.
      //
      // Believe what is DRAWN. A face that renders above the waterline keeps
      // the meadow, whatever the smooth field thinks, because that is what the
      // player sees.
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
      // AND THAT IS NO LONGER TRUE, because the bank is no longer a wall.
      //
      // Holding the repaint a clear metre under the surface was the right
      // answer on a 1:1.6 bank: a metre of height there is under two metres of
      // ground, so the strand stayed inside the water whichever of the two
      // height fields you believed. On the 1:11 shelf the profile now cuts, a
      // metre of height is ELEVEN metres of ground — so the whole shallow bed,
      // the part the water is deliberately glassy over, kept the meadow's
      // green, and lake_bridge came back with grass and its white flowers
      // legible under the shallows. The bed is repainted from the waterline
      // down now, and the top of that band is a warm gravel strand rather than
      // grey silt, which is the beach the reference has and we did not.
      if (d < 0.25) {
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
      // A WARM STRAND AT THE WATERLINE, GREY SILT AS IT DROPS AWAY.
      //
      // The first band is the beach — pale wet gravel, fully covering the
      // meadow by half a metre down, which is where the water is glassiest and
      // therefore where the bed is most legible. Past a couple of metres it
      // turns to grey silt and then to shadow, and by four metres the surface
      // is opaque over it and none of this is visible at all.
      // A NARROWER, DARKER STRAND. On the old 1:11 bank a band from half a
      // metre to a metre and a bit under the surface was a couple of metres of
      // ground; the shelf drops at 1:8 now and the whole thing is drawn under
      // water that is deliberately glassy, so the same numbers gave a wide pale
      // rim reading as sand. Wet gravel is a dark thing seen through blue.
      c.setRGB(col[t], col[t + 1], col[t + 2]);
      c.lerp(strand, Math.min(1, sstep(0.25, 0.95, d) * 0.72));
      c.lerp(silt, sstep(1.1, 2.4, d) * 0.85)
       .lerp(wetc, Math.min(1, Math.max(0, d / 5)) * 0.6);
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
    // AND THE RAMP IS DRIVEN BY DEPTH, NOT BY DISTANCE.
    //
    // Keying the shelf colour on horizontal metres to the shore was right when
    // the bank was a wall and depth told you nothing — but on the shelf the
    // profile cuts now it is exactly wrong, because the shelf is fifteen to
    // thirty metres wide and the ramp reached uMid only at twenty-two. So the
    // whole of it came out pale: lake_bridge's shallows were a hundred-metre
    // wash of near-white blue that read as haze rather than as water, and the
    // frame had no gradient in it at all, only a flat pale zone and a flat
    // cobalt one.
    //
    // Depth is the physical driver and it is the one that puts the pale band
    // where the eye expects it — hugging every rock and every inlet, narrow on
    // a steep bank and broad in a bay — because the bathymetry does that work.
    // The shore distance is kept for one job only: a pale lip pinned to the
    // waterline itself, which depth alone cannot place accurately at the 4 m
    // lattice resolution.
    vec3 col = uShore;
    col = mix(col, uShallow, smoothstep(0.05, 0.55, d));
    col = mix(col, uMid,     smoothstep(0.65, 2.30, d));
    col = mix(col, uDeep,    smoothstep(2.60, 5.80, d));
    col = mix(col, uShore,   (1.0 - smoothstep(0.0, 1.8, s)) * 0.30);

    // THE DEEP END HAS TO KEEP MOVING, or the bed's relief is invisible.
    //
    // The ramp above saturates at uDeep by 5.8 m and the floor now rolls
    // between about six and eleven — so without this term every one of those
    // metres renders as exactly the same colour and the whole middle of the
    // lake is a painted slab, which is the client's complaint word for word.
    // Carrying on darkening into the deeps is also just what water does.
    // ...and it is a HUE change as well as a brightness one. Darkening alone
    // reads as a cloud shadow lying on a flat colour; real deep water goes
    // greener as well as darker, and that is what makes the drift look like
    // water rather than like lighting.
    float deep = smoothstep(4.2, 11.0, d);
    col *= 1.0 - 0.19 * deep;
    col.g += 0.030 * deep;
    col.b -= 0.020 * deep;

    // Broad ripple bands. Posterised, because everything else in this world is
    // cut paper and a smooth gradient reads as a different game. Signed about
    // the mean rather than one-sided: mixing toward col * 1.15 lifted the
    // strongest band anywhere by eleven per cent and left every other pixel at
    // the base value, so the field read as a faint stain on a flat colour
    // instead of as structure.
    vec2 p = vWorld * 0.013;
    float w = noise(p + vec2(uTime * 0.05, uTime * 0.032));
    w += 0.5 * noise(p * 2.4 - vec2(uTime * 0.07, 0.0));
    w /= 1.5;
    // TWO OCTAVES SUMMED AND HALVED IS A FIELD THAT NEVER LEAVES THE MIDDLE.
    // Measured on the histogram, w sat between 0.35 and 0.65 almost everywhere,
    // so a five-step posterise only ever produced the middle three steps and
    // the band term came out at plus or minus five per cent — invisible, which
    // is why the open water still read as one value after the field was added.
    // Stretching it about its mean is what turns it into structure.
    w = clamp((w - 0.5) * 2.4 + 0.5, 0.0, 1.0);
    float band = floor(w * 5.0) / 5.0;
    col *= 1.0 + (band - 0.4) * 0.30;

    // WIND LANES.
    //
    // A lake seen from above is crossed by long stripes of ruffled and glassy
    // water lying across the wind, and that is the one piece of structure the
    // open middle of the reference's tarn actually carries. One direction,
    // stretched about fifteen to one, posterised to three steps so it reads as
    // cut paper. Faded out in the shallows, where the foam and the bed are
    // already doing the work and a stripe would only fight them.
    vec2 lane = vec2(vWorld.x * 0.85 + vWorld.y * 0.53,
                    -vWorld.x * 0.53 + vWorld.y * 0.85);
    float lanes = noise(vec2(lane.x * 0.0055, lane.y * 0.075) + vec2(0.0, uTime * 0.03));
    lanes = floor(lanes * 3.0) / 3.0;
    col *= 1.0 + (lanes - 0.5) * 0.11 * smoothstep(0.6, 2.4, d);

    // A second, much slower field, so the open water carries a broad tonal
    // drift rather than one flat value out to the horizon. The reference's
    // lake is mostly a single blue too — but it is not the SAME single blue
    // from one side to the other, and at this frame size that difference is
    // what stops a hundred metres of it reading as a painted slab.
    col *= 0.925 + 0.155 * noise(vWorld * 0.0032 + vec2(uTime * 0.006, 0.0));

    // --- foam at the waterline ---------------------------------------------
    // A bright lip about half a metre wide, chewed up by two noise octaves so
    // it is ragged and — importantly — ABSENT along stretches of shore. An
    // unbroken white piping all the way round the lake is the single loudest
    // tell that the water is a decal rather than a body of water.
    float chew = noise(vWorld * 0.11 + vec2(uTime * 0.05, uTime * 0.035));
    float chew2 = noise(vWorld * 0.38 - vec2(0.0, uTime * 0.14));
    // Forty centimetres to a metre and three quarters. Under a third of a metre
    // the lip lands inside one lattice cell at this camera distance and is
    // chewed away by the shore noise before it reaches a pixel; over two and a
    // half it stops being a lip and becomes a milky bank of surf.
    float edge = 0.32 + chew * 0.72 + chew2 * 0.34;
    // Dies off on BOTH sides of the waterline. Before it was keyed on an
    // unsigned distance, so every vertex the lattice carried past the shore
    // read as "zero metres from the water" and got the full lip — which on a
    // shelving bank is a twenty-metre snowfield, not a wave.
    // Sat a metre and a half further out than it used to. The last couple of
    // metres of lattice are faded out now (see uClip below), because that is
    // where the terrain's facets cut it; foam left sitting in that band was
    // foam nobody could see.
    float lip  = (1.0 - smoothstep(0.8, 0.8 + edge, s)) * smoothstep(0.0, 1.1, sg);
    float wash = (1.0 - smoothstep(0.8 + edge, 2.1 + edge, s)) * (0.03 + 0.11 * chew2)
               * step(0.0, sg);
    // BROKEN, NOT ABSENT.
    //
    // The gate opened at 0.52 on a field whose mean is 0.6, and the result was
    // multiplied by 0.40 — so the strongest foam anywhere on the lake mixed in
    // at fourteen per cent, which is to say there was no foam at all. Both
    // captures came back with a shoreline of grass meeting blue and nothing
    // between them. The reference has a white lip on every rock it touches and
    // along most of its shore; what it does NOT have is an even piping, which
    // is what the gate is for. So the gate stays and it opens earlier, and the
    // lip is allowed to be white where it is there at all.
    float gate = smoothstep(0.26, 0.66, chew * 0.75 + chew2 * 0.45);
    float foam = clamp(lip + wash, 0.0, 1.0) * gate;
    // A LITTLE QUIETER. The lattice now fades over four metres of shore rather
    // than one and a half, so the lip sits inside a band that is already
    // half-transparent — and at 0.46 the bloom pass turned the sum into a
    // glowing rope tracing every facet corner of the near shore.
    col = mix(col, uFoam, foam * 0.34);

    // --- sun glitter --------------------------------------------------------
    // Sparse and restrained. At 1.1x this fed the bloom pass two soft white
    // blobs the size of a car in every crossing frame, which read as smudges on
    // the lens rather than as sun on water.
    float glint = pow(max(0.0, noise(p * 7.0 + uTime * 0.22)), 26.0);
    col += uSun * glint * 0.45 * smoothstep(0.6, 3.0, d);

    // GLASSY OVER THE WHOLE SHELF, not merely at the lip.
    //
    // At 0.80 rising to 0.97 by two and a half metres, a boulder sitting in
    // eighty centimetres of water was hidden behind four fifths of a coat of
    // cobalt — which is why the frame had no stones under the surface, only a
    // few caps breaking it. The reference reads its shallows as GLASS: you see
    // the bed and the submerged rock, tinted blue, and the water only closes
    // over at three or four metres. The bed under the shelf is repainted wet
    // gravel below, so what comes through is stone, not meadow.
    // 0.46 WAS GLASS, NOT WATER. On lake_bridge the whole shelf came back as a
    // pale wash with green meadow and its white flowers legible through it —
    // the lake looked like a sheet of cellophane laid over the hillside. Two
    // thirds is enough to see a stone under the surface and not enough to read
    // a daisy through it.
    // AND OPEN A LITTLE FURTHER, because there is now something down there to
    // see. The shoals put stone within a metre or two of the surface out in the
    // open water; at 0.68 rising to opaque by 3.2 m those boulders were behind
    // four fifths of a coat of cobalt and might as well not have been built.
    float alpha = mix(0.62, 0.965, smoothstep(0.2, 4.2, d));
    alpha = max(alpha, foam * 0.70);
    // THE LATTICE CLIPS ITSELF — AND IT HAS TO FINISH BEFORE THE TERRAIN GETS
    // A CHANCE TO.
    //
    // It carries a ring of dry vertices past the waterline on purpose, so the
    // shoreline is cut by the opaque terrain rather than by a mesh boundary.
    // That was fine while the bank was a wall: a wall is nearly vertical, so
    // wherever the terrain's facets put their version of the waterline it was
    // within a metre of ours and the seam was invisible.
    //
    // On the 1:11 shelf this profile cuts, it is not fine at all. The terrain
    // is drawn at 8.7 m facets; the waterline on a facetted plane is a POLYLINE
    // with 8.7 m straight segments, and a facet whose chord sits forty
    // centimetres off the smooth field moves that line four metres sideways.
    // With the old 1.5 m fade the water was still fully opaque there, so what
    // the frame got was the facet polygon itself: a hard, dead-straight,
    // hard-cornered edge with a bright rim on it, running right round the near
    // shore (shots/mine/wildlife.png at 0.6 zoom, where it is a third of the
    // frame wide). It is THE hard cut this round was asked to remove, and it
    // was never the shader's colour ramp — it was a depth test.
    //
    // Fading over three metres of shore distance instead means the lattice has
    // gone before the terrain reaches it, so the visible edge is this ramp —
    // which rides on the noisy shore distance and is therefore organic — and
    // never the facet boundary.
    // Three metres was too much: on wildlife, where the near shore is a third
    // of the frame wide, it left a broad milky band of half-transparent water
    // lying over pale gravel that read as a dried-out lagoon. Between one and
    // two metres the facet edge is still buried and the water still reaches the
    // beach.
    // ...AND ONE AND A HALF METRES IS NOT ENOUGH ON THIS BANK.
    //
    // The fade has to outrun the terrain's own error, and that error scales
    // with how FLAT the bank is: on an 8.7 m facet lying on a 1:8 shelf, a
    // chord half a metre off the smooth field moves the drawn waterline four
    // metres sideways. Fading over 1.5 m left the water fully opaque out there,
    // so what the frame showed was the facet polygon itself — a dead straight,
    // hard-cornered zigzag of shoreline with a bright rim on it, unmistakable
    // in the wildlife capture where the near shore is a third of the frame
    // wide. Four metres puts the lattice's own soft edge outside the worst
    // facet error, so the visible shoreline is always this ramp, which rides on
    // the noisy shore distance and is therefore organic.
    alpha *= smoothstep(-1.2, 4.0, sg);
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
    const pads = {
      rng: new Rng(((getLakeContext(this.biome)?.seed ?? 1337) * 40503) ^ 0x1111),
      pos: [], col: [], rafts: 0, shoalRafts: 0,
    };
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
    // What actually got built, so a probe can answer "is there anything in the
    // middle of the lake" without reading it off a screenshot.
    this.detail = {
      rocks: acc.n, rocksOnShoals: acc.nShoal,
      rafts: pads.rafts, raftsOnShoals: pads.shoalRafts,
    };
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
    // TONED TO SIT ON WATER, NOT ON A SCREEN.
    //
    // These were the meadow's own greens, and against cobalt at this camera
    // distance a two-metre leaf of pure 0x5aa03f is a chip of colour with
    // nothing else in the frame anywhere near it. Every one of them read as a
    // stray polygon. Darker, and pulled a fifth of the way toward the water
    // they float on, they read as leaves.
    // LEAF GREEN, AND NOT A DROP OF THE LAKE IN IT. Pulling them a fifth of
    // the way toward the water they float on was meant to seat them in it; the
    // water is a teal cobalt, so what it actually did was turn every pad
    // CYAN-green — brighter against the blue than the meadow greens had been,
    // and unmistakably a stray polygon again. A lily pad is a dark, slightly
    // yellow green and it is the one thing on the lake that is NOT the colour
    // of the lake.
    const green = [0x2b5622, 0x35682a, 0x22461a, 0x3c7130];
    const c = new THREE.Color();
    /**
     * IS THERE A SHORE HERE?
     *
     * The old rule was "shallow, and within fifteen metres of a waterline",
     * which sounds like the shore and is not. A merged lake has waterlines in
     * the MIDDLE of it — the shoals where two basins' banks overlap, and the
     * dry knife of causeway a road crosses on — and a raft sited against one of
     * those is a raft in open water with no shore anywhere near it. That is
     * exactly what shots/r06 had: seven rafts of leaves scattered across deep
     * blue in the top corner of both captures, with the nearest land two
     * hundred metres away.
     *
     * So the test is made of the thing that was actually wanted: real dry
     * ground, and a decent amount of it, inside twenty metres. A stray
     * waterline has a cell or two; a shore has a quadrant.
     *
     * ...AND A SHOAL COUNTS TOO. The bed now rises to within a metre of the
     * surface well out in the open, and a raft of leaves on a shoal is the
     * cheapest thing in the world that says "there is something under the water
     * here" — which is exactly what the middle of every one of our lakes was
     * missing. A shoal is told apart from a mid-lake shoal-of-the-old-kind by
     * having NO dry ground anywhere near it and a broad shallow crest, so this
     * cannot bring back the rafts marooned in open water two rounds ago.
     */
    const bankNear = (i, j) => {
      let dry = 0, shallow = 0, seen = 0;
      for (let dj = -5; dj <= 5; dj++) {
        for (let di = -5; di <= 5; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= VN || jj >= VN) continue;
          seen++;
          const dd = depth[jj * VN + ii];
          if (dd < -0.4) dry++;
          else if (dd < 1.0) shallow++;
        }
      }
      if (seen <= 60) return null;
      if (dry >= 14) return 'shore';
      if (dry === 0 && shallow >= 13) return 'shoal';
      return null;
    };
    for (let j = 2; j < N - 1; j++) {
      for (let i = 2; i < N - 1; i++) {
        const d = depth[j * VN + i];
        // A CLEAR METRE UNDER, for the same reason the bed repaint stays a
        // metre under: the pads are placed off the analytic depth field on a
        // 4 m grid while the ground you SEE is a mesh with 8.7 m facets that
        // cuts the corner off every bank. Pads sited in half a metre of
        // analytic water came out lying on green grass several metres up the
        // shore, a raft of leaves floating over a meadow.
        // The shelf is a real shelf now, so the band can be the one lily pads
        // actually live in rather than the one that happened to exist.
        if (d < 0.8 || d > 1.8) continue;
        // Rafts, never a sprinkle — and only in the corner of a bay, so a wide
        // shelf does not come out carpeted in leaves.
        // TIGHT AGAINST THE SHORE. At fifteen metres the outer pads of a raft
        // sat past the pale band with deep blue all round them, which is a
        // green chip on cobalt however good the green is. In the reference
        // every pad is inside the shallows, within a couple of stones' width
        // of the bank.
        // ...and there has to be a SHORE — or a shoal — here, not merely a
        // waterline.
        const kind = bankNear(i, j);
        if (!kind) continue;
        if (kind === 'shore' && F.shore && F.shore[j * VN + i] > 9) continue;
        if (rng.float() > (kind === 'shoal' ? 0.020 : 0.011)) continue;
        const cx = x0 + i * cell, cz = z0 + j * cell;
        pads.rafts++; if (kind === 'shoal') pads.shoalRafts++;
        const count = 4 + rng.int(0, 7);
        for (let k = 0; k < count; k++) {
          const a = rng.float() * Math.PI * 2;
          const r = rng.float() * 5.2;
          const px = cx + Math.cos(a) * r, pz = cz + Math.sin(a) * r * 0.8;
          // only where there is still water under it
          const ii = Math.round((px - x0) / cell), jj = Math.round((pz - z0) / cell);
          if (ii < 0 || jj < 0 || ii >= VN || jj >= VN) continue;
          const dd = depth[jj * VN + ii];
          if (dd < 0.6 || dd > 2.0) continue;
          const R = 0.55 + rng.float() * 0.45;
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
    const proto = [], protoSy = [];
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
      protoSy.push(sy);
    }
    return { rng, proto, protoSy, pos: [], nor: [], col: [], n: 0, nShoal: 0 };
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
    const { rng, proto, protoSy, pos, nor, col } = acc;
    const P = this.palette;
    const base = new THREE.Color(P.rock ?? 0x8f9099);
    const dark = new THREE.Color(P.rockShadow ?? 0x5f6069);
    const stamps = [];

    const place = (x, z, r, y, lit, collar) => {
      const pi = rng.int(0, 4);
      const g = proto[pi];
      const yaw = rng.float() * Math.PI * 2;
      const ys = r * (0.85 + rng.float() * 0.5);
      // BURY A THIRD OF IT, ALWAYS.
      //
      // The caller passes the height the stone should SIT at and had no way to
      // know how tall the stone it was going to get is: the prototypes are
      // squashed by 0.62-1.0 and then scaled again here, so a boulder's own
      // half-height ranges from 0.55r to 1.35r. Seat it by a fixed fraction of
      // r and the flat end of that range comes out with its underside ABOVE the
      // bed — measured on lake_bridge, two stones in open water showing their
      // dark bottom facets, hanging over their own reflection. Sinking by a
      // third of the ACTUAL half-height makes that impossible whatever
      // prototype the draw returns, and a partly buried boulder is what a
      // boulder looks like anyway.
      const half = ys * protoSy[pi];
      const m = new THREE.Matrix4()
        .makeRotationY(yaw)
        .premultiply(new THREE.Matrix4().makeScale(r, ys, r))
        .setPosition(x, y - half * 0.34, z);
      const nm = new THREE.Matrix3().setFromMatrix4(m).invert().transpose();
      const p = g.attributes.position.array;
      const nn = g.attributes.normal.array;
      // Less spread toward the shadow swatch. At 0.55 a good third of the
      // shore population came out near-charcoal, and a dark stone lying on lit
      // meadow at this camera angle reads as a hole in the ground rather than
      // as granite. The reference's boulders are all within a stop of each
      // other and all of them are LIGHT.
      const c = base.clone().lerp(dark, rng.float() * 0.38).multiplyScalar(lit);
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
        // ...AND ONTO THE BEACH. The reference's waterline is not a line at
        // all, it is a band of stone: boulders sitting half in and half out of
        // the water with the meadow running up behind them. Stopping the
        // population at the waterline left the shore a bare strand of gravel
        // with nothing on it, which is the one thing the reference never does.
        if (d < -1.3 || d > 3.6) continue;
        // AND KEEP IT AT THE SHORE. These rates were tuned when the bed fell
        // away over twenty metres; the bank is now a seventy-metre shelf, so
        // the same probability per cell covered an acre of shallows and the
        // lake came back looking like a scree slope with water in it
        // (shots/ladder_hero/hero_alpine_t12.png). Rocks belong where the water
        // meets something, not spread evenly over the shelf.
        const sh = shore[j * VN + i];
        // A SHOAL IS A SHORE THAT HAPPENS TO BE IN THE MIDDLE.
        //
        // Gating the whole population on distance-to-the-bank was right while
        // the bed was a smooth bowl, because then everything shallow WAS near
        // the bank by construction. The bed now carries shoals that rise to
        // within a metre or two of the surface a long way out, and those are
        // precisely the places the reference shows stone through the water —
        // and the client's "most polygons have no detail at all" is loudest
        // over the empty middle of a lake. Anything under two and a half metres
        // qualifies, wherever it is.
        const onShoal = sh > 26 && d > 0.15 && d < 2.8;
        if (sh > 26 && !onShoal) continue;
        // A shoal crest is a small target and it is the whole point of the
        // exercise, so it gets a denser draw than a metre of open bank.
        const near = sh <= 26 ? 1 - sh / 26 : 0.85;
        // A stone whose top is under the surface is only legible where the
        // water is glassy, which is against the bank. Out in the open it is a
        // grey plate lying ON the lake with a ring of foam round it — the same
        // read the lily pads had, and a lone one of them sat in the middle of
        // lake_bridge's water.
        if (sh > 17 && d > 1.6 && !onShoal) continue;
        // Emergent rocks only in genuinely shallow water. Deeper than that the
        // surface is 97% opaque, so all you see is the cap and the boulder
        // reads as a stone floating in mid-lake rather than standing in it.
        const emergent = d < 2.2;
        // MEASURED SPARSE. At 0.018 / 0.007 the whole world came back with two
        // hundred and fifty five boulders shared between twenty-five basins —
        // ten per lake, on three hundred metres of shore, which is one every
        // thirty metres and which is why the captures showed open water meeting
        // grass with nothing in between. The reference's shoreline has a stone
        // in it every ten or twenty metres and half of them are under the
        // surface. These rates were set when the bank was a wall and the band
        // they had to fill was two metres wide; the shelf is fifteen now.
        if (rng.float() > (emergent ? 0.055 : 0.032) * (0.28 + near * near)) continue;
        const x = x0 + i * cell + (rng.float() - 0.5) * cell;
        const z = z0 + j * cell + (rng.float() - 0.5) * cell;
        // Not under the bridge deck, and not on the knife of ground the road
        // crosses a neck on: a boulder there is a boulder inside the timber.
        if (F.keepOut && F.keepOut(x, z)) continue;
        // BIGGER. The shore stones in the reference are four to eight metres
        // across; at 2-4 m ours were pebbles at this camera height, and an
        // emergent one rising only half its radius above a bed that had already
        // been pushed down by the seating rule broke the surface by twenty
        // centimetres — a grey speck, not a boulder.
        const r = emergent ? 1.5 + rng.float() * 2.6 : 1.1 + rng.float() * 1.6;
        // Centre height above the bed. Emergent rocks break the surface;
        // submerged ones stay a comfortable margin under it.
        // A CLEAR METRE UNDER, or it is a plate and not a stone. At 0.9 the top
        // of a submerged boulder sat within twenty centimetres of the surface,
        // and through water that is 68% opaque all you saw was its cap: a flat
        // brown hexagon lying ON the lake, indistinguishable from the lily pads
        // it was supposed to be nothing like. Under a metre and a third of
        // water the same stone reads as a shape THROUGH the surface, which is
        // the thing the reference does and the reason for the transparency.
        const rise = emergent ? r * 0.88 : Math.min(r * 0.5, Math.max(0.15, d - 1.35));
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
        // A TIGHTER NEIGHBOURHOOD, because the bank is no longer a wall.
        // Taking the minimum over five metres was right on a 1:1.6 face, where
        // the mesh really does cut three metres off the shoulder. On the 1:11
        // shelf the same rule simply sinks every boulder by half a metre for
        // nothing — which, with a rise of half a radius, was most of the reason
        // the emergent population never emerged.
        let bed = level - d;
        for (const [ox, oz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2.2, 2.2], [-2.2, -2.2]]) {
          const h = T.heightAt(x + ox, z + oz);
          if (h < bed) bed = h;
        }
        // Only something that reaches the surface gets a foam collar.
        const collar = (rise + r * 0.5) - d > -0.7;
        acc.n++; if (onShoal) acc.nShoal++;
        place(x, z, r, bed + rise, emergent ? 1.0 : 0.9, collar);
        // STONES COME IN GROUPS.
        //
        // One boulder per draw put singletons all along the shore, and a lone
        // rock standing in open water with a ring of foam round it reads as an
        // object that has been placed rather than as geology. Every shore in
        // the reference has them in threes and fours — one big, two small, one
        // half drowned — so each draw plants a little family instead.
        const mates = rng.int(0, 3);
        for (let m = 0; m < mates; m++) {
          const ang = rng.float() * Math.PI * 2;
          const rad = r * (1.1 + rng.float() * 1.9);
          const mx2 = x + Math.cos(ang) * rad, mz2 = z + Math.sin(ang) * rad;
          if (F.keepOut && F.keepOut(mx2, mz2)) continue;
          const md = level - T.heightAt(mx2, mz2);
          if (md < -1.6 || md > 3.8) continue;
          const mr = r * (0.32 + rng.float() * 0.5);
          const mEm = md < 2.0;
          const mRise = mEm ? mr * 0.88 : Math.min(mr * 0.5, Math.max(0.15, md - 1.35));
          let mbed = level - md;
          for (const [ox, oz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
            const hh = T.heightAt(mx2 + ox, mz2 + oz);
            if (hh < mbed) mbed = hh;
          }
          place(mx2, mz2, mr, mbed + mRise, mEm ? 1.0 : 0.9,
            (mRise + mr * 0.5) - md > -0.7);
        }
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
