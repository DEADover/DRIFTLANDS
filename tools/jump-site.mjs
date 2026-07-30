#!/usr/bin/env node
/**
 * SITING SCRATCH — walks the route, ranks straights, and drives the autopilot
 * to record the speed the car actually arrives at every station.
 * Throwaway diagnostic for choosing where the jump goes.
 */
import { chromium } from 'playwright';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5214', preset: 'hero_alpine', seconds: 240 };
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--preset') args.preset = av[++i];
  else if (a === '--seconds') args.seconds = Number(av[++i]);
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${args.base}/?shot=${args.preset}&hud=0`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 180000 });

const out = await page.evaluate(async ({ seconds }) => {
  const g = window.__GAME;
  const R = g.roads;
  const N = 900;
  const S = [];
  for (let i = 0; i < N; i++) {
    const s = R.sample(i / N);
    S.push({ i, t: i / N, x: s.x, z: s.z, h: s.heading });
  }
  const L = R.length;
  const ds = L / N;
  // turned heading per metre
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  for (let i = 0; i < N; i++) {
    const a = S[i], b = S[(i + 1) % N];
    a.kappa = Math.abs(wrap(b.h - a.h)) / ds;
  }
  // A "straight" is a run whose radius stays over 220 m.
  const KMAX = 1 / 220;
  const runs = [];
  let start = null;
  for (let i = 0; i < N * 2; i++) {
    const k = S[i % N].kappa;
    if (k <= KMAX) { if (start === null) start = i; }
    else { if (start !== null && i - start >= 3) runs.push({ a: start, b: i }); start = null; }
  }
  const seen = new Set();
  const straights = [];
  for (const r of runs) {
    const key = (r.a % N);
    if (seen.has(key)) continue;
    seen.add(key);
    const len = (r.b - r.a) * ds;
    const mid = S[Math.floor((r.a + r.b) / 2) % N];
    straights.push({
      lenM: len, i0: r.a % N, i1: r.b % N, midI: Math.floor((r.a + r.b) / 2) % N,
      midX: mid.x, midZ: mid.z, midT: mid.t,
    });
  }
  straights.sort((a, b) => b.lenM - a.lenM);

  // Drive and record speed per nearest station.
  const speed = new Float32Array(N);
  const hits = new Float32Array(N);
  const dt = 1 / 60;
  const steps = Math.round(seconds / dt);
  const v = g.vehicle;
  for (let s = 0; s < steps; s++) {
    g.update(dt, g.autopilotInput({ throttle: 1, aggression: 0.85 }));
    // nearest station by brute force every 4th step (cheap enough)
    if (s % 4) continue;
    let best = 0, bd = Infinity;
    for (let i = 0; i < N; i++) {
      const d = (S[i].x - v.position.x) ** 2 + (S[i].z - v.position.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (bd < 400) { speed[best] += v.speed; hits[best]++; }
  }
  const spd = [];
  for (let i = 0; i < N; i++) spd.push(hits[i] ? speed[i] / hits[i] : null);

  // terrain / road height context around each straight
  const ctx = (i) => {
    const s = S[i];
    const road = g.roads.heightAt(s.x, s.z);
    const ter = g.terrain.drawnHeightAt(s.x, s.z);
    const nx = -Math.sin(-s.h + Math.PI / 2), nz = 0; // placeholder
    return { road, ter };
  };
  return {
    length: L, ds, N,
    straights: straights.slice(0, 12).map((s) => ({
      ...s,
      // mean recorded speed over the run
      speed: (() => {
        let sum = 0, n = 0;
        for (let i = s.i0; i !== (s.i1 % N); i = (i + 1) % N) { if (spd[i] != null) { sum += spd[i]; n++; } }
        return n ? sum / n : null;
      })(),
      entrySpeed: spd[s.i0] ?? null,
      midSpeed: spd[s.midI] ?? null,
      ...ctx(s.midI),
    })),
    coverage: spd.filter((s) => s != null).length / N,
  };
}, { seconds: args.seconds });

await browser.close();
console.log(JSON.stringify(out, null, 2));
if (errors.length) { console.log('ERRORS', errors.slice(0, 5)); process.exit(1); }
