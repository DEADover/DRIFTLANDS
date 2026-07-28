import * as THREE from 'three';
import { fbm, ridged } from '../core/rng.js';

/**
 * Heightfield terrain with flat-shaded, vertex-coloured triangles.
 *
 * Flat shading + vertex colour is the whole visual identity: no textures, hard
 * facets catching the sun, colour driven by altitude and slope. Keep it that way.
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
    this._heights = null;
    this.mesh = null;
  }

  /** World-space height query. Bilinear over the sampled grid. */
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

  build() {
    const N = this.segments;
    const S = this.size;
    const half = S / 2;
    const step = S / N;

    const vertCount = N * N * 6;
    const positions = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);

    const c = new THREE.Color();
    const ramp = this.palette.ground.map((h) => new THREE.Color(h));
    const rockCol = new THREE.Color(this.palette.rock);

    // Precompute heights on the grid.
    const H = new Float32Array((N + 1) * (N + 1));
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        H[j * (N + 1) + i] = this.heightAt(-half + i * step, -half + j * step);
      }
    }
    this._heights = H;

    let p = 0, q = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), nrm = new THREE.Vector3();

    const pushTri = (x0, z0, x1, z1, x2, z2) => {
      const h0 = this._sample(H, N, half, step, x0, z0);
      const h1 = this._sample(H, N, half, step, x1, z1);
      const h2 = this._sample(H, N, half, step, x2, z2);
      a.set(x0, h0, z0); b.set(x1, h1, z1); d.set(x2, h2, z2);
      ab.subVectors(b, a); ac.subVectors(d, a);
      nrm.crossVectors(ab, ac).normalize();
      const slope = 1 - Math.abs(nrm.y);
      const hAvg = (h0 + h1 + h2) / 3;

      this.biome.colorAt(c, ramp, rockCol, hAvg, slope, (x0 + x1 + x2) / 3, (z0 + z1 + z2) / 3, this.seed);

      for (const v of [a, b, d]) {
        positions[p++] = v.x; positions[p++] = v.y; positions[p++] = v.z;
        colors[q++] = c.r; colors[q++] = c.g; colors[q++] = c.b;
      }
    };

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x0 = -half + i * step, z0 = -half + j * step;
        const x1 = x0 + step, z1 = z0 + step;
        // Alternate the diagonal to avoid a visible directional weave.
        if ((i + j) & 1) {
          pushTri(x0, z0, x0, z1, x1, z0);
          pushTri(x1, z0, x0, z1, x1, z1);
        } else {
          pushTri(x0, z0, x1, z1, x1, z0);
          pushTri(x0, z0, x0, z1, x1, z1);
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
    this.mesh.castShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'terrain';
    return this.mesh;
  }

  _sample(H, N, half, step, x, z) {
    const i = Math.round((x + half) / step);
    const j = Math.round((z + half) / step);
    const ii = Math.max(0, Math.min(N, i));
    const jj = Math.max(0, Math.min(N, j));
    return H[jj * (N + 1) + ii];
  }
}

// ---------------------------------------------------------------------------
// Height field building blocks, shared by biomes.
// ---------------------------------------------------------------------------

export const HeightFns = {
  rollingHills(x, z, seed, { scale = 0.0022, amp = 26 } = {}) {
    return fbm(x * scale, z * scale, { octaves: 4, seed }) * amp;
  },
  mountains(x, z, seed, { scale = 0.0016, amp = 130 } = {}) {
    const r = ridged(x * scale, z * scale, { octaves: 5, seed: seed + 7 });
    return Math.pow(Math.max(0, r), 2.1) * amp;
  },
  plateau(x, z, seed, { scale = 0.0018, amp = 55, sharpness = 3.5 } = {}) {
    const n = (fbm(x * scale, z * scale, { octaves: 3, seed: seed + 13 }) + 1) * 0.5;
    return Math.pow(n, 1 / sharpness) * amp;
  },
  detail(x, z, seed, amp = 2.2) {
    return fbm(x * 0.02, z * 0.02, { octaves: 2, seed: seed + 91 }) * amp;
  },
};
