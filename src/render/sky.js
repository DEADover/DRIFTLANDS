import * as THREE from 'three';
import { sunElevationFor } from './renderer.js';

/**
 * SKY DOME + fog.
 *
 * Three ingredients, all flat and poster-like:
 *   1. a three-stop vertical ramp (haze band -> horizon -> zenith) that lands
 *      the horizon colour exactly on the fog colour, so the terrain dissolves
 *      into the sky instead of ending at a seam;
 *   2. a sun with a crisp disc, a tight limb and a wide low-frequency glow —
 *      post.js turns that into restrained bloom;
 *   3. optional STYLISED clouds: value-noise projected onto a flat plane and
 *      then hard-quantised into two tones. Cut paper, never volumetric mush.
 */

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // force to far plane
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uHaze;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform vec3 uCloudLo;
  uniform vec3 uCloudHi;
  uniform float uSunSize;
  uniform float uSunGlow;
  uniform float uCloud;
  uniform float uCloudScale;
  uniform float uWind;
  varying vec3 vDir;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.55;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
    return s;
  }

  void main() {
    vec3 d = normalize(vDir);
    float t = clamp(d.y, -1.0, 1.0);

    // --- vertical ramp -------------------------------------------------
    float up = clamp(t * 1.06 + 0.02, 0.0, 1.0);
    vec3 col = mix(uHorizon, uTop, pow(up, 0.58));
    // Haze band hugging the horizon; below it, everything is haze.
    float haze = exp(-max(t, 0.0) * 16.0);
    col = mix(col, uHaze, haze * 0.85);
    col = mix(col, uHaze, clamp(-t * 8.0, 0.0, 1.0));

    // --- stylised clouds ------------------------------------------------
    if (uCloud > 0.001) {
      float y = max(d.y, 0.035);
      vec2 q = (d.xz / y) * uCloudScale + vec2(uWind, uWind * 0.31);
      float n = fbm(q);
      float lo = 0.60 - uCloud * 0.34;
      float e = smoothstep(lo, lo + 0.035, n);
      float lit = smoothstep(lo + 0.10, lo + 0.135, n);
      vec3 cc = mix(uCloudLo, uCloudHi, lit);
      float fade = smoothstep(0.035, 0.30, d.y);
      col = mix(col, cc, e * fade * 0.92);
    }

    // --- sun ------------------------------------------------------------
    vec3 sd = normalize(uSunDir);
    float c = dot(d, sd);
    float ang = uSunSize * 0.016;
    float disc = smoothstep(cos(ang * 2.1), cos(ang * 0.85), c);
    col += uSunColor * pow(max(c, 0.0), 900.0) * 3.0;
    col = mix(col, uSunColor * 2.1, disc * 0.9);
    col += uSunColor * pow(max(c, 0.0), 40.0) * 0.30 * uSunGlow;
    col += uSunColor * pow(max(c, 0.0), 5.0) * 0.10 * uSunGlow;

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Cloud coverage per biome. 0 = clear. Kept low: emptiness is the composition. */
const CLOUDS = {
  'Alpine Meadows': { cover: 0.42, scale: 0.55, glow: 1.0 },
  'Ember Woodland': { cover: 0.50, scale: 0.42, glow: 1.5 },
  'Vermilion Mesa': { cover: 0.16, scale: 0.70, glow: 0.9 },
  'Cobalt Coast': { cover: 0.58, scale: 0.38, glow: 2.0 },
  'Glacier Pass': { cover: 0.30, scale: 0.60, glow: 1.2 },
};

export class Sky {
  constructor(palette) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x2e6fd6) },
        uHorizon: { value: new THREE.Color(0xa9d8f5) },
        uHaze: { value: new THREE.Color(0xbfe0f2) },
        uSunColor: { value: new THREE.Color(0xfff2d6) },
        uSunDir: { value: new THREE.Vector3(1, 0.5, 0) },
        uCloudLo: { value: new THREE.Color(0xc8d8e8) },
        uCloudHi: { value: new THREE.Color(0xffffff) },
        uSunSize: { value: 1.0 },
        uSunGlow: { value: 1.0 },
        uCloud: { value: 0.4 },
        uCloudScale: { value: 0.55 },
        uWind: { value: 0.0 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 20), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    this.mesh.name = 'sky';
    this.applyPalette(palette);
  }

  applyPalette(p) {
    const u = this.material.uniforms;
    u.uTop.value.setHex(p.skyTop);
    u.uHorizon.value.setHex(p.skyHorizon);
    u.uHaze.value.setHex(p.fogColor ?? p.skyHorizon);
    u.uSunColor.value.setHex(p.sunColor);
    // Use the SAME elevation the light rig clamped to (renderer.js), or the sun
    // disc ends up somewhere the shadows disagree with.
    const el = sunElevationFor(p);
    u.uSunDir.value.set(
      Math.cos(p.sunAzimuth) * Math.cos(el),
      Math.sin(el),
      Math.sin(p.sunAzimuth) * Math.cos(el)
    );

    const cl = CLOUDS[p.name] ?? { cover: 0.35, scale: 0.55, glow: 1.0 };
    u.uCloud.value = cl.cover;
    u.uCloudScale.value = cl.scale;
    u.uSunGlow.value = cl.glow;
    // A low sun makes a bigger, softer disc; a high sun a small hard one.
    u.uSunSize.value = THREE.MathUtils.lerp(1.6, 0.85, THREE.MathUtils.clamp(el / 0.9, 0, 1));

    // Cloud tones: a shadowed body and a sun-lit top. Two flat values only.
    const lo = new THREE.Color(p.skyHorizon).lerp(new THREE.Color(p.skyTop), 0.30);
    lo.lerp(new THREE.Color(0xffffff), 0.30);
    const hi = new THREE.Color(p.sunColor).lerp(new THREE.Color(0xffffff), 0.45);
    u.uCloudLo.value.copy(lo);
    u.uCloudHi.value.copy(hi);
  }

  follow(camPos) {
    this.mesh.position.copy(camPos);
  }
}

/**
 * Aerial perspective, per biome. The palette densities are authored for "how
 * hazy is this place"; these scales are "how much of the picture may the haze
 * eat". At a 61° camera the far edge of frame is ~3x further than the car, so
 * anything above ~0.0015 turns the top third into soup — which is exactly what
 * was happening to the dusk biome.
 */
const FOG_SCALE = {
  'Alpine Meadows': 0.95,
  'Ember Woodland': 0.60,
  'Vermilion Mesa': 0.80,
  'Cobalt Coast': 0.34,
  'Glacier Pass': 0.72,
};

export function applyFog(scene, palette) {
  const k = FOG_SCALE[palette.name] ?? 0.7;
  scene.fog = new THREE.FogExp2(palette.fogColor, (palette.fogDensity ?? 0.002) * k);
  scene.background = new THREE.Color(palette.fogColor);
}
