import * as THREE from 'three';
import { Rng, fbm } from '../core/rng.js';

/**
 * Scatter props. Everything is instanced — one draw call per prop family.
 *
 * Composition rule from the reference: SPARSE, with clustering. Big empty
 * areas, then a copse. Never uniform noise.
 */

function coneTree(rng, palette) {
  const g = new THREE.BufferGeometry();
  // Built as a stack of 2-3 cones so the silhouette has steps, like the ref.
  const parts = [];
  const tiers = rng.int(2, 3);
  let y = 1.6;
  let r = rng.float(2.0, 2.9);
  for (let i = 0; i < tiers; i++) {
    const h = rng.float(3.0, 4.4);
    const cone = new THREE.ConeGeometry(r, h, rng.int(5, 7), 1);
    cone.translate(0, y + h / 2, 0);
    parts.push(cone);
    y += h * 0.62;
    r *= 0.66;
  }
  const trunk = new THREE.CylinderGeometry(0.28, 0.36, 2.0, 5);
  trunk.translate(0, 1.0, 0);
  parts.push(trunk);
  return mergeGeometries(parts);
}

function blobTree(rng) {
  const parts = [];
  const trunkH = rng.float(2.2, 3.4);
  const trunk = new THREE.CylinderGeometry(0.26, 0.42, trunkH, 5);
  trunk.translate(0, trunkH / 2, 0);
  parts.push(trunk);
  const blobs = rng.int(2, 4);
  for (let i = 0; i < blobs; i++) {
    const r = rng.float(1.5, 2.6);
    const s = new THREE.IcosahedronGeometry(r, 0);
    s.translate(rng.gauss(0, 1.0), trunkH + rng.float(0.4, 1.8), rng.gauss(0, 1.0));
    parts.push(s);
  }
  return mergeGeometries(parts);
}

function rockGeom(rng) {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) * rng.float(0.7, 1.3),
      pos.getY(i) * rng.float(0.5, 1.0),
      pos.getZ(i) * rng.float(0.7, 1.3)
    );
  }
  g.computeVertexNormals();
  return g;
}

function cactusGeom(rng) {
  const parts = [];
  const h = rng.float(3.5, 6.0);
  const body = new THREE.CylinderGeometry(0.55, 0.7, h, 7);
  body.translate(0, h / 2, 0);
  parts.push(body);
  const arms = rng.int(0, 2);
  for (let i = 0; i < arms; i++) {
    const ah = rng.float(1.6, 2.6);
    const arm = new THREE.CylinderGeometry(0.35, 0.4, ah, 6);
    const side = rng.sign();
    arm.translate(side * 0.9, h * rng.float(0.45, 0.7) + ah / 2, 0);
    parts.push(arm);
    const cross = new THREE.CylinderGeometry(0.33, 0.33, 1.1, 6);
    cross.rotateZ(Math.PI / 2);
    cross.translate(side * 0.5, h * rng.float(0.45, 0.7), 0);
    parts.push(cross);
  }
  return mergeGeometries(parts);
}

/** Minimal BufferGeometry merge — avoids pulling in the addons bundle. */
export function mergeGeometries(geos) {
  // Indexed geometry expands to index-count vertices once de-indexed, so size
  // the buffer off the index when there is one.
  let total = 0;
  for (const g of geos) total += g.index ? g.index.count : g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    const gi = g.index;
    const p = g.attributes.position;
    const n = g.attributes.normal ?? (g.computeVertexNormals(), g.attributes.normal);
    if (gi) {
      // Expand indexed geometry into non-indexed to keep the merge simple.
      const np = new Float32Array(gi.count * 3);
      const nn = new Float32Array(gi.count * 3);
      for (let i = 0; i < gi.count; i++) {
        const v = gi.getX(i);
        np[i * 3] = p.getX(v); np[i * 3 + 1] = p.getY(v); np[i * 3 + 2] = p.getZ(v);
        nn[i * 3] = n.getX(v); nn[i * 3 + 1] = n.getY(v); nn[i * 3 + 2] = n.getZ(v);
      }
      pos.set(np, o * 3); nrm.set(nn, o * 3); o += gi.count;
    } else {
      pos.set(p.array, o * 3); nrm.set(n.array, o * 3); o += p.count;
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, o * 3), 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(0, o * 3), 3));
  return out;
}

export class PropScatter {
  constructor(terrain, palette, biome, seed = 2024) {
    this.terrain = terrain;
    this.palette = palette;
    this.biome = biome;
    this.rng = new Rng(seed);
    this.group = new THREE.Group();
    this.group.name = 'props';
    this.colliders = [];
  }

