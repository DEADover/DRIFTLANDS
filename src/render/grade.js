/**
 * COLOUR GRADE — one designed look per biome.
 *
 * The lighting rig produces *correct* linear colour; this turns it into a
 * *designed* image. Each biome gets its own lift/gamma/gain, split-tone,
 * saturation and contrast, plus the strength of every post effect, so the five
 * places read as five deliberate photographs rather than one renderer with
 * different hexes plugged in.
 *
 * Conventions:
 *   lift        added into the shadows only          (0 = none)
 *   gamma       per-channel power, >1 darkens mids
 *   gain        per-channel multiply
 *   shadowTint  multiplied into dark values, centred on 1.0
 *   highTint    multiplied into bright values, centred on 1.0
 */

const BASE = {
  exposure: 1.0,
  shoulder: 0.74,
  lift: [0.0, 0.0, 0.0],
  gamma: [1.0, 1.0, 1.0],
  gain: [1.0, 1.0, 1.0],
  contrast: 1.08,
  saturation: 1.12,
  shadowTint: [1, 1, 1],
  highTint: [1, 1, 1],
  ao: 0.55,
  aoIntensity: 1.0,
  aoTint: [0.56, 0.61, 0.70],
  bloom: 0.16,
  bloomWide: 0.11,
  // Linear-HDR threshold. The scene buffer is untonemapped (post does its own
  // tone map), so lit ground sits around 1.5-2.5 here, not 0-1. A 0.8 cut made
  // the entire meadow bloom into a white star.
  bloomThreshold: 2.6,
  dof: 0.55,
  vignette: 0.20,
  ca: 0.0016,
};

export const GRADES = {
  'Alpine Meadows': {
    exposure: 1.04,
    shoulder: 0.76,
    lift: [0.008, 0.014, 0.028],
    gamma: [1.02, 1.0, 0.99],
    gain: [1.02, 1.02, 0.99],
    contrast: 1.12,
    saturation: 1.13,
    shadowTint: [0.91, 0.98, 1.13],
    highTint: [1.05, 1.02, 0.96],
    ao: 0.58,
    aoIntensity: 1.05,
    aoTint: [0.50, 0.58, 0.68],
    bloom: 0.22,
    bloomWide: 0.13,
    bloomThreshold: 0.93,
    dof: 0.55,
    vignette: 0.17,
  },

  'Ember Woodland': {
    exposure: 1.10,
    shoulder: 0.72,
    lift: [0.030, 0.018, 0.012],
    gamma: [1.0, 1.01, 1.04],
    gain: [1.02, 1.0, 0.97],
    contrast: 1.12,
    saturation: 1.14,
    shadowTint: [1.00, 0.96, 1.06],
    highTint: [1.06, 1.01, 0.91],
    ao: 0.60,
    aoIntensity: 1.05,
    aoTint: [0.54, 0.50, 0.56],
    bloom: 0.40,
    bloomWide: 0.32,
    bloomThreshold: 0.86,
    dof: 0.62,
    vignette: 0.17,
  },

  'Vermilion Mesa': {
    exposure: 1.00,
    shoulder: 0.78,
    lift: [0.006, 0.012, 0.026],
    gamma: [0.99, 1.0, 1.02],
    gain: [1.03, 1.0, 0.96],
    contrast: 1.16,
    saturation: 1.16,
    shadowTint: [0.90, 0.97, 1.16],
    highTint: [1.06, 1.01, 0.92],
    ao: 0.60,
    aoIntensity: 1.1,
    aoTint: [0.52, 0.55, 0.66],
    bloom: 0.24,
    bloomWide: 0.18,
    bloomThreshold: 0.95,
    dof: 0.45,
    vignette: 0.17,
  },

  'Cobalt Coast': {
    exposure: 1.30,
    shoulder: 0.62,
    lift: [0.022, 0.020, 0.052],
    gamma: [1.0, 1.02, 1.0],
    gain: [1.05, 0.99, 1.02],
    contrast: 1.14,
    saturation: 1.26,
    shadowTint: [0.86, 0.90, 1.22],
    highTint: [1.14, 0.98, 0.94],
    ao: 0.52,
    aoIntensity: 0.95,
    aoTint: [0.46, 0.48, 0.62],
    bloom: 0.55,
    bloomWide: 0.45,
    bloomThreshold: 0.52,
    dof: 0.70,
    vignette: 0.28,
    ca: 0.0022,
  },

  'Glacier Pass': {
    exposure: 1.00,
    shoulder: 0.70,
    lift: [0.010, 0.018, 0.034],
    gamma: [1.02, 1.01, 0.99],
    gain: [1.0, 1.0, 1.01],
    contrast: 1.10,
    saturation: 1.06,
    shadowTint: [0.87, 0.95, 1.14],
    highTint: [1.02, 1.015, 1.0],
    ao: 0.46,
    aoIntensity: 0.95,
    aoTint: [0.62, 0.68, 0.80],
    bloom: 0.26,
    bloomWide: 0.16,
    bloomThreshold: 0.94,
    dof: 0.60,
    vignette: 0.17,
  },
};

/** Resolve a grade for a palette, falling back to a sane derived default. */
export function gradeFor(palette) {
  const named = GRADES[palette?.name] ?? {};
  const g = { ...BASE, ...named };
  if (named.exposure === undefined && palette?.exposure) g.exposure = palette.exposure;
  return g;
}
