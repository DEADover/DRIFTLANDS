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
 *   distance set so the car occupies ~3-5% of frame width.
 */
export class ChaseCamera {
  constructor(aspect) {
    this.baseFov = 26;
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 1, 3000);

    // --- tuning ---
    this.pitch = THREE.MathUtils.degToRad(61);
    // Calibrated against the reference: the car should read at ~3.5-4.5% of
    // frame width. At fov 26 that lands around here.
    this.distance = 178;
    this.height = 0;              // extra vertical offset beyond pitch
    this.yaw = Math.PI * 0.25;    // world-fixed heading (art of rally does NOT spin with the car)
    this.followYaw = 0.0;         // 0 = fully world-fixed, 1 = fully car-relative
    this.lookAhead = 0.55;        // seconds of velocity to lead the car by
    this.smoothing = 6.0;         // position lerp rate
    this.driftPush = 0.35;        // slide the frame toward the drift direction

    this._pos = new THREE.Vector3();
    this._focus = new THREE.Vector3();
    this._desiredFocus = new THREE.Vector3();
    this._shake = new THREE.Vector3();
    this.shakeAmount = 0;
    this._initialised = false;
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

    // Focus point: the car, led by where it is going.
    this._desiredFocus.copy(car.position);
    this._desiredFocus.x += car.velocity.x * this.lookAhead;
    this._desiredFocus.z += car.velocity.z * this.lookAhead;

    // Push the frame sideways when sliding so the drift has room to breathe.
    if (this.driftPush) {
      const side = Math.sin(car.heading), fwd = Math.cos(car.heading);
      const push = THREE.MathUtils.clamp(car.lateralSlip ?? 0, -1, 1) * this.driftPush * 14;
      this._desiredFocus.x += fwd * push;
      this._desiredFocus.z -= side * push;
    }

    if (!this._initialised) {
      this._focus.copy(this._desiredFocus);
      this._initialised = true;
    }
    const k = 1 - Math.exp(-this.smoothing * dt);
    this._focus.lerp(this._desiredFocus, k);

    // Speed widens the frame slightly — reads as acceleration.
    const distance = this.distance * (1 + Math.min(speed / 60, 1) * 0.14) * (opts.zoom ?? 1);

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
  }

  /** Instantly place the camera (capture mode — no smoothing artefacts). */
  snap(car) {
    this._initialised = false;
    this.update(1 / 60, car);
  }
}
