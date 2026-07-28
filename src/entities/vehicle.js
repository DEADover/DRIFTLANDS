import * as THREE from 'three';

/**
 * ARCADE DRIFT MODEL
 * ------------------
 * Goal: sustained, controllable, *satisfying* powerslides. Not a sim.
 *
 * Design: a bicycle model with per-axle slip angles. Lateral force follows a
 * Pacejka-lite curve that PEAKS then FALLS OFF, which is what makes a drift
 * hold instead of snapping back. The handbrake collapses rear grip; throttle
 * during a slide keeps the rear out (power-oversteer); lifting recovers.
 *
 * Everything is in metres / seconds / radians. +Z is "south", heading 0 = +X.
 */

const clamp = THREE.MathUtils.clamp;

export const DEFAULT_TUNE = {
  mass: 1150,
  wheelBase: 2.6,
  cgToFront: 1.25,
  cgToRear: 1.35,

  enginePower: 21000,        // N of drive force at full throttle (low gear)
  topSpeed: 41,              // m/s soft cap (~148 km/h — arcade rally, not a hypercar)
  brakeForce: 22000,
  reverseFactor: 0.45,
  rollingResist: 6.5,
  dragCoef: 0.9,

  maxSteer: 0.62,            // rad at standstill
  steerSpeedFalloff: 0.55,   // how much max steer shrinks at speed
  steerRate: 5.2,            // rad/s of steering actuation
  steerReturn: 7.0,
  counterSteerAssist: 0.55,  // helps the player hold a slide

  frontGrip: 12.2,           // cornering stiffness
  rearGrip: 11.0,
  gripPeak: 0.30,            // slip angle (rad) where lateral force peaks
  gripFalloff: 0.55,         // how much force is lost past the peak (0..1)
  loadTransfer: 0.35,

  handbrakeGripMul: 0.22,
  throttleGripMul: 0.55,     // rear grip lost at full throttle
  surfaceGrip: 1.0,

  angularDamp: 3.4,
  inertiaScale: 1.0,
};

export class Vehicle {
  constructor(tune = {}) {
    this.tune = { ...DEFAULT_TUNE, ...tune };
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3(0, 0, 0); // world space, y unused for drive
    this.heading = 0;            // yaw, radians
    this.yawRate = 0;
    this.steer = 0;              // actual steering angle
    this.steerInput = 0;
    this.engineRpm = 0.15;
    this.gear = 1;

    // Derived / telemetry — read by FX, camera, HUD, scoring.
    this.speed = 0;
    this.lateralSlip = 0;        // -1..1 signed, how sideways we are
    this.slipAngle = 0;
    this.driftAngle = 0;
    this.isDrifting = false;
    this.driftTime = 0;
    this.wheelSlip = [0, 0, 0, 0];
    this.surfaceGrip = 1;
    this.onGround = true;
    this.verticalVel = 0;

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
  }

