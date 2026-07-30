#!/usr/bin/env node
/**
 * COLLIDER SURVEY — evidence for the radius->material mapping in
 * src/core/collision.js.
 *
 * The legacy prop colliders are bare {x, z, r} with no `kind`, so collision.js
 * has to infer the material from the radius. This boots the real world for
 * every biome and prints the radius histogram per producer, which is the only
 * honest way to pick the thresholds.
 *
 *   node tools/collide-survey.mjs --base http://127.0.0.1:5212
 */
import { chromium } from 'playwright';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5173' };
for (let i = 0; i < av.length; i++) {
  if (av[i] === '--base') args.base = av[++i];
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.error('PAGE', String(e)));

await page.goto(`${args.base}/?shot=hero_alpine&hud=0`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 180000 });

const out = await page.evaluate(async () => {
  const g = window.__GAME;
  const res = {};
  for (const id of ['alpine', 'desert', 'winter', 'forest', 'coast']) {
    try { g.loadBiome(id, 1337); } catch (e) { res[id] = { err: String(e) }; continue; }
    const groups = {
      props: g.props.colliders,
      bridges: g.bridges.colliders,
      landmarks: g.landmarks.colliders,
    };
    const stat = {};
    for (const [k, arr] of Object.entries(groups)) {
      if (!arr || !arr.length) { stat[k] = { n: 0 }; continue; }
      const rs = arr.map((c) => c.r).sort((a, b) => a - b);
      const q = (p) => rs[Math.min(rs.length - 1, Math.floor(p * rs.length))];
      // 0.25 m buckets, capped
      const hist = {};
      for (const r of rs) {
        const b = (Math.floor(r / 0.5) * 0.5).toFixed(1);
        hist[b] = (hist[b] ?? 0) + 1;
      }
      stat[k] = {
        n: rs.length, min: q(0), p10: q(0.1), p50: q(0.5), p90: q(0.9), max: rs[rs.length - 1],
        kinds: [...new Set(arr.map((c) => c.kind ?? '(none)'))],
        hist,
      };
    }
    const B = g.roads.barriers;
    stat.barriers = B?.segments?.length
      ? {
        n: B.segments.length,
        guard: B.segments.filter((s) => s.kind === 'guard').length,
        fence: B.segments.filter((s) => s.kind === 'fence').length,
        halfMin: Math.min(...B.segments.map((s) => s.half)),
        halfP50: B.segments.map((s) => s.half).sort((a, b) => a - b)[B.segments.length >> 1],
        halfMax: Math.max(...B.segments.map((s) => s.half)),
        keys: Object.keys(B.segments[0]),
      }
      : { n: 0 };
    res[id] = stat;
  }
  return res;
});

await browser.close();
console.log(JSON.stringify(out, null, 1));
