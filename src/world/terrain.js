import * as THREE from 'three';
import { HeightFns, hash01, clamp, smoothstep } from './landforms.js';

/**
 * TERRAIN — heightfield, faceted mesh, vertex colour.
 *
 * CONTRACT (game.js and the world builders depend on this):
 *   new Terrain({size, segments, seed}, palette, biome)
 *   .build()             -> THREE.Mesh, add it to the scene
 *   .heightAt(x, z)      -> number   analytic DESIGN field, safe at 120 Hz
 *   .normalAt(x, z, eps) -> Vector3  central differences on the design field
 *   .drawnHeightAt(x, z) -> number   the triangle that is actually on screen
 *   .drawnNormalAt(x, z) -> Vector3  that triangle's face normal
 *   .mesh, .size, .segments
 *
 * TWO HEIGHTS, ON PURPOSE — read this before using either.
 *
 *   `heightAt` is the analytic field. Every world builder plans against it
 *   (routes, lakes, prop scatter, landmark pads) and it must keep returning the
 *   smooth field, because it is what DECIDES where the landforms are. It is not,
 *   and never was, the height of the surface the player can see.
 *
 *   `drawnHeightAt` is that surface: the exact plane of the exact triangle
 *   build() emitted, jitter, axis warp, alternating diagonal and all. Anything
 *   that has to TOUCH the ground — a wheel, a fence post, the toe of an
 *   embankment — asks this one. Measured on the shipped build before it existed,
 *   the gap between the two ran to 2.14 m on a ridge (mean 1.28 m over the
 *   terrain-borne contact patches), which is the whole of the "the car sinks
 *   into the ground" complaint on bare terrain and most of it on the road.
 *
 * INTERNAL contract with biomes.js (the two files are owned together):
 *   biome.height(x, z, seed) -> number
 *   biome.colorAt(color, cols, h, slope, x, z, seed) -> mutates `color`
 *   where `cols` is the prepared palette.terrain swatch set (see _swatches).
 *
 * Three things make this read as art of rally rather than a paint bucket:
 *
 *  1. IRREGULAR GRID. Interior vertices are jittered inside their cell, so the
 *     triangles are all slightly different shapes and the regular weave that
 *     screams "heightmap" disappears. Border vertices are never jittered, so
 *     the map edge stays a clean straight line.
 *
 *  2. INTERIOR-BIASED RESOLUTION. The axis warp packs facets into the drivable
 *     middle and stretches them at the rim, for the same triangle budget. Near
 *     facets stay crisp; distant mountains stay cheap.
 *
 *  3. FACET CHARACTER. After the biome picks a base colour, every triangle gets
 *     an aspect-driven value push (does this plane face the sun?) plus a small
 *     per-facet grain. Lambert alone cannot separate two facets that differ by
 *     three degrees; this can. It is the whole cut-paper identity.
 */
export class Terrain {
  /**
   * @param {object} cfg
   * @param {number} cfg.size      world extent in metres (square, centred on origin)
   * @param {number} cfg.segments  grid resolution (higher = finer facets)
   */
  constructor(cfg, palette, biome) {
    this.size = cfg.size ?? 1600;
    this.segments = cfg.segments ?? 320;
    this.palette = palette;
    this.biome = biome;
    this.seed = cfg.seed ?? 1337;
    this.mesh = null;
  }

  /** World-space height query. Analytic — no grid sampling, no interpolation. */
  heightAt(x, z) {
    return this.biome.height(x, z, this.seed);
  }

  /** Surface normal via central differences — used for car pitch/roll. */
  normalAt(x, z, eps = 1.5) {
    const hL = this.heightAt(x - eps, z);
    const hR = this.heightAt(x + eps, z);
    const hD = this.heightAt(x, z - eps);
    const hU = this.heightAt(x, z + eps);
    return new THREE.Vector3(hL - hR, 2 * eps, hD - hU).normalize();
  }

  // -------------------------------------------------------------------------
  // THE DRAWN SURFACE
  //
  // `heightAt` is a smooth field; the mesh is flat triangles through samples of
  // it on a warped, jittered lattice. Inside a cell the two disagree by the sag
  // of the chord — tens of centimetres on open ground, over two metres across a
  // ridge — and every one of those centimetres is a wheel below the picture.
  // These three methods answer with the plane of the triangle that is on
  // screen, so nothing has to guess.
  // -------------------------------------------------------------------------

