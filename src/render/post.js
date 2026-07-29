import * as THREE from 'three';
import { GRADES, gradeFor } from './grade.js';

/**
 * POST-PROCESSING — owned by the render builder.
 *
 * CONTRACT:
 *   createPostFX(ctx) -> {
 *     render() -> void          MUST draw the final image to the canvas
 *     setSize(w, h) -> void
 *     applyPalette(palette) -> void
 *     enabled: boolean
 *   }
 *
 * ctx = { renderer, scene, camera, palette }
 *
 * THE PIPELINE
 * ------------
 *   1. scene  -> HDR target, rendered at `ssaa`x linear resolution (supersample).
 *                Tone mapping is deliberately NOT applied by three here (three
 *                skips it when drawing into a render target) so the whole image
 *                is graded once, in linear, at the end.
 *   2. AO     -> half-res scalable ambient obscurance from depth, two radii
 *                (tight contact + wide cavity), bilateral blurred. This is what
 *                stops objects floating.
 *   3. blur   -> half-res blurred copy of the scene, used as the far field for
 *                a depth-of-field that softens only the distance (diorama cue).
 *   4. bloom  -> quarter-res bright pass, two widths, restrained.
 *   5. final  -> box-resolve of the supersampled buffer (crisp facet edges, no
 *                FXAA mush) + DoF + BROKEN LIGHT + AO + tone map + bloom +
 *                per-biome grade + display-space highlight knee + vignette +
 *                chromatic falloff + dither, straight to the canvas.
 *
 * Everything preserves hard facet edges: no blur is ever applied to the
 * in-focus image, and the only spatial filter on it is a box downsample of a
 * higher-resolution render.
 *
 * WHAT IS SCENE-REFERRED AND WHAT IS DISPLAY-REFERRED
 * ---------------------------------------------------
 * Everything before `tonemap()` in the composite is LINEAR RADIANCE, and that is
 * where anything pretending to be light belongs — the broken-light term and the
 * AO both act there, because a cloud shadow and an occluded corner are things
 * that happen to light, not paint applied afterwards. Everything after it is
 * 0-1 DISPLAY values: bloom, the grade, the highlight knee and the vignette.
 * The knee exists because the grade can (and does) push values the scene-referred
 * shoulder already handled back up toward white; see the comment on it.
 */

const TRI_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

function fsGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  return g;
}

const DEPTH_UTIL = /* glsl */ `
  uniform sampler2D tDepth;
  uniform vec2 uProj;       // (tanHalfFovY * aspect, tanHalfFovY)
  uniform float uNear;
  uniform float uFar;

  float rawDepth(vec2 uv) { return texture2D(tDepth, uv).x; }
  float viewZ(float d) { return (uNear * uFar) / ((uFar - uNear) * d - uFar); } // negative
  float linearDist(vec2 uv) { return -viewZ(rawDepth(uv)); }
  vec3 viewPos(vec2 uv, float d) {
    float vz = viewZ(d);
    vec2 ndc = uv * 2.0 - 1.0;
    return vec3(ndc * uProj, -1.0) * (-vz);
  }
`;

// ---------------------------------------------------------------- AO
const AO_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  ${DEPTH_UTIL}
  uniform vec2 uTexel;        // 1 / ao-buffer size
  uniform vec2 uAspect;       // (1/aspect, 1) so a world radius maps isotropically
  uniform float uR1;          // tight contact radius (metres)
  uniform float uR2;          // wide cavity radius (metres)
  uniform float uIntensity;
  uniform float uBias;
  uniform float uHBias;       // metres above the tangent plane, at the TIGHT radius
  uniform float uFade;        // distance at which AO stops mattering
  uniform float uSeed;

  const int SAMPLES = 11;

  /**
   * Bounded occlusion estimator: every sample contributes at most 1, so
   * uIntensity means exactly "darkness when fully enclosed". Physically looser
   * than the SAO estimator, but this is art direction, not a light transport
   * solver — and a knob that means something is worth more than one that does not.
   */
  float occlude(vec3 P, vec3 N, vec3 S, float R, float hb) {
    vec3 V = S - P;
    float d = length(V);
    if (d < 1e-4) return 0.0;
    float h = dot(N, V);        // METRES above the tangent plane
    float ndv = h / d;
    // TWO rejections, and the second one is the important one.
    //
    // The angle bias alone could not tell a terrain crease from an occluder.
    // Our heightfield facets are ~15 m across and the depth-derived normal is
    // simply WRONG along every crease between them, so each crease produced a
    // constant small positive ndv and AO drew a dark line along it: a ladder of
    // horizontal streaks across the whole meadow, plainly visible in
    // ?debugpost=ao. Raising the angle bias far enough to reject them (0.22)
    // also rejected the contact pools at the base of every tree.
    //
    // Height above the tangent plane separates them cleanly and in a unit that
    // means something. So keep the angle bias small and gate on ABSOLUTE HEIGHT.
    //
    // The gate SCALES WITH THE RADIUS, and that is the whole trick. A crease
    // sampled 2 m away lifts a sample by centimetres; the SAME crease sampled
    // 8 m away lifts it by more than a metre, which is why the wide cavity
    // radius was drawing all the streaks while the tight contact radius was
    // innocent. One flat threshold cannot serve both. The caller passes the
    // gate for its own radius: ~0.4 m for the 2.2 m contact ring, ~1.8 m for
    // the 8 m cavity ring — and a tree, boulder or post still clears both.
    return smoothstep(uBias, uBias + 0.30, ndv)
         * smoothstep(hb, hb * 2.4, h)
         * (1.0 - smoothstep(R * 0.5, R, d));
  }

  void main() {
    float d = rawDepth(vUv);
    if (d >= 0.9999) { gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0); return; }

    vec3 P = viewPos(vUv, d);

    // Facet-accurate normal: pick the nearer neighbour on each axis so
    // silhouette edges do not smear the normal across a depth discontinuity.
    vec3 pR = viewPos(vUv + vec2(uTexel.x, 0.0), rawDepth(vUv + vec2(uTexel.x, 0.0)));
    vec3 pL = viewPos(vUv - vec2(uTexel.x, 0.0), rawDepth(vUv - vec2(uTexel.x, 0.0)));
    vec3 pU = viewPos(vUv + vec2(0.0, uTexel.y), rawDepth(vUv + vec2(0.0, uTexel.y)));
    vec3 pD = viewPos(vUv - vec2(0.0, uTexel.y), rawDepth(vUv - vec2(0.0, uTexel.y)));
    vec3 dx = abs(pR.z - P.z) < abs(P.z - pL.z) ? pR - P : P - pL;
    vec3 dy = abs(pU.z - P.z) < abs(P.z - pD.z) ? pU - P : P - pD;
    vec3 N = normalize(cross(dx, dy));
    if (N.z < 0.0) N = -N;

    float dist = -P.z;
    float scale = 0.5 / max(dist, 1.0);
    vec2 rad1 = uR1 * scale * uAspect / uProj.y;
    vec2 rad2 = uR2 * scale * uAspect / uProj.y;

    float rot = fract(sin(dot(floor(vUv / uTexel), vec2(12.9898, 78.233))) * 43758.5453 + uSeed) * 6.2831853;

    float s1 = 0.0, s2 = 0.0;
    for (int i = 0; i < SAMPLES; i++) {
      float a = (float(i) + 0.5) / float(SAMPLES);
      float ang = a * 6.2831853 * 3.0 + rot;
      vec2 dir = vec2(cos(ang), sin(ang)) * pow(a, 0.7);

      vec2 u1 = vUv + dir * rad1;
      vec2 u2 = vUv + dir * rad2;
      float d1 = rawDepth(u1);
      float d2 = rawDepth(u2);
      if (d1 < 0.9999) s1 += occlude(P, N, viewPos(u1, d1), uR1, uHBias);
      if (d2 < 0.9999) s2 += occlude(P, N, viewPos(u2, d2), uR2, uHBias * (uR2 / uR1));
    }

    float inv = 1.0 / float(SAMPLES);
    // Tight radius owns the contact; the wide one only deepens what is already
    // a real cavity, so open ground never picks up a grey wash.
    float occ = max(s1 * inv, s2 * inv * 0.75) * uIntensity;
    float ao = clamp(1.0 - occ, 0.0, 1.0);
    // Fade AO out with distance: it is a foreground grounding cue, not haze.
    ao = mix(ao, 1.0, smoothstep(uFade * 0.55, uFade, dist));

    gl_FragColor = vec4(ao, dist / uFar, 0.0, 1.0);
  }
