import * as THREE from 'three';
import { sampleEnv, surfaceStyle, styleForSurface, SURF } from './env.js';
import { ContactTracker } from './contact.js';

/**
 * TYRE MARKS — owned by the fx builder.
 *
 * CONTRACT (unchanged, `game.js` calls exactly these):
 *   new SkidMarks(opts)
 *   .mesh                       Object3D added to the scene
 *   .emit(rearPoints, slip, { surface, speed })
 *   .update(dt)
 *   .clear()
 *
 * WHAT THIS IS
 * ------------
 * The record of the player's line. From 180 m up a drift is over in a second;
 * the marks are the only thing that lets you *admire* it afterwards, so they
 * are a first-class graphic element rather than a debug ribbon.
 *
 *   - Four ribbons. The rears always mark; the fronts join in when they scrub,
 *     which is what makes a flick legible from above.
 *   - Width and opacity track slip AND speed, so a mark thickens into the apex
 *     and thins on exit. The shape of the mark tells the story of the corner.
 *   - Surface-specific: black rubber on tarmac; displaced soil with pale berms
 *     on dirt and gravel; a carved channel in snow that shows the cold grey
 *     beneath, banked by bright white spoil.
 *   - Age lives in the shader (per-vertex birth stamp), so marks hold at full
 *     strength for half a minute and then fade gracefully — zero per-frame CPU
 *     work and no buffer churn.
 *
 * This module also owns the per-frame tyre CONTACT resolve (see contact.js):
 * `emit()` is the one call in the frame that receives real wheel data, so it
 * publishes the resolved car frame for particles.js to build the plume from.
 */

