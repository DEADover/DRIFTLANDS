#!/usr/bin/env node
/**
 * Progress log writer. Append-only JSONL so parallel agents never clobber each
 * other, plus a rolled-up data.json the page reads.
 *
 * Usage:
 *   node tools/progress.mjs event --kind build   --round 1 --actor terrain --title "..." --body "..."
 *   node tools/progress.mjs event --kind critic  --round 1 --actor art-critic \
 *        --title "..." --score 42 --verdict lose --shot shots/r01/hero_alpine.png --body "..."
 *   node tools/progress.mjs round --round 1 --title "Foundations" --status running
 *   node tools/progress.mjs rebuild            # regenerate data.json from the log
 */
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'progress');
const LOG = path.join(DIR, 'log.jsonl');
const DATA = path.join(DIR, 'data.json');

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      if (o[k] === undefined) o[k] = v;
      else o[k] = [].concat(o[k], v);
    }
  }
  return o;
}

const [cmd, ...rest] = process.argv.slice(2);
const a = parse(rest);
await mkdir(DIR, { recursive: true });

if (cmd === 'event' || cmd === 'round') {
  const rec = {
    ts: new Date().toISOString(),
    type: cmd,
    kind: a.kind ?? (cmd === 'round' ? 'round' : 'note'),
    round: a.round ? Number(a.round) : null,
    actor: a.actor ?? 'lead',
    title: a.title ?? '',
    body: a.body ?? '',
    score: a.score !== undefined ? Number(a.score) : null,
    verdict: a.verdict ?? null,
    status: a.status ?? null,
    shots: a.shot ? [].concat(a.shot) : [],
    metrics: a.metrics ? JSON.parse(a.metrics) : null,
  };
  await appendFile(LOG, JSON.stringify(rec) + '\n');
}

// ---- roll up ---------------------------------------------------------------
const lines = existsSync(LOG) ? (await readFile(LOG, 'utf8')).trim().split('\n').filter(Boolean) : [];
const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const rounds = new Map();
for (const e of events) {
  if (e.round == null) continue;
  if (!rounds.has(e.round)) rounds.set(e.round, { round: e.round, title: '', status: 'running', events: [] });
  const r = rounds.get(e.round);
  if (e.type === 'round') {
    if (e.title) r.title = e.title;
    if (e.status) r.status = e.status;
  } else {
    r.events.push(e);
  }
}

// Score history per preset, for the trend chart.
const scoreSeries = {};
for (const e of events) {
  if (e.kind !== 'critic' || e.score == null) continue;
  const key = e.actor || 'critic';
  (scoreSeries[key] ??= []).push({ round: e.round, score: e.score, verdict: e.verdict });
}

const data = {
  generatedAt: new Date().toISOString(),
  rounds: [...rounds.values()].sort((x, y) => y.round - x.round),
  scoreSeries,
  totals: {
    builds: events.filter((e) => e.kind === 'build').length,
    critiques: events.filter((e) => e.kind === 'critic').length,
    wins: events.filter((e) => e.verdict === 'win').length,
    rounds: rounds.size,
  },
};
await writeFile(DATA, JSON.stringify(data, null, 2));
if (cmd) console.log(`progress: ${events.length} events, ${rounds.size} rounds`);
