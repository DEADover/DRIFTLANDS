import { fbm } from '../core/rng.js';
import {
  clamp, mix, smoothstep, warped, domes, dendritic,
  corridor, terrace, spines, bumps,
} from './landforms.js';

/**
 * BIOMES — five places, five landform grammars.
 *
 * A biome is NOT a recolour. Each one is built from a different sentence:
 *
 *   alpine  a meandering glacial CORRIDOR: meadow floor, shoulders that bank
 *           up on both sides, ridge spines beyond them.
 *   autumn  a DOME FIELD: overlapping rounded hills incised by a dendritic
 *           network of dells. No cliffs anywhere, no straight lines.
 *   desert  a THRESHOLDED, TERRACED field: flat playa, isolated mesas with flat
 *           tops and vertical risers, plus a slot canyon cut through it.
 *   coast   a signed SHORELINE DISTANCE: headlands and bays, a hard sea cliff,
 *           a broad marine terrace behind it, sea stacks offshore.
 *   winter  a U-PROFILE pass: flat trough floor, walls that stand straight up,
 *           lateral moraine ridges running along the foot of each wall.
 *
 * ---------------------------------------------------------------------------
 * SCALE DISCIPLINE — the thing that actually decides whether this reads.
 *
 * The camera is near-orthographic at 178 m with a 26 deg FOV, so the ground
 * beside the car is only ~130 m wide on screen. A 900 m valley is a featureless
 * plane at that magnification. Every biome therefore layers FOUR bands and all
 * four have to be present:
 *
 *   BACKDROP   600-1500 m wavelength, 100-250 m tall. Read near the horizon.
 *   LANDFORM   250-600 m,  20-60 m. The shape of the place; you feel it as a
 *              long climb or a valley closing in.
 *   DRIVABLE    60-180 m,   4-16 m. Crests, hollows, banks, jumps. THIS is the
 *              band v0 was missing entirely, and it is the one that makes the
 *              car feel like it is driving through landscape.
 *   TOOTH       15-45 m,  0.8-3 m. Tilts individual facets so flat shading has
 *              something to bite on. Without it the ground is a paint bucket.
 *
 * ---------------------------------------------------------------------------
 * ALTITUDE STOPS. `stops[i]` is the height at which `ramp[i]` lands. v0 mapped
 * a 0..120 m ramp onto an interior that only spanned ~8 m, so 95% of the ramp
 * was unreachable and the ground came out one colour. Stops are authored per
 * biome around the heights a driver ACTUALLY occupies, with the top one or two
 * entries reserved for the backdrop.
 */

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

/** Piecewise ramp lookup keyed on real altitude. */
function rampAt(target, ramp, h, stops) {
  const n = ramp.length - 1;
  if (h <= stops[0]) return target.copy(ramp[0]);
  for (let i = 0; i < n; i++) {
    if (h <= stops[i + 1]) {
      const span = stops[i + 1] - stops[i] || 1;
      const f = clamp((h - stops[i]) / span, 0, 1);
      return target.copy(ramp[i]).lerp(ramp[i + 1], f * f * (3 - 2 * f));
    }
  }
  return target.copy(ramp[n]);
}

/**
 * Large-scale patchiness. One coarse noise field drives two opposed macro
 * zones with a neutral band between, so the ground reads as meadow / scrub /
 * bare instead of a gradient. Features are 200-450 m: big fields of colour,
 * never speckle.
 */
function patches(c, K, x, z, seed, scale, aMix, bMix, e0 = 0.06, e1 = 0.22) {
  // Two bands: a big zone field (`scale`) and a breakup field 3.4x finer, so
  // there is colour structure both across the map and inside a single frame.
  // The camera only sees ~130 m of ground beside the car, so without the fine
  // band every shot is one macro zone and the ground goes flat again.
  const n = fbm(x * scale, z * scale, { octaves: 2, seed: seed + 41 })
    + fbm(x * scale * 2.3, z * scale * 2.3, { octaves: 1, seed: seed + 43 }) * 0.4;
  // Narrow transition bands: colour FIELDS with edges, not a wash.
  const a = smoothstep(e0, e1, n);
  if (a > 0) c.lerp(K.patchA, a * aMix);
  const b = smoothstep(-e0, -e1, n);
  if (b > 0) c.lerp(K.patchB, b * bMix);
}

