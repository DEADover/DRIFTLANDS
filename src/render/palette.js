// ART DIRECTION CONTRACT
// ----------------------
// Every colour in the game comes from here. Biomes read a palette; nothing
// hard-codes a hex outside this file. Critics judge art direction by tuning
// these numbers, so keep them semantic and readable.
//
// Colours are authored in linear-ish sRGB hex and converted by three's
// Color with colorManagement enabled.

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
 * @property {number[]} ground      ground tint ramp, low -> high altitude
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

/** @type {Record<string, Palette>} */
export const PALETTES = {
  // 1. Alpine meadow — lush green, blue lakes, snowy peaks. The "postcard".
  alpine: {
    name: 'Alpine Meadows',
    skyTop: 0x2e6fd6,
    skyHorizon: 0xa9d8f5,
    sunColor: 0xfff2d6,
    sunIntensity: 3.1,
    ambientSky: 0x9ccbf0,
    ambientGround: 0x5f7a3c,
    ambientIntensity: 1.15,
    fogColor: 0xbfe0f2,
    fogDensity: 0.0016,
    ground: [0x6ba03f, 0x88b84a, 0xa8cc63, 0xd8dcc0, 0xf2f6fb],
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
    sunElevation: 0.72,
    exposure: 1.05,
  },

  // 2. Autumn woodland — warm reds/oranges, low golden sun, long shadows.
  autumn: {
    name: 'Ember Woodland',
    skyTop: 0x3f63b8,
    skyHorizon: 0xffc98a,
    sunColor: 0xffb35c,
    sunIntensity: 3.4,
    ambientSky: 0xc9a9d8,
    ambientGround: 0x7a4a25,
    ambientIntensity: 1.0,
    fogColor: 0xf2c79b,
    fogDensity: 0.0022,
    ground: [0x8a6a34, 0xa8823c, 0xc09a4e, 0xd8b46a, 0xefe0c0],
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
    sunElevation: 0.28,
    exposure: 1.12,
  },

  // 3. Desert mesa — ochre, teal sky, hard shadows, huge negative space.
  desert: {
    name: 'Vermilion Mesa',
    skyTop: 0x1f7fc4,
    skyHorizon: 0xffd9a8,
    sunColor: 0xffe8bf,
    sunIntensity: 3.8,
    ambientSky: 0x8fc4e8,
    ambientGround: 0xb87a4a,
    ambientIntensity: 1.05,
    fogColor: 0xf5d5ac,
    fogDensity: 0.0011,
    ground: [0xc4753c, 0xd98b4a, 0xe8a25c, 0xf0bd7f, 0xf7dcae],
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
    sunElevation: 0.95,
    exposure: 1.0,
  },

  // 4. Coastal dusk — magenta/indigo sky, silhouettes, headlights read.
  coast: {
    name: 'Cobalt Coast',
    skyTop: 0x1a1b4d,
    skyHorizon: 0xff7a5c,
    sunColor: 0xff9a6a,
    sunIntensity: 2.4,
    ambientSky: 0x5a5fb0,
    ambientGround: 0x3a3a5a,
    ambientIntensity: 1.25,
    fogColor: 0x8a6a9a,
    fogDensity: 0.0028,
    ground: [0x3a5a4a, 0x4a6a52, 0x5f7a5c, 0x8a8a70, 0xbfae90],
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
    sunElevation: 0.09,
    exposure: 1.22,
  },

  // 5. Winter pass — the direct nod to the reference frame, but with colour.
  winter: {
    name: 'Glacier Pass',
    skyTop: 0x5f86c4,
    skyHorizon: 0xdce9f5,
    sunColor: 0xfff6e8,
    sunIntensity: 2.6,
    ambientSky: 0xcfe2f5,
    ambientGround: 0x9ab0c4,
    ambientIntensity: 1.5,
    fogColor: 0xdae8f2,
    fogDensity: 0.0034,
    ground: [0xe8eef5, 0xf2f6fb, 0xfbfdff, 0xffffff, 0xffffff],
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
    sunElevation: 0.36,
    exposure: 1.0,
  },
};

export const PALETTE_IDS = Object.keys(PALETTES);

export function getPalette(id) {
  return PALETTES[id] ?? PALETTES.alpine;
}
