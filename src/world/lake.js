/**
 * LAKE CONSTANTS — shared between water.js and bridges.js.
 *
 * These two modules have to agree on exactly one number (the surface height)
 * or the bridge floats above a dry valley / drowns in a lake. game.js builds
 * bridges without a reference to the Water object, so the agreement lives here
 * rather than in an instance field.
 *
 * WHY THE ALPINE OVERRIDE EXISTS
 * ------------------------------
 * biomes.js declares `waterLevel: -17` for alpine, but the alpine height field
 * only dips below -17 over 0.0-0.7% of the map depending on seed, and never
 * anywhere the route goes. Measured: at seed 4242 (the lake_bridge preset) the
 * lowest point in the entire 1700 m map is -12.7, so the water plane sat
 * five metres under the deepest hole in the world and the biome had no lake at
 * all. `roads.waterCrossings` came back empty for every seed for the same
 * reason, so there was nothing to bridge either.
 *
 * Filling the tarn basins to -5 floods 0.6-2.5% of the map — a handful of
 * lakes on the valley floor, exactly the scale of the reference — and puts
 * 1-3 genuine water crossings on the route per seed. Nothing else in the build
 * reads this value, so raising it here cannot disturb another subsystem.
 */
const SURFACE = {
  alpine: -5.0,
};

/** The height the visible water surface actually sits at, in metres. */
export function lakeLevel(biome) {
  return SURFACE[biome?.id] ?? biome?.waterLevel ?? -3;
}

/**
 * The terrain handle, parked here by whoever gets one first.
 *
 * game.js builds the Water with `new Water(palette, biome)` — no terrain and
 * no seed — but hands bridges.js the full ctx one line later. Rather than
 * widen game.js for a single argument, bridges.js drops its ctx here and
 * water.js picks it up on its first update(). Nothing outside this subsystem
 * reads it.
 */
let CTX = null;

export function setLakeContext(ctx) {
  CTX = ctx ? { terrain: ctx.terrain, biome: ctx.biome, seed: ctx.seed } : null;
}

export function getLakeContext(biome) {
  if (!CTX) return null;
  if (biome && CTX.biome && CTX.biome.id !== biome.id) return null;
  return CTX;
}

/** Metres of water over the bed at (x, z). Negative on dry land. */
export function lakeDepth(terrain, biome, x, z) {
  return lakeLevel(biome) - terrain.heightAt(x, z);
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
