// ART DIRECTION CONTRACT
// ----------------------
// Every colour in the game comes from here. Biomes read a palette; nothing
// hard-codes a hex outside this file. Critics judge art direction by tuning
// these numbers, so keep them semantic and readable.
//
// Colours are authored in linear-ish sRGB hex and converted by three's
// Color with colorManagement enabled.
//
// VALUE STRUCTURE is the rule that outranks hue. In the reference frame the
// long directional shadows are the dominant graphic element, which only works
// if the lit ground sits in a narrow mid-to-light band and nothing else in the
// frame competes with it. So, for every palette:
//
//   * the ground ramp spans roughly 45-80% lightness — never near-black, never
//     blown out. Chroma carries the identity, not brightness.
//   * `cliff` and `patchB` are the darks. They are the only ground values
//     allowed below 40% lightness, and they appear only on steeps and in
//     macro patches, so shadows still win.
//   * the car (0xef4d4d) and the `accents` must stay the most saturated things
//     in frame. Ground saturation is capped accordingly.
//
// SUN vs AMBIENT is a ratio, not two independent knobs. Flat ground receives
// sun * sin(elevation), so at the 10-14 deg elevations that give art of rally
// its enormous shadows the sun only delivers ~0.2 of its intensity to the
// ground. v0 paired a 3.4 sun with a 1.6 hemisphere at 12 deg, so ambient
// out-lit the sun 2:1, shadows stopped reading and every low-sun biome came out
// as mud. Rule of thumb used below: sunIntensity * sin(sunElevation) should be
// 1.3-1.7x ambientIntensity, which puts lit ground ~2.4x its own shadow.

/**
 * @typedef {Object} TerrainSwatches
 * @property {number[]} ramp      altitude ramp, low -> high. Biome STOPS map it.
 * @property {number} lowland     wet/shaded valley bottoms
 * @property {number} patchA      macro patch: the LIGHTER, drier zone
 * @property {number} patchB      macro patch: the DARKER, scrubbier zone
 * @property {number} scree       loose material on moderate slopes
 * @property {number} cliff       bare rock on steeps — the darkest ground value
 * @property {number} soil        exposed earth
 * @property {number} sand        beach / bleached flats
 * @property {number} summit      snow or bleached cap
 * @property {number} facetContrast  0..1, how hard sun-facing facets brighten
 * @property {number} grain       0..1, per-facet value noise (cut-paper tooth)
 * @property {number} bands       0 = off, else quantise lightness into N steps
 */

/**
 * @typedef {Object} Palette
 * @property {string} name
 * @property {number} skyTop        zenith colour
 * @property {number} skyHorizon    horizon colour
 * @property {number} sunColor
 * @property {number} sunIntensity
 * @property {number} ambientSky    hemisphere light: sky side
 * @property {number} ambientGround hemisphere light: ground bounce
 * @property {number} ambientIntensity
 * @property {number} fogColor
 * @property {number} fogDensity
 * @property {number[]} ground      legacy ground ramp (mirrors terrain.ramp)
 * @property {TerrainSwatches} terrain
 * @property {number[]} foliage     canopy colour variants
 * @property {number} trunk
 * @property {number} rock
 * @property {number} rockShadow
 * @property {number} water
 * @property {number} waterDeep
 * @property {number} waterFoam
 * @property {number} road
 * @property {number} roadEdge
 * @property {number[]} accents     signage / flowers / manmade pops
 * @property {number} sunAzimuth    radians
 * @property {number} sunElevation  radians
 * @property {number} exposure
 */

