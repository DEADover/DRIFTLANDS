import * as THREE from 'three';

/**
 * ARCADE DRIFT MODEL
 * ------------------
 * Goal: sustained, controllable, *satisfying* powerslides. Not a sim.
 *
 * Design: a bicycle model integrated in the INERTIAL frame with per-axle slip
 * angles and a Pacejka-lite curve that peaks then falls off to a plateau. The
 * falloff is what lets a slide hold instead of snapping straight. Longitudinal
 * force eats lateral capacity through a friction circle, so the throttle really
 * is the drift's throttle. The handbrake collapses rear grip to initiate;
 * lifting hands grip back and the car recovers.
 *
 * Sign conventions (all of them, because the v0 model had them inconsistent):
 *   heading psi rotates about +Y.  forward = (cos, 0, -sin), right = (sin, 0, cos)
 *   yawRate > 0  -> rotating toward the car's LEFT
 *   vy (velocity . right) > 0  -> sliding toward the car's RIGHT, i.e. a
 *      left-hand (counter-clockwise) drift
 *   steer (delta) > 0  -> front wheels pointed LEFT
 *   slip angle alpha = atan2(lateralVel, |longVel|) + delta on the front axle
 *   lateral force  Fy = -mu(alpha) * Fz          (opposes slip)
 *   yaw torque     tau = -a * Fyf * cos(delta) + b * Fyr
 *
 * CRITICAL vs the v0 model: velocity is integrated in WORLD space. The old
 * model rebuilt world velocity from body-frame components using the *new*
 * heading every frame, which dragged the velocity vector around with the car
 * and made slip angle physically unable to accumulate. That is why a full
 * handbrake produced 2-4 degrees.
 *
 * Everything is in metres / seconds / radians.
 */

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export const DEFAULT_TUNE = {
  // --- chassis -------------------------------------------------------------
  mass: 1180,
  cgToFront: 1.24,
  cgToRear: 1.36,
  cgHeight: 0.62,            // drives weight transfer (exaggerated on purpose)
  inertiaScale: 1.30,        // Iz = mass * this. Lower = more eager rotation.
  trackWidth: 1.58,

  // --- drivetrain ----------------------------------------------------------
  // Longitudinal feel, retuned after play-testing. 16200 N on 1180 kg is
  // 13.7 m/s^2 — 0-100 km/h in about two seconds, which made the car feel
  // teleport-fast and, by contrast, made braking feel broken. 9000 N gives
  // ~7.6 m/s^2 and a ~3.7 s 0-100: still firmly arcade, but you can place the
  // car. Braking is grip-limited in practice (mu ~1.3 on dirt caps it near
  // 12.7 m/s^2), so the raise mostly guarantees the tyres are the limit, not
  // the brake, and engine braking now gives real deceleration off-throttle.
  enginePower: 9000,         // N of drive force at full throttle, low speed
  topSpeed: 44,              // m/s (~158 km/h) — reads fast at this camera height
  driveBiasRear: 0.66,       // rear-biased AWD: launches hard, still oversteers
  brakeForce: 27000,
  engineBrake: 2600,         // N of overrun drag with the throttle shut
  reverseFactor: 0.30,
  rollingResist: 210,        // N constant
  rollingSpeed: 7.5,         // N per m/s
  dragCoef: 0.63,            // N per (m/s)^2
  slideDrag: 26,             // N per (m/s of lateral slide) — sideways scrubs speed

  // --- steering ------------------------------------------------------------
  maxSteer: 0.60,            // rad at standstill
  steerFalloffSpeed: 34,     // m/s at which the falloff is fully applied
  steerSpeedFalloff: 0.52,   // fraction of max steer lost at speed
  steerRate: 7.4,            // rad/s of steering actuation
  steerReturn: 9.5,
  counterSteerAssist: 0.80,  // fraction of the required counter-steer applied
  counterSteerDamp: 0.10,    // derivative term — kills tank-slappers
  steerAuthority: 1.85,      // how far past maxSteer counter-steer may reach

  // --- tyres ---------------------------------------------------------------
  baseMu: 1.62,              // peak friction coefficient on full grip
  gripExponent: 1.42,        // surfaceGrip raised to this — makes snow LOOSE
  peakSlipTarmac: 0.135,     // rad where lateral force peaks (~7.7 deg)
  peakSlipLoose: 0.30,       // loose surfaces peak later and flatter
  slipTail: 0.62,            // rad over which force decays past the peak
  plateauTarmac: 0.58,       // fraction of peak retained deep in a slide
  plateauLoose: 0.80,        // loose = forgiving, easy to hold sideways
  frontGripBias: 1.05,       // front grippier than rear = friendly oversteer
  rearGripBias: 0.97,
  frictionCircle: 0.94,      // how completely longitudinal use eats lateral grip

  // --- drift controls ------------------------------------------------------
  handbrakeGripMul: 0.24,    // rear mu multiplier under full handbrake
  handbrakeForce: 7600,      // N of rear braking from the lever
  throttleOversteer: 0.22,   // extra rear grip loss on power
  driftSustain: 1.45,        // yaw moment that keeps a commanded slide alive
  driftDamp: 0.30,           // derivative gain on the sustain servo
  driftEntryKick: 0.52,      // extra rotation on handbrake initiation
  betaMax: 0.66,             // rad (~38 deg) — the drift the car settles toward
  yawDamp: 0.95,
  yawDampSpin: 8.0,          // anti-spin damping past betaMax
  spinRecover: 6.0,          // active gather-up moment when past the limit

  // --- collisions ----------------------------------------------------------
  bumpRestitution: 0.34,     // how much of the inward speed bounces back
  bumpTangentKeep: 0.95,     // speed kept along the surface on a graze
  bumpHeadOnKeep: 0.62,      // speed kept in a square-on hit
  bumpSpin: 0.22,            // yaw flick from an off-centre hit
  bumpAlign: 0.58,           // how much a hit turns the CAR, not just its path
  bumpDeflect: 0.62,         // minimum slide along the surface, per m/s of hit
  bumpEscape: 7.0,           // m/s per second of grinding — nothing traps the car
  bumpSteer: 2.2,            // rad/s^2 steering the nose along the obstacle

  // --- suspension (visual + landing feel) ----------------------------------
  suspFreq: 2.35,            // Hz
  suspDamp: 0.52,
  suspTravel: 0.34,          // m of usable travel

  surfaceGrip: 1.0,
};

