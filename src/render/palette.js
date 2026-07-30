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
//
// ROUND 12 — THE ACID SWARD, AND IT IS RAMP INDEX 3 AND 4.
//
// measure.mjs bins at 12 levels/channel, so a bin level L covers
// L*23.18 +/- 11.59. Read that way the two frames say something very precise:
//
//   ours    #172e17 8.6%  #747400 8.6%  #5d5d00 6.5%  #8b8b00 6.3%
//   target  #172e17 9.4%  #2e4617 7.1%  #8b8b17 4.3%  #465d17 4.0%
//
//   levels  ours   (1,2,1) (5,5,0) (4,4,0) (6,6,0)
//           target (1,2,1) (2,3,1) (6,6,1) (3,4,1)
//
// Two separate defects, not one:
//
//  a) BLUE LEVEL 0 vs LEVEL 1. Our #8b8b00 and the target's #8b8b17 have the
//     IDENTICAL red and green levels. The only difference between the target's
//     brightest grass bin and our acid bin is 12-35 of blue against our 0-12.
//     That is 21% of our frame sitting one bin below the target in one channel,
//     and it is also the whole of the frame-mean blue deficit (33 vs 44).
//  b) OUR MIDS ARE TOO WARM. The target's mid greens are (2,3,1) and (3,4,1) —
//     green a full level ahead of red, R/G 0.66-0.75 — and it has 11.1% of the
//     frame in them. We have essentially none: ours are (4,4,0) and (5,5,0),
//     R equal to G. Frame mean red 99 against the target's 91 is the same fact.
//
// ALPINE_STOPS is [-26,-6,12,38,78,150] and alpine's height() starts at 28 and
// climbs, so the drivable meadow sits between stops 38 and 78 — indices 3 and
// 4 — and NOT index 2 as round 7 assumed. Those two swatches were (152,154,39)
// and (182,186,45): R/G 0.99 and B/G 0.25. R equal to G at B/G 0.25 IS
// #747400. Round 7's warm rotation is what put them there, and it overshot.
//
// The grade's `saturation: 1.68` is an affine mix toward luma, so it reaches
// zero blue whenever b < 0.405 * luma. Solving it backwards for the target's
// own #8b8b17 (out 0.545/0.545/0.09) needs an arriving b/g of 0.48, so albedo
// B/G in the sunlit sward has to be ~0.39-0.42, not 0.25 — the grade eats
// roughly half of it and everything under half of that lands in bin level 0.
//
// ...AND A UNIFORM COOL OF THE WHOLE MEADOW IS THE WRONG INSTRUMENT. Measured
// per LUMA DECILE on the grass population only (G strictly the max channel),
// which is the statistic that isolates the acid — r11 against the reference:
//
//     decile   ours (r11)      reference     grass sat ours / ref
//      0.1     25, 48, 21     25, 50, 23        0.56 / 0.54
//      0.2     51, 73, 22     50, 71, 21        0.70 / 0.70
//      0.3     79, 99, 17     82,100, 16        0.83 / 0.84
//      0.4    114,123,  8    112,126, 12        0.94 / 0.91
//      0.5    144,151,  6    138,149, 14        0.96 / 0.91
//      0.6    172,177,  5    161,172, 26        0.97 / 0.85
//      0.7    193,195,  6    187,194, 86        0.97 / 0.56
//
// The bottom four deciles were ALREADY on the reference to within a value or
// two, and frame-wide the grass measured R/G 0.819 against its 0.820 and
// B/G 0.170 against its 0.173. The meadow's hue was not the defect.
//
// The defect is the TOP THREE DECILES, and it is one number: the reference's
// grass saturation peaks at 0.91 near decile 0.45 and then FALLS AWAY, to 0.85
// and then to 0.56, as blue climbs 12 -> 26 -> 86. Ours climbs to 0.97 and stays
// there with blue pinned at 5. A sunlit highlight in the reference is a pale,
// half-desaturated yellow-green; ours is neon. And ours puts 2.3% of the frame
// in decile 0.6 against the reference's 0.5% — five times too much of the
// worst-behaved value in the picture.
//
// So: keep the reference's own R/G (0.89-0.94 through its sunlit deciles, which
// is very nearly R = G — the acid was never an excess of red), take a MODERATE
// amount of blue rather than the large amount the first pass added (that cost
// 0.062 of frame saturation and bought two bins), and bring the TOP of the ramp
// down in value so the decile-0.6 mass lands in 0.5 where the reference keeps
// it. The chroma roll-off at the lit end lives in biomes.js — see the essay at
// the t > 0 offsetHSL, which used to push chroma UP with value.
//
//   index      0     1     2     3     4     5
//   R/G was  0.64  0.80  0.98  0.99  0.98  0.97
//   R/G now  0.55  0.74  0.86  0.93  0.93  0.93
//   B/G was  0.41  0.30  0.23  0.25  0.24  0.29
//   B/G now  0.52  0.36  0.27  0.31  0.33  0.36
//
// Green falls only at indices 4 and 5, and only far enough to move the highlight
// mass down one decile; the frame mean luma is already on the reference.
// Index 3 up 5% in value (cycle 8): normalised against each frame's own grass,
// decile 0.4 is the reference's mode at 24.3% and ours sat at 23.4% while decile
// 0.3 held 26.4% against its 20.3%. Index 3 is the swatch decile 0.4 is made of,
// and raising it is the mean-neutral half of the pair with patchB below.
// Cycle 10, the last trim. Grass measured R/G 0.795 against the reference's
// 0.820 and B/G 0.205 against its 0.173 — 3% too green and 18% too blue, all of
// it in deciles 0.2-0.4 (its 0.3 grass is 82,100,16 and ours was 76,101,21). So
// indices 1-3 take +4 of red and -4 of blue. Index 0 is untouched: decile 0.1
// already lands on the reference at (26,49,23) against its (25,50,23), and it is
// the single largest bin in either frame.
// ...and the blue goes back at indices 2 and 3 only. The -4 there dropped the
// modal blue of the sunlit sward under 12, which is measure.mjs's level-0
// boundary, and printed #747400 and #5d5d00 again — the exact two bins the brief
// names. Red is what fixes R/G; the blue cut was collateral and only index 1
// needed it.
// CYCLE 3 — THE RAMP IS THE ACID, AND IT REACHES THE FRAME BY TWO DOORS.
//
// Every round since r06 has hunted the acid in the meadow VALUE FIELD in
// biomes.js — patchA/patchB, the bias, the lobe exponents — and every round has
// reported that its measured moves were tiny. Cycle 2 of this round measured why.
// props.js `derivePalette` builds the 259k-instance detail blanket like this:
//
//     grass:    [ ground[2].lerp(ground[1], 0.55), ground[2].lerp(ground[3], 0.50) ]
//     grassLit:   ground[3].lerp(ground[4], 0.34)
//     meadow:     shade(ground[1], -0.05, 0.07)
//
// `ground` IS this array. So the tussocks, blades, drifts and verge cover — a
// quarter of the meadow's pixels — take their colour STRAIGHT off these rungs and
// never see colorAt, the value field, patchA or patchB at all. Measured: cycle 2
// replaced the shade lerp with a saturating knee that pulls half the meadow mesh
// onto patchB, and the rendered grass mean went the WRONG WAY, (82,97,22) ->
// (84,100,25). The field only paints the mesh; the blanket on top of it is
// painted from here. That is the whole reason this defect has survived seven
// rounds of work in the other file.
//
// AND THE DEFECT IN THE RUNGS IS BLUE, WHICH IS A CONSTANT AND NOT A FRACTION.
// The reference's dominant green ladder, straight out of measure.mjs's own bins:
//
//     (23,46,23)  (46,70,23)  (70,93,23)  (139,139,23)
//     R/G  0.50        0.66        0.75         1.00
//     B/G  0.50        0.33        0.25         0.17
//
// Blue does not move — 23 at every rung — while green triples. Ours ran
// 23, 23, 30, 50, 58, 58: blue CLIMBING with value, B/G 0.31-0.36 at the top
// against the reference's 0.17, i.e. rather more than double its blue in the
// brightest greens. An earlier round wrote this exact essay and later rounds
// undid it a few values at a time while chasing single bins.
//
// One move, three measured deficits. Per-pixel saturation is (max-min)/max, so in
// a yellow-green the BLUE channel is the min and it alone sets the saturation:
// frame mean blue 57 against the reference's 44, frame saturation 0.716 against
// its 0.756, and frame mean red 96 against its 91 are not three problems. Holding
// blue at 23-29 across the ramp and putting the middle rungs on the reference's
// own R/G ladder (index 1: 0.80 -> 0.69, index 2: 0.91 -> 0.78) fixes all three,
// and it fixes them in the detail blanket at the same time without touching
// props.js — same instances, same density, corrected colour source.
//
// The top two rungs also come down in value (index 3 luma 0.588 -> 0.505, index 4
// 0.651 -> 0.570) because that is where the bright acid population lives. The
// colours our BRIGHT deciles render at are supplied by patchA, not by these rungs
// (solve the grade backwards from decile-0.6 grass and the arriving colour is
// patchA to within a value), so lowering the rungs thins the bright population
// without moving the colours that already match the reference decile for decile.
// CYCLE 4 — the blue fix held, the VALUE cut overshot. Measured after cycle 3:
//
//   dominant bins  ours #172e17 5.5  #5d7417 4.9  #2e4617 4.8  #465d17 4.7
//                  ref  #172e17 9.4  #2e4617 7.1  #8b8b17 4.3  #465d17 4.0
//
// Three of the reference's four top bins are now ours and both acid bins
// (#747417, #8b8b17) have left the top five, so the hue and channel-balance half
// of the brief is done and these rungs keep their blue. But the frame went from
// 0.019 too BRIGHT to 0.009 too dark and the mid-brights emptied out:
//
//   bucket        1     2     3     4     5     6
//   grass ours   9.3  15.1  17.2  13.0   4.7   0.2
//   grass ref   13.4  11.4  10.2  12.4   7.7   0.5
//
// Six points of grass piled into buckets 2-3 and bucket 5 fell to 4.7 against
// 7.7. So indices 3 and 4 go back about 55% of the way up in VALUE — luma 0.505
// -> 0.552 and 0.570 -> 0.613 — with blue left at 28-30. Value and blue were
// always separable here; cycle 3 moved both and only one of them wanted moving.
//
// Index 2 also gains back red. The reference's R/G ladder is a function of VALUE
// (0.66 at green 70, 0.75 at green 93, 1.00 at green 139), and index 2 sits at
// green 110 — so interpolating its own ladder it wants R/G ~0.84, not the 0.78
// cycle 3 gave it. Rendered grass came back R/G 0.758 against the reference's
// 0.806, which is that error: reading the ladder as a set of fixed numbers rather
// than as a function of value is what over-cooled the mids.
// CYCLE 6 — INDEX 1 IS THE DARK SPECKLE, AND IT IS SITTING ONE BUCKET TOO HIGH.
// props.js derives the blanket's dark cover from this rung specifically:
//   grass[0] = ground[2].lerp(ground[1], 0.55)   — 55% of the way onto index 1
//   meadow   = shade(ground[1], -0.05, 0.07)
// so index 1's value is where the reference's near-black turf speckle has to come
// from. It sat at (48,70,24), luma 0.226 — bucket 2 — while the remaining grass
// error is bucket 1 short by 4.6 points and bucket 2 OVER by 2.2. Taking it to
// luma 0.192 moves that speckle across the boundary it was sitting on the wrong
// side of. Held above luma 0.17 on purpose: bucket 0 is already 2.1 points over
// the reference and the AO and grade lift (post.js, grade.js — outside this file)
// multiply this rung down further wherever a tuft sits in contact shade.
const ALPINE_RAMP = [0x182c17, 0x263717, 0x5c6e1a, 0x92981c, 0xa2a81e, 0x929824];
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
      // CYCLE 1: was (23,46,28) — blue FIVE AHEAD of red, which is the teal the
      // round-7 essay below drove out and which has crept back. The reference's
      // shade grass (its decile 0.2, and 24% of all its grass) is (21,45,23):
      // red and blue EQUAL. Blue only comes off, red stays: at this value the
      // reference is not redder than us, it is less blue.
      lowland: 0x172e18,     // damp draws and tarn shores — bluest green here
      // CYCLE 6: ITS BLUE IS THE FRAME'S MISSING SATURATION. B/G was 0.46 — by
      // far the bluest thing in the meadow — against the reference's 0.17 in
      // bright grass, and the note below defends that with a backsolve through the
      // grade's `saturation: 1.68`. The backsolve is real but it was fitted to ONE
      // decile; applied to the whole lit lobe it costs more than it buys. Proof
      // from cycle 5: the middle-evacuation exponent, which only moves pixels
      // further ONTO patchA and patchB, dropped frame saturation 0.739 -> 0.728 and
      // raised grass blue 20 -> 22 without touching a single colour. A knob that
      // makes saturation worse by using more of a swatch is a knob pointing at that
      // swatch.
      //
      // CYCLE 7: AND 48 WAS TOO FAR — IT PUT THE ZERO-BLUE BINS BACK. At blue 48
      // frame saturation OVERSHOT to 0.763 against the reference's 0.756 and the
      // dominant table printed #5d7400 5.7%, #748b00 4.9%, #747400 4.8%: three
      // bins at blue level 0, which is the brief's headline defect and the one
      // failure mode it explicitly says not to recreate. A zero channel forces
      // per-pixel saturation to 1.0 regardless of the other two, so it BUYS the
      // saturation number by breaking the thing the number is a proxy for.
      // Grass blue measured 22 at B=72, 16 at B=48 against the reference's 18, and
      // saturation 0.728 / 0.763 against its 0.756 — so 58 is where both land, and
      // it is chosen off the blue channel rather than off the saturation because
      // saturation is exactly the statistic a zero channel can counterfeit.
      //
      // CYCLE 8: 58 STILL COUNTERFEITS IT — 68, AND THE EVIDENCE IS THE BLUE
      // HISTOGRAM, NOT THE BINS. Green pixels at luma 0.25-0.55, blue in twelves:
      //
      //     blue    ours (B=58)            reference
      //     0-12     59.4%  (104,117, 4)    38.4%  (109,123, 5)
      //     12-24    20.2%  ( 86,103,16)    45.6%  ( 91,108,17)  <- its MODE
      //
      // Our mode is in the bin the reference's ISN'T, and frame-wide 29.3% of our
      // green pixels carry blue under 12 against its 13.3%. Per luma decile the
      // reason is exact: deciles 0.4 and 0.5 already match the reference's blue to
      // the value (16 and 12), and the whole error is deciles 0.6-0.7, where the
      // reference runs blue 15 and 25 and we ran 11 and 9. The reference's grass
      // saturation FALLS at the top — 0.90 -> 0.86 — where ours climbed 0.91 ->
      // 0.95. Its brightest sward is a pale half-desaturated yellow-green; a lit
      // highlight is the one place a meadow loses chroma, and patchA is the swatch
      // that lit lobe is made of. Blue 68 with the chroma roll-off in biomes.js
      // taken from 0.14 to 0.22 puts both back.
      patchA: 0x8f9c44,      // sun-bleached alp grass, and the swatch the top
                             // three luma deciles are made of. R/G 0.91 (the
                             // reference's own sunlit grass runs 0.89-0.94), and
                             // B/G 0.46 — by far the bluest swatch in the ramp,
                             // because this is the ONE place the reference
                             // desaturates: solve the grade's saturation 1.68
                             // backwards from its decile-0.6 grass (161,172,26)
                             // and the arriving colour needs B/G 0.48.
                             //
                             // AND ITS VALUE IS THE ACID TAIL. This swatch
                             // arrives at unity gain, so its own luma (0.673)
                             // IS the top of the meadow: 4% of the frame landed
                             // brighter than luma 0.6 against the reference's
                             // 0.5%, and the reference's grass stops dead at
                             // 0.6. Scaled to luma 0.60 so the lit lobe tops out
                             // in decile 0.5, where the reference keeps its own
                             // brightest sward (138,149,14). Swept 0.673 / 0.60 /
                             // 0.575 in luma -> grass brighter than 0.6 lands at
                             // 3.7% / 2.8% / 1.3% of the frame against the
                             // reference's 0.5%, and frame luma bucket 6 at
                             // 7.0 / 6.1 / 5.3 against its 5.0. One notch further
                             // to luma 0.545 for the last of it: this population
                             // is the yellow film over the lit half of the frame
                             // and it is the last thing in the meadow that still
                             // reads as acid rather than as sun.
      // ...and its VALUE is set by luma bucket 0, which held 1.7% of the frame
      // against the reference's 0.9% at (12,25,12) vs its (9,28,21). The
      // reference's floor is not darker than ours, it is GREENER and there is
      // half as much of it. Lifting it from (26,44,26) to (30,49,32) moved bucket
      // 0 by 0.0 points, so the near-black is not this swatch at all — it is the
      // AO tint stacked with the grade's lift, exactly as the essay under
      // `ambientIntensity` says, and both live outside this file.
      //
      // So it goes the other way instead, to (22,40,26), because the GRASS
      // distribution wants it. Normalised against each frame's own grass, the
      // reference puts 17.1% of its grass in luma decile 0.1 and 20.3% in decile
      // 0.3; ours had 13.2% and 26.4%. It is short of genuinely deep shade and
      // long on mid-dark, which is the shade lobe of the meadow field not
      // reaching far enough down. Deepening this swatch is what extends it.
      // CYCLE 1: AND IT WENT ONE STOP TOO FAR DOWN. Populations again, points of
      // frame per bucket, GRASS only:
      //
      //   bucket    0     1     2     3     4     5
      //   ours     2.8   8.3  11.8  14.1  14.9   8.1
      //   ref      0.8  13.4  11.4  10.2  12.4   7.7
      //
      // The reference's grass has a HARD FLOOR at bucket 1 and piles 13.4 points
      // of the frame into it. Ours spills 2.8 points out of the bottom into
      // bucket 0 and only manages 8.3 in bucket 1 — the shade lobe is falling
      // THROUGH the bucket the reference lives in. Both halves of the brief's
      // "bucket 1 toward 15%, bucket 0 toward 0.9%" are this one fact.
      //
      // (26,44,26) -> (22,40,26) was the wrong direction. This swatch is the
      // value the shade lobe lands ON, so it has to sit inside bucket 1, not on
      // its lower edge: luma 0.138 puts every pixel the AO or a cast shadow then
      // multiplies down into bucket 0. The reference's own shade grass is
      // (21,45,23) at luma 0.150 — and it is GREENER than ours, not darker, with
      // red and blue equal. Same move as `lowland` above: +5 green, -3 blue.
      patchB: 0x162d17,      // shaded heath / bilberry. Was (28,37,22), G/R only
                             // 1.32 — a near-neutral dark, which is why our
                             // luma bucket 0 held 1.7% against the reference's
                             // 0.9%. The reference's darkest bin is (23,46,23):
                             // RED EQUALS BLUE and green is double both. A deep
                             // GREEN, not a dark grey-green.
      scree: 0x9f9d90,       // pale limestone — cliff faces ONLY, never meadow
      cliff: 0x6a6055,       // warm grey rock (ref boulders read #605753)
      soil: 0x8a6236,
      sand: 0xd7c48a,
      summit: 0xf2f7ff,      // unreachable: alpine tops out ~170 m now
      // ROUND 12: THE ACID IS A TAIL, AND THE FACET GAIN IS WHAT GROWS IT.
      //
      // Grass pixels per luma decile, as a share of each frame's own grass so
      // the different grass coverage (63.6% ours, 49.8% the reference's) cannot
      // hide inside the numbers:
      //
      //     decile   0.1   0.2   0.3   0.4   0.5   0.6
      //     ours    13.2  22.8  25.3  20.9  11.5   5.8
      //     target  17.1  22.5  20.3  24.3  14.9   1.0
      //
      // The reference's grass PEAKS at decile 0.4 and then stops dead: 1% of it
      // is brighter than luma 0.6 and none of it is brighter than 0.7. Ours
      // peaks a decile lower and then carries 5.8% out past 0.6 — 4% of the
      // whole frame in grass brighter than anything the reference allows, and
      // that tail is precisely the highlighter-green patches. Our colours now
      // match the reference decile for decile (its 0.6 grass is 161,172,26 and
      // ours is 166,177,28); we simply have seven times too many of them.
      //
      // AND IT IS NOT THIS KNOB — TESTED AND REVERTED. 0.60 -> 0.44 with grain
      // 0.34 -> 0.27 moved the decile-0.6 grass share by 0.0 points and the
      // frame mean luma by 0.000. The reason is in terrain.js: the push is
      // `asp = nx*sx + nz*sz`, the HORIZONTAL part of the face normal, and a 6 m
      // facet on a meadow that rolls +/-20 m over 190 m tilts about six degrees,
      // so |asp| never exceeds ~0.11 out there. The gain is a cliff-and-bank
      // instrument; on the flat it does almost nothing and cannot be the tail.
      //
      // Solving the grade's saturation backwards from our own decile-0.6 grass
      // (167,177,29) gives an arriving colour of (166,172,84) — which is patchA,
      // to within a value, at unity gain. The bright tail is not a facet, not
      // the light and not the grade: it is patchA's own VALUE, reached wherever
      // the lit lobe of the meadow field saturates. So patchA comes down and the
      // lobe shape changes; these two stay where they were.
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
    // ROUND 12: THE FIRS ARE HALF THE ACID PROBLEM, and the only way to see it
    // is to histogram BLUE inside the mid-luma green band rather than to look at
    // means. Grass-and-foliage pixels at luma 0.25-0.55, blue in bins of 12,
    // with the mean colour of each bin:
    //
    //     blue    ours                  reference
    //     0-12     94,110,  6  42.7%    109,123,  5  38.3%
    //     12-24    92,109, 16  26.7%     91,108, 17  45.6%   <- the reference's mode
    //     24-36    73,101, 30  10.0%     85,104, 27  13.9%
    //     36-48    53, 98, 41  15.3%    102,114, 40   1.3%   <- ours, and nothing else has it
    //
    // The reference's distribution is tight: 84% of it in blue 0-24, with the
    // mode at 12-24. Ours has a SECOND MODE at 36-48 holding 15.3% of the band,
    // and its mean colour is (53,98,41) — R/G 0.54, a dark blue-green. That is
    // not grass at any value; it is a lit fir face. These four swatches ran
    // B/G 0.60-0.69, i.e. blue well AHEAD of red, which is a spruce, and 15% of
    // the frame arriving at B/G 0.42 is where the missing frame saturation went
    // (0.699 against the reference's 0.756) and why the reference's own dominant
    // bin only holds 27% of our band against 46% of its.
    //
    // The bin the reference's mode sits in, (91,108,17), and the bin ours sits in
    // are otherwise the SAME COLOUR to within a value — so this is purely blue.
    // B/G comes to 0.40, which puts the lit faces at a rendered 0.26 (the
    // reference's own 24-36 bin) instead of 0.42. Hue lands at 118-124: still
    // the deep, faintly cool green the essay above asks for, and still nowhere
    // near the hue 150 that reads as teal — but with red and blue now within a
    // few values of each other, which is what the reference's darkest bin
    // (23,46,23) actually is.
    foliage: [0x25431b, 0x2e5321, 0x1e3616, 0x355f26],
    trunk: 0x6b4a30,
    // MEASURED: inside luma deciles 0.3-0.5 we put 8.9% of the frame in pixels
    // of saturation under 0.55 — mean colours (113,108,95) and (135,119,78),
    // i.e. pale pinkish stone — against the reference's 2.7%. Most of that gap
    // is boulder and cobble COUNT, which lives in props.js, but the colour makes
    // it worse than it needs to be: with the grade running a 1.05 red gain a
    // warm neutral prints mauve, which is exactly how our boulders read.
    // ...but -9 of red overshot and printed the boulders COOL grey against the
    // reference's warm tan-grey (its boulders read ~#8a7f72, R-B = 24). The
    // mauve was never the warmth, it was the warmth at too high a value: -3 of
    // red and -4 of value keeps the tan and drops the pink.
    rock: 0x7a7164,
    rockShadow: 0x474540,
    water: 0x1179bd,
    waterDeep: 0x0a4f8c,
    waterFoam: 0xeaf7ff,
    // ROAD. CYCLE 1: THE BUCKET-6 EXCESS IS THIS SURFACE, NOT THE MEADOW.
    //
    // Seven rounds have read luma bucket 6 (0.6-0.7) as "bright acid grass" and
    // gone looking for it in the ramp. Split the frame into populations by
    // rendered colour (sky/road/grass/rock) and report each one's contribution
    // to each bucket in POINTS OF THE FRAME, and it is not the grass at all:
    //
    //   bucket 6 =  11.7% ours / 4.9% reference
    //     of which  road  10.3 ours / 4.4 ref     <- the whole 6.8-point error
    //               grass  1.3 ours / 0.5 ref
    //
    // The note this replaces sampled the reference road "at two points" and got
    // rgb(203,160,73) and rgb(184,141,74), and concluded the level was nearly
    // right. Those are its two SUNLIT points. The reference road's POPULATION
    // mean is rgb(151,124,47) — ours is rgb(185,138,68) — because a third of its
    // road is in tree and bank shadow. Sampling lit patches and calling the
    // result the surface is the exact trap the brief warns about.
    //
    // And the distribution matters as much as the level. Points of frame per
    // bucket, road only:
    //
    //   bucket    1    2    3    4    5    6    7
    //   ours     0.1  0.4  1.0  3.3  6.6 10.3  0.0
    //   ref      0.6  2.5  4.3  8.4  9.6  4.4  1.3
    //
    // Ours is a spike at the top of the range; the reference's runs all the way
    // down into bucket 1.
    //
    // BUT THIS KNOB CANNOT FIX IT, MEASURED AND REVERTED. Cutting these two
    // swatches by 18% (0xb38a46 -> 0x9c7d3a) moved the rendered road population
    // mean by ONE VALUE, from rgb(185,138,68) to rgb(184,137,67), and every luma
    // bucket by 0.1 or less. The reason is in roads.js `surfaceColour`:
    //
    //     case 'dirt': return pale(c.lerp(ochre, 0.94).multiplyScalar(0.93));
    //
    // where `ochre` is a hardcoded 0xc9a45f. Alpine's road is a dirt road, so
    // `palette.road` is lerped 94% of the way OUT of the picture and contributes
    // about 6% of the surface colour; the `pale()` helper above it then applies
    // its own measured g*1.12 and b*1.34. The road's level lives in roads.js, not
    // here, and 5.9 of the frame's 6.8-point bucket-6 error is behind that door.
    // Left at the authored value so the diff does not imply a fix that is not one.
    //
    // AND IT IS ALSO THE WHOLE OF THE RESIDUAL SATURATION GAP. Frame mean
    // saturation is a share-weighted sum, so it decomposes exactly. Each
    // population's contribution (share x its own mean saturation), ours against
    // the reference, at the end of this round:
    //
    //     sky/water   0.133   0.102   +0.031
    //     road        0.124   0.215   -0.091
    //     grass       0.463   0.439   +0.024
    //     rock        0.003   0.002   +0.001
    //     TOTAL       0.724   0.759   -0.035
    //
    // The meadow is now CONTRIBUTING MORE than the reference's meadow does. The
    // deficit is one population: the reference's road is 31.2% of its frame at
    // saturation 0.69, ours is 20.4% at 0.61. Both numbers — the width and the
    // chroma — are set in roads.js. No further move in this file can close it, and
    // any attempt to close it from the meadow would have to over-saturate the grass
    // past the reference to pay for another surface's shortfall.
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
