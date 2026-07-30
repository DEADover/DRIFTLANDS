#!/usr/bin/env node
/**
 * WHAT THE CAMERA ACTUALLY SHOWS
 * ------------------------------
 * The client says: "at high speed the car stays in the middle of the screen ...
 * less of the track already driven should be visible and the user should see
 * more of the road ahead." That is a claim about METRES OF ROAD, so this
 * measures metres of road.
 *
 * Boots the real build headless (same harness as tools/probe.mjs), drives the
 * route autopilot for 90 s at a fixed 1/120 step, and every frame:
 *
 *   - projects the car through the LIVE camera to normalised device coords, so
 *     "where the car sits in frame" is a number, not an impression;
 *   - walks the road centreline forward and backward from the car and counts
 *     the CONTIGUOUS metres that are inside the frustum. Ahead vs behind is the
 *     headline: it is the client's sentence, in metres;
 *   - counts frames with the car outside the frame (budget: 0 — a previous
 *     round took this from 97/3600 to 0/4800 and it may not go back up);
 *   - records the worst single-frame change in camera yaw, pitch and FOV (the
 *     FOV rate was brought from 1.744 to 0.077 deg/frame; it may not get worse).
 *
 *   node tools/camera-test.mjs --base http://127.0.0.1:5217
 *   node tools/camera-test.mjs --json before.json
 *   node tools/camera-test.mjs --baseline before.json      # print before/after
 *
 * Deterministic: fixed step, seeded world, no wall clock read anywhere in the
 * measurement.
 */
