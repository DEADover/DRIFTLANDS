#!/usr/bin/env node
/**
 * ENGINE ANALYSIS
 * ---------------
 * Reads WAVs written by audio-render.mjs and prints objective measures, one
 * column per file, so "it sounds better" can be argued about with numbers.
 *
 * Usage:
 *   node tools/audio-analyse.mjs shots/audio/before_engine.wav shots/audio/after_engine.wav
 *
 * Every measure below answers one question a listener would ask, and each is
 * documented at its implementation with what a good and a bad value look like.
 * They are evidence, not a target: a synth can be tuned to win any single one
 * of them and still sound like a wasp in a jar.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: node tools/audio-analyse.mjs <a.wav> [b.wav ...]');
  process.exit(2);
}

// 2.9 Hz bins at 48 k. 8192 was not enough at the bottom: an idling four-pot
// fires at 32 Hz, which is five bins wide at 8192, and the harmonic-to-noise
// figure for the idle window flipped between 3 dB and 59 dB on a 5 dB change in
// noise level — the estimator, not the audio. It is stable at 16384.
const FFT = 16384;
const HOP = 2048;          // 43 ms, fine enough to see a 60 ms torque cut

// The engine's real rev range, used to turn the vehicle's normalised engineRpm
// into a crank speed. Nothing in the game states these; they are the analyser's
// own yardstick and both columns are held to the same one.
// These MUST match the constants at the top of src/audio/audio.js: the whole
// point of the pitch-tracking figure is that both the old and the new engine
// are held to the same interpretation of `engineRpm`.
const IDLE_RPM = 950;
const REDLINE_RPM = 7000;
const RPM_LO = 0.16;       // engineRpm at a standstill
const RPM_HI = 1.00;
const CYLINDERS = 4;       // four-stroke: firing rate = rev/s * cylinders/2

const cols = [];
for (const f of files) cols.push(await analyse(f));
report(cols);

// ---------------------------------------------------------------- measurement

async function analyse(file) {
  const p = path.isAbsolute(file) ? file : path.join(ROOT, file);
  const { data, rate } = parseWav(await readFile(p));
  let tape = null;
  try { tape = JSON.parse(await readFile(p.replace(/\.wav$/, '.tape.json'), 'utf8')); } catch {}

  const win = hann(FFT);
  const nFrames = Math.floor((data.length - FFT) / HOP);
  const frames = [];
  for (let i = 0; i < nFrames; i++) {
    const off = i * HOP;
    const re = new Float64Array(FFT);
    const im = new Float64Array(FFT);
    for (let j = 0; j < FFT; j++) re[j] = data[off + j] * win[j];
    fft(re, im);
    const mag = new Float64Array(FFT / 2);
    for (let k = 0; k < FFT / 2; k++) mag[k] = Math.hypot(re[k], im[k]);

    const t = (off + FFT / 2) / rate;
    let rms = 0;
    for (let j = 0; j < FFT; j++) rms += data[off + j] * data[off + j];
    frames.push({ t, mag, rms: Math.sqrt(rms / FFT), commanded: commandedF0(tape, t), rpmN: rpmAt(tape, t) });
  }

  const binHz = rate / FFT;
  for (const f of frames) {
    // TWO estimates, for two different jobs.
    //
    // f0raw is a WIDE search (+-2.5x) — it is allowed to find the note wherever
    // the engine actually put it, which is what the harmonic-to-noise and
    // half-order measures need: both slice the spectrum at multiples of the
    // note, and slicing at the wrong place turns them into noise.
    //
    // f0trk is a NARROW search (+-1.7x) used only for pitch span and linearity,
    // where the question is how well the note follows the commanded rpm and a
    // sub-octave candidate is a measurement error rather than a pitch. Both
    // columns get both windows.
    f.f0raw = estimateF0(f.mag, binHz, f.commanded, 2.5);
    f.f0trkRaw = estimateF0(f.mag, binHz, f.commanded, 1.7);
    f.order = commandedOrderStrength(f.mag, binHz, f.commanded);
  }
  // Median of five over the raw estimate. Adding real half-order content — the
  // whole point of the new wave tables — gives a harmonic-product-spectrum a
  // credible candidate an octave below the note, and it takes it on isolated
  // frames. Those single-frame octave drops are an artefact of the measurement,
  // not a pitch the engine ever plays, and they wreck both the span and the r2.
  for (let i = 0; i < frames.length; i++) {
    for (const [src, dst] of [['f0raw', 'f0'], ['f0trkRaw', 'f0trk']]) {
      const w = [];
      for (let d = -2; d <= 2; d++) if (frames[i + d]) w.push(frames[i + d][src]);
      w.sort((a, b) => a - b);
      frames[i][dst] = w[w.length >> 1];
    }
  }
  for (const f of frames) {
    f.centroid = centroid(f.mag, binHz);
    f.hnr = harmonicToNoise(f.mag, binHz, f.f0);
    f.halfOrder = halfOrderRatio(f.mag, binHz, f.f0);
  }

  // Windows of the tape, chosen from the script in audio-tape.mjs.
  const IDLE = [0.3, 1.1];
  const PULL = [3.0, 8.3];
  const OVERRUN = [8.9, 11.1];

  return {
    name: path.basename(file),
    rate,
    seconds: data.length / rate,
    frames,
    tape,
    peakDb: db(peak(data)),
    rmsDb: db(rmsOf(data)),
    crestDb: db(peak(data) / (rmsOf(data) || 1e-9)),
    pitchSpanOct: pitchSpan(frames),
    pitchLinearity: pitchLinearity(frames),
    hnrIdle: mean(pick(frames, IDLE).map((f) => f.hnr)),
    hnrPull: mean(pick(frames, PULL).map((f) => f.hnr)),
    hnrOverrun: mean(pick(frames, OVERRUN).map((f) => f.hnr)),
    centroidIdle: mean(pick(frames, IDLE).map((f) => f.centroid)),
    centroidPull: mean(pick(frames, PULL).map((f) => f.centroid)),
    centroidOverrun: mean(pick(frames, OVERRUN).map((f) => f.centroid)),
    halfOrder: mean(pick(frames, PULL).map((f) => f.halfOrder)),
    orderStrength: mean(frames.filter((f) => f.rms > 1e-4).map((f) => f.order)),
    orderLo: mean(frames.filter((f) => f.rms > 1e-4 && f.rpmN < 0.45).map((f) => f.order)),
    orderHi: mean(frames.filter((f) => f.rms > 1e-4 && f.rpmN > 0.80).map((f) => f.order)),
    brightSlope: brightnessSlope(frames),
    shift: shiftAnalysis(data, rate, tape),
  };
}

/**
 * Commanded firing frequency at time t, straight from the tape's engineRpm.
 * This is the ground truth the audible pitch is checked against; deriving it
 * from the audio instead would make the whole tracking measure circular.
 */
