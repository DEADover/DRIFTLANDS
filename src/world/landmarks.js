import * as THREE from 'three';

/**
 * LANDMARKS — owned by the landmark builder.
 *
 * Hamlets, barns, chalets, lighthouses, radio masts, ruins, fences, hay bales,
 * route chevrons, jetties. The things that make each biome feel like a PLACE
 * rather than a terrain sample.
 *
 * CONTRACT:
 *   createLandmarks(ctx) -> {
 *     group: THREE.Object3D
 *     isBlocked(x, z) -> boolean
 *     colliders: {x,z,r}[]
 *   }
 *
 * ctx = { terrain, biome, palette, seed, roads, water }
 */
export function createLandmarks(ctx) {
  const group = new THREE.Group();
  group.name = 'landmarks';
  return {
    group,
    isBlocked: () => false,
    colliders: [],
  };
}
