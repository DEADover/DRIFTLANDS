#!/usr/bin/env node
/**
 * PHYSICS / COLLISION GROUND TRUTH
 * --------------------------------
 * Boots the real build headless, then raycasts the real triangles and prints
 * how far the drawn world is from the world the physics believes in.
 *
 *   node tools/probe.mjs                       # every audit
 *   node tools/probe.mjs --only sink
 *   node tools/probe.mjs --driven 60            # also drive the route for 60 s
 *   node tools/probe.mjs --json out.json
 *   node tools/probe.mjs --base http://127.0.0.1:5210
 *
 * Exit code is 1 if the sink audit fails its budget, so a builder cannot ship
 * a car that sinks past a critic.
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const av = process.argv.slice(2);
const args = { base: 'http://127.0.0.1:5173', preset: 'hero_alpine' };
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--base') args.base = av[++i];
  else if (a === '--preset') args.preset = av[++i];
  else if (a === '--only') args.only = av[++i];
  else if (a === '--driven') args.driven = Number(av[++i] ?? 45);
  else if (a === '--json') args.json = av[++i];
  else if (a === '--budget') args.budget = Number(av[++i]);
}
// A wheel is 0.34 m in radius. Anything past a third of that reads on screen.
const BUDGET = args.budget ?? 0.12;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const url = `${args.base}/?shot=${args.preset}&hud=0`;
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 180000 });

const report = await page.evaluate(async ({ only, driven }) => {
  const P = await import('/src/dev/probe.js');
  const g = window.__GAME;
  const out = {};
  const want = (k) => !only || only === k;
  if (want('sink')) out.sink = P.auditSink(g);
  if (want('lateral')) out.lateral = P.auditLateral(g);
  if (want('solidity')) out.roadSolidity = P.auditRoadSolidity(g);
  if (want('feet')) out.barrierFeet = P.auditBarrierFeet(g);
  if (want('guards')) out.cornerGuards = P.auditCornerGuards(g);
  if (want('gaps')) out.guardGaps = P.auditGuardGaps(g);
  if (want('deck')) out.deckOverdraw = P.auditDeckOverdraw(g);
  // Driving mutates the world state, so these must go last.
  if (want('wheels')) out.wheels = P.auditWheelSeating(g);
  if (driven) out.driven = P.auditDriven(g, { seconds: driven });
  return out;
}, { only: args.only, driven: args.driven });

await browser.close();

const f = (v, d = 3) => (v === undefined || v === null ? '  --  ' : v.toFixed(d));
const line = (s) => console.log(s);

if (report.sink) {
  const s = report.sink;
  line('');
  line('SINK — drawn surface minus queried height, at the four contact patches');
  line(`  patches ${s.patches}   mean ${f(s.all.mean)} m   p50 ${f(s.all.p50)}   p95 ${f(s.all.p95)}   MAX ${f(s.all.max)}   min ${f(s.all.min)}`);
  line(`  over 0.10 m ${f(s.over['0.10'], 1)}%   over 0.25 m ${f(s.over['0.25'], 1)}%   over 0.50 m ${f(s.over['0.50'], 1)}%   axle-deep ${f(s.over.wheel, 1)}%`);
  for (const [k, v] of Object.entries(s.byKind)) {
    line(`    ${k.padEnd(9)} n ${String(v.n).padStart(5)}   mean ${f(v.mean)}   p95 ${f(v.p95)}   max ${f(v.max)}`);
  }
  line(`  surface-identity mismatch (physics thinks it is on a different surface): ${f(s.kindMismatch, 1)}%`);
  line('  worst:');
  for (const w of s.worst.slice(0, 6)) {
    line(`    ${f(w.sink)} m at (${w.x.toFixed(0)}, ${w.z.toFixed(0)})  drawn ${f(w.drawn, 2)} vs queried ${f(w.queried, 2)}  [${w.kind}/${w.physKind}]`);
  }
}

if (report.wheels) {
  const w = report.wheels;
  line('');
  line('WHEEL SEATING — bottom of each tyre vs the triangle under it (>0 = inside the ground)');
  line(`  samples ${w.samples}   mean ${f(w.all.mean)}   MEDIAN ${f(w.all.p50)}   p95 ${f(w.all.p95)}   MAX ${f(w.all.max)}   min ${f(w.all.min)}   over 0.10 m ${f(w.over['0.10'], 1)}%`);
  const row = (label, pack) => {
    const cells = ['FL', 'FR', 'RL', 'RR'].map((n) => `${n} ${f(pack[n]?.mean, 3)}`).join('   ');
    line(`    ${label.padEnd(11)} ${cells}`);
  };
  row('overall', w.perWheel);
  row('climbing', w.climbing);
  row('descending', w.descending);
}

if (report.driven) {
  const d = report.driven;
  line('');
  line('DRIVEN — wheel bottom vs drawn surface, along the line the car really takes');
  line(`  samples ${d.samples}   mean ${f(d.all.mean)}   p95 ${f(d.all.p95)}   MAX ${f(d.all.max)}`);
  line(`  over 0.10 m ${f(d.over['0.10'], 1)}%   over 0.25 m ${f(d.over['0.25'], 1)}%`);
}

if (report.lateral) {
  line('');
  line('LATERAL — sink as a function of distance from the centre line');
  line('    u(m)     n     mean     p95      max   surface-mismatch');
  for (const r of report.lateral.rows) {
    line(`  ${String(r.u).padStart(5)} ${String(r.n).padStart(6)}  ${f(r.mean)}  ${f(r.p95)}  ${f(r.max)}   ${f(r.mismatch, 1)}%`);
  }
}

if (report.roadSolidity) {
  const r = report.roadSolidity;
  line('');
  line('SOLIDITY — is the road actually there');
  line(`  samples ${r.samples}   holes ${r.holes} (${f(r.holePct, 2)}%)   stacked-surface cracks ${r.cracks}`);
  for (const c of r.worstCracks) line(`    step ${f(c.step, 2)} m at (${c.x}, ${c.z}) u=${c.u}  ${c.a} over ${c.b}`);
}

if (report.barrierFeet) {
  const b = report.barrierFeet;
  line('');
  line('BARRIER FEET — post base minus drawn ground');
  line(`  on ground: samples ${b.samples}   mean ${f(b.all.mean)}   max ${f(b.all.max)}   floating(>0.12) ${f(b.floating, 1)}%   buried(<-0.6) ${f(b.buried, 1)}%`);
  if (b.onDeck) line(`  on a deck: samples ${b.onDeck.samples}   mean gap to deck ${f(b.onDeck.all.mean)}   max ${f(b.onDeck.all.max)}   floating ${f(b.onDeck.floating, 1)}%`);
  for (const w of b.worst.slice(0, 5)) line(`    +${f(w.gap)} m at (${w.x.toFixed(0)}, ${w.z.toFixed(0)}) [${w.kind}]`);
}

if (report.cornerGuards) {
  const c = report.cornerGuards;
  line('');
  line('CORNER GUARDS — roads.audit(), the module that owns the rule');
  if (c.note) line(`  ${c.note}`);
  else {
    line(`  owed ${c.owed} bay-stations   UNPROTECTED ${c.missing}   ${c.ok ? 'PASS' : 'FAIL'}`);
    for (const l of String(c.text ?? '').split('\n').filter((s) => /MISSING|and \d+ shorter/.test(s)).slice(0, 8)) line(`  ${l}`);
  }
}

if (report.guardGaps) {
  const g = report.guardGaps;
  line('');
  line('STEEL OWED AND MISSING — independent of roads.audit()');
  line(`  stations walked ${g.checked}   dangerous-and-unsteeled ${g.dangerous}`);
  line(`  with NOTHING at all ${g.nothingAtAll}   with timber only ${g.timberOnly}`);
  line('    trouble   fall    radius  entry   protected by      at');
  for (const r of g.runs) {
    line(`  ${String(r.trouble).padStart(8)}  ${f(r.fall, 1).padStart(5)} m  ${String(r.radius).padStart(5)} m  ${f(r.entry, 0).padStart(4)}   ${String(r.protectedBy).padEnd(12)}  (${r.x}, ${r.z})  x${r.stations}`);
  }
}

if (report.deckOverdraw) {
  const d = report.deckOverdraw;
  line('');
  line('DECK — road ribbon drawn above the bridge deck');
  if (d.note) line(`  ${d.note}`);
  line(`  deck samples ${d.samples}   overdrawn ${d.overdrawn} (${f(d.overdrawnPct, 1)}%)`);
  for (const w of (d.worst ?? []).slice(0, 5)) line(`    +${f(w.over)} m at (${w.x.toFixed(0)}, ${w.z.toFixed(0)})`);
}

if (errors.length) {
  line('');
  line(`PAGE ERRORS (${errors.length}):`);
  for (const e of errors.slice(0, 6)) line(`  ${e.slice(0, 200)}`);
}

if (args.json) await writeFile(args.json, JSON.stringify(report, null, 2));

line('');
const worst = report.sink?.all?.max;
if (errors.length) { console.log('✗ page errors'); process.exit(1); }
if (worst !== undefined && worst > BUDGET) {
  console.log(`✗ sink ${worst.toFixed(3)} m exceeds budget ${BUDGET} m`);
  process.exit(1);
}
console.log('✓ probe within budget');
