import * as THREE from 'three';
import { sampleEnv, surfaceStyle, SURF } from './env.js';
import { FX_CONTACT } from './contact.js';

/**
 * PARTICLE FX — owned by the fx builder.
 *
 * CONTRACT (unchanged, `game.js` calls exactly these):
 *   new ParticleSystem(max)
 *   .points        Object3D added to the scene
 *   .spawn(opts)   one-shot puff, legacy signature
 *   .update(dt)    step + upload
 *   .clear()
 *
 * WHAT THIS IS
 * ------------
 * A single-draw-call instanced-quad system built for one job: making a
 * powerslide look like it weighs something from 180 m up. You cannot feel
 * g-force through a top-down camera, so the plume has to carry it.
 *
 * The plume is LAYERED — every emission picks a role, and the roles composite:
 *   BILLOW  large slow puffs that rise, expand and out-live the car
 *   SHEET   ground-aligned ellipses smeared along the travel direction —
 *           the low skirt of dust that hugs the ground and reads as weight
 *   WISP    small fast shreds torn off the tyre, the high-frequency detail
 *   GRIT    hard chips with gravity that arc and BOUNCE off the ground
 *   SPRAY   water droplets / snow crystals
 *   SPARK   additive streaks on impact
 *   FLECK   grass and leaf litter kicked out of the verge
 *
 * Every soft particle is shaded as a sphere impostor lit by the scene's own
 * sun (found via env.js), so a plume has a hot rim on the sun side and a cool
 * sky-lit shadow side. That single trick is what stops dust reading as
 * stickers at this camera angle.
 *
 * Emission is driven from the tyre contact frame published on FX_CONTACT by
 * skidmarks.js — see contact.js for why the fx subsystem resolves it there.
 */

// ---------------------------------------------------------------- roles ----
const T_SOFT = 0;   // lit sphere impostor, noisy silhouette
const T_HARD = 1;   // chip / stone / leaf — opaque flake
const T_DROP = 2;   // water droplet / snow crystal, bright and specular
const T_SPARK = 3;  // additive streak
const T_SHADE = 4;  // unlit ground-aligned shadow of the plume

const MAX_RATE = 215;   // particles/second ceiling for the wheel driver

