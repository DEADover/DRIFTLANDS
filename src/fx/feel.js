/**
 * GAME FEEL — owned by the feel builder.
 *
 * The layer that turns correct physics into *satisfying* physics: camera
 * kicks, FOV punch, hit-stop, rumble, gear-shift snaps, drift-chain scoring
 * escalation, near-miss slow-mo. Everything here is cosmetic and additive.
 *
 * CONTRACT:
 *   createFeel(ctx) -> {
 *     update(dt, state) -> void
 *     event(name, payload) -> void        'impact' | 'driftStart' | 'driftEnd' | 'shift' | 'jump' | 'land'
 *     timeScale: number                   read by the game loop each frame
 *     fovBoost: number                    added to the camera FOV
 *     get chainMultiplier(): number
 *   }
 *
 * ctx = { camera, vehicle, particles }
 * state = { vehicle, camera, dt, onRoad, surface }
 */
export function createFeel(ctx) {
  return {
    timeScale: 1,
    fovBoost: 0,
    chainMultiplier: 1,
    update() {},
    event() {},
  };
}
