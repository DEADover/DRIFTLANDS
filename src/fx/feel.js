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
  /** deg of PULL-IN held for as long as slow motion is at full depth. Negative
   *  sign is applied at the use site; see the note there for why it is the one
   *  FOV term in this file that narrows rather than widens. */
  fovSlow: 3.5,

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
  topSpeed: 50,
};

/**
 * SLOW MOTION OVER A JUMP.
 *
 * Armed only by the `jump` event, which `game.js _stepVertical` fires exactly
 * once per flight and only when the car left a surface that was climbing steeply
 * AND had a real drop behind it — a built ramp, never a road crest and never a
 * bridge. See the SEPARATION note in `_stepVertical` for how those are told
 * apart; nothing in this file re-decides it.
 *
 * DEPTH. 0.40, and the number comes from the flight, not from taste. The design
 * jump measures 0.906 s of air (tools/jump-test.mjs at the autopilot's real
 * 39.5 m/s approach); 0.906 / 0.40 = 2.27 s on the wall clock, which is the
 * "couple of seconds" that was asked for. 0.35 stretches it to 2.6 s and the car
 * starts to read as stalled in mid-air rather than hanging; 0.50 gives 1.8 s,
 * which is over before the eye has found the car. It also keeps the SHORT jumps
 * legible: a 27 m/s take-off is 0.64 s of air, 1.6 s slowed, still a beat.
 *
 * SHAPE. Eased at both ends, because a hard cut to 0.4x and back is nauseating —
 * and asymmetrically, 0.18 s in and 0.34 s out, so the drop into slow motion
 * lands with the take-off while the return is a release rather than a snap. The
 * ramps are in REAL seconds and the curve is a smoothstep, so there is no
 * discontinuity in the first derivative at either end.
 *
 * CEILING. 1.6 s of SIM time. The flight normally ends it (the car lands), but a
 * jump that turns into a long fall down a hillside must not hold the whole game
 * at 0.4x while it happens.
 *
 * IT CANNOT MOVE THE CAR. `game.update` scales dt and then spends it in a fixed
 * 1/120 accumulator, so time scaling changes how many frames a given sequence of
 * identical physics steps is spread over and nothing else. Proved, not asserted:
 * `tools/jump-test.mjs --slowmo` drives the same jump with it on and off and
 * compares the two flights step index for step index.
 *
 * IT DOES NOT TOUCH THE LEDGER EITHER. Everything above that has a clock —
 * `chainTime`, `chainGrace`, `payoutAge`, `impactCool`, the FOV filters — is
 * advanced by `rdt`, which is this module's own recovered REAL time (`dt` back
 * out through `timeScale`). That was already true for hit-stop and it is why
 * hit-stop never distorted the chain; slow motion inherits it unchanged. The
 * payout count-up therefore beats at the same wall-clock rate at 0.4x as at 1x,
 * and nothing is banked or counted twice.
 */
const SLOW_SCALE = 0.40;
const SLOW_IN = 0.18;        // real seconds to full depth
const SLOW_OUT = 0.34;       // real seconds back to normal
const SLOW_MAX = 1.60;       // sim seconds, a hard ceiling on one flight
const SLOW_COOLDOWN = 1.20;  // real seconds before another jump may arm it

/** How wide of the car the two batteries stand, in metres. The jump's crown is
 *  13.3 m across and its crib walls retain the edges, so 9.5 m puts them on the
 *  verge just outside the earthwork — clear of the racing line, and far enough
 *  apart that the car flies BETWEEN them rather than through one. */
