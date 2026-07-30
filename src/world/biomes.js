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

// ALPINE. The route loop that roads.js lays down lives at radius 350-700 m from
// the origin (its base polar radius is 0.3 * biome.size), so EVERY altitude a
// driver can reach has to be a green. Measured on the old field, the hero shot
// put the car at h = 85 m inside terrain that ran to 288 m — deep into the snow
// cap — which is where the white blow-out in the frame came from. The landform
// below now tops out at ~170 m and does so only outside r = 700 m, so these
// stops cover the whole world and the last two are rim-hill greens, not snow.
// CYCLE 9 — WHICH RUNGS THE VISIBLE MEADOW ACTUALLY SITS ON.
//
// The last error in the grass is bucket 1 short by 5.4 points and bucket 3 over by
// 4.1, and eight cycles have established which levers can move a number that size:
// the ramp can, the value field cannot (bias, lobe knee and the middle-evacuation
// exponent each moved the render by under a point, because a quarter of the
// meadow's pixels are detail instances that never see the field — see the ramp
// essay in palette.js). The stops are the third lever and they had not been tried.
//
// Alpine's basin runs roughly 12-60 m where the camera can see it. Against
// [-26,-6,12,38,78,150] that band lands on indices 2-4, whose luma is 0.389,
// 0.556 and 0.613 — every rung the visible meadow is made of sits in bucket 3 or
// above, and there is no dark rung anywhere in the altitudes a driver occupies.
// That is the structural reason the meadow cannot reach the reference's bucket-1
// pile no matter how the value field is tuned: the field can only lerp away from
// whatever the ramp already handed it, and it was handing it bucket 3.
//
// TRIED AND REVERTED, MEASURED. Shifting the lower stops up 10-14 m
// ([-26,0,22,52,92,160]) slid the meadow one rung down as intended and it is a net
// regression: bucket 1 gained only 0.7 points (9.6 -> 10.3 against the reference's
// 15.0) while bucket 2 went 2.4 points further OVER, bucket 5 drained 13.7 -> 11.3
// against its 17.5, frame luma overshot to 0.010 BELOW the reference and frame
// saturation fell 0.727 -> 0.708.
//
// The reason is a fact about the ramp that is easy to miss: the DARK rungs are the
// BLUE-RICH ones, correctly so — the reference's own dark green is (23,46,23) at
// B/G 0.50 against 0.17 in its brightest sward. So sliding the meadow onto them
// adds blue and costs chroma, and rendered grass blue went 16 -> 25. The bucket-1
// pile cannot be bought by moving the meadow down the ramp; the reference's own
// bucket-1 bin has saturation 0.50 and it reaches a 0.756 frame mean anyway,
// because that mean is carried by its ROAD (31.2% of frame at saturation 0.69
// against our 20.2% at 0.61 — the whole of our residual deficit, see below).
const ALPINE_STOPS = [-26, -6, 12, 38, 78, 150];
const AUTUMN_STOPS = [-34, -14, 3, 20, 40, 68];
const DESERT_STOPS = [8, 21, 31, 50, 78, 108];
const COAST_STOPS = [-6, 3, 18, 44, 78, 110];
const WINTER_STOPS = [-16, -6, 4, 17, 80, 190];