function rpmAt(tape, t) {
  if (!tape?.frames?.length) return 0;
  const i = Math.min(tape.frames.length - 1, Math.max(0, Math.round(t * tape.controlHz)));
  return tape.frames[i].rpm;
}

function commandedF0(tape, t) {
  if (!tape?.frames?.length) return null;
  const i = Math.min(tape.frames.length - 1, Math.max(0, Math.round(t * tape.controlHz)));
  const rpmN = tape.frames[i].rpm;
  const rpm = IDLE_RPM + ((Math.max(RPM_LO, Math.min(1.25, rpmN)) - RPM_LO) / (RPM_HI - RPM_LO))
            * (REDLINE_RPM - IDLE_RPM);
  return (rpm / 60) * (CYLINDERS / 2);
}

/**
 * Fundamental estimate by harmonic-product-spectrum, seeded near the commanded
 * value. HPS is used rather than a plain peak-pick because the loudest bin in
 * an engine spectrum is routinely the 2nd or 3rd harmonic — an exhaust
 * resonance sitting on one of them — and a peak-picker reports the octave
 * error as a pitch jump that is not there.
 */
function estimateF0(mag, binHz, seed, span) {
  // `span` sets how far from the commanded value the note may be found; see
  // the two call sites. pitchSpan/pitchLinearity additionally only look at
  // frames above 60 Hz commanded, where the OLD engine's own pitch error still
  // falls inside the narrow window — so the window cannot flatter the new one.
  const lo = seed ? seed / span : 20;
  const hi = seed ? seed * span : 400;
  let best = 0, bestScore = -1;
  const k0 = Math.max(2, Math.floor(lo / binHz));
  const k1 = Math.min(mag.length / 6, Math.ceil(hi / binHz));
  for (let k = k0; k <= k1; k++) {
    let s = 0;
    for (let h = 1; h <= 6; h++) {
      const kk = k * h;
      if (kk >= mag.length) break;
      // Take the local max over ±1 bin so a fundamental sitting between bins is
      // not penalised at its higher harmonics, where the error multiplies.
      s += Math.log(1e-9 + Math.max(mag[kk - 1], mag[kk], mag[kk + 1]));
    }
    if (s > bestScore) { bestScore = s; best = k; }
  }
  return best * binHz;
}