const VERT = /* glsl */ `
  precision highp float;

  attribute float aU;        // -1..1 across the ribbon
  attribute float aV;        // metres travelled, for tread phase
  attribute float aAlpha;
  attribute float aBirth;
  attribute float aStyle;

  uniform float uTime;
  uniform float uHold;
  uniform float uFade;
  uniform float uFogDensity;
  uniform vec3 uCore[6];
  uniform vec3 uBerm[6];
  uniform float uBermStr[6];

  varying float vU;
  varying float vV;
  varying float vA;
  varying vec3 vCore;
  varying vec3 vBerm;
  varying float vBermStr;
  varying float vFog;

  void main() {
    int s = int(aStyle + 0.5);
    vCore = uCore[s];
    vBerm = uBerm[s];
    vBermStr = uBermStr[s];

    float age = uTime - aBirth;
    vA = aAlpha * (1.0 - smoothstep(uHold, uHold + uFade, age));
    vU = aU;
    vV = aV;

    vec4 wp = modelMatrix * vec4(position, 1.0);
    float d = distance(wp.xyz, cameraPosition);
    float fd = uFogDensity * d;
    vFog = 1.0 - exp(-fd * fd);

    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  uniform vec3 uFogCol;

  varying float vU;
  varying float vV;
  varying float vA;
  varying vec3 vCore;
  varying vec3 vBerm;
  varying float vBermStr;
  varying float vFog;

  void main() {
    if (vA <= 0.002) discard;
    float au = abs(vU);

    // Solid contact patch with soft shoulders — a tyre print, not a stroke.
    float body = 1.0 - smoothstep(0.64, 1.0, au);
    // Two grooves across the patch.
    float ribs = 0.86 + 0.14 * cos(vU * 12.566);
    // Longitudinal grain so the mark is never a flat slab of colour.
    float grain = 0.93 + 0.07 * sin(vV * 2.3 + vU * 3.0);
    // Displaced material banked up at the shoulders (dirt / snow).
    float berm = smoothstep(0.58, 0.90, au) * (1.0 - smoothstep(0.94, 1.06, au));
    float bw = clamp(berm * vBermStr, 0.0, 1.0);

    vec3 col = mix(vCore * ribs * grain, vBerm, bw);
    float a = vA * clamp(body + bw * 0.7, 0.0, 1.0);
    if (a <= 0.003) discard;

    col = mix(col, uFogCol, vFog * 0.9);
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const MIN_STEP = 0.5;      // metres between ribbon segments
const N_RIBBONS = 4;       // rear-right, rear-left, front-right, front-left

export class SkidMarks {
  constructor({ maxQuads = 10000 } = {}) {
    this.maxQuads = maxQuads;
    this.head = 0;
    this.count = 0;
    this.time = 0;
    this._dt = 1 / 60;
    this._dirty = false;

    const verts = maxQuads * 6;
    this.positions = new Float32Array(verts * 3);
    this.us = new Float32Array(verts);
    this.vs = new Float32Array(verts);
    this.alphas = new Float32Array(verts);
    this.births = new Float32Array(verts);
    this.styles = new Float32Array(verts);

    const geo = new THREE.BufferGeometry();
    const mk = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    this.pAttr = mk(this.positions, 3);
    this.uAttr = mk(this.us, 1);
    this.vAttr = mk(this.vs, 1);
    this.alphaAttr = mk(this.alphas, 1);
    this.birthAttr = mk(this.births, 1);
    this.styleAttr = mk(this.styles, 1);
    geo.setAttribute('position', this.pAttr);
    geo.setAttribute('aU', this.uAttr);
    geo.setAttribute('aV', this.vAttr);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.setAttribute('aBirth', this.birthAttr);
    geo.setAttribute('aStyle', this.styleAttr);
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    const core = [], berm = [], bstr = [];
    for (let i = 0; i < 6; i++) {
      core.push(new THREE.Color(0x333333));
      berm.push(new THREE.Color(0x888888));
      bstr.push(0.6);
    }

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      // The ribbon is laid flat on the ground with a consistent left-normal, so
      // its winding always faces DOWN — single-sided culls the whole thing.
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
      uniforms: {
        uTime: { value: 0 },
        uHold: { value: 34 },      // seconds at full strength
        uFade: { value: 46 },      // seconds to fade away
        uFogCol: { value: new THREE.Color(0xbfe0f2) },
        uFogDensity: { value: 0.0016 },
        uCore: { value: core },
        uBerm: { value: berm },
        uBermStr: { value: bstr },
      },
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'skidmarks';

    this.tracker = new ContactTracker();
    this._envState = {};
    this._last = new Array(N_RIBBONS).fill(null);
    this._dist = new Float32Array(N_RIBBONS);
    this._c = new THREE.Color();
    this._stylesAt = -1;
  }

  // ------------------------------------------------------------- ribbons ---
  _pushQuad(a0, b0, a1, b1, alpha, style, v0, v1) {
    const i = this.head;
    const o = i * 18;
    const P = this.positions;
    const set = (k, p) => { P[o + k * 3] = p.x; P[o + k * 3 + 1] = p.y; P[o + k * 3 + 2] = p.z; };
    set(0, a0); set(1, b0); set(2, a1);
    set(3, b0); set(4, b1); set(5, a1);

    const U = this.us, V = this.vs, A = this.alphas, B = this.births, S = this.styles;
    const j = i * 6;
    U[j] = 1; U[j + 1] = -1; U[j + 2] = 1;
    U[j + 3] = -1; U[j + 4] = -1; U[j + 5] = 1;
    V[j] = v0; V[j + 1] = v0; V[j + 2] = v1;
    V[j + 3] = v0; V[j + 4] = v1; V[j + 5] = v1;
    for (let k = 0; k < 6; k++) { A[j + k] = alpha; B[j + k] = this.time; S[j + k] = style; }

    this.pAttr.addUpdateRange(o, 18);
    this.uAttr.addUpdateRange(j, 6);
    this.vAttr.addUpdateRange(j, 6);
    this.alphaAttr.addUpdateRange(j, 6);
    this.birthAttr.addUpdateRange(j, 6);
    this.styleAttr.addUpdateRange(j, 6);
    this._dirty = true;

    this.head = (this.head + 1) % this.maxQuads;
    this.count = Math.min(this.count + 1, this.maxQuads);
  }

  _lay(idx, p, inten, style, widthMul, alphaMul, salt) {
    if (inten < 0.045) { this._last[idx] = null; return; }
    const last = this._last[idx];
    if (!last) { this._last[idx] = { x: p.x, y: p.y, z: p.z }; return; }

    const dx = p.x - last.x, dz = p.z - last.z;
    const d = Math.hypot(dx, dz);
    if (d < MIN_STEP) return;
    if (d > 12) { last.x = p.x; last.y = p.y; last.z = p.z; return; }  // teleport guard

    const nx = -dz / d, nz = dx / d;
    const e = Math.min(1.4, inten);
    // Width and opacity both ride slip: the mark fattens into the apex.
    const s0 = (Math.sin(this._dist[idx] * 0.9 + salt * 12.9898) + 1) * 0.5;
    const s1 = (Math.sin(this._dist[idx] * 1.7 + salt * 78.233) + 1) * 0.5;
    const hw = (0.32 + e * 0.36) * widthMul * (0.90 + 0.20 * s0);
    const alpha = Math.min(0.95, (0.30 + e * 0.62) * alphaMul * (0.86 + 0.28 * s1));

    const v0 = this._dist[idx];
    this._dist[idx] += d;
    const v1 = this._dist[idx];
    const y = 0.075;

    this._pushQuad(
      { x: last.x + nx * hw, y: last.y + y, z: last.z + nz * hw },
      { x: last.x - nx * hw, y: last.y + y, z: last.z - nz * hw },
      { x: p.x + nx * hw, y: p.y + y, z: p.z + nz * hw },
      { x: p.x - nx * hw, y: p.y + y, z: p.z - nz * hw },
      alpha, style, v0, v1
    );
    last.x = p.x; last.y = p.y; last.z = p.z;
  }

  // ---------------------------------------------------------------- emit ---
  /**
   * @param {{x:number,y:number,z:number}[]} rear rear-right then rear-left contacts
   * @param {number[]} intensity per rear wheel, 0..1.5
   * @param {{surface?:{kind:string,grip:number}, speed?:number}} opts
   */
  emit(rear, intensity, opts = {}) {
    if (!rear || rear.length < 1) return;
    const f = this.tracker.update(this._dt, rear, intensity, opts);

    const env = sampleEnv(this.mesh, this._envState, this.time);
    this._syncStyles(env);
    const st = surfaceStyle(env, f.kind, f.grip);
    const style = st.surf;

    const speedF = THREE.MathUtils.clamp((f.speed - 3.0) / 15, 0, 1);
    if (speedF <= 0) { this._last.fill(null); return; }

    // On loose ground a tyre leaves a track just by rolling; on tarmac only
    // real slip makes rubber.
    const loose = st.surf === SURF.TARMAC ? 0 : 0.34 * speedF;

    for (let w = 0; w < 2; w++) {
      const inten = Math.max(f.slip[w] ?? 0, loose);
      this._lay(w, f.rear[w], inten, style, st.width, st.markAlpha, w + 1);
    }
    // Fronts scrub under steering and yaw, and on loose ground cut a lighter
    // track of their own. Roughly two-thirds the weight of the rears.
    for (let w = 0; w < 2; w++) {
      const inten = Math.max(f.frontSlip * 0.85, loose * 0.72);
      this._lay(2 + w, f.front[w], inten, style, st.width * 0.86, st.markAlpha * 0.68, w + 5);
    }
  }

  /** Push the per-surface palette into the shader, tinted by this world. */
  _syncStyles(env) {
    if (this._stylesAt === this._envState.at) return;
    this._stylesAt = this._envState.at;
    const core = this.material.uniforms.uCore.value;
    const berm = this.material.uniforms.uBerm.value;
    const bstr = this.material.uniforms.uBermStr.value;
    for (let s = 0; s < 6; s++) {
      const src = styleForSurface(s);
      core[s].copy(src.markCore);
      // Nudge the groove toward a darker version of THIS world's ground so a
      // mark always reads as displaced material, never as imported paint.
      this._c.copy(env.groundColor).multiplyScalar(0.62);
      core[s].lerp(this._c, s === SURF.TARMAC ? 0.08 : 0.30);
      berm[s].copy(src.markBerm);
      bstr[s] = src.bermStrength;
    }
    this.material.uniforms.uFogCol.value.copy(env.fogColor);
    this.material.uniforms.uFogDensity.value = env.fogDensity;
  }

  // -------------------------------------------------------------- update ---
  update(dt) {
    if (!(dt > 0)) dt = 1 / 60;
    this._dt = dt;
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;

    if (this._dirty) {
      this._dirty = false;
      this.geometry.setDrawRange(0, this.count * 6);
      this.pAttr.needsUpdate = true;
      this.uAttr.needsUpdate = true;
      this.vAttr.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
      this.birthAttr.needsUpdate = true;
      this.styleAttr.needsUpdate = true;
    }
  }

  clear() {
    this.head = 0;
    this.count = 0;
    this.alphas.fill(0);
    this.alphaAttr.clearUpdateRanges();
    this.alphaAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, 0);
    this._last.fill(null);
    this._dist.fill(0);
    this.tracker.reset();
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
