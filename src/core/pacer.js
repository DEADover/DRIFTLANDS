/**
 * THE FRAME GOVERNOR — WHY THE CAMERA LOOKED JERKY ON A FAST MACHINE
 * ------------------------------------------------------------------
 * The client reported a jerky camera and a game that "feels like it is
 * lagging" on an M-series MacBook Pro. Three previous rounds looked for it in
 * camera.js and in the simulation's accumulator, found real defects there, fixed
 * them, and the complaint did not go away. It did not go away because the cause
 * was never in the maths.
 *
 * MEASURED on the real machine with the real page (tools/frametime.mjs, headed
 * Chromium, real GPU, 3024x1800):
 *
 *     JS per frame     1.4 ms          <- the CPU is asleep
 *     GPU per frame    27.9 ms         <- the GPU is drowning
 *     presented at     39 fps on a display refreshing at 120
 *     vsyncs/frame     1x:21%  2x:73%  3x:6%
 *     cadence change   44% of frames
 *
 * That last line is the whole complaint. A display shows a frame at fixed
 * instants; the only thing a page controls is whether it has one ready in time.
 * At 39 fps on a 120 Hz panel a frame occupies one, two or three refresh
 * intervals depending on where its cost happens to land, so the interval a
 * frame is HELD ON SCREEN for keeps changing — and since the simulation is
 * advanced by the interval that just ELAPSED, the world's apparent speed
 * changes from frame to frame by up to 3x. The eye reads that as stutter no
 * matter how smooth the camera spring is. It is exactly as visible when the
 * average frame rate is high: 39 fps evenly spaced looks calm, 39 fps spaced
 * 8/17/25/8/17 does not.
 *
 * So stop letting the cost decide the cadence. This module picks an integer
 * number of refresh intervals per rendered frame, renders on that grid, and
 * hands the simulation the NOMINAL period rather than the measured one. Even
 * spacing plus a constant dt is what "smooth" actually means. A game that
 * renders a steady 60 on a 120 Hz panel is smooth; one that free-runs at 71 is
 * not, and it is the free-running one that has the better fps counter — which
 * is why chasing the average was the wrong target for three rounds.
 *
 * THE REFRESH PERIOD IS MEASURED, NOT ASSUMED. ProMotion panels vary their
 * refresh rate, an external monitor may be 60, and the browser may not run rAF
 * at the panel rate at all. The estimate is the 5th percentile of recent rAF
 * deltas: when the page is keeping up that is the period, and when the page is
 * behind, every delta is a multiple of the period, so the estimate becomes a
 * multiple of it too. Either way the grid this module renders on stays an exact
 * multiple of a real refresh interval, which is all that evenness requires.
 *
 * WHAT IT ADAPTS, AND IN WHICH ORDER. Smoothness first, then resolution, then
 * frame rate:
 *   - overrunning and above the resolution floor  -> drop resolution a step
 *   - overrunning at the floor                    -> take another vsync (lower fps, still even)
 *   - comfortable headroom for a while            -> give a step back
 * Resolution moves before frame rate because this is a stylized game seen
 * through a full-screen grade, a depth-of-field blur and film grain: 1.5x on a
 * Retina panel is still well above one image pixel per CSS pixel and is very
 * hard to see, whereas a halved frame rate is obvious. Steps are discrete and
 * rate-limited because every change reallocates eight render targets, which is
 * itself a dropped frame.
 */

/** Refresh-period estimate is drawn from this many recent rAF deltas. */
const WINDOW = 180;
/** Discrete resolution ladder, in device pixels per CSS pixel. */
const SCALES = [1.0, 1.25, 1.5, 1.75, 2.0];
/** Never stretch a frame over more refresh intervals than this. */
const MAX_N = 4;
/** Seconds before trying a resolution step that has just failed. Doubles. */
const CLIMB_GAP = 6;
/** Seconds before trying to give back a refresh interval. Doubles. */
const HOLD_GAP = 6;