`;

// ------------------------------------------------------- bilateral AO blur
const AO_BLUR_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tAO;
  uniform vec2 uDir;      // texel-space blur direction

  void main() {
    vec2 c = texture2D(tAO, vUv).rg;
    float centreDepth = c.g;
    float sum = c.r, wsum = 1.0;
    for (int i = 1; i <= 4; i++) {
      float fi = float(i);
      float w = exp(-0.5 * (fi * fi) / 5.0);
      vec2 o = uDir * fi;
      vec2 a = texture2D(tAO, vUv + o).rg;
      vec2 b = texture2D(tAO, vUv - o).rg;
      float wa = w * exp(-abs(a.g - centreDepth) * 140.0);
      float wb = w * exp(-abs(b.g - centreDepth) * 140.0);
      sum += a.r * wa + b.r * wb;
      wsum += wa + wb;
    }
    gl_FragColor = vec4(sum / wsum, centreDepth, 0.0, 1.0);
  }
`;

// ------------------------------------------------------------- downsample
const DOWN_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;    // source texel size
  void main() {
    vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2( 0.5, -0.5)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2(-0.5,  0.5)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2( 0.5,  0.5)).rgb;
    gl_FragColor = vec4(c * 0.25, 1.0);
  }
`;

const BLUR_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uDir;
  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
    c += (texture2D(tSrc, vUv + uDir * 1.3846154).rgb + texture2D(tSrc, vUv - uDir * 1.3846154).rgb) * 0.3162162;
    c += (texture2D(tSrc, vUv + uDir * 3.2307692).rgb + texture2D(tSrc, vUv - uDir * 3.2307692).rgb) * 0.0702703;
    gl_FragColor = vec4(c, 1.0);
  }
`;

/**
 * THE TONE CURVE — shared by the bright pass and the composite.
 *
 * The scene buffer is LINEAR and UNTONED (three renders it with NoToneMapping
 * so the frame is only ever mapped once, here). Its range is roughly 0..3, so
 * every threshold downstream has to be expressed against that, and the curve
 * itself has to be able to swallow a value of 3 without producing paper white.
 *
 * It compresses the PEAK CHANNEL and rescales the triplet by the same factor,
 * so the ratio between channels — the hue and the saturation — survives the
 * roll-off exactly. A per-channel shoulder (what this used to be) desaturates
 * as it compresses: a hot red becomes pink, a lit green becomes cream, and a
 * whole meadow one stop over becomes a white hole. That was the blowout.
 *
 * Below `knee` it is the identity, so authored flat colour is untouched.
 */
const TONEMAP = /* glsl */ `
  uniform float uExposure;
  uniform float uShoulder;   // knee: below this, identity
  uniform float uWhite;      // asymptote: the curve never reaches it

  vec3 tonemap(vec3 c) {
    c = max(c * uExposure, 0.0);
    float p = max(c.r, max(c.g, c.b));
    if (p <= uShoulder) return c;
    float span = max(uWhite - uShoulder, 1e-3);
    float t = (p - uShoulder) / span;
    float pc = uShoulder + span * (t / (1.0 + t));
    return c * (pc / max(p, 1e-5));
  }
`;

// The bright pass thresholds the DISPLAY-REFERRED value, not the raw linear
// one, so "0.85" means "85% of the way to white on screen" whatever the scene
// exposure happens to be. It also means bloom is bounded by the tone curve and
// physically cannot smear a white star across the frame.
const BRIGHT_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  ${TONEMAP}
  uniform sampler2D tSrc;
  uniform float uThreshold;
  uniform float uKnee;
  void main() {
    vec3 c = tonemap(texture2D(tSrc, vUv).rgb);
    float l = max(c.r, max(c.g, c.b));
    float w = smoothstep(uThreshold, uThreshold + uKnee, l);
    gl_FragColor = vec4(c * w, 1.0);
  }
