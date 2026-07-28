import * as THREE from 'three';

/**
 * GPU-friendly billboard particle pool for dust, gravel, smoke and splashes.
 * One draw call. Soft round sprites, additive-ish for dust so it glows into
 * the light — that halo behind a sliding car is 80% of the "satisfying".
 */

const VERT = /* glsl */ `
  attribute vec3 aOffset;
  attribute float aSize;
  attribute float aLife;
  attribute vec3 aColor;
  varying float vLife;
  varying vec3 vColor;
  void main() {
    vLife = aLife;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * (300.0 / max(1.0, -mv.z));
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying float vLife;
  varying vec3 vColor;
  void main() {
    if (vLife <= 0.0) discard;
    vec2 d = gl_PointCoord - 0.5;
    float r = dot(d, d);
    if (r > 0.25) discard;
    float a = smoothstep(0.25, 0.02, r) * vLife;
    gl_FragColor = vec4(vColor, a * 0.85);
    #include <colorspace_fragment>
  }
`;

export class ParticleSystem {
  constructor(max = 2500) {
    this.max = max;
    this.head = 0;
    this.offsets = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.sizes = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.colors = new Float32Array(max * 3);
    this.drag = new Float32Array(max);
    this.grow = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    geo.setAttribute('aOffset', new THREE.BufferAttribute(this.offsets, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.name = 'particles';
    this._c = new THREE.Color();
  }

  spawn({ x, y, z, vx = 0, vy = 0, vz = 0, size = 2, life = 1, color = 0xffffff, drag = 1.6, grow = 1.4 }) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.offsets[i * 3] = x; this.offsets[i * 3 + 1] = y; this.offsets[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.sizes[i] = size;
    this.life[i] = 1;
    this.maxLife[i] = life;
    this.drag[i] = drag;
    this.grow[i] = grow;
    this._c.set(color);
    this.colors[i * 3] = this._c.r; this.colors[i * 3 + 1] = this._c.g; this.colors[i * 3 + 2] = this._c.b;
  }

  update(dt) {
    const { offsets, vel, life, maxLife, sizes, drag, grow } = this;
    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt / maxLife[i];
      if (life[i] <= 0) { life[i] = 0; continue; }
      const d = Math.exp(-drag[i] * dt);
      vel[i * 3] *= d;
      vel[i * 3 + 1] = vel[i * 3 + 1] * d + 1.6 * dt; // dust rises
      vel[i * 3 + 2] *= d;
      offsets[i * 3] += vel[i * 3] * dt;
      offsets[i * 3 + 1] += vel[i * 3 + 1] * dt;
      offsets[i * 3 + 2] += vel[i * 3 + 2] * dt;
      sizes[i] += grow[i] * dt * 3;
    }
    this.geometry.attributes.aOffset.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aLife.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.geometry.attributes.aLife.needsUpdate = true;
  }
}