  /**
   * Invert the axis warp: given axis(s), recover s.
   *
   * axis(s) = a·s + (1-a)·s³ is strictly increasing on [-1, 1] (its derivative
   * never falls below `a`), so Newton from s = y walks straight down to the one
   * real root — three or four steps at a = 0.6. It only has to be good enough
   * to name the right lattice column; the barycentric test below is what
   * actually decides which triangle the point is in.
   */
  _axisInv(y) {
    const a = this._lat.a;
    if (a >= 1) return y;
    const k = 1 - a;
    let s = y;
    for (let n = 0; n < 24; n++) {
      const f = a * s + k * s * s * s - y;
      const step = f / Math.max(a + 3 * k * s * s, 1e-9);
      s -= step;
      if (Math.abs(step) < 1e-13) break;
    }
    return s;
  }

  /**
   * Height of lattice vertex `idx` AS DRAWN, memoised.
   *
   * Not simply `vy[idx]`, because water.js `carveLakes()` runs after build(),
   * swaps `heightAt` for the carved field and re-drapes every mesh vertex in
   * place to match — same x and z, new y. Reading the live `heightAt` therefore
   * tracks the mesh through the carve; the cache is dropped wholesale the first
   * time the function identity changes, which is exactly when the mesh moved.
   *
   * Math.fround because build() stores the vertex in a Float32Array: the drawn
   * corner is the float32 of this number, and rounding here is the difference
   * between agreeing with the triangle to 1e-6 m and to 1e-4 m.
   */
  _cornerY(idx) {
    if (this._dyFn !== this.heightAt) {
      this._dyFn = this.heightAt;
      this._dyOk.fill(0);
    }
    if (!this._dyOk[idx]) {
      this._dy[idx] = Math.fround(this.heightAt(this._lat.vx[idx], this._lat.vz[idx]));
      this._dyOk[idx] = 1;
    }
    return this._dy[idx];
  }

