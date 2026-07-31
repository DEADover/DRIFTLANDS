#!/usr/bin/env node
/**
 * SCREENSHOT HARNESS
 * ------------------
 * Renders capture presets to PNG through headless Chromium. Deterministic:
 * the game runs a fixed number of fixed-step frames driven by a scripted input
 * tape, then signals `window.__SHOT_READY`.
 *
 * Usage:
 *   node tools/shoot.mjs                          # every preset, default size
 *   node tools/shoot.mjs hero_alpine drift_alpine # named presets
 *   node tools/shoot.mjs --all --out shots/r03 --w 1920 --h 1080
 *   node tools/shoot.mjs --hud 0                  # hide the HUD (pure art shots)
 *
 * Exits non-zero if any page error occurred, so builders can't ship a broken
 * build past a critic.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const out = { presets: [], w: 1920, h: 1080, out: 'shots/latest', hud: '1', base: 'http://127.0.0.1:5173' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--w') out.w = +argv[++i];
    else if (a === '--h') out.h = +argv[++i];
    else if (a === '--out') { out.out = argv[++i]; out.explicitOut = true; }
    else if (a === '--hud') out.hud = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    // --times 4,6,8,10 shoots each preset at several settle times, producing a
    // motion sequence. Judging a drift from a single still is guesswork.
    else if (a === '--times') out.times = argv[++i].split(',').map(Number);
    else if (!a.startsWith('--')) out.presets.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/**
 * WHERE THE SHOTS GO, WHEN NOBODY SAYS.
 *
 * These directories used to be named by hand — `shots/r21-steel`, `r22-chain`,
 * `r24-jump`, then just `r27`, `r28`, `r29`, `r30`. Those numbers were never
 * round numbers; they were labels I invented per capture and incremented on
 * feel. Meanwhile progress/data.json keeps the real round counter, which had
 * reached 26. So the History tab showed r30 while the Timeline showed ROUND 26 —
 * two counters for one thing, and only one of them meant anything. The client
 * spotted it before I did.
 *
 * One number now: with no `--out`, a capture lands in the round it belongs to.
 */
if (!args.explicitOut) {
  try {
    const { readFile } = await import('node:fs/promises');
    const d = JSON.parse(await readFile(path.join(ROOT, 'progress/data.json'), 'utf8'));
    const round = d?.rounds?.[0]?.round;
    if (Number.isFinite(round)) out_default(args, `shots/r${round}`);
  } catch { /* no progress data — shots/latest is a fine fallback */ }
}
function out_default(a, dir) { a.out = dir; }

// Read the preset list straight from the source of truth.
const presetsMod = await import(pathToFileURL(path.join(ROOT, 'src/capture/presets.js')).href);
const ALL = presetsMod.PRESET_IDS;
const targets = args.presets.length ? args.presets : ALL;

const outDir = path.isAbsolute(args.out) ? args.out : path.join(ROOT, args.out);
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--disable-lcd-text',
  ],
});

const results = [];
let hadError = false;

// Expand presets × settle times into the actual shot list.
const jobs = [];
for (const id of targets) {
  if (args.times) for (const t of args.times) jobs.push({ id, t, name: `${id}_t${String(t).replace('.', 'p')}` });
  else jobs.push({ id, t: null, name: id });
}

for (const job of jobs) {
  const { id, t, name } = job;
  const page = await browser.newPage({
    viewport: { width: args.w, height: args.h },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const url = `${args.base}/?shot=${encodeURIComponent(id)}&hud=${args.hud}${t != null ? `&t=${t}` : ''}`;
  const t0 = Date.now();
  let info = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 120000 });
    info = await page.evaluate('window.__SHOT_INFO');
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file, type: 'png' });
    results.push({ id, name, t, file: path.relative(ROOT, file), ms: Date.now() - t0, ...info, errors });
    console.log(`  ✓ ${name.padEnd(20)} ${info?.speedKmh ?? '?'} km/h  drift ${info?.driftAngleDeg ?? '?'}°  ${info?.drawCalls ?? '?'} calls  ${Date.now() - t0}ms`);
  } catch (e) {
    hadError = true;
    errors.push(String(e));
    results.push({ id, name, error: String(e), errors });
    console.error(`  ✗ ${name}: ${e}`);
  }
  if (errors.length) {
    hadError = true;
    console.error(`    page errors in ${name}:`);
    for (const e of errors.slice(0, 6)) console.error(`      ${e}`);
  }
  await page.close();
}

await browser.close();
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify({ at: new Date().toISOString(), args, results }, null, 2));

// Pointer to the newest gallery, consumed by the live progress page.
await writeFile(
  path.join(ROOT, 'shots/index.json'),
  JSON.stringify({
    at: new Date().toISOString(),
    dir: path.relative(ROOT, outDir),
    files: results.filter((r) => r.file).map((r) => r.file),
    results,
  }, null, 2)
);
// Refresh the development history so the progress page can show every run,
// not just the newest one.
// Importing it rebuilds and writes shots/history.json as a side effect.
await import('./gallery.mjs').catch(() => {});
console.log(`\n→ ${results.length} shots in ${path.relative(ROOT, outDir)}`);
process.exit(hadError ? 1 : 0);