// ------------------------------------------------------------- shaders ----
const VERT = /* glsl */ `
  precision highp float;

  attribute vec3 iPos;
  attribute vec2 iSize;    // (long, short) in metres
  attribute vec3 iCol;
  attribute vec4 iMisc;    // rot, life(1..0), seed, opacity
  attribute vec2 iMode;    // type, flat(0=camera facing, 1=ground aligned)

  uniform float uFogDensity;

  varying vec2 vUv;
  varying vec3 vCol;
  varying float vLife;
  varying float vSeed;
  varying float vType;
  varying float vOpa;
  varying float vFog;

  void main() {
    float life = iMisc.y;
    if (life <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // clipped away
      return;
    }

    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 R = mix(camRight, vec3(1.0, 0.0, 0.0), iMode.y);
    vec3 U = mix(camUp,    vec3(0.0, 0.0, 1.0), iMode.y);

    float c = cos(iMisc.x), s = sin(iMisc.x);
    vec2 q = position.xy * iSize;
    vec2 qr = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
    vec3 world = iPos + R * qr.x + U * qr.y;

    vUv = position.xy + 0.5;
    vCol = iCol;
    vLife = life;
    vSeed = iMisc.z;
    vOpa = iMisc.w;
    vType = iMode.x;

    float d = distance(world, cameraPosition);
    float fd = uFogDensity * d;
    vFog = 1.0 - exp(-fd * fd);

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  uniform vec3 uSunDir;
  uniform vec3 uSunCol;
  uniform vec3 uSkyCol;
  uniform vec3 uGndCol;
  uniform vec3 uFogCol;
  uniform float uTime;

  varying vec2 vUv;
  varying vec3 vCol;
  varying float vLife;
  varying float vSeed;
  varying float vType;
  varying float vOpa;
  varying float vFog;

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
    return 0.58 * vnoise(p) + 0.30 * vnoise(p * 2.13 + 7.7) + 0.12 * vnoise(p * 4.31 + 3.1);
  }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.08) discard;

    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 camFwd   = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);

    float alpha;
    vec3 col = vCol;
    vec3 glow = vec3(0.0);

    // Age curve: snap in over the first 10% of life, linger on the way out.
    float birth = smoothstep(1.0, 0.965, vLife);
    float death = vLife;

    if (vType < 0.5) {
      // ===================== SOFT: dust / smoke / powder ==================
      float ang = atan(p.y, p.x);
      float sd = vSeed * 37.0;
      // Angular noise breaks the circle into a cauliflower silhouette; radial
      // noise carves the interior into lobes. Together they read as volume.
      float na = fbm(vec2(cos(ang), sin(ang)) * 1.9 + sd + uTime * 0.05);
      float nb = fbm(p * 1.7 + sd * 0.7 + uTime * 0.07);
      float grow = mix(0.66, 1.04, 1.0 - death);      // silhouette dilates with age
      float rr = r / grow * (1.0 + (na - 0.5) * 0.88);

      float body = smoothstep(1.00, 0.30, rr);
      body *= mix(0.58, 1.28, nb);
      alpha = body * vOpa * (0.30 + 0.70 * death) * birth;

      // sphere impostor normal -> sun side / shadow side
      float nz = sqrt(max(0.0, 1.0 - min(r * r, 1.0)));
      vec3 N = normalize(camRight * p.x + camUp * p.y + camFwd * nz);
      float ndl = dot(N, uSunDir);
      float wrap = pow(clamp(0.26 + 0.74 * ndl, 0.0, 1.0), 1.45);

      vec3 lit = uSunCol * wrap * 1.22
               + uSkyCol * (0.24 + 0.30 * clamp(N.y, 0.0, 1.0))
               + uGndCol * 0.14;
      col = vCol * lit;

      // Sun-through-dust: the lit limb of the puff blooms.
      float rim = smoothstep(0.38, 1.00, rr) * clamp(ndl, 0.0, 1.0);
      col += uSunCol * rim * 0.24;
      glow = uSunCol * vCol * rim * 0.45 * alpha;

    } else if (vType < 1.5) {
      // ===================== HARD: chips, stones, leaves ==================
      float k = max(abs(p.x), abs(p.y) * 1.25);
      alpha = (1.0 - smoothstep(0.70, 1.0, k)) * vOpa * birth * smoothstep(0.0, 0.20, death);
      float nz = sqrt(max(0.0, 1.0 - min(r * r, 1.0)));
      vec3 N = normalize(camRight * p.x * 0.6 + camUp * p.y * 0.6 + camFwd * nz);
      float ndl = clamp(0.30 + 0.70 * dot(N, uSunDir), 0.0, 1.0);
      col = vCol * (uSunCol * ndl * 1.10 + uSkyCol * 0.36);

    } else if (vType < 2.5) {
      // ===================== DROP: water spray / snow crystal =============
      float e = 1.0 - smoothstep(0.25, 1.0, r);
      alpha = e * e * vOpa * birth * (0.25 + 0.75 * death);
      float nz = sqrt(max(0.0, 1.0 - min(r * r, 1.0)));
      vec3 N = normalize(camRight * p.x + camUp * p.y + camFwd * nz);
      float spec = pow(clamp(dot(N, uSunDir), 0.0, 1.0), 5.0);
      col = vCol * (uSkyCol * 0.90 + uSunCol * 0.60) + uSunCol * spec * 1.0;
      glow = uSunCol * spec * alpha * 0.7;

    } else if (vType < 3.5) {
      // ===================== SPARK ========================================
      float k = length(vec2(p.x, p.y * 2.6));
      alpha = (1.0 - smoothstep(0.10, 1.0, k)) * vOpa * death;
      col = vCol;
      glow = vCol * alpha * 1.6;

    } else {
      // ===================== SHADE: the plume's shadow on the ground ======
      float ang = atan(p.y, p.x);
      float na = fbm(vec2(cos(ang), sin(ang)) * 1.7 + vSeed * 29.0);
      float rr = r * (1.0 + (na - 0.5) * 0.55);
      alpha = smoothstep(1.02, 0.20, rr) * vOpa * (0.30 + 0.70 * death) * birth;
      col = vCol;   // unlit: it IS the absence of light
    }

    if (alpha <= 0.004) discard;

    col = mix(col, uFogCol, vFog * 0.92);
    glow *= (1.0 - vFog * 0.85);

    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor.rgb *= gl_FragColor.a;      // premultiplied
    gl_FragColor.rgb += glow;                // additive bloom term
  }
`;