const GEAR_COUNT = 6;

export class Vehicle {
  constructor(tune = {}) {
    this.tune = { ...DEFAULT_TUNE, ...tune };
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3(0, 0, 0); // WORLD space, y unused for drive
    this.heading = 0;            // yaw, radians
    this.yawRate = 0;
    this.steer = 0;              // actual front wheel angle (+ = left)
    this.steerInput = 0;
    this.engineRpm = 0.15;
    this.gear = 1;

    // Derived / telemetry — read by FX, camera, HUD, scoring.
    this.speed = 0;
    this.longSpeed = 0;
    this.latSpeed = 0;
    this.lateralSlip = 0;        // -1..1 signed, how sideways we are
    this.slipAngle = 0;          // signed
    this.driftAngle = 0;         // magnitude, radians — the headline number
    this.isDrifting = false;
    this.driftTime = 0;
    this.wheelSlip = [0, 0, 0, 0];
    this.wheelSpinBoost = 0;     // 0..1 longitudinal wheelspin
    this.surfaceGrip = 1;
    this.onGround = true;
    this.verticalVel = 0;

    // Feel-facing one-shot telemetry (consumed and cleared by fx/feel.js).
    this.lastImpact = 0;         // m/s of normal velocity killed by a hit
    this.contactCount = 0;       // total prop contacts this life (telemetry)
    this.impactDir = new THREE.Vector3();
    this.justShifted = 0;        // +1 up, -1 down, cleared by the reader
    this.landImpact = 0;         // m/s of downward velocity killed on landing
    this.airTime = 0;
    this.rideHeight = 0;         // suspension deflection, m (negative = compressed)
    this.pitchAccel = 0;         // smoothed longitudinal accel, m/s^2
    this.rollAccel = 0;          // smoothed lateral accel, m/s^2

    this._accX = 0;
    this._accY = 0;
    this._prevBeta = 0;
    this._csAssist = 0;
    this._entryKick = 0;
    this._hbHeld = 0;
    this._gearTimer = 0;
    this._contactTime = 0;

    // Externally-applied depenetration tracking (see _resolveExternal).
    this._lastPos = new THREE.Vector3();
    this._lastVel = new THREE.Vector3();
    this._lastYawRate = 0;

    // Vertical body state (driven by entities/car.js, which knows the ground).
    this._bodyY = 0;
    this._bodyVY = 0;
    this._groundY = null;
    this._groundVY = 0;

    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
  }

