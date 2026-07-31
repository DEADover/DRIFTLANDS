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
 */
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
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
console.log('PACKAGED ' + (html.length / 1048576).toFixed(2) + ' MB -> ' + path.relative(ROOT, OUT));
