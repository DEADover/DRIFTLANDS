#!/usr/bin/env node
/**
 * OFFLINE ENGINE RENDER
 * ---------------------
 * Runs the real audio graph over the real drive tape and writes a WAV, so the
 * engine can be listened to and measured instead of asserted about.
 *
 * Usage (dev server must be up on --base):
 *   node tools/audio-render.mjs --out shots/audio/after.wav
 *   node tools/audio-render.mjs --rev v0-engine --out shots/audio/before.wav
 *   node tools/audio-render.mjs --solo engine --out shots/audio/engine.wav
 *
 * WHY OfflineAudioContext AND NOT A RECORDING OF THE GAME.
 *
 * A live capture is at the mercy of frame timing, the OS mixer and whatever the
 * page happens to be doing; two runs never line up sample for sample and a
 * before/after diff means nothing. OfflineAudioContext renders the identical
 * node graph faster than real time and bit-reproducibly. The one thing it does
 * not give you for free is a moving clock — ctx.currentTime sits at zero until
 * you render — so the control loop uses the suspend/resume protocol: park the
 * render at frame N's timestamp, call audio.update() exactly as the game would,
 * resume. Every setTargetAtTime inside _update then lands on the timestamp the
 * game would have given it, and the code under test is not modified at all.
 *
 * WHY HEADLESS CHROMIUM. WebAudio is the thing being measured; Node has no
 * implementation of it, and a re-implementation would be measuring my own
 * re-implementation. Playwright is already a dev dependency for shoot.mjs.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { renderTape } from './audio-tape.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const o = {
    base: 'http://127.0.0.1:5215',
    out: 'shots/audio/after.wav',
    rev: null,
    surface: 'dirt',
    rate: 48000,
    solo: null,          // 'engine' mutes road/wind/tyres so the engine is naked
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') o.base = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--rev') o.rev = argv[++i];
    else if (a === '--surface') o.surface = argv[++i];
    else if (a === '--rate') o.rate = +argv[++i];
    else if (a === '--solo') o.solo = argv[++i];
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));

// NOTE ON --rev: pass a TAG, not HEAD. A background autosave commits this bench
// every 60 s, so HEAD is routinely a half-finished edit; the v0 engine is tagged
// `v0-engine` for exactly this reason. Rendering "before" from HEAD once
// produced a blob that referenced a constant the same commit had not yet
// declared, and the run came back as fifteen seconds of silence.
//
// A historical revision arrives as SOURCE TEXT and is imported in the page from
// a blob URL, never written under the project root.
//
// Writing it to disk was the obvious thing and it did not work: Vite's watcher
// notices the new file, decides the page's module graph is stale and pushes a
// full reload, which destroys the execution context in the middle of the render
// and fails the run every time. A blob URL keeps the comparison version out of
// the dev server's world entirely. It costs nothing, because audio.js has no
// imports of its own to resolve — the WORKING-TREE version is still imported
// through Vite so that whatever it does import (import.meta.glob for sfx/) is
// transformed exactly as it is for the game.
const srcPath = '/src/audio/audio.js';
let srcCode = null;
if (args.rev) {
  srcCode = execFileSync('git', ['show', `${args.rev}:src/audio/audio.js`], { cwd: ROOT }).toString();
}

const tape = renderTape();
console.log(`tape: ${tape.frames.length} frames @ ${tape.controlHz} Hz, ${tape.shifts.length} gear changes`);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// warn too: audio.js swallows an update() exception into a console.warn and
// then quietly renders silence, which is exactly the failure a render tool
// must not report as a successful run.
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });

// A blank page on the dev server's origin, so the module import resolves and
// Vite's transform pipeline (bare `three` specifiers, import.meta.glob) applies
// exactly as it does for the game — see the comment in audio-harness.html for
// why this is emphatically not "/".
// Vite injects its HMR client into any HTML it serves, and a reload lands as
// "Execution context was destroyed" in the middle of a 15-second render. That
// happens whenever a source file was written moments before the run — which,
// during an edit-render-listen loop, is every single time. Retry rather than
// fight it: a reload fires once per change, so the second attempt is clean.
let result = null;
for (let attempt = 0; attempt < 3 && result === null; attempt++) {
  await page.goto(`${args.base}/tools/audio-harness.html`, { waitUntil: 'load', timeout: 30000 });
  try {
    result = await runRender();
  } catch (e) {
    if (attempt === 2 || !/context was destroyed|Execution context/.test(String(e))) throw e;
    errors.length = 0;
    console.log('  (page reloaded under the render — retrying)');
  }
}

function runRender() {
  return page.evaluate(async ({ srcPath, srcCode, tape, rate, surface, solo }) => {
    const mod = srcCode
      ? await import(URL.createObjectURL(new Blob([srcCode], { type: 'text/javascript' })))
      : await import(srcPath);
    const dur = tape.frames.length * tape.controlDt + 0.6;   // tail for the last shift
    const ctx = new OfflineAudioContext(1, Math.ceil(rate * dur), rate);
    const a = mod.createAudio();
  
    // startOffline() is the supported hook; older revisions predate it, so fall
    // back to assembling the graph by hand the way start() would have.
    if (typeof a.startOffline === 'function') a.startOffline(ctx);
    else { a.ctx = ctx; a._build(); a.started = true; a.enabled = true; }
  
    if (solo === 'engine') {
      // Everything that is not the engine is DISCONNECTED from master, not turned
      // down: _update re-automates every one of those gains on the next frame, so
      // zeroing them lasts about 13 ms. Cutting the wire is the only thing the
      // update loop cannot undo, and the engine is then genuinely naked.
      for (const n of ['gravel', 'hiss', 'hum', 'hollow']) { try { a[n].g.disconnect(); } catch {} }
      for (const n of ['windGain', 'squealGain', 'scrubGain']) { try { a[n].disconnect(); } catch {} }
    }
  
    const st = { vehicle: null, surface: { kind: surface }, onRoad: true };
    const dt = tape.controlDt;
  
    // EVERY suspend has to be registered before startRendering. The render runs
    // on its own thread and does not wait for JS to get round to asking: schedule
    // a suspend for a timestamp the renderer has already passed and the promise
    // simply never settles, which is exactly how the first version of this tool
    // hung. So the whole control tape is queued up front, then rendering is let go.
    const failures = [];
    for (let i = 1; i < tape.frames.length; i++) {
      ctx.suspend(i * dt).then(() => {
        st.vehicle = tape.frames[i];
        a.update(dt, st);
        ctx.resume();
      }, (e) => failures.push(`suspend ${i}: ${e.message}`));
    }
    st.vehicle = tape.frames[0];
    a.update(dt, st);
    const buf = await ctx.startRendering();
    if (failures.length) throw new Error(failures[0] + ` (+${failures.length - 1} more)`);
  
    const f = buf.getChannelData(0);
    let peak = 0, sum = 0, clipped = 0;
    const pcm = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const x = f[i];
      const m = Math.abs(x);
      if (m > peak) peak = m;
      if (m >= 0.999) clipped++;
      sum += x * x;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
    }
    // Base64 in the page: 15 s of Int16 is ~1.4 MB of string, which crosses the
    // bridge in one go; handing back 700k JSON numbers does not.
    const bytes = new Uint8Array(pcm.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return {
      b64: btoa(bin),
      frames: f.length,
      peak,
      rms: Math.sqrt(sum / f.length),
      clipped,
    };
  }, { srcPath, srcCode, tape: { frames: tape.frames, controlDt: tape.controlDt }, rate: args.rate, surface: args.surface, solo: args.solo });
}

await browser.close();

if (errors.length) {
  console.error('page errors:');
  for (const e of errors.slice(0, 8)) console.error('  ' + e);
  process.exit(1);
}

const pcm = Buffer.from(result.b64, 'base64');
const outPath = path.isAbsolute(args.out) ? args.out : path.join(ROOT, args.out);
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, wav(pcm, args.rate));
// The tape rides alongside the WAV: the analyser needs the commanded rpm and
// the gear-change times, and reading them out of the audio would be circular.
await writeFile(outPath.replace(/\.wav$/, '.tape.json'), JSON.stringify({
  rate: args.rate,
  controlHz: tape.controlHz,
  shifts: tape.shifts,
  rev: args.rev ?? 'working tree',
  solo: args.solo ?? null,
  frames: tape.frames.map((f) => ({ t: f.t, rpm: f.engineRpm, gear: f.gear, speed: f.speed })),
}, null, 2));

console.log(
  `→ ${path.relative(ROOT, outPath)}  ${(result.frames / args.rate).toFixed(2)}s  ` +
  `peak ${(20 * Math.log10(result.peak || 1e-9)).toFixed(1)} dBFS  ` +
  `rms ${(20 * Math.log10(result.rms || 1e-9)).toFixed(1)} dBFS  ` +
  `clipped ${result.clipped}`
);

/** 16-bit mono RIFF. No dependency does this in fewer lines than doing it. */
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);            // PCM
  h.writeUInt16LE(1, 22);            // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