// Legacy `ground` is kept in sync with `terrain.ramp` — some systems (dust
// colour, prop tinting) still read it.
//
// ALPINE, measured off ref/target_01_alpine_meadow.png at 20 levels/channel.
//
// The v3 note below this one said "reference grass runs B = 0-12, keep blue on
// the floor". That was measured on SUNLIT grass only and then applied to the
// whole ramp, and it is what turned the frame olive. Re-measured across the
// whole reference the picture is completely different:
//
//   dominant greens  #0d261a #1a331a #26401a #334d1a #59660d #66730d #73800d
//                    #808c0d #808c00
//   i.e. B = 26,26,26,26,13,13,13,13,0 as the green gets lighter.
//
// So blue is NOT a floor, it is a RAMP THAT RUNS THE OTHER WAY to value. The
// reference's shaded greens are deep blue-greens at hue 120-150 carrying B ~ R
// and only ~50-60% saturation; its sunlit greens are hue 62-70 yellow-greens at
// 85-100% saturation with almost no blue. Ours had B = 0 at BOTH ends — every
// dominant bin ended in 00 — which is the literal definition of olive, and it
// also pinned our mean saturation at 0.88 against the reference's 0.77, because
// a zero channel forces S = 1 no matter what the other two do.
//
// Hence, low -> high:
//   * 0-1  deep cool heath green, hue 145 -> 105, S 0.55-0.60. These are the
//          hollows, the shore draws and the shaded side of every swell.
//   * 2-4  the meadow proper, swinging 80 -> 64 in hue and 0.72 -> 0.80 in
//          saturation as it climbs. Index 3 is the reference's sunlit sward.
//   * 5    rim hill: same hue, chroma pulled back so distance sits behind.
// The luminance span is deliberately much wider than v3's (0.15 -> 0.58 against
// 0.20 -> 0.53): the reference's green pixels spread from L 0.12 at the 5th
// percentile to 0.55 at the 95th, ours only 0.17 -> 0.45, and a compressed ramp
// is half of why.
// ROUND 7 — THE ACID FIX, and it is a GREEN-CHANNEL fix, not a yellow one.
//
// Measured with tools/crop.mjs (green pixels split into five luma tiers, mean
// R/G per tier, hero_alpine 1600x900 against the reference at the same scale):
//
//     luma tier      ours R/G   reference R/G
//     0.14-0.28        0.50         0.63
//     0.28-0.42        0.72         0.83     <- 49% of our green pixels
//     0.42-0.56        0.81         0.90     <- 23%
//
// Every tier of our meadow sits 0.09-0.13 of R/G BELOW the reference, i.e. our
// grass is about ten degrees of hue further round toward pure green, at every
// value. That is the acid: at G = 140 the reference puts R at 126 and we put it
// at 113, and 113/140/9 is chartreuse where 126/141/12 is olive.
//
// It is not the grade — grade.js already runs gain [1.050, 0.995, 1.105], i.e.
// it is ALREADY adding 5% red. It is not the facet push either: that is a
// multiplicative gain on LINEAR HSL lightness, and below l = 0.5 that scales all
// three channels together, so it cannot rotate a hue. It is the albedo.
//
// So the ramp rotates warm — but NOT UNIFORMLY, and the first pass at it that
// did rotate uniformly printed mustard. The rotation belongs at the BOTTOM and
// the MIDDLE of the ramp only. Measured per dominant bin on a sunlit meadow
// crop, the reference's brightest grass is #828f00 / #758f00 / #8f9c00 —
// R/G 0.80-0.92, green still ahead of red — and a uniform +0.08 of R/G put ours
// at #9c8f0d / #a99c0d, R/G 1.08, which is RED ahead of green: mustard, not
// grass. Meanwhile the r06 acid bins (#5d8b00, #748b00) were index 2 of this
// ramp under full sun, not index 4, which is why index 2 is where the big warm
// step goes and index 4 barely moves at all.
//
//   index    0     1     2     3     4     5
//   was    0.45  0.59  0.79  0.88  0.95  0.93   R/G
//   now    0.58  0.73  0.89  0.91  0.89  0.89
//
// Lowering G rather than only raising R is deliberate — it also takes luma and
// saturation off, and we were over on both.
//
// The BOTTOM of the ramp also loses a third of its blue. Our single biggest
// dominant bin was #17462e — rgb(23,70,46), B/G 0.66 — where the reference's
// single biggest bin is #172e17, rgb(23,46,23), B/G 0.50 with red and blue
// EQUAL. Deep shade in the reference is a dark green; ours was drifting teal,
// and a teal floor under a yellow-green meadow is half of why the meadow read
// as acid: the eye judges the grass against what sits next to it.
//
// BLUE IS A CONSTANT, NOT A FRACTION. This is the other half of the acid, and
// it only shows up if you read the reference's dominant bins as a ladder:
//
//   #172e17  #2e4617  #465d17  #8b8b17      B = 23, 23, 23, 23
//   G  =  46      70       93      139
//
// Blue does not move at all while green triples. That is the signature of a
// constant sky fill sitting on top of a green that gets brighter — and it means
// the reference's B/G FALLS from 0.50 in shade to 0.17 in sun. Ours rose with
// green (B = 26,35,34,35,48,71, ending at B/G 0.46 on the brightest swatch),
// which is why our sunlit grass was simultaneously too pale AND too weak in
// chroma while the shade went teal. Blue is now flat at 26-46 across the ramp.
const ALPINE_RAMP = [0x1c2c12, 0x384615, 0x71731b, 0x989a27, 0xb6ba2d, 0xa2a730];
const AUTUMN_RAMP = [0x3b4c28, 0x5a682e, 0x83803a, 0xac974a, 0xccb466, 0xe6d59a];
const DESERT_RAMP = [0xe8d5a4, 0xdcb476, 0xcf8546, 0xbc5730, 0xa33c27, 0xc9713c];
const COAST_RAMP = [0x104a46, 0x0f6f4c, 0x1e924c, 0x54a548, 0x9c9a56, 0xcfc084];
const WINTER_RAMP = [0x6c9ac6, 0x9bc3e2, 0xc8dff3, 0xe9f3fc, 0xffffff, 0xffffff];