export const BIOMES = {
  // =========================================================================
  // 1. ALPINE — a rolling green meadow basin with a valley threaded through it.
  //
  // v2 built alpine as a narrow glacial corridor with a 190 m alp and 215 m
  // spines beyond it. The trouble is that roads.js lays its loop at r = 350-700
  // m, which put the drive halfway up the alp: measured, the hero shot had the
  // car at 85 m in terrain running 30-288 m, so most of the frame was above the
  // 110 m snow line. That is where the white blow-out came from — it was never
  // a post-processing artefact, it was a snowfield.
  //
  // The reference frame has no mountains at all: it is edge-to-edge meadow with
  // a lake, a road and trees. So the grammar is now a BASIN. Long swells and a
  // shallow meander give the drivable band real relief (banks, saddles, crests,
  // a bowl for the lake) inside 0-60 m, and the only high ground is a ring of
  // green hills starting at r = 720 m — beyond the route, and 60 m short of any
  // altitude that could go white.
  // =========================================================================
  alpine: {
    id: 'alpine',
    palette: 'alpine',
    label: 'Alpine Meadows',
    waterLevel: -8.0,
    size: 1700,
    // 248, up from 196. At 196 the far half of the meadow resolved into six or
    // seven triangles the size of a car park, and one of them catching the sun
    // is a flat slab of the brightest grass in the palette with no internal
    // variation at all — which is most of what "acid patch" actually looks like
    // once the hue is right. Measured A/B at the same palette: 196 put 21% of
    // its green pixels in the 0.42-0.56 luma tier as one or two huge faces, 248
    // puts 15% spread over many, and frame mean luma landed on the reference's
    // 0.379 exactly instead of 0.005 over.
    segments: 248,
    lodBias: 0.66,
    meshJitter: 0.36,
    treeDensity: 1.0,
    rockDensity: 0.7,
    // The drivable band rolls +/-20 m over 190 m: crests throw 18 m shadows,
    // not 500 m ones. See terrain.js for why this is a per-biome opt-in.
    terrainShadow: true,

    height(x, z, seed) {
      const s = seed + 5;

      // LAKE BOWLS come FIRST, because the bowl has to mute every other band
      // inside itself. Subtracting a cone from a noisy meadow gives a funnel
      // with a ragged rim; damping the meadow by the bowl mask and then dropping
      // the floor gives a flat bed, a clean shoreline and a bank you can see the
      // water cut into. The previous version dug 44 m out of a field that was
      // already 28-72 m up, so the whole 1700 m map came out with 0% water and
      // there was nothing for a bridge to cross.
      //
      // Held off the spawn: `corridor` guarantees the origin is on the valley
      // axis, and the car must not start in a lake.
      const bowlRaw = bumps(x, z, 520, s + 55, { chance: 0.42, radius: 0.34 })
        * smoothstep(70, 230, Math.hypot(x, z));
      const bowl = Math.pow(smoothstep(0.0, 0.58, bowlRaw), 0.85);
      const dry = 1 - bowl;

      // LANDFORM — long pasture swells, 480 m across and ±22 m. Warped so the
      // level sets meander instead of reading as circular blobs. This is the
      // band you feel as "the ground rises away toward those trees".
      const [wx, wz] = warped(x, z, s, 150, 0.0012);
      let h = 28 + fbm(wx * 0.0021, wz * 0.0021, { octaves: 2, seed: s + 61 }) * 22 * (0.15 + dry * 0.85);

      // A shallow meandering valley cut through the swells: a 280 m floor, then
      // shoulders that gain 22 m over the next 300 m (a 7% bank you can lean a
      // car on, not a wall). Plus a cross-cutting saddle every ~1800 m along it
      // so the valley is a sequence of rooms rather than one endless trench.
      const { u, v } = corridor(x, z, s, { dir: 0.46, amp: 300, wave: 1750 });
      const av = Math.abs(v);
      const bank = smoothstep(140, 440, av);
      h += bank * 22 * dry;
      h += Math.sin(u * 0.0035 + 1.1) * 7.0 * (1 - bank) * dry;

      // DRIVABLE — crests to launch off and hollows to dive through, 190 m and
      // 80 m across. This is the band the camera actually sees beside the car.
      h += fbm(x * 0.0054, z * 0.0054, { octaves: 2, seed: s + 11 }) * 11.0 * (0.2 + dry * 0.8);
      h += fbm(x * 0.0128, z * 0.0128, { octaves: 2, seed: s + 23 }) * 4.6 * (0.2 + dry * 0.8);

      // ...and now the water goes in. Floor at 28 - 58 = -30 against a -8 water
      // plane: a 22 m lake with a shoreline the road has to find a neck through,
      // which is what puts a bridge in the frame.
      h -= bowl * 58;

      // RIM — green hills closing the distance. They begin outside the route
      // loop and top out near 170 m: high enough to read as alp, far too low to
      // reach the ramp's pale end, and there is no snow term at all any more.
      const rim = smoothstep(720, 1120, Math.hypot(x, z));
      h += Math.pow(rim, 1.35) * 105;
      h += spines(x, z, 0.0026, s + 7, 2.0) * 115 * rim;

      // TOOTH — hummocks, not dither. The facets are ~6 m across, so a band at
      // 44 m / 4.2 m tilts a CLUSTER of them a coherent 10-12 deg and the next
      // cluster the other way: that is what turns flat shading into visible
      // planes catching the light. At 2.2 m the planes differed by three degrees
      // and the whole meadow resolved into one wash.
      // ROUND 12 — THE TOOTH HAS DRIFTED AWAY FROM ITS OWN DOCUMENTATION, AND
      // FIXING IT HERE COSTS MORE THAN IT BUYS. The essay above says "a band at
      // 44 m / 4.2 m", which tilts a cluster of 5 m facets a coherent 10-12
      // degrees. What is actually here is 70 m / 2.6 m: a 7% grade, so 4 degrees,
      // and 4 degrees is under the threshold where flat shading separates two
      // triangles at all. Measured in the lake_bridge and wildlife presets, that
      // is why the meadow beside a close camera comes back as ONE FLAT SLAB of
      // the brightest green in the ramp — which is what an acid patch actually
      // looks like once the hue is right, exactly as the note at `segments` says,
      // and it is the largest remaining defect in this biome's read.
      //
      // BOTH WAYS OF FIXING IT WERE TRIED AND BOTH WERE REVERTED, because every
      // term in height() moves the car:
      //
      //   57 m / 4.2 m   hero luma bucket 4 fell 22.6% -> 17.5% (reference 22.0)
      //   49 m / 2.6 m   hero mean luma fell 0.372 -> 0.319 and the frame filled
      //                  with lake (#0046a2 at 7.4% of it)
      //
      // Neither is a colour regression: the shot presets drive the car for a
      // fixed time, so a metre of height anywhere on the route changes where the
      // car ends up and therefore what the camera frames. A 2 m change to the
      // tooth relocated the hero shot to a different part of the map. The tooth
      // needs to be raised, but it has to be done together with whoever owns the
      // shot presets and the camera, not blind from here, so it stays as it is.
      const k = (1 - rim * 0.5) * (0.25 + dry * 0.75);
      h += fbm(x * 0.0142, z * 0.0142, { octaves: 2, seed: s + 91 }) * 2.6 * k;
      h += fbm(x * 0.030, z * 0.030, { octaves: 1, seed: s + 93 }) * 0.8 * k;
      return h;
    },

    colorAt(c, K, h, slope, x, z, seed) {
      rampAt(c, K.ramp, h, ALPINE_STOPS);

      // MEADOW VALUE FIELD — the single biggest fix of this round.
      //
      // Measured, our luma histogram was a spike: 57% of the frame sat in two
      // adjacent buckets while the reference spreads evenly across five, and
      // our green pixels ran L 0.17-0.45 against the reference's 0.12-0.55.
      // The old code tried to fix that with an offsetHSL of +/-0.022 lightness,
      // which is nothing — a rounding error on a value of 0.35.
      //
      // So value variation is no longer a tint on top of the ramp; it is a LERP
      // ACROSS THE WHOLE GROUND RANGE, from the deep blue-green heath in the
      // hollows (L 0.20) to sun-bleached alp grass on the rises (L 0.66). Three
      // octaves, and the coarse one dominates on purpose: the camera only sees
      // ~130 m of ground, so a 290 m band is what puts a genuinely lit slope on
      // one side of the frame and a genuinely shaded one on the other. Finer
      // bands alone just make speckle, which averages back to flat.
      //
      // SCALE IS EVERYTHING HERE and the first attempt got it wrong. A 290 m
      // band is not "large scale" at this camera, it is CONSTANT: the frame
      // only spans ~200 m of ground, so all a 290 m band does is decide how
      // bright the whole shot is (measured: albedo median 0.40 at the origin
      // against 0.58 at (300,-200), with the in-frame p10-p90 spread still only
      // 0.14 in both). The band that reads as a lit slope on one side of the
      // frame and a shaded hollow on the other is 130-140 m — a bit under one
      // frame width — with a 50 m band inside it for draws and hummocks.
      // ...and the band cannot be too coarse EITHER, which is the trap on the
      // other side. At 140 m the hero frame looked right but the wildlife
      // preset — a much closer camera seeing maybe 70 m of ground — landed
      // entirely inside one bright lobe and came back at mean luma 0.484
      // against the reference's 0.379, a chartreuse field with no shade in it
      // at all. The band has to be short enough that the CLOSEST camera still
      // contains a full light-dark cycle: ~87 m, which is about a third of the
      // hero frame and a full cycle of the wildlife one. That also matches the
      // reference, whose meadow sweeps measure 40-70 m across.
      const big = fbm(x * 0.0088, z * 0.0088, { octaves: 2, seed: seed + 205 });
      const mid = fbm(x * 0.021, z * 0.021, { octaves: 2, seed: seed + 213 });
      const fine = fbm(x * 0.058, z * 0.058, { octaves: 1, seed: seed + 217 });
      // A COOL BIAS on this field was tried (-0.10) and reverted: it bought
      // 0.009 of mean saturation and cost 0.009 of mean luma and 2.4 points out
      // of luma bucket 5, which is the bucket we are shortest on. The chroma
      // has to come off the shaded half specifically, not off the whole field.
      // THE BIAS IS A MASS-DISTRIBUTION KNOB, and -0.19 was costing us the two
      // luma buckets the reference is fattest in. Measured this round:
      //
      //   bucket    0.2    0.3    0.4    0.5
      //   ours     18.7   22.7   19.9   15.2
      //   target   16.7   21.5   22.0   17.5
      //
      // Two points too much in 0.2 and 0.3, four points too little in 0.4 and
      // 0.5 — and the same fact read a second way: inside deciles 0.3-0.5 the
      // reference puts 46.6% of the FRAME in pixels of saturation above 0.75
      // (that is its meadow) where we put 31.4%. Both gaps are one move: the lit
      // lobe of this field has to reach further up the ramp. It also buys back
      // most of the 0.015 of mean luma the acid fix cost, without touching a
      // single colour — which is the right way round, because the colours now
      // match the reference decile by decile and the DISTRIBUTION does not.
      // CYCLE 2: THE BIAS GOES POSITIVE, AND THAT IS NOT A REVERSAL.
      // Paired with the saturating shade knee below, this term no longer sets
      // "how dark the meadow is" — the knee does. What it sets is HOW MUCH of the
      // field is in the shade lobe at all, and the reference wants that number
      // LOWER than ours while the shade itself goes far deeper: a smaller, much
      // darker shade population. Sampled offline over 384k points of the field
      // (the field is homogeneous, so a large sample predicts the albedo
      // distribution without paying for a render), bias -0.075 -> +0.05 with the
      // knee at 0.68 takes the shade lobe from 63.3% to 51.0% of the meadow while
      // albedo luma bucket 1 goes 2.2% -> 10.4% and bucket 3 falls 24.4% -> 16.4%.
      // Mean albedo luma only moves 0.436 -> 0.421, which is what keeps the frame
      // mean on the reference; the two moves are deliberately mean-neutral.
      // ...and CYCLE 3 PUTS IT BACK. Measured, bias +0.05 with the knee raised the
      // rendered grass mean from (82,97,22) to (84,100,25) and frame luma from
      // 0.390 to 0.398 against the reference's 0.379 — the offline albedo model
      // called the pair mean-neutral and the render disagreed, because the model
      // cannot see the detail blanket (see the ramp essay in palette.js). The
      // knee stays, the bias goes back to the value seven rounds tuned it to.
      let t = clamp((big * 0.44 + mid * 0.34 + fine * 0.20) * 1.8 - 0.075, -1, 1);
      // ...and then PUSHED OFF ZERO. A sum of fbm octaves is a bell: most of the
      // meadow lands near t = 0, i.e. on the bare ramp, and that is why the
      // frame reads as one flat wash of a single green no matter how well the
      // ramp itself is tuned. Measured on green pixels split into luma tiers,
      // ours piled 52% into 0.28-0.42 where the reference puts 29%, and came up
      // 8 points short in 0.42-0.56 and 9 short in 0.14-0.28 — a distribution
      // problem, not a colour one. A sub-unit exponent on |t| is the cheapest
      // fix: it leaves the two ends and the sign alone (so the ramp's reach is
      // unchanged and the frame mean barely moves) and only evacuates the
      // middle, turning the bell into the two-lobed sun/shade split the
      // reference has.
      // ROUND 12: 0.68 EVACUATES THE MIDDLE TOO HARD. Grass per decile as a
      // share of each frame's own grass — ours 13/23/25/21/12/6 against the
      // reference's 17/23/20/24/15/1 — is not a bell against two lobes, it is
      // ONE mode in the wrong place plus a tail the reference does not have. The
      // reference's grass peaks at decile 0.4 and stops at 0.6; ours peaks at 0.3
      // and runs out to 0.7.
      // ...BUT UNITY IS WORSE, MEASURED: taking it to 1.0 put decile 0.3 at
      // 18.4% of the frame against the reference's 10.1% and thinned decile 0.5
      // from 7.3% to 5.9% against its 7.4%. The exponent is not what places the
      // mode — with patchA's value now capped, the upper lobe can no longer run
      // away, and evacuating the middle is what fills decile 0.4-0.5 rather than
      // piling everything on the bare ramp at 0.3. It stays where it was; the
      // mode is placed with the bias term above instead.
      // CYCLE 5: 0.68 -> 0.56, AND THE REASON THE ROUND-12 TEST SAID OTHERWISE IS
      // THAT IT WAS RUN AGAINST THE OLD RAMP. With the rungs now on the
      // reference's ladder the frame mean has landed (luma 0.382 against 0.379,
      // saturation 0.739 against 0.756, grass mean (77,95,20) against (75,93,18))
      // and exactly one error is left in the meadow — it is not a colour, it is
      // the bimodality:
      //
      //   bucket        0     1     2     3     4     5
      //   grass ours   2.8   8.7  13.2  15.8  14.3   6.7
      //   grass ref    0.8  13.4  11.4  10.2  12.4   7.7
      //
      // The reference dips at bucket 3 between two piles; ours has its single mode
      // there, 5.6 points over, and is 4.7 short at bucket 1. This exponent is the
      // one knob that moves BOTH at once, because it evacuates the middle and
      // feeds whichever lobe a pixel is already on. Sampled offline, 0.68 -> 0.56
      // takes albedo bucket 1 from 18.1% to 22.6% and bucket 3 from 19.7% to
      // 17.0% while the lit lobe holds (bucket 5 23.9% -> 25.1%).
      t = Math.sign(t) * Math.pow(Math.abs(t), 0.56);
      // Asymmetric on purpose. THREE.Color.lerp mixes in LINEAR space, where a
      // 50% mix toward a dark green is nowhere near 50% of the way down in
      // perceived value — the bright end always wins. The dark lerp has to be
      // pushed harder to buy the same number of stops.
      // The shade lerp is CURVED, not linear. Sampled against the reference,
      // our mid-tones (L 0.36) came back rgb(78,104,20) — R/G 0.75 — where the
      // reference's mid-tones at the same value are rgb(84,89,42) and
      // rgb(82,96,27), R/G 0.85-0.94. A straight lerp from a hue-70 yellow-green
      // to a hue-136 heath passes through pure hue-100 green at the halfway
      // point, and halfway is exactly where most of the meadow sits. Raising the
      // exponent keeps the mid-tones on the warm side of the path and only lets
      // the cool blue-green arrive in the genuinely deep hollows, which is what
      // the reference does.
      // CYCLE 2: THE SHADE LERP IS A KNEE, NOT A POWER CURVE, AND THAT IS THE
      // SHAPE OF THE REFERENCE'S HISTOGRAM.
      //
      // Grass per luma bucket as a share of each frame's own grass:
      //
      //   bucket    0     1     2     3     4     5     6
      //   ours     4.6  13.5  19.2  23.0  24.4  13.2   2.1
      //   ref      1.4  23.8  20.2  18.1  22.0  13.7   0.9
      //
      // The reference is BIMODAL — a pile at bucket 1, a dip at 3, a second pile
      // at 4 — and bucket 0 is a CLIFF beneath it: 1.4% under a 23.8%. Ours is one
      // broad mode at 3-4 with a soft leak out of the bottom. Seven rounds have
      // read that leak as "our shade is too dark" and lightened swatches; it is
      // the opposite. A cliff with a pile on top of it is the signature of a
      // SATURATING mix — a population that all lands on one swatch and then stops
      // — and `pow(-t, 1.22)` is the least saturating curve available: with |t|
      // typically 0.3 it returns 0.23, so the shaded meadow only travelled a
      // quarter of the way to patchB and the deep green never actually arrived.
      // Measured offline, albedo luma bucket 1 held 2.2% of the meadow.
      //
      // `min(1, -t / 0.68)` reaches patchB at t = -0.68 and holds there, which
      // puts a hard floor at patchB's own luma (0.150 — inside bucket 1, which is
      // why cycle 1 raised it) and piles the shade lobe onto it: albedo bucket 1
      // 2.2% -> 10.4%. The exponent that replaced it is 1.0 on purpose; the
      // round-12 essay's worry about a straight lerp passing through pure hue-100
      // green at the halfway point is answered by patchB now being (22,45,23),
      // red and blue EQUAL, so the path no longer runs through a teal.
      //
      // THE LIT SIDE KEEPS ITS SOFT TAPER AND IS DELIBERATELY NOT KNEED. The
      // reference's lit lobe does not cliff — 22.0 / 13.7 / 0.9 across buckets
      // 4/5/6 is a taper — and a knee there would land a third of the meadow on
      // exactly patchA, which is the flat slab of brightest grass that reads as an
      // acid patch in the first place. Tested offline: litKnee 0.55 puts 34% of
      // the field on one value. The brief's "do not flatten the meadow" is this.
      if (t > 0) c.lerp(K.patchA, t * 0.92);
      else c.lerp(K.patchB, Math.min(1, -t / 0.68));
      // Hue and chroma ride WITH the value, they do not float free: a lit rise
      // is warmer AND yellower AND more saturated (grass drying in the sun),
      // a hollow is cooler AND greener AND duller. The reference shows a 60-80
      // degree hue swing between its lit and shaded greens, and that swing —
      // not chroma — is what makes it look painted. It also pulls mean
      // saturation down, because the dull half is a big share of the frame.
      // Asymmetric, and the asymmetry is measured: the reference's lightest
      // greens run 90-100% saturation and its darkest run 50-66%, so chroma
      // FALLS with value far faster than it rises. A symmetric +/-0.035 left our
      // shaded grass at S 0.80 where the reference has 0.55, which is most of
      // the 0.02 we are still over on frame mean saturation.
      //
      // ROUND 12: "the lightest greens run 90-100% saturation" IS THE BUG, and
      // it came from measuring a crop of lit grass instead of the population.
      // Per luma decile on the reference's grass, saturation peaks at 0.91 near
      // decile 0.45 and then falls to 0.85 and 0.56 as blue climbs 12 -> 26 -> 86.
      // It is an INVERTED-U in value, not a rising line. Ours ran 0.94 / 0.96 /
      // 0.97 / 0.97 across the same range with blue pinned at 5-8, and that
      // plateau at the top is exactly the acid: #747400 and #5d5d00, 15% of the
      // frame, both with a hard zero in blue.
      //
      // So chroma now falls at BOTH ends and only the middle of the lit lobe
      // keeps full saturation. The roll-off is quadratic in t so it bites only
      // on the genuinely bright half of the lobe — a linear term would take
      // chroma out of decile 0.4, which already matches the reference.
      //
      // The warm hue rotation also comes down hard, from -0.022 to -0.006. At
      // -0.022 (about 8 degrees) the lit lobe crossed the line where RED LEADS
      // GREEN, which is what put R exactly equal to G in both acid bins; the
      // reference's brightest grass still keeps green ahead at R/G 0.94.
      // CYCLE 8: the quadratic term 0.14 -> 0.22. Measured per luma decile on the
      // grass population, the reference's saturation peaks near decile 0.45 and
      // then FALLS, 0.90 -> 0.86, as its blue climbs 12 -> 15 -> 25; ours rose
      // 0.91 -> 0.95 with blue falling 12 -> 11 -> 9. This is the term that is
      // supposed to produce that roll-off and it was not biting hard enough to
      // reach the top two deciles. Quadratic in t on purpose, so deciles 0.4-0.5 —
      // which already match the reference's blue to the value — are left alone.
      if (t > 0) c.offsetHSL(t * -0.006, t * 0.020 - t * t * 0.22, 0);
      else c.offsetHSL(-t * 0.030, t * 0.065, 0);

      // Damp, darker grass in the hollows and along the tarn shores.
      const wet = smoothstep(6, -16, h);
      if (wet > 0) c.lerp(K.lowland, wet * 0.6);

      // SHORELINE. The water plane sits at -8 m; a narrow band of pale gravel
      // right at the line is what stops a lake reading as blue paint spilled on
      // grass. Two metres above the water it is already gone, so it never turns
      // into a beach — the reference's tarn edges are a hard, thin rim.
      const shore = smoothstep(-13.5, -8.5, h) * smoothstep(-3.5, -6.5, h);
      if (shore > 0) c.lerp(K.sand, shore * 0.7);
      // Grey belongs to boulders and genuinely vertical rock, nothing else. The
      // old limestone outcrop field painted pale scree straight across the flat
      // meadow (measured: #b5b4a1 at slope 0.000, right under the car) and was
      // the single biggest cause of the washed-out ground. Soil only from ~28°,
      // scree from ~37°, bare rock from ~45° — angles the meadow never reaches.
      steepness(c, K, slope, 0.12, 0.20, 0.30, [0.30, 0.55, 0.85]);
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
