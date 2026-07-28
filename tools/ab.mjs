#!/usr/bin/env node
/**
 * BLIND A/B COMPOSITOR
 * --------------------
 * A colour screenshot next to a monochrome reference is not a blind test — the
 * critic knows instantly which is which, and "which is better" collapses into
 * "which do I already believe is better".
 *
 * So we compare the thing that actually separates good craft from bad, with the
 * giveaway removed: VALUE STRUCTURE. Both images are desaturated and matched for
 * size, then emitted as anonymous panels A and B in a randomised order. The key
 * is written to a separate file the critic is told not to read until it has
 * committed to a verdict.
 *
 * Usage:
 *   node tools/ab.mjs --ours shots/r01/winter_pass.png --out ab/round01 [--seed 7]
 *
 * Writes:  ab/round01/panel_A.png, panel_B.png, pair_mono.png, pair_colour.png
 *          ab/round01/KEY.json      <- which panel is which (do not peek)
 *
 * Uses Playwright's canvas rather than an image library so the project keeps
 * zero extra dependencies.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const REF = path.join(ROOT, 'ref/reference_artofrally.png');

const args = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) if (av[i].startsWith('--')) args[av[i].slice(2)] = av[++i];

const oursPath = path.isAbsolute(args.ours ?? '') ? args.ours : path.join(ROOT, args.ours ?? 'shots/latest/winter_pass.png');
const outDir = path.isAbsolute(args.out ?? '') ? args.out : path.join(ROOT, args.out ?? 'ab/latest');
const seed = Number(args.seed ?? 1);
await mkdir(outDir, { recursive: true });

const toDataUrl = async (p) => 'data:image/png;base64,' + (await readFile(p)).toString('base64');
const refUrl = await toDataUrl(REF);
const ourUrl = await toDataUrl(oursPath);

// Deterministic coin flip so a round's assignment is reproducible.
const oursIsA = (Math.imul(seed, 2654435761) >>> 0) % 2 === 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

const out = await page.evaluate(async ({ refUrl, ourUrl, oursIsA }) => {
  const load = (src) => new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
  });
  const ref = await load(refUrl);
  const our = await load(ourUrl);

  // Normalise to a common width so neither is favoured by resolution.
  const W = 1600;
  const draw = (img, mono) => {
    const h = Math.round((img.height / img.width) * W);
    const c = document.createElement('canvas');
    c.width = W; c.height = h;
    const x = c.getContext('2d');
    if (mono) x.filter = 'grayscale(1)';
    x.drawImage(img, 0, 0, W, h);
    return c;
  };

  const stack = (top, bottom, labels) => {
    const c = document.createElement('canvas');
    const gap = 26, pad = 44;
    c.width = W + pad * 2;
    c.height = top.height + bottom.height + gap + pad * 2 + 60;
    const x = c.getContext('2d');
    x.fillStyle = '#0c0e13'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(top, pad, pad + 30);
    x.drawImage(bottom, pad, pad + 30 + top.height + gap + 30);
    x.fillStyle = '#e8ecf4';
    x.font = '700 26px ui-monospace, Menlo, monospace';
    x.fillText(labels[0], pad, pad + 20);
    x.fillText(labels[1], pad, pad + 30 + top.height + gap + 22);
    return c;
  };

  const refMono = draw(ref, true), ourMono = draw(our, true);
  const panelA = oursIsA ? ourMono : refMono;
  const panelB = oursIsA ? refMono : ourMono;

  const monoPair = stack(panelA, panelB, ['PANEL A', 'PANEL B']);
  const colourPair = stack(draw(ref, false), draw(our, false), ['REFERENCE — art of rally', 'OURS']);

  return {
    A: panelA.toDataURL('image/png'),
    B: panelB.toDataURL('image/png'),
    mono: monoPair.toDataURL('image/png'),
    colour: colourPair.toDataURL('image/png'),
  };
}, { refUrl, ourUrl, oursIsA });

await browser.close();

const save = async (name, dataUrl) =>
  writeFile(path.join(outDir, name), Buffer.from(dataUrl.split(',')[1], 'base64'));

await save('panel_A.png', out.A);
await save('panel_B.png', out.B);
await save('pair_mono.png', out.mono);
await save('pair_colour.png', out.colour);
await writeFile(
  path.join(outDir, 'KEY.json'),
  JSON.stringify({ panelA: oursIsA ? 'OURS' : 'REFERENCE', panelB: oursIsA ? 'REFERENCE' : 'OURS', ours: path.relative(ROOT, oursPath), seed }, null, 2)
);

console.log(`blind pair → ${path.relative(ROOT, outDir)}/pair_mono.png  (key withheld in KEY.json)`);