const FIREWORK_SPREAD = 9.5;

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

  let slowArmed = false;       // a jump is in progress and owns the clock
  let slowBlend = 0;           // 0..1, eased into SLOW_SCALE
  let slowSim = 0;             // sim seconds spent slowed in this flight
  let slowCool = 0;            // real seconds before another jump may arm it

  const feel = {
    timeScale: 1,
    /** Diagnostic switch for tools/jump-test.mjs --slowmo. */
    slowMoEnabled: true,
    /** Take-offs celebrated. Read by tools/jump-test.mjs's control run. */
    jumpCount: 0,
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
      let scale = 1;
      if (hitStop > 0) {
        hitStop -= rdt;
        scale = TUNE.hitStopScale;
        if (hitStop <= 0) hitEase = TUNE.hitStopEase;
      } else if (hitEase > 0) {
        hitEase -= rdt;
        scale = lerp(1, TUNE.hitStopScale, clamp(hitEase / TUNE.hitStopEase, 0, 1));
      }
      impactCool = Math.max(0, impactCool - rdt);

      // ------------------------------------------------------ slow motion
      // Held for as long as the car is off the ground, then released.
      //
      // ON `ballisticAir` AND NOT ON `onGround`. `onGround` is written twice per
      // step — the suspension writes it and then `_stepVertical`'s ballistic
      // clamp writes it — and the suspension's copy is the one that survives to
      // be read here. Measured: over the design jump `v.onGround` reads `true`
      // for all 0.9 s of the flight, with the car 3.11 m in the air, so slow
      // motion armed and was released again on the very next frame and the
      // effect never appeared at all. `ballisticAir` is written only by the
      // clamp and means exactly what it says.
      //
      // The two time scales COMPOSE by taking the smaller: an impact during a
      // flight still gets its hit-stop, and the flight still owns the frames
      // either side of it.
      slowCool = Math.max(0, slowCool - rdt);
      if (slowArmed) {
        slowSim += dt;
        if (!v.ballisticAir || slowSim > SLOW_MAX) { slowArmed = false; slowCool = SLOW_COOLDOWN; }
      }
      const slowWant = slowArmed ? 1 : 0;
      const slowRate = slowWant > slowBlend ? 1 / SLOW_IN : 1 / SLOW_OUT;
      slowBlend = clamp(slowBlend + Math.sign(slowWant - slowBlend) * slowRate * rdt, 0, 1);
      if (slowBlend > 0) {
        // smoothstep, so neither the entry nor the exit has a corner in it
        const e = slowBlend * slowBlend * (3 - 2 * slowBlend);
        scale = Math.min(scale, lerp(1, SLOW_SCALE, e));
      }
      this.timeScale = scale;

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

      /**
       * SLOW MOTION HAS TO BE SEEN, NOT ONLY MEASURED — AND IT WAS ONLY MEASURED.
       *
       * Traced over the real driven jump (tools/jump-trace.mjs) `timeScale` sits
       * at exactly 0.400 for the whole flight and the flight lasts 2.2 s on the
       * wall clock against 0.9 s of sim. The mechanism was never broken. It was
       * INVISIBLE, and for a structural reason: the camera FOLLOWS the car, so
       * during a flight the car is nearly stationary in frame and the only thing
       * whose on-screen speed changes is the ground scrolling past — under a car
       * that is 4% of the frame wide, 400 px from the eye. Halve that scroll rate
       * and nobody can tell; there is nothing in the picture to compare it to.
       * That is the whole of "the slow motion also works unclearly".
       *
       * So the clock now moves the LENS. A sustained pull-IN of 3.5 degrees on a
       * 26 degree base is a 13% narrowing: the world crowds in, the car grows by
       * about a sixth, and the change is unmistakable because it is a change in
       * COMPOSITION rather than in rate. It is the opposite sign to every other
       * term here — speed, drift and shove all push the lens OUT — so it cannot
       * be confused with going fast.
       *
       * Sustained, not a punch: it is driven off `slowBlend` directly, so it
       * arrives and leaves exactly with the effect and cannot survive it. The
       * camera's own 9 deg/s limiter spreads the 3.5 over 0.39 s, which is inside
       * a 2.2 s flight with room either side.
       */
      const e = slowBlend * slowBlend * (3 - 2 * slowBlend);
      this.fovBoost = fovBase + fovPunch - TUNE.fovSlow * e;

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

    /**
     * Drop every transient that owns the clock.
     *
     * `game.resetPose()` forgets where the car was standing; this forgets what
     * time was doing while it stood there. Without it a run that ended mid
     * hit-stop hands the next one a time scale of 0.09, and since the shell
     * spends scaled dt in a fixed-step accumulator, that changes how many
     * physics steps a frame of input covers. Measured in tools/jump-test.mjs:
     * two supposedly identical runs landed 0.32 m apart because of it, which is
     * enough to make an A/B comparison meaningless. The LEDGER is deliberately
     * untouched — a respawn is not a reason to lose your score.
     */
    reset() {
      hitStop = 0; hitEase = 0; impactCool = 0;
      slowArmed = false; slowBlend = 0; slowSim = 0; slowCool = 0;
      fovPunch = 0;
      this.jumpAir = false;
      this.timeScale = 1;
    },

    event(name, payload = {}) {
      const v = ctx.vehicle;
      const camera = ctx.camera;
      switch (name) {
        case 'impact':
          this._hit(payload.speed ?? 0, v, camera, false);
          break;
        case 'land':
          this._land(payload.speed ?? 4, v, camera);
          break;
        case 'jump':
          this._takeoff(payload, v, camera);
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

    /**
     * TAKE-OFF. Fired once per flight by `game.js _stepVertical`, and only for a
     * launch off a real ramp — see the SEPARATION note there. Everything in here
     * is a one-shot; the sustained part of the effect is `slowArmed`, which the
     * update loop releases when the wheels come back down.
     */
    _takeoff(p, v, camera) {
      if (!v) return;
      this.jumpCount++;
      // Armed for `_land`: this flight earns the big touchdown, an ordinary
      // crest-hop does not. See the note there.
      this.jumpAir = true;
      // Punch the FOV OUT as the car lifts — the opposite sign to an impact,
      // because the world is falling away rather than arriving.
      // 1.05 -> 0.55 because the slow-motion PULL-IN (see the FOV block in
      // update()) is -3.5 and arrives 0.18 s later: at the old value the two
      // spent the first third of the flight cancelling and the lens did nothing
      // visible at the moment it most needed to.
      fovPunch += 0.55;
      camera?.addShake?.(0.10);
      if (this.slowMoEnabled && !slowArmed && slowCool <= 0) {
        slowArmed = true;
        slowSim = 0;
      }
      /**
       * DIRT OFF THE LIP. There was nothing here at all: the take-off had two
       * fireworks and an FOV punch and no contact event whatsoever, so the car
       * simply stopped touching the ground with no sign that it had ever been
       * touching it. A rally car leaving an earthwork at 140 km/h throws a sheet
       * of it backwards, and the sheet is the thing that says WHEELS LEFT HERE.
       *
       * Thrown along -forward, at the height of the lip the event carries, and
       * scaled by the launch speed so a 3 m/s hop off a bank does not produce the
       * same plume as the design jump's 7.4.
       */
      if (particles?.burst) {
        const f = v.forward;
        particles.burst({
          x: v.position.x - f.x * 1.6, y: (p.y ?? v._groundY ?? 0) + 0.2, z: v.position.z - f.z * 1.6,
          n: 22, power: 3.0 + (p.vy ?? 4) * 0.55,
          color: 0xc8b48a, dx: -f.x, dz: -f.z, seed: 0x11f7,
        });
      }
      this._fireworks(p, v);
    },

    /** One battery either side of the take-off, at the lip's own height. */
    _fireworks(p, v) {
      if (!particles?.firework) return;
      const r = v.right;
      const y = p.y ?? (v._groundY ?? 0);
      let n = 0;
      for (const side of [1, -1]) {
        n += particles.firework({
          x: v.position.x + r.x * FIREWORK_SPREAD * side,
          y,
          z: v.position.z + r.z * FIREWORK_SPREAD * side,
          // Fixed seeds, not a running counter: every take-off must produce the
          // same frame, or the screenshot harness stops being a comparison.
          seed: side > 0 ? 0x5eed01 : 0x5eed02,
        });
      }
      this.fireworkCost = n;
    },

    /**
     * TOUCHDOWN — and the end of a celebrated jump is not an ordinary landing.
     *
     * "What good looks like: the landing has a visible compression." Two things
     * carry that here, and neither is a body squat: 0.30 m of chassis travel is
     * six pixels at this camera and cannot be seen. What CAN be seen is
     *
     *   1. the nose slamming level. `carPose` holds the flight attitude — about
     *      -24 degrees at touchdown — and blends out of it at 22/s, so the front
     *      of the car drops through two dozen degrees over about a sixth of a
     *      second of sim. Slow motion is still at 0.40 on the landing frame, so
     *      that plays over 0.4 s of wall clock. That is the compression.
     *   2. the dust. Which, until `particles.burst` existed, was emitted and
     *      thrown away every single time — see `_burst`.
     *
     * `jumpAir` is set by `_takeoff` and cleared here, so the big ring is spent
     * once per celebrated flight and an ordinary kerb-hop still gets the small
     * one. It cannot leak: the same edge that clears it releases slow motion.
     */
    _land(speed, v, camera) {
      if (!(speed > 1.2)) return;
      const big = this.jumpAir === true;
      this.jumpAir = false;
      camera?.addShake?.(clamp(speed * TUNE.landShake * (big ? 2.0 : 1), 0.05, 0.7));
      fovPunch -= clamp(speed * 0.06, 0.1, 0.9);
      this._burst(
        v,
        Math.round(clamp(speed * (big ? 5.0 : 2.2), 6, big ? 46 : 34)),
        (big ? 3.4 : 1.6) + speed * (big ? 0.26 : 0.12),
      );
      if (speed > 9 && hitStop <= 0) hitStop = 0.035;
    },

    /**
     * Debris/dust ring at the car's contact patch.
     *
     * NOT `particles.spawn` any more, and this was never decorative — it was
     * ABSENT. `spawn()` drops everything on any frame the contact-frame dust
     * driver has already run, which is every frame a moving car is on; counted
     * over 112 s of the jump_alpine drive, 11278 of these calls were discarded
     * and none survived. So a landing had no dust and an impact had no debris.
     * `particles.burst` is the event-shaped entry point; see the note on it.
     */
    _burst(v, n, power, color, dir) {
      if (!particles?.burst || !v) return;
      particles.burst({
        x: v.position.x, y: (v._groundY ?? 0) + 0.25, z: v.position.z,
        n, power, color: color ?? 0xd8d2c4,
        dx: dir?.x ?? 0, dz: dir?.z ?? 0,
        // Deterministic, like the fireworks: the screenshot harness compares the
        // same preset across rounds and a random ring makes that meaningless.
        seed: (this.jumpCount * 977 + n * 31 + Math.round(power * 100)) >>> 0,
      });
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
