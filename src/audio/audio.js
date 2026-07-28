/**
 * AUDIO — owned by the audio builder.
 *
 * Procedural only (WebAudio oscillators/noise). No asset files: everything is
 * synthesised so the project stays self-contained.
 *
 * CONTRACT:
 *   createAudio() -> {
 *     start() -> Promise<void>     must be called from a user gesture
 *     update(dt, state) -> void
 *     event(name, payload) -> void
 *     setEnabled(on) -> void
 *     started: boolean
 *   }
 *
 * state = { vehicle, surface, onRoad }
 *
 * MUST be inert in capture mode (no AudioContext) so screenshots never stall.
 * createAudio() runs before the Game knows it is capturing, so the guard sits
 * in start() — and start() is the ONLY place a context is ever constructed.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN HERE
 *
 * engine   a five-oscillator stack locked to a fundamental derived from rpm,
 *          with a detuned pair for beating, a sub for lump, an upper saw and a
 *          third-harmonic peak that only opens up under load. Cutoff tracks
 *          rpm AND load, a waveshaper hardens the rasp as load rises, and the
 *          whole thing ducks and chuffs on a gear change. Off throttle it goes
 *          dark and starts crackling on overrun.
 * tyres    a resonant squeal triad whose pitch and gain follow slip angle,
 *          gated by surface (tarmac screams, snow does not).
 * road     one noise source fanned into four filtered buses — gravel rattle,
 *          snow hiss, tarmac hum, bridge boom — crossfaded by surface and
 *          scaled by speed.
 * wind     bandpassed noise that opens and rises with speed.
 * impacts  a pitch-dropping sine thud + a panel ring + a debris burst.
 * payout   a rising whoosh and an arpeggiated chime when a drift chain lands.
 *
 * The load signal is INFERRED, because the audio module is not handed the
 * input struct: rising rpm plus positive acceleration means throttle, falling
 * rpm at speed means overrun. That is enough to sell it.
 */

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** True in the screenshot harness. Checked before an AudioContext can exist. */
function isCaptureMode() {
  try {
    if (typeof window === 'undefined') return true;
    if (window.__GAME && window.__GAME.capture === true) return true;
    if (new URLSearchParams(window.location.search).get('shot')) return true;
    if (typeof window.AudioContext !== 'function' &&
        typeof window.webkitAudioContext !== 'function') return true;
  } catch {
    return true;
  }
  return false;
}