/** @type {Record<string, Palette>} */
export const PALETTES = {
  // 1. Alpine meadow — lush green, blue lakes, snowy peaks. The "postcard".
  alpine: {
    name: 'Alpine Meadows',
    skyTop: 0x2664cf,
    skyHorizon: 0xa9d8f5,
    sunColor: 0xfff2d6,
    sunIntensity: 3.7,
    // DO NOT retune ambient to fix the black holes under the firs. Tried and
    // measured this round: ground under a fir cluster comes back as rgb(3,14,57)
    // at four separate sample points — a NAVY pit with four times more blue in
    // it than green, where the reference's tree shadows are plainly GREEN
    // (#0d261a, #1a331a) at L 0.15-0.20. Raising ambientIntensity 1.10 -> 1.34
    // moved the frame by 0.001 luma and left those pixels bit-identical,
    // because renderer.js derives its shadow floor from the sun/ambient SHARE
    // and then normalises the rig, so a bigger ambient just buys a slightly
    // shallower step, not a lighter shadow. The colour comes from post.js's AO
    // tint (which eats red) stacked with grade.js's `lift: [0, 0.030, 0.195]`
    // (which adds blue and no red, ramped as (1-col)^4 so it only bites on
    // pixels that are already near black). Both live outside this file.
    ambientSky: 0xb8d0de,
    ambientGround: 0x90a052,
    ambientIntensity: 1.1,
    fogColor: 0xbfe0f2,
    fogDensity: 0.00085,
    ground: ALPINE_RAMP,
    terrain: {
      ramp: ALPINE_RAMP,
      // patchA and patchB are no longer a mild tint on top of the ramp — they
      // ARE the tonal spread. colorAt lerps between them on a 260 m / 90 m / 25 m
      // noise stack, so the meadow has to be able to reach L 0.60 on a sunlit
      // rise and L 0.19 in a hollow without either end being a different
      // material. Keep them one hue family apart, not one value apart.
      lowland: 0x152718,     // damp draws and tarn shores — bluest green here
      patchA: 0xa2bb4e,      // sun-bleached alp grass. R stays a hair UNDER G:
                             // the reference's sunlit bins run R/G 0.80-0.92 and
                             // the moment red leads, grass reads as mustard.
      patchB: 0x1c2516,      // shaded heath / bilberry: hue 125, S 0.53, L 0.13
      scree: 0xa9a596,       // pale limestone — cliff faces ONLY, never meadow
      cliff: 0x6a6055,       // warm grey rock (ref boulders read #605753)
      soil: 0x8a6236,
      sand: 0xd7c48a,
      summit: 0xf2f7ff,      // unreachable: alpine tops out ~170 m now
      facetContrast: 0.60,   // both are linear GAINS now, not lightness offsets
      grain: 0.34,
      bands: 0,
    },
    // FIRS. props.js builds each conifer's tier ramp by offsetting these in
    // LINEAR HSL, and because a green this dark sits near l = 0.02 there, its
    // `dir` heuristic pushes the upper tiers BRIGHTER — up to +0.125 linear,
    // which on a 0x3d9440 base landed the crowns on mint. The reference has no
    // mint in it: its firs are the darkest thing in the frame (#0d261a,
    // #1a331a) and read as deep blue-greens at hue 130-155. So the base set is
    // darker AND bluer, which leaves room for the tier brightening to become
    // the lit/shade separation it was meant to be instead of a blow-out.
    // Hue matters as much as value: at hue 150+ a dark green reads TEAL, and
    // the first pass at this put a spruce-blue wood in the frame. The
    // reference's firs measure hue 100-135 (#26401a lit through #1a331a to
    // #0d261a in the shade), so these sit at 127-133 — unmistakably green,
    // just deep and slightly cool.
    // ...and DARKENING THE BASE IS NOT THE LEVER for the bright tips. Measured:
    // taking this set down 18% moved the fir crowns by nothing and pushed luma
    // bucket 0 from 2.9% to 3.7% against the reference's 0.9%. The reason is
    // that props.js adds its tier offsets to LINEAR lightness — `leafPale` is
    // base + 0.10 + 0.105 — so on a green sitting at linear l ~ 0.02 the base
    // contributes almost nothing to the top tier and everything to the bottom
    // one. What the base DOES still control at the top is hue and chroma, so
    // the fix for a mint crown is to take the chroma out: S ~ 0.49 across the
    // set, matching the reference's own firs (#1a331a is S 0.49, #0d261a is
    // 0.66), with the darkest variant lifted back to L 0.20 so its underside
    // stops falling into the black hole the AO and the grade lift make of it.
    foliage: [0x25432c, 0x2e5335, 0x1e3625, 0x355f39],
    trunk: 0x6b4a30,
    rock: 0x7d7268,
    rockShadow: 0x4e463f,
    water: 0x1179bd,
    waterDeep: 0x0a4f8c,
    waterFoam: 0xeaf7ff,
    // ROAD, pulled down a stop. MEASURED: our road surface renders at
    // rgb(209,162,70), luma 0.65, and it is ~10% of the frame, which is why our
    // luma bucket 6 (0.6-0.7) held 9.9% of the picture against the reference's
    // 5.0% while bucket 5 held 10.2% against its 17.5%. Sampled at two points
    // the reference road is rgb(203,160,73) and rgb(184,141,74) — the same
    // R/G ratio of 1.27-1.30 as ours, just a stop lower and far more varied.
    // So the hue was already right; only the level was wrong.
    road: 0xb38a46,
    roadEdge: 0xc9a76b,
    accents: [0xef4d4d, 0xffd23f, 0xff8fbf, 0xffffff],
    sunAzimuth: 2.35,
    // 34 deg. ART_DIRECTION calls for shadows ~1-1.5x object height; 0.50 rad
    // gave 1.8x, and with alpine's terrain now self-shadowing that turned every
    // meadow crest into a half-frame wedge.
    sunElevation: 0.60,
    exposure: 0.97,
  },

  // 2. Autumn woodland — warm reds/oranges, low golden sun, long shadows.
  autumn: {
    name: 'Ember Woodland',
    skyTop: 0x3a5fb8,
    skyHorizon: 0xffc98a,
    sunColor: 0xffb35c,
    sunIntensity: 5.4,
    ambientSky: 0xd0b0dc,
    ambientGround: 0xb08048,
    ambientIntensity: 1.02,
    fogColor: 0xf2c79b,
    fogDensity: 0.0013,
    ground: AUTUMN_RAMP,
    terrain: {
      ramp: AUTUMN_RAMP,
      lowland: 0x2f4426,     // damp green in the dells
      patchA: 0xd8b95e,      // amber bracken
      patchB: 0x415c2e,      // deep pasture green — the cool foil
      scree: 0xb2a077,
      cliff: 0x6b5b43,
      soil: 0x7d5c30,
      sand: 0xe0c894,
      summit: 0xe6d59a,
      facetContrast: 0.52,
      grain: 0.02,
      bands: 0,
    },
    foliage: [0xd6642a, 0xe88b2a, 0xb83d22, 0xf0a83a, 0x8a5a2a],
    trunk: 0x4a3220,
    rock: 0x8a7f70,
    rockShadow: 0x584f45,
    water: 0x3c8fa8,
    waterDeep: 0x1c5266,
    waterFoam: 0xfff0dc,
    road: 0x7a6b58,
    roadEdge: 0xd8c8a8,
    accents: [0xff4d2d, 0xffe066, 0x2f7d43, 0xffffff],
    sunAzimuth: 1.05,
    sunElevation: 0.23,
    exposure: 1.14,
  },

  // 3. Desert mesa — ochre, teal sky, hard shadows, huge negative space.
  desert: {
    name: 'Vermilion Mesa',
    skyTop: 0x1878c0,
    skyHorizon: 0xffd9a8,
    sunColor: 0xffe8bf,
    sunIntensity: 4.0,
    ambientSky: 0x8fc4e8,
    ambientGround: 0xd09666,
    ambientIntensity: 1.12,
    fogColor: 0xf5d5ac,
    fogDensity: 0.0007,
    ground: DESERT_RAMP,
    terrain: {
      ramp: DESERT_RAMP,
      lowland: 0xb0743f,
      patchA: 0xefdcae,      // bleached wind-swept sand
      patchB: 0x9a5233,      // dark desert varnish
      scree: 0xc98a5c,       // talus skirt at the foot of every riser
      cliff: 0xa5372a,       // vermilion cliff face
      soil: 0x7c2c1d,
      sand: 0xf0dfb4,
      summit: 0xd88b58,
      facetContrast: 0.5,
      grain: 0.016,
      bands: 0,
    },
    foliage: [0x5f8a4a, 0x4a7a3c, 0x6f9a55],
    trunk: 0x7a5a3a,
    rock: 0xb85f38,
    rockShadow: 0x7a3520,
    water: 0x2fb0c4,
    waterDeep: 0x136a80,
    waterFoam: 0xf2fdff,
    road: 0xa8845f,
    roadEdge: 0xe8d3ad,
    accents: [0x2fd0e8, 0xff5c3c, 0xffd23f, 0xffffff],
    sunAzimuth: 3.6,
    sunElevation: 0.58,
    exposure: 0.95,
  },

  // 4. Coastal golden hour — indigo sea, lit headlands, very long shadows.
  //    v0 sat at sunElevation 0.09 with heavy purple fog and read as mud. The
  //    sun is lifted just enough to actually light the terrace tops while the
  //    shadows stay enormous.
  coast: {
    name: 'Cobalt Coast',
    skyTop: 0x1d2467,
    skyHorizon: 0xff8a5c,
    sunColor: 0xffcc9c,
    sunIntensity: 6.4,
    ambientSky: 0x7d88d4,
    ambientGround: 0x625a86,
    ambientIntensity: 0.98,
    fogColor: 0xa87a9a,
    fogDensity: 0.0011,
    ground: COAST_RAMP,
    terrain: {
      ramp: COAST_RAMP,
      lowland: 0x1e4440,
      patchA: 0xc9a862,      // sunlit marram grass
      patchB: 0x1d3f37,      // dark gorse — the deep note
      scree: 0xa08f8c,
      cliff: 0x5e5566,       // violet-grey cliff, reads cool against the sun
      soil: 0x4a3a3a,
      sand: 0xe9d0a2,
      summit: 0xf0dcb4,
      facetContrast: 0.6,
      grain: 0.02,
      bands: 0,
    },
    foliage: [0x1f4a3a, 0x2a5a44, 0x163a2e],
    trunk: 0x2a1f1a,
    rock: 0x5a5a6a,
    rockShadow: 0x33333f,
    water: 0x2a5fa8,
    waterDeep: 0x0f2a5a,
    waterFoam: 0xd6e8ff,
    road: 0x4a4a52,
    roadEdge: 0x9a9aa8,
    accents: [0xff4d8f, 0x2fd0e8, 0xffd23f, 0xffffff],
    sunAzimuth: 5.2,
    sunElevation: 0.175,
    exposure: 1.16,
  },

  // 5. Winter pass — the direct nod to the reference frame, but with colour.
  //    v0's ramp was five shades of white, so nothing read. Snow here runs from
  //    a saturated shadow-blue to pure white, and bare rock supplies the dark.
  winter: {
    name: 'Glacier Pass',
    skyTop: 0x3d6fb8,
    skyHorizon: 0xd2e6f7,
    sunColor: 0xfff6e8,
    sunIntensity: 3.9,
    ambientSky: 0xc4dcf5,
    ambientGround: 0xa8bfd4,
    ambientIntensity: 1.12,
    fogColor: 0xcfe2f2,
    fogDensity: 0.00075,
    ground: WINTER_RAMP,
    terrain: {
      ramp: WINTER_RAMP,
      lowland: 0x5f90bf,
      patchA: 0xf6fbff,      // fresh drift
      patchB: 0x87b0d4,      // wind-scoured blue ice
      scree: 0x7f8b9c,       // moraine gravel
      cliff: 0x4c5666,       // wet dark rock — the only true dark
      soil: 0x60697a,
      sand: 0xcfd9e4,
      summit: 0xffffff,
      facetContrast: 0.5,
      grain: 0.016,
      bands: 0,
    },
    foliage: [0x1f4a3f, 0x27584a, 0x1a3f36],
    trunk: 0x3a2f28,
    rock: 0x8a94a3,
    rockShadow: 0x5a636f,
    water: 0x4fc0d8,
    waterDeep: 0x1a6f8f,
    waterFoam: 0xffffff,
    road: 0xb8bfc9,
    roadEdge: 0xe8eef5,
    accents: [0xef4d4d, 0x2fd0e8, 0xffd23f, 0xff8fbf],
    sunAzimuth: 0.6,
    sunElevation: 0.32,
    exposure: 1.0,
  },
};

export const PALETTE_IDS = Object.keys(PALETTES);

export function getPalette(id) {
  return PALETTES[id] ?? PALETTES.alpine;
}
