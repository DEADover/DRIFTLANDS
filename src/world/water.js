import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { lakeLevel, lakeColors, getLakeContext } from './lake.js';

/**
 * WATER — stylised alpine lakes.
 *
 * CONTRACT (game.js depends on this):
 *   new Water(palette, biome)   // optional 3rd arg: terrain
 *   .mesh        THREE.Object3D added to the scene
 *   .update(dt)
 *   .contains(x, z, height) -> boolean
 *
 * ---------------------------------------------------------------------------
 * HOW THE SHORELINE IS MADE
 *
 * v0 was one giant quad at biome.waterLevel. Two things were wrong with that:
 * the level sat below the floor of the world so nothing was ever wet, and even
 * where it wasn't, a single quad has no idea how deep the water under it is,
 * so every pixel of the lake was the same blue right up to a hard geometric
 * edge.
 *
 * This version bakes depth into the mesh. The surface is a 5 m lattice clipped
 * to the flooded cells, carrying a per-vertex `aDepth` = surface minus bed.
 * That one attribute buys everything the reference shows:
 *
 *   - a pale cyan shelf in the first couple of metres, cobalt in the middle;
 *   - a foam line that follows the true waterline, because depth -> 0 there,
 *     rather than a ring drawn at some fixed radius;
 *   - transparency that fades in with shallowness, so the bed and any rock
 *     standing in the water read through the shallows and vanish in the deeps.
 *
 * The shoreline itself is never drawn as an edge at all: the terrain is opaque
 * and higher than the surface everywhere outside the lake, so it clips the
 * water for us and the outline is exactly as organic as the ground is.
 *
 * WHY THE BUILD IS DEFERRED
 * game.js constructs Water as `new Water(palette, biome)` — no terrain, no
 * seed — so at construction time there is no way to ask how deep anything is.
 * bridges.js IS handed {terrain, seed} and is built immediately afterwards, so
 * it parks that context in lake.js and the lattice is built on the first
 * update(), which always runs before the first render. Pass terrain as a third
 * constructor argument and it builds eagerly instead.
 */

const VERT = /* glsl */ `
  attribute float aDepth;
  attribute float aShore;
  varying float vDepth;
  varying float vShore;
  varying vec2 vWorld;
  varying vec3 vPos;
  uniform float uTime;
  void main() {
    vDepth = aDepth;
    vShore = aShore;
    vec3 p = position;
    // A slow swell, killed off in the shallows so the waterline stays put.
    float k = smoothstep(0.0, 2.5, aDepth);
    p.y += sin(p.x * 0.055 + uTime * 0.9) * 0.10 * k
         + sin(p.z * 0.041 - uTime * 0.7) * 0.08 * k;
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorld = wp.xz;
    vPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uMid;
  uniform vec3 uShallow;
  uniform vec3 uShore;
  uniform vec3 uFoam;
  uniform vec3 uSun;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  varying float vDepth;
  varying float vShore;
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
    float d = max(vDepth, 0.0);
    // Horizontal metres to the waterline. This, not depth, is what sets the
    // width of the shelf and the foam: on a bed sloping at 1:15 a 70 cm depth
    // band is ten metres wide on screen, which is why keying the foam off
    // depth alone painted the whole lake white.
    float s = max(vShore, 0.0);

    // --- shelf -> shallow -> mid -> deep ------------------------------------
    // Alpine tarns are 2-6 m deep, so a ramp authored for a nine-metre lake
    // never reaches its own deep colour and the whole body reads as one pale
    // cyan. The shelf is a couple of metres wide and then it is straight into
    // cobalt, which is what the reference does.
    vec3 col = uShore;
    col = mix(col, uShallow, smoothstep(0.2, 2.2, s));
    col = mix(col, uMid,     smoothstep(2.0, 7.5, s));
    col = mix(col, uDeep,    smoothstep(1.6, 4.8, d));

    // Broad ripple bands. Posterised, because everything else in this world is
    // cut paper and a smooth gradient reads as a different game.
    vec2 p = vWorld * 0.013;
    float w = noise(p + vec2(uTime * 0.05, uTime * 0.032));
    w += 0.5 * noise(p * 2.4 - vec2(uTime * 0.07, 0.0));
    w /= 1.5;
    float band = floor(w * 4.0) / 4.0;
    col = mix(col, col * 1.09, band);

    // --- foam at the waterline ---------------------------------------------
    // A bright lip about half a metre wide, chewed up by two noise octaves so
    // it is ragged and — importantly — ABSENT along stretches of shore. An
    // unbroken white piping all the way round the lake is the single loudest
    // tell that the water is a decal rather than a body of water.
    float chew = noise(vWorld * 0.11 + vec2(uTime * 0.05, uTime * 0.035));
    float chew2 = noise(vWorld * 0.38 - vec2(0.0, uTime * 0.14));
    float edge = 0.12 + chew * 0.40 + chew2 * 0.24;
    float lip  = 1.0 - smoothstep(edge * 0.15, edge, s);
    float wash = (1.0 - smoothstep(edge, edge + 1.1, s)) * (0.04 + 0.12 * chew2);
    float gate = smoothstep(0.22, 0.62, chew * 0.75 + chew2 * 0.45);
    float foam = clamp(lip + wash, 0.0, 1.0) * gate;
    col = mix(col, uFoam, foam * 0.82);

    // --- sun glitter --------------------------------------------------------
    float glint = pow(max(0.0, noise(p * 7.0 + uTime * 0.22)), 16.0);
    col += uSun * glint * 1.1 * smoothstep(0.6, 3.0, d);

    // Near-opaque past the shelf; glassy right at the edge so the bed and any
    // rock standing in the shallows read through.
    float alpha = mix(0.86, 0.97, smoothstep(0.4, 2.6, d));
    alpha = max(alpha, foam * 0.95);

    // Match the scene's exponential fog so the lake recedes correctly.
    float dist = length(vPos - cameraPosition);
    float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    col = mix(col, uFogColor, clamp(f, 0.0, 1.0));

    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`;