/** Deterministic PRNG so crackle and debris never reach for Math.random. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function createAudio() {
  return new Audio();
}

class Audio {
  constructor() {
    this.started = false;
    this.enabled = true;
    this.ctx = null;
    this.rand = rng(0x51f3a7);

    // smoothed control signals
    this.rpm = 0.1;
    this.load = 0;
    this.overrun = 0;
    this.squeal = 0;
    this.lastSpeed = 0;
    this.lastRpm = 0.1;
    this.lastGear = 1;
    this.nextCrackle = 0;
    this.shiftUntil = 0;
    this.time = 0;
    this._failed = false;
  }

  // ---------------------------------------------------------------- lifecycle
  async start() {
    if (this.started || this._failed) return;
    if (isCaptureMode()) return;                 // never build a graph in capture
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this._build();
      if (ctx.state === 'suspended') await ctx.resume();
      this.started = true;
      window.addEventListener('keydown', (e) => {
        if (e.code === 'KeyN') this.setEnabled(!this.enabled);
      });
    } catch (err) {
      this._failed = true;
      this.ctx = null;
      console.warn('[audio] disabled:', err);
    }
  }

  setEnabled(on) {
    this.enabled = !!on;
    try {
      this.master?.gain.setTargetAtTime(this.enabled ? 1 : 0, this.ctx.currentTime, 0.05);
    } catch { /* never throw */ }
  }

  // ------------------------------------------------------------- graph set-up
  _build() {
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // ---- master bus: gentle glue compression, then out ---------------------
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 26;
    comp.ratio.value = 4.5;
    comp.attack.value = 0.004;
    comp.release.value = 0.16;
    const out = ctx.createGain();
    out.gain.value = 1.05;
    this.out = out;                              // exposed for tools/audiocheck
    this.master.connect(comp).connect(out).connect(ctx.destination);

    // ---- shared noise source ----------------------------------------------
    this.noiseBuf = this._makeNoise(3.0);
    this.noise = ctx.createBufferSource();
    this.noise.buffer = this.noiseBuf;
    this.noise.loop = true;

    // ================================================================= ENGINE
    // Signal order matters: partials -> DRIVE (timbre) -> shaper -> filters ->
    // LEVEL (loudness) -> master. Driving the shaper harder must change the
    // rasp, not the volume, so the level control lives after it.
    const eng = ctx.createGain();
    eng.gain.value = 0.7;
    this.engDrive = eng;

    // Rasp: a waveshaper whose curve is swapped between 8 precomputed
    // hardnesses, so no Float32Array is ever built inside the frame loop.
    this.curves = [];
    for (let i = 0; i < 8; i++) this.curves.push(makeDriveCurve(0.06 + i * 0.42));
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = this.curves[0];
    this.shaper.oversample = '2x';
    this.curveIdx = 0;

    this.engLP = ctx.createBiquadFilter();
    this.engLP.type = 'lowpass';
    this.engLP.frequency.value = 500;
    this.engLP.Q.value = 0.9;

    this.engPeak = ctx.createBiquadFilter();   // the bite that opens under load
    this.engPeak.type = 'peaking';
    this.engPeak.frequency.value = 430;
    this.engPeak.Q.value = 1.5;
    this.engPeak.gain.value = 0;

    const engHP = ctx.createBiquadFilter();
    engHP.type = 'highpass';
    engHP.frequency.value = 34;

    this.engLevel = ctx.createGain();
    this.engLevel.gain.value = 0;
    this.engBus = this.engLevel;                // exposed for tools/audiocheck

    eng.connect(this.shaper).connect(this.engLP).connect(this.engPeak)
       .connect(engHP).connect(this.engLevel).connect(this.master);

    // oscillator stack — per-partial gains so timbre can move with load
    const mk = (type, g0) => {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      g.gain.value = g0;
      o.connect(g).connect(eng);
      o.start(t);
      return { o, g };
    };
    this.p = {
      sub:   mk('square',   0.26),   // 0.5x — the lump of a four-pot
      bodyA: mk('sawtooth', 0.50),   // 1x
      bodyB: mk('sawtooth', 0.34),   // 1x detuned — beating and thickness
      upper: mk('sawtooth', 0.10),   // 2x — edge, opens under load
      horn:  mk('triangle', 0.07),   // 3x — the top note at full noise
    };
    this.p.bodyB.o.detune.value = 9;

    // induction rasp: noise through a bandpass tracking the fundamental
    this.raspBP = ctx.createBiquadFilter();
    this.raspBP.type = 'bandpass';
    this.raspBP.frequency.value = 700;
    this.raspBP.Q.value = 1.4;
    this.raspGain = ctx.createGain();
    this.raspGain.gain.value = 0;
    this.noise.connect(this.raspBP).connect(this.raspGain).connect(eng);

    // =================================================================== ROAD
    const road = (type, freq, q) => {
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      this.noise.connect(f).connect(g).connect(this.master);
      return { f, g };
    };
    this.gravel = road('bandpass', 780, 0.75);
    this.hiss   = road('highpass', 3600, 0.70);
    this.hum    = road('lowpass',  300, 1.10);
    this.hollow = road('bandpass', 240, 3.40);   // bridge decking

    // Gravel rattle: very-low-passed noise drives the gravel bus gain, which
    // gives an irregular stony flutter no LFO shape can fake.
    this.rattleSrc = ctx.createBufferSource();
    this.rattleSrc.buffer = this.noiseBuf;
    this.rattleSrc.loop = true;
    const rattleLP = ctx.createBiquadFilter();
    rattleLP.type = 'lowpass';
    rattleLP.frequency.value = 24;
    this.rattleAmt = ctx.createGain();
    this.rattleAmt.gain.value = 0;
    this.rattleSrc.connect(rattleLP).connect(this.rattleAmt).connect(this.gravel.g.gain);

    // =================================================================== WIND
    this.windBP = ctx.createBiquadFilter();
    this.windBP.type = 'bandpass';
    this.windBP.frequency.value = 600;
    this.windBP.Q.value = 0.55;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.noise.connect(this.windBP).connect(this.windGain).connect(this.master);

    // ================================================================== TYRES
    this.squealBP = ctx.createBiquadFilter();
    this.squealBP.type = 'bandpass';
    this.squealBP.frequency.value = 1500;
    this.squealBP.Q.value = 7.5;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealBP.connect(this.squealGain).connect(this.master);

    this.sq = [];
    for (const [mul, g0] of [[1, 0.5], [1.5, 0.26], [2.02, 0.14]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 620 * mul;
      const g = ctx.createGain();
      g.gain.value = g0;
      o.connect(g).connect(this.squealBP);
      o.start(t);
      this.sq.push({ o, mul });
    }
    // a wobble, so the squeal is alive rather than a test tone
    this.sqLfo = ctx.createOscillator();
    this.sqLfo.type = 'sine';
    this.sqLfo.frequency.value = 7.3;
    const sqLfoGain = ctx.createGain();
    sqLfoGain.gain.value = 22;
    this.sqLfo.connect(sqLfoGain);
    for (const s of this.sq) sqLfoGain.connect(s.o.frequency);
    this.sqLfo.start(t);

    // scrub: broadband grit riding with the squeal so it has a body
    this.scrubBP = ctx.createBiquadFilter();
    this.scrubBP.type = 'bandpass';
    this.scrubBP.frequency.value = 2600;
    this.scrubBP.Q.value = 1.1;
    this.scrubGain = ctx.createGain();
    this.scrubGain.gain.value = 0;
    this.noise.connect(this.scrubBP).connect(this.scrubGain).connect(this.master);

    this.noise.start(t);
    this.rattleSrc.start(t);
  }

  _makeNoise(seconds) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const r = rng(0x9e3779b9);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = r() * 2 - 1;
      last = last * 0.22 + w * 0.78;             // a touch of colour, not pure white
      d[i] = last;
    }
    const fade = 400;                            // taper the seam so the loop never ticks
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[i] *= k;
      d[n - 1 - i] *= k;
    }
    return buf;
  }

  // ------------------------------------------------------------------ update
  update(dt, state) {
    if (!this.started || !this.ctx || !this.enabled) return;
    try {
      this._update(clamp(dt || 0, 0, 0.1), state || {});
    } catch (err) {
      if (!this._warned) { this._warned = true; console.warn('[audio]', err); }
    }
  }

  _update(dt, state) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const k = 0.035;                              // default setTargetAtTime constant
    this.time += dt;

    const v = state.vehicle;
    if (!v) return;
    const surfKind = state.surface?.kind ?? 'dirt';

    const speed = v.speed ?? 0;
    const top = v.tune?.topSpeed ?? 41;
    const spN = clamp01(speed / top);
    const rpmRaw = clamp01(v.engineRpm ?? 0.1);
    const gear = clamp(v.gear ?? 1, 1, 6);

    // ---- infer load --------------------------------------------------------
    const accel = dt > 0 ? (speed - this.lastSpeed) / dt : 0;
    let dRpm = dt > 0 ? (rpmRaw - this.lastRpm) / dt : 0;
    const shifted = gear !== this.lastGear;
    if (shifted) dRpm = 0;                        // ignore the sawtooth reset
    this.lastSpeed = speed;
    this.lastRpm = rpmRaw;

    // Cruising at constant speed still counts as light load (0.24 baseline);
    // only genuine deceleration pushes it low enough to read as a closed throttle.
    const loadTarget = clamp01(0.24 + dRpm * 1.1 + accel * 0.1);
    this.load += (loadTarget - this.load) * Math.min(1, dt * 9);
    this.rpm += (rpmRaw - this.rpm) * Math.min(1, dt * 18);

    // overrun: off throttle, still turning, still moving
    const overTarget = (this.load < 0.18 && this.rpm > 0.32 && speed > 5) ? 1 : 0;
    this.overrun += (overTarget - this.overrun) * Math.min(1, dt * 7);

    const load = this.load;
    const rpm = this.rpm;
    const set = (param, val, tc = k) => param.setTargetAtTime(val, now, tc);

    // ---- engine pitch ------------------------------------------------------
    // A four-cylinder fires twice per revolution: the fundamental you actually
    // hear lands between about 40 and 200 Hz across the rev range.
    const f0 = 41 + rpm * 152 + gear * 1.2;
    set(this.p.sub.o.frequency,   f0 * 0.5,   0.020);
    set(this.p.bodyA.o.frequency, f0,         0.018);
    set(this.p.bodyB.o.frequency, f0 * 1.004, 0.018);
    set(this.p.upper.o.frequency, f0 * 2,     0.018);
    set(this.p.horn.o.frequency,  f0 * 3,     0.018);
    set(this.p.bodyB.o.detune, 7 + load * 12, 0.08);

    // ---- engine timbre -----------------------------------------------------
    // brightness follows rpm AND load; overrun slams the shutters
    const cutoff = (330 + rpm * 2500 + load * 2700) * (1 - this.overrun * 0.68);
    set(this.engLP.frequency, clamp(cutoff, 170, 9000), 0.05);
    set(this.engPeak.frequency, clamp(f0 * 3.2, 120, 3800), 0.05);
    set(this.engPeak.gain, load * 11 - this.overrun * 7, 0.06);

    const shut = 1 - this.overrun * 0.65;
    set(this.p.upper.g.gain, (0.05 + load * 0.24 + rpm * 0.08) * shut, 0.06);
    set(this.p.horn.g.gain, (0.02 + load * 0.13 * rpm) * shut, 0.06);
    set(this.p.sub.g.gain, 0.30 - load * 0.10, 0.06);

    // rasp hardens with load — step to a harder transfer curve in 8 stages
    const ci = clamp(Math.round(load * 7), 0, 7);
    if (ci !== this.curveIdx) { this.curveIdx = ci; this.shaper.curve = this.curves[ci]; }

    set(this.raspBP.frequency, clamp(f0 * 5.5, 200, 6000), 0.06);
    set(this.raspGain.gain, (0.02 + load * 0.10) * (0.3 + rpm * 0.7), 0.06);

    // ---- engine drive and level ---------------------------------------------
    // drive shapes the rasp; level sets loudness. They must not be the same knob.
    set(this.engDrive.gain, 0.45 + load * 0.85, 0.06);
    const ducking = this.shiftUntil > now;
    const engLevel = (0.048 + rpm * 0.070 + load * 0.062) * (ducking ? 0.28 : 1);
    set(this.engLevel.gain, engLevel, ducking ? 0.01 : 0.05);

    if (shifted) {
      this._shift(gear > this.lastGear, rpm);
      this.lastGear = gear;
    }

    // overrun crackle — sparse, deterministic pops on the way down
    if (this.overrun > 0.55 && this.time > this.nextCrackle) {
      this.nextCrackle = this.time + 0.035 + this.rand() * 0.14 * (1.4 - rpm);
      this._pop(0.05 + this.rand() * 0.07, 1100 + this.rand() * 1800, 0.035);
    }

    // ---- road --------------------------------------------------------------
    const roll = Math.pow(spN, 0.8);
    const w = surfaceWeights(surfKind);
    set(this.gravel.g.gain, w.gravel * roll * 0.085, 0.09);
    set(this.rattleAmt.gain, w.gravel * roll * 0.055, 0.09);
    set(this.hiss.g.gain,   w.hiss   * roll * 0.070, 0.09);
    set(this.hum.g.gain,    w.hum    * roll * 0.105, 0.09);
    set(this.hollow.g.gain, w.hollow * roll * 0.105, 0.06);
    set(this.gravel.f.frequency, 620 + spN * 700, 0.12);
    set(this.hum.f.frequency, 190 + spN * 260, 0.12);

    // ---- wind --------------------------------------------------------------
    set(this.windGain.gain, Math.pow(spN, 2.1) * 0.085, 0.10);
    set(this.windBP.frequency, 420 + spN * 1350, 0.12);
    set(this.windBP.Q, 0.5 + spN * 0.7, 0.12);

    // ---- tyres -------------------------------------------------------------
    const slip = Math.max(v.wheelSlip?.[2] ?? 0, v.wheelSlip?.[3] ?? 0,
                          (v.wheelSlip?.[0] ?? 0) * 0.8);
    const ang = clamp01(((v.driftAngle ?? 0) - 0.06) / 0.5);
    const target = clamp01(Math.max(slip - 0.28, 0) / 0.5 * 0.7 + ang * 0.7)
                 * clamp01((speed - 4) / 9) * surfaceSqueal(surfKind);
    this.squeal += (target - this.squeal) * Math.min(1, dt * (target > this.squeal ? 8 : 4));
    const sq = this.squeal;
    set(this.squealGain.gain, sq * 0.085, 0.05);
    set(this.scrubGain.gain, sq * 0.05 + clamp01(slip - 0.1) * roll * 0.022, 0.05);
    const sqF = 560 + ang * 520 + spN * 250;
    for (const s of this.sq) set(s.o.frequency, sqF * s.mul, 0.05);
    set(this.squealBP.frequency, sqF * 1.15, 0.05);
    set(this.squealBP.Q, 6 + sq * 5, 0.06);
    set(this.sqLfo.frequency, 6.2 + sq * 5, 0.10);
  }

  // ------------------------------------------------------------------ events
  event(name, payload) {
    if (!this.started || !this.ctx || !this.enabled) return;
    try {
      if (name === 'impact') this._impact(payload?.speed ?? 8);
      else if (name === 'driftStart') this._driftStart();
      else if (name === 'driftEnd') this._payout(payload?.score ?? 0);
      else if (name === 'shift') this._shift(true, this.rpm);
    } catch (err) {
      if (!this._warned) { this._warned = true; console.warn('[audio]', err); }
    }
  }

  /** Ignition cut plus a blow-off chuff. The level duck is applied in _update. */
  _shift(up, rpm) {
    const ctx = this.ctx, now = ctx.currentTime;
    this.shiftUntil = now + (up ? 0.075 : 0.05);
    this._pop(up ? 0.09 : 0.05, up ? 1500 : 2400, 0.06, 'highpass');
    const o = ctx.createOscillator();            // a soft clack from the linkage
    o.type = 'triangle';
    const g = ctx.createGain();
    o.frequency.setValueAtTime(up ? 210 : 260, now);
    o.frequency.exponentialRampToValueAtTime(90, now + 0.06);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.07 * (0.5 + rpm), now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    o.connect(g).connect(this.master);
    o.start(now); o.stop(now + 0.11);
  }

  /** A short filtered-noise burst. Used for crackle, chuff and debris. */
  _pop(amp, freq, dur, type = 'bandpass') {
    const ctx = this.ctx, now = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.playbackRate.value = 0.8 + this.rand() * 0.6;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(amp, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(now, this.rand() * 2.5);
    s.stop(now + dur + 0.02);
  }

  _impact(speed) {
    const ctx = this.ctx, now = ctx.currentTime;
    const amp = clamp(speed / 26, 0.12, 1);

    const o = ctx.createOscillator();            // the thud
    o.type = 'sine';
    o.frequency.setValueAtTime(105 + amp * 40, now);
    o.frequency.exponentialRampToValueAtTime(38, now + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.5 * amp, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    o.connect(g).connect(this.master);
    o.start(now); o.stop(now + 0.36);

    const o2 = ctx.createOscillator();           // the panel ring
    o2.type = 'triangle';
    o2.frequency.setValueAtTime(320 + this.rand() * 90, now);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, now);
    g2.gain.exponentialRampToValueAtTime(0.16 * amp, now + 0.004);
    g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.17);
    o2.connect(g2).connect(this.master);
    o2.start(now); o2.stop(now + 0.19);

    this._pop(0.26 * amp, 1700, 0.13);           // the debris
  }

  _driftStart() {
    const ctx = this.ctx, now = ctx.currentTime;
    // a low swell under the slide — no melody, it must not become a jingle
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, now);
    o.frequency.exponentialRampToValueAtTime(96, now + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.07, now + 0.09);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    o.connect(g).connect(this.master);
    o.start(now); o.stop(now + 0.62);
  }

  /** Whoosh plus chime when a chain lands. The pitch tier rises with the score. */
  _payout(score) {
    if (!(score > 110)) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const tier = score > 1500 ? 3 : score > 760 ? 2 : score > 320 ? 1 : 0;
    const amp = 0.5 + tier * 0.14;

    const s = ctx.createBufferSource();          // whoosh
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2.6;
    f.frequency.setValueAtTime(340, now);
    f.frequency.exponentialRampToValueAtTime(4200 + tier * 900, now + 0.42);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.2 * amp, now + 0.16);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    s.connect(f).connect(g).connect(this.master);
    s.start(now, 0.7); s.stop(now + 0.58);

    // chime: an add9 stack arpeggiated by 45 ms, brighter at higher tiers
    const root = [523.25, 587.33, 659.25, 783.99][tier];
    [1, 1.5, 2, 3, 4.5].forEach((r, i) => {
      const t0 = now + 0.16 + i * 0.045;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = root * r;
      const gg = ctx.createGain();
      const peak = 0.11 * amp / (1 + i * 0.55);
      gg.gain.setValueAtTime(0.0001, t0);
      gg.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
      gg.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.0 + tier * 0.25);
      o.connect(gg).connect(this.master);
      o.start(t0); o.stop(t0 + 1.4 + tier * 0.3);
    });

    const lo = ctx.createOscillator();           // a floor under the chime
    lo.type = 'sine';
    lo.frequency.value = root / 4;
    const lg = ctx.createGain();
    lg.gain.setValueAtTime(0.0001, now + 0.16);
    lg.gain.exponentialRampToValueAtTime(0.09 * amp, now + 0.2);
    lg.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
    lo.connect(lg).connect(this.master);
    lo.start(now + 0.16); lo.stop(now + 1.2);
  }
}

