import * as THREE from 'three';
import { HeightFns, hash01, clamp, smoothstep } from './landforms.js';

/**
 * TERRAIN — heightfield, faceted mesh, vertex colour.
 *
 * CONTRACT (game.js and the world builders depend on this):
 *   new Terrain({size, segments, seed}, palette, biome)
 *   .build()             -> THREE.Mesh, add it to the scene
 *   .heightAt(x, z)      -> number   analytic, safe at 120 Hz
 *   .normalAt(x, z, eps) -> Vector3  central differences
 *   .mesh, .size, .segments
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

  build() {
    const N = this.segments;
    const S = this.size;
    const half = S / 2;
    const seed = this.seed;
    const B = this.biome;
    const cols = this._swatches();

    // --- vertex lattice ----------------------------------------------------
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
      const asp = nx * sx + nz * sz;
      const dl = asp * fc + (hash01(tri, tri >> 11, seed + 777) - 0.5) * gr;
      c.getHSL(hsl);
      let l = clamp(hsl.l + dl, 0.02, 0.99);
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
    // Deliberately NOT a shadow caster. With a 17-25 deg sun a 180 m valley
    // wall throws a 500 m shadow, which at this camera scale swallows the
    // entire drivable frame in one black wedge. Relief is carried by Lambert
    // plus vertex colour; the long shadows that matter are the props'.
    this.mesh.castShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'terrain';
    return this.mesh;
  }
}

export { HeightFns, clamp, smoothstep };
