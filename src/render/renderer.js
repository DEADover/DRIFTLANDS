import * as THREE from 'three';

/**
 * Renderer + lighting rig. The look of the game is decided here, in post.js and
 * in palette.js.
 *
 * LIGHTING DOCTRINE
 * -----------------
 * The reference's whole graphic identity is *value structure*: a mid-value
 * ground, a clean step darker in shadow, long directional shadows describing
 * the terrain, and the car as the brightest/most saturated thing in frame.
 * So the rig does not use the palette's raw intensities — it renormalises them
 * so that a fully-lit surface lands at ~1.0 * albedo and a shadowed surface at
 * a *designed* fraction of that (see SHADOW_FLOOR). Tone mapping then happens
 * once, in post, on the whole composited image.
 *
 * Shadows: single tight ortho frustum fitted around the player, sized by the
 * sun elevation (low sun = long shadows = bigger box), snapped to shadow-map
 * texels so the shadow edges do not crawl while the camera moves.
 */

export function createRenderer(container, { pixelRatio } = {}) {
  const renderer = new THREE.WebGLRenderer({
    // No MSAA on the default framebuffer: everything is drawn into an
    // offscreen supersampled target and resolved by post.js.
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
  });
  renderer.setPixelRatio(pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Tone mapping is done by post.js on the composited HDR buffer. Leaving this
  // as ACES only affects direct-to-canvas draws (there are none).
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  // PCFShadowMap, not PCFSoft: only this branch of three's shader honours
  // `light.shadow.radius`, and a tunable penumbra is the whole point — the
  // references have soft-edged shadows, and PCFSoft's fixed kernel gives a hard
  // one. (VSM was tried and rejected: it moirés badly across a low-poly
  // heightfield.) The radius itself is set in LightRig, in metres.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;
  container.appendChild(renderer.domElement);
  return renderer;
}

const PI = Math.PI;

/**
 * SHADOW LENGTH IS ART DIRECTION, NOT ASTRONOMY.
 *
 * A shadow is `1/tan(elevation)` times the caster's height. The references sit
 * at 1.0-1.5x — short, readable, and they let you see the ground the object is
 * standing on. Palettes are free to author a mood-driven sun elevation; the rig
 * clamps it into the band that produces those lengths, because a 28° sun (what
 * alpine asked for) throws a 1.9x shadow that reads as late afternoon and eats
 * the meadow.
 *
 *   0.98 rad = 56.1°  ->  0.67x height in world, ~1.09x ON SCREEN
 *   1.12 rad = 64.2°  ->  0.48x height in world, ~0.79x ON SCREEN
 *
 * The two numbers differ because the camera is tilted: a vertical object is
 * squashed to cos(52) = 0.62 of its height on screen while the ground it
 * stands on is not, so a world shadow of 1.0x READS as 1.6x. MEASURED off
 * ref/target_01 (fence posts and the isolated conifer at ~(780,20)+): the
 * reference's shadows read at 0.3-0.6x on screen. This band is deliberately a
 * little longer than that so shadows still describe the light's direction,
 * but it is far shorter than the 1.9x this used to throw.
 *
 * Exported so sky.js can put the sun disc where the shadows say it is.
 */
export const SHADOW_ELEVATION = [0.98, 1.12];
export function sunElevationFor(p) {
  return THREE.MathUtils.clamp(p?.sunElevation ?? 0.7, SHADOW_ELEVATION[0], SHADOW_ELEVATION[1]);
}

/** World-space width of the shadow penumbra, in metres. */
const PENUMBRA = 0.85;

/**
 * Shadow budget (see _ensureShadowCasters). Instanced scatter with at least
 * SCATTER_COUNT copies and a per-instance radius below MIN_CASTER metres is
 * grounded by the contact AO in post.js instead of by the shadow map.
 * MIN_CASTER is deliberately just under the AO's tight radius (2.2 m).
 */
const MIN_CASTER = 2.0;
const SCATTER_COUNT = 300;

/** Value of a fully-lit horizontal surface, as a fraction of its albedo. */
const KEY = 0.97;

/**
 * How much of the total light budget survives in shadow, per biome mood.
 *
 * MEASURED off target_01: lit grass #7cc24a, the same grass under a conifer
 * #3a7a2e. In linear that is a factor of (0.25, 0.42, 0.39) — so a shadowed
 * surface keeps a bit over 0.4 of its lit value, and it keeps it UNEVENLY:
 * green and blue survive, red is eaten. The uneven part is the ambient's hue
 * (see `tint` below) and the post AO tint; this number is the level.
 * Direct light alone lands ~0.46 and AO takes the contact points lower.
 */
function shadowFloor(p) {
  const sun = p.sunIntensity ?? 3;
  const amb = p.ambientIntensity ?? 1;
  const share = amb / (sun + amb); // 0.22 .. 0.38 across our palettes
  // Compress into a designed band: shadow must be a clean step, never a hole.
  //
  // ROUND 3, MEASURED (tools/measure.mjs greenBands): shadowed grass in
  // target_01 sits at #193217 and lit grass at #7d900c. Ours sat at #184917 —
  // the reds and blues matched to within a value or two, but the GREEN in
  // shadow was 73 against the reference's 50. The step down into shadow was
  // simply not deep enough, and a shallow step is most of why the meadow read
  // flat. Alpine's share is 0.229, so the old curve handed it 0.455; this one
  // hands it 0.331. Still a clean coloured step, never a hole: measured darkPct
  // (fraction of the frame below luma 18) stays at 0.16%.
  //
  // ROUND 4, MEASURED (tools/patch_rp.mjs): grass in tree shadow in target_01
  // is luma 43-74 with R/G 0.53-0.74; ours was luma 69 with R/G 0.83 — a step
  // that is both too shallow and too warm, because a shallow step leaves the
  // (red-heavy) direct term still visible in it. Alpine's share is 0.229, so
  // the old curve handed it 0.331 and this one hands it 0.293. Measured frame
  // p05 moves 49 -> 44 against the reference's 33, and darkPct (fraction below
  // luma 18) stays under 0.5%: still a coloured step, still not a hole.
  //
  // ROUND 5, MEASURED (tools/measure.mjs, dominant colour bins). This is the
  // number the histogram was really asking about. The reference's meadow reads
  // as three separated values — #8b8b17 in the sun (luma 0.51), #2e4617 in tree
  // shadow (0.24), #172e17 in the deep (0.16) — and that separation is why its
  // luma histogram is a plateau (21.5 / 22 / 17.5 across three buckets). Ours
  // read #5d7417 in the sun (0.41) and #464617 in shadow (0.28): the same
  // meadow, 0.13 of display range wide instead of 0.29.
  //
  // A grade cannot invent that. Solving for the affine contrast that maps our
  // pair onto the reference's gives a slope of 2.2 ON TOP of the 1.43 already
  // there — a curve that would posterise every facet in the frame. The
  // separation has to come from the LIGHT, and this is the only number that
  // sets it. 0.293 -> 0.215 is that same solve done here instead, where it
  // costs nothing but a darker shadow.
  //
  // Still a clean coloured step and not a hole: the shadow keeps 0.215 of the
  // full budget, the ambient supplying it is the palette's sky hue (see `tint`
  // below, deliberately barely desaturated), and the frame's darkest luma
  // bucket lands at 0.9% — exactly the reference's 0.9%.
  return THREE.MathUtils.clamp(0.145 + 0.305 * share, 0.20, 0.42);
}

const _c = new THREE.Color();
/**
 * Palettes supply HUE; the rig supplies VALUE. Each light colour is pulled
 * toward white by `desat` and then normalised to unit luminance, so a light's
 * intensity means exactly what the doctrine above says it means — and so a
 * saturated blue sky ambient cannot crush the red channel out of every shadow.
 */
function tint(hex, desat) {
  _c.setHex(hex).lerp(WHITE, desat);
  const luma = 0.2126 * _c.r + 0.7152 * _c.g + 0.0722 * _c.b;
  if (luma > 1e-4) _c.multiplyScalar(1 / luma);
  return _c;
}
const WHITE = new THREE.Color(1, 1, 1);

export class LightRig {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;

    this.sun = new THREE.DirectionalLight(0xffffff, 2.0);
    this.sun.castShadow = true;
    // 4k + a tight fitted frustum ≈ 0.055 m per texel: contact points stay
    // attached and the edges read as deliberate hard graphics, like the
    // reference, instead of the stair-stepped mess a loose frustum gives.
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.075;   // scaled with the wider PCF disc below
    const c = this.sun.shadow.camera;
    c.near = 1;
    c.far = 900;
    this.sunTarget = new THREE.Object3D();
    scene.add(this.sun, this.sunTarget);
    this.sun.target = this.sunTarget;

    /** Sky dome ambient. Blue-ish from above = the bounce that fills shadow. */
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
    scene.add(this.hemi);

    /**
     * Bounce fill from the anti-sun side, sky coloured and shadowless. Keeps
     * silhouettes from going muddy and stops shadowed faces reading as holes.
     */
    this.fill = new THREE.DirectionalLight(0xffffff, 0.3);
    this.fill.castShadow = false;
    scene.add(this.fill);

    this._half = 120;
    this._az = 2.35;
    this._el = 0.7;
    this._basisDirty = true;
    this._f = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._center = new THREE.Vector3();
  }

  applyPalette(p) {
    this._az = p.sunAzimuth;
    this._el = sunElevationFor(p);

    const floor = shadowFloor(p);
    const fillShare = 0.20;             // fraction of the ambient budget given to the rim fill

    // The ground is the picture's mid value, and the ground is horizontal — so
    // normalise the sun by its own elevation. Without this, a 5° dusk sun makes
    // the same palette read four stops darker than a 54° desert one.
    const sinEl = THREE.MathUtils.clamp(Math.sin(this._el), 0.30, 1.0);
    const sunTerm = (KEY * (1 - floor)) / sinEl;
    const ambTerm = KEY * floor * (1 - fillShare);
    const fillTerm = KEY * floor * fillShare;

    // three's lambert BRDF divides irradiance by PI, so multiply it back in.
    // Keep more of the sun's warmth (0.35 -> 0.20 toward white): the reference's
    // "high-key warm light" is not brightness, it is the WARM KEY / COOL FILL
    // split. `tint` normalises luminance, so this is hue only.
    this.sun.color.copy(tint(p.sunColor, 0.20));
    this.sun.intensity = PI * sunTerm;

    // SHADOW MUST BE COLOURED, NEVER NEUTRAL. What fills a shadow is sky above
    // and bounce off the ground beside it — so the shadow's hue is the ambient's
    // hue, and pulling the ambient toward white (which the old 0.30-0.54 desat
    // did) is exactly how you get the grey shadows the brief rejects. Keep most
    // of the palette's sky/ground colour; `tint` still normalises luminance, so
    // this changes hue only and cannot darken the picture.
    // ROUND 3, MEASURED: in target_01 the shadow/lit ratio of meadow grass is
    // (0.20, 0.35, 1.92) — the blue channel is nearly TWICE as strong in shadow
    // as in light, because what fills a shadow is sky. Ours came out
    // (0.18, 0.45, 0.96): too much surviving green, and no blue lift at all.
    // Pulling the ambient a third less toward white keeps the palette's sky hue
    // in the fill, which is the only thing that can produce that blue ratio.
    const desat = THREE.MathUtils.lerp(0.10, 0.23, THREE.MathUtils.clamp(this._el / 0.8, 0, 1));
    this.hemi.color.copy(tint(p.ambientSky, desat));
    this.hemi.groundColor.copy(tint(p.ambientGround, desat + 0.06)).multiplyScalar(0.85);
    this.hemi.intensity = PI * ambTerm;

    this.fill.color.copy(tint(p.ambientSky, Math.max(0, desat - 0.06)));
    // Directional, so only ~half the surfaces see it — hence a multiplier above
    // 1. But 1.7 was aiming it straight at the one thing the frame needed dark.
    // MEASURED (tools/measure.mjs): the reference puts 15.0% of its pixels in
    // the 0.1-0.2 luma bucket and 0.9% below 0.1; ours put 9.0% and 1.1%. The
    // missing mass is the anti-sun face of every conifer — the reference's
    // canopies read as near-black silhouettes with a lit rim, ours read as one
    // mid green all the way round (measured 0.306 on the shaded face against a
    // lit face barely 0.14 above it). A shadowless light pointed at exactly
    // those faces at 1.7x was the reason. 1.05 still keeps them off zero, which
    // is all this light was ever supposed to do.
    this.fill.intensity = PI * fillTerm * 1.05;
    this.fill.position.set(
      -Math.cos(p.sunAzimuth) * 100,
      52,
      -Math.sin(p.sunAzimuth) * 100
    );

    // Shadow box. Now that the sun is held in a short-shadow band this no longer
    // has to grow for a raking dusk sun, so it stays tight and the map stays
    // sharp where it matters.
    // Sized for what the camera can actually see: at distance 78 / 52 deg the
    // frame covers roughly 83 m across at the focus and ~130 m at the top edge,
    // so a +-80 m box (biased up-sun in `follow`) covers it with room to spare.
    // Tighter box = 0.039 m per texel = contact points that stay attached.
    this._half = THREE.MathUtils.clamp(72 + 9 / Math.tan(this._el), 78, 120);
    const c = this.sun.shadow.camera;
    c.left = -this._half;
    c.right = this._half;
    c.top = this._half;
    c.bottom = -this._half;
    c.near = 1;
    c.far = 2.6 * this._half + 420;
    c.updateProjectionMatrix();

    // Penumbra in METRES, not texels: three scales the Vogel disk by
    // `radius * texelSize`, and texelSize depends on the box we just fitted, so
    // expressing it any other way makes the softness drift with the sun angle.
    const metresPerTexel = (2 * this._half) / this.sun.shadow.mapSize.x;
    this.sun.shadow.radius = THREE.MathUtils.clamp(PENUMBRA / metresPerTexel, 2, 40);
    this._basisDirty = true;

    this.shadowFloor = floor;
  }

  _updateBasis() {
    const az = this._az, el = this._el;
    // Direction from target toward the light (three's lookAt +Z axis).
    this._f.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
    this._right.set(0, 1, 0).cross(this._f).normalize();
    this._up.copy(this._f).cross(this._right).normalize();
    this._basisDirty = false;
  }

  /**
   * SAFETY NET: anything solid in the scene casts and receives. Several
   * subsystems (the car most visibly) never set castShadow, and an object with
   * no shadow reads as floating no matter how good the rest of the image is.
   * Cheap rescan — the graph is a few hundred nodes and this runs twice a
   * second. Owners can opt out with `userData.noShadow = true`.
   *
   * IT IS ALSO THE SHADOW BUDGET.
   *
   * MEASURED (tools/inventory_rp.mjs + tools/perf_rp.mjs, alpine hero, 1600x900):
   * the frame draws 3.00M triangles, of which 2.89M are ALSO drawn into the
   * shadow map — so the shadow pass is half the triangle count of the whole
   * frame and 22.6% of its time. Dropping the shadow map from 4096 to 2048 buys
   * only 3.2%, which says the cost is geometry submission, not fill. The only
   * honest saving is to submit less geometry.
   *
   * The scatter is where it lives: 8.3k grass tussocks, 1.7k flower clumps and
   * 4.9k pebble slabs together are 1.1M of those triangles, and every one of
   * them is a sub-2-metre object whose entire contribution to the image is a
   * soft dark pool at its own base — which post.js's 2.2 m contact AO already
   * draws, from depth, for free. So mass scatter below MIN_CASTER metres does
   * not enter the shadow map. Trees, rocks, posts, buildings, animals and the
   * car all clear the threshold and are untouched.
   */
  _ensureShadowCasters() {
    this.scene.traverse((o) => {
      if (!o.isMesh || o.userData.noShadow) return;
      if (o.name === 'sky') return;
      const m = o.material;
      if (!m || m.transparent || m.depthWrite === false) return; // water, skids, fx
      o.receiveShadow = true;
      const r = o.geometry?.boundingSphere?.radius
        ?? (o.geometry?.computeBoundingSphere?.(), o.geometry?.boundingSphere?.radius ?? 0);
      // Mass scatter smaller than the contact-AO radius: not worth a shadow pass.
      if (o.isInstancedMesh && o.count >= SCATTER_COUNT && r < MIN_CASTER) {
        if (o.castShadow) o.castShadow = false;
        return;
      }
      if (o.castShadow) return;
      // Ground planes receive but must not cast: a 1600m heightfield in the
      // shadow frustum destroys the depth range for everything else.
      if (r > 160) return;
      o.castShadow = true;
    });
  }

  /**
   * Keep the shadow frustum tight around the player, snapped to texel
   * boundaries in light space so edges do not shimmer as the camera moves.
   */
  follow(target) {
    if ((this._scanTick = (this._scanTick ?? 0) - 1) <= 0) {
      this._scanTick = 30;
      this._ensureShadowCasters();
    }
    if (this._basisDirty) this._updateBasis();
    const d = 1.6 * this._half + 180;
    const texel = (2 * this._half) / this.sun.shadow.mapSize.x;

    // Bias the box toward the sun so off-screen casters up-sun still fit.
    this._center.copy(target).addScaledVector(this._f, this._half * 0.22);

    const a = Math.round(this._center.dot(this._right) / texel) * texel;
    const b = Math.round(this._center.dot(this._up) / texel) * texel;
    const cc = this._center.dot(this._f);
    this._center.set(0, 0, 0)
      .addScaledVector(this._right, a)
      .addScaledVector(this._up, b)
      .addScaledVector(this._f, cc);

    this.sunTarget.position.copy(this._center);
    this.sun.position.copy(this._center).addScaledVector(this._f, d);
    this.sunTarget.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }
}