/** Crossfade weights for the four road-noise characters. */
function surfaceWeights(kind) {
  switch (kind) {
    case 'road':   return { gravel: 0.25, hiss: 0.30, hum: 1.00, hollow: 0 };
    case 'bridge': return { gravel: 0.15, hiss: 0.20, hum: 0.55, hollow: 1.0 };
    case 'snow':   return { gravel: 0.20, hiss: 1.00, hum: 0.28, hollow: 0 };
    case 'dirt':
    default:       return { gravel: 1.00, hiss: 0.35, hum: 0.40, hollow: 0 };
  }
}

/** How willing a surface is to scream. Snow does not squeal. */
function surfaceSqueal(kind) {
  switch (kind) {
    case 'road': return 1.0;
    case 'bridge': return 0.85;
    case 'snow': return 0.14;
    default: return 0.42;
  }
}

/**
 * Asymmetric soft clip. `k` is how hard the rasp bites. Normalised so that
 * winding the drive up changes the TIMBRE and not the level — otherwise the
 * mix would swell every time the driver squeezes the throttle.
 */
function makeDriveCurve(k) {
  const n = 1024;
  const c = new Float32Array(n);
  const norm = 1 / (1 + k * 0.34);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.tanh(x * (1 + k * 3.2));
    const b = Math.tanh(x * (1 + k * 1.1));
    c[i] = ((x > 0 ? a : b) * 0.86 + x * 0.14) * norm;   // asymmetry = even harmonics
  }
  return c;
}