`;

/**
 * BROKEN LIGHT — the thing that separates a painted meadow from a rendered one.
 *
 * MEASURED off ref/target_01 (tools/measure.mjs): the reference's meadow runs
 * p05 42 / p50 78 / p95 133 in luma — a spread of 91. Ours ran 55 / 85 / 109, a
 * spread of 54. The reference is not more contrasty in the grade; it has broad,
 * soft, LOW-FREQUENCY variation across the field — cloud shadow, dappled sun,
 * grass that is greener in the hollows and drier on the crowns. Contrast cannot
 * manufacture that: contrast expands what is already there, and what was there
 * was one flat value.
 *
 * So the composite reconstructs WORLD XZ from the depth buffer and modulates the
 * incident light by two octaves of value noise anchored to the world, not to the
 * screen. It is a light term, applied in linear before the tone map, exactly
 * where a real cloud shadow would act. Because it is world-anchored it does not
 * crawl when the camera moves, and because it is applied before the tone map it
 * cannot clip.
 *
 * The bright lobes also go WARM and the dark lobes COOL — the reference's field
 * is yellow-green where the sun hits and blue-green in the hollows, and that
 * warm/cool split across the field is most of why it reads as painted.
 */
const MEADOW_NOISE = /* glsl */ `
  uniform mat4  uInvView;       // camera.matrixWorld
  uniform float uDappleScale;   // cycles per metre
  uniform float uDapple;        // amplitude of the value swing
  uniform float uDappleWarm;    // amplitude of the warm/cool swing
  uniform float uDappleFine;    // amplitude of the brush-scale octave

  float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d2 = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d2, f.x), f.y);
  }
  /**
   * -1..1. Three octaves, lightly domain-warped so the lobes are not on a grid.
   * The warp is deliberately SMALL (0.45 of a cell): at 1.7 cells it smeared the
   * whole field into one gradient across the frame, which just relit the picture
   * instead of breaking it up.
   */
  float dappleField(vec2 w) {
    vec2 warp = (vec2(vnoise(w * 0.7 + 5.2), vnoise(w * 0.7 + 17.7)) - 0.5) * 0.45;
    vec2 p = w + warp;
    float n = vnoise(p) * 0.50 + vnoise(p * 2.17 + 9.1) * 0.32 + vnoise(p * 4.70 + 3.3) * 0.18;
    return n * 2.0 - 1.0;
  }
