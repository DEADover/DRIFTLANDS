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
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;
  container.appendChild(renderer.domElement);
  return renderer;
}

const PI = Math.PI;

/** Value of a fully-lit horizontal surface, as a fraction of its albedo. */
const KEY = 0.97;

/** How much of the total light budget survives in shadow, per biome mood. */
function shadowFloor(p) {
  const sun = p.sunIntensity ?? 3;
  const amb = p.ambientIntensity ?? 1;
  const share = amb / (sun + amb); // 0.22 .. 0.38 across our palettes
  // Compress into a designed band: shadow must be a clean step, never a hole.
  return THREE.MathUtils.clamp(0.40 + 0.55 * share, 0.48, 0.62);
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
    this.sun.shadow.normalBias = 0.035;
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
    this._el = p.sunElevation;

    const floor = shadowFloor(p);
    const fillShare = 0.20;             // fraction of the ambient budget given to the rim fill

    // The ground is the picture's mid value, and the ground is horizontal — so
    // normalise the sun by its own elevation. Without this, a 5° dusk sun makes
    // the same palette read four stops darker than a 54° desert one.
    const sinEl = THREE.MathUtils.clamp(Math.sin(p.sunElevation ?? 0.7), 0.30, 1.0);
    const sunTerm = (KEY * (1 - floor)) / sinEl;
    const ambTerm = KEY * floor * (1 - fillShare);
    const fillTerm = KEY * floor * fillShare;

    // three's lambert BRDF divides irradiance by PI, so multiply it back in.
    this.sun.color.copy(tint(p.sunColor, 0.35));
    this.sun.intensity = PI * sunTerm;

    // A high sun wants a near-neutral ambient; a dusk sun IS its ambient hue,
    // so keep more of the palette's colour as the sun drops.
    const desat = THREE.MathUtils.lerp(0.30, 0.54, THREE.MathUtils.clamp((p.sunElevation ?? 0.7) / 0.8, 0, 1));
    this.hemi.color.copy(tint(p.ambientSky, desat));
    this.hemi.groundColor.copy(tint(p.ambientGround, desat + 0.06)).multiplyScalar(0.85);
    this.hemi.intensity = PI * ambTerm;

    this.fill.color.copy(tint(p.ambientSky, desat - 0.08));
    this.fill.intensity = PI * fillTerm * 1.7; // directional, so only ~half the surfaces see it
    this.fill.position.set(
      -Math.cos(p.sunAzimuth) * 100,
      52,
      -Math.sin(p.sunAzimuth) * 100
    );

    // Long shadows need a long box. Grows as the sun drops.
    const el = Math.max(0.06, p.sunElevation);
    this._half = THREE.MathUtils.clamp(96 + 9 / Math.tan(el), 105, 190);
    const c = this.sun.shadow.camera;
    c.left = -this._half;
    c.right = this._half;
    c.top = this._half;
    c.bottom = -this._half;
    c.near = 1;
    c.far = 2.6 * this._half + 420;
    c.updateProjectionMatrix();
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
   */
  _ensureShadowCasters() {
    this.scene.traverse((o) => {
      if (!o.isMesh || o.userData.noShadow) return;
      if (o.name === 'sky') return;
      const m = o.material;
      if (!m || m.transparent || m.depthWrite === false) return; // water, skids, fx
      o.receiveShadow = true;
      if (o.castShadow) return;
      // Ground planes receive but must not cast: a 1600m heightfield in the
      // shadow frustum destroys the depth range for everything else.
      const r = o.geometry?.boundingSphere?.radius
        ?? (o.geometry?.computeBoundingSphere?.(), o.geometry?.boundingSphere?.radius ?? 0);
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
