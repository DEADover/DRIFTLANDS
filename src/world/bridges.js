import * as THREE from 'three';

/**
 * BRIDGES — owned by the bridges builder.
 *
 * CONTRACT:
 *   createBridges(ctx) -> {
 *     group: THREE.Object3D
 *     heightAt(x, z) -> number|null   deck height if over a bridge, else null
 *     isBlocked(x, z) -> boolean      keep-out for props
 *     colliders: {x,z,r}[]            pylons / railings the car should hit
 *   }
 *
 * ctx = { terrain, biome, palette, seed, roads }
 * Use roads.waterCrossings to place decks where the route meets water.
 */
export function createBridges(ctx) {
  const group = new THREE.Group();
  group.name = 'bridges';
  return {
    group,
    heightAt: () => null,
    isBlocked: () => false,
    colliders: [],
  };
}
