/**
 * THE DRIVE TAPE — one scripted lap of the throttle, shared by the renderer and
 * the analyser so both are talking about the same seconds of audio.
 *
 * WHY THE REAL VEHICLE AND NOT A HAND-DRAWN RPM CURVE.
 *
 * audio.js is handed the live Vehicle object and reads a dozen fields off it —
 * engineRpm, gear, speed, pitchAccel, wheelSpinBoost, wheelSlip. Faking those by
 * hand means measuring the synth against a state vector the game never actually
 * produces: hand-drawn rpm rises smoothly through a shift, whereas the real
 * gearbox snaps the gear and lets engineRpm glide with a ~110 ms time constant,
 * and that glide is precisely what the shift has to sound convincing over. So
 * the tape is INPUT — throttle, brake, steer, handbrake against time — and the
 * shipped vehicle model turns it into the state audio.js will really see.
 *
 * Deterministic by construction: Vehicle.step is pure given its inputs, the
 * step is fixed at 1/120 s, and nothing here calls Math.random or Date.now.
 */

import { Vehicle } from '../src/entities/vehicle.js';

export const TAPE_DT = 1 / 120;        // physics step; the game runs fixed-step too
export const TAPE_SECONDS = 15;

/**
 * Control rate — how often audio.update() is called. 75 Hz, not 60, for a
 * mechanical reason: the offline renderer parks the render clock at each frame
 * boundary, and WebAudio only suspends on a render-quantum (128-sample) edge.
 * 48000/75 = 640 = 5 quanta exactly; 48000/60 = 800 is 6.25 quanta and Chromium
 * refuses it. The synth smooths every control it touches with setTargetAtTime,
 * so 13.3 ms versus 16.7 ms between updates changes nothing it can hear.
 */
export const CONTROL_HZ = 75;

/**
 * The script, in plain words:
 *   0.0- 1.2  idle, stationary — the sound you hear most and judge first
 *   1.2- 8.5  wide open from rest to top speed — every upshift, 1 through 6
 *   8.5-11.2  throttle shut at speed — overrun, engine braking, downshifts
 *  11.2-13.0  brakes on down to a crawl — the last downshifts, load still zero
 *  13.0-15.0  idle again, so before/after can be compared at both ends
 *
 * A gentle steer is held through the pull so wheelSlip and driftAngle are not
 * identically zero; the tyre channel is not under test but it must not be
 * silent, or the mix balance measured here would not be the mix that ships.
 */
export function inputAt(t) {
  const z = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  if (t < 1.2) return z;
  if (t < 8.5) return { throttle: 1, brake: 0, steer: 0.12 * Math.sin(t * 0.8), handbrake: 0 };
  if (t < 11.2) return { throttle: 0, brake: 0, steer: 0.10 * Math.sin(t * 0.8), handbrake: 0 };
  if (t < 13.0) return { throttle: 0, brake: 0.55, steer: 0, handbrake: 0 };
  return z;
}

/**
 * Run the tape and return one record per CONTROL frame (60 Hz — the rate
 * audio.update is called at in the game), plus the gear-change times the
 * analyser needs to know where to look for the shift interruption.
 */
export function renderTape({ controlHz = CONTROL_HZ, seconds = TAPE_SECONDS } = {}) {
  const v = new Vehicle();
  v.reset(0, 0, 0);

  const frames = [];
  const shifts = [];
  const controlDt = 1 / controlHz;
  const subSteps = Math.max(1, Math.round(controlDt / TAPE_DT));
  const dt = controlDt / subSteps;
  const n = Math.round(seconds * controlHz);

  let lastGear = v.gear;
  for (let i = 0; i < n; i++) {
    const t = i * controlDt;
    for (let s = 0; s < subSteps; s++) v.step(dt, inputAt(t + s * dt));
    if (v.gear !== lastGear) {
      shifts.push({ t, from: lastGear, to: v.gear, up: v.gear > lastGear });
      lastGear = v.gear;
    }
    frames.push({
      t,
      // Exactly the fields audio.js reads, and nothing else — if the synth
      // starts reading something new this list has to grow with it.
      speed: v.speed,
      longSpeed: v.longSpeed,
      engineRpm: v.engineRpm,
      gear: v.gear,
      driftAngle: v.driftAngle,
      wheelSlip: v.wheelSlip.slice(),
      wheelSpinBoost: v.wheelSpinBoost,
      pitchAccel: v.pitchAccel,
      // The whole tune, because the synth's load estimator runs the vehicle's
      // own resistance and drive arithmetic backwards and needs all of it.
      tune: { ...v.tune },
    });
  }
  return { frames, shifts, controlHz, controlDt, seconds };
}