/**
 * Hard-edged patches of a single material — rock slabs in the meadow, gravel
 * shelves on the terrace. The transition band is deliberately tiny (0.05 of the
 * noise range) so the boundary is a CUT EDGE, not a gradient. Soft-edged colour
 * blends average out into one mud tone at this camera distance; hard edges are
 * what make the ground read as cut paper.
 */
function outcrops(c, K, swatch, x, z, seed, scale, thr, amount) {
  const n = fbm(x * scale, z * scale, { octaves: 3, seed: seed + 131 });
  const t = smoothstep(thr, thr + 0.05, n);
  if (t <= 0) return;
  // Solid in the middle, still crisp at the rim: a flat 100% fill reads as a
  // sticker, a soft gradient reads as fog.
  c.lerp(swatch, t * amount * (0.6 + 0.4 * smoothstep(thr, thr + 0.24, n)));
}

/**
 * Slope -> exposed soil -> scree -> bare cliff. Three tiers, because a single
 * grey threshold turns every bank into concrete. slope = 1 - cos(tilt), so
 * 0.03 = 14 deg, 0.09 = 25 deg, 0.17 = 34 deg, 0.29 = 45 deg.
 */
function steepness(c, K, slope, soilAt, screeAt, cliffAt, m = [0.42, 0.72, 0.9]) {
  if (slope > soilAt) c.lerp(K.soil, smoothstep(soilAt, screeAt, slope) * m[0]);
  if (slope > screeAt) c.lerp(K.scree, smoothstep(screeAt, cliffAt, slope) * m[1]);
  if (slope > cliffAt) c.lerp(K.cliff, smoothstep(cliffAt, cliffAt + 0.2, slope) * m[2]);
}

// ---------------------------------------------------------------------------

// The drivable valley floor sits at 14-90 m. Keep every one of those stops on a
// green, so the meadow reads as meadow; snow only arrives above ~190 m.
const ALPINE_STOPS = [-26, -8, 8, 48, 135, 250];
const AUTUMN_STOPS = [-34, -14, 3, 20, 40, 68];
const DESERT_STOPS = [8, 21, 31, 50, 78, 108];
const COAST_STOPS = [-6, 3, 18, 44, 78, 110];
const WINTER_STOPS = [-16, -6, 4, 17, 80, 190];

