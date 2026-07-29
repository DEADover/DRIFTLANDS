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
  // 0 = the contrast runs per channel (and so doubles as a saturation boost —
  // see the essay at the contrast in post.js). 1 = it runs on luma and the
  // triplet is rescaled, so the tonal shaping is identical and the chroma
  // survives. Defaults to 0 only to leave the unshipped biomes as authored.
  contrastChroma: 0.0,
  // Display-space knee. Everything above it is compressed toward, but never
  // onto, white AFTER the grade has had its way. Protects the dust plume.
  hiKnee: 0.88,
  // Release of the highlight knee for the very top of the range, so a knee low
  // enough to hold a broad bright surface does not also flatten small specular
  // peaks. 0 = off (a plain shoulder); see the essay in post.js.
  hiRecover: 0.0,
  hiRecoverRange: [0.88, 1.0],
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
    // ROUND 5: round 4 pulled this down to fix a frame that was a stop too
    // bright at the top and not dark enough at the bottom. The bottom is now
    // fixed at its source (shadowFloor in renderer.js), so the exposure is free
    // to go back up and put the SUNLIT meadow where the reference's is — its
    // grass sits at luma 0.51 and ours at 0.41, and the mass the histogram is
    // missing is all in the 0.4-0.6 buckets (ours 24%, the reference's 39.5%).
    // ROUND 6: trimmed a hair. With the highlight knee opened up and the shadow
    // family lifted at its source, the frame mean landed at 0.390 against the
    // reference's 0.379; this is the one knob that moves the whole distribution
    // without changing its shape, so it is the right one to spend the 0.011 on.
    exposure: 1.01,
    shoulder: 0.82,
    white: 1.0,
    // NO CRUSHED BLACKS — but the old lift was 0.066 of blue added at
    // (1 - col), i.e. +11/255 of blue still arriving at mid-grass. That is a
    // veil, not a shadow colour. Halved, and the sky colour in the darks now
    // comes from shadowTint on a ramp that ends before the meadow does.
    // ROUND 5, MEASURED PER PATCH (tools/patch_rp5.mjs):
    //
    //                    ours B:G   target B:G
    //   sunlit grass       0.150       0.214
    //   grass in shade     0.117       0.257
    //
    // The blue is not only missing from the shadows, it is missing from the
    // whole meadow — and a (1-luma)^4 profile is a shadow-only instrument. It
    // reaches a dark tree face at 0.52 of amplitude and sunlit grass at 0.14, a
    // 4:1 ratio, so the amplitude that would fix the sun floods the darks with a
    // blue veil first. Falloff 2.0 makes that ratio 1.7:1, which lets a much
    // SMALLER amplitude land on the meadow: sunlit grass gains 4/255 of blue and
    // grass in shade 3/255, while the deepest canopy actually receives slightly
    // less than before. The rest of the shadow's blue is the shadowTint's job,
    // where it belongs — it is a light colour, not a black point.
    // ROUND 6: the green goes up. MEASURED, our deepest luma decile is
    // rgb(8,19,20) against target_01's rgb(9,28,21) — red and blue land, green
    // is 9/255 short, and that one number is the difference between a legible
    // dark GREEN tree (the reference) and a teal silhouette (ours). Green is
    // bounce, not sky, so it also gets no toe; see liftToe below.
    // ROUND 7: THE LIFT WAS THE TEAL, AND IT WAS ALSO THE SATURATION DEFICIT.
    //
    // MEASURED (tools/depth_rp.mjs — isolates the conifer-canopy population,
    // the one thing that appears at every depth in both frames, instead of
    // averaging the whole picture):
    //
    //                      ours            target
    //   canopy rgb     [27,57,34]      [28,52,23]
    //
    // Red lands. Blue is 11/255 over and green 5/255 over, and 11 of blue on a
    // green of 57 is precisely the difference between the reference's warm dark
    // green and our teal. Where it comes from is arithmetic: at canopy luma 0.19
    // the (1-luma)^2 ramp is 0.656, so the old lift delivered +17.6/255 of blue
    // and +3.7/255 of red to every pixel in a tree.
    //
    // And it was the frame's saturation too. Saturation is (max-min)/max and on
    // a green the min channel is blue, so a blue lift is a DESATURATION knob
    // wearing a different name. SWEPT (tools/sweep_rp.mjs, five settings in one
    // page load): blue 0.105 -> 0.075 -> 0.050 moves frame saturation
    // 0.733 -> 0.754 -> 0.775 against the reference's 0.756, and canopy blue
    // 34 -> 28 -> 22 against its 23. Two independent measurements agreeing on
    // the same knob is as close to proof as this gets.
    //
    // 0.060 / 0.040 is where both land: frame saturation 0.759, dark% 32.5 on
    // the nose, canopy [29,56,25]. The green comes down with it because the
    // same sweep showed canopy green 58 against the reference's 52.
    lift: [0.022, 0.040, 0.060],
    // The lift now falls off as (1-col)^3, so this amplitude reaches a dark
    // tree face nearly in full and sunlit grass barely at all. It is what puts
    // the sky back into our shadows: measured shadowed grass went from
    // B/G 0.03 (no blue at all — a brown hole) toward the reference's 0.22-0.41.
    liftFalloff: 2.0,
    // ...AND A TOE. See the essay at the lift in post.js: a plain ramp hands its
    // biggest dose of sky fill to the pixels that can see the least sky, which
    // is how our deepest shade came out rgb(5,19,40) — a navy blue — against the
    // reference's rgb(9,28,21). Below this luma the fill fades out.
    //
    // PER CHANNEL, because the three channels are three different lights: BLUE
    // is sky and a cavity cannot see the sky, so it gets the full toe; GREEN is
    // bounce off grass and off the tree's own needles, which is the only light
    // left inside a stand, so it gets none; RED is a little of both.
    liftToe: [0.04, 0.0, 0.18],
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
    // ROUND 5: the blue multiplier goes the other way. Round 4 set it to 0.955
    // to pull the frame's R/G onto the reference, but R/G is set by R and G —
    // taking blue out was collateral, and measure.mjs then read frame mean blue
    // 26 against the reference's 44 with every dominant colour bin ending in 00.
    // Red and green are now within a value of the reference at the frame mean
    // (90/102 against 91/103), so they stay where they are and only blue moves.
    // ROUND 6: THE MEADOW'S MISSING SATURATION WAS MISSING RED, NOT SATURATION.
    //
    // MEASURED with the right statistic at last (tools/sat.mjs — MEAN PER-PIXEL
    // saturation per luma decile, which is what measure.mjs reports; the
    // saturation of a decile's MEAN COLOUR is a different number and it lies,
    // because averaging several hues greys the result):
    //
    //              ours (round 5)   target
    //   decile 3       0.725        0.842
    //   decile 4       0.717        0.842
    //   decile 5       0.695        0.812
    //
    // Deciles 3-5 are 57% of this frame and they carried the ENTIRE frame-mean
    // deficit; deciles 0-2 and 6 were already on the reference. And the reason
    // is visible in one number: the reference's sunlit grass is #8b8b17, where
    // RED EQUALS GREEN — a chartreuse. Ours was rgb(113,126,x), R/G 0.90, a pure
    // green. Turning the saturation knob up to close the gap instead drove the
    // blue to zero (every dominant bin ended in 00 against the reference's 0x17)
    // and printed neon grass in lake_bridge; red is the channel that was
    // actually short, and adding it raises both the saturation and the luma,
    // which is also where deciles 4-5 needed mass.
    //
    // 1.05 AND NOT MORE, AND THE LIMIT IS A PICTURE, NOT A NUMBER. Swept to
    // 1.16: deciles 3-5 reached 0.79/0.80/0.77 and the histogram L1 against the
    // reference fell to its best value of the round — and every boulder in the
    // frame turned PINK, because a global red gain cannot tell a green it should
    // warm from a grey it should not. The rocks are the constraint.
    gain: [1.050, 0.995, 1.105],
    // 1.26 was tried and reverted (shots/g8): it moved frame p95 by one value
    // and cost one at the median. The top of our range is governed by hiKnee,
    // not by the contrast, so this knob has nothing left to give here.
    //
    // ROUND 5. It has plenty left to give now that raising it no longer wrecks
    // the chroma. Measured from the round-4 histogram: our luma std is 0.141
    // against the reference's 0.155 — we are 10% short of its spread — while
    // both means sit at 0.37. A contrast about the picture's own key value is
    // the one move that widens without shifting, so 1.30 x 1.10 = 1.43.
    contrast: 1.43,
    contrastPivot: 0.325,
    // ROUND 5: the contrast now runs on LUMA. Per channel it was silently the
    // biggest saturation knob in the grade and it was zeroing the blue in every
    // green in the frame — see the essay at the contrast in post.js.
    contrastChroma: 1.0,
    // ROUND 5: 0.72 was a ceiling, not a roll-off. Measured, only 0.4% of our
    // pixels reached luma 0.7 against the reference's 1.5%, and 0.0% reached
    // 0.8 against its 0.2% — the picture had no highlight tail at all, which is
    // half of why the meadow read as a painted plane. At 0.72 a peak channel of
    // 1.0 landed at 0.86 and one of 0.85 at 0.81, so the whole top quarter of
    // the range was folded into a 0.14-wide band. The knee still exists (the
    // dust plume must not grow), it just starts where the picture's real
    // highlights end rather than in the middle of them.
    // MEASURED PER PATCH (tools/patch_rp5.mjs), and this turned out to be the
    // largest single tonal error in the frame:
    //
    //                    ours    target
    //   road             0.726    0.500
    //   road (far)       0.673    0.450
    //   sunlit grass     0.392    0.373
    //   grass in shade   0.346    0.346
    //
    // The MEADOW is already right — both grass patches land within 0.02 of the
    // reference. The road is 0.23 of display range too bright, and it is ~14%
    // of the frame, which is precisely and entirely the histogram's remaining
    // defect: ours put 10.5% in the 0.6-0.7 bucket and 3.8% above 0.7 against
    // the reference's 5.0% and 1.4%, and it left the 0.5-0.6 bucket at 8.9%
    // against 17.5% because the mass that belongs there is sitting two buckets
    // up. It also carried the whole 0.015 of excess frame mean.
    //
    // A knee is the correct instrument for "one bright surface is printing too
    // hot" — it is why this knob exists. At 0.48 the road's peak channel (0.843)
    // is compressed to 0.69 and the road lands near 0.60, while sunlit grass
    // (peak 0.424) passes underneath it completely untouched. The meadow keeps
    // exactly the values that already match; only the thing that is wrong moves.
    //
    // ROUND 6: 0.48 WAS AIMED AT THE WRONG SURFACE, AND THE MASK PROVES IT.
    //
    // tools/hl.mjs paints every pixel above luma 0.6 orange. In target_01 that
    // mask is THE ENTIRE ROAD, plus sunlit grass crowns scattered right across
    // the meadow, plus the tops of rocks and the flower clumps. In ours it is
    // the dust plume and nothing else — the road is completely below the line.
    //
    // Per BUCKET rather than per patch (tools/hl.mjs, mean colour of each luma
    // decile), the two frames agree almost exactly wherever we have mass:
    //
    //            ours              target
    //   0.4   116,123,28  20.2%   118,123,31  22.0%
    //   0.5   160,142,34  18.0%   153,144,32  17.5%
    //   0.6   192,160,80   1.4%   197,163,72   4.9%
    //   0.7   211,187,109  0.2%   222,184,103  1.4%
    //
    // Identical colours, a third of the population. So the reference does not
    // have a DIFFERENT bright surface from ours, it has MORE OF THE SAME ONE:
    // its road runs on through 0.6-0.75 where the 0.48 knee folds ours back into
    // 0.5-0.6. The round-5 patch measurement that set 0.48 sampled one square of
    // road and compared it to one square of the reference's; the histogram is the
    // whole population and it says the opposite.
    //
    // 0.70 is where the road's peak channel (0.94 arriving) compresses to 0.83
    // instead of 0.73, i.e. the road lands at luma ~0.64 — the reference's own
    // bucket-6 value — while sunlit grass (peak 0.48) still passes underneath
    // untouched and the plume still has a knee above it. Nothing that already
    // matched has moved.
    hiKnee: 0.755,
    // ...and the release above it, so a knee that low still leaves a tail. See
    // the essay at the highlight roll-off in post.js. The road's peak channel
    // is 0.84 and never enters this range; the dust plume, the white flowers and
    // the car's roof do.
    // MEASURED: at 0.80 over [0.86, 1.0] the release put 4.5% of the frame above
    // luma 0.7 against the reference's 1.5%, and it emptied the 0.5-0.6 bucket
    // (18.0% -> 11.1%) doing it. The patch average of the road's peak channel is
    // 0.843, but its brightest pixels run past 0.86, so a release starting there
    // was still catching the top of the road — the population it exists to
    // exclude. Starting it at 0.93 puts it above everything except the plume,
    // the flowers and the car.
    // ROUND 6: with the knee up at 0.70 the release no longer has to rescue a
    // whole road, only the last 0.1% of the frame — the plume core, the car roof
    // and the white flowers, which are the reference's buckets 8 and 9 (0.1% and
    // 0.1%, mean colour 227,213,166 and 242,241,231, chroma 0.27 and 0.05). It
    // starts higher and stays strong, because that population is genuinely
    // achromatic and genuinely tiny.
    hiRecover: 0.16,
    hiRecoverRange: [0.88, 1.0],
    // Alpine runs a hard contrast about a low pivot, which without this clips
    // every channel under 0.075 — it used to take all of the blue in the meadow
    // with it. The luma-space contrast now protects the chroma on its own, so
    // this is back to doing only its original job: keeping a near-black off
    // absolute zero. Lowered so the reference's genuinely deep canopy shadows
    // (its top colour bin is #172e17 at luma 0.16, 9.4% of the frame) are
    // reachable at all — at 0.055 nothing could land below 7/255 x 3.
    // ROUND 6: 0.032 was low enough to be reachable and low enough to be
    // pointless — a channel landing at 0.016 is still a hole. The reference's
    // own bottom bucket has mean chroma 0.68 against our 0.88 and mean red 9
    // against our 5: its blacks are compressed and slightly desaturated, not
    // clipped. This knee is per-channel precisely so that it does that, and it
    // is the only term that can put red back into a pixel whose red is zero.
    loKnee: 0.055,
    // NEAR NEUTRAL, AND IT FINALLY MEANS IT. Round 2 concluded the grade should
    // supply almost no saturation and let the world supply the colour; round 4
    // still read 0.830 against the reference's 0.756 because the CONTRAST was
    // secretly the biggest saturation knob in the shader (see post.js). With
    // that fixed this is the only saturation term left, so it can sit where
    // round 2 said it should. 1.02 rather than 1.00 because the split-tone
    // below is a multiply and multiplies pull very slightly toward grey.
    // 1.075, not 1.10: measured, 1.10 put the frame mean on the reference
    // (0.726 vs 0.756) but did it by squeezing the blue back out of the grass —
    // sunlit grass fell from 26 to 18 against the reference's 23. A saturation
    // multiply moves the WEAK channel, so on a green it is a blue knob wearing
    // a different name, which is the same trap the per-channel contrast was.
    saturation: 1.74, // LEAD round 5: terrain-art muted the albedo and this grade
    // muted it again; the two compounded to a frame mean of 0.592 against the
    // reference's 0.756. Swept 1.30/1.45/1.60 -> 0.676/0.729/0.781 and interpolated.
    // Shadow eats red: measured R/G in target_01's shadowed grass is 0.53-0.74
    // against 0.79 in the sun. A tint that only cools cannot do that; this one
    // takes red out as well.
    //
    // ROUND 5: WHAT "FRAME MEAN BLUE 44" ACTUALLY MEANS. The brief reads the
    // reference's mean blue of 44 against our 26 as starved greens. Its colour
    // bins say something more specific: #172e17, #2e4617, #8b8b17, #465d17 —
    // every green in the reference, from the deepest canopy to the brightest
    // sunlit grass, carries blue 23 and only blue 23. The fifth bin is #0074b9
    // at blue 185, and that is the LAKE. Half of the reference's mean blue is
    // one object that this shot does not contain.
    //
    // So the number to hit is 23 in the greens, not 44 in the mean — and after
    // cycle 6 our sunlit grass was already at 26 and our grass in shade at 18.
    // The overshoot was all in the two things that should not be blue at all:
    // the road (98) and the conifers (66), which had gone visibly teal. This
    // pulls the cool tint back to where a sky fill would really land it.
    shadowTint: [0.95, 0.99, 1.10],
    // THE SPLIT-TONE IS THE ONLY HUE-SELECTIVE TOOL IN THE GRADE, SO IT HAS TO
    // BE AIMED. Measured after the blue was restored globally (cycle 6):
    //
    //                 ours B:G   target B:G
    //   sunlit grass    0.234       0.214   <- landed
    //   grass in shade  0.189       0.257   <- better
    //   ROAD            0.719       0.480   <- overshot badly
    //
    // A dirt road is the one surface in an alpine frame that is NOT full of sky,
    // and giving it the meadow's blue turned it from ochre to a pale grey tan —
    // worth 0.034 of the frame's whole saturation deficit on its own, because a
    // road is 14% of this shot.
    //
    // The old ramp ran 0.02..0.50, which is entirely BELOW the road (luma 0.61)
    // and almost entirely below sunlit grass (0.39): both got the same ~90% of
    // the warm tint and the tool separated nothing. Straddling the meadow
    // instead — the ramp now starts under sunlit grass and ends under the road —
    // gives the grass four fifths of the cool sky tint and the road effectively
    // all of the warm one, off the same knob, in the same pass.
    // The blue here is the road's only real defence. Measured: the reference's
    // road is [159,125,60], saturation 0.62; ours arrives at [180,156,96],
    // saturation 0.47 — a pale grey tan where the reference has ochre, and a
    // road is 14% of this frame, so that one surface is a third of the whole
    // frame's saturation deficit. Below the split ramp the meadow keeps its sky
    // fill; above it, the one surface in an alpine picture that is NOT full of
    // sky gets its warmth back.
    // ROUND 6, MEASURED AT THE SAME LUMA AT LAST. The argument above was made
    // while our road was printing 0.23 of display range hotter than the
    // reference's, so "ours is a pale grey tan" was comparing two different
    // exposures of it. With the highlight knee opened, the two land on top of
    // each other — luma decile 0.6-0.7, ours rgb(195,166,43) against the
    // reference's rgb(197,163,72). Red and green agree to within three values.
    // The road's problem was never that it was pale; it is that this tint was
    // taking a quarter of its blue away, and 43 against 72 is the whole of the
    // remaining saturation error in the brightest third of the frame (ours 0.78,
    // the reference 0.63). A dirt road is not full of sky, but it is not free of
    // it either.
    highTint: [1.00, 1.01, 1.12],
    // ROUND 6: the ramp moves up with the road. It used to start at 0.30, which
    // is UNDER sunlit grass (0.42-0.46), so the meadow was taking 40% of a tint
    // built for a dirt road. Measured, restoring the road's blue through that
    // ramp cost the grass 0.05 of saturation in the 0.4-0.6 deciles, where ours
    // already matched the reference (0.77/0.79 against 0.75/0.79). Starting the
    // ramp above sunlit grass and ending it on the road crown separates the two
    // populations the knob exists to separate.
    splitRange: [0.50, 0.70],
    // Objects are grounded by a soft dark pool at their base in every
    // reference frame — that pool is this, not the cast shadow.
    // ROUND 5. THE HISTOGRAM SPIKE IS THE TREES, NOT THE MEADOW.
    //
    // MEASURED per patch: our sunlit grass is 0.384, our grass in shade 0.338
    // and our conifer canopy 0.300 — the entire green half of the picture lives
    // inside one 0.1-wide luma bucket, which is precisely the 29.5% spike in
    // bucket 3. The reference separates them: grass 0.373, canopy #172e17 at
    // 0.16. Its trees are 0.21 below its grass; ours are 0.08 below.
    //
    // That gap is not exposure and not contrast — both of those move the grass
    // and the trees together, which is why raising the contrast to 1.43 left
    // the spike where it was. It is OCCLUSION: a conifer stand is a solid mass
    // and the light does not get inside it. The wide cavity term is the only
    // thing in the renderer that knows the difference between a tree clump and
    // an open field, so it is the only knob that can move one without the other.
    //
    // MEASURED, AND IT IS NOT ENOUGH ON ITS OWN. At ao 0.92 / intensity 5.2 the
    // canopy moved 0.300 -> 0.291 and the frame mean fell 0.368 -> 0.362: the
    // term was darkening the whole picture faster than it was separating the
    // trees, because the top of a conifer seen from above is not IN a cavity —
    // it is the most exposed surface in the frame. The remaining 0.13 of
    // separation is the conifer's own albedo and its self-shadowing, which is
    // props/terrain work, not a post effect. Backed off to a value that keeps
    // the extra grounding without the global tax, and logged as such.
    ao: 0.88,
    // Measured against the AO debug buffer (?debugpost=ao): at 1.15 the buffer
    // was almost pure white — nothing was grounded. 2.4 gave the soft dark pool
    // the references have at the base of every tree, rock and post. 3.6 is that
    // same pool re-levelled after the radius-scaled height gate in post.js
    // stopped counting terrain creases as occluders.
    // ROUND 6: 4.2 saturates the estimator inside a conifer stand — occ clamps
    // to 1.0 and the pool prints the raw aoTint, i.e. it stops being a soft
    // grounding pool and becomes a flat multiply on the darkest surfaces in the
    // frame. That is half of the 7x overshoot in the bottom luma bucket. 3.0
    // still fills the debug buffer's contact rings; it just no longer bottoms
    // out under every tree clump at once.
    aoIntensity: 3.0,
    // MEASURED off target_01: the meadow is not one value with objects on it,
    // it has broad darker ground THROUGH and BETWEEN the tree clumps — its
    // grass spread is 110 luma against our 86. At 8 m this term only deepened
    // what was already a cavity; at 15 m a stand of firs shades the ground
    // around it, which is the single biggest "painted, not rendered" cue left.
    aoWide: 18.0,
    // Warmed from [0.36, 0.48, 0.60]. That ratio put more blue than red into
    // every contact pool in the frame, and with the split-tone's cool fill
    // landing on the same pixels the two compounded: the conifers measured B:G
    // 0.61 and read visibly teal against the reference's warm green. Contact
    // occlusion is bounce being blocked, not sky being added; it should darken
    // and cool a little, not paint.
    //
    // ROUND 6, MEASURED PER LUMA BUCKET (tools/hl.mjs). The bottom of our frame
    // is both too full and the wrong colour:
    //
    //            ours                  target
    //   0.0-0.1  rgb(5,19,40)   6.7%   rgb(9,28,21)  0.9%
    //   0.1-0.2  rgb(17,43,47) 10.7%   rgb(23,45,25) 14.9%
    //
    // The reference's deep shade is GREEN — blue sits at 0.75 of green in the
    // bottom bucket and 0.56 in the next. Ours is BLUE-dominant at 2.1 and teal
    // at 1.09, and it carries a fifth of the reference's red. That is not one
    // knob, it is three multiplies stacked on the same pixels (this tint, the
    // shadowTint, the blue lift), but this one is the largest: 0.42/0.56 is a
    // 25% red deficit applied in linear at strength 0.88 x intensity 4.2, i.e.
    // it turns every green it touches teal before anything else gets a vote.
    //
    // Occlusion blocks the warm ground bounce and leaves the cool sky, so a
    // slight cool bias is right — but 'slight'. 0.50/0.56 is an 11% deficit,
    // and the whole tint is lifted because the bucket it governs was 7x too
    // populated.
    aoTint: [0.52, 0.555, 0.575],
    // GROUND-ONLY FACET SMOOTHING. See the essay in post.js. MEASURED: our
    // adjacent meadow facets differ by ~30/255 while the entire shadow map is
    // worth a p99 of 15/255 — the seam between two triangles of grass is the
    // strongest line in the frame. This softens that seam over ~7 output pixels
    // and touches nothing whose depth-derived normal is not near-horizontal.
    surface: 0.75,
    surfacePx: 10.0,
    // How steep a surface still counts as ground, as cos(slope). Started at
    // 0.80 (36 degrees) which is fine for a meadow and left every HILLSIDE
    // faceted — plainly visible in lake_bridge, whose left slope is the whole
    // left half of the frame. 0.55 is 57 degrees, which covers any terrain a
    // car could be near. Trees and boulders survive it because they are small:
    // the ring straddles their edges, and the cover^2 term in post.js falls off
    // hard. Checked by eye at 0.80 / 0.66 / 0.55 in both shots — the conifer
    // tiers are pixel-identical.
    groundSlope: 0.55,
    bloom: 0.10,
    bloomWide: 0.06,
    bloomThreshold: 0.88,
    // The reference is sharp corner to corner: only a whisper of far softening.
    dof: 0.20,
    // MEASURED: target_01's twelve row means run 79 / 113 / 77 top to bottom —
    // the edges sit at 70% of the peak. Ours ran 96 / 117 / 90, i.e. 77%.
    //
    // ROUND 6, MEASURED BOTH AXES (tools/rows.mjs, 12 rows x 8 columns). Rows
    // alone were the wrong test, because a row mean of this frame is mostly the
    // road and a row mean of the reference is mostly meadow. Columns:
    //
    //             col means                          edge/peak
    //   ours    73  85 120 138 130  85  82  63         0.49
    //   target  76  94  93 118 119 112  87  73         0.63
    //
    // Our left and right edges sit at half the peak against the reference's two
    // thirds — we overshot the falloff we were chasing. It matters more than a
    // ratio suggests: a vignette is a MULTIPLY, so it does its worst work on
    // the pixels that are already darkest, and in this frame those are the
    // conifer stands, which live at the left and right edges. Backing it off is
    // worth more of the crushed-blacks defect than any knob in the grade —
    // measured, the bottom luma decile falls 3.9% -> 2.8% off this alone, and
    // its colour lands on the reference's (sat 0.68 against 0.68).
    vignette: 0.285,
    ca: 0.0011,
    // Alpine is the meadow biome, so it is the one that most needs the field
    // broken up. Measured target spread 91 luma vs our flat 54 — see the essay
    // above MEADOW_NOISE in post.js.
    // ROUND 5, MEASURED. This is the knob the histogram actually wants. Raising
    // the contrast from 1.30 to 1.43 moved the frame's std where it should be
    // but left 30.5% of every pixel in one 0.1-wide luma bucket (the reference
    // spreads 21.5 / 22 / 17.5 across three). A contrast can only widen a
    // distribution that already has width; ours has a SPIKE, because a 15 m
    // terrain facet under a directional key is one value from edge to edge and
    // the meadow is made of them. Only variation in the scene can break that,
    // and this is the only source of it in the frame.
    // 0.55 read as BLUR, not broken light: a low-frequency noise field over a
    // faceted meadow makes soft grey blobs that the eye takes for defocus. The
    // reference's ground variation comes from real tree shadows. Swept
    // 0.55/0.25/0.0 and looked: 0 is clean, so keep a trace and no more.
    dapple: 0.12,
    // The reference's field is yellow-green where the sun lands and blue-green
    // in the hollows, and that warm/cool split across the meadow is most of why
    // it reads as painted rather than lit. 0.06 was almost invisible.
    dappleWarm: 0.10,
    // Eased off: this is a 1.6 m brush texture and the scatter it was standing
    // in for (flowers, tussocks) is coming back into the meadow this round.
    // ROUND 7, MEASURED (tools/facet_rp.mjs — mean luma step between two green
    // ground pixels 6 px apart, the statistic "the ground reads as flat facets"
    // is really about): the reference scores 20.74 and we score 7.70. Our meadow
    // is under-detailed by a factor of nearly three, and almost all of that gap
    // is CONTENT — the reference's local contrast is bushes, tufts, flowers and
    // their own small shadows. This octave can only add luminance variation, and
    // swept at the frequencies it now runs at (see post.js) 0.15/0.26/0.36 buys
    // 7.61/7.89/8.24. 0.26 is as far as it goes before it reads as noise instead
    // of as grass; the rest of that gap belongs to the scatter, not to post.
    dappleFine: 0.26,
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
    exposure: 1.01,
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
    exposure: 1.01,
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
