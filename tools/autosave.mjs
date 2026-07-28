#!/usr/bin/env node
/**
 * AUTOSAVE — insurance against losing builder work.
 *
 * Round 1 lost nine agents to a session limit mid-edit. Their files survived
 * only because they happened to be written to disk; anything held in an agent's
 * head at that moment was gone, and there was no history to fall back to.
 *
 * This runs in the background and commits every bench's working tree on a
 * timer. Each bench is its own git repo, so a snapshot is cheap, per-builder,
 * and independently recoverable — `git -C <bench> log` shows every iteration.
 *
 *   node tools/autosave.mjs            # loop forever, 60 s period
 *   node tools/autosave.mjs --once
 *   node tools/autosave.mjs --period 30
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);
const BENCH = process.env.BENCH_ROOT
  || '/private/tmp/claude-501/-Users-sgryzhin-Claude-Projects-CarGame/bench';
const ROOT = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const once = argv.includes('--once');
const period = Number(argv[argv.indexOf('--period') + 1]) || 60;

async function git(dir, args) {
  return exec('git', ['-C', dir, ...args], { maxBuffer: 8 << 20 });
}

async function ensureRepo(dir) {
  if (existsSync(path.join(dir, '.git'))) return;
  await git(dir, ['init', '-q']);
  await writeFile(path.join(dir, '.gitignore'), 'node_modules\nshots\n');
  await git(dir, ['config', 'user.email', 'builder@local']);
  await git(dir, ['config', 'user.name', 'builder']);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', 'bench baseline']).catch(() => {});
}

async function snapshot() {
  if (!existsSync(BENCH)) return [];
  const out = [];
  for (const name of await readdir(BENCH)) {
    const dir = path.join(BENCH, name);
    if (!existsSync(path.join(dir, 'src'))) continue;
    try {
      await ensureRepo(dir);
      const { stdout: status } = await git(dir, ['status', '--porcelain']);
      if (!status.trim()) continue;
      const files = status.trim().split('\n').length;
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-qm', `autosave ${new Date().toISOString()} (${files} files)`]);
      const { stdout: count } = await git(dir, ['rev-list', '--count', 'HEAD']);
      out.push({ name, files, commits: Number(count.trim()) });
    } catch (e) {
      out.push({ name, error: String(e).slice(0, 120) });
    }
  }
  return out;
}

async function tick() {
  const res = await snapshot();
  if (res.length) {
    const stamp = new Date().toISOString().slice(11, 19);
    for (const r of res) {
      console.log(r.error
        ? `[${stamp}] ! ${r.name}: ${r.error}`
        : `[${stamp}] saved ${r.name} (${r.files} files, commit #${r.commits})`);
    }
    await mkdir(path.join(ROOT, 'progress'), { recursive: true });
    await writeFile(
      path.join(ROOT, 'progress/autosave.json'),
      JSON.stringify({ at: new Date().toISOString(), benches: res }, null, 2)
    );
  }
}

await tick();
if (!once) {
  console.log(`autosave running every ${period}s over ${BENCH}`);
  setInterval(() => tick().catch((e) => console.error('autosave:', e)), period * 1000);
}