/**
 * How much louder the spectrum is AT the commanded firing frequency and its
 * first two harmonics than the smooth envelope passing through those points.
 *
 * This is the pitch-tracking question asked without an f0 detector, and so
 * without any octave ambiguity: if the note you hear really is the rpm the game
 * says, there is a sharp peak exactly at rpm/60 x 2, and this is large. If the
 * synth put its note somewhere else — anywhere else — the commanded frequency
 * lands on the shoulder of a peak or between two, and this collapses toward
 * zero. It cannot be gamed by simply having a loud spectrum; it is a
 * peak-to-local-envelope ratio.
 */
function commandedOrderStrength(mag, binHz, f) {
  if (!(f > 0)) return 0;
  let acc = 0, n = 0;
  for (let h = 1; h <= 3; h++) {
    const k = Math.round((h * f) / binHz);
    // k >= 14 so the +-11-bin side band cannot run off the front of the
    // spectrum. At idle the firing note is 32 Hz — under three bins — so the
    // first harmonic is simply not measurable there and h=2,3 carry it.
    if (k < 14 || k > mag.length - 12) continue;
    const at = Math.max(mag[k - 1], mag[k], mag[k + 1]) ** 2;
    // Local envelope: the median of a band either side, far enough out to miss
    // the peak itself but close enough to be the same region of the spectrum.
    const side = [];
    for (let d = 4; d <= 11; d++) { side.push(mag[k - d] ** 2); side.push(mag[k + d] ** 2); }
    side.sort((a, b) => a - b);
    acc += 10 * Math.log10((at + 1e-14) / (side[side.length >> 1] + 1e-14));
    n++;
  }
  return n ? acc / n : 0;
}

