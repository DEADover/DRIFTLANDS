import * as THREE from 'three';

/**
 * THE 2.5D CAMERA.
 *
 * The client targets (ref/target_01..08), NOT art of rally, set this now. They
 * are closer and less steep: you can read a bridge's pylons, the sides of a
 * conifer, the flank of a boulder. Real perspective recession, never
 * orthographic. Still world-fixed — the frame does not rotate with the car.
 *
 * MEASURED FROM ref/target_01 AND CONFIRMED IN OUR OWN FRAMES:
 *   car width  4.5-5.5% of frame width
 *   tilt       48-55 deg from horizontal
 *   horizon    NOT IN FRAME — ground fills the picture edge to edge
 *
 * CALIBRATION — `node tools/probe.mjs hero_alpine` projects the car's actual
 * vertex cloud through the live capture-time camera and prints its NDC box.
 * Do not eyeball this; run the probe.
 *
 *   round 2, distance 90: car read 4.40% of frame width — UNDER the band.
 *   round 3, distance 78: car reads 5.08%. That is where it sits now.
 *
 * Frame width at the focus point is 2*tan(fovx/2)*distance, so the car's share
 * is inversely proportional to distance. Re-run the probe if you touch fov,
 * aspect or speedWiden.
 *
 * RECESSION is independent of distance — it is sin(pitch+fovY/2)/sin(pitch-fovY/2)
 * only. At pitch 52 / fov 29 that is 1.51x, i.e. the top of frame is half again
 * as deep as the bottom. Measured the same ratio off target_01 by comparing
 * conifer heights in the top and bottom eighths of the frame (175px vs 230px
 * over three quarters of the frame height), so pitch and fov are RIGHT and the
 * only framing error was scale. Do not widen the lens to "get more perspective":
 * it would overshoot the reference and turn the diorama into a fisheye.
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
    // Near pulled in from 24 now that the camera sits at distance 78: a hillside
    // rising toward the lens must not clip. Far is still tight because post.js
    // reconstructs view-space position from this depth buffer.
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 14, 1500);

    // --- tuning ---
    this.pitch = THREE.MathUtils.degToRad(52);
    this.distance = 78;
    this.height = 0;              // extra vertical offset beyond pitch
    this.yaw = Math.PI * 0.25;    // world-fixed heading (art of rally does NOT spin with the car)
    this.followYaw = 0.0;         // 0 = fully world-fixed, 1 = fully car-relative
    // Seconds of velocity to lead the car by. This is what decides how much of
    // the frame is ROAD AHEAD versus road already driven. At 0.62 s the lead is
    // only ~19 m at speed, against an ~88 m frame, so the car sat near the
    // middle and most of the picture was the past. It now grows with speed:
    // the faster you go, the further the frame slides ahead and the more of the
    // coming corner you can read.
    this.lookAhead = 0.75;        // at a standstill / low speed
    this.lookAheadFast = 1.75;    // fully applied at `leadFullSpeed`
    this.leadFullSpeed = 34;      // m/s at which the fast lead is reached
    this.leadSmooth = 1.5;        // how lazily the lead itself responds
    // Back to 3.4 deliberately. A softer focus spring lags the target more the
    // faster you go — about 24 m at speed — which silently ate most of the
    // increased look-ahead. Smoothness now comes from leadSmooth, driftSmooth
    // and the eased speed signal instead, none of which fight the lead.
    this.stiffness = 3.4;         // spring omega for the focus point (low = poster-like)
    this.driftPush = 0.40;        // slide the frame toward the drift direction
    this.driftSmooth = 1.8;
    // The client asked for a calmer camera that breathes back further as speed
    // builds. 0.14 was barely perceptible; 0.42 is a real pull-back that also
    // gives you more warning of what is coming. It is applied through a
    // SMOOTHED speed (see _speedEase) so a stab of throttle or a collision
    // cannot yank the frame.
    this.speedWiden = 0.42;
    this.speedEase = 0.9;         // how slowly the zoom itself reacts, 1/s

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

  /** Drop all accumulated trauma — used on respawn so a crash cannot follow you. */
  calmShake() { this.shakeAmount = 0; this._fovApplied = undefined; }

  addShake(amount) {
    this.shakeAmount = Math.min(0.55, this.shakeAmount + amount);
  }

  /**
   * @param {{position: THREE.Vector3, velocity: THREE.Vector3, heading: number, lateralSlip: number}} car
   */
  update(dt, car, opts = {}) {
    const speed = car.velocity.length();
    const step = Math.min(dt, 1 / 30);

    // Lead the car by where it is going — but let the lead itself ease in, so
    // stabs of throttle or a spin do not jolt the frame.
    const leadN = Math.min(speed / this.leadFullSpeed, 1);
    const lead = this.lookAhead + (this.lookAheadFast - this.lookAhead) * (leadN * leadN);
    // Clamp the lead to a fraction of what the frame actually covers, so a fast
    // straight or a tight corner can never push the car off the edge.
    const vFovR = (this.camera.fov * Math.PI) / 180;
    const halfFrame = this.distance * Math.tan(vFovR / 2) * this.camera.aspect;
    const leadDist = Math.min(speed * lead, Math.max(8, halfFrame * 0.45));
    const leadScale = speed > 0.01 ? leadDist / speed : 0;
    this._tmp.set(car.velocity.x * leadScale, 0, car.velocity.z * leadScale);
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

    // HARD LEASH — the car may never leave the frame.
    //
    // Clamping the look-ahead was not enough: the focus spring itself lags, and
    // on a tight corner at speed the car outran the camera. Measured over a
    // 30 s drive, the car was off-screen for 97 of 3600 frames.
    //
    // So bound the FINAL focus offset from the car, whatever the spring did. The
    // leash length is derived from what the frame actually covers, so it holds
    // at any distance or FOV. Bleeding the spring velocity at the same time
    // stops it fighting the clamp and buzzing against it.
    const vFovL = (this.camera.fov * Math.PI) / 180;
    const halfW = this.distance * Math.tan(vFovL / 2) * this.camera.aspect;
    const leash = Math.max(10, halfW * 0.52);
    this._tmp.copy(this._focus).sub(car.position);
    this._tmp.y = 0;
    const off = this._tmp.length();
    if (off > leash) {
      this._tmp.multiplyScalar(leash / off);
      this._focus.set(car.position.x + this._tmp.x, this._focus.y, car.position.z + this._tmp.z);
      this._focusVel.multiplyScalar(0.6);
    }

    // Speed widens the frame slightly — reads as acceleration.
    // Ease the speed that drives the zoom, not the zoom itself: distance then
    // moves on a signal that has no steps in it, whatever the physics does.
    const sN = Math.min(speed / 42, 1);
    this._speedEase = this._speedEase === undefined
      ? sN
      : this._speedEase + (sN - this._speedEase) * (1 - Math.exp(-this.speedEase * dt));
    const distance = this.distance * (1 + this._speedEase * this.speedWiden) * (opts.zoom ?? 1);

    // FOV punch, driven by the feel layer.
    const fovWant = this.baseFov + (opts.fovBoost ?? 0);
    if (this._fovApplied === undefined) this._fovApplied = fovWant;
    // Degrees per second the FOV may move. 1.74 deg in one frame at 120 Hz is
    // 209 deg/s; 9 deg/s turns the same punch into a 0.2 s swell you read as
    // weight instead of a snap.
    const FOV_RATE = 9;
    const dFov = THREE.MathUtils.clamp(fovWant - this._fovApplied, -FOV_RATE * step, FOV_RATE * step);
    this._fovApplied += dFov;
    if (Math.abs(this.camera.fov - this._fovApplied) > 0.002) {
      this.camera.fov = this._fovApplied;
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
