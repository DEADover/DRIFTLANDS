import * as THREE from 'three';

/**
 * ANIMALS — owned by the wildlife builder.
 *
 * CONTRACT:
 *   createAnimals(ctx) -> {
 *     group: THREE.Object3D
 *     update(dt, player) -> void        player = {position: Vector3, speed: number}
 *   }
 *
 * ctx = { terrain, biome, palette, seed, roads }
 *
 * Design intent: herds that read as ALIVE from 180 m up. That means motion,
 * flocking, and a startle reaction when the car gets close — silhouette alone
 * is not enough at this camera height.
 */
export function createAnimals(ctx) {
  const group = new THREE.Group();
  group.name = 'animals';
  return {
    group,
    update: () => {},
    count: 0,
  };
}
