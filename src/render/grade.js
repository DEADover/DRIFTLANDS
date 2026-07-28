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
  // Tone curve. `shoulder` is the knee — below it the curve is the identity, so
  // every authored flat colour survives untouched. `white` is the asymptote the
  // roll-off approaches but never reaches, and the compression is applied to the
  // peak channel and shared across the triplet, so highlights keep their hue
  // instead of bleaching. Both are display-referred (0-1).
  shoulder: 0.74,
  white: 1.0,
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
  // DISPLAY-REFERRED: the bright pass tone maps before it thresholds, so this
  // is "how far toward white on screen", independent of scene exposure. It can
  // no longer be defeated by a hot scene buffer.
  bloomThreshold: 0.86,
  dof: 0.55,
  vignette: 0.20,
  ca: 0.0016,
};

export const GRADES = {
  // TARGET: ref/target_01_alpine_meadow.png — deep saturated meadow green,
  // warm high-key sun, gentle contrast, no washed whites, everything crisp.
  // Measured off the reference: lit grass sits at sRGB ~#6fb84a, grass in tree
  // shadow at ~#3a7a2e. That is a ratio of (0.25, 0.42, 0.39) — shadow is a
  // COLOURED step that keeps green and blue and eats red, never a grey wash.
  // The AO tint below is that ratio; it is why contact shading reads as cool
  // green rather than as dirt.
  //
  // The grade is deliberately CLOSE TO NEUTRAL. The palette anchors already are
  // the target colours (grass #5faa3c-#7cc24a, road #c9a45f), and the rig lands
  // a lit horizontal surface at ~0.95x its albedo, so a lit meadow arrives at
  // the composite already the right colour. Verified by hand: albedo #7cc24a
  // through this grade comes out #76c73e. A heavier grade only pushed it into
  // acid green. Saturation and richness are the world's job; the grade's job is
  // warmth, a shadow that is cool rather than black, and no clipped highlight.
  'Alpine Meadows': {
    exposure: 1.0,
    shoulder: 0.82,
    white: 1.0,
    // NO CRUSHED BLACKS. Shadow is a coloured step, so the lift is small but
    // blue-weighted: it opens the darks and tints them toward the sky instead
    // of letting them collapse to neutral.
    lift: [0.012, 0.020, 0.040],
    gamma: [1.0, 1.0, 1.0],
    gain: [1.0, 1.0, 1.0],
    contrast: 1.10,
    saturation: 1.08,
    shadowTint: [0.93, 0.99, 1.10],
    highTint: [1.06, 1.015, 0.93],
    // Objects are grounded by a soft dark pool at their base in every
    // reference frame — that pool is this, not the cast shadow.
    ao: 0.76,
    // Measured against the AO debug buffer (post.u.uDebug = 1): at 1.15 the
    // buffer was almost pure white — nothing was grounded. 2.4 gives the soft
    // dark pool the references have at the base of every tree, rock and post.
    aoIntensity: 2.4,
    aoTint: [0.38, 0.55, 0.52],
    bloom: 0.15,
    bloomWide: 0.09,
    bloomThreshold: 0.88,
    // The reference is sharp corner to corner: only a whisper of far softening.
    dof: 0.20,
    vignette: 0.20,
    ca: 0.0011,
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
