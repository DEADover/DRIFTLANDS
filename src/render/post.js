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
 *                FXAA mush) + AO + DoF + bloom + tone map + per-biome grade +
 *                vignette + chromatic falloff + dither, straight to the canvas.
 *
 * Everything preserves hard facet edges: no blur is ever applied to the
 * in-focus image, and the only spatial filter on it is a box downsample of a
 * higher-resolution render.
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
  uniform float uFade;        // distance at which AO stops mattering
  uniform float uSeed;

  const int SAMPLES = 11;

  /**
   * Bounded occlusion estimator: every sample contributes at most 1, so
   * uIntensity means exactly "darkness when fully enclosed". Physically looser
   * than the SAO estimator, but this is art direction, not a light transport
   * solver — and a knob that means something is worth more than one that does not.
   */
  float occlude(vec3 P, vec3 N, vec3 S, float R) {
    vec3 V = S - P;
    float d = length(V);
    if (d < 1e-4) return 0.0;
    float ndv = dot(N, V) / d;
    // Angle bias, not a depth bias: anything within ~asin(uBias) of the tangent
    // plane is the terrain's own faceting, not an occluder. Constant biases
    // leave long streaks along every facet crease.
    return smoothstep(uBias, uBias + 0.30, ndv) * (1.0 - smoothstep(R * 0.5, R, d));
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
      if (d1 < 0.9999) s1 += occlude(P, N, viewPos(u1, d1), uR1);
      if (d2 < 0.9999) s2 += occlude(P, N, viewPos(u2, d2), uR2);
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

// --------------------------------------------------------------- composite
const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  ${DEPTH_UTIL}
  ${TONEMAP}
  uniform sampler2D tScene;
  uniform sampler2D tAO;
  uniform sampler2D tBloom;
  uniform sampler2D tBloomWide;
  uniform sampler2D tFar;
  uniform vec2 uOutTexel;      // 1 / output size
  uniform float uAspectRatio;

  uniform vec3  uLift;
  uniform vec3  uGamma;
  uniform vec3  uGain;
  uniform float uContrast;
  uniform float uSaturation;
  uniform vec3  uShadowTint;
  uniform vec3  uHighTint;

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

    col = col * uGain + uLift * (1.0 - col);
    col = pow(max(col, 0.0), uGamma);
    col = (col - 0.5) * uContrast + 0.5;
    float l = dot(max(col, 0.0), LUMA);
    col = mix(vec3(l), col, uSaturation);
    col *= mix(uShadowTint, uHighTint, smoothstep(0.05, 0.95, l));

    // ---- vignette
    float v = 1.0 - uVignette * smoothstep(uVignetteSoft, 1.30, r2 * 1.9);
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

  const maxPixels = 9.2e6;   // supersampling budget
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

  const rtAO = new THREE.WebGLRenderTarget(2, 2, { ...colorOpts, type: THREE.UnsignedByteType });
  const rtAOb = new THREE.WebGLRenderTarget(2, 2, { ...colorOpts, type: THREE.UnsignedByteType });
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
    uGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uContrast: { value: 1 },
    uSaturation: { value: 1 },
    uShadowTint: { value: new THREE.Vector3(1, 1, 1) },
    uHighTint: { value: new THREE.Vector3(1, 1, 1) },
    uAOStrength: { value: 0.6 },
    uAOTint: { value: new THREE.Vector3(0.55, 0.60, 0.70) },
    uBloom: { value: 0.35 },
    uBloomWide: { value: 0.25 },
    uDofNear: { value: 260 },
    uDofFar: { value: 900 },
    uDofAmount: { value: 0.7 },
    uVignette: { value: 0.28 },
    uVignetteSoft: { value: 0.18 },
    uCA: { value: 0.0016 },
    uGrain: { value: 0.0022 },
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
      const dpr = renderer.getPixelRatio();
      const outW = Math.max(2, Math.round(w * dpr));
      const outH = Math.max(2, Math.round(h * dpr));
      ss = THREE.MathUtils.clamp(Math.sqrt(maxPixels / (outW * outH)), 1.0, 2.0);
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
      u.uGamma.value.fromArray(g.gamma);
      u.uGain.value.fromArray(g.gain);
      u.uContrast.value = g.contrast;
      u.uSaturation.value = g.saturation;
      u.uShadowTint.value.fromArray(g.shadowTint);
      u.uHighTint.value.fromArray(g.highTint);
      u.uAOStrength.value = g.ao;
      u.uAOTint.value.fromArray(g.aoTint);
      u.uBloom.value = g.bloom;
      u.uBloomWide.value = g.bloomWide;
      u.uDofAmount.value = g.dof;
      u.uVignette.value = g.vignette;
      u.uCA.value = g.ca;
      bright.u.uThreshold.value = g.bloomThreshold;
      aoPass.u.uIntensity.value = g.aoIntensity;
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