`;

// --------------------------------------------------------------- composite
const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  ${DEPTH_UTIL}
  ${TONEMAP}
  ${MEADOW_NOISE}
  uniform sampler2D tScene;
  uniform sampler2D tAO;
  uniform sampler2D tBloom;
  uniform sampler2D tBloomWide;
  uniform sampler2D tFar;
  uniform vec2 uOutTexel;      // 1 / output size
  uniform float uAspectRatio;

  uniform vec3  uLift;
  uniform float uLiftFall;
  uniform vec3  uLiftToe;      // per channel: 0 = plain ramp; else the luma the fill fades out below
  uniform vec3  uGamma;
  uniform vec3  uGain;
  uniform float uContrast;
  uniform float uContrastPivot;
  uniform float uContrastChroma;
  uniform float uHiKnee;
  uniform float uHiRecover;    // 0 = plain shoulder; 1 = peaks pass through untouched
  uniform float uHiRecoverLo;  // peak value at which the release starts
  uniform float uLoKnee;
  uniform float uSaturation;
  uniform vec3  uShadowTint;
  uniform vec3  uHighTint;
  uniform float uSplitLo;
  uniform float uSplitHi;

  uniform float uAOStrength;
  uniform vec3  uAOTint;
  uniform float uBloom;
  uniform float uBloomWide;
  uniform float uDofNear;
  uniform float uDofFar;
  uniform float uDofAmount;
  uniform float uVignette;
  uniform float uVignetteSoft;
  uniform float uCA;
  uniform float uGrain;
  uniform float uDebug;

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  // Box-resolve the supersampled buffer: four bilinear taps at the quadrant
  // centres of the output pixel. Keeps facet edges razor sharp while removing
  // the jaggies — no FXAA smearing anywhere.
  vec3 resolve(vec2 uv) {
    vec2 o = uOutTexel * 0.25;
    return (texture2D(tScene, uv + vec2(-o.x, -o.y)).rgb
          + texture2D(tScene, uv + vec2( o.x, -o.y)).rgb
          + texture2D(tScene, uv + vec2(-o.x,  o.y)).rgb
          + texture2D(tScene, uv + vec2( o.x,  o.y)).rgb) * 0.25;
  }

  vec3 toSRGB(vec3 c) {
    c = max(c, 0.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }

  void main() {
    vec2 dir = vUv - 0.5;
    float r2 = dot(dir * vec2(uAspectRatio, 1.0), dir * vec2(uAspectRatio, 1.0));

    // Chromatic falloff: zero in the centre, a fraction of a pixel at the edge.
    float ca = uCA * r2;
    vec3 col;
    col.r = resolve(vUv + dir * ca).r;
    col.g = resolve(vUv).g;
    col.b = resolve(vUv - dir * ca).b;

    float d = rawDepth(vUv);
    float dist = -viewZ(d);

    // ---- depth of field: soften only the far distance (miniature cue)
    if (uDofAmount > 0.001 && d < 0.9999) {
      float f = smoothstep(uDofNear, uDofFar, dist) * uDofAmount;
      col = mix(col, texture2D(tFar, vUv).rgb, f);
    } else if (d >= 0.9999) {
      col = mix(col, texture2D(tFar, vUv).rgb, uDofAmount * 0.55);
    }

    // ---- broken light (linear, world-anchored — see MEADOW_NOISE above)
    if (uDapple > 0.0001 && d < 0.9999) {
      vec3 vp = viewPos(vUv, d);
      vec3 wp = (uInvView * vec4(vp, 1.0)).xyz;
      float n = dappleField(wp.xz * uDappleScale);
      // SYMMETRIC about 1.0. An asymmetric swing (tried first: 1-a .. 1+0.55a)
      // dimmed the whole frame by 0.225a and cost as much brightness at the top
      // of the range as it bought darkness at the bottom — the field got no
      // wider, only lower. smoothstep has mean 0.5 over a uniform input, so this
      // form leaves the average exposure of the frame exactly untouched and
      // spends the entire amplitude on RANGE.
      float v = smoothstep(0.0, 1.0, n * 0.5 + 0.5);
      float shade = 1.0 + uDapple * (2.0 * v - 1.0);
      vec3 warm = vec3(1.0 + uDappleWarm, 1.0 + uDappleWarm * 0.22, 1.0 - uDappleWarm * 0.85);
      vec3 cool = vec3(1.0 - uDappleWarm * 0.85, 1.0, 1.0 + uDappleWarm * 1.05);
      col *= shade * mix(cool, warm, v);

      // BRUSH SCALE. The lobes above are 24 m across and do nothing about the
      // real "rendered, not painted" tell, which is that a 15 m terrain facet is
      // one flat value from edge to edge. This octave is ~1.6 m — about 30 px at
      // the focus — so it breaks the facet into something with tooth, the way the
      // reference's grass does, without softening a single silhouette.
      if (uDappleFine > 0.0001) {
        float f = vnoise(wp.xz * (uDappleScale * 15.0)) - 0.5;
        f += (vnoise(wp.xz * (uDappleScale * 37.0) + 4.4) - 0.5) * 0.55;
        col *= 1.0 + f * uDappleFine;
      }
    }

    // ---- contact shading (in linear: occlusion is a light term, not a paint)
    float ao = texture2D(tAO, vUv).r;
    float occ = (1.0 - ao) * uAOStrength;
    col = mix(col, col * uAOTint, clamp(occ, 0.0, 1.0));

    // ---- tone map. EVERYTHING below this line is display-referred: bloom is
    // added against a 0-1 image and a contrast pivot of 0.5 means mid-grey.
    col = tonemap(col);

    // ---- bloom (already tone mapped by the bright pass, so it is bounded)
    col += texture2D(tBloom, vUv).rgb * uBloom;
    col += texture2D(tBloomWide, vUv).rgb * uBloomWide;

    col = toSRGB(col);

    col = col * uGain;
    col = pow(max(col, 0.0), uGamma);
    // CONTRAST PIVOTS ON THE PICTURE'S KEY VALUE, NOT ON MID-GREY.
    // Measured: our meadow and target_01's meadow agree almost exactly at the
    // median (luma 83 vs 78) and diverge only above it (p95 110 vs 133). A
    // contrast pivoted at 0.5 sits ABOVE the whole meadow distribution, so every
    // green in the frame gets darker and the picture loses the sunlit end
    // instead of gaining it. Pivoting at the meadow's own median leaves the mid
    // where it already matched and spends the contrast on the two tails.
    //
    // ...AND IT RUNS ON LUMA, NOT PER CHANNEL. THIS IS THE BLUE FIX.
    //
    // MEASURED (tools/measure.mjs, round 4): every dominant colour in our frame
    // ended in 00 — #5d5d00, #5d7400, #465d00, #464600 — while the reference's
    // greens all carry blue at 0x17. Frame mean blue 26 against the target's 44.
    // The albedo was never that blue-free; this line was eating it.
    //
    // An affine contrast applied PER CHANNEL about a pivot of 0.325 is a
    // saturation multiplier in disguise. Grass arriving as (0.40, 0.47, 0.06):
    // green is near the pivot and barely moves (0.47 -> 0.514, x1.09) but blue
    // is 0.27 BELOW it and gets pushed 1.3x further away (0.06 -> -0.02, then
    // clamped up off the floor by uLoKnee to 0.01). B/G goes 0.128 -> 0.019.
    // The weakest channel of every pixel darker than the pivot is destroyed,
    // which is both the missing blue AND the measured oversaturation (0.830
    // against the target's 0.756 — and mean saturation is (max-min)/max, i.e.
    // almost exactly "how far the weak channel is from the strong one").
    //
    // Run the SAME affine curve on luma instead and scale the triplet by the
    // ratio. Because luma is a linear combination whose weights sum to 1, the
    // resulting LUMINANCE is bit-for-bit what the per-channel form produced —
    // the tonal shaping this knob exists for is untouched — but the ratio
    // between the channels, i.e. the hue and the saturation, survives exactly.
    // Colour then comes from the world and from the tints below, which is where
    // round 2 concluded it should come from.
    //
    // uContrastChroma mixes between the two; it defaults to 0 (the old
    // behaviour) so the four biomes nobody is shipping keep their authored look.
    {
      vec3 perCh = (col - uContrastPivot) * uContrast + uContrastPivot;
      float lIn = dot(max(col, 0.0), LUMA);
      float lOut = (lIn - uContrastPivot) * uContrast + uContrastPivot;
      // Guard the ratio: a near-black pixel has no chroma to preserve, and
      // lOut/lIn there is either enormous or negative. Below the guard the two
      // forms agree anyway (both are heading for the low knee).
      vec3 lumaCh = max(col, 0.0) * clamp(lOut / max(lIn, 0.02), 0.0, 4.0);
      col = mix(perCh, lumaCh, uContrastChroma);
    }

    // ---- LOW KNEE: the mirror of uHiKnee, and it was the missing half.
    //
    // A contrast of 1.30 pivoted at 0.325 maps 0.0 to -0.098, so EVERY channel
    // below 0.075 was clipped flat to zero. Our grass carries 12/255 of blue in
    // the sun and 4/255 in shadow — the entire blue record of the meadow lives
    // under that threshold, and the clip is why measured B/G came out 0.00-0.08
    // against the reference's 0.12 in sun and 0.22-0.41 in shadow. A clipped
    // channel is also the most "rendered"-looking thing an image can do: it
    // flattens every dark area to one hue and it bands where the clip begins.
    //
    // v' = k*k / (2k - v) for v < k. It is C1 at the knee (value AND slope
    // match), it is monotonic, and it never reaches zero — pure black lands at
    // k/2 instead of clipping. Per channel, deliberately: the darks desaturate
    // very slightly as they compress, which is what film does and what the
    // reference's near-blacks look like.
    if (uLoKnee > 0.0001) {
      vec3 kk = vec3(uLoKnee);
      vec3 comp = kk * kk / max(2.0 * kk - col, 1e-4);
      col = mix(comp, col, step(kk, col));
    }

    // ---- LIFT, AFTER the contrast, weighted by LUMA.
    //
    // Before the contrast it could not survive it: 0.10 of blue added to a
    // shadow became 0.031, and (0.031 - 0.325) * 1.3 + 0.325 is negative. A
    // lift is a BLACK POINT, and a black point that the contrast can undo is
    // not one. So it acts here, on the graded image, where what it adds is what
    // the picture gets.
    //
    // The weight comes from the PIXEL's luma, not from the channel being
    // lifted. Tried per-channel first (measured, shots/g2): grass has almost no
    // blue even in full sun — 12/255 — so (1 - col.b)^4 was 0.87 and the blue
    // lift landed on SUNLIT meadow at nearly full strength, taking B/G from
    // 0.12 back up to 0.26 and undoing the whole point. Luma decides whether a
    // pixel is in shadow; the channel value only says what colour it is.
    //
    // MEASURED against target_01: shadowed grass there is R/G 0.53-0.74,
    // B/G 0.22-0.41 — red eaten, blue surviving. A multiply can never produce
    // that from our shadow, whose blue channel is 4/255; only an additive term
    // can, and this is the one.
    //
    // THE REORDER IS SHARED, so it moves the other four biomes too. Worked
    // through: their lifts are 0.012-0.052 at contrasts of 1.10-1.16, so the
    // change is the difference between multiplying the lift by the contrast and
    // not — under 1/255 in every case. Not worth a per-biome branch that the
    // next person would have to keep alive; uLiftFall defaults to 1.0 and
    // uLoKnee to 0.0, which leaves their curve shape exactly as authored.
    // ...AND IT HAS A TOE, BECAUSE A CAVITY CANNOT SEE THE SKY.
    //
    // This lift models sky fill: the blue that arrives on a surface the sun
    // cannot reach. A plain (1-luma)^f ramp says the darker a pixel is the more
    // sky it receives, which is true of OPEN shade and exactly false of a closed
    // one — the inside of a conifer stand is dark precisely because nothing,
    // sun or sky, gets in there. So the ramp has to turn around at the bottom.
    //
    // MEASURED (tools/hl.mjs, mean colour of each luma decile). Rendering the
    // frame with the lift disabled entirely:
    //
    //                 with lift        without        target
    //   bucket 0    rgb(5,19,40)   rgb(9,18,13)   rgb(9,28,21)
    //   bucket 1    rgb(17,43,47)  rgb(21,44,25)  rgb(23,45,25)
    //   bucket 4    rgb(116,121,28) rgb(118,121,22) rgb(118,123,31)
    //
    // Bucket 1 without the lift is the reference to within two values per
    // channel, and bucket 4 needs the lift to reach the reference's blue. Both
    // things are true at once, so the amplitude is right and the PROFILE is
    // wrong: at luma 0.08 the ramp delivers 90% of a blue lift to a pixel whose
    // green is 18, which is how a dark green becomes a navy blue, and the
    // saturation multiply downstream then finishes the red off (0.0275 -> 0.003).
    //
    // uLiftToe is the luma at which the fill is fully visible; below it the fill
    // fades out to nothing at 0.02. Defaults to 0 = off, so the four unshipped
    // biomes keep the plain ramp they were authored against.
    //
    // IT IS PER CHANNEL, BECAUSE THE THREE CHANNELS ARE THREE DIFFERENT LIGHTS.
    //
    // The blue in this lift is SKY, and a cavity cannot see the sky, so blue
    // needs the toe. The green is BOUNCE off the grass and off the tree's own
    // needles — it comes from the surfaces immediately around the pixel, which
    // inside a conifer stand are more green surfaces. Bounce does not switch off
    // in a cavity; it is the only light left in one.
    //
    // MEASURED (tools/hl.mjs). Our deepest bucket is rgb(8,19,20) against the
    // reference's rgb(9,28,21): red and blue are within a value, and the whole
    // deficit is 9/255 of GREEN. That is the shape this fixes and it is why a
    // scalar toe could not — with blue at 0.105 and green at 0.048, any weight
    // that delivers enough green delivers twice as much blue and the pixel goes
    // navy, which is what round 5 shipped.
    float lIn2 = dot(max(col, 0.0), LUMA);
    float liftW = pow(max(1.0 - lIn2, 0.0), uLiftFall);
    vec3 toeW = mix(vec3(1.0), smoothstep(vec3(0.02), max(uLiftToe, 0.021), vec3(lIn2)),
                    step(vec3(0.0001), uLiftToe));
    col += uLift * liftW * toeW;

    float l = dot(max(col, 0.0), LUMA);
    col = mix(vec3(l), col, uSaturation);
    // SPLIT-TONE, ON A RAMP THAT ENDS BEFORE THE MEADOW DOES.
    //
    // MEASURED (tools/patch_rp.mjs): target_01's open meadow is #505f0c —
    // B/G 0.12. Ours was #5f6c18, B/G 0.22, i.e. nearly twice the blue in the
    // mid greens, and that milkiness is most of why our field read olive and
    // "rendered" next to the reference's chartreuse. The blue was not wrong,
    // it was in the wrong PLACE: this ramp ran 0.05..0.95, so grass at luma
    // 0.39 still took 64% of the SHADOW tint (+8% blue) even though it is fully
    // sunlit. The reference keeps its blue strictly for what is IN shadow —
    // shadowed grass there is B/G 0.46. Ending the ramp at uSplitHi puts the
    // cool tint back where a sky fill would actually land it.
    col *= mix(uShadowTint, uHighTint, smoothstep(uSplitLo, uSplitHi, l));

    // ---- highlight roll-off, in DISPLAY space, after the grade.
    // The scene-referred shoulder above cannot protect the top end from what the
    // grade does to it: a contrast pivoted at 0.33 multiplies everything above
    // the pivot, and the brightest thing in frame is the dust plume, which is
    // exactly what must NOT grow. Same peak-channel compression as tonemap(), so
    // it desaturates nothing — it just stops the grade printing paper white.
    //
    // ...PLUS HIGHLIGHT RECOVERY, WHICH IS WHAT MAKES A LOW KNEE USABLE.
    //
    // Alpine needs the knee down at 0.48, because its dirt road arrives 0.23 of
    // display range hotter than the reference's and is 14% of the frame. But a
    // knee low enough to hold the road also flattens everything above it: with
    // the road landing at 0.60, MEASURED, the frame had 0.0% of pixels above
    // luma 0.7 against the reference's 1.5% and 0.0% above 0.8 against its 0.2%.
    // No tail at all, and a picture with no tail reads as capped.
    //
    // Those two are not in conflict, but BRIGHTNESS ALONE CANNOT TELL THEM
    // APART — measured, the road's peak channel averages 0.88 and its brightest
    // pixels run past 0.95, which is exactly where the plume lives. A release
    // gated on peak value only was worth 3.2% of the frame above luma 0.7
    // (target 1.5%) and it emptied the 0.5-0.6 bucket to pay for it.
    //
    // CHROMA tells them apart cleanly, and for a real reason. A bright DIFFUSE
    // surface is bright because of its albedo, and an albedo has a colour: our
    // road is a saturated ochre, chroma 0.53. A real highlight — dust lit from
    // behind, a white flower, a car roof, foam — is bright because of the LIGHT,
    // and the light is white, so its chroma is near zero. Releasing the knee for
    // achromatic peaks and holding it for coloured ones is the difference
    // between "recover the highlights" and "turn the exposure back up".
    //
    // MEASURED, and the band is not where you would guess. The reference's own
    // brightest 1% has mean chroma 0.434 — its highlights are the bridge, the
    // road crown and sunlit rock, all warm, none of them white. So the band is
    // not "achromatic vs coloured", it is "less coloured than the road", which
    // measures 0.539 after the grade. Ours: brightest 1% at chroma 0.491.
    //
    // The chroma band is not a taste knob and is deliberately not exposed: it is
    // the definition of "this is a highlight, not a paint colour".
    //
    // Monotonic in pk by construction: the released term is (pk - compressed),
    // which grows with pk, times a smoothstep in pk.
    {
      float pk = max(col.r, max(col.g, col.b));
      if (pk > uHiKnee) {
        float span = max(1.0 - uHiKnee, 1e-3);
        float t = (pk - uHiKnee) / span;
        float pc = uHiKnee + span * (t / (1.0 + t));
        float chroma = (pk - min(col.r, min(col.g, col.b))) / max(pk, 1e-4);
        float w = uHiRecover
                * smoothstep(uHiRecoverLo, 1.0, pk)
                * (1.0 - smoothstep(0.34, 0.58, chroma));
        pc += w * (pk - pc);
        col *= pc / pk;
      }
    }

    // ---- vignette
    //
    // MEASURED off target_01: its twelve row means run 80 / 113 / 78 top to
    // bottom and its eight column means 77 / 119 / 73 — the reference falls off
    // by about 30% at every edge, not just the corners. Ours fell off 10%,
    // because the old curve did not begin until r2 * 1.9 passed 0.18, and the
    // TOP AND BOTTOM CENTRE of a 16:9 frame only ever reach 0.475. Starting the
    // ramp at 0.05 and ending it at 1.10 puts real falloff on all four edges
    // while leaving the middle third untouched.
    float v = 1.0 - uVignette * smoothstep(uVignetteSoft, 1.10, r2 * 1.9);
    col *= v;
    // Barely desaturate the corners. The references darken at the edge but stay
    // fully saturated there; a filmic edge-desaturation reads as a photograph,
    // and this is meant to read as a painting.
    col = mix(vec3(dot(max(col, 0.0), LUMA)), col, mix(1.0, 0.96, 1.0 - v));

    if (uDebug > 0.5) {
      if (uDebug < 1.5) col = vec3(ao);
      else if (uDebug < 2.5) col = vec3(fract(dist * 0.02));
      else col = texture2D(tBloom, vUv).rgb * 4.0;
    }

    // ---- dither (kills banding in the sky ramp)
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    col += (n - 0.5) * uGrain;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

const RAW_VERT = /* glsl */ `
  precision highp float;
  attribute vec3 position;
  attribute vec2 uv;
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