  reset(x = 0, z = 0, heading = 0) {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.heading = heading;
    this.yawRate = 0;
    this.steer = 0;
    this.driftTime = 0;
    this.driftAngle = 0;
    this.slipAngle = 0;
    this.lateralSlip = 0;
    this._accX = this._accY = 0;
    this._prevBeta = 0;
    this._csAssist = 0;
    this._entryKick = 0;
    this._lastPos.copy(this.position);
    this._lastVel.set(0, 0, 0);
    this._lastYawRate = 0;
    this._bodyY = this._bodyVY = 0;
    this._groundY = null;
    this._contactTime = 0;
    this.lastImpact = 0;
    this.landImpact = 0;
    this.airTime = 0;
  }

  get forward() {
    return this._fwd.set(Math.cos(this.heading), 0, -Math.sin(this.heading));
  }
  get right() {
    return this._right.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /** Peak friction coefficient available on the current surface. */
  get mu() {
    const T = this.tune;
    const g = clamp(this.surfaceGrip * T.surfaceGrip, 0.2, 1.4);
    return T.baseMu * Math.pow(g, T.gripExponent);
  }

  /**
   * The shell (game.js) resolves prop overlaps by translating the car out along
   * the contact normal and scaling velocity down *every frame it overlaps* —
   * that is a hard stop, not a collision, and it zeroes the car against a rock.
   *
   * We do not own game.js, so we detect the translation here (position moved
   * without us moving it) and rebuild a proper impulse from the pre-contact
   * velocity: kill the inward component with a little bounce, KEEP the
   * tangential component so the car scrapes along and drives away.
   */
  _resolveExternal(dt, input) {
    const T = this.tune;
    const dx = this.position.x - this._lastPos.x;
    const dz = this.position.z - this._lastPos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < 1e-8 || d2 > 64) {                // no push, or a teleport/reset
      this._contactTime = Math.max(0, this._contactTime - dt * 3);
      return;
    }
    this._contactTime = Math.min(1.2, this._contactTime + dt);
    if (this._contactTime <= dt * 1.5) this.contactCount++;

    const d = Math.sqrt(d2);
    const nx = dx / d, nz = dz / d;            // contact normal, away from the prop

    // Pre-contact velocity is what we integrated last frame; the shell has
    // since scaled `velocity` down by an arbitrary number of 0.45 factors.
    const vx = this._lastVel.x, vz = this._lastVel.z;
    const vn = vx * nx + vz * nz;              // < 0 means we were driving into it
    let ox = vx - vn * nx, oz = vz - vn * nz;

    // Severity: head-on kills speed, a graze barely costs anything.
    const inward = Math.max(0, -vn);
    const speed = Math.hypot(vx, vz);
    const headOn = speed > 0.5 ? inward / speed : 0;
    const keep = lerp(T.bumpTangentKeep, T.bumpHeadOnKeep, headOn * headOn);
    ox *= keep; oz *= keep;
    ox += nx * inward * T.bumpRestitution;
    oz += nz * inward * T.bumpRestitution;

    // Pick the tangent that carries us onward past the obstacle.
    let tx = -nz, tz = nx;
    const f = this.forward;
    let sense = tx * f.x + tz * f.z;
    if (Math.abs(sense) < 0.05) sense = tx * vx + tz * vz;
    if (sense < 0) { tx = -tx; tz = -tz; }

    // A prop DEFLECTS you. It never welds you to the ground: guarantee a
    // minimum slide along the contact, growing the longer we grind, so a
    // nose-on hit with a boulder spits the car sideways and it drives away.
    const effort = 0.4 + 0.6 * clamp((input?.throttle ?? 0) + (input?.brake ?? 0), 0, 1);
    const slide = Math.max(inward * T.bumpDeflect, this._contactTime * T.bumpEscape * effort);
    const along = ox * tx + oz * tz;
    if (along < slide) { ox += tx * (slide - along); oz += tz * (slide - along); }

    this.velocity.set(ox, 0, oz);

    // A hit deflects the CAR, not just its trajectory. Without this the
    // velocity vector snaps sideways while the body keeps pointing the old
    // way, which reads as an instant 70-degree spin out of nowhere and takes
    // seconds to recover from. Carrying most of the deflection into the
    // heading turns a shunt into a knock off line.
    const oldAng = Math.atan2(-vz, vx);
    const newAng = Math.atan2(-oz, ox);
    let dAng = (newAng - oldAng) % (Math.PI * 2);
    if (dAng > Math.PI) dAng -= Math.PI * 2;
    if (dAng < -Math.PI) dAng += Math.PI * 2;
    if (speed > 3) this.heading += clamp(dAng, -1.2, 1.2) * T.bumpAlign;

    // Clipping something off-centre spins you, and grinding along it steers the
    // nose parallel to the surface instead of leaving it buried.
    const r = this.right;
    const side = Math.sign(-(nx * r.x + nz * r.z)) || 1;
    let yaw = this._lastYawRate * 0.8 - side * inward * T.bumpSpin * 0.05;
    const wantHeading = Math.atan2(-tz, tx);
    let dh = (wantHeading - this.heading) % (Math.PI * 2);
    if (dh > Math.PI) dh -= Math.PI * 2;
    if (dh < -Math.PI) dh += Math.PI * 2;
    yaw += clamp(dh, -1.2, 1.2) * T.bumpSteer * dt * Math.min(1, this._contactTime * 5);
    this.yawRate = clamp(yaw, -3.6, 3.6);

    if (inward > this.lastImpact) {
      this.lastImpact = inward;
      this.impactDir.set(nx, 0, nz);
    }
  }