  /**
   * @param {(x:number,z:number)=>boolean} isBlocked  keep-out test (roads, water, town)
   */
  build(isBlocked = () => false) {
    const B = this.biome;
    const half = B.size / 2 * 0.94;
    const rng = this.rng;

    const treeVariants = [];
    const isDesert = B.id === 'desert';
    const conifer = B.id === 'alpine' || B.id === 'winter';
    for (let i = 0; i < 8; i++) {
      const r = new Rng(1000 + i * 37);
      treeVariants.push(
        isDesert ? cactusGeom(r) : conifer ? coneTree(r, this.palette) : blobTree(r)
      );
    }
    const rockVariants = [];
    for (let i = 0; i < 5; i++) rockVariants.push(rockGeom(new Rng(5000 + i * 17)));

    const foliage = this.palette.foliage.map((h) => new THREE.Color(h));
    // NOTE: vertexColors must stay FALSE. Per-instance tint comes from
    // InstancedMesh.instanceColor; enabling vertexColors without a geometry
    // `color` attribute multiplies everything to black.
    const treeMat = new THREE.MeshLambertMaterial({ flatShading: true });
    const rockMat = new THREE.MeshLambertMaterial({ flatShading: true });

    // ---- clustered placement -------------------------------------------
    const attempts = Math.floor(2600 * (B.treeDensity ?? 1));
    const treeXf = treeVariants.map(() => []);
    const rockXf = rockVariants.map(() => []);

    for (let i = 0; i < attempts; i++) {
      const x = rng.float(-half, half);
      const z = rng.float(-half, half);
      // Clustering mask: only place where the noise field is high.
      const clump = fbm(x * 0.004, z * 0.004, { octaves: 3, seed: 909 });
      if (clump < rng.float(-0.35, 0.55)) continue;
      const h = this.terrain.heightAt(x, z);
      if (h < B.waterLevel + 1.2) continue;
      const n = this.terrain.normalAt(x, z, 3);
      if (n.y < 0.82) continue; // too steep for trees
      if (isBlocked(x, z)) continue;
      // Treeline
      if (h > 95 && !isDesert) continue;

      const v = rng.int(0, treeVariants.length - 1);
      treeXf[v].push({ x, y: h, z, s: rng.float(0.72, 1.5), r: rng.float(0, Math.PI * 2) });
      this.colliders.push({ x, z, r: 1.6 });
    }

    const rockAttempts = Math.floor(1500 * (B.rockDensity ?? 1));
    for (let i = 0; i < rockAttempts; i++) {
      const x = rng.float(-half, half);
      const z = rng.float(-half, half);
      const h = this.terrain.heightAt(x, z);
      if (h < B.waterLevel + 0.4) continue;
      if (isBlocked(x, z)) continue;
      const v = rng.int(0, rockVariants.length - 1);
      const s = Math.pow(rng.float(0.2, 1), 2) * 5 + 0.5;
      rockXf[v].push({ x, y: h - s * 0.15, z, s, r: rng.float(0, Math.PI * 2) });
      if (s > 2.2) this.colliders.push({ x, z, r: s * 0.8 });
    }

    const dummy = new THREE.Object3D();
    const col = new THREE.Color();

    treeVariants.forEach((geo, vi) => {
      const list = treeXf[vi];
      if (!list.length) return;
      const inst = new THREE.InstancedMesh(geo, treeMat, list.length);
      const instColors = new Float32Array(list.length * 3);
      list.forEach((t, i) => {
        dummy.position.set(t.x, t.y, t.z);
        dummy.rotation.set(0, t.r, 0);
        dummy.scale.setScalar(t.s);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
        col.copy(foliage[i % foliage.length]).offsetHSL(0, 0, (i % 5) * 0.012 - 0.024);
        instColors[i * 3] = col.r; instColors[i * 3 + 1] = col.g; instColors[i * 3 + 2] = col.b;
      });
      inst.instanceColor = new THREE.InstancedBufferAttribute(instColors, 3);
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      this.group.add(inst);
    });

    const rockC = new THREE.Color(this.palette.rock);
    const rockS = new THREE.Color(this.palette.rockShadow);
    rockVariants.forEach((geo, vi) => {
      const list = rockXf[vi];
      if (!list.length) return;
      const inst = new THREE.InstancedMesh(geo, rockMat, list.length);
      const instColors = new Float32Array(list.length * 3);
      list.forEach((t, i) => {
        dummy.position.set(t.x, t.y, t.z);
        dummy.rotation.set(0, t.r, 0);
        dummy.scale.set(t.s, t.s * 0.75, t.s);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
        col.copy(rockC).lerp(rockS, (i % 4) / 5);
        instColors[i * 3] = col.r; instColors[i * 3 + 1] = col.g; instColors[i * 3 + 2] = col.b;
      });
      inst.instanceColor = new THREE.InstancedBufferAttribute(instColors, 3);
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      this.group.add(inst);
    });

    return this.group;
  }
}
