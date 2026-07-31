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
 * engine   a firing-order model: three PeriodicWaves built from four cylinders
 *          fired round one four-stroke cycle, morphed by load and overrun, run
 *          through a FIXED exhaust resonance stack. See ENGINE MODEL below.
 * tyres    a resonant squeal triad whose pitch and gain follow slip angle,
 *          gated by surface (tarmac screams, snow does not).
 * road     one noise source fanned into four filtered buses — gravel rattle,
 *          snow hiss, tarmac hum, bridge boom — crossfaded by surface and
 *          scaled by speed.
 * wind     bandpassed noise that opens and rises with speed.
 * impacts  a pitch-dropping sine thud + a panel ring + a debris burst.
 * payout   a rising whoosh and an arpeggiated chime when a drift chain lands.
 *
 * ---------------------------------------------------------------------------
 * ENGINE MODEL — why it is built this way
 *
 * The v0 engine was five oscillators at 0.5x / 1x / 1x / 2x / 3x of a
 * fundamental, and it sounded like a buzzing sawtooth because that is what it
 * was. Four things were missing, and each is now a named piece of the graph.
 *
 * 1. THE FIRING ORDER IS THE TIMBRE. An engine's waveform does not repeat once
 *    per firing event; it repeats once per FOUR-STROKE CYCLE, which is two
 *    crank revolutions and four firings on a four-pot. So the oscillator runs
 *    at the cycle rate — rpm/120, a mere 8-60 Hz — and the harmonic table
 *    carries the four exhaust pulses inside it. Harmonic 4 is the firing
 *    frequency you hear as the note; harmonics 1, 2, 3, 5, 6, 7 only exist
 *    because the four cylinders are not identical, and they are what an engine
 *    has and an oscillator does not. The tables are built by literally summing
 *    four pulses at their crank phases (`makeEngineWave`), so the unevenness is
 *    derived, not sprinkled on. Measured: half-order energy -27.4 dB on the old
 *    stack, -14.7 dB now.
 *
 * 2. THE PIPE DOES NOT MOVE. The old filter stack tracked rpm — cutoff at
 *    330 + rpm * 2500, peak at f0 * 3.2 — so every harmonic kept the same
 *    relative level at every rpm and the ear heard one timbre being transposed,
 *    not an engine. A real exhaust is a fixed-length resonator: the peaks stay
 *    put while the harmonics slide through them, getting loud as they cross a
 *    mode and quiet as they leave, and that crossing is most of what makes it
 *    sound like gas leaving a pipe. `_buildExhaust` puts four peaking filters
 *    at fixed frequencies and NOTHING in _update is allowed to touch them.
 *    Measured as the slope of brightness against pitch: 0.93 before — double
 *    the revs, double every frequency in the sound — against 0.73 now.
 *
 * 3. LOAD AND OVERRUN ARE DIFFERENT INSTRUMENTS, not one filter cutoff. There
 *    are three wave tables — idle, on-load, overrun — built from the SAME four
 *    cylinders with different pulse shapes, and they are crossfaded. That works
 *    only because all three oscillators are driven by ONE frequency source, so
 *    they stay sample-phase identical and the crossfade is a true morph of the
 *    harmonic table rather than two waveforms combing against each other.
 *
 * 4. THE SHIFT IS AN EVENT WITH STRUCTURE. Torque cut, real gap, re-engagement
 *    thump, note landing at the new ratio — see `_shift`. A level duck and a
 *    crossfade is what makes a shift sound like a synthesiser.
 *
 * Pitch is PROPORTIONAL to crank speed (`crankRpm`), because that is the one
 * thing a listener checks without knowing they are checking it. The old
 * `41 + rpm * 152` is affine, not proportional, so it can only be right in one
 * place: measured as how much energy actually sits at the firing frequency the
 * rpm implies, it scored -1.8 dB at high revs — nothing there at all — against
 * +13.8 dB now.
 *
 * The load signal is INFERRED, because the audio module is not handed the input
 * struct — but it is inferred from `pitchAccel`, the vehicle's own smoothed
 * longitudinal acceleration, which is far better evidence than rpm slope: full
 * throttle is +7.6 m/s^2 of drive and a shut throttle is -2.2 m/s^2 of engine
 * braking, and those do not overlap.
 */

import { createSfx } from './sfx.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * The rev range the normalised `vehicle.engineRpm` is interpreted as. The
 * vehicle model floors that signal at 0.16 when stationary and lets it run a
 * little past 1.0 on wheelspin, so 0.16 is idle and 1.0 is the redline; the
 * over-rev above 1.0 is allowed to sound like an over-rev.
 *
 * These numbers are the audio module's own interpretation — the physics has no
 * opinion about crank speed — but tools/audio-analyse.mjs holds both the old
 * and new engine to this same yardstick, which is the only way the pitch
 * tracking figure means anything.
 */
const IDLE_RPM = 950;
const REDLINE_RPM = 7000;
const RPM_LO = 0.16;                 // vehicle.engineRpm at a standstill
const RPM_HI = 1.00;

