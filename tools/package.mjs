#!/usr/bin/env node
/**
 * PACKAGE A DISTRIBUTABLE.
 *
 * `vite build` produces index.html plus one JS chunk, which needs a web server:
 * a `<script type="module" src=...>` will not load over file://, so a recipient
 * who double-clicks index.html gets a blank page and no explanation. Since the
 * build is a single self-contained chunk with no runtime imports, inlining it
 * removes that requirement entirely — the archive becomes one folder anyone can
 * open with a double click.
 *
 *   node tools/package.mjs
 *
 * NOTE ON MUSIC: build with `DRIFTLANDS_NO_MUSIC=1 npx vite build` first. The
 * player's own tracks are compiled into the bundle by import.meta.glob, and a zip
 * handed to someone else is redistribution. Do NOT do what I did the first time
 * and move the files out of the folder by hand — the dev server re-expands the
 * glob the moment they vanish and, if the watcher has been told to ignore that
 * folder, never notices them return. The music silently stopped working and it
 * took a bug report to find out.
 */
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Shipped beside the game. Written HERE rather than by hand, because this script
 * wipes the release directory on every run — a README added afterwards is a
 * README that vanishes the next time anyone rebuilds, which is exactly what
 * happened to the first one.
 */
const README = String.raw`DRIFTLANDS — Alpine Meadows, Stage 01
=====================================

TO PLAY
  Open index.html in a browser. Double-clicking it works — everything is in that
  one file, there is no server to run and nothing to install. Chrome, Edge,
  Firefox and Safari are all fine. WebGL is required.

CONTROLS
  W A S D    drive
  SPACE      handbrake
  R          reset the car back to the road
  L          lap times and results (pauses the game)
  M  route ribbon      H  hide the HUD      N  mute
  [ ]  change track    P  pause music       - =  volume

THE RACE
  Five laps. Crossing the start line completes one; time and drift score are
  kept per lap and totalled at the end. Press L at any time for the table.

  Drift score rewards CONTINUITY. Linking slides without straightening up climbs
  a multiplier from x1 to x100 over about forty-five seconds of continuous
  sliding; breaking the chain drops it back to x1. Chasing that is the game.

  There is a jump on the long straight, over a ford. It is meant to be taken
  flat out.

MUSIC
  This build ships with no music, on purpose: the playlist is compiled in, and
  the tracks in the development copy are someone's own licensed music, which is
  not ours to hand on. The engine, tyres, impacts and the lap chime are all
  synthesised and are all here. The music/ folder is where a soundtrack would
  live, but a built copy cannot pick up files dropped into it — that has to
  happen when the build is made.

WHAT THIS IS
  A single-stage technical demo. One world, generated procedurally: there is not
  one image file anywhere in it. Every surface, tree, rock, bridge, guardrail and
  cloud is geometry and vertex colour computed at load, and the engine note is
  synthesised rather than sampled. That is why the whole thing is under a
  megabyte.

KNOWN
  The first load takes a moment while the world is built — nothing is being
  downloaded, it is being computed.
  Frame rate depends on your GPU; this is a lot of geometry for an integrated one.

FEEDBACK WORTH HAVING
  Anything that looks WRONG rather than merely hard. Wheels or bodywork passing
  through scenery, the car stuck with no way out, the camera losing the car, a
  bridge or barrier that reads oddly, sound that does not match what happened.
  Screenshots help far more than descriptions — press H first if the HUD is in
  the way.
`;
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'release', 'DRIFTLANDS');

let html = await readFile(path.join(DIST, 'index.html'), 'utf8');
const m = html.match(/<script type="module"[^>]*src="\.\/(assets\/[^"]+)"[^>]*><\/script>/);
if (!m) throw new Error('could not find the module script tag in dist/index.html');
const js = await readFile(path.join(DIST, m[1]), 'utf8');

// The progress page is a development artefact and is not in the build.
html = html.replace(/<a href="[^"]*progress[^"]*"[^>]*>.*?<\/a>/g, '');
// `</script>` inside a string literal would close the tag early.
// A FUNCTION REPLACEMENT, not a string one. String.replace treats `$&`, `$\``
// and friends in the REPLACEMENT as substitution patterns, and minified JS is
// full of `$`. The first attempt produced a bundle that died with "SyntaxError:
// missing ) after argument list" because its own source had been rewritten by
// the replace call that was supposed to move it.
const inline = `<script type="module">\n${js.replace(/<\/script>/gi, '<\\/script>')}\n</script>`;
html = html.replace(m[0], () => inline);

await rm(path.join(ROOT, 'release'), { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'index.html'), html);
await mkdir(path.join(OUT, 'music'), { recursive: true });
if (existsSync(path.join(ROOT, 'music/README.md'))) {
  await cp(path.join(ROOT, 'music/README.md'), path.join(OUT, 'music/README.md'));
}
await writeFile(path.join(OUT, 'README.txt'), README);
console.log('PACKAGED ' + (html.length / 1048576).toFixed(2) + ' MB -> ' + path.relative(ROOT, OUT));