export class ParticleSystem {
  constructor(max = 4000) {
    this.max = Math.max(256, max);
    this.head = 0;
    this.time = 0;
    this.alive = 0;

    const m = this.max;
    this.px = new Float32Array(m); this.py = new Float32Array(m); this.pz = new Float32Array(m);
    this.vx = new Float32Array(m); this.vy = new Float32Array(m); this.vz = new Float32Array(m);
    this.life = new Float32Array(m);
    this.invLife = new Float32Array(m);
    this.sw = new Float32Array(m); this.sh = new Float32Array(m);
    this.gw = new Float32Array(m); this.gh = new Float32Array(m);
    this.rot = new Float32Array(m); this.rotV = new Float32Array(m);
    this.drag = new Float32Array(m);
    this.acc = new Float32Array(m);      // vertical acceleration (+rise / -gravity)
    this.turb = new Float32Array(m);
    this.groundY = new Float32Array(m);
    this.bounce = new Float32Array(m);
    this.type = new Float32Array(m);
    this.flat = new Float32Array(m);

    // ---- instanced geometry: one draw call for the whole system ----
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0,
    ]), 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);

    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(m * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(m * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(m * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aMisc = new THREE.InstancedBufferAttribute(new Float32Array(m * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aMode = new THREE.InstancedBufferAttribute(new Float32Array(m * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iSize', this.aSize);
    geo.setAttribute('iCol', this.aCol);
    geo.setAttribute('iMisc', this.aMisc);
    geo.setAttribute('iMode', this.aMode);
    geo.instanceCount = m;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0.5, 0.7, 0.5).normalize() },
        uSunCol: { value: new THREE.Color(0xfff2d6) },
        uSkyCol: { value: new THREE.Color(0x9ccbf0) },
        uGndCol: { value: new THREE.Color(0x5f7a3c) },
        uFogCol: { value: new THREE.Color(0xbfe0f2) },
        uFogDensity: { value: 0.0016 },
        uTime: { value: 0 },
      },
    });

    // `points` is the handle game.js adds to the scene — keep the name.
    this.points = new THREE.Mesh(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.name = 'particles';

    this._envState = {};
    this._c = new THREE.Color();
    this._c2 = new THREE.Color();
    this._acc = { dust: 0, fleck: 0, stone: 0 };
    this._wheelToggle = 0;
    this._drivenThisFrame = false;
    this._lastImpactT = -10;
  }

  // ------------------------------------------------------------ spawning ---
  /** Low-level allocate. Metres / seconds / world space. */
  _emit(o) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.px[i] = o.x; this.py[i] = o.y; this.pz[i] = o.z;
    this.vx[i] = o.vx || 0; this.vy[i] = o.vy || 0; this.vz[i] = o.vz || 0;
    this.life[i] = 1;
    this.invLife[i] = 1 / Math.max(0.05, o.life);
    this.sw[i] = o.w; this.sh[i] = o.h ?? o.w;
    this.gw[i] = o.gw ?? 0; this.gh[i] = o.gh ?? o.gw ?? 0;
    this.rot[i] = o.rot ?? Math.random() * 6.283;
    this.rotV[i] = o.rotV ?? 0;
    this.drag[i] = o.drag ?? 1.6;
    this.acc[i] = o.acc ?? 0;
    this.turb[i] = o.turb ?? 0;
    this.groundY[i] = o.groundY ?? -1e6;
    this.bounce[i] = o.bounce ?? 0;
    this.type[i] = o.type ?? T_SOFT;
    this.flat[i] = o.flat ?? 0;

    const j = i * 3;
    this.aCol.array[j] = o.r; this.aCol.array[j + 1] = o.g; this.aCol.array[j + 2] = o.b;
    this.aMisc.array[i * 4 + 2] = o.seed ?? Math.random();
    this.aMisc.array[i * 4 + 3] = o.opacity ?? 0.4;
    return i;
  }

  /**
   * LEGACY ENTRY POINT — kept signature-compatible so the shell keeps working
   * standalone. When the wheel driver already ran this frame it owns the plume
   * (it has strictly better data) and this duplicate is dropped.
   */
  spawn({ x, y, z, vx = 0, vy = 0, vz = 0, size = 2, life = 1, color = 0xffffff, drag = 1.6, grow = 1.4 }) {
    if (this._drivenThisFrame) return;
    this._c.set(color);
    this._emit({
      x, y, z, vx, vy: vy * 0.7, vz,
      w: size * 0.8, gw: grow * 1.6,
      life: life * 1.5,
      r: this._c.r, g: this._c.g, b: this._c.b,
      drag, acc: 0.9, turb: 0.9, opacity: 0.26, type: T_SOFT,
    });
  }

  // ------------------------------------------------------- the fx driver ---
  /** Everything the tyres throw, from the contact frame skidmarks resolved. */
  _drive(dt, env) {
    const f = FX_CONTACT.frame;
    this._drivenThisFrame = !!f;
    if (!f) return;

    this._env = env;
    const st = surfaceStyle(env, f.kind, f.grip);
    const spd = f.speed;
    const inWater = env.waterLevel > -9000 && Math.abs(f.y - env.waterLevel) < 0.85;

    // ---- impact: sparks, debris fan and a dust shock ---------------------
    if (f.impact > 0.12 && this.time - this._lastImpactT > 0.25) {
      this._lastImpactT = this.time;
      this._impact(f, st);
    }

    if (spd < 3.2) { this._acc.dust = 0; return; }

    const rearSlip = Math.max(f.slip[0], f.slip[1]);
    // Scrub: how hard the tyres are tearing the surface up.
    const scrub = Math.min(2.4, rearSlip * 1.25 + Math.abs(f.vLat) / 8.5 + Math.abs(f.yawRate) * 0.30);
    // Roll: even straight-line speed throws a rooster tail on loose ground.
    const roll = Math.min(1, Math.max(0, (spd - 6.5) / 20));
    const drive = roll * 0.62 + scrub * 1.55;
    const loose = inWater ? 1.6 : st.loose;

    let rate = Math.min(MAX_RATE, drive * 38 * loose);
    // Tarmac only lights up when it is genuinely sliding — no smoke at cruise.
    if (st.surf === SURF.TARMAC) rate *= Math.min(1, scrub * 0.75);

    this._acc.dust += rate * dt;
    let n = Math.floor(this._acc.dust);
    this._acc.dust -= n;
    n = Math.min(n, 18);

    const dirX = f.dirX, dirZ = f.dirZ;
    for (let k = 0; k < n; k++) {
      this._wheelToggle ^= 1;
      const w = f.rear[this._wheelToggle];
      // Smear the origin backwards along the path so the plume is continuous
      // instead of pulsing once per frame.
      const back = Math.random() * spd * dt * 1.4 + Math.random() * 1.2;
      const spread = (Math.random() - 0.5) * 2.4;
      const ox = w.x - dirX * back + f.rightX * spread + (Math.random() - 0.5) * 0.6;
      const oz = w.z - dirZ * back + f.rightZ * spread + (Math.random() - 0.5) * 0.6;
      if (inWater) this._spray(ox, w.y, oz, f);
      else this._plume(ox, w.y, oz, f, st, scrub);
    }

    // ---- verge life: grass shredded out, stones flicked up ---------------
    if (!inWater && st.surf !== SURF.TARMAC && st.surf !== SURF.SNOW) {
      const off = f.kind === 'road' || f.kind === 'bridge' ? 0.25 : 1;
      this._acc.fleck += roll * 7 * off * (0.4 + scrub * 0.5) * dt;
      while (this._acc.fleck >= 1) { this._acc.fleck -= 1; this._fleck(f, env); }
      this._acc.stone += roll * 3.5 * off * (0.3 + scrub * 0.8) * dt;
      while (this._acc.stone >= 1) { this._acc.stone -= 1; this._stone(f, st); }
    }
  }

  /** One layered dust element. Roles composite into a single volume. */
  _plume(x, gy, z, f, st, scrub) {
    const spd = f.speed;
    const dirX = f.dirX, dirZ = f.dirZ;
    const rx = f.rightX, rz = f.rightZ;
    const lat = THREE.MathUtils.clamp(f.vLat * 0.22, -3.2, 3.2);
    const power = 0.35 + scrub * 0.55;

    // Colour: base dust with per-particle drift toward the hot (sunlit) tint.
    const mixHot = Math.random() * Math.random();
    this._c.copy(st.dust).lerp(st.dustHot, mixHot * 0.85);
    const v = 0.86 + Math.random() * 0.26;
    const r = this._c.r * v, g = this._c.g * v, b = this._c.b * v;

    const roleR = Math.random();
    const side = Math.random() < 0.5 ? 1 : -1;
    const isSnow = st.surf === SURF.SNOW;
    const isTar = st.surf === SURF.TARMAC;

    if (roleR < 0.46) {
      // ---------- BILLOW: the body of the plume --------------------------
      const carry = spd * (0.30 + Math.random() * 0.22);
      this._emit({
        x, y: gy + 0.35 + Math.random() * 0.8, z,
        vx: dirX * carry + rx * (lat * 0.8 + side * (3.0 + Math.random() * 5.0)) + (Math.random() - 0.5) * 2.0,
        vy: (1.1 + Math.random() * 2.0) * st.rise * (0.7 + power),
        vz: dirZ * carry + rz * (lat * 0.8 + side * (3.0 + Math.random() * 5.0)) + (Math.random() - 0.5) * 2.0,
        w: (6.0 + Math.random() * 4.5) * (isTar ? 1.3 : 1),
        gw: (3.4 + Math.random() * 4.0) * st.puff,
        life: (0.95 + Math.random() * 0.85) * st.life,
        r, g, b,
        drag: 1.05, acc: 0.85 * st.rise, turb: 1.9,
        rotV: (Math.random() - 0.5) * 0.9,
        opacity: (0.30 + Math.random() * Math.random() * 0.75) * (isTar ? 1.15 : 1),
        type: T_SOFT, flat: 0.18,
      });
    } else if (roleR < 0.73) {
      // ---------- SHEET: the low skirt that hugs the ground --------------
      const carry = spd * (0.24 + Math.random() * 0.20);
      const along = Math.atan2(-dirZ, -dirX);
      this._emit({
        x, y: gy + 0.55 + Math.random() * 0.45, z,
        vx: dirX * carry + rx * (lat * 1.5 + side * (2.4 + Math.random() * 4.5)),
        vy: 0.15 + Math.random() * 0.35,
        vz: dirZ * carry + rz * (lat * 1.5 + side * (2.4 + Math.random() * 4.5)),
        w: 6.0 + Math.random() * 4.5,
        h: 4.8 + Math.random() * 3.6,
        gw: 5.0 + Math.random() * 4.5,
        gh: 4.0 + Math.random() * 3.6,
        life: (0.85 + Math.random() * 0.8) * st.life,
        r, g, b,
        drag: 1.7, acc: 0.06, turb: 0.5,
        rot: along + (Math.random() - 0.5) * 1.6, rotV: (Math.random() - 0.5) * 0.25,
        opacity: 0.26 + Math.random() * Math.random() * 0.45,
        type: T_SOFT, flat: 1,
      });
    } else if (roleR < 0.80) {
      // ---------- SHADOW: the plume's own shade cast on the ground -------
      // Offset along the sun's horizontal projection by an assumed plume
      // height. Nothing grounds airborne dust like seeing it darken the
      // meadow underneath it.
      const env = this._env;
      const sy = Math.max(0.25, env.sunDir.y);
      const h = 2.4 + Math.random() * 3.4;
      const ox = -(env.sunDir.x / sy) * h;
      const oz = -(env.sunDir.z / sy) * h;
      const carry = spd * (0.24 + Math.random() * 0.18);
      const along = Math.atan2(-dirZ, -dirX);
      this._c2.copy(env.groundColor).multiplyScalar(0.44);
      this._emit({
        x: x + ox, y: gy + 0.14, z: z + oz,
        vx: dirX * carry + rx * side * (2.0 + Math.random() * 3.5),
        vy: 0,
        vz: dirZ * carry + rz * side * (2.0 + Math.random() * 3.5),
        w: 5.5 + Math.random() * 4.0,
        h: 4.4 + Math.random() * 3.2,
        gw: 4.5 + Math.random() * 4.0,
        gh: 3.6 + Math.random() * 3.2,
        life: (0.85 + Math.random() * 0.8) * st.life,
        r: this._c2.r, g: this._c2.g, b: this._c2.b,
        drag: 1.7, acc: 0, turb: 0.4,
        rot: along + (Math.random() - 0.5) * 1.8, opacity: 0.15 + Math.random() * 0.12,
        type: T_SHADE, flat: 1,
      });
    } else if (roleR < 0.93) {
      // ---------- WISP: shreds torn straight off the tyre ----------------
      const carry = spd * (0.45 + Math.random() * 0.25);
      this._emit({
        x, y: gy + 0.25 + Math.random() * 0.5, z,
        vx: dirX * carry + rx * lat * 1.9 + (Math.random() - 0.5) * 4.0,
        vy: 1.6 + Math.random() * 3.2 * st.rise,
        vz: dirZ * carry + rz * lat * 1.9 + (Math.random() - 0.5) * 4.0,
        w: 1.5 + Math.random() * 2.0,
        gw: 3.4 + Math.random() * 3.0,
        life: (0.35 + Math.random() * 0.45) * st.life,
        r, g, b,
        drag: 2.6, acc: 1.5 * st.rise, turb: 2.2,
        rotV: (Math.random() - 0.5) * 2.2,
        opacity: 0.28 + Math.random() * 0.18,
        type: T_SOFT, flat: 0,
      });
    } else if (isSnow) {
      // ---------- snow crystals: bright, slow, sparkling ------------------
      const carry = spd * (0.40 + Math.random() * 0.3);
      this._emit({
        x, y: gy + 0.3 + Math.random() * 0.9, z,
        vx: dirX * carry + (Math.random() - 0.5) * 5,
        vy: 2.5 + Math.random() * 4.5,
        vz: dirZ * carry + (Math.random() - 0.5) * 5,
        w: 0.20 + Math.random() * 0.26,
        life: 0.9 + Math.random() * 0.8,
        r: 1, g: 1, b: 1,
        drag: 1.1, acc: -3.5, turb: 1.6,
        groundY: gy + 0.05, bounce: 0,
        opacity: 0.8, type: T_DROP,
      });
    } else if (!isTar) {
      // ---------- GRIT: hard chips that arc and bounce --------------------
      this._chip(x, gy, z, f, st, 1);
    } else {
      // tarmac: extra soft smoke instead of chips
      this._emit({
        x, y: gy + 0.6 + Math.random(), z,
        vx: dirX * spd * 0.22 + (Math.random() - 0.5) * 2,
        vy: 1.8 + Math.random() * 2.2,
        vz: dirZ * spd * 0.22 + (Math.random() - 0.5) * 2,
        w: 2.2 + Math.random() * 2.0, gw: 3.4 + Math.random() * 2.4,
        life: 2.6 + Math.random() * 1.6,
        r, g, b, drag: 0.9, acc: 1.4, turb: 1.1,
        opacity: 0.14 + Math.random() * 0.10, type: T_SOFT,
      });
    }
  }

  _chip(x, gy, z, f, st, scale) {
    const spd = f.speed;
    this._c2.copy(st.grit);
    const v = 1.0 + Math.random() * 0.55;
    this._emit({
      x, y: gy + 0.16, z,
      vx: f.dirX * spd * (0.30 + Math.random() * 0.40) + (Math.random() - 0.5) * 7,
      vy: 3.5 + Math.random() * 7.5,
      vz: f.dirZ * spd * (0.30 + Math.random() * 0.40) + (Math.random() - 0.5) * 7,
      w: (0.10 + Math.random() * 0.16) * scale,
      h: (0.08 + Math.random() * 0.12) * scale,
      life: 1.4 + Math.random() * 1.3,
      r: this._c2.r * v, g: this._c2.g * v, b: this._c2.b * v,
      drag: 0.12, acc: -19, turb: 0,
      groundY: gy + 0.08, bounce: 0.34,
      rotV: (Math.random() - 0.5) * 9,
      opacity: 0.95, type: T_HARD,
    });
  }

  /** Grass / leaf litter torn out of the verge and blown back. */
  _fleck(f, env) {
    const side = Math.random() < 0.5 ? 1 : -1;
    const w = f.rear[side > 0 ? 0 : 1];
    const off = 0.7 + Math.random() * 1.5;
    this._c2.copy(env.groundColor).multiplyScalar(1.5 + Math.random() * 0.9);
    const spd = f.speed;
    this._emit({
      x: w.x + f.rightX * off * side, y: w.y + 0.12, z: w.z + f.rightZ * off * side,
      vx: f.dirX * spd * 0.30 + f.rightX * side * (1.5 + Math.random() * 3),
      vy: 1.2 + Math.random() * 3.4,
      vz: f.dirZ * spd * 0.30 + f.rightZ * side * (1.5 + Math.random() * 3),
      w: 0.22 + Math.random() * 0.34, h: 0.09 + Math.random() * 0.14,
      life: 0.9 + Math.random() * 1.1,
      r: this._c2.r, g: this._c2.g, b: this._c2.b,
      drag: 1.5, acc: -7.5, turb: 1.2,
      groundY: w.y + 0.06, bounce: 0.12,
      rotV: (Math.random() - 0.5) * 12,
      opacity: 0.9, type: T_HARD,
    });
  }

  /** A stone flicked off the verge — bigger, bounces further. */
  _stone(f, st) {
    const side = Math.random() < 0.5 ? 1 : -1;
    const w = f.rear[side > 0 ? 0 : 1];
    this._chip(
      w.x + f.rightX * (0.4 + Math.random()) * side,
      w.y,
      w.z + f.rightZ * (0.4 + Math.random()) * side,
      f, st, 1.8
    );
  }

  /** Shallow water: a bright fan of droplets plus a low sheet of mist. */
  _spray(x, gy, z, f) {
    const spd = f.speed;
    const side = Math.random() < 0.5 ? 1 : -1;
    if (Math.random() < 0.55) {
      this._emit({
        x, y: gy + 0.15, z,
        vx: f.dirX * spd * 0.35 + f.rightX * side * (3 + Math.random() * 9),
        vy: 3.0 + Math.random() * 7.0,
        vz: f.dirZ * spd * 0.35 + f.rightZ * side * (3 + Math.random() * 9),
        w: 0.16 + Math.random() * 0.30,
        life: 0.55 + Math.random() * 0.6,
        r: 0.85, g: 0.95, b: 1.0,
        drag: 0.8, acc: -16, turb: 0.4,
        groundY: gy, bounce: 0,
        opacity: 0.85, type: T_DROP,
      });
    } else {
      const along = Math.atan2(-f.dirZ, -f.dirX);
      this._emit({
        x, y: gy + 0.25 + Math.random() * 0.5, z,
        vx: f.dirX * spd * 0.28 + f.rightX * side * 2.5,
        vy: 0.7 + Math.random() * 1.4,
        vz: f.dirZ * spd * 0.28 + f.rightZ * side * 2.5,
        w: 1.6 + Math.random() * 2.0, h: 1.0 + Math.random() * 1.2,
        gw: 3.4 + Math.random() * 2.6, gh: 2.2 + Math.random() * 1.6,
        life: 0.9 + Math.random() * 0.8,
        r: 0.92, g: 0.97, b: 1.0,
        drag: 2.0, acc: 0.2, turb: 0.8,
        rot: along, opacity: 0.16 + Math.random() * 0.12,
        type: T_SOFT, flat: 0.75,
      });
    }
  }

  /** Prop collision: sparks, a debris fan and a dust shock. */
  _impact(f, st) {
    const mag = f.impact;
    const n = 10 + Math.floor(mag * 26);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283;
      const s = 4 + Math.random() * 16 * mag;
      this._emit({
        x: f.x + f.fwdX * 1.6, y: f.y + 0.55 + Math.random() * 0.5, z: f.z + f.fwdZ * 1.6,
        vx: Math.cos(a) * s, vy: 2 + Math.random() * 9, vz: Math.sin(a) * s,
        w: 0.10 + Math.random() * 0.16, h: 0.05 + Math.random() * 0.08,
        life: 0.30 + Math.random() * 0.5,
        r: 1.0, g: 0.72 + Math.random() * 0.25, b: 0.30 * Math.random(),
        drag: 0.6, acc: -16, groundY: f.y + 0.05, bounce: 0.3,
        rot: a, opacity: 1, type: T_SPARK,
      });
    }
    const m = 8 + Math.floor(mag * 10);
    for (let i = 0; i < m; i++) {
      const a = Math.random() * 6.283;
      this._c.copy(st.dust).lerp(st.dustHot, Math.random() * 0.5);
      this._emit({
        x: f.x + f.fwdX * 1.4, y: f.y + 0.4, z: f.z + f.fwdZ * 1.4,
        vx: Math.cos(a) * (2 + Math.random() * 7), vy: 1 + Math.random() * 3,
        vz: Math.sin(a) * (2 + Math.random() * 7),
        w: 1.1 + Math.random() * 1.5, gw: 3.0 + Math.random() * 2.5,
        life: 0.9 + Math.random() * 0.9,
        r: this._c.r, g: this._c.g, b: this._c.b,
        drag: 1.8, acc: 0.7, turb: 1.4,
        opacity: 0.22 + Math.random() * 0.14, type: T_SOFT,
      });
      this._chip(f.x + f.fwdX * 1.4, f.y, f.z + f.fwdZ * 1.4, f, st, 1.3);
    }
  }

  // ---------------------------------------------------------------- step ---
  update(dt) {
    if (!(dt > 0)) dt = 1 / 60;
    this.time += dt;

    const env = sampleEnv(this.points, this._envState, this.time);
    const u = this.material.uniforms;
    u.uSunDir.value.copy(env.sunDir);
    u.uSunCol.value.copy(env.sunColor).multiplyScalar(THREE.MathUtils.clamp(env.sunIntensity / 3.0, 0.45, 1.4));
    u.uSkyCol.value.copy(env.skyColor).multiplyScalar(0.42 * THREE.MathUtils.clamp(env.ambIntensity, 0.5, 1.8));
    u.uGndCol.value.copy(env.groundColor);
    u.uFogCol.value.copy(env.fogColor);
    u.uFogDensity.value = env.fogDensity;
    u.uTime.value = this.time;

    this._drive(dt, env);
    FX_CONTACT.frame = null;

    const {
      px, py, pz, vx, vy, vz, life, invLife, sw, sh, gw, gh,
      rot, rotV, drag, acc, turb, groundY, bounce, type, flat,
    } = this;
    const pos = this.aPos.array, size = this.aSize.array;
    const misc = this.aMisc.array, mode = this.aMode.array;
    const t = this.time;
    let alive = 0;

    for (let i = 0; i < this.max; i++) {
      let l = life[i];
      if (l <= 0) { misc[i * 4 + 1] = 0; continue; }
      l -= dt * invLife[i];
      if (l <= 0) { life[i] = 0; misc[i * 4 + 1] = 0; continue; }
      life[i] = l;
      alive++;

      const d = Math.exp(-drag[i] * dt);
      let ux = vx[i] * d, uy = vy[i] * d + acc[i] * dt, uz = vz[i] * d;

      const tb = turb[i];
      if (tb > 0) {
        const s = t * 1.6 + i * 0.37;
        ux += Math.sin(s + pz[i] * 0.28) * tb * dt;
        uz += Math.cos(s * 1.17 + px[i] * 0.28) * tb * dt;
        uy += Math.sin(s * 0.63) * tb * 0.45 * dt;
      }

      let nx = px[i] + ux * dt;
      let ny = py[i] + uy * dt;
      let nz = pz[i] + uz * dt;

      const gyv = groundY[i];
      if (ny < gyv) {
        const bo = bounce[i];
        ny = gyv;
        if (bo > 0 && uy < -1.2) {
          uy = -uy * bo;
          ux *= 0.55; uz *= 0.55;
        } else {
          uy = 0; ux *= 0.30; uz *= 0.30;
          if (type[i] === T_HARD) rotV[i] *= 0.4;
        }
      }

      px[i] = nx; py[i] = ny; pz[i] = nz;
      vx[i] = ux; vy[i] = uy; vz[i] = uz;
      rot[i] += rotV[i] * dt;
      sw[i] += gw[i] * dt;
      sh[i] += gh[i] * dt;

      const j3 = i * 3, j2 = i * 2, j4 = i * 4;
      pos[j3] = nx; pos[j3 + 1] = ny; pos[j3 + 2] = nz;
      size[j2] = sw[i]; size[j2 + 1] = sh[i];
      misc[j4] = rot[i];
      misc[j4 + 1] = l;
      mode[j2] = type[i];
      mode[j2 + 1] = flat[i];
    }
    this.alive = alive;

    this.aPos.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aMisc.needsUpdate = true;
    this.aMode.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.aMisc.array.fill(0);
    this.aMisc.needsUpdate = true;
    this.head = 0;
    this.alive = 0;
    this._acc.dust = this._acc.fleck = this._acc.stone = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