export class FramePacer {
  /**
   * @param {object} o
   * @param {(scale:number)=>void} [o.onScale]  apply a device-pixel ratio
   * @param {number} [o.baseScale]  the ratio to start at and never exceed
   * @param {number} [o.minScale]   never go below this
   * @param {boolean} [o.adaptScale] set false to pin the resolution
   */
  constructor({ onScale, baseScale = 2, minScale = 1, adaptScale = true } = {}) {
    this.onScale = onScale ?? null;
    this.adaptScale = adaptScale;
    this.ladder = SCALES.filter((s) => s <= baseScale + 1e-6 && s >= minScale - 1e-6);
    if (!this.ladder.length) this.ladder = [baseScale];
    this.scaleIdx = this.ladder.length - 1;

    /** Refresh intervals per rendered frame. 1 = every vsync. */
    this.n = 1;
    /** Estimated refresh period, seconds. Seeded at 60 Hz until measured. */
    this.period = 1 / 60;

    this._raw = new Float32Array(WINDOW);
    this._rawN = 0;
    this._rawI = 0;
    this._lastRaf = -1;
    this._lastRender = -1;
    /** Intervals between RENDERED frames, for the fit test. */
    this._shown = [];
    /** Seconds of real time the simulation still owes, kept bounded. */
    this._debt = 0;
    this._decideAt = 0;
    this._coolUntil = 0;
    this._goodRuns = 0;
    /**
     * Backoff state — see _decide. `_climb*` guards giving resolution back,
     * `_hold*` guards giving frame rate back. Both double on every retreat so
     * a machine that cannot hold the better setting stops being asked.
     */
    this._climbAt = 0;
    this._climbGap = CLIMB_GAP;
    this._holdUntil = 0;
    this._holdGap = HOLD_GAP;
    /** No policy decisions before this time — start-up frames are not evidence. */
    this._settleAt = -1;
    this.stats = { fps: 0, n: 1, scale: this.ladder[this.scaleIdx], period: this.period };
  }

  /** The device-pixel ratio currently asked for. */
  get scale() { return this.ladder[this.scaleIdx]; }

  /**
   * Refresh intervals per frame we are aiming for: the fewest that still keeps
   * us at or below 60 fps. A 120 Hz panel gets 2 (60 fps), a 60 Hz panel gets 1.
   * Sixty is the target rather than "as many as possible" because past it the
   * pixels are worth more than the frames, and because every attempt to hold a
   * rate the machine cannot quite reach is paid for in stutter.
   */
  get targetN() { return Math.max(1, Math.round(1 / (60 * this.period))); }