export const BIOMES = {
  // =========================================================================
  // 1. ALPINE — a glacial corridor you drive along.
  // =========================================================================
  alpine: {
    id: 'alpine',
    palette: 'alpine',
    label: 'Alpine Meadows',
    waterLevel: -17.0,
    size: 1700,
    segments: 360,
    lodBias: 0.56,
    meshJitter: 0.42,
    treeDensity: 1.0,
    rockDensity: 0.7,

    height(x, z, seed) {
      const s = seed + 5;
      const { u, v } = corridor(x, z, s, { dir: 0.46, amp: 205, wave: 1500 });
      const av = Math.abs(v);

      // LANDFORM — the valley section. The floor is wide (a preset drive is
      // ~250 m, and the car must stay in the meadow), and the bank is gentle
      // enough to climb: 52 m over 390 m is a 13% average grade.
      const bank = smoothstep(130, 520, av);
      const alp = smoothstep(470, 900, av);
      let h = Math.pow(bank, 1.45) * 52;
      h += fbm(u * 0.0031, v * 0.0031, { octaves: 3, seed: s + 61 }) * 27 * bank;

      // BACKDROP — the alp and the ridge spines above it.
      h += Math.pow(alp, 1.6) * 190;
      h += spines(x, z, 0.0021, s + 7, 2.2) * 215 * alp;

      // DRIVABLE — crests to jump, hollows to dive through, banked turns where
      // the two meet. Damped on the spines so the backdrop stays clean.
      const k = 1 - alp * 0.72;
      h += fbm(x * 0.0051, z * 0.0051, { octaves: 2, seed: s + 11 }) * 15.5 * k;
      h += fbm(x * 0.0126, z * 0.0126, { octaves: 2, seed: s + 23 }) * 6.4 * k;

      // Tarn basins scooped out of the floor — the lakes sit in these.
      const basin = bumps(x, z, 540, s + 55, { chance: 0.26, radius: 0.24 });
      h -= Math.pow(smoothstep(0, 0.8, basin), 0.7) * 24 * (1 - bank);

      // TOOTH
      h += fbm(x * 0.029, z * 0.029, { octaves: 2, seed: s + 91 }) * 2.3 * k;
      h += fbm(x * 0.068, z * 0.068, { octaves: 1, seed: s + 93 }) * 0.8;
      return h;
    },

    colorAt(c, K, h, slope, x, z, seed) {
      rampAt(c, K.ramp, h, ALPINE_STOPS);
      patches(c, K, x, z, seed, 0.0046, 0.62, 0.55, 0.09, 0.17);
      // Limestone slabs breaking through the turf. Sparse, hard-edged, and the
      // only cool grey in a frame that is otherwise entirely green.
      outcrops(c, K, K.scree, x, z, seed, 0.0108, 0.33, 0.82);
      steepness(c, K, slope, 0.05, 0.13, 0.27);
      // Snow settles on high ground, but never on the near-vertical faces.
      if (h > 110) c.lerp(K.summit, smoothstep(110, 200, h) * (1 - smoothstep(0.2, 0.44, slope)));
      return c;
    },
  },

  // =========================================================================
  // 2. AUTUMN — rolling wooded hills. Rounded everything, no cliffs.
  // =========================================================================
  autumn: {
    id: 'autumn',
    palette: 'autumn',
    label: 'Ember Woodland',
    waterLevel: -31.0,
    size: 1500,
    segments: 340,
    lodBias: 0.6,
    meshJitter: 0.44,
    treeDensity: 1.9,
    rockDensity: 0.5,

    height(x, z, seed) {
      const s = seed + 3;
      const [wx, wz] = warped(x, z, s, 115, 0.0016);

      // LANDFORM — a broad county swell, then hills with domed tops.
      let h = fbm(wx * 0.0018, wz * 0.0018, { octaves: 2, seed: s + 31 }) * 27;
      h += domes(wx, wz, 0.0061, s + 43, 2) * 21;

      // DRIVABLE — the second dome band plus crests over the shoulders.
      h += domes(wx, wz, 0.0124, s + 47, 2) * 8.5;
      h += fbm(x * 0.0092, z * 0.0092, { octaves: 2, seed: s + 71 }) * 6.5;

      // Dendritic dells: the stream network that ties the hills together and
      // gives the woodland its branching, non-directional read.
      h -= dendritic(wx, wz, 0.0034, s + 57, 0.24, 3) * 10;

      // TOOTH
      h += fbm(x * 0.027, z * 0.027, { octaves: 2, seed: s + 91 }) * 2.6;
      h += fbm(x * 0.063, z * 0.063, { octaves: 1, seed: s + 93 }) * 0.9;
      return h + 4;
    },

    colorAt(c, K, h, slope, x, z, seed) {
      rampAt(c, K.ramp, h, AUTUMN_STOPS);
      patches(c, K, x, z, seed, 0.0044, 0.62, 0.58, 0.09, 0.17);
      // Damp mossy hollows in the dells.
      const wet = smoothstep(-12, -30, h);
      if (wet > 0) c.lerp(K.lowland, wet * 0.45);
      steepness(c, K, slope, 0.05, 0.13, 0.3, [0.45, 0.55, 0.7]);
      return c;
    },
  },

  // =========================================================================
  // 3. DESERT — playa, stepped mesas, slot canyon.
  // =========================================================================
  desert: {
    id: 'desert',
    palette: 'desert',
    label: 'Vermilion Mesa',
    waterLevel: -4.0,
    size: 1900,
    segments: 420,
    lodBias: 0.58,
    meshJitter: 0.3,
    treeDensity: 0.18,
    rockDensity: 1.6,

    height(x, z, seed) {
      const s = seed + 9;

      // Playa: NOT a table. Long sand swells with a dune train riding on them,
      // so the hard desert sun always has something to rake across. A flat
      // playa under a 41 deg sun is a paint bucket no matter what you colour it.
      let h = 26
        + fbm(x * 0.0031, z * 0.0031, { octaves: 2, seed: s + 5 }) * 7.5
        + fbm(x * 0.0092, z * 0.0092, { octaves: 2, seed: s + 15 }) * 3.4
        + Math.sin(x * 0.0165 - z * 0.0092) * 1.5   // dune train, directional
        + fbm(x * 0.033, z * 0.033, { octaves: 2, seed: s + 25 }) * 1.1;

      // Mesa footprints. The source field is deliberately SMOOTH (2 octaves,
      // ~600 m wavelength, gently warped) so the terrace contours come out as
      // clean closed curves. Feed a fractal field in here and you get the v0
      // zigzag wall: jagged contours + one-triangle-wide risers.
      //
      // The transition width is load-bearing and easy to get wrong. A riser is
      // `riser * step` metres of SOURCE height; how many facets wide it comes
      // out is that divided by the source gradient. With a 600 m field the
      // flank climbed 54 m in ~28 m, so every riser landed inside a single
      // triangle and the rim degenerated into shark teeth — the v0 zigzag in a
      // new costume. Halving the frequency and widening the threshold spreads
      // the same climb over ~110 m, which is 3-4 facets per riser: enough to
      // mesh a clean vertical face.
      const [wx, wz] = warped(x, z, s, 110, 0.0011);
      const f = fbm(wx * 0.00092, wz * 0.00092, { octaves: 2, seed: s + 21 });
      const cap = smoothstep(-0.12, 0.4, f);
      const bench = smoothstep(-0.34, 0.1, f);
      let block = Math.pow(cap, 0.75) * 56 + Math.pow(bench, 0.9) * 28;

      // Isolated buttes. Deliberately NOT sharpened with a low exponent: that
      // makes the last 10% of the cone climb 15 m and produces the same
      // one-triangle cliff. Let the terrace supply the hardness instead.
      const b = bumps(x, z, 340, s + 33, { chance: 0.17, radius: 0.24 });
      block += smoothstep(0.02, 0.78, b) * 38;

      // Erosion gullies bitten into the mesa edge BEFORE terracing, so the
      // steps come out scalloped and alcoved instead of as concentric ovals —
      // the difference between a mesa and a contour map.
      block -= dendritic(wx * 1.4, wz * 1.4, 0.0018, s + 71, 0.24, 3) * 30 * bench;

      // Two or three big benches, not a wedding cake. The riser is 30% of each
      // step, which at this field gradient spans 3-4 facets: wide enough to
      // mesh cleanly, steep enough (~55 deg) to read as a cliff face.
      h += terrace(block, 30, 0.4);

      // Slot canyon, offset so it never swallows the spawn.
      const cn = corridor(x + 260, z - 300, s + 3, { dir: -0.72, amp: 250, wave: 1700 });
      const cv = Math.abs(cn.v + 120);
      h -= terrace((1 - smoothstep(24, 150, cv)) * 46, 23, 0.4);

      return h;
    },

    colorAt(c, K, h, slope, x, z, seed) {
      rampAt(c, K.ramp, h, DESERT_STOPS);
      // Horizontal strata locked to absolute altitude — this is what makes a
      // terraced wall read as sedimentary rock rather than as stairs.
      const band = Math.sin(h * 0.235) * 0.5 + 0.5;
      c.offsetHSL(0.007 - band * 0.014, 0.05 * band, (band - 0.5) * 0.055);
      patches(c, K, x, z, seed, 0.0036, 0.55, 0.5, 0.1, 0.2);
      outcrops(c, K, K.patchB, x, z, seed, 0.0072, 0.26, 0.6);
      steepness(c, K, slope, 0.04, 0.11, 0.22, [0.4, 0.6, 0.85]);
      // Bleached sand pools in the flats between the mesas.
      if (h < 32 && slope < 0.035) c.lerp(K.sand, smoothstep(32, 24, h) * 0.5);
      return c;
    },
  },

  // =========================================================================
  // 4. COAST — headlands, sea cliffs, marine terrace, stacks.
  // =========================================================================
  coast: {
    id: 'coast',
    palette: 'coast',
    label: 'Cobalt Coast',
    waterLevel: 0.0,
    size: 1700,
    segments: 360,
    lodBias: 0.6,
    meshJitter: 0.4,
    treeDensity: 0.75,
    rockDensity: 0.9,

    height(x, z, seed) {
      const s = seed + 17;
      // Shoreline runs NE-SW with the sea to the south-east. The meander is
      // what turns a ruled line into headlands and bays.
      const { u, v } = corridor(x, z, s, { dir: 0.62, amp: 230, wave: 1150 });
      // Distance inland; the origin sits ~230 m back from the cliff edge.
      const d = v + 175 + fbm(u * 0.0034, 0.7, { octaves: 3, seed: s + 9 }) * 110;

      // --- sea floor, with stacks standing off the headlands
      let sea = -4 - smoothstep(-20, -400, d) * 24;
      const st = bumps(x, z, 165, s + 41, { chance: 0.18, radius: 0.14 });
      sea += Math.pow(smoothstep(0, 0.7, st), 0.3) * 30 * smoothstep(-260, -30, d);

      // --- land: a hard cliff, then a broad marine terrace tilted inland
      let land = Math.pow(smoothstep(-30, 78, d), 1.6) * 30 + smoothstep(60, 900, d) * 30;
      const on = smoothstep(0, 110, d);
      land += fbm(x * 0.0049, z * 0.0049, { octaves: 2, seed: s + 27 }) * 12 * on;
      land += fbm(x * 0.0118, z * 0.0118, { octaves: 2, seed: s + 37 }) * 5.2 * on;
      // Gorse-covered dune humps, the drivable texture of the terrace.
      land += bumps(x, z, 190, s + 51, { chance: 0.4, radius: 0.36 }) * 7.5 * on;
      land += fbm(x * 0.03, z * 0.03, { octaves: 2, seed: s + 91 }) * 2.1 * on;

      return mix(sea, land, smoothstep(-60, 10, d));
    },

    colorAt(c, K, h, slope, x, z, seed) {
      rampAt(c, K.ramp, h, COAST_STOPS);
      patches(c, K, x, z, seed, 0.0042, 0.6, 0.6, 0.09, 0.17);
      outcrops(c, K, K.scree, x, z, seed, 0.0095, 0.3, 0.72);
      // Storm beach: a narrow band of pale sand right at the waterline.
      const beach = smoothstep(-2, 1.5, h) * smoothstep(7, 3.5, h);
      if (beach > 0) c.lerp(K.sand, beach * 0.85);
      steepness(c, K, slope, 0.04, 0.1, 0.2, [0.4, 0.75, 1.0]);
      return c;
    },
  },

  // =========================================================================
  // 5. WINTER — U-shaped glacial pass with lateral moraines.
  // =========================================================================
  winter: {
    id: 'winter',
    palette: 'winter',
    label: 'Glacier Pass',
    waterLevel: -26.0,
    size: 1800,
    segments: 360,
    lodBias: 0.56,
    meshJitter: 0.4,
    treeDensity: 0.85,
    rockDensity: 1.1,

    height(x, z, seed) {
      const s = seed + 23;
      const { u, v } = corridor(x, z, s, { dir: -0.34, amp: 165, wave: 1400 });
      const av = Math.abs(v);

      // U-profile: a genuinely flat trough floor, then walls that stand up
      // fast. Same corridor operator as alpine, completely different section —
      // alpine opens outward, this one closes in on you.
      const wall = smoothstep(250, 620, av);
      let h = Math.pow(wall, 1.35) * 185;
      h += spines(x, z, 0.0018, s + 7, 2.0) * 170 * smoothstep(540, 950, av);

      // Lateral moraines: two long gravel ridges at the foot of each wall.
      // Low, jumpable, and they run with the valley so they lead the eye.
      const ridge = (cw) => Math.exp(-((av - cw) / 34) * ((av - cw) / 34));
      const along = 0.5 + 0.5 * Math.sin(u * 0.0068 + 1.3);
      h += (ridge(165) * 12 + ridge(258) * 8) * (0.42 + along * 0.58);

      // Snout hummocks, drift waves and wind sastrugi on the floor.
      const floor = 1 - wall;
      h += fbm(x * 0.0058, z * 0.0058, { octaves: 2, seed: s + 31 }) * 9.5 * floor;
      h += fbm(x * 0.0142, z * 0.0142, { octaves: 2, seed: s + 35 }) * 3.6 * floor;
      h += fbm(x * 0.034, z * 0.034, { octaves: 2, seed: s + 91 }) * 1.5;
      h += Math.sin(x * 0.031 + z * 0.014) * 0.7 * floor;
      return h;
    },

    colorAt(c, K, h, slope, x, z, seed) {
      rampAt(c, K.ramp, h, WINTER_STOPS);
      // Wind scour vs fresh drift: the only way snow gets macro structure.
      const n = fbm(x * 0.0046, z * 0.0046, { octaves: 2, seed: seed + 77 });
      const scoured = smoothstep(0.08, 0.36, n);
      if (scoured > 0) c.lerp(K.patchB, scoured * 0.55);
      const drift = smoothstep(-0.08, -0.34, n);
      if (drift > 0) c.lerp(K.patchA, drift * 0.5);

      // Moraine gravel. The two lateral ridges are recomputed here rather than
      // smuggled through the signature: they are the only mid-value in an
      // otherwise white biome, and two grey lines running with the valley are
      // what stop a snowfield from reading as blank paper.
      const { u, v } = corridor(x, z, seed + 23, { dir: -0.34, amp: 165, wave: 1400 });
      const av = Math.abs(v);
      const rock = Math.max(
        Math.exp(-((av - 165) / 30) * ((av - 165) / 30)),
        Math.exp(-((av - 258) / 22) * ((av - 258) / 22)) * 0.8,
      ) * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(u * 0.0068 + 1.3)));
      if (rock > 0.02) c.lerp(K.scree, clamp(rock * 1.3, 0, 1) * 0.85);
      // Wind-blasted rock ribs on the valley shoulders.
      outcrops(c, K, K.cliff, x, z, seed, 0.0102, 0.3, 0.75);
      outcrops(c, K, K.scree, x, z, seed, 0.0064, 0.24, 0.45);

      // Rock ribs punch through wherever the wall steepens — the darkest value
      // in the biome, and the thing that makes the pass legible at all.
      steepness(c, K, slope, 0.03, 0.09, 0.19, [0.45, 0.7, 0.85]);
      return c;
    },
  },
};

export const BIOME_IDS = Object.keys(BIOMES);
export const getBiome = (id) => BIOMES[id] ?? BIOMES.alpine;
