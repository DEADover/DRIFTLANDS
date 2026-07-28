/**
 * TYRE CONTACT BUS  (owned by the fx builder)
 * -------------------------------------------
 * `game.js` hands the fx subsystem the rear tyre contact points, the per-wheel
 * slip, the surface and the speed once per frame — via `SkidMarks.emit()`.
 * That single call carries everything the *whole* fx subsystem needs, so we
 * resolve it once here into a full car frame and publish it for the particle
 * side to consume in the same frame. Nothing outside `src/fx/` touches this.
 *
 * Reconstruction: the two rear contact points are
 *     p = carPos - fwd*1.35 +- right*0.92
 * so (pRight - pLeft) recovers the car's `right` axis, and `fwd = (r.z, -r.x)`.
 * Differentiating the mid-point gives world velocity, hence longitudinal /
 * lateral split and yaw rate — enough to drive a directional plume without
 * widening anybody's contract.
 */

export const FX_CONTACT = {
  /** @type {null|object} resolved car frame for this frame, consumed by particles */
  frame: null,
};

const HALF_TRACK = 0.92;
const REAR_TO_FRONT = 2.6;

export class ContactTracker {
  constructor() {
    this.prevMidX = null;
    this.prevMidZ = null;
    this.prevRightX = 0;
    this.prevRightZ = 0;
    this.prevSpeed = 0;
    this.time = 0;
    this.frame = {
      x: 0, y: 0, z: 0,
      fwdX: 1, fwdZ: 0, rightX: 0, rightZ: 1,
      velX: 0, velZ: 0, dirX: 1, dirZ: 0,
      speed: 0, vLat: 0, vLong: 0, slipAngle: 0, yawRate: 0,
      slip: [0, 0], frontSlip: 0,
      rear: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }],
      front: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }],
      kind: 'dirt', grip: 1, impact: 0, dt: 1 / 60, time: 0,
      airborne: false,
    };
  }

  reset() {
    this.prevMidX = null;
    this.prevSpeed = 0;
  }

  /**
   * @param {number} dt
   * @param {{x:number,y:number,z:number}[]} rear rear-right, rear-left contact points
   * @param {number[]} slip per rear wheel, 0..1.5
   * @param {{surface?:{kind:string,grip:number}, speed?:number}} opts
   */
  update(dt, rear, slip, opts = {}) {
    const f = this.frame;
    this.time += dt;
    f.dt = dt;
    f.time = this.time;

    const a = rear[0], b = rear[1] ?? rear[0];
    let rx = a.x - b.x, rz = a.z - b.z;
    const rl = Math.hypot(rx, rz);
    if (rl > 1e-4) { rx /= rl; rz /= rl; } else { rx = this.prevRightX || 0; rz = this.prevRightZ || 1; }
    f.rightX = rx; f.rightZ = rz;
    f.fwdX = rz; f.fwdZ = -rx;

    const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
    f.x = mx; f.z = mz; f.y = (a.y + (b.y ?? a.y)) * 0.5;

    if (this.prevMidX === null) { this.prevMidX = mx; this.prevMidZ = mz; }
    const inv = dt > 1e-5 ? 1 / dt : 0;
    let vx = (mx - this.prevMidX) * inv;
    let vz = (mz - this.prevMidZ) * inv;
    // The reported speed is authoritative; the differentiated vector only gives
    // us the direction (and survives the odd teleport from a collision push-out).
    const dMag = Math.hypot(vx, vz);
    const speed = opts.speed ?? dMag;
    if (dMag > 0.05) { f.dirX = vx / dMag; f.dirZ = vz / dMag; }
    if (dMag > 60) { vx = f.dirX * speed; vz = f.dirZ * speed; }
    f.velX = vx; f.velZ = vz;
    f.speed = speed;
    this.prevMidX = mx; this.prevMidZ = mz;

    f.vLong = vx * f.fwdX + vz * f.fwdZ;
    f.vLat = vx * f.rightX + vz * f.rightZ;
    f.slipAngle = Math.atan2(f.vLat, Math.max(Math.abs(f.vLong), 0.6));

    // Yaw rate from the rotation of the recovered right axis.
    if (this.prevRightX || this.prevRightZ) {
      const cross = this.prevRightX * rz - this.prevRightZ * rx;
      const dot = this.prevRightX * rx + this.prevRightZ * rz;
      f.yawRate = Math.atan2(cross, dot) * inv;
    }
    this.prevRightX = rx; this.prevRightZ = rz;

    // Collision detection: game.js bleeds 55% of the velocity on a prop hit.
    f.impact = 0;
    if (this.prevSpeed > 7 && speed < this.prevSpeed * 0.72) {
      f.impact = Math.min(1, (this.prevSpeed - speed) / 14);
    }
    this.prevSpeed = speed;

    f.slip[0] = slip?.[0] ?? 0;
    f.slip[1] = slip?.[1] ?? 0;

    // Front wheels: 2.6 m ahead of the rear pair. Front tyres scrub from
    // steering + yaw, which we can read off the reconstructed frame.
    for (let i = 0; i < 2; i++) {
      const src = rear[i] ?? rear[0];
      const p = f.front[i];
      p.x = src.x + f.fwdX * REAR_TO_FRONT;
      p.z = src.z + f.fwdZ * REAR_TO_FRONT;
      p.y = src.y;
      const q = f.rear[i];
      q.x = src.x; q.y = src.y; q.z = src.z;
    }
    const frontLat = f.vLat + f.yawRate * (REAR_TO_FRONT * 0.5 + 1.3);
    f.frontSlip = Math.min(1.2, Math.abs(frontLat) / 7 + Math.abs(f.yawRate) * 0.22);

    const surf = opts.surface ?? {};
    f.kind = surf.kind ?? 'dirt';
    f.grip = surf.grip ?? 1;

    FX_CONTACT.frame = f;
    return f;
  }
}

export { HALF_TRACK, REAR_TO_FRONT };