  /**
   * @param {number} dt fixed timestep
   * @param {{throttle:number,brake:number,steer:number,handbrake:number}} input
   */
  step(dt, input) {
    const T = this.tune;
    this._resolveExternal(dt, input);

    const cosH = Math.cos(this.heading), sinH = Math.sin(this.heading);
    // body-frame velocity: x = forward, y = right
    const vx = this.velocity.x * cosH - this.velocity.z * sinH;
    const vy = this.velocity.x * sinH + this.velocity.z * cosH;
    const speed = Math.hypot(vx, vy);
    this.speed = speed;
    this.longSpeed = vx;
    this.latSpeed = vy;

    const throttle = clamp(input.throttle ?? 0, 0, 1);
    const brake = clamp(input.brake ?? 0, 0, 1);
    const handbrake = clamp(input.handbrake ?? 0, 0, 1);

    // ---- surface ----------------------------------------------------------
    const grip = clamp(this.surfaceGrip * T.surfaceGrip, 0.2, 1.4);
    const muBase = T.baseMu * Math.pow(grip, T.gripExponent);
    // 0 = tarmac, 1 = deep snow. Loose surfaces peak later and fall off less,
    // so they feel floaty and are easy to hold sideways.
    const loose = clamp((1 - grip) / 0.45, 0, 1);
    const peakSlip = lerp(T.peakSlipTarmac, T.peakSlipLoose, loose);
    const plateau = lerp(T.plateauTarmac, T.plateauLoose, loose);

    // ---- drift angle & counter-steer assist -------------------------------
    const vRef = Math.max(Math.abs(vx), 2.2);
    const beta = Math.atan2(vy, vRef);
    const betaRate = (beta - this._prevBeta) / Math.max(dt, 1e-5);
    this._prevBeta = beta;

    const engaged = smoothstep(4, 11, speed);
    // A real driver counter-steers into the slide. Doing it here (a) makes the
    // car holdable with coarse inputs and (b) puts visible opposite lock on the
    // front wheels, which is most of why a top-down drift reads as a drift.
    const csTarget =
      -(clamp(beta, -1.2, 1.2) * T.counterSteerAssist +
        clamp(betaRate, -6, 6) * T.counterSteerDamp) * engaged;
    this._csAssist += (csTarget - this._csAssist) * Math.min(1, dt * 12);

    const speedT = clamp(speed / T.steerFalloffSpeed, 0, 1);
    const maxSteer = T.maxSteer * (1 - speedT * T.steerSpeedFalloff);
    const steerCmd = (input.steer ?? 0) * maxSteer + this._csAssist;
    const lim = maxSteer * T.steerAuthority;
    const target = clamp(steerCmd, -lim, lim);
    const rate = Math.abs(target) > Math.abs(this.steer) ? T.steerRate : T.steerReturn;
    this.steer += clamp(target - this.steer, -rate * dt, rate * dt);
    this.steerInput = input.steer ?? 0;
    const delta = this.steer;

    // ---- longitudinal drive ------------------------------------------------
    // The rev limiter watches TOTAL speed, not forward speed: otherwise a car
    // sitting at 40 degrees reads as "slow" and gets full power, and a drift
    // becomes an accelerator instead of the speed-scrubbing move it should be.
    const sr = clamp(speed / T.topSpeed, 0, 1);
    let drive = 0;
    let reverse = 0;
    if (throttle > 0) {
      drive = T.enginePower * throttle * Math.max(0, 1 - sr * sr * sr);
    }
    let brakeF = 0;
    if (brake > 0) {
      if (vx > 0.4) brakeF = T.brakeForce * brake;
      else reverse = T.enginePower * T.reverseFactor * brake;
    }
    // Overrun: lifting off should slow the car noticeably, not coast forever.
    // Without this the only way to shed speed is the brake, which is a large
    // part of why deceleration felt absent.
    if (throttle <= 0.02 && brake <= 0.02 && vx > 0.5) {
      brakeF += T.engineBrake * Math.min(1, vx / 6);
    }
    const hbF = handbrake * T.handbrakeForce * (vx > 0.2 ? 1 : 0);

    // Resistance acts along the VELOCITY vector, not the body axis, plus a
    // sideways scrub term: a car at 35 degrees is a barn door, and bleeding
    // speed in the slide is what makes exits feel earned.
    const moving = speed > 0.3 ? 1 : 0;
    const dragMag = (T.rollingResist + T.rollingSpeed * speed +
      T.dragCoef * speed * speed + T.slideDrag * Math.abs(vy)) * moving;
    const ux = speed > 0.1 ? vx / speed : 1;
    const uy = speed > 0.1 ? vy / speed : 0;
    const resist = dragMag * ux;
    const resistY = dragMag * uy;

    // ---- vertical loads with weight transfer -------------------------------
    const L = T.cgToFront + T.cgToRear;
    const W = T.mass * 9.81;
    const transfer = clamp((T.mass * this._accX * T.cgHeight) / L, -W * 0.42, W * 0.42);
    const Fzf = Math.max(W * 0.12, W * (T.cgToRear / L) - transfer);
    const Fzr = Math.max(W * 0.12, W * (T.cgToFront / L) + transfer);

    // ---- rear axle: the friction circle is the drift engine ------------------
    // Longitudinal force is capped by available grip, so snow cannot put the
    // power down and spins its wheels instead — that is what makes a surface
    // *felt* rather than just a number.
    const fxRearCmd = (drive - reverse) * T.driveBiasRear - brakeF * 0.38 - hbF;
    let muR = muBase * T.rearGripBias;
    muR *= lerp(1, T.handbrakeGripMul, handbrake);
    muR *= 1 - throttle * T.throttleOversteer * smoothstep(4, 16, speed);
    const rearCap = Math.max(1, muR * Fzr);
    const demandR = Math.abs(fxRearCmd) / rearCap;
    const useR = Math.min(demandR, 1);
    const fxRear = clamp(fxRearCmd, -rearCap, rearCap);
    const muRlat = muR * Math.sqrt(Math.max(0, 1 - useR * useR * T.frictionCircle));

    // ---- front axle ---------------------------------------------------------
    const fxFrontCmd = (drive - reverse) * (1 - T.driveBiasRear) - brakeF * 0.62;
    const muF = muBase * T.frontGripBias;
    const frontCap = Math.max(1, muF * Fzf);
    const useF = clamp(Math.abs(fxFrontCmd) / frontCap, 0, 1);
    const fxFront = clamp(fxFrontCmd, -frontCap, frontCap);
    const muFlat = muF * Math.sqrt(Math.max(0, 1 - useF * useF * T.frictionCircle * 0.8));

    const vyF = vy - this.yawRate * T.cgToFront;
    const vyR = vy + this.yawRate * T.cgToRear;
    const alphaF = Math.atan2(vyF, vRef) + delta;
    const alphaR = Math.atan2(vyR, vRef);

    const Fyf = tyreLat(alphaF, muFlat, peakSlip, plateau, T.slipTail) * Fzf;
    const Fyr = tyreLat(alphaR, muRlat, peakSlip * 1.06, plateau, T.slipTail) * Fzr;

    // ---- assemble body-frame forces ----------------------------------------
    const cd = Math.cos(delta), sd = Math.sin(delta);
    const FyfLat = Fyf * cd;
    const Fx = fxRear + fxFront - resist + Fyf * sd;
    const Fy = FyfLat + Fyr - resistY;

    const ax = Fx / T.mass;
    const ay = Fy / T.mass;
    this._accX = lerp(this._accX, ax, Math.min(1, dt * 22));
    this._accY = lerp(this._accY, ay, Math.min(1, dt * 22));
    this.pitchAccel = this._accX;
    this.rollAccel = this._accY;

    // ---- yaw ----------------------------------------------------------------
    const Iz = T.mass * T.inertiaScale;
    let torque = -T.cgToFront * FyfLat + T.cgToRear * Fyr;

    // Handbrake initiation kick: a short burst of rotation in the commanded
    // direction so a stab of the lever *snaps* the tail out instead of sighing.
    if (handbrake > 0.5 && this._hbHeld < 0.28 && speed > 6) {
      this._entryKick = (input.steer ?? 0) * T.driftEntryKick;
    }
    this._hbHeld = handbrake > 0.5 ? this._hbHeld + dt : 0;
    if (Math.abs(this._entryKick) > 1e-3) {
      torque += this._entryKick * Iz * 3.4;
      this._entryKick -= this._entryKick * Math.min(1, dt * 9);
    }

    // Drift sustain: while the rear is genuinely loose and the player is asking
    // for a slide, add a yaw moment in that direction. This is the difference
    // between a car that settles at a boring 8 deg and one you can hold at 35.
    // How far the slide is allowed to run scales with how much lock the player
    // is asking for, so the drift angle is something you *steer*, not a constant.
    const rearLoose = clamp(1 - muRlat / Math.max(0.05, muBase), 0, 1);
    const want = clamp(input.steer ?? 0, -1, 1);
    const betaLimit = T.betaMax * (0.46 + 0.54 * Math.max(Math.abs(want), handbrake)) *
      (1 + loose * 0.20);            // snow lets the slide run further
    // Proportional-derivative, not proportional: without the rate term the
    // slide hunts (57 deg, 17 deg, 33 deg...) instead of settling on an angle.
    const signW = Math.sign(want) || 1;
    const room = clamp(1 - (beta * signW) / betaLimit, 0, 1);
    const sustain = clamp(room - betaRate * signW * T.driftDamp, -0.35, 1);
    torque += want * rearLoose * sustain * engaged * T.driftSustain * Iz;

    // Anti-spin. Damping alone is not enough: it stops the rotation but leaves
    // the car broadside and sliding, which is a spin, not a drift. So past the
    // limit we add an active gather-up moment that rotates the nose back toward
    // the velocity vector — exactly what a driver does to catch one.
    const spin = smoothstep(betaLimit * 0.86, betaLimit + 0.24, Math.abs(beta));
    const damp = T.yawDamp + T.yawDampSpin * spin;
    torque -= this.yawRate * damp * Iz;
    const over = Math.abs(beta) - betaLimit;
    if (over > 0) torque -= Math.sign(beta) * Math.min(over, 0.9) * T.spinRecover * Iz;

    this.yawRate += (torque / Iz) * dt;
    if (speed < 2.2) this.yawRate *= Math.exp(-dt * 5.5);
    this.yawRate = clamp(this.yawRate, -3.6, 3.6);
    this.heading += this.yawRate * dt;

    // ---- integrate in WORLD space (this is what lets slip accumulate) -------
    const f = this.forward, r = this.right;
    this.velocity.x += (f.x * ax + r.x * ay) * dt;
    this.velocity.z += (f.z * ax + r.z * ay) * dt;

    if (this.velocity.lengthSq() < 0.05 && throttle === 0 && brake === 0) {
      this.velocity.set(0, 0, 0);
      this.yawRate *= 0.4;
    }
    this.position.addScaledVector(this.velocity, dt);

    this._lastPos.copy(this.position);
    this._lastVel.copy(this.velocity);
    this._lastYawRate = this.yawRate;

    // ---- telemetry ----------------------------------------------------------
    const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
    const nvx = this.velocity.x * ch - this.velocity.z * sh;
    const nvy = this.velocity.x * sh + this.velocity.z * ch;
    this.speed = Math.hypot(nvx, nvy);
    this.slipAngle = Math.atan2(nvy, Math.max(Math.abs(nvx), 0.6));
    this.driftAngle = Math.abs(this.slipAngle);
    this.lateralSlip = clamp(nvy / 13, -1, 1);
    const drifting = this.driftAngle > 0.17 && this.speed > 7;
    this.isDrifting = drifting;
    this.driftTime = drifting ? this.driftTime + dt : 0;

    // Wheel slip drives skid marks and dust. Rear includes wheelspin, and the
    // loaded outside wheel marks harder than the unloaded inside one.
    // Real wheelspin = the axle was asked for more than it can hold.
    this.wheelSpinBoost = clamp((demandR - 1.0) * 1.15, 0, 1) * throttle;
    const fs = clamp(Math.abs(alphaF) / 0.42, 0, 1.2);
    const rsBase = clamp(Math.abs(alphaR) / 0.36 + handbrake * 0.85 +
      this.wheelSpinBoost * 0.75, 0, 1.6);
    const bias = clamp(this._accY / 9.0, -0.35, 0.35);
    this.wheelSlip[0] = clamp(fs * (1 - bias * 0.5), 0, 1.3);
    this.wheelSlip[1] = clamp(fs * (1 + bias * 0.5), 0, 1.3);
    this.wheelSlip[2] = clamp(rsBase * (1 - bias * 0.5), 0, 1.6);
    this.wheelSlip[3] = clamp(rsBase * (1 + bias * 0.5), 0, 1.6);

    this._updateDrivetrain(dt, Math.abs(nvx), throttle);
  }

