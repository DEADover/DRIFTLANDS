#!/usr/bin/env node
/**
 * BENCH — an isolated working copy of the project for one agent.
 *
 * Parallel builders must not share a dev server or a source tree: one agent's
 * half-saved file would corrupt another's screenshots. Each agent gets a full
 * copy with node_modules symlinked (so creation is instant) and its own port.
 *
 *   node tools/bench.mjs create <name> <port>   -> prints the bench path
 *   node tools/bench.mjs collect <name> <file…> -> copies owned files back
 *   node tools/bench.mjs list
 *
 * Merging is safe because file ownership across agents is strictly disjoint:
 * "merge" is literally a copy of the files that agent owns.
 */
import { cp, mkdir, rm, symlink, readdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BENCH_ROOT = process.env.BENCH_ROOT
  || '/private/tmp/claude-501/-Users-sgryzhin-Claude-Projects-CarGame/bench';

const COPY = ['src', 'tools', 'ref', 'index.html', 'vite.config.js', 'package.json'];

const [cmd, name, ...rest] = process.argv.slice(2);

if (cmd === 'create') {
  const port = rest[0] ?? '5200';
  const dir = path.join(BENCH_ROOT, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const item of COPY) {
    if (existsSync(path.join(ROOT, item))) {
      await cp(path.join(ROOT, item), path.join(dir, item), { recursive: true });
    }
  }
  await mkdir(path.join(dir, 'shots'), { recursive: true });
  await symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  await writeFile(path.join(dir, '.bench'), JSON.stringify({ name, port, root: ROOT }, null, 2));
  // Bake the port into the vite config so `npx vite` just works.
  const vc = await readFile(path.join(dir, 'vite.config.js'), 'utf8');
  await writeFile(path.join(dir, 'vite.config.js'), vc.replace(/5173/g, String(port)));
  console.log(dir);
} else if (cmd === 'collect') {
  const dir = path.join(BENCH_ROOT, name);
  let n = 0;
  for (const f of rest) {
    const src = path.join(dir, f);
    if (!existsSync(src)) { console.error(`  ! missing ${f}`); continue; }
    await mkdir(path.dirname(path.join(ROOT, f)), { recursive: true });
    await cp(src, path.join(ROOT, f), { recursive: true });
    console.log(`  ← ${f}`);
    n++;
  }
  console.log(`collected ${n} path(s) from ${name}`);
} else if (cmd === 'list') {
  if (!existsSync(BENCH_ROOT)) { console.log('(none)'); process.exit(0); }
  for (const d of await readdir(BENCH_ROOT)) console.log(d);
} else {
  console.error('usage: bench.mjs create|collect|list');
  process.exit(2);
}