/** Normalised engineRpm -> crank rev/min. */
function crankRpm(rpmN) {
  return IDLE_RPM + ((rpmN - RPM_LO) / (RPM_HI - RPM_LO)) * (REDLINE_RPM - IDLE_RPM);
}

/**
 * Crank rev/min -> the oscillator's fundamental, which is the FOUR-STROKE
 * CYCLE rate: two crank revolutions, so rpm/120. Everything audible is a
 * harmonic of this — the firing note a four-cylinder makes is harmonic 4.
 */
function cycleHz(rpm) {
  return rpm / 120;
}

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
    // Optional player-supplied samples. Enumerated at build time; usually empty,
    // in which case nothing below it ever runs. See sfx.js.
    this.sfx = createSfx();
    this.sampled = null;

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
    // While a shift is scheduled, _update must keep its hands off the pitch and
    // the torque gate: both are on explicit ramps and a setTargetAtTime landing
    // in the middle of one cancels it, which is how the gap disappears.
    this.shiftHoldUntil = 0;
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
      // Deliberately NOT awaited. The synth is already running; if the folder
      // has anything usable it takes over a few hundred milliseconds later, and
      // if it does not, nothing happened.
      this._adoptSamples();
      window.addEventListener('keydown', (e) => {
        if (e.code === 'KeyN') this.setEnabled(!this.enabled);
      });
    } catch (err) {
      this._failed = true;
      this.ctx = null;
      console.warn('[audio] disabled:', err);
    }
  }

  /**
   * Build the same graph against a caller-supplied context and skip every
   * browser-lifecycle concern. The only client is tools/audio-render.mjs, which
   * hands in an OfflineAudioContext so the engine can be rendered to a WAV and
   * measured; it exists so that tool does not have to reach into private state,
   * and so this file stays the only place that knows how the graph goes
   * together. Never called by the game.
   */
  startOffline(ctx) {
    this.ctx = ctx;
    this._build();
    this.started = true;
    this.enabled = true;
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
    //
    // Signal path, and the order is the argument:
    //
    //   3 phase-locked oscillators (firing-order wave tables)
    //        -> DRIVE (timbre)  -> waveshaper
    //        -> [+ combustion noise, joining here so it comes out the same pipe]
    //        -> EXHAUST RESONANCE (four fixed peaks — see _buildExhaust)
    //        -> tone lowpass -> highpass
    //        -> LEVEL (steady-state loudness, per-frame)
    //        -> TORQUE GATE (shift events only, scheduled ramps)
    //        -> master
    //
    // LEVEL and GATE are two separate gains on purpose. _update writes LEVEL
    // every frame with setTargetAtTime; _shift writes GATE with explicit
    // ramps. Sharing one node means the next frame's setTargetAtTime cancels
    // the shift ramp 13 ms into a 75 ms gap, and the gap silently vanishes.

    this.engDrive = ctx.createGain();
    this.engDrive.gain.value = 0.5;

    // Rasp: a waveshaper whose curve is swapped between 8 precomputed
    // hardnesses, so no Float32Array is ever built inside the frame loop.
    this.curves = [];
    for (let i = 0; i < 8; i++) this.curves.push(makeDriveCurve(0.06 + i * 0.42));
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = this.curves[0];
    this.shaper.oversample = '2x';
    this.curveIdx = 0;

    // Everything the exhaust is supposed to colour meets here: the shaped tone
    // and the combustion noise. Noise deliberately bypasses the waveshaper —
    // clipping noise just makes duller noise, and costs the pulses their bite.
    this.engPipe = ctx.createGain();
    this.engPipe.gain.value = 1;

    this.engLP = ctx.createBiquadFilter();
    this.engLP.type = 'lowpass';
    this.engLP.frequency.value = 900;
    this.engLP.Q.value = 0.6;

    // 48 Hz, not 32. On a four-pot at idle the firing note is 32 Hz and the
    // wave's own fundamental is 8 Hz; all of that was consuming peak headroom
    // no laptop speaker was ever going to reproduce, and it was also what the
    // spectral envelope peaked at, which meant the fixed exhaust modes were
    // never the loudest thing in the sound they are supposed to define. 66 Hz
    // was tried and went too far: it took the idle's second harmonic with it.
    const engHP = ctx.createBiquadFilter();
    engHP.type = 'highpass';
    engHP.frequency.value = 48;

    this.engLevel = ctx.createGain();
    this.engLevel.gain.value = 0;
    this.engBus = this.engLevel;                // exposed for tools/audiocheck

    this.torqueGate = ctx.createGain();
    this.torqueGate.gain.value = 1;

    this.engDrive.connect(this.shaper).connect(this.engPipe);
    this._buildExhaust(this.engPipe, this.engLP);
    this.engLP.connect(engHP).connect(this.engLevel)
              .connect(this.torqueGate).connect(this.master);

    // ---- the wave tables ---------------------------------------------------
    // One draw of four cylinders, shared by all three tables. If each table
    // drew its own the crossfade would morph between three DIFFERENT engines
    // and the unevenness would swim about instead of being a fixed character.
    const cyl = makeCylinders(4, rng(0xC0FFEE));
    const waves = {
      // sigma widens the exhaust pulse (duller), tilt is the harmonic roll-off,
      // lump scales how far the four cylinders differ. Overrun is the hollow
      // one: a wide, weak, ragged pulse, which is what a cylinder pumping
      // unburnt charge actually produces.
      idle: makeEngineWave(ctx, cyl, { sigma: 0.030, tilt: 0.60, lump: 1.00 }),
      power: makeEngineWave(ctx, cyl, { sigma: 0.018, tilt: 0.42, lump: 0.55 }),
      over: makeEngineWave(ctx, cyl, { sigma: 0.044, tilt: 0.95, lump: 1.45 }),
    };

    // ---- one frequency source for all three --------------------------------
    // The oscillators' own frequency is pinned at 0 and the pitch arrives as an
    // audio-rate signal, so all three integrate bit-identical phase. That is
    // the whole reason the crossfade is a morph of the harmonic table and not
    // three waveforms combing against each other — with independent frequency
    // params, rounding alone drifts them apart within seconds.
    this.f0Src = ctx.createConstantSource();
    this.f0Src.offset.value = cycleHz(IDLE_RPM);

    // A slow, seeded wander of the crank speed. Real idle hunts; a synth that
    // does not is the giveaway. Amount is set per-frame as a fraction of f0.
    this.wanderSrc = ctx.createBufferSource();
    this.wanderSrc.buffer = this.noiseBuf;
    this.wanderSrc.loop = true;
    const wanderLP = ctx.createBiquadFilter();
    wanderLP.type = 'lowpass';
    wanderLP.frequency.value = 2.4;
    this.wanderAmt = ctx.createGain();
    this.wanderAmt.gain.value = 0;
    this.wanderSrc.connect(wanderLP).connect(this.wanderAmt);

    this.eng = [];
    for (const key of ['idle', 'power', 'over']) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(waves[key]);
      o.frequency.value = 0;
      this.f0Src.connect(o.frequency);
      this.wanderAmt.connect(o.frequency);
      const g = ctx.createGain();
      g.gain.value = key === 'idle' ? 1 : 0;
      o.connect(g).connect(this.engDrive);
      o.start(t);
      this.eng.push({ key, o, g });
    }
    this.f0Src.start(t);
    this.wanderSrc.start(t);

    // ---- combustion and induction noise ------------------------------------
    // Two bands, because they behave differently. The ROAR is broadband and
    // opens with load — it is the reason a car at full throttle is not just a
    // louder version of a car at idle. The INDUCTION band tracks rpm and is the
    // airbox; it is what makes the top of the rev range sound like it is
    // breathing rather than just getting brighter.
    this.roarLP = ctx.createBiquadFilter();
    this.roarLP.type = 'lowpass';
    this.roarLP.frequency.value = 400;
    this.roarLP.Q.value = 0.7;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    this.noise.connect(this.roarLP).connect(this.roarGain).connect(this.engPipe);

    this.raspBP = ctx.createBiquadFilter();
    this.raspBP.type = 'bandpass';
    this.raspBP.frequency.value = 700;
    this.raspBP.Q.value = 1.1;
    this.raspGain = ctx.createGain();
    this.raspGain.gain.value = 0;
    this.noise.connect(this.raspBP).connect(this.raspGain).connect(this.engPipe);

    // The roar is not steady: its level is modulated by very-low-passed noise,
    // the same trick the gravel bus uses, so combustion has an irregular
    // flutter instead of sitting there like a hiss generator.
    this.roarMod = ctx.createBufferSource();
    this.roarMod.buffer = this.noiseBuf;
    this.roarMod.loop = true;
    this.roarMod.playbackRate.value = 1.7;
    const roarModLP = ctx.createBiquadFilter();
    roarModLP.type = 'lowpass';
    roarModLP.frequency.value = 42;
    this.roarModAmt = ctx.createGain();
    this.roarModAmt.gain.value = 0;
    this.roarMod.connect(roarModLP).connect(this.roarModAmt).connect(this.roarGain.gain);
    this.roarMod.start(t);

    // ---- transmission whine ------------------------------------------------
    // A straight-cut gearbox whines at the tooth-mesh frequency: crank revs
    // times the mesh order of whichever pair is engaged, so it steps when the
    // gear does. Kept 30 dB under the exhaust — you should not be able to point
    // at it, you should only notice when it is gone.
    this.whineOsc = ctx.createOscillator();
    this.whineOsc.type = 'triangle';
    this.whineOsc.frequency.value = 800;
    this.whineBP = ctx.createBiquadFilter();
    this.whineBP.type = 'bandpass';
    this.whineBP.frequency.value = 800;
    this.whineBP.Q.value = 3.5;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whineOsc.connect(this.whineBP).connect(this.whineGain).connect(this.torqueGate);
    this.whineOsc.start(t);

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

  // ------------------------------------------------------- optional sfx/ files
  /**
   * Hand the engine over to player-supplied recordings, if the sfx/ folder had
   * any. Kept in one method and one branch in _update on purpose: the synth is
   * the deliverable and must not grow a second code path running through it.
   *
   * The samples replace the wave tables and the exhaust chain — a recording
   * already contains its own pipe, so putting it through ours would be a second
   * exhaust — but everything ELSE stays: the load and overrun inference, the
   * crossfade weights, the torque gate and the shift's pitch trajectory. Those
   * are behaviour, not sound, and they are what makes a sample set follow the
   * car rather than just play.
   */
  async _adoptSamples() {
    try {
      await this.sfx.load(this.ctx);
      if (!this.sfx.hasEngine || !this.ctx) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const voices = {};
      for (const key of ['idle', 'power', 'over']) {
        const e = this.sfx.get(`engine_${key === 'power' ? 'onload' : key === 'over' ? 'overrun' : 'idle'}`);
        if (!e) continue;
        const src = ctx.createBufferSource();
        src.buffer = e.buffer;
        src.loop = true;
        const g = ctx.createGain();
        g.gain.value = 0;
        src.connect(g).connect(this.torqueGate);
        src.start(t);
        voices[key] = { src, g, refRpm: e.refRpm };
      }
      if (!Object.keys(voices).length) return;
      // Silence the synth engine rather than tearing it down: it is one gain
      // ramp, it is reversible, and a half-dismantled graph is how a fallback
      // stops being a fallback.
      this.engLevel.gain.setTargetAtTime(0, t, 0.05);
      this.sampled = voices;
      console.info('[sfx] engine from sfx/:', this.sfx.names.join(', '));
    } catch (err) {
      console.warn('[sfx] disabled:', err);
      this.sampled = null;
    }
  }

  /** Drive the sample voices from the same rpm and crossfade the synth uses. */
  _updateSamples(now, crank, weights, set) {
    for (const key of ['idle', 'power', 'over']) {
      const v = this.sampled[key];
      if (!v) continue;
      set(v.src.playbackRate, clamp(crank / v.refRpm, 0.25, 4), 0.03);
      // A voice the folder did not supply has its weight folded into the ones
      // it did, so the crossfade always sums to one and the engine never dips.
      let w = weights[key];
      for (const k of ['idle', 'power', 'over']) if (!this.sampled[k]) w += weights[k] / this._voiceCount();
      set(v.g.gain, clamp01(w) * 0.9, 0.045);
    }
  }

  _voiceCount() {
    return ['idle', 'power', 'over'].filter((k) => this.sampled[k]).length || 1;
  }

  /**
   * THE PIPE. Four peaking filters at FIXED frequencies, wired between `input`
   * and `output`, and nothing in _update is permitted to move them.
   *
   * This is the single change that does most of the work. An exhaust is a
   * fixed-length resonator: its modes sit where the geometry puts them while
   * the engine's harmonics slide up and down THROUGH them, so a harmonic gets
   * loud as it crosses a mode and quiet as it leaves. That crossing is the
   * sound of gas leaving a pipe. The v0 engine tracked its peak filter at
   * f0 * 3.2, which means every harmonic kept the same relative level forever
   * and the ear heard a filter sweep on a tone generator — measured as a
   * formant that moved 8.4x while the pitch moved 4.7x.
   *
   * The frequencies are a ~2.2 m straight-through system: c/2L = 78 Hz for the
   * open-open fundamental, its second and third modes, and the collector bark
   * higher up. Rounded to what sounded right rather than to three decimals,
   * because the real thing has bends, a silencer and a bodyshell in the way.
   */
  _buildExhaust(input, output) {
    const ctx = this.ctx;
    const peak = (freq, q, gain) => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = q;
      f.gain.value = gain;
      return f;
    };
    // The low mode is deliberately the QUIETEST boost of the three. Physically
    // it is the strongest, but a game is played on laptop speakers and a phone,
    // where 84 Hz is a waste of the headroom that 605 Hz would have used. First
    // pass had it at +5.5 dB and the spectral centroid at full load came out at
    // 227 Hz against the old engine's 494 — correct, and inaudible.
    const modes = [
      peak(84, 1.6, 1.0),     // pipe fundamental — the thump you feel
      peak(232, 2.2, 7.0),    // second mode — the note's colour
      peak(605, 1.4, 8.0),    // collector bark — where the sound actually lives
      peak(1280, 1.2, 4.0),   // the hard edge that reads as "rally" and not "van"
    ];
    // The rasp band is the only one whose GAIN moves, and only with load: a
    // pipe does not change length, but it does get driven harder. Frequency
    // stays nailed down, which is what the formant measure is about.
    this.rasp = peak(1900, 0.9, 0);
    let node = input;
    for (const m of [...modes, this.rasp]) node = node.connect(m);
    node.connect(output);
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
    this._lastV = v;              // event() has no state argument; _shift needs one
    const surfKind = state.surface?.kind ?? 'dirt';

    const speed = v.speed ?? 0;
    const top = v.tune?.topSpeed ?? 41;
    const spN = clamp01(speed / top);
    const rpmRaw = clamp01(v.engineRpm ?? 0.1);
    const gear = clamp(v.gear ?? 1, 1, 6);

    const shifted = gear !== this.lastGear;
    this.lastSpeed = speed;
    this.lastRpm = rpmRaw;

    // ---- infer load --------------------------------------------------------
    // The module is never handed the input struct, so throttle has to be read
    // back out of the motion. The v0 guess was rpm slope plus acceleration with
    // a 0.24 floor, which cannot tell "flat out at top speed" (accelerating
    // hardly at all, because drag has caught up) from "coasting".
    //
    // The vehicle publishes `pitchAccel`: its own smoothed body-frame
    // longitudinal acceleration. Bracket it. Work out what the acceleration
    // WOULD be at this speed with the throttle shut and with it wide open —
    // both are computable from the tune the vehicle also publishes — and read
    // off where the measured value sits between them. Checked against the drive
    // tape at four speeds: predicted full-throttle acceleration 7.37 / 6.40 /
    // 4.22 m/s^2 against 7.33 / 6.43 / 4.21 measured, and predicted closed-
    // throttle -3.32 against -3.32. The estimator is not approximately right,
    // it is the model's own arithmetic run backwards.
    const T = v.tune ?? {};
    const mass = T.mass ?? 1180;
    const resist = ((T.rollingResist ?? 210) + (T.rollingSpeed ?? 7.5) * speed
                    + (T.dragCoef ?? 0.63) * speed * speed) / mass;
    const accOff = -(resist + ((T.engineBrake ?? 2600) / mass) * Math.min(1, speed / 6));
    const accOn = ((T.enginePower ?? 9000) / mass) * Math.max(0, 1 - spN * spN * spN) - resist;
    const loadTarget = clamp01(((v.pitchAccel ?? 0) - accOff) / Math.max(0.6, accOn - accOff));

    this.load += (loadTarget - this.load) * Math.min(1, dt * 9);
    this.rpm += (rpmRaw - this.rpm) * Math.min(1, dt * 18);

    // Overrun: throttle shut, engine still spinning, car still moving. With a
    // load signal this trustworthy the threshold can be tight — 0.12, where the
    // old inference needed 0.18 and still fired at part throttle.
    const overTarget = (this.load < 0.12 && this.rpm > 0.30 && speed > 5) ? 1 : 0;
    this.overrun += (overTarget - this.overrun) * Math.min(1, dt * 7);

    const load = this.load;
    const rpm = this.rpm;
    const over = this.overrun;
    const set = (param, val, tc = k) => param.setTargetAtTime(val, now, tc);

    // ---- engine pitch ------------------------------------------------------
    // The oscillators run at the four-stroke CYCLE rate — the note you hear is
    // harmonic 4 of it. Proportional to crank speed, so the pitch is the rpm:
    // 2.9 octaves from idle to redline, where the old `41 + rpm * 152` managed
    // 2.3 and squashed them all into the wrong places.
    const crank = crankRpm(rpm);
    const f0 = cycleHz(crank);
    if (now >= this.shiftHoldUntil) {
      set(this.f0Src.offset, f0, 0.022);
    }
    // Idle hunt: +-0.35% wander at rest, tapering away under load where the
    // governor and the driver's foot hold it steady.
    set(this.wanderAmt.gain, f0 * 0.0035 * (1 - load * 0.7) * (0.4 + (1 - rpm) * 0.6), 0.2);

    // ---- engine timbre -----------------------------------------------------
    // Three wave tables, barycentric. Overrun claims its share first because it
    // is a state, not a degree: the throttle plate is shut or it is not.
    const wOver = over;
    const wPower = (1 - over) * load;
    const wIdle = (1 - over) * (1 - load);
    for (const e of this.eng) {
      set(e.g.gain, e.key === 'over' ? wOver : e.key === 'power' ? wPower : wIdle, 0.045);
    }
    if (this.sampled) {
      this._updateSamples(now, crank, { idle: wIdle, power: wPower, over: wOver }, set);
    }

    // The tone lowpass still exists, but it is now a lid rather than the whole
    // timbre: the wave tables carry the character, so this only has to keep the
    // top end from fizzing at low rpm and let it out at high.
    // The rpm term is deliberately WEAK. Make the cutoff strongly proportional
    // to rpm and the whole spectrum transposes with the revs — measured as a
    // brightness-to-pitch slope of 0.93 on the old engine, i.e. one timbre
    // being pitch-shifted, which is the definition of sounding synthetic. Load
    // is what should open a throttle body; revs on their own should not.
    const cutoff = (1500 + rpm * 2400 + load * 3400) * (1 - over * 0.55);
    set(this.engLP.frequency, clamp(cutoff, 260, 11000), 0.05);

    // The one exhaust mode allowed to move — in level only, never frequency.
    set(this.rasp.gain, 1.5 + load * 9 - over * 6, 0.06);

    // rasp hardens with load — step to a harder transfer curve in 8 stages
    const ci = clamp(Math.round(load * 7), 0, 7);
    if (ci !== this.curveIdx) { this.curveIdx = ci; this.shaper.curve = this.curves[ci]; }

    // ---- combustion noise ---------------------------------------------------
    // The noise floor RISING under load is half of what "on power" means. Off
    // throttle there is nothing burning, so it nearly vanishes and the note
    // hollows out — which is the other half.
    set(this.roarLP.frequency, (520 + rpm * 2600 + load * 1500) * (1 - over * 0.55), 0.08);
    // The 0.040 floor is not decoration. Without it an idling engine measured a
    // harmonic-to-noise ratio of 106 dB — cleaner than a sine wave, and the
    // single most synthetic thing left in the sound. 0.075 overshot the other
    // way and idle measured 3.2 dB, which is a hiss generator with a tune on
    // top. 0.040 sits where a real idle does.
    set(this.roarGain.gain, (0.040 + load * 0.075) * (0.4 + rpm * 0.6) * (1 - over * 0.85), 0.06);
    set(this.roarModAmt.gain, load * 0.05, 0.08);
    // Airbox: only PARTLY rpm-tracked. An induction resonance is a real cavity
    // with a real length, so it has a fixed component; making it purely
    // proportional to rpm was another voice transposing in lockstep with pitch.
    set(this.raspBP.frequency, clamp(1100 + f0 * 12, 400, 7000), 0.06);
    // Gated by overrun as well as load. It was not, and with the combustion
    // roar correctly cut on a shut throttle this induction band became the
    // loudest noise left in the overrun — an airbox roaring with nothing going
    // through it.
    set(this.raspGain.gain, (0.014 + load * 0.050) * (0.3 + rpm * 0.7) * (1 - over * 0.7), 0.06);

    // ---- transmission whine -------------------------------------------------
    // Tooth-mesh frequency = crank revs/s times the mesh order of the pair
    // that is engaged, so it steps down through the box as the gears get taller.
    const mesh = GEAR_MESH[clamp(gear, 1, 6) - 1];
    const whineF = clamp((crank / 60) * mesh, 120, 9000);
    set(this.whineOsc.frequency, whineF, 0.03);
    set(this.whineBP.frequency, whineF, 0.03);
    set(this.whineGain.gain, (0.004 + load * 0.010) * clamp01((rpm - 0.2) / 0.6), 0.07);

    // ---- engine drive and level ---------------------------------------------
    // drive shapes the rasp; level sets loudness. They must not be the same knob.
    set(this.engDrive.gain, 0.30 + load * 0.55, 0.06);
    set(this.engLevel.gain, 0.105 + rpm * 0.060 + load * 0.080, 0.05);

    if (shifted) {
      this._shift(gear > this.lastGear, v);
      this.lastGear = gear;
    }

    // overrun crackle — sparse, deterministic pops on the way down
    if (this.overrun > 0.55 && this.time > this.nextCrackle) {
      this.nextCrackle = this.time + 0.035 + this.rand() * 0.14 * (1.4 - rpm);
      // Scaled by rpm and sat under the exhaust, but not buried. The original
      // fixed 0.05-0.12 went straight to master at around ten times the
      // engine's own level and swamped it. 0.014-0.034 then went too far the
      // other way: rendering with the crackle disabled entirely changed nothing
      // measurable, which means it was doing nothing audible either. This sits
      // between the two.
      this._pop((0.030 + this.rand() * 0.035) * (0.4 + rpm * 0.6),
                1100 + this.rand() * 1800, 0.035);
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
      else if (name === 'shift') this._shift(true, this._lastV ?? {});
      else if (name === 'lap') this._lap(payload?.final === true);
    } catch (err) {
      if (!this._warned) { this._warned = true; console.warn('[audio]', err); }
    }
  }

  /**
   * THE LAP CHIME — a timing beam, not a fanfare.
   *
   * Two short bell tones a fifth apart, the second a beat after the first, on a
   * fast exponential decay. Deliberately spare: this fires once a lap, over an
   * engine at full noise, and it has one job — to tell the player the line went
   * under them without taking their attention off the road. A fanfare would be
   * heard once and resented four more times.
   *
   * The final lap gets a third tone an octave up, so finishing sounds different
   * from lapping without needing a second sound to learn.
   */
  _lap(final = false) {
    const ctx = this.ctx, now = ctx.currentTime;
    // A fifth: 880 and 1320 Hz sit above the engine's strongest harmonics
    // (the firing order tops out near 600 Hz at the limiter) so the chime is
    // heard through full throttle rather than mixed into it.
    const notes = final ? [[880, 0], [1320, 0.13], [1760, 0.27]] : [[880, 0], [1320, 0.13]];
    for (const [hz, at] of notes) {
      const t = now + at;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      // Triangle, not sine: a pure sine at this level disappears under broadband
      // engine noise, and a saw is a buzzer. A triangle keeps a little edge.
      o.type = 'triangle';
      o.frequency.setValueAtTime(hz, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 0.42);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.45);
    }
  }

  /**
   * THE SHIFT. Four things happen, in this order, and all four are needed.
   *
   *   1. TORQUE CUT. The gate slams to -22 dB in 8 ms. Not a duck to 0.28 with
   *      a 10 ms time constant, which is what v0 did and which measured as
   *      7 dB down 40 ms after the change — a sag, not a cut.
   *   2. A REAL GAP. 70 ms up, 55 ms down, held down. Nothing is playing except
   *      the tail of the exhaust and the burble, and the silence is the point:
   *      it is the only cue that the drivetrain came apart for a moment.
   *   3. THE NOTE MOVES DURING THE GAP, to the ratio the new gear implies. On
   *      an upshift it falls; on a downshift it is BLIPPED UP past the landing
   *      point and settles back, because that is what a heel-and-toe downshift
   *      does and it is the most recognisable noise in rallying. The landing
   *      pitch is computed from speed and the new gear rather than waited for,
   *      because the vehicle's own engineRpm glides there over ~110 ms and by
   *      then the shift is over.
   *   4. RE-ENGAGEMENT. The gate comes back with a 6 dB overshoot over 30 ms —
   *      driveline shunt, the shove in the back — plus a low thump and the
   *      linkage clack.
   *
   * Both the gate and the pitch are on explicit scheduled ramps, and
   * `shiftHoldUntil` stops _update writing over them. That is not a detail: a
   * setTargetAtTime from the next frame cancels a ramp outright, and the first
   * version of this cut vanished 13 ms into a 70 ms gap for exactly that reason.
   */
  _shift(up, v) {
    const ctx = this.ctx, now = ctx.currentTime;
    const rpm = this.rpm;
    const gap = up ? 0.070 : 0.055;
    this.shiftUntil = now + gap;
    this.shiftHoldUntil = now + gap + 0.09;

    // Where the note has to land: the vehicle's own gear/speed -> rpm rule,
    // evaluated for the gear it has just selected.
    const T = v.tune ?? {};
    const span = (T.topSpeed ?? 44) / 6;
    const fwd = Math.abs(v.longSpeed ?? v.speed ?? 0);
    const frac = clamp((fwd - (clamp(v.gear ?? 1, 1, 6) - 1) * span) / span, 0, 1);
    const landF = cycleHz(crankRpm(clamp(0.16 + frac * 0.86, 0.1, 1.25)));
    const nowF = cycleHz(crankRpm(rpm));

    const gate = this.torqueGate.gain;
    gate.cancelScheduledValues(now);
    gate.setValueAtTime(gate.value, now);
    gate.linearRampToValueAtTime(0.08, now + 0.008);          // the cut
    gate.setValueAtTime(0.08, now + gap);                     // the gap, held
    gate.linearRampToValueAtTime(2.0, now + gap + 0.030);     // shunt overshoot
    gate.linearRampToValueAtTime(1.0, now + gap + 0.090);

    const f = this.f0Src.offset;
    f.cancelScheduledValues(now);
    f.setValueAtTime(nowF, now);
    if (up) {
      // Falls through the gap and lands flat. The small undershoot is the
      // flywheel losing a little more than the new ratio wants before the
      // clutch picks it back up.
      f.linearRampToValueAtTime(landF * 0.965, now + gap);
      f.linearRampToValueAtTime(landF, now + gap + 0.055);
    } else {
      // The blip: up past the landing point inside the gap, caught on the way
      // back down as the clutch bites.
      f.linearRampToValueAtTime(landF * 1.10, now + gap * 0.7);
      f.linearRampToValueAtTime(landF, now + gap + 0.055);
    }

    // A supplied shift sample replaces the SOUND of the shift, never its
    // shape: the gate, the gap and the pitch trajectory above still run, so a
    // one-shot recording lands in a real hole instead of on top of the engine.
    const sample = this.sfx.get(up ? 'shift' : 'shift_down');
    if (sample?.buffer) {
      const s = ctx.createBufferSource();
      s.buffer = sample.buffer;
      const g = ctx.createGain();
      g.gain.value = 0.9;
      s.connect(g).connect(this.master);
      s.start(now);
      return;
    }

    // Exhaust burble across the gap: unburnt charge lighting in the pipe. Three
    // deterministic pops, sparser and softer on a downshift where the throttle
    // is being blipped rather than lifted.
    const pops = up ? 3 : 2;
    for (let i = 0; i < pops; i++) {
      this._popAt(now + 0.010 + i * 0.020 + this.rand() * 0.012,
                  (0.05 + this.rand() * 0.06) * (0.4 + rpm),
                  900 + this.rand() * 2200, 0.030);
    }

    // Re-engagement thump: the driveline taking up its slack. Lands on the
    // moment the gate comes back, or it reads as a separate noise.
    const th = ctx.createOscillator();
    th.type = 'sine';
    const tg = ctx.createGain();
    th.frequency.setValueAtTime(92, now + gap);
    th.frequency.exponentialRampToValueAtTime(46, now + gap + 0.10);
    tg.gain.setValueAtTime(0.0001, now + gap);
    tg.gain.exponentialRampToValueAtTime(0.13 * (0.45 + rpm), now + gap + 0.006);
    tg.gain.exponentialRampToValueAtTime(0.0001, now + gap + 0.16);
    th.connect(tg).connect(this.master);
    th.start(now + gap); th.stop(now + gap + 0.18);

    const o = ctx.createOscillator();            // a soft clack from the linkage
    o.type = 'triangle';
    const g = ctx.createGain();
    o.frequency.setValueAtTime(up ? 210 : 260, now);
    o.frequency.exponentialRampToValueAtTime(90, now + 0.06);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.055 * (0.5 + rpm), now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    o.connect(g).connect(this.master);
    o.start(now); o.stop(now + 0.11);
  }

  /** A short filtered-noise burst. Used for crackle, chuff and debris. */
  _pop(amp, freq, dur, type = 'bandpass') {
    this._popAt(this.ctx.currentTime, amp, freq, dur, type);
  }

  /**
   * The same burst at a scheduled time. The shift burble needs three of them
   * spread across a 70 ms gap that has not happened yet, and firing them all at
   * currentTime turns a burble into one thicker pop.
   */
  _popAt(now, amp, freq, dur, type = 'bandpass') {
    const ctx = this.ctx;
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

/**
 * Four cylinders as they actually are: not identical.
 *
 * Each gets a firing phase (fraction of one four-stroke CYCLE — two crank
 * revolutions — so an even four-pot would be at 0, 0.25, 0.5, 0.75) and a
 * strength. The deviations are drawn once from a seeded stream and reused by
 * every wave table, because these four cylinders are this car's engine and
 * must not change when the load does.
 *
 * Magnitudes: +-18% on strength and +-1.4% of a cycle on timing, which is about
 * 5 degrees of crank. That is generous for a production motor and about right
 * for a rally engine on individual throttle bodies, which is the one we want.
 */
function makeCylinders(n, r) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      nominal: i / n,
      dPhase: (r() * 2 - 1) * 0.014,
      dAmp: (r() * 2 - 1) * 0.18,
    });
  }
  return out;
}

