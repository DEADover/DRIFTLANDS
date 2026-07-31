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
 *   chainStep, chainTime, chainGrace, shakeTrauma
 *
 * ---------------------------------------------------------------------------
 * THE LEDGER LIVES HERE, AND THAT IS THE POINT OF THIS BLOCK.
 *
 * It used to live in ui/hud.js — `hud.total`, `hud.best`, a payout multiplier
 * and PAYOUT_MIN, all private to the view. Which meant that under `?hud=0`,
 * which is what every capture preset and every audit tool runs, THE SCORE DID
 * NOT EXIST. core/race.js could not read it, so it grew a second, quieter
 * scoring rule of its own out of the raw rises of game.driftScore, and the
 * player was shown two totals that never agreed (measured on a five-lap alpine
 * race under the autopilot: corner TOTAL 242.04, results table 1222.51 — the
 * two disagreed by a factor of five, in the direction that made the number the
 * player had watched all race the SMALLER one).
 *
 * feel.js is where it belongs because this module is the only one that already
 * knows the whole shape of a slide: it owns CHAIN_STEPS, it is constructed
 * unconditionally by the shell whether or not there is a DOM, it is updated
 * every frame with the vehicle, and game.js already hands it the finished score
 * of every slide via `event('driftEnd', {score})`. Nothing had to be added to
 * the shell to move the ledger here — the wire was already in place.
 *
 * Public ledger surface (ui/hud.js draws it, core/race.js buckets it):
 *   bank         running banked total for the current ledger, in WHOLE points
 *   best         the largest single slide banked into it
 *   payout       what the last banked slide was worth (== the rise in `bank`)
 *   payoutPeak   the same slide as a RAW drift score — what the HUD's tiers grade
 *   payoutBase   that slide before the chain multiplier — a display figure, so
 *                the HUD's count-up beat has somewhere to count FROM
 *   payoutMult   the chain multiplier it was held at — display only
 *   payoutSeq    ++ on every banked slide; the HUD's trigger edge
 *   slideSeq     ++ on every slide that ENDS, banked or not; the HUD needs the
 *                difference to know when to drop its chain pips
 *   payoutAge    seconds since the last banked slide
 *   resetBank()  empty the ledger — core/race.js calls it at the start line
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// Escalating chain: each step is a small, legible reward for keeping it lit.
/**
 * THE CHAIN LADDER — how long you have kept it sideways, and what that is worth.
 *
 * The ceiling was x6 at nine seconds, and x6 is a number you reach and then have
 * nothing left to reach for. It is now x100 at forty-five, which changes what the
 * scoreboard is FOR: not "did you drift" but "how long did you dare hold it".
 *
 * The rungs are geometric, not linear, so every step feels like the same
 * proportional jump and the last one — 60 to 100 — is the payoff the whole run
 * was building to. Forty-five seconds of continuously linked sliding, with only
 * CHAIN_GRACE of straight line allowed between drifts, is a genuine trophy on a
 * stage with this many corners; a casual run never sees the top of this table.
 *
 * The base scoring rate came DOWN at the same time (game.js) and had to: with the
 * ceiling raised sixteenfold, leaving the rate alone would have made a maxed
 * chain worth more than the rest of the stage put together by accident rather
 * than by design.
 */
const CHAIN_STEPS = [
  { at: 0.0, mul: 1.0 },
  { at: 1.1, mul: 1.5 },
  { at: 2.4, mul: 2.0 },
  { at: 4.0, mul: 3.0 },
  { at: 6.2, mul: 4.0 },
  { at: 9.0, mul: 6.0 },
  { at: 12.0, mul: 8.0 },
  { at: 15.5, mul: 11.0 },
  { at: 19.5, mul: 15.0 },
  { at: 24.0, mul: 20.0 },
  { at: 29.0, mul: 28.0 },
  { at: 34.5, mul: 40.0 },
  { at: 40.5, mul: 60.0 },
  { at: 45.0, mul: 100.0 },
];
const CHAIN_GRACE = 0.85;      // s of straight-line allowed between linked drifts

