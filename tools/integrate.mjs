#!/usr/bin/env node
/**
 * INTEGRATE — pull every builder's owned files back into the main repo.
 *
 * This is safe as a plain copy because ownership is strictly disjoint: no two
 * builders may write the same path. The manifest below is the authority on who
 * owns what, and integrate.mjs refuses to run if two owners claim one file.
 *
 *   node tools/integrate.mjs            # copy everything back
 *   node tools/integrate.mjs terrain-art render-post   # only these owners
 *   node tools/integrate.mjs --dry
 */
import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BENCH = '/private/tmp/claude-501/-Users-sgryzhin-Claude-Projects-CarGame/bench';

export const OWNERSHIP = {
  'terrain-art': ['src/world/terrain.js', 'src/world/biomes.js', 'src/render/palette.js'],
  'roads': ['src/world/roads.js'],
  'water-bridges': ['src/world/water.js', 'src/world/bridges.js'],
  'props-landmarks': ['src/world/props.js', 'src/world/landmarks.js'],
  'animals': ['src/entities/animals.js'],
  'vehicle-feel': ['src/entities/vehicle.js', 'src/entities/car.js', 'src/fx/feel.js'],
  'render-post': ['src/render/renderer.js', 'src/render/post.js', 'src/render/sky.js', 'src/render/camera.js'],
  'fx': ['src/fx/particles.js', 'src/fx/skidmarks.js'],
  'hud-audio': ['src/ui/hud.js', 'src/audio/audio.js'],
};

// Fail loudly if the ownership table ever overlaps — that is the one thing
// that would make a plain-copy merge silently lose work.
const seen = new Map();
for (const [owner, files] of Object.entries(OWNERSHIP)) {
  for (const f of files) {
    if (seen.has(f)) throw new Error(`ownership conflict on ${f}: ${seen.get(f)} and ${owner}`);
    seen.set(f, owner);
  }
}

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const only = argv.filter((a) => !a.startsWith('--'));
const owners = only.length ? only : Object.keys(OWNERSHIP);

let copied = 0, missing = 0, extra = 0;
for (const owner of owners) {
  const files = OWNERSHIP[owner];
  if (!files) { console.error(`unknown owner: ${owner}`); continue; }
  const dir = path.join(BENCH, owner);
  if (!existsSync(dir)) { console.error(`no bench for ${owner}`); continue; }
  console.log(`\n${owner}`);
  for (const f of files) {
    const src = path.join(dir, f);
    if (!existsSync(src)) { console.log(`  ! missing ${f}`); missing++; continue; }
    if (!dry) {
      await mkdir(path.dirname(path.join(ROOT, f)), { recursive: true });
      await cp(src, path.join(ROOT, f));
    }
    console.log(`  ← ${f}`);
    copied++;
  }
  // Builders may add new files inside their own subsystem; bring those too.
  const dirsOwned = [...new Set(files.map((f) => path.dirname(f)))];
  for (const d of dirsOwned) {
    const benchDir = path.join(dir, d);
    if (!existsSync(benchDir)) continue;
    for (const entry of await readdir(benchDir)) {
      const rel = path.join(d, entry);
      if (files.includes(rel)) continue;
      if (seen.has(rel)) continue;               // owned by someone else
      if (existsSync(path.join(ROOT, rel))) continue; // pre-existing shared file
      if (!entry.endsWith('.js')) continue;
      if (!dry) await cp(path.join(benchDir, entry), path.join(ROOT, rel));
      console.log(`  ← ${rel}  (new)`);
      extra++;
    }
  }
}

console.log(`\n${dry ? '[dry] ' : ''}${copied} owned + ${extra} new file(s) integrated, ${missing} missing`);
