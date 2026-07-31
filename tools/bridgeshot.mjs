// Park the car mid-span on EVERY crossing on the route and screenshot each one.
// The picture is the acceptance test; the percentages have been wrong twice.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const BASE = process.env.BASE || 'http://127.0.0.1:5223';
const b = await chromium.launch({ args:['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport:{ width:1600, height:900 } });
await p.goto(`${BASE}/?shot=hero_alpine&hud=0`,{ waitUntil:'load', timeout:120000 });
await p.waitForFunction('window.__SHOT_READY === true', null, { timeout:180000 });
const spans = await p.evaluate(() => {
  const g = window.__GAME, N = 2000, out = [];
  const on = (i) => { const s = g.roads.sample(((i%N)+N)/N % 1); return s && g.bridges.heightAt(s.x,s.z) != null; };
  const A = []; for (let i=0;i<N;i++){ const s=g.roads.sample(i/N); A.push(s && g.bridges.heightAt(s.x,s.z)!=null); }
  for (let i=0;i<N;i++) if (A[i] && !A[(i-1+N)%N]) { let j=i,l=0; while(A[j%N] && l<N){j++;l++;} out.push({i,len:l}); }
  return out;
});
console.log('spans on the route: ' + spans.length);
for (let k = 0; k < spans.length; k++) {
  const info = await p.evaluate(({ i, len }) => {
    const g = window.__GAME, N = 2000;
    const mid = g.roads.sample((((i + Math.floor(len/2)) % N) / N));
    // The chase camera EASES toward the car; 40 frames at 1/120 is a third of a
    // second and it never arrives, which is why the first attempt at this shot
    // framed a hillside 200 m from the span. Hold the car on the deck and let
    // the camera actually catch up.
    for (let q=0;q<400;q++) {
      g.vehicle.reset(mid.x, mid.z, mid.heading);
      g.resetPose();
      g.update(1/60, { throttle:0, brake:1, steer:0, handbrake:1 });
    }
    return { x:Math.round(mid.x), z:Math.round(mid.z), lenM: Math.round(len*3577/N),
             deck:+(g.bridges.heightAt(mid.x,mid.z)??NaN).toFixed(2) };
  }, spans[k]);
  await p.evaluate(() => { for (let q=0;q<3;q++) window.__GAME.render(); });
  await writeFile(`shots/bridge/span${k}.png`, await p.screenshot());
  console.log(`span${k} ` + JSON.stringify(info));
}
await b.close();
