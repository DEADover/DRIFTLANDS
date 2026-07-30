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
 * FRAMING DOCTRINE: the car is not the subject, the road ahead is. The focus
 * point is bounded in NORMALISED DEVICE COORDINATES rather than in metres (see
 * `_clampOffset`), so `frameY` and `frameX` say where on screen the car is
 * allowed to sit and the velocity lead pushes it there. Measured over 90 s of
 * route autopilot, that took the road inside the frustum at 34 m/s from
 * 42.8 m ahead / 45.5 m behind to 60.8 / 24.1 — from 0.94:1 to 2.53:1.
 *
 * Note what is NOT the lever. Biasing the car DOWN the frame is not the same
 * request: the frame is world-fixed, so "down the frame" is a fixed compass
 * direction, and for half the route it points at the road already driven. The
 * lead is car-relative and always points up the road, which is why it is the
 * only one of the four candidates that moves the ahead:behind number. Pitch and
 * distance grow the frame ahead AND behind by the same factor and move the
 * ratio not at all.
 *
 * MOTION DOCTRINE: unhurried. The focus point rides a critically-damped spring,
 * not a lerp, so it never snaps and never overshoots; the velocity lead and the
 * drift push are smoothed on their own, slower constants so a flick of the
 * wheel does not shove the frame. The frame is world-fixed: it must NOT rotate
 * with the car.
 */

/**
 * THE RENDER CLOCK — a deterministic, shared "how long has the world been
 * running" that the render layer can read without asking the game for it.
 *
 * post.js needs a time to drift cloud shadows across the ground and sky.js needs
 * one to drift the cloud forms. Neither may use `performance.now()`: the
 * screenshot harness runs a fixed number of FIXED-STEP frames and then grabs a
 * frame, so a wall-clock time would make every shot a different picture and
 * every A/B comparison meaningless. It also may not read the game's own
 * `simTime`, which lives in game.js.
 *
 * ChaseCamera.update is called exactly once per simulated frame with the frame's
 * dt, so accumulating there gives the same number the sim has, from a file the
 * render layer owns. `?t=` in the harness lands on an exact multiple of the
 * fixed step, so `shots/seq` frames are reproducible to the pixel.
 */
