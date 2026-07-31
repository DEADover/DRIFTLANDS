#!/usr/bin/env node
/**
 * THE FLIGHT, FRAME BY FRAME — what the PLAYER's clock sees.
 * ---------------------------------------------------------
 * `jump-test.mjs` answers "does the car go up?" It measures the trajectory in
 * SIM steps, which is exactly the quantity slow motion is designed not to move,
 * so it cannot see slow motion at all, and it never looks at the car's ATTITUDE.
 * The client's three complaints are all about attitude and about the clock:
 *
 *   "the take-off animation can be considered non-working"
 *   "the slow motion also works unclearly"
 *   "the fireworks are not expressive"
 *
 * So this tool drives the ordinary autopilot lap — no teleport, no injected
 * velocity, the same drive the `jump_alpine` screenshot preset captures — and
 * logs, per RENDERED FRAME:
 *
 *   wall clock, sim clock, timeScale, ballisticAir, height above ground,
 *   BODY PITCH IN DEGREES (what the eye actually reads as "a jump"),
 *   live particle count.
 *
 * Every column is a thing you can see on screen. Airtime measured in sim
 * seconds is not.
 *
 *   node tools/jump-trace.mjs --base http://127.0.0.1:5220
 *   node tools/jump-trace.mjs --base ... --from 105 --to 110
 */
import { chromium } from 'playwright';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5173', preset: 'jump_alpine', from: 104, to: 111, warm: 120 };
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--preset') args.preset = av[++i];
  else if (a === '--from') args.from = Number(av[++i]);
  else if (a === '--to') args.to = Number(av[++i]);
  else if (a === '--warm') args.warm = Number(av[++i]);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
// `&t=0` so the harness does NO warmup and this loop IS the preset's own drive,
// frame for frame — otherwise the shot's 107.15 s has already been spent and the
// flight is behind us before the first row is logged.
await page.goto(`${args.base}/?shot=${args.preset}&hud=0&t=0`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 180000 });

const rows = await page.evaluate(({ from, to, warm }) => {
  const g = window.__GAME;
  const dt = 1 / 60;
  const out = [];
  let wall = 0;
  for (let i = 0; i < 60 * warm; i++) {
    const input = g.autopilotInput({ throttle: 1, aggression: 1 });
    g.update(dt, input);
    wall += dt;                                  // one RENDERED frame = 1/60 real
    if (wall >= from && wall <= to) {
      const v = g.vehicle;
      const p = g._poseCache ?? {};
      const gr = g.groundAt(v.position.x, v.position.z);
      out.push({
        wall: +wall.toFixed(3),
        sim: +g.simTime.toFixed(3),
        ts: +(g.feel.timeScale ?? 1).toFixed(3),
        air: v.ballisticAir ? 1 : 0,
        h: +((g._carY ?? gr.height) - gr.height).toFixed(2),
        pitch: +((p.pitch ?? 0) * 180 / Math.PI).toFixed(2),
        roll: +((p.roll ?? 0) * 180 / Math.PI).toFixed(2),
        spd: +v.speed.toFixed(1),
        fov: +(g.camera.camera?.fov ?? 0).toFixed(2),
        jc: g.feel.jumpCount,
      });
    }
    if (wall > to) break;
  }
  return out;
}, args);

if (errors.length) { console.error(errors.slice(0, 4).join('\n')); process.exit(1); }

console.log('wall     sim      tScale  air  h(m)   pitch°  roll°   km/h   fov°   jumps');
let lastAir = 0, tOff = null, tOn = null;
for (const r of rows) {
  console.log(
    `${r.wall.toFixed(3).padStart(7)} ${r.sim.toFixed(3).padStart(8)} ${r.ts.toFixed(3).padStart(7)}` +
    `  ${r.air}  ${r.h.toFixed(2).padStart(6)} ${r.pitch.toFixed(2).padStart(7)} ${r.roll.toFixed(2).padStart(7)}` +
    ` ${(r.spd * 3.6).toFixed(0).padStart(6)} ${r.fov.toFixed(2).padStart(6)} ${String(r.jc).padStart(6)}`,
  );
  if (r.air && !lastAir) tOff = r;
  if (!r.air && lastAir && tOn === null) tOn = r;
  lastAir = r.air;
}
if (tOff) {
  const air = rows.filter((r) => r.air);
  const p = air.map((r) => r.pitch);
  const ts = air.map((r) => r.ts);
  const fv = rows.map((r) => r.fov);
  console.log('');
  console.log(`FLIGHT   frames airborne : ${air.length}  (= ${(air.length / 60).toFixed(2)} s of WALL clock)`);
  console.log(`         pitch range     : ${Math.min(...p).toFixed(2)}° .. ${Math.max(...p).toFixed(2)}°   ` +
              `SWING ${(Math.max(...p) - Math.min(...p)).toFixed(2)}°`);
  console.log(`         timeScale range : ${Math.min(...ts).toFixed(3)} .. ${Math.max(...ts).toFixed(3)}`);
  console.log(`         peak height     : ${Math.max(...air.map((r) => r.h)).toFixed(2)} m`);
  console.log(`         camera fov      : ${Math.max(...fv).toFixed(2)}° -> ${Math.min(...fv).toFixed(2)}°   ` +
              `PULL-IN ${(Math.max(...fv) - Math.min(...fv)).toFixed(2)}°`);
}
await browser.close();
