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
// Alpine stays GREEN across the whole drivable band. In target_01 the only
// greys in frame are boulders and cliff faces — those come from outcrops() and
// steepness() in biomes.js, never from the altitude ramp. Putting rock grey at
// index 4 turned every 50 m hillside into scree and washed the meadow out.
const ALPINE_RAMP = [0x2f5936, 0x437c37, 0x5d9c40, 0x77b348, 0x93c257, 0xe8f2fb];
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
    ambientSky: 0xa8d4f2,
    ambientGround: 0x86a05c,
    ambientIntensity: 1.1,
    fogColor: 0xbfe0f2,
    fogDensity: 0.00085,
    ground: ALPINE_RAMP,
    terrain: {
      ramp: ALPINE_RAMP,
      lowland: 0x2f6440,     // damp hollows by the tarns
      patchA: 0xc9be6a,      // sun-baked alp grass, gold-green
      patchB: 0x21503a,      // dark heath / bilberry scrub — the deep note
      scree: 0xc3bcae,       // pale limestone scree fans
      cliff: 0x6f6f7d,       // cool grey rock — the dark note
      soil: 0x7d5a38,
      sand: 0xd8cfae,
      summit: 0xf7fbff,
      facetContrast: 0.58,
      grain: 0.018,
      bands: 0,
    },
    foliage: [0x2f7d43, 0x3d9451, 0x256b3a, 0x4aa85c],
    trunk: 0x6b4a30,
    rock: 0x8f9099,
    rockShadow: 0x5f6069,
    water: 0x2fa4d6,
    waterDeep: 0x14608f,
    waterFoam: 0xeaf7ff,
    road: 0x8a7f6e,
    roadEdge: 0xd9d2c2,
    accents: [0xef4d4d, 0xffd23f, 0xff8fbf, 0xffffff],
    sunAzimuth: 2.35,
    sunElevation: 0.5,
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
