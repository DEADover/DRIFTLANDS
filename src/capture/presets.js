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
   * THE CROWD, AT THE ONLY PLACE IT IS ALLOWED TO BE.
   *
   * Spectators only ever stand behind steel guardrails, and guardrails only
   * exist at corners roads.js has judged dangerous — so a shot of the crowd is
   * necessarily a shot of a hard corner, and it cannot be framed by picking a
   * pretty spot. 47.75 s is the measured moment on this route where the most
   * spectators are inside the frustum at once (67 of them, all within 55 m):
   * the guarded left-hander with the drop on its outside. If this comes back
   * with an empty verge, the guardrail layout has moved, not the crowd.
   */
  crowd_alpine: {
    id: 'crowd_alpine',
    label: 'Spectators — the gallery behind the guardrail',
    biome: 'alpine',
    seed: 1337,
    warmup: 47.75,
    tape: [drive(47.75, { throttle: 1 })],
    camera: { zoom: 0.78 },
    autopilot: { aggression: 1 },
    notes: 'Judge the crowd: silhouette, colour, clustering, and that every one of them is behind steel.',
  },

  /**
   * THE CAR ITSELF, BIG ENOUGH TO JUDGE.
   *
   * Every other preset frames the world; these two frame the model. The camera's
   * near plane is 14 m, so there is a floor under how close it can get — at
   * distance 20 m (zoom 0.26) and fov 26 the frame is 16.4 m across and the car
   * reads ~29% of frame width, about seven times its in-game size. That is
   * enough to judge chamfers, arch clearance and wheel spokes, and it is still
   * the real world, the real light and the real materials rather than a turntable.
   *
   * The tape brakes to a stop on purpose: at rest the camera's velocity lead is
   * zero so the car sits centred, and the wheel-in-arch relationship the client
   * asked about is shown in its neutral state rather than mid-lean.
   */
  car_studio: {
    id: 'car_studio',
    label: 'The car, three-quarter — judge the model itself',
    biome: 'alpine',
    seed: 1337,
    warmup: 11.0,
    tape: [drive(5.0, { throttle: 1 }), drive(11.0, { brake: 1 })],
    camera: { zoom: 0.26, pitchDeg: 34 },
    autopilot: { aggression: 1 },
    notes: 'Judge bevels, roofline, arch gap, spokes, livery. NOT a composition shot.',
  },

  car_plan: {
    id: 'car_plan',
    label: 'The car, plan view at the game camera angle',
    biome: 'alpine',
    seed: 1337,
    warmup: 11.0,
    tape: [drive(5.0, { throttle: 1 }), drive(11.0, { brake: 1 })],
    camera: { zoom: 0.26 },
    notes: 'The in-game angle, magnified. This is the read that has to survive.',
    autopilot: { aggression: 1 },
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
    // 108.72 -> 107.15. The preset's MEANING is unchanged — it is still the car
    // in the air over the ford — but the settle time had to follow the world:
    // the take-off lip came down from 5.0 m to 1.5 m and the earthwork shortened
    // from 76 m to 55 m, which moved the sited crest, and the jump now runs in
    // slow motion, so a WALL-CLOCK warmup buys less sim time than it used to.
    // At 108.72 the car is past the run-out and back on the road; 107.15 is
    // 0.40 s after take-off with the car over the middle of the water.
    warmup: 107.15,
    tape: [drive(107.15, { throttle: 1 })],
    camera: { zoom: 0.86 },
    autopilot: { aggression: 1 },
    notes: 'Judge the earthwork, the crib revetments, the stream, the air and the take-off fireworks.',
  },
};

export const PRESET_IDS = Object.keys(PRESETS);
