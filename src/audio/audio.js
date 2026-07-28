/**
 * AUDIO — owned by the audio builder.
 *
 * Procedural only (WebAudio oscillators/noise). No asset files: everything must
 * be synthesised so the project stays self-contained.
 *
 * CONTRACT:
 *   createAudio() -> {
 *     start() -> Promise<void>     must be called from a user gesture
 *     update(dt, state) -> void
 *     event(name, payload) -> void
 *     setEnabled(on) -> void
 *     started: boolean
 *   }
 *
 * state = { vehicle, surface, onRoad }
 *
 * MUST be inert in capture mode (no AudioContext) so screenshots never stall.
 */
export function createAudio() {
  return {
    started: false,
    async start() {},
    update() {},
    event() {},
    setEnabled() {},
  };
}
