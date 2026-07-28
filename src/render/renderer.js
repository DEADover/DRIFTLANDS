import * as THREE from 'three';

/**
 * Renderer + lighting rig. The look of the game is decided here and in
 * palette.js. Keep the two in sync: this file consumes a Palette.
 */
export function createRenderer(container, { pixelRatio } = {}) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  return renderer;
}

export class LightRig {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;

    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    const c = this.sun.shadow.camera;
    c.near = 1;
    c.far = 600;
    c.left = -160;
    c.right = 160;
    c.top = 160;
    c.bottom = -160;
    this.sunTarget = new THREE.Object3D();
    scene.add(this.sun, this.sunTarget);
    this.sun.target = this.sunTarget;

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
    scene.add(this.hemi);

    /** Rim/fill from the opposite side keeps silhouettes from going muddy. */
    this.fill = new THREE.DirectionalLight(0xffffff, 0.35);
    scene.add(this.fill);
  }

  applyPalette(p) {
    this.sun.color.setHex(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    this.hemi.color.setHex(p.ambientSky);
    this.hemi.groundColor.setHex(p.ambientGround);
    this.hemi.intensity = p.ambientIntensity;
    this.fill.color.setHex(p.ambientSky);
    this._az = p.sunAzimuth;
    this._el = p.sunElevation;
    this.fill.position.set(
      -Math.cos(p.sunAzimuth) * 100,
      60,
      -Math.sin(p.sunAzimuth) * 100
    );
  }

  /** Keep the shadow frustum tight around the player for crisp contact shadows. */
  follow(target) {
    const d = 220;
    const az = this._az ?? 2.35;
    const el = this._el ?? 0.7;
    this.sunTarget.position.copy(target);
    this.sun.position.set(
      target.x + Math.cos(az) * Math.cos(el) * d,
      target.y + Math.sin(el) * d,
      target.z + Math.sin(az) * Math.cos(el) * d
    );
    this.sun.target.updateMatrixWorld();
  }
}
