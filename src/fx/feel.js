/**
 * GAME FEEL — owned by the feel builder.
 *
 * The layer that turns correct physics into *satisfying* physics: camera
 * kicks, FOV punch, hit-stop, rumble, gear-shift snaps, drift-chain scoring
 * escalation. Everything here is cosmetic and additive — nothing in this file
 * may change where the car ends up. If you delete it the game still plays; it
 * just stops feeling like anything.
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
 *
 * Extras this implementation also publishes (safe to ignore, nice for a HUD):
 *   chainStep, chainTime, chainGrace, bank, payout, payoutAge, shakeTrauma
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// Escalating chain: each step is a small, legible reward for keeping it lit.
const CHAIN_STEPS = [
  { at: 0.0, mul: 1.0 },
  { at: 1.1, mul: 1.5 },
  { at: 2.4, mul: 2.0 },
  { at: 4.0, mul: 3.0 },
  { at: 6.2, mul: 4.0 },
  { at: 9.0, mul: 6.0 },
];
const CHAIN_GRACE = 0.85;      // s of straight-line allowed between linked drifts

const TUNE = {
  // FOV
  fovSpeed: 3.0,               // deg at top speed
  fovDrift: 1.5,               // deg at a full-lock slide
  fovAccel: 0.16,              // deg per m/s^2 of shove in the back
  fovAttack: 2.2,              // how fast the boost builds (reads as accel)
  fovRelease: 4.5,             // how fast it lets go (reads as lift-off)
  fovPunchDecay: 5.5,

  // camera
  rumbleTrauma: 0.34,          // sustained shake on rough ground at speed
  impactShake: 0.055,          // trauma per m/s of impact
  landShake: 0.05,
  driftEntryShake: 0.16,

  // hit-stop
  hitStopMin: 11,              // m/s of impact before time freezes at all
  hitStopMax: 0.085,           // s of real time
  hitStopScale: 0.09,          // how slow time gets
  hitStopEase: 0.13,           // s to ease back to normal

  impactCooldown: 0.30,        // debounce: grinding a wall is not 40 impacts
  topSpeed: 44,
};

export function createFeel(ctx = {}) {
  const particles = ctx.particles;

  let fovBase = 0;             // the smoothed, speed-driven part
  let fovPunch = 0;            // transient kicks
  let hitStop = 0;             // remaining real seconds of freeze
  let hitEase = 0;
  let impactCool = 0;

  let chainTime = 0;           // seconds of accumulated drift in this chain
  let chainGrace = 0;          // seconds left to relink after breaking
  let chainStep = 0;
  let bank = 0;                // paid-out score
  let payout = 0;              // size of the last payout
  let payoutAge = 99;
  let wasDrifting = false;
  let pendingScore = 0;

  const feel = {
    timeScale: 1,
    fovBoost: 0,
    chainMultiplier: 1,
    chainStep: 0,
    chainTime: 0,
    chainGrace: 0,
    bank: 0,
    payout: 0,
    payoutAge: 99,
    shakeTrauma: 0,

    /**
     * @param {number} dt time already scaled by this.timeScale (game.js does it)
     */
    update(dt, state = {}) {
      const v = state.vehicle ?? ctx.vehicle;
      const camera = state.camera ?? ctx.camera;
      if (!v) return;
      // Recover real time: the shell feeds us our own slow-motion back.
      const rdt = Math.min(0.1, dt / Math.max(0.05, this.timeScale));

      // ---------------------------------------------------------- hit-stop
      if (hitStop > 0) {
        hitStop -= rdt;
        this.timeScale = TUNE.hitStopScale;
        if (hitStop <= 0) hitEase = TUNE.hitStopEase;
      } else if (hitEase > 0) {
        hitEase -= rdt;
        this.timeScale = lerp(1, TUNE.hitStopScale, clamp(hitEase / TUNE.hitStopEase, 0, 1));
      } else {
        this.timeScale = 1;
      }
      impactCool = Math.max(0, impactCool - rdt);

      // -------------------------------------------------- vehicle one-shots
      // The vehicle publishes impacts and landings as sticky values; we are the
      // consumer, so we clear them.
      if (v.lastImpact > 0) {
        // Only the vehicle's own reading is the true normal-component impact,
        // so only this path is allowed to freeze time. game.js reports raw
        // speed, which would hit-stop on every 130 km/h graze.
        this._hit(v.lastImpact, v, camera, true);
        v.lastImpact = 0;
      }
      if (v.landImpact > 0) {
        this._land(v.landImpact, v, camera);
        v.landImpact = 0;
      }
      if (v.justShifted) {
        // A shift should be felt as a beat, not seen as an event.
        fovPunch += v.justShifted > 0 ? 0.55 : -0.35;
        v.justShifted = 0;
      }

      // --------------------------------------------------------- drift chain
      const drifting = !!v.isDrifting;
      if (drifting) {
        chainTime += rdt;
        chainGrace = CHAIN_GRACE;
        if (!wasDrifting) fovPunch += 0.9;
      } else if (chainGrace > 0) {
        chainGrace -= rdt;
        if (chainGrace <= 0) this._payout();
      }
      wasDrifting = drifting;

      let step = 0;
      for (let i = 0; i < CHAIN_STEPS.length; i++) if (chainTime >= CHAIN_STEPS[i].at) step = i;
      if (step > chainStep) {
        // Stepping up the chain is the payoff beat: a snap of FOV and a nudge.
        fovPunch += 0.7 + step * 0.22;
        camera?.addShake?.(0.10 + step * 0.03);
        this._burst(v, 10 + step * 6, 1.1 + step * 0.25);
      }
      chainStep = step;
      this.chainMultiplier = CHAIN_STEPS[step].mul;
      this.chainStep = step;
      this.chainTime = chainTime;
      this.chainGrace = chainGrace;
      if (state.driftScore > pendingScore) pendingScore = state.driftScore;
      payoutAge += rdt;
      this.payoutAge = payoutAge;

      // ------------------------------------------------------------- FOV
      const speedRatio = clamp(v.speed / TUNE.topSpeed, 0, 1);
      const driftRatio = clamp((v.driftAngle ?? 0) / 0.7, 0, 1);
      const target =
        Math.pow(speedRatio, 1.5) * TUNE.fovSpeed +
        driftRatio * speedRatio * TUNE.fovDrift +
        clamp((v.pitchAccel ?? 0) * TUNE.fovAccel, -1.2, 1.4);
      const rate = target > fovBase ? TUNE.fovAttack : TUNE.fovRelease;
      fovBase += (target - fovBase) * (1 - Math.exp(-rate * rdt));
      fovPunch *= Math.exp(-TUNE.fovPunchDecay * rdt);
      this.fovBoost = fovBase + fovPunch;

      // --------------------------------------------------------- rumble
      // Rough ground should be felt through the frame, not just seen. Bridges
      // and tarmac are smooth; gravel and snow buzz.
      const kind = state.surface?.kind;
      const smooth = kind === 'road' || kind === 'bridge';
      const rough = smooth ? 0.12 : 1 - clamp(state.surface?.grip ?? 0.85, 0, 1) * 0.35;
      const want = TUNE.rumbleTrauma * rough * Math.pow(speedRatio, 1.35);
      if (want > 0.001 && camera?.addShake) camera.addShake(want * 1.8 * rdt);
      this.shakeTrauma = camera?.shakeAmount ?? 0;
    },

    event(name, payload = {}) {
      const v = ctx.vehicle;
      const camera = ctx.camera;
      switch (name) {
        case 'impact':
          this._hit(payload.speed ?? 0, v, camera, false);
          break;
        case 'land':
        case 'jump':
          this._land(payload.speed ?? 4, v, camera);
          break;
        case 'shift':
          fovPunch += 0.55;
          break;
        case 'driftStart':
          fovPunch += 0.9;
          camera?.addShake?.(TUNE.driftEntryShake);
          chainGrace = CHAIN_GRACE;
          break;
        case 'driftEnd':
          if ((payload.score ?? 0) > pendingScore) pendingScore = payload.score;
          break;
        default:
          break;
      }
    },

    // -------------------------------------------------------------- internals
    _hit(speed, v, camera, allowStop = false) {
      if (!(speed > 0.5) || impactCool > 0) return;
      impactCool = TUNE.impactCooldown;
      camera?.addShake?.(clamp(speed * TUNE.impactShake, 0.08, 0.85));
      fovPunch -= clamp(speed * 0.10, 0.3, 2.2);   // punch IN — the world lurches
      if (allowStop && speed > TUNE.hitStopMin && hitStop <= 0) {
        hitStop = Math.min(TUNE.hitStopMax, 0.028 + speed * 0.0032);
      }
      this._burst(v, Math.round(clamp(speed * 1.6, 6, 40)), 2.2 + speed * 0.09, 0xcfc6b4, v?.impactDir);
      // Hitting things breaks the chain. It has to cost something.
      if (speed > 8) chainGrace = Math.min(chainGrace, 0.12);
    },

    _land(speed, v, camera) {
      if (!(speed > 1.2)) return;
      camera?.addShake?.(clamp(speed * TUNE.landShake, 0.05, 0.6));
      fovPunch -= clamp(speed * 0.06, 0.1, 0.9);
      this._burst(v, Math.round(clamp(speed * 2.2, 6, 34)), 1.6 + speed * 0.12);
      if (speed > 9 && hitStop <= 0) hitStop = 0.035;
    },

    /** Debris/dust ring at the car's contact patch. Purely decorative. */
    _burst(v, n, power, color, dir) {
      if (!particles || !v) return;
      const y = (v._groundY ?? 0) + 0.35;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.6;
        const sp = power * (0.4 + Math.random() * 0.9);
        particles.spawn({
          x: v.position.x + Math.cos(a) * 1.2,
          y: y + Math.random() * 0.5,
          z: v.position.z + Math.sin(a) * 1.2,
          vx: Math.cos(a) * sp + (dir ? dir.x * power * 0.8 : 0),
          vy: 1.4 + Math.random() * power * 0.35,
          vz: Math.sin(a) * sp + (dir ? dir.z * power * 0.8 : 0),
          size: 2.0 + Math.random() * 3.2,
          life: 0.5 + Math.random() * 0.7,
          color: color ?? 0xd8d2c4,
          drag: 2.1,
          grow: 2.6,
        });
      }
    },

    _payout() {
      const mul = CHAIN_STEPS[chainStep].mul;
      if (chainTime > 0.6 && pendingScore > 0) {
        payout = pendingScore * mul;
        bank += payout;
        payoutAge = 0;
        this.bank = bank;
        this.payout = payout;
      }
      chainTime = 0;
      chainStep = 0;
      pendingScore = 0;
      this.chainMultiplier = 1;
      this.chainStep = 0;
    },
  };

  return feel;
}