  /**
   * Call once per requestAnimationFrame.
   * @param {number} nowMs the rAF timestamp
   * @returns {number|null} seconds to simulate and then render, or null to skip
   */
  tick(nowMs) {
    const now = nowMs / 1000;

    // --- refresh period: 5th percentile of recent raw deltas ---------------
    if (this._lastRaf >= 0) {
      const d = now - this._lastRaf;
      // A tab that was backgrounded, or a breakpoint, produces a delta of
      // seconds. It says nothing about the display and must not pollute the
      // estimate.
      if (d > 0.0005 && d < 0.2) {
        this._raw[this._rawI] = d;
        this._rawI = (this._rawI + 1) % WINDOW;
        this._rawN = Math.min(WINDOW, this._rawN + 1);
      }
    }
    this._lastRaf = now;
    if (this._rawN >= 20) {
      const s = Array.prototype.slice.call(this._raw, 0, this._rawN).sort((a, b) => a - b);
      this.period = s[Math.floor(s.length * 0.05)];
    }

    // --- is this one of the frames we render? ------------------------------
    if (this._lastRender < 0) { this._lastRender = now; return this._emit(this.n * this.period); }
    const since = now - this._lastRender;
    // Half a period of slack: rAF timestamps land a hair before or after the
    // ideal instant, and without the slack a frame that arrives 0.2 ms early is
    // pushed a whole interval late, which is the very stutter being removed.
    if (since < this.n * this.period - this.period * 0.5) return null;

    this._shown.push(since);
    if (this._shown.length > 90) this._shown.shift();
    this._lastRender = now;

    // Real time that actually passed, against the time we are about to claim.
    // Kept as bounded debt so a hitch does not make the world jump, and a long
    // run does not drift away from the wall clock either.
    const nominal = this.n * this.period;
    this._debt = Math.max(-0.25, Math.min(0.25, this._debt + (since - nominal)));

    // THE FIRST SECONDS ARE NOT EVIDENCE. Shader programs compile on first use,
    // geometry is still being uploaded, and the title screen is still up: those
    // frames are the most expensive the session will ever produce and they are
    // not what the game costs. Reacting to them rode the resolution ladder to
    // its floor before the first corner. Wait them out.
    if (this._settleAt < 0) this._settleAt = now + 2.5;
    if (now >= this._settleAt && now >= this._decideAt) {
      this._decide(now);
      this._decideAt = now + 0.4;
    }

    // Repay at most a quarter of a frame per frame: the dt handed out stays
    // within [0.75, 1.25] of nominal, so nothing the player sees is jerky even
    // while the clock is being caught up.
    const repay = Math.max(-nominal * 0.25, Math.min(nominal * 0.25, this._debt * 0.2));
    this._debt -= repay;
    return this._emit(nominal + repay);
  }

  _emit(dt) {
    this.stats.n = this.n;
    this.stats.scale = this.scale;
    this.stats.period = this.period;
    this.stats.fps = 1 / (this.n * this.period);
    return Math.max(1 / 480, Math.min(0.05, dt));
  }