  /** Gearbox: gives audio and the HUD rhythm, and fires shift events. */
  _updateDrivetrain(dt, fwdSpeed, throttle) {
    const T = this.tune;
    const span = T.topSpeed / GEAR_COUNT;
    // Gear from speed, WITH HYSTERESIS. A bare floor() meant cruising at a
    // boundary flipped the gear every time the timer expired, and each flip
    // fired a shift event that punched the camera.
    const HYST = 0.12;
    const upAt = this.gear * span * (1 + HYST * 0.5);
    const downAt = (this.gear - 1) * span * (1 - HYST * 0.5);
    let g = this.gear;
    if (fwdSpeed > upAt) g = Math.min(GEAR_COUNT, this.gear + 1);
    else if (fwdSpeed < downAt) g = Math.max(1, this.gear - 1);

    this._gearTimer = Math.max(0, this._gearTimer - dt);
    if (g !== this.gear && this._gearTimer <= 0) {
      this.justShifted = g > this.gear ? 1 : -1;
      this._gearTimer = 0.45;
      this.gear = g;
    }
    const frac = clamp((fwdSpeed - (this.gear - 1) * span) / span, 0, 1);
    const target = clamp(0.16 + frac * 0.86 + this.wheelSpinBoost * 0.35, 0.1, 1.25);
    this.engineRpm += (target - this.engineRpm) * Math.min(1, dt * 9);
  }