/**
 * THE FLOOR. Below this a slide is not worth announcing, so it banks NOTHING —
 * not in the corner total, not in the lap table, not in the race total. It was
 * a private constant in ui/hud.js, which is exactly how the two scoreboards
 * came to disagree: the HUD dropped these slides and race.js counted them.
 * One rule, one place, and 110 is unchanged from the value it was tuned at.
 */
/**
 * Below this a finished slide is not banked and not announced.
 *
 * 110 was set when the base scoring rate was 6. It is now 1.8 — the rate came
 * down when the chain ceiling went from x6 to x100 — and the floor did not move
 * with it, so it started discarding almost everything: MEASURED over a five-lap
 * race, 169 of 181 slides dropped, 5,826 raw points thrown away against 2,184
 * banked. A floor that rejects 93% of what the player does is not a floor, it is
 * the ceiling.
 *
 * Scaled by the same 1.8/6 the rate moved by, so the SHARE of slides worth
 * announcing is what it was when the number was chosen.
 */
export const PAYOUT_MIN = 33;

/**
 * THE CHAIN MULTIPLIER IS APPLIED ONCE, AND IT IS APPLIED WHILE YOU DRIVE.
 *
 * game.js accumulates `driftScore += driftAngle * speed * dt * 1.8 * mul` — the
 * ladder is already integrated into every point of the live number. hud.js then
 * multiplied the finished slide by `min(9.9, mul)` a SECOND time on the way
 * into the corner total. That is a squared ladder: a slide held at the x4 rung
 * banked x16, and one held to the top banked x100 * 9.9 = x990.
 *
 * The retune in the commit that raised the ceiling states its intent in
 * arithmetic, and the arithmetic only closes on a single application:
 *   "a casual slide banks about a third of what it used to"
 *        6 -> 1.8 at mul 1  =  0.30      (the second application is 1.0 either way)
 *   "a chain held to the top banks five times the old maximum"
 *        1.8 * 100 = 180  vs  6 * 6 = 36  =  5.00 exactly
 * Doubled, that second line comes out at 1.8*100*9.9 / (6*6*6) = 8.25, which is
 * not a number anyone chose. So: bank the peak as game.js accumulated it, and
 * never multiply again. `payoutMult` below is carried purely so the HUD's
 * count-up beat has something honest to say.
 */

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
  let payoutAge = 99;
  let wasDrifting = false;
  let bank = 0;                // every point banked since the last resetBank()
  let best = 0;                // the largest single slide in that ledger
  let payoutSeq = 0;
  let slideSeq = 0;

  const feel = {
    timeScale: 1,
    fovBoost: 0,
    chainMultiplier: 1,
    chainStep: 0,
    chainTime: 0,
    chainGrace: 0,
    shakeTrauma: 0,

    // ---- the ledger (see the header). Plain fields: read them, never write. --
    bank: 0,
    best: 0,
    payout: 0,
    payoutPeak: 0,
    payoutBase: 0,
    payoutMult: 1,
    payoutSeq: 0,
    slideSeq: 0,
    payoutAge: 99,
    PAYOUT_MIN,

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
        // A shift is a beat, not a jolt. The camera now rate-limits FOV, but
        // the punch itself was also far too large to begin with.
        fovPunch += v.justShifted > 0 ? 0.14 : -0.09;
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
        if (chainGrace <= 0) this._breakChain();
      }
      wasDrifting = drifting;

      let step = 0;
      for (let i = 0; i < CHAIN_STEPS.length; i++) if (chainTime >= CHAIN_STEPS[i].at) step = i;
      if (step > chainStep) {
        // Stepping up the chain is the payoff beat: a snap of FOV and a nudge.
        //
        // SCALED BY HOW FAR UP THE LADDER YOU ARE, not by the rung's index. These
        // three lines used to read `step * 0.22` and friends, which was fine at
        // six rungs and absurd at fourteen: the top step would have fired a
        // 3.56 degree FOV punch against the 1.8 it was tuned for, half a unit of
        // camera shake against 0.25, and 88 particles against 40. The fraction
        // keeps the top of the ladder feeling exactly as it did, however many
        // rungs get added underneath it.
        const t = step / (CHAIN_STEPS.length - 1);
        fovPunch += 0.7 + t * 1.1;
        camera?.addShake?.(0.10 + t * 0.15);
        this._burst(v, 10 + Math.round(t * 30), 1.1 + t * 1.25);
      }
      chainStep = step;
      this.chainMultiplier = CHAIN_STEPS[step].mul;
      this.chainStep = step;
      this.chainTime = chainTime;
      this.chainGrace = chainGrace;
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
      // Halved: this term is CONTINUOUS, so it sets the resting trauma level, and
      // at 1.8 the frame never stopped buzzing (measured peak 0.873).
      if (want > 0.001 && camera?.addShake) camera.addShake(want * 0.85 * rdt);
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
          // game.js fires this on the frame `isDrifting` goes false, BEFORE it
          // applies the exp(-2.2 dt) decay, and driftAngle is a magnitude — so
          // the score it hands us is the slide's peak by construction. There is
          // no need to sample and track a maximum anywhere.
          this._bank(payload.score ?? 0);
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
      fovPunch -= clamp(speed * 0.05, 0.1, 0.7);   // punch IN — the world lurches
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

    /**
     * A SLIDE HAS ENDED. Bank it, or throw it away — once, for everyone.
     *
     * `slideSeq` ticks either way: the HUD drops its chain pips on a slide that
     * failed to clear the floor, and it can only know that happened if the
     * ledger tells it. `payoutSeq` ticks only when something was actually
     * banked, and is the edge the celebration beat fires on.
     */
    _bank(peak) {
      this.slideSeq = ++slideSeq;
      if (!(peak >= PAYOUT_MIN)) return;   // the floor is on the RAW peak
      const mul = this.chainMultiplier;

      /**
       * A SCORE IS A WHOLE NUMBER, AND IT IS ROUNDED HERE — ONCE.
       *
       * Everything downstream prints integers: the corner total, each row of
       * the lap table, the table's footer. If the ledger carried fractions,
       * five lap cells rounded independently would not add up to a footer
       * rounded once — a five-lap race could show a column summing to 2184
       * under a total of 2183, which is exactly the "these two numbers
       * disagree" complaint in miniature. Banking integers makes every lap
       * bucket a difference of integers, so the column sums to the total
       * EXACTLY, on screen and in float, with no tolerance anywhere. It also
       * retires a 1.1e-13 residual that had to be tolerated in the tests.
       */
      const points = Math.round(peak);
      bank += points;               // already carries the ladder — see the header
      if (points > best) best = points;
      payoutAge = 0;
      this.bank = bank;
      this.best = best;
      this.payout = points;
      this.payoutPeak = peak;       // the RAW slide — what the HUD's tiers grade
      this.payoutBase = points / mul;
      this.payoutMult = mul;
      this.payoutAge = 0;
      this.payoutSeq = ++payoutSeq;
    },

    /** The relink window closed: the ladder goes back to the bottom rung. */
    _breakChain() {
      chainTime = 0;
      chainStep = 0;
      this.chainMultiplier = 1;
      this.chainStep = 0;
      this.chainTime = 0;
    },

    /**
     * Empty the ledger. core/race.js calls this the instant the race starts and
     * on restart, which is what makes the corner total and the race total the
     * same number rather than two numbers that happen to grow together: they
     * both start at zero at the start line. Points scored while staging are
     * discarded exactly like the clock discards the time spent there.
     */
    resetBank() {
      bank = 0; best = 0; payoutSeq = 0; slideSeq = 0; payoutAge = 99;
      this.bank = 0; this.best = 0; this.payout = 0; this.payoutPeak = 0;
      this.payoutBase = 0; this.payoutMult = 1;
      this.payoutSeq = 0; this.slideSeq = 0; this.payoutAge = 99;
    },
  };

  return feel;
}
