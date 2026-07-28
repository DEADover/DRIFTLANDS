import * as THREE from 'three';

/**
 * ROAD NETWORK — owned by the roads builder.
 *
 * CONTRACT (do not change the shape of the return value; main.js depends on it):
 *   createRoadNetwork(ctx) -> {
 *     group:      THREE.Object3D            added to the scene
 *     isOnRoad(x, z) -> boolean             used for grip + prop keep-out
 *     gripAt(x, z)   -> number              1.0 tarmac, ~0.75 gravel, etc
 *     isBlocked(x, z)-> boolean             keep-out for props (road + verge)
 *     sample(t)      -> {x, z, heading}     point along the main route, t in 0..1
 *     spawn()        -> {x, z, heading}     good starting point on the route
 *     length:     number                    metres of main route
 *   }
 *
 * ctx = { terrain, biome, palette, seed, rng }
 */
export function createRoadNetwork(ctx) {
  const group = new THREE.Group();
  group.name = 'roads';
  return {
    group,
    isOnRoad: () => false,
    gripAt: () => 1.0,
    isBlocked: () => false,
    sample: () => ({ x: 0, z: 0, heading: 0 }),
    spawn: () => null,
    length: 0,
    /** Points the bridge builder needs: places where the route crosses water. */
    waterCrossings: [],
  };
}
