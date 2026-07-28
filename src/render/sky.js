import * as THREE from 'three';

/** Gradient sky dome + matching exponential fog. Cheap, and it sets the mood. */

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
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uSunSize;
  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);
    float t = clamp(d.y * 1.15 + 0.06, 0.0, 1.0);
    // Two-stop ramp with a compressed horizon band — poster-like.
    vec3 col = mix(uHorizon, uTop, pow(t, 0.62));

    // Sun bloom in the sky itself (no post needed for the basic read).
    float sd = max(0.0, dot(d, normalize(uSunDir)));
    col += uSunColor * pow(sd, 220.0) * 2.2;
    col += uSunColor * pow(sd, 8.0) * 0.16 * uSunSize;

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export class Sky {
  constructor(palette) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color(palette.skyTop) },
        uHorizon: { value: new THREE.Color(palette.skyHorizon) },
        uSunColor: { value: new THREE.Color(palette.sunColor) },
        uSunDir: { value: new THREE.Vector3(1, 0.5, 0) },
        uSunSize: { value: 1.0 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1500, 24, 16), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    this.mesh.name = 'sky';
    this.applyPalette(palette);
  }

  applyPalette(p) {
    this.material.uniforms.uTop.value.setHex(p.skyTop);
    this.material.uniforms.uHorizon.value.setHex(p.skyHorizon);
    this.material.uniforms.uSunColor.value.setHex(p.sunColor);
    this.material.uniforms.uSunDir.value.set(
      Math.cos(p.sunAzimuth) * Math.cos(p.sunElevation),
      Math.sin(p.sunElevation),
      Math.sin(p.sunAzimuth) * Math.cos(p.sunElevation)
    );
  }

  follow(camPos) {
    this.mesh.position.copy(camPos);
  }
}

export function applyFog(scene, palette) {
  scene.fog = new THREE.FogExp2(palette.fogColor, palette.fogDensity);
  scene.background = new THREE.Color(palette.fogColor);
}
