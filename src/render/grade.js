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
  // Value the contrast rotates about. 0.5 = mid grey (the photographic
  // default); lower it onto the picture's own key value when the subject lives
  // well below mid grey, as a meadow does.
  contrastPivot: 0.5,
  // Display-space knee. Everything above it is compressed toward, but never
  // onto, white AFTER the grade has had its way. Protects the dust plume.
  hiKnee: 0.88,
  // Display-space knee at the BOTTOM, mirroring hiKnee. Below it, values are
  // compressed toward — but never onto — zero, so a hard contrast cannot clip
  // a channel flat. 0 = off (the old behaviour).
  loKnee: 0.0,
  saturation: 1.12,
  shadowTint: [1, 1, 1],
  highTint: [1, 1, 1],
  // Luma window the split-tone ramps across. The default is the whole range,
  // which quietly tints the midtones too; see the essay in post.js.
  splitRange: [0.05, 0.95],
  ao: 0.55,
  aoIntensity: 1.0,
  // Wide cavity radius in METRES (the tight contact radius is fixed at 2.2 m).
  // Big values buy the broad darkening between and under clumps of trees that
  // the references have; they cost nothing, the sample count is unchanged.
  aoWide: 8.0,
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
  // Broken light. See MEADOW_NOISE in post.js. `dapple` is the downward swing
  // of the light term, `dappleWarm` the warm/cool split across the lobes and
  // `dappleMetres` the lobe size in world metres. 0 = off.
  dapple: 0.0,
  dappleWarm: 0.0,
  dappleFine: 0.0,
  dappleMetres: 34,
  // Screen-space dither. Its first job is to kill banding in the sky ramp; a
  // little more than that also gives the flat facets some tooth.
  grain: 0.0022,
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
  // ROUND 2 held that the grade should be CLOSE TO NEUTRAL, because the palette
  // anchors are already the target colours and a heavier grade pushed the meadow
  // into acid green. Round 3 measured what "close to neutral" actually produced
  // (tools/measure.mjs, against the reference):
  //
  //                        reference    round 2      round 3
  //   meadow luma p05/p95   42 / 133    55 / 111     45 / 121
  //   meadow tonal spread   91          52           74
  //   frame mean R/G        0.885       0.840        0.899
  //   frame mean saturation 0.754       0.718        0.741
  //
  // So round 2 was right that a heavier grade is not the answer, and wrong about
  // which knob. Turning saturation up made it acid because saturation is the
  // wrong axis: the reference is not more saturated, it has a WIDER meadow and a
  // WARMER key. What actually moved it was a contrast pivoted on the meadow's own
  // median instead of on mid grey, a gain that fixes the red/green ratio at the
  // root, a deeper shadow floor in the rig, and low-frequency broken light. The
  // saturation knob is still where round 2 left it, near 1.05.
  'Alpine Meadows': {
    // ROUND 4, MEASURED (tools/measure_rp.mjs, 1600x900, hero_alpine vs the
    // reference normalised to the same size):
    //
    //                      reference   round 3    want
    //   frame luma p05        33          54       ~40
    //   frame luma p50        97         102        ~97
    //   frame luma p95       159         169       ~159
    //   frame mean            97         108        ~98
    //   meadow tonal spread  110          87       >100
    //   open-meadow B/G     0.12        0.22       ~0.14
    //
    // Every one of those says the same thing twice: the picture is a stop too
    // bright at the top and nowhere near dark enough at the bottom. Round 3
    // spent its effort widening the top of the range; the range it was missing
    // was underneath. So: pull the exposure down (the tone curve's identity
    // region means this is a clean linear scale, not a crush), take the lift
    // off the shadows, and stop the split-tone from tinting sunlit grass.
    exposure: 0.93,
    shoulder: 0.82,
    white: 1.0,
    // NO CRUSHED BLACKS — but the old lift was 0.066 of blue added at
    // (1 - col), i.e. +11/255 of blue still arriving at mid-grass. That is a
    // veil, not a shadow colour. Halved, and the sky colour in the darks now
    // comes from shadowTint on a ramp that ends before the meadow does.
    lift: [0.0, 0.030, 0.195],
    // The lift now falls off as (1-col)^3, so this amplitude reaches a dark
    // tree face nearly in full and sunlit grass barely at all. It is what puts
    // the sky back into our shadows: measured shadowed grass went from
    // B/G 0.03 (no blue at all — a brown hole) toward the reference's 0.22-0.41.
    liftFalloff: 4.0,
    gamma: [1.0, 1.0, 1.0],
    // MEASURED: the reference frame's mean is R/G = 0.885 and its lit grass is
    // R/G = 0.868 — a yellow-green. Ours came out 0.840 and 0.756: the same
    // value, but a PURE green. That single ratio is most of what reads as
    // "ours is more olive / less alpine". The gain fixes the hue at the root
    // rather than asking the split-tone to do it in the top third of the range,
    // where a meadow does not live.
    // ROUND 4, MEASURED per patch rather than per frame (tools/patch_rp.mjs).
    // The frame-mean R/G that round 3 tuned against is dominated by our very
    // wide road, so it hid the truth: open meadow measured R/G 0.93 against the
    // reference's 0.84, and the road 1.33 against 1.27. Both are too red by
    // about the same 4%, which is exactly what the round-3 gain added. Taking
    // it back off lands the road on the reference and the meadow most of the
    // way there; the rest of the meadow's yellow is in the albedo, not here.
    gain: [0.990, 1.005, 0.955],
    // 1.26 was tried and reverted (shots/g8): it moved frame p95 by one value
    // and cost one at the median. The top of our range is governed by hiKnee,
    // not by the contrast, so this knob has nothing left to give here.
    contrast: 1.30,
    contrastPivot: 0.325,
    hiKnee: 0.72,
    // Alpine runs contrast 1.30 about a pivot of 0.325, which without this
    // clips every channel under 0.075 — i.e. all of the blue in the meadow.
    loKnee: 0.055,
    saturation: 1.065,
    // Shadow eats red: measured R/G in target_01's shadowed grass is 0.53-0.74
    // against 0.79 in the sun. A tint that only cools cannot do that; this one
    // takes red out as well.
    shadowTint: [0.84, 0.96, 1.22],
    highTint: [1.055, 1.012, 0.92],
    // Cool tint spent only on what is actually in shadow. 0.52 is just above
    // the luma of grass under a conifer in target_01 and well below open
    // meadow, so the two get different colours instead of the same wash.
    splitRange: [0.02, 0.46],
    // Objects are grounded by a soft dark pool at their base in every
    // reference frame — that pool is this, not the cast shadow.
    ao: 0.84,
    // Measured against the AO debug buffer (?debugpost=ao): at 1.15 the buffer
    // was almost pure white — nothing was grounded. 2.4 gave the soft dark pool
    // the references have at the base of every tree, rock and post. 3.6 is that
    // same pool re-levelled after the radius-scaled height gate in post.js
    // stopped counting terrain creases as occluders.
    aoIntensity: 3.6,
    // MEASURED off target_01: the meadow is not one value with objects on it,
    // it has broad darker ground THROUGH and BETWEEN the tree clumps — its
    // grass spread is 110 luma against our 86. At 8 m this term only deepened
    // what was already a cavity; at 15 m a stand of firs shades the ground
    // around it, which is the single biggest "painted, not rendered" cue left.
    aoWide: 18.0,
    aoTint: [0.36, 0.48, 0.60],
    bloom: 0.10,
    bloomWide: 0.06,
    bloomThreshold: 0.88,
    // The reference is sharp corner to corner: only a whisper of far softening.
    dof: 0.20,
    // MEASURED: target_01's twelve row means run 79 / 113 / 77 top to bottom —
    // the edges sit at 70% of the peak. Ours ran 96 / 117 / 90, i.e. 77%.
    vignette: 0.31,
    ca: 0.0011,
    // Alpine is the meadow biome, so it is the one that most needs the field
    // broken up. Measured target spread 91 luma vs our flat 54 — see the essay
    // above MEADOW_NOISE in post.js.
    dapple: 0.36,
    // The reference's field is yellow-green where the sun lands and blue-green
    // in the hollows, and that warm/cool split across the meadow is most of why
    // it reads as painted rather than lit. 0.06 was almost invisible.
    dappleWarm: 0.10,
    // Eased off: this is a 1.6 m brush texture and the scatter it was standing
    // in for (flowers, tussocks) is coming back into the meadow this round.
    dappleFine: 0.15,
    grain: 0.006,
    dappleMetres: 24,
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
