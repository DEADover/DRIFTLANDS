import * as THREE from 'three';

/**
 * Stylised water: a flat plane with animated, low-frequency colour banding.
 * No reflections, no refraction — the look is graphic, like cut paper. Depth
 * is faked by blending toward `waterDeep` where the terrain is far below.
 */

const VERT = /* glsl */ `
  varying vec2 vWorld;
  varying vec3 vPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xz;
    vPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uFoam;
  uniform vec3 uSun;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  varying vec2 vWorld;
  varying vec3 vPos;

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
               mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
  }

  void main() {
    vec2 p = vWorld * 0.012;
    float w = noise(p + vec2(uTime * 0.05, uTime * 0.03));
    w += 0.5 * noise(p * 2.3 - vec2(uTime * 0.07, 0.0));
    w /= 1.5;

    // Banded, poster-like gradient rather than a smooth ramp.
    float band = floor(w * 5.0) / 5.0;
    vec3 col = mix(uDeep, uShallow, band);

    // Sun glitter: sharp specular streaks along one axis.
    float glint = pow(max(0.0, noise(p * 6.0 + uTime * 0.25)), 14.0);
    col += uSun * glint * 1.4;

    // Foam lines at the crest of the noise.
    float foam = smoothstep(0.72, 0.80, w) * (1.0 - smoothstep(0.86, 0.94, w));
    col = mix(col, uFoam, foam * 0.55);

    // Match the scene's exponential fog so the lake recedes correctly.
    float d = length(vPos - cameraPosition);
    float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
    col = mix(col, uFogColor, clamp(f, 0.0, 1.0));

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export class Water {
  constructor(palette, biome) {
    this.palette = palette;
    this.biome = biome;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uShallow: { value: new THREE.Color(palette.water) },
        uDeep: { value: new THREE.Color(palette.waterDeep) },
        uFoam: { value: new THREE.Color(palette.waterFoam) },
        uSun: { value: new THREE.Color(palette.sunColor) },
        uFogColor: { value: new THREE.Color(palette.fogColor) },
        uFogDensity: { value: palette.fogDensity },
      },
    });
    const size = biome.size * 1.6;
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = biome.waterLevel;
    this.mesh.renderOrder = -1;
    this.mesh.name = 'water';
  }

  update(dt) {
    this.material.uniforms.uTime.value += dt;
  }

  /** True if this world position is under water. */
  contains(x, z, height) {
    return height < this.biome.waterLevel;
  }
}