  /**
   * Pick the grid and the resolution.
   *
   * THE TRAP THIS AVOIDS, because the first version walked straight into it:
   * once you are pacing, the interval between rendered frames is n*period BY
   * CONSTRUCTION — you made it so. Deriving "how many intervals do we need"
   * from that measurement therefore always answers "exactly the n you already
   * chose", so n can rise on any transient hitch and can never come back down.
   * MEASURED: the governor collapsed to 6 vsyncs per frame — 20 fps — on a
   * machine whose GPU was finishing the frame in 15 ms.
   *
   * A paced loop cannot see its own headroom, so it has to go and look. Every
   * few seconds, if we are not already at full rate, drop a step and watch what
   * happens: if the faster grid holds, keep it and try again sooner; if it does
   * not, step back and wait longer before trying again. The only measurement
   * trusted here is "did the grid we asked for actually hold", which is the one
   * thing the interval can honestly answer.
   *
   * Median, not mean: one 40 ms hitch from a shader compile or a garbage
   * collection must not move the policy.
   */
  _decide(now) {
    if (this._shown.length < 10) return;
    const s = [...this._shown].sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)];
    // HOW MANY FRAMES SPILL, not how long the average one took.
    //
    // Once the loop is pacing, the gap between rendered frames is n*period BY
    // CONSTRUCTION — we are waiting, not working — so the median says only
    // "yes, the waiting worked". It cannot distinguish a frame with 8 ms to
    // spare from one with 0.2 ms. What DOES leak through is the tail: a frame
    // that misses its slot has to wait for the next refresh, so it lands a
    // whole interval late. The fraction of frames doing that is the real
    // headroom signal, and p90 is where it shows up first.
    const p90 = s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
    const grid = this.n * this.period;
    // 1.25 and not 1.0: a frame that lands a few per cent over its grid is
    // noise, and reacting to noise is how a governor starts oscillating.
    const overrun = med > grid * 1.25;
    const target = this.targetN;

    // ---------------------------------------------------------------- behind
    if (overrun) {
      if (this.adaptScale && this.scaleIdx > 0) {
        // Resolution first: it is the cheaper thing to lose and, measured on
        // this scene, by far the larger lever. Props cost about 3.5 ms whatever
        // the resolution; going from 2x to 1x saved 13.5 ms.
        //
        // WAIT, DO NOT SUBSTITUTE. If a resolution change is still cooling
        // down, the right move is to do nothing for another window — the
        // change may not even have taken effect in these measurements yet.
        // Falling through to "take another refresh interval" instead was
        // measured doing real damage: the governor climbed to 1.75x, overran,
        // could not drop back because it was still cooling, halved the frame
        // rate instead, found that comfortable, gave the interval back, overran
        // again — and settled wherever the music stopped. 90% of frames at 3
        // vsyncs while the governor reported it was targeting 2.
        if (now < this._coolUntil) return;
        this.scaleIdx--;
        // Do not immediately try to climb back to the step that just failed.
        // Without this the governor finds the boundary and then oscillates
        // across it forever, and every crossing reallocates eight render
        // targets — the cure becomes the disease.
        this._climbAt = now + this._climbGap;
        this._climbGap = Math.min(60, this._climbGap * 2);
        this._apply(now);
      } else if (this.n < MAX_N) {
        // At the resolution floor and still behind: take another refresh
        // interval. This is the last resort — it halves the frame rate — so it
        // is held for a while before we try to give it back.
        this.n++;
        this._holdUntil = now + this._holdGap;
        this._holdGap = Math.min(40, this._holdGap * 2);
        this._shown.length = 0;
      }
      this._goodRuns = 0;
      return;
    }

    // ------------------------------------------------------- keeping up fine
    //
    // NOTE THE ASYMMETRY, AND IT IS DELIBERATE. Once we are pacing, the gap
    // between rendered frames is n*period BY CONSTRUCTION — we are waiting, not
    // working — so "not overrunning" says nothing about how much headroom
    // there is. The only way to find out is to ask for more and see whether it
    // holds, which is what both branches below do. Each retreat doubles its own
    // backoff so a machine that genuinely cannot hold the better setting is
    // asked less and less often.
    if (this.n > target && now >= this._holdUntil) {
      this.n--;
      this._shown.length = 0;
      return;
    }

    // Nine frames in ten landing exactly on the grid. Anything less and we are
    // already living on the edge of this setting, so asking for more would only
    // buy an overrun and the hitch of changing back.
    const comfortable = p90 <= grid * 1.05;

    if (this.n <= target && this.adaptScale && this.scaleIdx < this.ladder.length - 1
        && now >= this._coolUntil && now >= this._climbAt && comfortable) {
      // Four consecutive comfortable windows, ~1.6 s. Brisk on purpose: the
      // first seconds of a session are the most expensive it will ever be, and
      // the governor should not spend the rest of the race paying for them.
      if (++this._goodRuns >= 4) { this._goodRuns = 0; this.scaleIdx++; this._apply(now); }
      return;
    }

    // AND ONLY THEN, THE FRAME RATE ABOVE THE TARGET.
    //
    // 60 is the target rather than "as fast as the panel goes" because past it
    // the pixels are worth more than the frames — a 120 Hz panel showing a
    // half-resolution 120 fps is a worse picture than the same panel showing a
    // full-resolution 60. But if the resolution ladder is already at its
    // ceiling and frames are still landing comfortably, there is nothing left
    // to spend the headroom on, and a high-refresh display should get to use
    // it. Same backoff as everything else: one failure and it stops asking for
    // twice as long.
    if (this.n > 1 && this.scaleIdx === this.ladder.length - 1
        && comfortable && now >= this._holdUntil && now >= this._coolUntil) {
      if (++this._goodRuns >= 6) { this._goodRuns = 0; this.n--; this._shown.length = 0; }
      return;
    }
    this._goodRuns = 0;
  }

  _apply(now) {
    // Reallocating the render targets costs a frame; do not let the policy
    // react to that frame, and do not touch resolution again for a second.
    this._coolUntil = now + 1.0;
    this._shown.length = 0;
    this._goodRuns = 0;
    this.onScale?.(this.scale);
  }
}