export class Water {
  constructor(palette, biome, terrain = null) {
    this.palette = palette;
    this.biome = biome;
    this.terrain = terrain;
    this.level = lakeLevel(biome);

    const C = lakeColors(biome, palette);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color(C.deep) },
        uMid: { value: new THREE.Color(C.mid) },
        uShallow: { value: new THREE.Color(C.shallow) },
        uShore: { value: new THREE.Color(C.shore) },
        uFoam: { value: new THREE.Color(C.foam) },
        uSun: { value: new THREE.Color(palette.sunColor) },
        uFogColor: { value: new THREE.Color(palette.fogColor) },
        uFogDensity: { value: palette.fogDensity },
      },
    });

    this.mesh = new THREE.Group();
    this.mesh.name = 'water';

    // A far sheet so anything beyond the lattice (the sea in coastal biomes,
    // the map rim) still reads as water rather than as a hole.
    const fg = new THREE.PlaneGeometry(biome.size * 2.4, biome.size * 2.4, 1, 1);
    fg.rotateX(-Math.PI / 2);
    const far = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: new THREE.Color(C.deep) }));
    far.position.y = this.level - 0.06;
    far.renderOrder = -1;
    this.mesh.add(far);
    this.far = far;

    this.surface = null;
    this._tries = 0;
    if (terrain) this._ensureSurface();
  }

  /** Build the lattice as soon as somebody has told lake.js about the terrain. */
  _ensureSurface() {
    if (this.surface || this._tries > 240) return;
    this._tries++;
    const T = this.terrain ?? getLakeContext(this.biome)?.terrain ?? null;
    if (!T) return;
    this.terrain = T;
    const m = this._buildSurface(T);
    if (m) {
      m.renderOrder = 4;
      this.mesh.add(m);
      this.surface = m;
    } else {
      this._tries = 999; // no water anywhere in this biome; stop looking.
    }
  }

  /**
   * The clipped lattice. Cells whose four corners are all well clear of the
   * water are skipped, which is 97%+ of the map — a lake costs a few thousand
   * triangles, not a hundred thousand.
   */
  _buildSurface(T) {
    const S = this.biome.size;
    const half = S / 2;
    const cell = 5.0;
    const N = Math.ceil(S / cell);
    const VN = N + 1;

    const depth = new Float32Array(VN * VN);
    let wet = 0;
    for (let j = 0; j < VN; j++) {
      const z = -half + j * cell;
      for (let i = 0; i < VN; i++) {
        const x = -half + i * cell;
        const d = this.level - T.heightAt(x, z);
        depth[j * VN + i] = d;
        if (d > 0) wet++;
      }
    }
    if (wet === 0) return null;

    // Horizontal distance to the waterline, estimated as depth / bed slope.
    // The exact distance transform would be quantised to the 5 m cell, far too
    // coarse for a two-metre foam line; this is continuous and is accurate
    // precisely where it matters, in the first few metres off the shore.
    const shore = new Float32Array(VN * VN);
    for (let j = 0; j < VN; j++) {
      for (let i = 0; i < VN; i++) {
        const k = j * VN + i;
        const d = depth[k];
        const dx = (depth[k + (i < N ? 1 : 0)] - depth[k - (i > 0 ? 1 : 0)]) / (cell * ((i > 0 && i < N) ? 2 : 1));
        const dz = (depth[k + (j < N ? VN : 0)] - depth[k - (j > 0 ? VN : 0)]) / (cell * ((j > 0 && j < N) ? 2 : 1));
        const g = Math.hypot(dx, dz);
        shore[k] = g > 1e-4 ? d / g : d * 40;
      }
    }

    // Boulders in and around the water, and the foam collar they earn.
    // The shore field is stamped BEFORE the lattice is emitted, so the white
    // ring around each rock falls out of the same attribute that draws the
    // shoreline — no second pass, no decal, no sorting problem.
    this._scatterRocks(T, { depth, shore, VN, N, cell, half });

    const pos = [];
    const dep = [];
    const sho = [];
    // 2.5 m of headroom: keep a ring of dry vertices so the shoreline
    // triangles exist and the terrain, not the mesh boundary, does the cutting.
    const KEEP = -2.5;
    const push = (i, j) => {
      pos.push(-half + i * cell, this.level, -half + j * cell);
      dep.push(depth[j * VN + i]);
      sho.push(Math.max(-60, Math.min(60, shore[j * VN + i])));
    };
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = depth[j * VN + i], b = depth[j * VN + i + 1];
        const c = depth[(j + 1) * VN + i], e = depth[(j + 1) * VN + i + 1];
        if (a < KEEP && b < KEEP && c < KEEP && e < KEEP) continue;
        push(i, j); push(i, j + 1); push(i + 1, j);
        push(i + 1, j); push(i, j + 1); push(i + 1, j + 1);
      }
    }
    if (!pos.length) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(dep), 1));
    geo.setAttribute('aShore', new THREE.BufferAttribute(new Float32Array(sho), 1));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, this.material);
    m.name = 'lakeSurface';
    m.matrixAutoUpdate = false;
    return m;
  }

  /**
   * SHORE AND SUBMERGED BOULDERS.
   *
   * props.js scatters the meadow's rocks, but it is told to keep out of the
   * lake (see bridges.js isBlocked) — otherwise it plants trees under water.
   * The reference frame is full of grey boulders standing in the shallows with
   * a white collar of foam, so the lake grows its own.
   *
   * Two populations: emergent rocks that break the surface along the shore
   * line, and flatter submerged slabs a metre or two down that read as shapes
   * THROUGH the water, which is what sells the transparency.
   */
  _scatterRocks(T, F) {
    const { depth, shore, VN, N, cell, half } = F;
    const seed = getLakeContext(this.biome)?.seed ?? 1337;
    const rng = new Rng((seed * 2654435761) ^ 0x5eed);
    const P = this.palette;
    const base = new THREE.Color(P.rock ?? 0x8f9099);
    const dark = new THREE.Color(P.rockShadow ?? 0x5f6069);

    const pos = [];
    const nor = [];
    const col = [];
    const stamps = [];

    const proto = [];
    for (let v = 0; v < 5; v++) {
      const g = new THREE.IcosahedronGeometry(1, 0).toNonIndexed();
      const a = g.attributes.position.array;
      // Squash and dent it: perfect icosahedra read as dice, not granite.
      const sy = 0.42 + rng.float() * 0.42;
      for (let i = 0; i < a.length; i += 3) {
        a[i] *= 0.8 + rng.float() * 0.5;
        a[i + 1] *= sy;
        a[i + 2] *= 0.8 + rng.float() * 0.5;
      }
      g.computeVertexNormals();
      proto.push(g);
    }

    const place = (x, z, r, sink, lit, collar) => {
      const g = proto[(rng.int(0, 4))];
      const yaw = rng.float() * Math.PI * 2;
      const m = new THREE.Matrix4()
        .makeRotationY(yaw)
        .premultiply(new THREE.Matrix4().makeScale(r, r * (0.7 + rng.float() * 0.6), r))
        .setPosition(x, this.level - sink, z);
      const nm = new THREE.Matrix3().setFromMatrix4(m).invert().transpose();
      const p = g.attributes.position.array;
      const nn = g.attributes.normal.array;
      const c = base.clone().lerp(dark, rng.float() * 0.55).multiplyScalar(lit);
      const v = new THREE.Vector3(), nv = new THREE.Vector3();
      for (let i = 0; i < p.length; i += 3) {
        v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m);
        nv.set(nn[i], nn[i + 1], nn[i + 2]).applyMatrix3(nm).normalize();
        pos.push(v.x, v.y, v.z);
        nor.push(nv.x, nv.y, nv.z);
        col.push(c.r, c.g, c.b);
      }
      if (collar) stamps.push({ x, z, r: r * 0.95 });
    };

    // Walk the lattice cells and drop rocks where the depth band is right.
    // Every rock SITS ON THE BED: y = bed + a fraction of its radius. Placing
    // them relative to the surface instead left boulders hovering in five
    // metres of water like buoys.
    for (let j = 1; j < N; j++) {
      for (let i = 1; i < N; i++) {
        const d = depth[j * VN + i];
        // Past ~3.5 m the water is opaque, so a rock down there is a rock
        // nobody will ever see — and its foam collar would be a white ring
        // floating on empty blue. Keep the population in the readable band.
        if (d < -0.5 || d > 3.6) continue;
        const emergent = d < 2.0;
        if (rng.float() > (emergent ? 0.055 : 0.030)) continue;
        const x = -half + i * cell + (rng.float() - 0.5) * cell;
        const z = -half + j * cell + (rng.float() - 0.5) * cell;
        const r = emergent ? 1.0 + rng.float() * 2.1 : 1.2 + rng.float() * 1.8;
        // Centre height above the bed. Emergent rocks break the surface;
        // submerged ones stay a comfortable margin under it.
        const rise = emergent ? r * 0.50 : Math.min(r * 0.38, Math.max(0.2, d - 0.9));
        // Only something that reaches the surface gets a foam collar.
        const collar = (rise + r * 0.5) - d > -0.7;
        place(x, z, r, d - rise, emergent ? 1.0 : 0.82, collar);
      }
    }

    // Foam collar. Only the shore field is stamped — stamping the DEPTH field
    // too painted a ten-metre pale shelf around every rock, which at this
    // camera height read as a white blob rather than a wet stone.
    for (const st of stamps) {
      const pad = st.r + 4;
      const i0 = Math.max(0, Math.floor((st.x + half - pad) / cell));
      const i1 = Math.min(N, Math.ceil((st.x + half + pad) / cell));
      const j0 = Math.max(0, Math.floor((st.z + half - pad) / cell));
      const j1 = Math.min(N, Math.ceil((st.z + half + pad) / cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * VN + i;
          const dx = (-half + i * cell) - st.x, dz = (-half + j * cell) - st.z;
          const e = Math.hypot(dx, dz) - st.r;
          if (e < shore[k]) shore[k] = e;
        }
      }
    }

    for (const g of proto) g.dispose();
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      vertexColors: true, flatShading: true,
    }));
    m.name = 'lakeRocks';
    m.castShadow = true;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    this.mesh.add(m);
    this.rocks = m;
  }

  update(dt) {
    if (!this.surface) this._ensureSurface();
    this.material.uniforms.uTime.value += dt;
  }

  /** True if this world position is under water. */
  contains(x, z, height) {
    return height < this.level;
  }

  /** Metres of water at (x, z); negative on dry land. */
  depthAt(x, z) {
    if (!this.terrain) return 0;
    return this.level - this.terrain.heightAt(x, z);
  }
}