/** Energy-weighted mean frequency: the single number that means "brightness". */
function centroid(mag, binHz) {
  let num = 0, den = 0;
  for (let k = 1; k < mag.length; k++) {
    const e = mag[k] * mag[k];
    num += e * k * binHz;
    den += e;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Harmonic-to-noise ratio in dB: energy within ±1.5 bins of a harmonic of f0,
 * against everything else below 8 kHz. High means a pitched, mechanical sound;
 * low means hiss and roar. An engine wants a LOT of harmonic energy at low revs
 * and noticeably less at full load, where induction roar is genuinely part of it.
 *
 * TRUST THIS ONE LEAST, and do not read the overrun figure at all for an engine
 * with strong half-order content. It depends entirely on f0 being right, and
 * where the cylinder unevenness is largest — which is on overrun, by design —
 * the harmonic-product-spectrum has a credible candidate an octave down and
 * takes it. The harmonic mask then lands on the half-orders and most of the
 * real energy is counted as noise. Verified: cutting the overrun noise floor by
 * 8 dB, gating the induction band and doubling the crackle each moved this
 * number by 0.0 dB. Use the spectral centroid contrast to judge whether the
 * note hollows out on a shut throttle; it needs no pitch estimate.
 */
function harmonicToNoise(mag, binHz, f0) {
  if (!(f0 > 0)) return 0;
  const kMax = Math.min(mag.length - 2, Math.floor(8000 / binHz));
  const isHarm = new Uint8Array(kMax + 2);
  for (let h = 1; h * f0 < 8000; h++) {
    const k = Math.round((h * f0) / binHz);
    for (let d = -1; d <= 1; d++) if (k + d > 0 && k + d <= kMax) isHarm[k + d] = 1;
  }
  let hE = 0, nE = 0;
  for (let k = 1; k <= kMax; k++) {
    const e = mag[k] * mag[k];
    if (isHarm[k]) hE += e; else nE += e;
  }
  return 10 * Math.log10((hE + 1e-12) / (nE + 1e-12));
}

/**
 * Energy at the half-orders (0.5x, 1.5x, 2.5x the firing frequency) relative to
 * the whole-orders, in dB. This is the cylinder-to-cylinder unevenness: a
 * perfectly even four-pot repeats once per firing event and has none, a real
 * one repeats once per two crank revolutions and has plenty. It is the single
 * measure that most separates "engine" from "oscillator".
 */
function halfOrderRatio(mag, binHz, f0) {
  if (!(f0 > 0)) return -60;
  const at = (f) => {
    const k = Math.round(f / binHz);
    if (k < 1 || k >= mag.length - 1) return 0;
    return Math.max(mag[k - 1], mag[k], mag[k + 1]) ** 2;
  };
  let half = 0, whole = 0;
  for (let h = 1; h <= 6; h++) {
    whole += at(f0 * h);
    half += at(f0 * (h - 0.5));
  }
  return 10 * Math.log10((half + 1e-12) / (whole + 1e-12));
}

/**
 * How far the audible pitch travels from idle to redline, in octaves, and how
 * closely it follows the commanded rpm.
 *
 * A real crank sweeping 950 to 7200 rpm moves 2.92 octaves. A synth whose
 * fundamental is `constant + k*rpm` moves much less, and — worse — moves the
 * wrong AMOUNT per unit rpm at each end, so the car sounds like it is already
 * revving hard when it is idling. Measured against the commanded curve rather
 * than against an absolute, because only the ratio is audible.
 */
function pitchSpan(frames) {
  const f = frames.filter((x) => x.f0trk > 20 && x.commanded >= 60).map((x) => x.f0trk).sort((a, b) => a - b);
  if (f.length < 20) return 0;
  const lo = f[Math.floor(f.length * 0.03)];
  const hi = f[Math.floor(f.length * 0.97)];
  return Math.log2(hi / lo);
}

/** r^2 of log(measured f0) against log(commanded f0). 1.0 = pitch is rpm. */
function pitchLinearity(frames) {
  const pts = frames.filter((x) => x.f0trk > 20 && x.commanded >= 60 && x.rms > 1e-4)
    .map((x) => [Math.log(x.commanded), Math.log(x.f0trk)]);
  if (pts.length < 20) return 0;
  const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return (sxy * sxy) / ((sxx * syy) || 1e-12);
}

/**
 * How much of the pitch change the BRIGHTNESS follows: the slope of
 * log2(spectral centroid) against log2(commanded firing frequency), over the
 * full-throttle pull so load is held still.
 *
 * A slope of 1.0 means the entire spectrum transposes with the revs — double
 * the rpm, double every frequency in the sound, relative levels untouched. That
 * is what a filter stack whose every cutoff is proportional to f0 produces, and
 * it is why such an engine reads as one timbre being pitch-shifted. A fixed
 * exhaust cannot do that: its resonances hold energy at the frequencies the
 * geometry puts them at, so the centroid rises noticeably LESS than the pitch
 * does, and harmonics get loud and quiet as they sweep through the modes.
 * Real engine recordings sit around 0.4-0.7.
 *
 * Uses the commanded frequency, so no pitch detector is involved and neither
 * column can be flattered or punished by the choice of search window.
 */
function brightnessSlope(frames) {
  const set = frames.filter((f) => f.commanded > 0 && f.centroid > 0 && f.rms > 1e-5
                                   && f.t >= 1.4 && f.t <= 8.3);
  if (set.length < 20) return 0;
  const xs = set.map((f) => Math.log2(f.commanded));
  const ys = set.map((f) => Math.log2(f.centroid));
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  return sxy / (sxx || 1e-12);
}

function smoothLog(power, binHz, octaves) {
  const out = new Float64Array(power.length);
  const half = Math.pow(2, octaves / 2);
  for (let k = 1; k < power.length; k++) {
    const k0 = Math.max(1, Math.floor(k / half));
    const k1 = Math.min(power.length - 1, Math.ceil(k * half));
    let s = 0;
    for (let j = k0; j <= k1; j++) s += power[j];
    out[k] = s / (k1 - k0 + 1);
  }
  return out;
}

/**
 * The shift, measured as a listener hears it: how far the level drops and for
 * how long.
 *
 * WINDOW LENGTH IS THE WHOLE PROBLEM. The first version tracked a 3 ms RMS and
 * reported that every upshift was 20 dB down for 320 ms, which is nonsense: at
 * 45 Hz the waveform's own period is 22 ms, so a 3 ms window was reporting the
 * troughs between exhaust pulses as level drops. 25 ms spans at least one cycle
 * everywhere in the rev range. It does blunt a very short gap — a 60 ms cut
 * reads a few dB shallower than it is — but it blunts both columns equally, and
 * a measure that cannot tell a gap from a waveform is worth nothing.
 *
 * The pre-shift reference is the MEDIAN of the preceding 120 ms for the same
 * reason: the maximum picks whatever ripple crest happened to land there.
 *
 * A crossfade between two ratios shows up here as a shallow dip of a few dB and
 * a duration of 0 ms — nothing actually stops, which is why it reads as a
 * synthesiser sliding rather than a clutch coming out.
 */
function shiftAnalysis(data, rate, tape) {
  if (!tape?.shifts?.length) return { count: 0, depthDb: 0, durMs: 0, per: [] };
  const W = Math.round(rate * 0.025);
  const envAt = (t) => {
    const i = Math.max(0, Math.min(data.length - W - 1, Math.round(t * rate - W / 2)));
    let s = 0;
    for (let j = 0; j < W; j++) s += data[i + j] * data[i + j];
    return Math.sqrt(s / W);
  };
  const per = [];
  for (const sh of tape.shifts) {
    const before = [];
    for (let t = sh.t - 0.12; t < sh.t; t += 0.004) before.push(envAt(t));
    before.sort((a, b) => a - b);
    const ref = before[Math.floor(before.length / 2)] || 1e-9;
    let minE = Infinity, minT = sh.t;
    for (let t = sh.t; t < sh.t + 0.25; t += 0.002) {
      const e = envAt(t);
      if (e < minE) { minE = e; minT = t; }
    }
    let dur = 0;
    for (let t = sh.t; t < sh.t + 0.35; t += 0.002) if (db(envAt(t) / ref) < -6) dur += 0.002;
    // Depth 40 ms in separates a CUT from a SAG. A dropped clutch is already
    // most of the way down after 40 ms; an engine level that is merely
    // following rpm downhill has barely moved. Both can end up at the same
    // minimum, and they sound nothing alike.
    per.push({
      t: sh.t, up: sh.up, minT,
      depthDb: db(minE / ref), durMs: dur * 1000, d40Db: db(envAt(sh.t + 0.04) / ref),
    });
  }
  return {
    count: per.length,
    depthDb: mean(per.map((p) => p.depthDb)),
    durMs: mean(per.map((p) => p.durMs)),
    d40Db: mean(per.map((p) => p.d40Db)),
    per,
  };
}

// ------------------------------------------------------------------ reporting

function report(cols) {
  const W = 22;
  const pad = (s) => String(s).padStart(W);
  const row = (label, vals, note) => {
    console.log('  ' + label.padEnd(28) + vals.map(pad).join('') + (note ? '   ' + note : ''));
  };
  const rule = () => console.log('  ' + '-'.repeat(28 + W * cols.length));

  console.log('\nENGINE MEASUREMENTS  (' + cols[0].seconds.toFixed(1) + ' s tape, ' + cols[0].rate + ' Hz)\n');
  row('', cols.map((c) => c.name));
  rule();
  // PITCH TRACKING is reported as commanded-order gain and not as a detected
  // f0. A harmonic-product-spectrum has to be told how far from the commanded
  // frequency it may look, and that choice alone moved the old engine's
  // measured pitch span between 1.9 and 2.3 octaves — the window, not the
  // audio. Order gain needs no detector: it asks whether there is a peak
  // exactly where the rpm says the firing note should be, and splitting it by
  // rev band is what exposes a pitch that is affine in rpm rather than
  // proportional to it, because such a synth can only be right in the middle.
  row('order gain, low rev, dB', cols.map((c) => c.orderLo.toFixed(1)));
  row('order gain, high rev, dB', cols.map((c) => c.orderHi.toFixed(1)));
  row('order gain, overall, dB', cols.map((c) => c.orderStrength.toFixed(1)));
  row('half-order energy, dB', cols.map((c) => c.halfOrder.toFixed(1)));
  rule();
  row('HNR idle, dB', cols.map((c) => c.hnrIdle.toFixed(1)));
  row('HNR full load, dB', cols.map((c) => c.hnrPull.toFixed(1)));
  row('HNR overrun, dB', cols.map((c) => c.hnrOverrun.toFixed(1)));
  row('load->overrun HNR swing', cols.map((c) => (c.hnrOverrun - c.hnrPull).toFixed(1)));
  rule();
  row('centroid idle, Hz', cols.map((c) => c.centroidIdle.toFixed(0)));
  row('centroid full load, Hz', cols.map((c) => c.centroidPull.toFixed(0)));
  row('centroid overrun, Hz', cols.map((c) => c.centroidOverrun.toFixed(0)));
  row('load/overrun brightness', cols.map((c) => (c.centroidPull / (c.centroidOverrun || 1)).toFixed(2) + 'x'));
  rule();
  row('brightness/pitch slope', cols.map((c) => c.brightSlope.toFixed(2)));
  rule();
  row('shift depth, dB', cols.map((c) => c.shift.depthDb.toFixed(1)));
  row('shift depth @40ms, dB', cols.map((c) => c.shift.d40Db.toFixed(1)));
  row('shift duration, ms', cols.map((c) => c.shift.durMs.toFixed(0)));
  rule();
  row('peak, dBFS', cols.map((c) => c.peakDb.toFixed(1)));
  row('rms, dBFS', cols.map((c) => c.rmsDb.toFixed(1)));
  row('crest factor, dB', cols.map((c) => c.crestDb.toFixed(1)));
  console.log('');

  // Per-shift detail: the average hides an upshift that works and a downshift
  // that does not.
  console.log('  per-shift interruption: dB at +40 ms | deepest dB / ms held below -6 dB');
  const n = Math.max(...cols.map((c) => c.shift.per.length));
  for (let i = 0; i < n; i++) {
    const label = cols[0].shift.per[i];
    console.log('    ' + `${label ? label.t.toFixed(2) + 's ' + (label.up ? 'up  ' : 'down') : '?'}`.padEnd(28) +
      cols.map((c) => {
        const p = c.shift.per[i];
        return String(p ? `${p.d40Db.toFixed(0)}|${p.depthDb.toFixed(0)}dB/${p.durMs.toFixed(0)}ms` : '-').padStart(W);
      }).join(''));
  }
  console.log('');
}

// ----------------------------------------------------------------- primitives

function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF file');
  let pos = 12, rate = 48000, bits = 16, ch = 1, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') { ch = buf.readUInt16LE(pos + 10); rate = buf.readUInt32LE(pos + 12); bits = buf.readUInt16LE(pos + 22); }
    else if (id === 'data') { data = buf.subarray(pos + 8, pos + 8 + size); }
    pos += 8 + size + (size & 1);
  }
  if (!data) throw new Error('no data chunk');
  if (bits !== 16) throw new Error('expected 16-bit PCM');
  const n = Math.floor(data.length / 2 / ch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2 * ch) / 32768;
  return { data: out, rate };
}

/** In-place radix-2 FFT. No dependency, and the sizes here are always 2^n. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

function db(x) { return 20 * Math.log10(Math.max(1e-12, x)); }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function pick(frames, [a, b]) { return frames.filter((f) => f.t >= a && f.t <= b); }
function peak(d) { let m = 0; for (let i = 0; i < d.length; i++) { const x = Math.abs(d[i]); if (x > m) m = x; } return m; }
function rmsOf(d) { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / d.length); }