import { chromium } from 'playwright';
import { writeFile, readFile } from 'node:fs/promises';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5217', preset: 'hero_alpine', seconds: 90 };
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--preset') args.preset = av[++i];
  else if (a === '--seconds') args.seconds = Number(av[++i]);
  else if (a === '--json') args.json = av[++i];
  else if (a === '--baseline') args.baseline = av[++i];
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${args.base}/?shot=${args.preset}&hud=0`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 180000 });

const report = await page.evaluate(async ({ seconds }) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const g = window.__GAME;
  const cam = g.camera.camera;
  const DT = 1 / 120;
  const frames = Math.round(seconds / DT);

  const S = g.roads._samples;
  const DS = g.roads._ds ?? 1;
  // How far to walk before giving up. The frame is under 120 m deep at any
  // speed, so 260 m each way can never clip a real answer.
  const WALK = Math.ceil(260 / DS);

  const v3 = new THREE.Vector3();
  const fwdV = new THREE.Vector3();

  const inFrustum = (x, y, z) => {
    v3.set(x, y, z).project(cam);
    return Math.abs(v3.x) <= 1 && Math.abs(v3.y) <= 1 && v3.z >= -1 && v3.z <= 1;
  };

  // Road height, with the terrain as the fallback off the ribbon.
  const roadY = (x, z) => g.roads.heightAt?.(x, z) ?? g.groundAt(x, z).height;

  let nearIdx = 0;
  const nearest = (x, z) => {
    const n = S.length;
    let bi = nearIdx, bd = Infinity;
    for (let k = nearIdx - 120; k <= nearIdx + 120; k++) {
      const i = ((k % n) + n) % n;
      const dx = x - S[i].x, dz = z - S[i].z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    if (bd > 200 * 200) {
      for (let i = 0; i < n; i++) {
        const dx = x - S[i].x, dz = z - S[i].z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; bi = i; }
      }
    }
    nearIdx = bi;
    return bi;
  };

  /** Contiguous metres of centreline inside the frustum, walking with `step`. */
  const walk = (i0, step) => {
    const n = S.length;
    for (let k = 1; k <= WALK; k++) {
      const i = (((i0 + step * k) % n) + n) % n;
      const s = S[i];
      if (!inFrustum(s.x, roadY(s.x, s.z), s.z)) return (k - 1) * DS;
    }
    return WALK * DS;
  };

  const bands = { low: [], mid: [], high: [] };
  const push = (speed, row) => {
    (speed < 12 ? bands.low : speed < 25 ? bands.mid : bands.high).push(row);
  };

  let offFrame = 0, offFrameCorner = 0, sampled = 0;
  let prevYaw = null, prevPitch = null, prevFov = cam.fov;
  let worstYaw = 0, worstPitch = 0, worstFov = 0;
  // Camera shake displaces the eye, so a post-impact frame dominates any
  // worst-case jerk figure and tells you nothing about the FRAMING. Track the
  // quiet frames separately — that is the number the framing change owns.
  //
  // And note what the yaw/pitch numbers can and cannot say: this camera is
  // WORLD-FIXED (followYaw 0), so its heading is a constant and the only thing
  // that moves it is the shake offset. Measured, the worst per-frame yaw change
  // on a shake-free frame is 0.0002 deg. So yaw and pitch are a shake meter,
  // not a smoothness meter. What actually has to stay smooth is the FOCUS
  // POINT, because that is what translates the frame — so track its per-frame
  // step (m/frame) and, more to the point, the change in that step from one
  // frame to the next, which is the frame's acceleration and is what a player
  // reads as a jerk.
  let calmYaw = 0, calmPitch = 0, calmFrames = 0;
  let prevFocus = null, prevStep = null, worstStep = 0, worstAccel = 0;
  const fTmp = { x: 0, z: 0 };
  const ndcY = [], ndcX = [];

  for (let f = 0; f < frames; f++) {
    g.update(DT, g.autopilotInput({ throttle: 1, aggression: 0.85 }));
    const v = g.vehicle;

    // --- camera smoothness, every single frame -----------------------------
    cam.getWorldDirection(fwdV);
    const yaw = Math.atan2(fwdV.x, fwdV.z);
    const pitch = Math.asin(-Math.max(-1, Math.min(1, fwdV.y)));
    if (prevYaw !== null) {
      let dy = yaw - prevYaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      worstYaw = Math.max(worstYaw, Math.abs(dy) * 180 / Math.PI);
      worstPitch = Math.max(worstPitch, Math.abs(pitch - prevPitch) * 180 / Math.PI);
      worstFov = Math.max(worstFov, Math.abs(cam.fov - prevFov));
      if ((g.camera.shakeAmount ?? 0) <= 0.0001) {
        calmFrames++;
        calmYaw = Math.max(calmYaw, Math.abs(dy) * 180 / Math.PI);
        calmPitch = Math.max(calmPitch, Math.abs(pitch - prevPitch) * 180 / Math.PI);
      }
    }
    prevYaw = yaw; prevPitch = pitch; prevFov = cam.fov;

    // The focus point is not displaced by the shake, but a collision moves the
    // CAR discontinuously and the focus follows, so gate this on the same
    // shake-free frames: what is being judged is the framing, not the crash.
    const fo = g.camera._focus;
    const quiet = (g.camera.shakeAmount ?? 0) <= 0.0001;
    if (prevFocus && quiet) {
      const sx = fo.x - prevFocus.x, sz = fo.z - prevFocus.z;
      const st = Math.hypot(sx, sz);
      worstStep = Math.max(worstStep, st);
      if (prevStep) {
        worstAccel = Math.max(worstAccel, Math.hypot(sx - prevStep.x, sz - prevStep.z));
      }
      prevStep = { x: sx, z: sz };
    } else if (!quiet) prevStep = null;
    prevFocus = { x: fo.x, z: fo.z };
    void fTmp;

    // --- where the car sits in frame ---------------------------------------
    const pose = g._pose;
    const cy = g._carY ?? v.position.y;
    v3.set(v.position.x, cy + 0.7, v.position.z).project(cam);
    const cx = v3.x, cyN = v3.y;
    ndcX.push(cx); ndcY.push(cyN);
    if (Math.abs(cx) > 1 || Math.abs(cyN) > 1 || v3.z < -1 || v3.z > 1) offFrame++;

    // A 4.2 x 1.8 x 1.3 box on the car's heading. "Off frame" above is the
    // centre; this is the stricter test — any corner past the edge.
    {
      const h = v.heading, cs = Math.cos(h), sn = Math.sin(h);
      let clipped = false;
      for (const [a, b, c] of [[2.1, 0.9, 0], [2.1, -0.9, 0], [-2.1, 0.9, 0], [-2.1, -0.9, 0],
        [2.1, 0.9, 1.3], [2.1, -0.9, 1.3], [-2.1, 0.9, 1.3], [-2.1, -0.9, 1.3]]) {
        const x = v.position.x + cs * a + sn * b;
        const z = v.position.z - sn * a + cs * b;
        v3.set(x, cy + c, z).project(cam);
        if (Math.abs(v3.x) > 1 || Math.abs(v3.y) > 1) { clipped = true; break; }
      }
      if (clipped) offFrameCorner++;
      void pose;
    }

    // --- metres of road, at 20 Hz ------------------------------------------
    if (f % 6) continue;
    sampled++;
    const i0 = nearest(v.position.x, v.position.z);
    const offRoad = Math.hypot(v.position.x - S[i0].x, v.position.z - S[i0].z);
    // Increasing sample index runs along (tx, tz); "ahead" is whichever of the
    // two directions the car is actually travelling in.
    const s0 = S[i0];
    const dir = (v.velocity.x * s0.tx + v.velocity.z * s0.tz) >= 0 ? 1 : -1;
    const ahead = walk(i0, dir);
    const behind = walk(i0, -dir);
    push(v.speed, { ahead, behind, ndcY: cyN, ndcX: cx, speed: v.speed, offRoad });
  }

  const stats = (a) => {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return {
      n: s.length,
      mean: a.reduce((x, y) => x + y, 0) / a.length,
      p05: q(0.05), p50: q(0.50), p95: q(0.95), min: s[0], max: s[s.length - 1],
    };
  };
  const band = (rows) => rows.length ? {
    n: rows.length,
    speed: stats(rows.map((r) => r.speed)),
    ahead: stats(rows.map((r) => r.ahead)),
    behind: stats(rows.map((r) => r.behind)),
    ratio: stats(rows.map((r) => r.ahead / Math.max(1, r.behind))),
    ndcY: stats(rows.map((r) => r.ndcY)),
    offRoad: stats(rows.map((r) => r.offRoad)),
  } : null;

  return {
    frames, sampled,
    bands: { low: band(bands.low), mid: band(bands.mid), high: band(bands.high) },
    all: {
      ahead: stats([...bands.low, ...bands.mid, ...bands.high].map((r) => r.ahead)),
      behind: stats([...bands.low, ...bands.mid, ...bands.high].map((r) => r.behind)),
      ndcY: stats(ndcY), ndcX: stats(ndcX),
    },
    offFrame, offFrameCorner,
    jerk: { yawDeg: worstYaw, pitchDeg: worstPitch, fovDeg: worstFov },
    calm: { frames: calmFrames, yawDeg: calmYaw, pitchDeg: calmPitch },
    focus: { stepM: worstStep, accelM: worstAccel },
  };
}, { seconds: args.seconds });

await browser.close();

const f = (v, d = 1) => (v === null || v === undefined ? '  --' : v.toFixed(d));
const L = console.log;

let base = null;
if (args.baseline) { try { base = JSON.parse(await readFile(args.baseline, 'utf8')); } catch {} }

const show = (label, r, b) => {
  L('');
  L(`${label}   ${r.frames} frames at 1/120, ${r.sampled} road samples`);
  L('');
  L('  ROAD INSIDE THE FRAME — contiguous metres of centreline, from the car');
  L('                              AHEAD                       BEHIND          ahead:behind');
  L('  band       speed      mean    p05    p95        mean    p05    p95        mean');
  for (const k of ['low', 'mid', 'high']) {
    const x = r.bands[k]; if (!x) continue;
    const y = b?.bands?.[k];
    L(`  ${k.padEnd(5)} ${f(x.speed.mean).padStart(8)} m/s ${f(x.ahead.mean).padStart(7)} ${f(x.ahead.p05).padStart(6)} ${f(x.ahead.p95).padStart(6)}   ` +
      `${f(x.behind.mean).padStart(7)} ${f(x.behind.p05).padStart(6)} ${f(x.behind.p95).padStart(6)}   ` +
      `${f(x.ahead.mean / x.behind.mean, 2).padStart(9)}   off-road ${f(x.offRoad.mean)} m` +
      (y ? `      (was ${f(y.ahead.mean)} / ${f(y.behind.mean)} = ${f(y.ahead.mean / y.behind.mean, 2)})` : ''));
  }
  L(`  ALL          -       ${f(r.all.ahead.mean).padStart(7)} ${f(r.all.ahead.p05).padStart(6)} ${f(r.all.ahead.p95).padStart(6)}   ` +
    `${f(r.all.behind.mean).padStart(7)} ${f(r.all.behind.p05).padStart(6)} ${f(r.all.behind.p95).padStart(6)}   ` +
    `${f(r.all.ahead.mean / r.all.behind.mean, 2).padStart(9)}`);

  L('');
  L('  CAR IN FRAME — normalised device coords. ndcY -1 = bottom edge, +1 = top.');
  L('  band      ndcY mean    p05    p50    p95     screen pos (0 = bottom, 1 = top)');
  for (const k of ['low', 'mid', 'high']) {
    const x = r.bands[k]; if (!x) continue;
    L(`  ${k.padEnd(5)} ${f(x.ndcY.mean, 3).padStart(11)} ${f(x.ndcY.p05, 3).padStart(6)} ${f(x.ndcY.p50, 3).padStart(6)} ${f(x.ndcY.p95, 3).padStart(6)}` +
      `        ${f((1 + x.ndcY.mean) / 2, 3)}`);
  }
  L(`  ALL   ${f(r.all.ndcY.mean, 3).padStart(11)} ${f(r.all.ndcY.p05, 3).padStart(6)} ${f(r.all.ndcY.p50, 3).padStart(6)} ${f(r.all.ndcY.p95, 3).padStart(6)}` +
    `        ${f((1 + r.all.ndcY.mean) / 2, 3)}`);
  L(`        ndcX mean ${f(r.all.ndcX.mean, 3)}  min ${f(r.all.ndcX.min, 3)}  max ${f(r.all.ndcX.max, 3)}`);

  L('');
  L('  BUDGETS');
  L(`    car centre outside the frame   ${r.offFrame} / ${r.frames} frames   (must be 0)` +
    (b ? `   was ${b.offFrame} / ${b.frames}` : ''));
  L(`    any car corner clipped         ${r.offFrameCorner} / ${r.frames} frames` +
    (b ? `   was ${b.offFrameCorner} / ${b.frames}` : ''));
  L(`    worst per-frame yaw change     ${f(r.jerk.yawDeg, 3)} deg` + (b ? `   was ${f(b.jerk.yawDeg, 3)}` : ''));
  L(`    worst per-frame pitch change   ${f(r.jerk.pitchDeg, 3)} deg` + (b ? `   was ${f(b.jerk.pitchDeg, 3)}` : ''));
  L(`    worst per-frame FOV change     ${f(r.jerk.fovDeg, 3)} deg` + (b ? `   was ${f(b.jerk.fovDeg, 3)}` : ''));
  if (r.calm) {
    L(`    (yaw/pitch above are a SHAKE meter: this camera is world-fixed, and on`);
    L(`     the ${r.calm.frames} shake-free frames the worst yaw change is ${f(r.calm.yawDeg, 4)} deg.)`);
  }
  if (r.focus) {
    L(`    worst focus step               ${f(r.focus.stepM, 4)} m/frame` + (b?.focus ? `   was ${f(b.focus.stepM, 4)}` : ''));
    L(`    worst focus ACCELERATION       ${f(r.focus.accelM, 5)} m/frame^2` + (b?.focus ? `   was ${f(b.focus.accelM, 5)}` : ''));
  }
};

show('CAMERA FRAMING', report, base);

if (errors.length) {
  L('');
  L(`PAGE ERRORS (${errors.length}):`);
  for (const e of errors.slice(0, 6)) L(`  ${e.slice(0, 200)}`);
}

if (args.json) await writeFile(args.json, JSON.stringify(report, null, 2));
L('');
if (errors.length) { L('x page errors'); process.exit(1); }
if (report.offFrame > 0) { L(`x car left the frame on ${report.offFrame} frames`); process.exit(1); }
L('ok');