/**
 * Build the harmonic table of one four-stroke cycle by summing the cylinders'
 * exhaust pulses in the frequency domain, and hand it to WebAudio as a
 * PeriodicWave.
 *
 * WHY THIS AND NOT A STACK OF OSCILLATORS. If the four cylinders were
 * identical, the sum over them cancels for every harmonic that is not a
 * multiple of 4 and you are left with the firing frequency and its overtones —
 * a clean, synthetic, four-per-cycle buzz, which is exactly what the old
 * five-oscillator stack was. It is the DEVIATIONS that leak energy into
 * harmonics 1, 2, 3, 5, 6, 7: content at half and quarter of the firing
 * frequency, repeating once per two crank revolutions. That lumpiness is not a
 * flaw being modelled for flavour, it is the largest single perceptual cue that
 * a sound is an engine. Getting it by construction means it stays correct at
 * every rpm for free, where hand-placed detuned oscillators do not.
 *
 * `sigma` is the pulse width as a fraction of the cycle (wide = dull), `tilt`
 * the harmonic roll-off exponent, `lump` a scale on the cylinder deviations.
 * One PeriodicWave is built per load state; none of this runs per frame.
 */
function makeEngineWave(ctx, cylinders, { sigma, tilt, lump, harmonics = 160 }) {
  const re = new Float32Array(harmonics + 1);
  const im = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    // Pulse spectrum: a power-law body for the sharp leading edge of blowdown,
    // times a gaussian that stops it running to Nyquist as pure fizz.
    const g = Math.pow(n, -tilt) * Math.exp(-(n * sigma) * (n * sigma));
    let sr = 0, si = 0;
    for (const c of cylinders) {
      const a = 2 * Math.PI * n * (c.nominal + c.dPhase * lump);
      const amp = 1 + c.dAmp * lump;
      sr += amp * Math.cos(a);
      si += amp * Math.sin(a);
    }
    re[n] = g * sr;
    im[n] = g * si;
  }
  // Normalised, so the three tables sit at the same loudness and the load
  // crossfade changes timbre without changing level.
  return ctx.createPeriodicWave(re, im, { disableNormalization: false });
}

/**
 * Gearbox tooth-mesh orders, first to sixth: how many times per crank
 * revolution the engaged pair meshes. Falls as the gears get taller, which is
 * why a straight-cut box whines lower in the higher gears and why stepping this
 * with the gear is what makes it read as a transmission rather than a tone.
 */
const GEAR_MESH = [15.5, 13.2, 11.6, 10.4, 9.6, 9.0];

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
