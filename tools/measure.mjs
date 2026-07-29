#!/usr/bin/env node
/**
 * Objective image comparison against a client target.
 *
 * "Too dark", "too olive", "too saturated" are opinions until someone measures
 * them. This prints the numbers a builder can actually aim at: luminance
 * distribution, mean saturation and hue, and the dominant colours of each
 * image, side by side with the target.
 *
 *   node tools/measure.mjs --ours shots/r04/hero_alpine.png --biome alpine
 *   node tools/measure.mjs --ours a.png --target ref/target_01_alpine_meadow.png
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
// Duplicated rather than imported from ab.mjs on purpose: that module runs its
// whole compositing job at import time, so importing it here would silently
// render an unrelated A/B pair every time you asked for a measurement.
const TARGET_FOR_BIOME = {
  alpine: 'target_01_alpine_meadow.png',
  desert: 'target_02_desert_canyon.png',
  alpineLake: 'target_03_alpine_lake_peaks.png',
  autumn: 'target_04_autumn_village.png',
  winter: 'target_05_winter_pass.png',
  tropical: 'target_06_tropical_island.png',
  volcanic: 'target_07_volcanic_geothermal.png',
  blossom: 'target_08_blossom_wetland.png',
};

const ROOT = path.resolve(import.meta.dirname, '..');
const args = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) if (av[i].startsWith('--')) args[av[i].slice(2)] = av[++i];

const oursPath = path.isAbsolute(args.ours ?? '') ? args.ours : path.join(ROOT, args.ours);
const targetFile = args.target ?? TARGET_FOR_BIOME[args.biome ?? 'alpine'];
const refPath = path.isAbsolute(targetFile) ? targetFile : path.join(ROOT, 'ref', targetFile);

const toUrl = async (p) => 'data:image/png;base64,' + (await readFile(p)).toString('base64');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });

const stats = await page.evaluate(async ({ a, b }) => {
  const load = (src) => new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
  });

  const analyse = async (src) => {
    const img = await load(src);
    const W = 480, H = Math.round((img.height / img.width) * W);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data;

    let n = 0, sumL = 0, sumS = 0, sumR = 0, sumG = 0, sumB = 0;
    const lumaHist = new Array(10).fill(0);
    const bins = new Map();

    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, bl = d[i + 2] / 255;
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      const S = mx === 0 ? 0 : (mx - mn) / mx;
      sumL += L; sumS += S; sumR += r; sumG += g; sumB += bl; n++;
      lumaHist[Math.min(9, Math.floor(L * 10))]++;
      // 12-level-per-channel colour bins for a dominant-colour readout
      const key = `${Math.round(r * 11)},${Math.round(g * 11)},${Math.round(bl * 11)}`;
      bins.set(key, (bins.get(key) ?? 0) + 1);
    }

    const top = [...bins.entries()].sort((p, q) => q[1] - p[1]).slice(0, 5).map(([k, v]) => {
      const [r, g, bl] = k.split(',').map((t) => Math.round((+t / 11) * 255));
      const hex = '#' + [r, g, bl].map((z) => z.toString(16).padStart(2, '0')).join('');
      return { hex, pct: +(100 * v / n).toFixed(1) };
    });

    return {
      meanLuma: +(sumL / n).toFixed(3),
      meanSat: +(sumS / n).toFixed(3),
      meanRGB: [sumR, sumG, sumB].map((v) => Math.round((v / n) * 255)),
      lumaHist: lumaHist.map((v) => +(100 * v / n).toFixed(1)),
      dark: +(100 * lumaHist.slice(0, 3).reduce((p, q) => p + q, 0) / n).toFixed(1),
      bright: +(100 * lumaHist.slice(7).reduce((p, q) => p + q, 0) / n).toFixed(1),
      top,
    };
  };

  return { ours: await analyse(a), target: await analyse(b) };
}, { a: await toUrl(oursPath), b: await toUrl(refPath) });

await browser.close();

const row = (label, o, t) => {
  const pad = (v) => String(v).padStart(22);
  console.log(`  ${label.padEnd(16)}${pad(JSON.stringify(o))}${pad(JSON.stringify(t))}`);
};

console.log(`\n  ${''.padEnd(16)}${'OURS'.padStart(22)}${'TARGET'.padStart(22)}`);
console.log('  ' + '-'.repeat(60));
row('mean luma', stats.ours.meanLuma, stats.target.meanLuma);
row('mean sat', stats.ours.meanSat, stats.target.meanSat);
row('mean RGB', stats.ours.meanRGB, stats.target.meanRGB);
row('% dark (L<0.3)', stats.ours.dark, stats.target.dark);
row('% bright (L>0.7)', stats.ours.bright, stats.target.bright);
console.log('\n  luma histogram, 10 buckets 0..1 (percent of pixels)');
console.log('    ours  ', stats.ours.lumaHist.join(' '));
console.log('    target', stats.target.lumaHist.join(' '));
console.log('\n  dominant colours');
console.log('    ours  ', stats.ours.top.map((t) => `${t.hex} ${t.pct}%`).join('  '));
console.log('    target', stats.target.top.map((t) => `${t.hex} ${t.pct}%`).join('  '));

const dL = stats.target.meanLuma - stats.ours.meanLuma;
const dS = stats.target.meanSat - stats.ours.meanSat;
console.log(`\n  VERDICT: ours is ${dL > 0 ? 'DARKER' : 'brighter'} by ${Math.abs(dL).toFixed(3)} luma, ` +
  `${dS > 0 ? 'LESS' : 'more'} saturated by ${Math.abs(dS).toFixed(3)}\n`);