  /**
   * Vertical body model. The chassis is a spring-damper riding the terrain, so
   * the car squats over crests, extends into dips, and thumps on landing.
   * Called by entities/car.js, which is the thing that actually knows the
   * ground height under the car each frame.
   * @returns {number} body offset in metres (positive = extended)
   */
  updateVertical(dt, groundY) {
    const T = this.tune;
    if (this._groundY === null) { this._groundY = groundY; this._bodyY = 0; }
    const gvy = (groundY - this._groundY) / Math.max(dt, 1e-4);
    this._groundY = groundY;
    this._groundVY = lerp(this._groundVY, gvy, Math.min(1, dt * 30));

    const w = 2 * Math.PI * T.suspFreq;
    // The body chases the wheels; the terrain's vertical velocity loads it.
    // Cresting fast throws the body up (extension), dropping compresses it.
    const targetY = clamp(-this._groundVY * 0.055, -T.suspTravel, T.suspTravel);
    const acc = (targetY - this._bodyY) * w * w - this._bodyVY * 2 * T.suspDamp * w;
    this._bodyVY += acc * dt;
    this._bodyY += this._bodyVY * dt;

    const wasAir = !this.onGround;
    this.onGround = this._bodyY < T.suspTravel * 0.92;
    if (!this.onGround) this.airTime += dt;

    if (this._bodyY < -T.suspTravel) {
      const impact = -this._bodyVY;                // bottomed out
      this._bodyY = -T.suspTravel;
      this._bodyVY *= -0.18;
      if (impact > 1.4) this.landImpact = Math.max(this.landImpact, impact);
    }
    if (wasAir && this.onGround && this.airTime > 0.12) {
      this.landImpact = Math.max(this.landImpact, Math.abs(this._bodyVY) + 2);
      this.airTime = 0;
    }
    if (this.onGround) this.airTime = 0;

    this.verticalVel = this._bodyVY;
    this.rideHeight = this._bodyY;
    return this._bodyY;
  }
}

/**
 * Pacejka-lite. Rises smoothly to a peak at `peak` slip, then decays to a
 * plateau. The decay is what makes drifts *hold* rather than snap: past the
 * peak the axle cannot pull itself straight again on its own.
 * Returns a signed friction coefficient (multiply by vertical load).
 */
function tyreLat(alpha, mu, peak, plateau, tail) {
  const a = Math.abs(alpha);
  let f;
  if (a <= peak) {
    const t = a / peak;
    f = t * (2 - t);                       // flat-topped rise, no kink at the peak
  } else {
    const t = Math.min((a - peak) / tail, 1);
    f = 1 - (1 - plateau) * t * t * (3 - 2 * t);
  }
  return -Math.sign(alpha) * f * mu;
}
