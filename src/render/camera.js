import * as THREE from 'three';

/**
 * THE 2.5D CAMERA.
 *
 * Reference (art of rally): a high, steeply-tilted view with a narrow FOV so
 * the world reads almost orthographic — parallel-looking, poster-like, the car
 * small in a big landscape. Tops of trees dominate; you see just enough of the
 * sides of objects to read their height.
 *
 * Tunables that matter most, in order:
 *   pitch    ~58-66 deg from horizontal (0 = side-on, 90 = straight down)
 *   fov      20-32 deg. Lower = flatter/more orthographic/more "poster".
 *   distance set so the car occupies ~3.5-4.5% of frame width.
 *
 * CALIBRATION (measured, not guessed): at fov 26 / 16:9, distance 136 puts the
 * car at ~3.8% of frame width in `hero_alpine` — measured off the actual PNG.
 * Do not change `distance` without re-measuring.
 *
 * MOTION DOCTRINE: unhurried. The focus point rides a critically-damped spring,
 * not a lerp, so it never snaps and never overshoots; the velocity lead and the
 * drift push are smoothed on their own, slower constants so a flick of the
 * wheel does not shove the frame. The frame is world-fixed: it must NOT rotate
 * with the car.
 */
export class ChaseCamera {
  constructor(aspect) {
    this.baseFov = 26;
    // Near/far kept tight: post.js reconstructs view-space position from the
    // depth buffer, and precision there is worth more than headroom.
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 24, 1900);

    // --- tuning ---
    this.pitch = THREE.MathUtils.degToRad(61);
    this.distance = 136;
    this.height = 0;              // extra vertical offset beyond pitch
    this.yaw = Math.PI * 0.25;    // world-fixed heading (art of rally does NOT spin with the car)
    this.followYaw = 0.0;         // 0 = fully world-fixed, 1 = fully car-relative
    this.lookAhead = 0.62;        // seconds of velocity to lead the car by
    this.leadSmooth = 2.2;        // how lazily the lead itself responds
    this.stiffness = 3.4;         // spring omega for the focus point (low = poster-like)
    this.driftPush = 0.40;        // slide the frame toward the drift direction
    this.driftSmooth = 2.6;
    this.speedWiden = 0.14;       // extra distance at speed

    this._pos = new THREE.Vector3();
    this._focus = new THREE.Vector3();
    this._focusVel = new THREE.Vector3();
    this._desiredFocus = new THREE.Vector3();
    this._lead = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._shake = new THREE.Vector3();
    this._push = 0;
    this.shakeAmount = 0;
    this._initialised = false;
    this.camera.userData.focusDistance = this.distance;
  }

  setAspect(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  addShake(amount) {
    this.shakeAmount = Math.min(1.2, this.shakeAmount + amount);
  }

  /**
   * @param {{position: THREE.Vector3, velocity: THREE.Vector3, heading: number, lateralSlip: number}} car
   */
  update(dt, car, opts = {}) {
    const speed = car.velocity.length();
    const step = Math.min(dt, 1 / 30);

    // Lead the car by where it is going — but let the lead itself ease in, so
    // stabs of throttle or a spin do not jolt the frame.
    this._tmp.set(car.velocity.x * this.lookAhead, 0, car.velocity.z * this.lookAhead);
    this._lead.lerp(this._tmp, 1 - Math.exp(-this.leadSmooth * step));

    // Push the frame sideways when sliding so the drift has room to breathe.
    const slip = THREE.MathUtils.clamp(car.lateralSlip ?? 0, -1, 1);
    this._push += (slip - this._push) * (1 - Math.exp(-this.driftSmooth * step));

    this._desiredFocus.copy(car.position).add(this._lead);
    if (this.driftPush) {
      const side = Math.sin(car.heading), fwd = Math.cos(car.heading);
      const push = this._push * this.driftPush * 15;
      this._desiredFocus.x += fwd * push;
      this._desiredFocus.z -= side * push;
    }

    if (!this._initialised) {
      this._focus.copy(this._desiredFocus);
      this._focusVel.set(0, 0, 0);
      this._initialised = true;
    }

    // Critically damped spring — semi-implicit Euler, unconditionally stable
    // at our step sizes and free of the "rubber band" feel of a raw lerp.
    const w = this.stiffness;
    const k = w * w, c = 2 * w;
    this._tmp.copy(this._desiredFocus).sub(this._focus).multiplyScalar(k)
      .addScaledVector(this._focusVel, -c);
    this._focusVel.addScaledVector(this._tmp, step);
    this._focus.addScaledVector(this._focusVel, step);

    // Speed widens the frame slightly — reads as acceleration.
    const distance = this.distance * (1 + Math.min(speed / 60, 1) * this.speedWiden) * (opts.zoom ?? 1);

    // FOV punch, driven by the feel layer.
    const fov = this.baseFov + (opts.fovBoost ?? 0);
    if (Math.abs(this.camera.fov - fov) > 0.001) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    const yaw = this.yaw + this.followYaw * car.heading;
    const horiz = Math.cos(this.pitch) * distance;
    const vert = Math.sin(this.pitch) * distance;

    this._pos.set(
      this._focus.x + Math.cos(yaw) * horiz,
      this._focus.y + vert + this.height,
      this._focus.z + Math.sin(yaw) * horiz
    );

    // Trauma-based shake: squared falloff feels punchier than linear.
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 1.8);
    const s = this.shakeAmount * this.shakeAmount;
    if (s > 0.0001) {
      const t = performance.now() * 0.001;
      this._shake.set(
        Math.sin(t * 47.3) * s * 1.6,
        Math.sin(t * 39.1 + 2.1) * s * 1.2,
        Math.sin(t * 43.7 + 4.3) * s * 1.6
      );
      this._pos.add(this._shake);
    }

    this.camera.position.copy(this._pos);
    this.camera.lookAt(this._focus);
    this.camera.updateMatrixWorld();

    // Published for post.js: everything past this is "the distance", and that
    // is the only thing depth of field is allowed to touch.
    this.camera.userData.focusDistance = distance;
  }

  /** Instantly place the camera (capture mode — no smoothing artefacts). */
  snap(car) {
    this._initialised = false;
    this.update(1 / 60, car);
  }
}