  /**
   * Barycentric test of one triangle in the XZ plane. On a hit the corner
   * indices and weights are left in scratch fields — no object is allocated,
   * because this runs a dozen-odd times per wheel per frame.
   */
  _tri(a, b, c, x, z) {
    const { vx, vz } = this._lat;
    const ax = vx[a], az = vz[a], bx = vx[b], bz = vz[b], cx = vx[c], cz = vz[c];
    const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (den === 0) return -Infinity;
    const inv = 1 / den;
    const w0 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) * inv;
    const w1 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) * inv;
    const w2 = 1 - w0 - w1;
    const m = Math.min(w0, w1, w2);
    if (m > this._bm) {
      this._bm = m;
      this._ta = a; this._tb = b; this._tc = c;
      this._w0 = w0; this._w1 = w1; this._w2 = w2;
    }
    return m;
  }

  /**
   * Both triangles of cell (i, j), split on the SAME diagonal build() chose.
   * `(i + j) & 1` is the whole of it, and getting it backwards costs the full
   * chord sag of the cell — which on a 10 m facet is the bug this file is
   * fixing, not a rounding difference.
   */
  _cell(i, j, x, z) {
    const VN = this._lat.VN;
    const i00 = j * VN + i, i10 = i00 + 1, i01 = i00 + VN, i11 = i01 + 1;
    if ((i + j) & 1) {
      if (this._tri(i00, i01, i10, x, z) >= 0) return true;
      if (this._tri(i10, i01, i11, x, z) >= 0) return true;
    } else {
      if (this._tri(i00, i11, i10, x, z) >= 0) return true;
      if (this._tri(i00, i01, i11, x, z) >= 0) return true;
    }
    return false;
  }

  /**
   * Find the drawn triangle under (x, z). Returns false only when the point is
   * off the mesh entirely.
   *
   * WHY A 3x3 SEARCH AND NOT A LOOKUP. The axis warp inverts exactly, so the
   * REGULAR lattice cell is known in closed form — but pass B then slides every
   * interior vertex by up to jitter/N in warp space, which is 0.2 of a cell.
   * A point can therefore sit inside the quad one column over. ±1 is provably
   * enough (the displacement is bounded), and the cached cell means the walk
   * almost never happens twice for the same wheel.
   */
  _locate(x, z) {
    const L = this._lattice();
    const N = L.N;
    this._bm = -Infinity;
    if (this._li >= 0 && this._cell(this._li, this._lj, x, z)) return true;

    let ci = Math.floor((this._axisInv(x / L.half) + 1) * 0.5 * N);
    let cj = Math.floor((this._axisInv(z / L.half) + 1) * 0.5 * N);
    if (!(ci >= 0)) ci = 0; else if (ci > N - 1) ci = N - 1;
    if (!(cj >= 0)) cj = 0; else if (cj > N - 1) cj = N - 1;

    for (let dj = 0; dj <= 2; dj++) {
      const j = cj + (dj === 0 ? 0 : dj === 1 ? -1 : 1);
      if (j < 0 || j > N - 1) continue;
      for (let di = 0; di <= 2; di++) {
        const i = ci + (di === 0 ? 0 : di === 1 ? -1 : 1);
        if (i < 0 || i > N - 1) continue;
        if (this._cell(i, j, x, z)) { this._li = i; this._lj = j; return true; }
      }
    }
    // Nothing contained it. Outside the map there is no triangle at all; just
    // inside the rim the best near-miss is the right answer, and the plane it
    // names is the one the ray would have hit.
    if (this._bm < -0.05) return false;
    this._li = ci; this._lj = cj;
    return true;
  }

  /**
   * Height of the triangle that is actually drawn at (x, z). Falls back to the
   * analytic field off the mesh, where there is nothing to disagree with.
   */
  drawnHeightAt(x, z) {
    if (!this._locate(x, z)) return this.heightAt(x, z);
    return this._cornerY(this._ta) * this._w0
      + this._cornerY(this._tb) * this._w1
      + this._cornerY(this._tc) * this._w2;
  }

  /**
   * That triangle's face normal, oriented upward.
   *
   * Flat-shaded terrain has no other normal: the smooth `normalAt` is the
   * gradient of a field the mesh only samples, and a car taking its roll from
   * it sits visibly off the facet it is standing on.
   */
  drawnNormalAt(x, z, out) {
    const v = out ?? new THREE.Vector3();
    if (!this._locate(x, z)) return v.copy(this.normalAt(x, z));
    const { vx, vz } = this._lat;
    const a = this._ta, b = this._tb, c = this._tc;
    const ax = vx[a], ay = this._cornerY(a), az = vz[a];
    const e1x = vx[b] - ax, e1y = this._cornerY(b) - ay, e1z = vz[b] - az;
    const e2x = vx[c] - ax, e2y = this._cornerY(c) - ay, e2z = vz[c] - az;
    v.set(
      e1y * e2z - e1z * e2y,
      e1z * e2x - e1x * e2z,
      e1x * e2y - e1y * e2x,
    );
    if (v.y < 0) v.negate();
    return v.normalize();
  }

  /** Prepared colour swatches, with graceful fallback to the legacy fields. */
  _swatches() {
    const p = this.palette;
    const T = p.terrain ?? {};
    const g = p.ground;
    const col = (hex, fb) => new THREE.Color(hex ?? fb);
    return {
      ramp: (T.ramp ?? g).map((h) => new THREE.Color(h)),
      lowland: col(T.lowland, g[0]),
      patchA: col(T.patchA, g[2]),
      patchB: col(T.patchB, g[0]),
      scree: col(T.scree, p.rock),
      cliff: col(T.cliff, p.rock),
      soil: col(T.soil, p.rockShadow),
      sand: col(T.sand, g[3]),
      summit: col(T.summit, g[g.length - 1]),
      facetContrast: T.facetContrast ?? 0.45,
      grain: T.grain ?? 0.03,
      bands: T.bands ?? 0,
    };
  }

  /**
   * THE VERTEX LATTICE, built once and kept.
   *
   * It used to live inside build() as three local arrays, which meant the only
   * record of where the drawn vertices ended up was the position buffer — and
   * nothing could ask "what is the height of the triangle at (x, z)?" without
   * raycasting the scene. Hoisting it here changes not one number in the mesh
   * (build() still reads exactly these arrays) and gives `drawnHeightAt` a cell
   * it can regenerate the corners of in O(1).
   *
   * PASS B IS SEQUENTIAL AND THAT IS WHY THIS IS A TABLE, NOT A FUNCTION. The
   * slope gate for vertex (i, j) reads its four lattice neighbours, and by the
   * time it runs, (i-1, j) and (i, j-1) have ALREADY been jittered while
   * (i+1, j) and (i, j+1) have not. So a vertex's position depends on the whole
   * rectangle below-left of it. Recomputing one cell on demand would have to
   * replay that cone; storing the lattice costs 1.2 MB at N=320 and replays
   * nothing.
   */
  _lattice() {
    if (this._lat) return this._lat;
    const N = this.segments;
    const half = this.size / 2;
    const seed = this.seed;
    const B = this.biome;

    // Axis warp: s -> s*(a + (1-a)s^2). The derivative is `a` at the centre and
    // 3-2a at the rim, so with a = 0.6 the drivable interior gets ~1.7x the
    // facet density of the rim without spending a single extra triangle.
    const a = B.lodBias ?? 0.6;
    const axis = (s) => s * (a + (1 - a) * s * s);
    const jitter = B.meshJitter ?? 0.4;

    const VN = N + 1;
    const vx = new Float32Array(VN * VN);
    const vy = new Float32Array(VN * VN);
    const vz = new Float32Array(VN * VN);
    const jk = (jitter * 2) / N;

    // Pass A — regular lattice. Cheap, and it gives us a local gradient without
    // any extra height queries.
    for (let j = 0; j < VN; j++) {
      for (let i = 0; i < VN; i++) {
        const x = half * axis((i / N) * 2 - 1);
        const z = half * axis((j / N) * 2 - 1);
        const idx = j * VN + i;
        vx[idx] = x;
        vz[idx] = z;
        vy[idx] = B.height(x, z, seed);
      }
    }

    // Pass B — SLOPE-AWARE jitter.
    //
    // Jitter is what kills the heightmap weave, but applied blindly it wrecks
    // exactly the features we care most about. On a mesa riser the height jumps
    // a full terrace step across one cell, so randomising which side of the
    // step each vertex lands on turns a clean vertical cliff into a row of
    // shark teeth (and does the same to sea cliffs). So: full jitter on open
    // ground, none at all on anything approaching vertical.
    for (let j = 1; j < N; j++) {
      for (let i = 1; i < N; i++) {
        const idx = j * VN + i;
        const dx = Math.abs(vy[idx + 1] - vy[idx - 1]) / (vx[idx + 1] - vx[idx - 1] || 1);
        const dz = Math.abs(vy[idx + VN] - vy[idx - VN]) / (vz[idx + VN] - vz[idx - VN] || 1);
        const g = Math.max(Math.abs(dx), Math.abs(dz));  // metres per metre
        const soft = 1 - smoothstep(0.35, 1.1, g);       // 19 deg .. 48 deg
        if (soft <= 0.02) continue;
        const su = (i / N) * 2 - 1 + (hash01(i, j, seed + 17) - 0.5) * jk * soft;
        const sv = (j / N) * 2 - 1 + (hash01(i, j, seed + 91) - 0.5) * jk * soft;
        const x = half * axis(clamp(su, -1, 1));
        const z = half * axis(clamp(sv, -1, 1));
        vx[idx] = x;
        vz[idx] = z;
        vy[idx] = B.height(x, z, seed);
      }
    }

    this._lat = { N, VN, half, a, vx, vy, vz };
    // Corner heights AS DRAWN, filled lazily by _cornerY (see there for why they
    // are not just vy).
    this._dy = new Float32Array(VN * VN);
    this._dyOk = new Uint8Array(VN * VN);
    this._dyFn = null;
    this._li = -1; this._lj = -1;
    return this._lat;
  }

  build() {
    const N = this.segments;
    const seed = this.seed;
    const B = this.biome;
    const cols = this._swatches();
    const { VN, vx, vy, vz } = this._lattice();

    // --- triangles ---------------------------------------------------------
    const triCount = N * N * 2;
    const positions = new Float32Array(triCount * 9);
    const colors = new Float32Array(triCount * 9);

    const c = new THREE.Color();
    // Horizontal sun bearing — used for the aspect push.
    const sx = Math.cos(this.palette.sunAzimuth ?? 2.35);
    const sz = Math.sin(this.palette.sunAzimuth ?? 2.35);
    const fc = cols.facetContrast;
    const gr = cols.grain;
    const bands = cols.bands;

    let p = 0, q = 0, tri = 0;
    const hsl = { h: 0, s: 0, l: 0 };

    const emit = (i0, i1, i2) => {
      const ax = vx[i0], ay = vy[i0], az = vz[i0];
      const bx = vx[i1], by = vy[i1], bz = vz[i1];
      const cx = vx[i2], cy = vy[i2], cz = vz[i2];

      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const il = 1 / (Math.hypot(nx, ny, nz) || 1);
      nx *= il; ny *= il; nz *= il;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }

      const hAvg = (ay + by + cy) / 3;
      const mx = (ax + bx + cx) / 3;
      const mz = (az + bz + cz) / 3;

      B.colorAt(c, cols, hAvg, 1 - ny, mx, mz, seed);

      // Facet character. `asp` is the horizontal component of the face normal
      // projected onto the sun bearing: positive = this plane leans into the
      // light. A few percent of lightness here separates facets that Lambert
      // would otherwise render identically.
      //
      // The push is MULTIPLICATIVE in linear light, i.e. a constant number of
      // stops, not a constant lightness offset. The additive form was value-
      // blind: on a dark green (linear l ~ 0.12) a +0.06 push is +50%, on a pale
      // rock (l ~ 0.45) it is +13%. Measured on the alpine meadow that turned
      // every sun-facing bank acid — albedo HSV value 52% arriving on screen at
      // 70% — while shaded ground stayed flat. As a gain it reads the same
      // everywhere and the facets still separate.
      const asp = nx * sx + nz * sz;
      const dl = asp * fc + (hash01(tri, tri >> 11, seed + 777) - 0.5) * gr;
      c.getHSL(hsl);
      let l = clamp(hsl.l * (1 + dl), 0.02, 0.99);
      if (bands) l = Math.round(l * bands) / bands; // posterise: cut-paper tell
      c.setHSL(hsl.h, hsl.s, l);

      positions[p++] = ax; positions[p++] = ay; positions[p++] = az;
      positions[p++] = bx; positions[p++] = by; positions[p++] = bz;
      positions[p++] = cx; positions[p++] = cy; positions[p++] = cz;
      for (let k = 0; k < 3; k++) {
        colors[q++] = c.r; colors[q++] = c.g; colors[q++] = c.b;
      }
      tri++;
    };

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const i00 = j * VN + i, i10 = i00 + 1;
        const i01 = i00 + VN, i11 = i01 + 1;
        // Alternate the diagonal so no directional weave survives.
        if ((i + j) & 1) {
          emit(i00, i01, i10);
          emit(i10, i01, i11);
        } else {
          emit(i00, i11, i10);
          emit(i00, i01, i11);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    // SELF-SHADOWING is opt-in per biome (`biome.terrainShadow`).
    //
    // It used to be off everywhere, and for good reason: with a 17-25 deg sun a
    // 180 m valley wall throws a 500 m shadow, which at this camera scale
    // swallows the whole drivable frame in one black wedge. But that argument
    // only holds for landforms with walls near the drive. Alpine no longer has
    // any — its drivable band rolls ±20 m over 190 m under a 29 deg sun, so a
    // crest throws an 18 m shadow: exactly the soft ground-modelling shading the
    // reference frame uses to describe its rises and hollows, and the single
    // biggest source of the value spread ours was missing (18 points against the
    // reference's 27). Biomes that still have walls simply leave the flag off.
    this.mesh.castShadow = !!this.biome.terrainShadow;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'terrain';
    return this.mesh;
  }
}

export { HeightFns, clamp, smoothstep };
