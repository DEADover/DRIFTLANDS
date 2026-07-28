#!/usr/bin/env node
/**
 * Build shots/history.json — the full development record.
 *
 * The progress page used to show only the newest gallery, so all earlier
 * evolution was invisible. This scans every shot run on disk and emits two
 * views of the same data:
 *
 *   runs[]     chronological, each with its screenshots and telemetry
 *   byPreset{} per preset, that preset across every run in time order —
 *              which is what actually shows progress
 *
 * Runs are ordered by their manifest timestamp, falling back to mtime.
 */
import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHOTS = path.join(ROOT, 'shots');

/** Scratch runs that are not part of the story. */
const SKIP = new Set(['smoke', 'verify', 'seqtest', 'latest', 't']);

export async function buildHistory() {
  if (!existsSync(SHOTS)) return { runs: [], byPreset: {} };
  const runs = [];

  for (const name of await readdir(SHOTS)) {
    const dir = path.join(SHOTS, name);
    let st;
    try { st = await stat(dir); } catch { continue; }
    if (!st.isDirectory() || SKIP.has(name)) continue;

    const pngs = (await readdir(dir)).filter((f) => f.endsWith('.png'));
    if (!pngs.length) continue;

    let manifest = null;
    const mf = path.join(dir, 'manifest.json');
    if (existsSync(mf)) {
      try { manifest = JSON.parse(await readFile(mf, 'utf8')); } catch {}
    }

    const byName = new Map((manifest?.results ?? []).map((r) => [r.name ?? r.id, r]));
    const shots = [];
    for (const f of pngs.sort()) {
      const key = f.replace('.png', '');
      const r = byName.get(key) ?? {};
      shots.push({
        preset: r.id ?? key,
        name: key,
        file: path.relative(ROOT, path.join(dir, f)),
        speedKmh: r.speedKmh ?? null,
        driftAngleDeg: r.driftAngleDeg ?? null,
        drawCalls: r.drawCalls ?? null,
        t: r.t ?? null,
      });
    }

    runs.push({
      run: name,
      at: manifest?.at ?? st.mtime.toISOString(),
      count: shots.length,
      shots,
    });
  }

  runs.sort((a, b) => new Date(a.at) - new Date(b.at));

  // Per-preset evolution: the view that actually shows progress over time.
  const byPreset = {};
  for (const r of runs) {
    for (const s of r.shots) {
      (byPreset[s.preset] ??= []).push({ ...s, run: r.run, at: r.at });
    }
  }

  return { generatedAt: new Date().toISOString(), runs, byPreset };
}

const data = await buildHistory();
await writeFile(path.join(SHOTS, 'history.json'), JSON.stringify(data, null, 2));
console.log(`history: ${data.runs.length} runs, ${Object.keys(data.byPreset).length} presets`);