  get forward() {
    return this._fwd.set(Math.cos(this.heading), 0, -Math.sin(this.heading));
  }
  get right() {
    return this._right.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /**
   * @param {number} dt fixed timestep
   * @param {{throttle:number,brake:number,steer:number,handbrake:number}} input
   */
  step(dt, input) {
    const T = this.tune;
    const fwd = this.forward.clone();
    const right = this.right.clone();

    // ---- local-space velocity -------------------------------------------
    const vLong = this.velocity.dot(fwd);
    const vLat = this.velocity.dot(right);
    const speed = this.velocity.length();
    this.speed = speed;

    // ---- steering actuation ---------------------------------------------
    const speedFactor = 1 - clamp(speed / T.topSpeed, 0, 1) * T.steerSpeedFalloff;
    const maxSteer = T.maxSteer * speedFactor;

    // Counter-steer assist: when sliding, bias the achievable steering toward
    // the slide so the player can hold it without perfect inputs.
    const slideDir = Math.sign(vLat);
    const slideMag = clamp(Math.abs(vLat) / 12, 0, 1);
    const assist = -slideDir * slideMag * T.counterSteerAssist * maxSteer;

    const target = clamp(input.steer * maxSteer + assist, -maxSteer * 1.35, maxSteer * 1.35);
    const rate = Math.abs(target) > Math.abs(this.steer) ? T.steerRate : T.steerReturn;
    this.steer += clamp(target - this.steer, -rate * dt, rate * dt);
    this.steerInput = input.steer;

    // ---- longitudinal forces ---------------------------------------------
    const throttle = input.throttle;
    const brake = input.brake;
    let driveForce = 0;

    if (throttle > 0) {
      const speedRatio = clamp(vLong / T.topSpeed, 0, 1);
      // Torque curve: strong low-end, tapering to the top speed.
      const curve = 1 - speedRatio * speedRatio * 0.85;
      driveForce = T.enginePower * throttle * curve;
    }
    if (brake > 0) {
      if (vLong > 0.5) driveForce -= T.brakeForce * brake;
      else driveForce -= T.enginePower * T.reverseFactor * brake;
    }
    // resistance
    driveForce -= T.rollingResist * vLong * 12;
    driveForce -= T.dragCoef * vLong * Math.abs(vLong) * 1.2;

    // ---- lateral forces: per-axle slip -----------------------------------
    const wb = T.wheelBase;
    const frontVLat = vLat + this.yawRate * T.cgToFront;
    const rearVLat = vLat - this.yawRate * T.cgToRear;
    const vRef = Math.max(Math.abs(vLong), 2.5);

    const frontSlip = Math.atan2(frontVLat, vRef) - this.steer * Math.sign(Math.max(vLong, 0.1));
    const rearSlip = Math.atan2(rearVLat, vRef);

    // Weight transfer: braking loads the front, throttle loads the rear.
    const accelSign = clamp((driveForce / (T.mass * 9.81)) * T.loadTransfer, -0.45, 0.45);
    const frontLoad = 0.5 - accelSign;
    const rearLoad = 0.5 + accelSign;

    const surf = this.surfaceGrip * T.surfaceGrip;
    let rearGripMul = surf;
    if (input.handbrake > 0) rearGripMul *= THREE.MathUtils.lerp(1, T.handbrakeGripMul, input.handbrake);
    // Power oversteer — throttle eats rear grip, which is the drift engine.
    rearGripMul *= 1 - throttle * (1 - T.throttleGripMul) * clamp(speed / 18, 0, 1);

    const fyF = -tyreForce(frontSlip, T.frontGrip, T) * frontLoad * T.mass * 9.81 * surf;
    const fyR = -tyreForce(rearSlip, T.rearGrip, T) * rearLoad * T.mass * 9.81 * rearGripMul;

    // ---- integrate --------------------------------------------------------
    const cosSteer = Math.cos(this.steer);
    const accLong = (driveForce + fyF * Math.sin(this.steer) * -1) / T.mass;
    const accLat = (fyF * cosSteer + fyR) / T.mass;

    const torque = fyF * cosSteer * T.cgToFront - fyR * T.cgToRear;
    const inertia = T.mass * 1.1 * T.inertiaScale;
    this.yawRate += (torque / inertia) * dt;
    this.yawRate -= this.yawRate * T.angularDamp * dt;
    this.yawRate = clamp(this.yawRate, -3.2, 3.2);
    this.heading += this.yawRate * dt;

    const newLong = vLong + accLong * dt;
    const newLat = vLat + accLat * dt;

    const f2 = this.forward;
    const r2 = this.right;
    this.velocity.set(
      f2.x * newLong + r2.x * newLat,
      0,
      f2.z * newLong + r2.z * newLat
    );

    // Hard stop at crawl so the car settles instead of jittering.
    if (this.velocity.lengthSq() < 0.02 && throttle === 0) {
      this.velocity.set(0, 0, 0);
      this.yawRate *= 0.5;
    }

    this.position.addScaledVector(this.velocity, dt);

    // ---- telemetry --------------------------------------------------------
    this.slipAngle = Math.atan2(newLat, Math.max(Math.abs(newLong), 0.001));
    this.driftAngle = Math.abs(this.slipAngle);
    this.lateralSlip = clamp(newLat / 14, -1, 1);
    const drifting = this.driftAngle > 0.16 && this.speed > 7;
    this.isDrifting = drifting;
    this.driftTime = drifting ? this.driftTime + dt : 0;

    const fs = clamp(Math.abs(frontSlip) / 0.5, 0, 1);
    const rs = clamp(Math.abs(rearSlip) / 0.5, 0, 1) * (input.handbrake > 0 ? 1.4 : 1);
    this.wheelSlip[0] = fs; this.wheelSlip[1] = fs;
    this.wheelSlip[2] = clamp(rs, 0, 1.5); this.wheelSlip[3] = clamp(rs, 0, 1.5);

    // Engine audio/visual driver.
    const wheelSpeed = Math.abs(newLong) + Math.abs(newLat) * 0.5;
    const targetRpm = clamp(0.12 + ((wheelSpeed / T.topSpeed) * 2.2) % 1, 0.08, 1);
    this.engineRpm += (targetRpm - this.engineRpm) * Math.min(1, dt * 8);
    this.gear = Math.max(1, Math.min(6, Math.floor(wheelSpeed / (T.topSpeed / 6)) + 1));
  }
}

/**
 * Pacejka-lite: rises to a peak at `gripPeak` slip, then decays to a plateau.
 * The decay is what makes drifts *hold* rather than snap.
 */
function tyreForce(slip, stiffness, T) {
  const a = Math.abs(slip);
  const peak = T.gripPeak;
  let f;
  if (a < peak) {
    f = (a / peak);
  } else {
    const over = Math.min((a - peak) / (Math.PI / 2 - peak), 1);
    f = 1 - over * T.gripFalloff;
  }
  // stiffness scales the whole curve into a friction coefficient (~1.0-1.4)
  const mu = (stiffness / 11) * 1.05;
  return Math.sign(slip) * f * mu;
}