export const RENDER_CLOCK = { t: 0 };

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
    //
    // Above about 12 m/s these two are NOT the binding constraint any more —
    // frameY/frameX below are, because 1.75 s of lead is 60 m and the frame can
    // only hold ~16 m of it. They still set the framing at walking pace, where
    // the frame is meant to stay poster-centred, and they set how quickly the
    // frame slides forward as the car gets going.
    this.lookAhead = 0.75;        // at a standstill / low speed
    this.lookAheadFast = 1.75;    // fully applied at `leadFullSpeed`
    // WHERE THE CAR SITS IN FRAME — the client's note, as a number.
    //
    // MEASURED (tools/camera-test.mjs, 90 s of route autopilot at 1/120):
    // the baseline put the car at ndcY +0.026, i.e. dead centre, and showed
    // 42.8 m of road ahead against 45.5 m behind at 34 m/s — a ratio of 0.94,
    // MORE of the road already driven than of the road to come. That is exactly
    // what the client wrote down.
    //
    // These two bound how far the SPRING'S TARGET may sit from the car, in
    // normalised device coordinates. At speed the look-ahead saturates them, so
    // they are the framing: the car settles about 0.42 of a half-frame below
    // centre when it drives up the frame, and 0.52 of a half-frame to the side
    // when it drives across it. Result, measured over the same 90 s: at 34 m/s
    // 63.2 m of road ahead against 20.2 m behind, 3.12:1, from 0.94:1.
    //
    // 0.42/0.52 and not more. Pushed to 0.58/0.70 with the old hard clamp the
    // metres stopped moving entirely (60.6 ahead against 60.8) while the car
    // went to 86% of the way to the frame edge — past this the extra offset
    // buys frame the road has already left. 3:1 is also as far as this should
    // go for a reason that is not measurable: at 4:1 the dust plume, the skid
    // marks and the corner you just took are all out of shot, and a top-down
    // rally game where you cannot see what you just did is missing half of it.
    this.frameY = 0.42;
    this.frameX = 0.52;
    // The emergency leash, applied to the spring's OUTPUT. It must stay well
    // clear of the framing box, because a positional constraint that engages on
    // ordinary frames sawtooths: MEASURED, the worst frame-to-frame focus
    // acceleration on shake-free frames is 0.00400 m/frame^2 for the baseline
    // camera, 0.261 with the framing enforced as a hard clamp, 0.084 with this
    // box at 0.78/0.86 (still catching normal corners), and 0.00677 here, where
    // it only ever catches a spin or a shunt. The car still cannot leave the
    // frame: 0.93 of a half-frame plus the car's ~0.03 of half-width is 0.96,
    // and the 8-corner test measures 0 clipped frames in 10800.
    this.reachY = 0.86;
    this.reachX = 0.93;
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
    this._before = new THREE.Vector3();
    this._velS = new THREE.Vector3();     // eased velocity, for the lag feed-forward
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
   * Clamp a ground-plane focus offset so that the CAR lands inside a box in
   * normalised device coordinates. Mutates and returns `off` (y is ignored).
   *
   * The camera's ground frame at heading `yaw`: it stands at
   * focus + (cos yaw, ., sin yaw) * horiz, so the direction AWAY from the
   * camera — up the screen — is U = (-cos yaw, -sin yaw), and the camera's
   * right is R = (sin yaw, -cos yaw). Writing the offset as fz along U and fx
   * along R, and putting the car and the focus at the same ground height (which
   * is what game.js hands us), the projection is exactly
   *
   *     depth = d - fz*cos(pitch)          (view-space depth of the car)
   *     ndcY  = -fz*sin(pitch) / (depth * ty)
   *     ndcX  = -fx            / (depth * ty * aspect)      ty = tan(fov/2)
   *
   * Inverting ndcY for the limit gives the two bounds on fz — they are NOT
   * symmetric, because the near edge of the frame is closer to the focus than
   * the far edge is. fx is then bounded at the depth fz leaves us at.
   */
  _clampOffset(off, d, yaw, limY, limX) {
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    const ty = Math.tan((this.camera.fov * Math.PI) / 360);
    const ux = -Math.cos(yaw), uz = -Math.sin(yaw);
    const rx = Math.sin(yaw), rz = -Math.cos(yaw);
    let fz = off.x * ux + off.z * uz;
    let fx = off.x * rx + off.z * rz;

    const fzMax = (limY * d * ty) / (sp + limY * ty * cp);          // car pushed DOWN the frame
    const fzMin = (limY * d * ty) / (limY * ty * cp - sp);          // negative: car pushed UP
    fz = Math.min(fzMax, Math.max(fzMin, fz));

    const depth = Math.max(1, d - fz * cp);
    const fxMax = limX * depth * ty * this.camera.aspect;
    fx = Math.min(fxMax, Math.max(-fxMax, fx));

    off.set(ux * fz + rx * fx, 0, uz * fz + rz * fx);
    return off;
  }

  /**
   * @param {{position: THREE.Vector3, velocity: THREE.Vector3, heading: number, lateralSlip: number}} car
   */
  update(dt, car, opts = {}) {
    const speed = car.velocity.length();
    const step = Math.min(dt, 1 / 30);
    RENDER_CLOCK.t += step;

    // The zoom-out has to be known BEFORE anything is clamped against the frame.
    // This block used to sit at the bottom, and both clamps below were written
    // against `this.distance` — the BASE 78 — while the camera at speed is
    // actually 110 m out. The frame they were protecting was 30% smaller than
    // the real one, so the look-ahead was cut to 14.4 m at every speed. That
    // single line is most of why the client sees the car in the middle of the
    // frame: at 34 m/s the spring's own lag (2v/omega, ~20 m) is larger than
    // the lead the clamp allowed, so the net offset was about zero.
    // Ease the speed that drives the zoom, not the zoom itself: distance then
    // moves on a signal that has no steps in it, whatever the physics does.
    const sN = Math.min(speed / 42, 1);
    this._speedEase = this._speedEase === undefined
      ? sN
      : this._speedEase + (sN - this._speedEase) * (1 - Math.exp(-this.speedEase * dt));
    const distance = this.distance * (1 + this._speedEase * this.speedWiden) * (opts.zoom ?? 1);
    const yaw = this.yaw + this.followYaw * car.heading;

    // Lead the car by where it is going — but let the lead itself ease in, so
    // stabs of throttle or a spin do not jolt the frame.
    const leadN = Math.min(speed / this.leadFullSpeed, 1);
    const lead = this.lookAhead + (this.lookAheadFast - this.lookAhead) * (leadN * leadN);
    this._tmp.set(car.velocity.x * lead, 0, car.velocity.z * lead);
    this._lead.lerp(this._tmp, 1 - Math.exp(-this.leadSmooth * step));

    // Push the frame sideways when sliding so the drift has room to breathe.
    const slip = THREE.MathUtils.clamp(car.lateralSlip ?? 0, -1, 1);
    this._push += (slip - this._push) * (1 - Math.exp(-this.driftSmooth * step));

    this._tmp.copy(this._lead);
    if (this.driftPush) {
      const side = Math.sin(car.heading), fwd = Math.cos(car.heading);
      const push = this._push * this.driftPush * 15;
      this._tmp.x += fwd * push;
      this._tmp.z -= side * push;
    }
    // THE FRAMING, applied to the spring's TARGET rather than to its output.
    //
    // Clamping the final focus every frame was tried first and measured: the
    // constraint went active and inactive on alternate frames and the focus
    // sawtoothed, taking the worst frame-to-frame acceleration of the focus
    // point from 0.004 to 0.261 m/frame^2 on shake-free frames — a 65x jerk
    // regression, invisible in the framing numbers and very visible on screen.
    // Frame the TARGET instead and the spring keeps doing what it is for.
    this._clampOffset(this._tmp, distance, yaw, this.frameY, this.frameX);
    this._desiredFocus.copy(car.position).add(this._tmp);

    // ...and cancel the spring's own lag, or the framing above is a lie.
    // A critically damped spring tracking a target that moves at V settles a
    // fixed distance BEHIND it: x'' = 0 and x' = V give w^2*e = 2*w*V, so
    // e = 2V/w. At 34 m/s and stiffness 3.4 that is 20 m — larger than the
    // whole offset the frame can hold, which is why the baseline camera framed
    // the car dead centre no matter what the look-ahead asked for. Feeding the
    // target forward by exactly 2V/w cancels it, and the eased velocity is used
    // rather than the raw one so a collision cannot inject a step.
    this._velS.lerp(car.velocity, 1 - Math.exp(-this.leadSmooth * step));
    this._desiredFocus.addScaledVector(this._velS, 2 / this.stiffness);

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

    // THE HARD LEASH — the car may never leave the frame.
    //
    // The old leash was one radius in metres, applied in every direction alike.
    // That is the wrong shape twice over. The frame's footprint on the ground at
    // pitch 52 / fov 26 is 86 m across but only 63 m deep, and the two halves of
    // that depth are not equal either (37 m up-screen, 26 m down). One circle
    // cannot describe it: it strangles a sideways offset, where there is 43 m of
    // room, and it does not know that pushing the car DOWN the frame runs out at
    // 26 m. So do it exactly instead. For a focus offset (fx across, fz up the
    // frame) at camera distance d, the car projects to
    //
    //     ndcY = -fz*sin(pitch) / ((d - fz*cos(pitch)) * tan(fov/2))
    //     ndcX = -fx           / ((d - fz*cos(pitch)) * tan(fov/2) * aspect)
    //
    // which is exact for a car and a focus at the same ground height — which is
    // what game.js passes us. Inverting it gives a clamp in the units that
    // matter: WHERE ON SCREEN THE CAR IS. `frameY` is then not a leash length,
    // it is a guarantee in the units the guarantee is written in, and it holds
    // at any distance, FOV, aspect or zoom because a half-frame is a half-frame.
    //
    // This is the EMERGENCY box (reachY/reachX), not the framing box. The
    // framing is already done, above, on the spring's target; this only has to
    // catch a spin, a collision or a respawn — the case the previous round
    // measured at 97 off-screen frames in 3600. Keeping it wider than the
    // framing means it almost never fires, which is what keeps it smooth.
    //
    // When it does fire, project out only the velocity component pushing
    // further out of bounds rather than scaling the whole vector: scaling also
    // bleeds the velocity ALONG the constraint, which buzzes.
    this._tmp.copy(this._focus).sub(car.position);
    this._tmp.y = 0;
    this._before.copy(this._tmp);
    this._clampOffset(this._tmp, distance, yaw, this.reachY, this.reachX);
    if (!this._tmp.equals(this._before)) {
      this._focus.set(car.position.x + this._tmp.x, this._focus.y, car.position.z + this._tmp.z);
      // outward direction of the violation; kill only the velocity along it
      this._before.sub(this._tmp);
      const n = this._before.length();
      if (n > 1e-6) {
        this._before.multiplyScalar(1 / n);
        const along = this._focusVel.dot(this._before);
        if (along > 0) this._focusVel.addScaledVector(this._before, -along);
      }
    }

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
      // RENDER_CLOCK, not performance.now(). The clock at the top of this file
      // exists precisely so the render layer has a deterministic time, and the
      // shake was the one thing in here still reading the wall clock — which
      // made every screenshot after an impact a different picture, and made the
      // camera's own smoothness unmeasurable: two identical 10800-frame runs
      // of tools/camera-test.mjs disagreed on the worst per-frame yaw change by
      // 0.577 vs 0.686 deg purely because the shake landed on different phases.
      const t = RENDER_CLOCK.t;
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