class Pass {
  /** @param {boolean} raw false = three ShaderMaterial (can #include chunks) */
  constructor(renderer, geo, fragmentShader, uniforms, raw = true) {
    this.renderer = renderer;
    const def = { fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false };
    this.material = raw
      ? new THREE.RawShaderMaterial({ ...def, vertexShader: RAW_VERT })
      : new THREE.ShaderMaterial({ ...def, vertexShader: TRI_VERT });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.Camera();
  }
  render(target) {
    this.renderer.setRenderTarget(target ?? null);
    this.renderer.render(this.scene, this.camera);
  }
  get u() { return this.material.uniforms; }
}

/** Dev-only: ?debugpost=ao|depth|bloom renders an intermediate buffer. */
const DEBUG = (() => {
  try {
    const v = new URLSearchParams(location.search).get('debugpost');
    return { ao: 1, depth: 2, bloom: 3 }[v] ?? 0;
  } catch { return 0; }
})();

export function createPostFX(ctx) {
  const { renderer, scene } = ctx;
  let camera = ctx.camera;
  const geo = fsGeometry();

  /**
   * SUPERSAMPLE BUDGET.
   *
   * `maxPixels` is only a ceiling for very large windows; at every size we
   * actually ship (1600x900 .. 1920x1080) the clamp below is what decides, so
   * SSAA is the knob that matters. It is the linear factor: 2.0 renders four
   * times the pixels of the output, 1.5 renders 2.25x.
   *
   * Every derived buffer is sized from W,H — i.e. from the SUPERSAMPLED size —
   * so this factor also scales the AO pass (W/2), the far-field blur (W/2) and
   * both bloom chains (W/4, W/8). At 2.0 the "half-res" AO is really running at
   * full output resolution. Dropping to 1.5 therefore buys a bigger saving than
   * the raster count alone suggests, and MEASURED (tools/perf_rp.mjs, alpine
   * hero, 1600x900) it is the single largest honest saving in the frame.
   */
  const SSAA = 1.5;
  const maxPixels = 9.2e6;   // supersampling budget for oversized windows
  let W = 2, H = 2, ss = 1;

  const colorOpts = {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    generateMipmaps: false,
  };

  const rtScene = new THREE.WebGLRenderTarget(2, 2, {
    ...colorOpts,
    depthBuffer: true,
  });
  rtScene.depthTexture = new THREE.DepthTexture(2, 2);
  rtScene.depthTexture.format = THREE.DepthFormat;
  rtScene.depthTexture.type = THREE.UnsignedIntType;
  rtScene.texture.name = 'post.scene';

  // HALF FLOAT, NOT UNSIGNED BYTE. The green channel carries dist/far for the
  // bilateral blur's edge test, and at far = 1500 the whole visible ground plane
  // spans dist 115..175 — that is 0.077..0.117, i.e. TEN distinct 8-bit levels
  // across the frame. The blur's weight, exp(-|dd| * 140), then flipped by ~0.58
  // at every level boundary, and because depth varies with screen Y on a ground
  // plane the boundaries were horizontal: ten grey stripes across every meadow,
  // clearly visible in ?debugpost=ao. Half float makes the edge test exact.
  const rtAO = new THREE.WebGLRenderTarget(2, 2, { ...colorOpts, type: THREE.HalfFloatType });
  const rtAOb = new THREE.WebGLRenderTarget(2, 2, { ...colorOpts, type: THREE.HalfFloatType });
  const rtHalf = new THREE.WebGLRenderTarget(2, 2, colorOpts);
  const rtHalfB = new THREE.WebGLRenderTarget(2, 2, colorOpts);
  const rtQ = new THREE.WebGLRenderTarget(2, 2, colorOpts);
  const rtQb = new THREE.WebGLRenderTarget(2, 2, colorOpts);
  const rtE = new THREE.WebGLRenderTarget(2, 2, colorOpts);
  const rtEb = new THREE.WebGLRenderTarget(2, 2, colorOpts);

  const projU = { value: new THREE.Vector2(1, 1) };
  const nearU = { value: 1 };
  const farU = { value: 3000 };

  const aoPass = new Pass(renderer, geo, AO_FRAG, {
    tDepth: { value: rtScene.depthTexture },
    uProj: projU, uNear: nearU, uFar: farU,
    uTexel: { value: new THREE.Vector2() },
    uAspect: { value: new THREE.Vector2(1, 1) },
    // Tight radius = the contact pool at the base of a tree/rock/post, which is
    // what actually grounds an object in the references. Wide radius only
    // deepens real cavities. Both in METRES.
    uR1: { value: 2.2 },
    uR2: { value: 8.0 },
    uIntensity: { value: 2.4 },
    uBias: { value: 0.10 },
    uHBias: { value: 0.40 },
    uFade: { value: 460 },
    uSeed: { value: 0 },
  });

  const aoBlur = new Pass(renderer, geo, AO_BLUR_FRAG, {
    tAO: { value: rtAO.texture },
    uDir: { value: new THREE.Vector2() },
  });

  const down = new Pass(renderer, geo, DOWN_FRAG, {
    tSrc: { value: rtScene.texture },
    uTexel: { value: new THREE.Vector2() },
  });

  const blur = new Pass(renderer, geo, BLUR_FRAG, {
    tSrc: { value: null },
    uDir: { value: new THREE.Vector2() },
  });

  // Shared by the bright pass and the composite so the bloom threshold is
  // always measured against the same curve the frame is finally shown through.
  const exposureU = { value: 1 };
  const shoulderU = { value: 0.72 };
  const whiteU = { value: 1.0 };

  const bright = new Pass(renderer, geo, BRIGHT_FRAG, {
    tSrc: { value: rtHalf.texture },
    uExposure: exposureU, uShoulder: shoulderU, uWhite: whiteU,
    uThreshold: { value: 0.86 },
    uKnee: { value: 0.14 },
  });

  const composite = new Pass(renderer, geo, COMPOSITE_FRAG, {
    tScene: { value: rtScene.texture },
    tDepth: { value: rtScene.depthTexture },
    tAO: { value: rtAOb.texture },
    tBloom: { value: rtQb.texture },
    tBloomWide: { value: rtEb.texture },
    tFar: { value: rtHalfB.texture },
    uProj: projU, uNear: nearU, uFar: farU,
    uOutTexel: { value: new THREE.Vector2() },
    uAspectRatio: { value: 1.777 },
    uExposure: exposureU, uShoulder: shoulderU, uWhite: whiteU,
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uLiftFall: { value: 1.0 },
    uLiftToe: { value: new THREE.Vector3(0, 0, 0) },
    uGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uContrast: { value: 1 },
    uContrastPivot: { value: 0.5 },
    uContrastChroma: { value: 0.0 },
    uHiKnee: { value: 0.88 },
    uHiRecover: { value: 0.0 },
    uHiRecoverLo: { value: 0.88 },
    uLoKnee: { value: 0.0 },
    uSaturation: { value: 1 },
    uShadowTint: { value: new THREE.Vector3(1, 1, 1) },
    uHighTint: { value: new THREE.Vector3(1, 1, 1) },
    uSplitLo: { value: 0.05 },
    uSplitHi: { value: 0.95 },
    uAOStrength: { value: 0.6 },
    uAOTint: { value: new THREE.Vector3(0.55, 0.60, 0.70) },
    uBloom: { value: 0.35 },
    uBloomWide: { value: 0.25 },
    uDofNear: { value: 260 },
    uDofFar: { value: 900 },
    uDofAmount: { value: 0.7 },
    uVignette: { value: 0.28 },
    uVignetteSoft: { value: 0.05 },
    uCA: { value: 0.0016 },
    uGrain: { value: 0.0022 },
    uInvView: { value: new THREE.Matrix4() },
    // 1/34 cycles per metre => lobes ~34 m across, about a quarter of the
    // frame's 83 m width at the focus. Matches the patch size in target_01.
    uDappleScale: { value: 1 / 34 },
    uDapple: { value: 0.0 },
    uDappleWarm: { value: 0.0 },
    uDappleFine: { value: 0.0 },
    uDebug: { value: DEBUG },
  });

  const api = {
    enabled: true,
    grade: null,

    // Tuning surface. Every knob of the composite is reachable from the console
    // (and from the screenshot harness) so the look can be bisected empirically
    // instead of by editing shaders and reloading.
    u: composite.u,
    passes: { ao: aoPass, bright, composite },

    setCamera(cam) { if (cam) camera = cam; },

    setSize(w, h) {
      this._size = [w, h];
      const dpr = renderer.getPixelRatio();
      const outW = Math.max(2, Math.round(w * dpr));
      const outH = Math.max(2, Math.round(h * dpr));
      ss = this._ssOverride ?? THREE.MathUtils.clamp(Math.sqrt(maxPixels / (outW * outH)), 1.0, SSAA);
      W = Math.max(2, Math.round(outW * ss));
      H = Math.max(2, Math.round(outH * ss));

      rtScene.setSize(W, H);
      const hw = Math.max(2, W >> 1), hh = Math.max(2, H >> 1);
      const qw = Math.max(2, W >> 2), qh = Math.max(2, H >> 2);
      const ew = Math.max(2, W >> 3), eh = Math.max(2, H >> 3);
      rtAO.setSize(hw, hh); rtAOb.setSize(hw, hh);
      rtHalf.setSize(hw, hh); rtHalfB.setSize(hw, hh);
      rtQ.setSize(qw, qh); rtQb.setSize(qw, qh);
      rtE.setSize(ew, eh); rtEb.setSize(ew, eh);

      aoPass.u.uTexel.value.set(1 / hw, 1 / hh);
      down.u.uTexel.value.set(1 / W, 1 / H);
      composite.u.uOutTexel.value.set(1 / outW, 1 / outH);
      composite.u.uAspectRatio.value = outW / outH;
      this._out = [outW, outH];
      this._half = [hw, hh];
      this._q = [qw, qh];
      this._e = [ew, eh];
    },

    applyPalette(palette) {
      const g = gradeFor(palette);
      this.grade = g;
      const u = composite.u;
      u.uExposure.value = g.exposure;
      u.uShoulder.value = g.shoulder;
      u.uWhite.value = g.white;
      u.uLift.value.fromArray(g.lift);
      u.uLiftFall.value = g.liftFalloff ?? 1.0;
      u.uLiftToe.value.fromArray(g.liftToe ?? [0, 0, 0]);
      u.uGamma.value.fromArray(g.gamma);
      u.uGain.value.fromArray(g.gain);
      u.uContrast.value = g.contrast;
      u.uContrastPivot.value = g.contrastPivot ?? 0.5;
      u.uContrastChroma.value = g.contrastChroma ?? 0.0;
      u.uHiKnee.value = g.hiKnee ?? 0.88;
      u.uHiRecover.value = g.hiRecover ?? 0.0;
      u.uHiRecoverLo.value = g.hiRecoverRange?.[0] ?? 0.88;
      u.uLoKnee.value = g.loKnee ?? 0.0;
      u.uSaturation.value = g.saturation;
      u.uShadowTint.value.fromArray(g.shadowTint);
      u.uHighTint.value.fromArray(g.highTint);
      u.uSplitLo.value = g.splitRange?.[0] ?? 0.05;
      u.uSplitHi.value = g.splitRange?.[1] ?? 0.95;
      u.uAOStrength.value = g.ao;
      u.uAOTint.value.fromArray(g.aoTint);
      u.uBloom.value = g.bloom;
      u.uBloomWide.value = g.bloomWide;
      u.uDofAmount.value = g.dof;
      u.uVignette.value = g.vignette;
      u.uCA.value = g.ca;
      u.uDapple.value = g.dapple ?? 0;
      u.uDappleWarm.value = g.dappleWarm ?? 0;
      u.uDappleFine.value = g.dappleFine ?? 0;
      u.uGrain.value = g.grain ?? 0.0022;
      u.uDappleScale.value = 1 / (g.dappleMetres ?? 34);
      bright.u.uThreshold.value = g.bloomThreshold;
      aoPass.u.uIntensity.value = g.aoIntensity;
      aoPass.u.uR2.value = g.aoWide ?? 8.0;
    },

    render() {
      const cam = camera;

      // Report the whole frame's cost (scene + every post pass) in
      // renderer.info, not just the last pass — the shot manifests read it.
      renderer.info.autoReset = false;
      renderer.info.reset();

      // ------------------------------------------------------------ 1. scene
      //
      // The composite pass below does its OWN tone map (`shoulder`) and its own
      // sRGB encode. So the scene must land in this buffer as LINEAR, UNTONED
      // radiance — otherwise the frame is tone-mapped twice and sRGB-encoded
      // twice, which is exactly the milky blown-out look this used to produce.
      const prevTone = renderer.toneMapping;
      const prevExposure = renderer.toneMappingExposure;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;

      renderer.setRenderTarget(rtScene);
      renderer.clear(true, true, true);
      renderer.render(scene, cam);

      renderer.toneMapping = prevTone;
      renderer.toneMappingExposure = prevExposure;

      const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
      projU.value.set(tanHalf * cam.aspect, tanHalf);
      nearU.value = cam.near;
      farU.value = cam.far;
      // World reconstruction for the broken-light term: view -> world.
      composite.u.uInvView.value.copy(cam.matrixWorld);

      // -------------------------------------------------------------- 2. AO
      aoPass.u.uAspect.value.set(1 / cam.aspect, 1);
      aoPass.render(rtAO);
      aoBlur.u.tAO.value = rtAO.texture;
      aoBlur.u.uDir.value.set(1 / this._half[0], 0);
      aoBlur.render(rtAOb);
      aoBlur.u.tAO.value = rtAOb.texture;
      aoBlur.u.uDir.value.set(0, 1 / this._half[1]);
      aoBlur.render(rtAO);
      composite.u.tAO.value = rtAO.texture;

      // ------------------------------------------------- 3. half-res + far blur
      down.u.tSrc.value = rtScene.texture;
      down.u.uTexel.value.set(1 / W, 1 / H);
      down.render(rtHalf);

      blur.u.tSrc.value = rtHalf.texture;
      blur.u.uDir.value.set(1.35 / this._half[0], 0);
      blur.render(rtHalfB);
      blur.u.tSrc.value = rtHalfB.texture;
      blur.u.uDir.value.set(0, 1.35 / this._half[1]);
      blur.render(rtHalf);
      composite.u.tFar.value = rtHalf.texture;

      // ---------------------------------------------------------- 4. bloom
      bright.u.tSrc.value = rtHalf.texture;   // already slightly blurred: cheap and smooth
      bright.render(rtQ);
      blur.u.tSrc.value = rtQ.texture;
      blur.u.uDir.value.set(1.2 / this._q[0], 0);
      blur.render(rtQb);
      blur.u.tSrc.value = rtQb.texture;
      blur.u.uDir.value.set(0, 1.2 / this._q[1]);
      blur.render(rtQ);
      composite.u.tBloom.value = rtQ.texture;

      down.u.tSrc.value = rtQ.texture;
      down.u.uTexel.value.set(1 / this._q[0], 1 / this._q[1]);
      down.render(rtE);
      blur.u.tSrc.value = rtE.texture;
      blur.u.uDir.value.set(1.6 / this._e[0], 0);
      blur.render(rtEb);
      blur.u.tSrc.value = rtEb.texture;
      blur.u.uDir.value.set(0, 1.6 / this._e[1]);
      blur.render(rtE);
      composite.u.tBloomWide.value = rtE.texture;

      // ------------------------------------------------------- 5. composite
      // The camera publishes how far its focus point is (see camera.js); the
      // far field starts well beyond it so the car is never soft.
      const focus = cam.userData?.focusDistance ?? this._focusDist ?? 180;
      composite.u.uDofNear.value = focus * 1.55;
      composite.u.uDofFar.value = focus * 6.0;
      renderer.setRenderTarget(null);
      composite.render(null);
    },

    /** Optional hint: how far the focus point is, if the camera does not say. */
    setFocusDistance(d) { this._focusDist = d; },

    /** Bench hook: force a supersample factor (null = back to the default). */
    setSupersample(v) {
      this._ssOverride = v == null ? null : THREE.MathUtils.clamp(v, 1.0, 2.0);
      if (this._size) this.setSize(this._size[0], this._size[1]);
    },
    get supersample() { return ss; },

    dispose() {
      for (const rt of [rtScene, rtAO, rtAOb, rtHalf, rtHalfB, rtQ, rtQb, rtE, rtEb]) rt.dispose();
    },
  };

  const size = renderer.getSize(new THREE.Vector2());
  api.setSize(size.x, size.y);
  api.applyPalette(ctx.palette ?? {});
  return api;
}

export { GRADES };
