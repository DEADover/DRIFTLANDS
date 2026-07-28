import * as THREE from 'three';

/**
 * Persistent tyre marks. A single growing ribbon buffer per rear wheel, laid
 * flat on the terrain with a small y-offset. Fades by vertex alpha over time.
 */
export class SkidMarks {
  constructor({ maxQuads = 3000, color = 0x1a1a1a } = {}) {
    this.maxQuads = maxQuads;
    this.head = 0;
    this.count = 0;

    const verts = maxQuads * 6;
    this.positions = new Float32Array(verts * 3);
    this.alphas = new Float32Array(verts);
    this.ages = new Float32Array(maxQuads);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: { uColor: { value: new THREE.Color(color) } },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying float vA;
        void main() {
          vA = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vA;
        void main() {
          if (vA <= 0.001) discard;
          gl_FragColor = vec4(uColor, vA);
        }`,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'skidmarks';

    this._last = [null, null];
  }

  /** @param {THREE.Vector3} a left edge  @param {THREE.Vector3} b right edge */
  _pushQuad(a0, b0, a1, b1, alpha) {
    const i = this.head;
    const o = i * 18;
    const P = this.positions;
    const set = (k, v) => { P[o + k * 3] = v.x; P[o + k * 3 + 1] = v.y; P[o + k * 3 + 2] = v.z; };
    set(0, a0); set(1, b0); set(2, a1);
    set(3, b0); set(4, b1); set(5, a1);
    for (let k = 0; k < 6; k++) this.alphas[i * 6 + k] = alpha;
    this.ages[i] = 0;
    this.head = (this.head + 1) % this.maxQuads;
    this.count = Math.min(this.count + 1, this.maxQuads);
    this.geometry.setDrawRange(0, this.count * 6);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  /**
   * @param {{x:number,z:number,y:number}[]} wheelPoints rear wheel contact points
   * @param {number[]} intensity 0..1 per wheel
   */
  emit(wheelPoints, intensity) {
    for (let w = 0; w < wheelPoints.length; w++) {
      const p = wheelPoints[w];
      const inten = intensity[w];
      const last = this._last[w];
      if (inten < 0.18) { this._last[w] = null; continue; }
      if (!last) { this._last[w] = { ...p }; continue; }
      const dx = p.x - last.x, dz = p.z - last.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.35) continue;
      const nx = -dz / d, nz = dx / d;
      const hw = 0.20 + inten * 0.10;
      this._pushQuad(
        { x: last.x + nx * hw, y: last.y + 0.06, z: last.z + nz * hw },
        { x: last.x - nx * hw, y: last.y + 0.06, z: last.z - nz * hw },
        { x: p.x + nx * hw, y: p.y + 0.06, z: p.z + nz * hw },
        { x: p.x - nx * hw, y: p.y + 0.06, z: p.z - nz * hw },
        Math.min(0.85, 0.25 + inten * 0.6)
      );
      this._last[w] = { ...p };
    }
  }

  update(dt) {
    // Slow global fade so the world doesn't fill with black.
    const fade = dt * 0.012;
    if (fade <= 0) return;
    let dirty = false;
    for (let i = 0; i < this.count; i++) {
      const a = this.alphas[i * 6];
      if (a > 0) {
        const na = Math.max(0, a - fade);
        for (let k = 0; k < 6; k++) this.alphas[i * 6 + k] = na;
        dirty = true;
      }
    }
    if (dirty) this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  clear() {
    this.head = 0; this.count = 0;
    this.alphas.fill(0);
    this.geometry.setDrawRange(0, 0);
  }
}
