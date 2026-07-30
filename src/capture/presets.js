/**
 * CAPTURE PRESETS — the shared vocabulary for every screenshot in this project.
 *
 * A preset is a fully deterministic recipe: biome + seed + a scripted input
 * tape + a settle time. Given the same code, the same preset always produces
 * the same pixels. That is what makes A/B comparison meaningful.
 *
 * Rule: never change a preset's meaning. Add a new one instead. Critics compare
 * shots of the SAME preset across rounds.
 */

/** @typedef {{id:string,label:string,biome:string,seed:number,warmup:number,tape:Array,camera?:object,notes:string}} Preset */

const drive = (t, o) => [t, o];

/** @type {Record<string, Preset>} */
export const PRESETS = {
  hero_alpine: {
    id: 'hero_alpine',
    label: 'Alpine hero — wide landscape, car mid-corner',
    biome: 'alpine',
    seed: 1337,
    warmup: 9.0,
    tape: [
      drive(2.6, { throttle: 1 }),
      drive(4.4, { throttle: 1, steer: 1 }),
      drive(5.2, { throttle: 0.6, steer: 1, handbrake: 1 }),
      drive(9.0, { throttle: 1, steer: -0.35 }),
    ],
    autopilot: { aggression: 1 },
    notes: 'The postcard shot. Judge composition, colour, depth, sparsity.',
  },

  drift_alpine: {
    id: 'drift_alpine',
    label: 'Alpine drift — full slide, dust, skid marks',
    biome: 'alpine',
    seed: 1337,
    warmup: 10.0,
    tape: [
      drive(4.0, { throttle: 1 }),
      drive(4.8, { throttle: 0.5, steer: 1, handbrake: 1 }),
      drive(12.0, { throttle: 1, steer: 0.55 }),
    ],
    camera: { zoom: 0.72 },
    autopilot: { aggression: 1 },
    notes: 'Judge drift FX: dust volume, skid marks, car attitude, camera lead.',
  },

  lake_bridge: {
    id: 'lake_bridge',
    label: 'Lake + bridge crossing',
    biome: 'alpine',
    seed: 4242,
    warmup: 7.0,
    tape: [drive(7.0, { throttle: 1 })],
    camera: { zoom: 1.15 },
    autopilot: { aggression: 1 },
    notes: 'Judge water, shoreline, bridge silhouette and scale.',
  },

  autumn_forest: {
    id: 'autumn_forest',
    label: 'Ember woodland — dense canopy, low sun',
    biome: 'autumn',
    seed: 777,
    warmup: 8.0,
    tape: [drive(3.0, { throttle: 1 }), drive(8.0, { throttle: 1, steer: -0.4 })],
    autopilot: { aggression: 1 },
    notes: 'Judge colour richness, canopy variety, long shadows.',
  },

  desert_mesa: {
    id: 'desert_mesa',
    label: 'Vermilion mesa — hard light, big negative space',
    biome: 'desert',
    seed: 9090,
    warmup: 8.0,
    tape: [drive(8.0, { throttle: 1, steer: 0.15 })],
    autopilot: { aggression: 1 },
    notes: 'Judge silhouette of mesas, shadow hardness, sparsity discipline.',
  },

  coast_dusk: {
    id: 'coast_dusk',
    label: 'Cobalt coast at dusk — headlights, sea',
    biome: 'coast',
    seed: 5150,
    warmup: 8.0,
    tape: [drive(8.0, { throttle: 1, steer: -0.2 })],
    autopilot: { aggression: 1 },
    notes: 'Judge mood, headlight read, sea colour, silhouette separation.',
  },

  winter_pass: {
    id: 'winter_pass',
    label: 'Glacier pass — the direct reference comparison',
    biome: 'winter',
    seed: 2468,
    warmup: 8.0,
    tape: [drive(3.0, { throttle: 1 }), drive(8.0, { throttle: 1, steer: 0.3 })],
    camera: { zoom: 1.25 },
    autopilot: { aggression: 1 },
    notes: 'THE A/B SHOT. Framed to match the reference image directly.',
  },

  wildlife: {
    id: 'wildlife',
    label: 'Animals — herd near the road',
    biome: 'alpine',
    seed: 8888,
    warmup: 10.0,
    tape: [drive(10.0, { throttle: 0.8 })],
    camera: { zoom: 0.6 },
    autopilot: { aggression: 1 },
    notes: 'Judge animal silhouettes, motion, believability of the herd.',
  },

  /**
   * THE JUMP. Car airborne over the stream, mid-flight.
   *
   * WHY THE WARMUP IS TWO MINUTES. Every other preset frames something that is
   * near the spawn; this one frames a set-piece 2.4 km around the loop from it,
   * and main.js has exactly one way to move the car — drive it. 108.72 s is the
   * measured moment the autopilot at full throttle is 8 m past the take-off lip
   * and 4.7 m over the water (tools/jump-test.mjs prints the same arrival).
   *
   * That makes this the one preset in the set whose framing depends on a hundred
   * seconds of driving, so it is also the one that will drift if the route, the
   * tyre model or the autopilot change. If it comes back with the car on the
   * ground, re-measure the arrival rather than assuming the jump is broken —
   * `node tools/jump-test.mjs` reports the site and the approach speed directly.
   */
  jump_alpine: {
    id: 'jump_alpine',
    label: 'The jump — airborne over the stream',
    biome: 'alpine',
    seed: 1337,
    warmup: 108.72,
    tape: [drive(108.72, { throttle: 1 })],
    camera: { zoom: 0.86 },
    autopilot: { aggression: 1 },
    notes: 'Judge the earthwork, the crib revetments, the stream and the air.',
  },
};

export const PRESET_IDS = Object.keys(PRESETS);
