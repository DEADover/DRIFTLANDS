import * as THREE from 'three';

/**
 * GROUND TRUTH PROBE — dev only, never imported by the game.
 *
 * Every "the car sinks into the ground" bug in this project has had the same
 * shape: the physics asks one function for the height of the world, and the
 * renderer draws a surface built by a DIFFERENT function. Any argument about
 * whether the car is sinking is then unfalsifiable, because both sides are
 * consistent with their own idea of where the ground is.
 *
 * So this file does not ask the game anything about heights. It fires a ray
 * straight down at the actual triangles in the actual scene and reports what
 * the player can actually see. `drawn - queried` is the sink, in metres, and it
 * is not a matter of opinion.
 *
 * Loaded from tools/probe.mjs via a dynamic import in the page, so it costs the
 * shipped bundle nothing.
 */

/** Surfaces a wheel can rest on. Everything else (props, water, sky) is not ground. */
const DRIVABLE = /^(terrain|road-main|road-spur|bridge|deck|abutment|pier|rail|kerb)/;

function collectDrivable(scene) {
  const out = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    // Named directly, or a child of the bridges group (its parts carry part names).
    let nm = o.name || '';
    let inBridges = false;
    for (let p = o.parent; p; p = p.parent) if (p.name === 'bridges') inBridges = true;
    if (DRIVABLE.test(nm) || inBridges) out.push(o);
  });
  return out;
}

function classify(obj) {
  for (let o = obj; o; o = o.parent) {
    if (o.name === 'bridges') return 'bridge';
    if (o.name === 'terrain') return 'terrain';
    if (o.name === 'road-main' || o.name === 'road-spur') return 'road';
  }
  return obj.name || 'other';
}

/**
 * Topmost drivable surface at (x, z), by raycast.
 * @returns {{y:number, kind:string, normal:THREE.Vector3}|null}
 */
export function makeRaycastSurface(scene) {
  const meshes = collectDrivable(scene);
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = false;
  const dir = new THREE.Vector3(0, -1, 0);
  const org = new THREE.Vector3();
  return (x, z, from = 600) => {
    org.set(x, from, z);
    ray.set(org, dir);
    const hits = ray.intersectObjects(meshes, false);
    if (!hits.length) return null;
    // Topmost = smallest distance from a high origin.
    const h = hits[0];
    return {
      y: h.point.y,
      kind: classify(h.object),
      normal: h.face ? h.face.normal.clone().applyNormalMatrix(
        new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld)) : new THREE.Vector3(0, 1, 0),
      all: hits.map((q) => ({ y: q.point.y, kind: classify(q.object) })),
    };
  };
}

const pct = (a, b) => (b ? (100 * a) / b : 0);

function stats(list) {
  if (!list.length) return { n: 0 };
  const s = list.slice().sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    mean: sum / s.length,
    p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.floor(s.length * 0.95)],
    max: s[s.length - 1],
    min: s[0],
  };
}

/**
 * THE SINK AUDIT.
 *
 * Walks the whole main route. At every station it poses a car on the racing
 * line and, for each of the four contact patches, compares:
 *
 *   queried  what game.groundAt() tells the physics the height is
 *   drawn    what the triangles actually there say it is
 *
 * A positive `drawn - queried` means the visible surface is ABOVE where the
 * wheel is being placed: the wheel is inside the ground. That is the defect.
 */
export function auditSink(game, { stations = 600, wheelR = 0.34 } = {}) {
  const surf = makeRaycastSurface(game.scene);
  const A = 1.35, B = 0.92;
  const rows = [];

  for (let i = 0; i < stations; i++) {
    const s = game.roads.sample(i / stations);
    if (!s) continue;
    const fx = Math.cos(s.heading), fz = -Math.sin(s.heading);
    const rx = -fz, rz = fx;

    for (const [a, b] of [[A, B], [A, -B], [-A, B], [-A, -B]]) {
      const x = s.x + fx * a + rx * b;
      const z = s.z + fz * a + rz * b;
      const d = surf(x, z);
      if (!d) continue;
      const q = game.groundAt(x, z);
      rows.push({
        x, z, station: i,
        drawn: d.y, queried: q.height, sink: d.y - q.height,
        kind: d.kind,
        physKind: q.onBridge ? 'bridge' : q.onRoad ? 'road' : 'terrain',
      });
    }
  }

  const sinks = rows.map((r) => r.sink);
  const byKind = {};
  for (const r of rows) {
    (byKind[r.kind] ??= []).push(r.sink);
  }
  const worst = rows.slice().sort((a, b) => b.sink - a.sink).slice(0, 12);

  // Where physics and the renderer do not even agree WHICH surface you are on,
  // no height reconciliation can help — that is a separate class of bug.
  const kindMismatch = rows.filter((r) => r.kind !== r.physKind).length;

  return {
    patches: rows.length,
    all: stats(sinks),
    over: {
      '0.10': pct(sinks.filter((s) => s > 0.10).length, sinks.length),
      '0.25': pct(sinks.filter((s) => s > 0.25).length, sinks.length),
      '0.50': pct(sinks.filter((s) => s > 0.50).length, sinks.length),
      // A wheel is 0.34 m in radius; sink past that and the axle is underground.
      wheel: pct(sinks.filter((s) => s > wheelR * 2).length, sinks.length),
    },
    byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, stats(v)])),
    kindMismatch: pct(kindMismatch, rows.length),
    worst,
  };
}

/**
 * Same comparison, but along the path the car ACTUALLY drives rather than the
 * geometric centreline — the autopilot's line, sampled every physics step.
 * Catches sinks that only happen under load (banking, drift, landing).
 */
export function auditDriven(game, { seconds = 60, dt = 1 / 60 } = {}) {
  const surf = makeRaycastSurface(game.scene);
  const A = 1.35, B = 0.92;
  const rows = [];
  const frames = Math.round(seconds / dt);

  for (let f = 0; f < frames; f++) {
    game.update(dt, game.autopilotInput({ throttle: 1, aggression: 0.85 }));
    if (f % 6) continue;                       // 10 Hz sampling is plenty
    const v = game.vehicle;
    if (!v.onGround) continue;                 // airborne is not sinking
    const fwd = v.forward, r = v.right;
    for (const [a, b] of [[A, B], [A, -B], [-A, B], [-A, -B]]) {
      const x = v.position.x + fwd.x * a + r.x * b;
      const z = v.position.z + fwd.z * a + r.z * b;
      const d = surf(x, z);
      if (!d) continue;
      // The wheel bottom is where the pose actually put it.
      const pose = game._pose;
      const wheelY = (pose?.y ?? v.position.y) + Math.sin(pose?.pitch ?? 0) * a
        - Math.sin(pose?.roll ?? 0) * b;
      rows.push({ x, z, t: f * dt, drawn: d.y, wheelY, sink: d.y - wheelY, kind: d.kind });
    }
  }

  const sinks = rows.map((r) => r.sink);
  return {
    samples: rows.length,
    all: stats(sinks),
    over: {
      '0.10': pct(sinks.filter((s) => s > 0.10).length, sinks.length),
      '0.25': pct(sinks.filter((s) => s > 0.25).length, sinks.length),
    },
    worst: rows.slice().sort((a, b) => b.sink - a.sink).slice(0, 10),
  };
}

/**
 * DO THE BARRIERS TOUCH THE GROUND?
 *
 * Post bases are placed from `terrain.heightAt` — the analytic field — while
 * what is drawn under them is a triangle of the terrain mesh or, next to the
 * road, the batter of the earthworks. Same disagreement as the car, same
 * result: posts hang in the air or sink to the rail.
 */
export function auditBarrierFeet(game, { cell = 2.0 } = {}) {
  const surf = makeRaycastSurface(game.scene);

  // The barrier segments carry no foot height, so take it from the geometry that
  // is actually drawn: bucket every barrier vertex by ground cell and keep the
  // lowest one. That bucket minimum IS the bottom of the post in that cell.
  const buckets = new Map();
  game.scene.traverse((o) => {
    if (!o.isMesh || !/barrier/.test(o.name || '')) return;
    const p = o.geometry.attributes.position.array;
    const m = o.matrixWorld;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.length; i += 3) {
      v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m);
      const k = `${Math.round(v.x / cell)},${Math.round(v.z / cell)}`;
      const b = buckets.get(k);
      if (!b) buckets.set(k, { x: v.x, z: v.z, lo: v.y, hi: v.y });
      else { if (v.y < b.lo) { b.lo = v.y; b.x = v.x; b.z = v.z; } if (v.y > b.hi) b.hi = v.y; }
    }
  });

  const rows = [];
  const onDeck = [];
  for (const b of buckets.values()) {
    // A cell that holds only rail (no post reaching down) is not evidence of a
    // floating post — a post is at least 0.5 m of vertical extent.
    if (b.hi - b.lo < 0.45) continue;
    // A post at the lip of an embankment is HELD UP BY THE EMBANKMENT even when
    // a ray dropped at its exact centre misses the batter by a few centimetres
    // and lands on the hillside ten metres below. Judging it against that ray
    // manufactures a floating post out of nothing, so take the highest drawn
    // surface the post's own footprint covers: a post is ~0.2 m thick and stands
    // in ground that is not a knife edge.
    const d = surf(b.x, b.z);
    if (!d) continue;
    let best = d;
    for (const [ox, oz] of [[0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35],
                            [0.25, 0.25], [-0.25, 0.25], [0.25, -0.25], [-0.25, -0.25]]) {
      const q = surf(b.x + ox, b.z + oz);
      if (q && q.y > best.y) best = q;
    }
    const row = { x: b.x, z: b.z, foot: b.lo, drawn: best.y, gap: b.lo - best.y, kind: best.kind };
    // A rail on a bridge is BOLTED TO THE DECK and is supposed to overhang the
    // void. Judging it against the valley floor 11 m below is meaningless, so it
    // is counted separately: near a span, the question is only whether the rail
    // is anywhere near deck level.
    const deck = game.bridges.heightAt?.(b.x, b.z);
    const deckNear = deck != null ? deck
      : [[2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5], [5, 0], [-5, 0], [0, 5], [0, -5]]
        .map(([ox, oz]) => game.bridges.heightAt?.(b.x + ox, b.z + oz))
        .find((h) => h != null);
    if (deckNear != null) { onDeck.push({ ...row, deck: deckNear, gapToDeck: b.lo - deckNear }); continue; }
    rows.push(row);
  }
  const gaps = rows.map((r) => r.gap);
  const deckGaps = onDeck.map((r) => r.gapToDeck);
  return {
    samples: rows.length,
    all: stats(gaps),
    onDeck: {
      samples: onDeck.length,
      all: stats(deckGaps),
      floating: pct(deckGaps.filter((g) => g > 0.12).length, deckGaps.length),
    },
    floating: pct(gaps.filter((g) => g > 0.12).length, gaps.length),
    buried: pct(gaps.filter((g) => g < -0.6).length, gaps.length),
    worst: rows.slice().sort((a, b) => b.gap - a.gap).slice(0, 10),
  };
}

/**
 * IS EVERY DANGEROUS CORNER GUARDED?
 *
 * "Dangerous" is curvature tight enough to run wide at speed AND a real fall
 * beyond the verge. A tight corner on flat ground needs nothing.
 */
/**
 * WHERE IS STEEL OWED AND MISSING? — INDEPENDENT OF roads.js.
 *
 * `auditCornerGuards` below delegates to `roads.audit()`, which is the module
 * that PLACES the barriers grading its own work, against its own definition of a
 * dangerous corner and against `terrain.heightAt` rather than the surface it
 * actually draws. It reports 0 unprotected. The player says otherwise, so this
 * asks the question from scratch and shares nothing with it:
 *
 *   - the corner is found by differentiating the route's own heading, not read
 *     off a cached curvature;
 *   - the drop is measured on the DRAWN surface by raycast, outward from the
 *     real carriageway edge, and it is the drop a car would fall, not the
 *     gradient of the hillside;
 *   - "protected" means a barrier bay whose body is within reach of the edge,
 *     and it records whether that bay is STEEL or merely timber — the player
 *     asked specifically about the metal ones, and a timber fence in front of a
 *     15 m fall is decoration.
 *
 * Returns gaps sorted by how much trouble they are: fall x entry speed.
 */
export function auditGuardGaps(game, {
  stations = 900, reach = 15, dropMin = 4.0, look = 8, radiusMax = 140,
} = {}) {
  // CALIBRATION, learned the hard way. The first version took dropMin 2.5 m,
  // looked 14 m out, and applied no radius filter at all, so it reported 352
  // "dangerous" stations — including a 942 m radius sweeper, which is a straight
  // with a kink in it, and falls measured 14 m off the edge that no car leaving
  // the road at that radius would ever reach. An independent walk over the same
  // route found five candidate corners and all five dissolved.
  //
  // A corner only counts if you can actually run wide out of it, and the drop
  // only counts if it is close enough to the edge to fall into: radius under
  // 140 m, fall over 4 m within 8 m of the carriageway.
  
  const surf = makeRaycastSurface(game.scene);
  const segs = game.roads.barriers?.segments ?? [];

  // Bucket the barriers so the proximity test is not O(bays) per station.
  const CELL = 12;
  const grid = new Map();
  for (const s of segs) {
    for (const f of [-1, -0.5, 0, 0.5, 1]) {
      const x = s.x + s.dx * s.half * f, z = s.z + s.dz * s.half * f;
      const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ x, z, kind: s.kind });
    }
  }
  const nearest = (x, z) => {
    let best = null, bd = Infinity;
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    const span = Math.ceil(reach / CELL);
    for (let u = -span; u <= span; u++) {
      for (let v = -span; v <= span; v++) {
        for (const p of grid.get(`${ci + u},${cj + v}`) ?? []) {
          const d = Math.hypot(p.x - x, p.z - z);
          if (d < bd) { bd = d; best = p; }
        }
      }
    }
    return { d: bd, kind: best?.kind ?? null };
  };

  // Sample the centreline, then differentiate it for curvature.
  const S = [];
  for (let i = 0; i < stations; i++) {
    const s = game.roads.sample(i / stations);
    if (s) S.push(s);
  }
  const gaps = [];
  for (let i = 1; i < S.length - 1; i++) {
    const a = S[i - 1], b = S[i], c = S[i + 1];
    let dh = c.heading - a.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const ds = Math.hypot(c.x - a.x, c.z - a.z);
    if (ds < 1e-3) continue;
    const k = dh / ds;                                  // 1/radius, signed
    const radius = Math.abs(k) > 1e-6 ? 1 / Math.abs(k) : Infinity;

    // Outside of the bend, in world space.
    const fx = Math.cos(b.heading), fz = -Math.sin(b.heading);
    const rx = -fz, rz = fx;
    const side = k > 0 ? 1 : -1;

    // Walk out to the real carriageway edge, then keep going and watch the
    // drawn surface fall away.
    let edge = 0;
    for (let u = 2; u <= 26; u += 0.5) {
      if (!game.roads.isOnRoad(b.x + rx * side * u, b.z + rz * side * u)) { edge = u; break; }
    }
    if (!edge) continue;
    const ex = b.x + rx * side * edge, ez = b.z + rz * side * edge;
    const top = surf(ex, ez);
    if (!top) continue;
    let fall = 0, fallAt = 0;
    for (let u = 1; u <= look; u += 1) {
      const d = surf(ex + rx * side * u, ez + rz * side * u);
      if (!d) continue;
      const f = top.y - d.y;
      if (f > fall) { fall = f; fallAt = u; }
    }
    if (fall < dropMin) continue;

    // A corner you can carry speed into is more dangerous than a hairpin.
    if (radius > radiusMax) continue;
    // Entry speed a car can actually carry through this radius on this grip.
    // Capped at the car's own top speed, but the cap must not swallow the whole
    // signal: at radius 213 the uncapped figure is 76 m/s, so with a 40 m/s cap
    // every corner scored identically and the radius did nothing at all. That is
    // why the radius filter above exists rather than a speed weighting.
    const entry = Math.min(40, Math.sqrt(2.8 * 9.81 * radius));
    const n = nearest(ex, ez);
    const covered = n.d <= reach;
    if (covered && n.kind === 'guard') continue;         // steel present: fine
    gaps.push({
      x: +ex.toFixed(1), z: +ez.toFixed(1),
      radius: Math.round(radius), fall: +fall.toFixed(1), fallAt,
      entry: +entry.toFixed(1),
      protectedBy: covered ? n.kind : 'nothing',
      nearestBay: covered ? +n.d.toFixed(1) : null,
      trouble: +(fall * entry).toFixed(0),
    });
  }
  gaps.sort((p, q) => q.trouble - p.trouble);

  // Collapse runs of adjacent stations into one reported gap.
  const runs = [];
  for (const g of gaps) {
    const near = runs.find((r) => Math.hypot(r.x - g.x, r.z - g.z) < 30);
    if (near) { near.stations++; if (g.fall > near.fall) { near.fall = g.fall; } continue; }
    runs.push({ ...g, stations: 1 });
  }
  return {
    checked: S.length,
    dangerous: gaps.length,
    nothingAtAll: gaps.filter((g) => g.protectedBy === 'nothing').length,
    timberOnly: gaps.filter((g) => g.protectedBy === 'fence').length,
    runs: runs.slice(0, 20),
  };
}

export function auditCornerGuards(game) {
  // roads.js owns the definition of "a barrier is owed here" and already walks
  // every route to check it. Re-deriving that here would only give us a second,
  // differently-wrong answer.
  const a = game.roads.audit?.();
  if (!a) return { note: 'roads.audit() not available' };
  return a;
}

/**
 * IS THE DECK CLEAN TIMBER?
 *
 * Over a span the deck is the drivable surface; if the road ribbon is drawn
 * above it you get gravel on the planks and, worse, two surfaces fighting over
 * the wheel.
 */
export function auditDeckOverdraw(game, { stations = 400 } = {}) {
  const scene = game.scene;
  const bridgeMeshes = [];
  const roadMeshes = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    let inB = false;
    for (let p = o; p; p = p.parent) if (p.name === 'bridges') inB = true;
    if (inB) bridgeMeshes.push(o);
    else if (o.name === 'road-main' || o.name === 'road-spur') roadMeshes.push(o);
  });
  if (!bridgeMeshes.length) return { decks: 0, note: 'no bridges in scene' };

  const ray = new THREE.Raycaster();
  const dir = new THREE.Vector3(0, -1, 0);
  const org = new THREE.Vector3();
  const top = (list, x, z) => {
    org.set(x, 600, z);
    ray.set(org, dir);
    const h = ray.intersectObjects(list, false);
    return h.length ? h[0].point.y : null;
  };

  const rows = [];
  for (let i = 0; i < stations; i++) {
    const s = game.roads.sample(i / stations);
    if (!s) continue;
    if (game.bridges.heightAt(s.x, s.z) == null) continue;   // not over a span
    const fx = Math.cos(s.heading), fz = -Math.sin(s.heading);
    const rx = -fz, rz = fx;
    for (const u of [-3.5, -1.8, 0, 1.8, 3.5]) {
      const x = s.x + rx * u, z = s.z + rz * u;
      const deck = top(bridgeMeshes, x, z);
      const road = top(roadMeshes, x, z);
      if (deck == null) continue;
      rows.push({ x, z, deck, road, over: road == null ? -99 : road - deck });
    }
  }
  const bad = rows.filter((r) => r.over > 0.01);
  return {
    samples: rows.length,
    overdrawn: bad.length,
    overdrawnPct: pct(bad.length, rows.length),
    worst: bad.sort((a, b) => b.over - a.over).slice(0, 8),
  };
}

/**
 * IS THE ROAD A SOLID SURFACE?
 *
 * Two failures the sink audit cannot see:
 *   holes   a downward ray through the carriageway hits nothing drivable at all
 *   gaps    the road and the terrain leave a vertical crack between them, so
 *           the wheel can find a height that belongs to neither
 */
export function auditRoadSolidity(game, { stations = 500 } = {}) {
  const surf = makeRaycastSurface(game.scene);
  let holes = 0, samples = 0;
  const cracks = [];
  for (let i = 0; i < stations; i++) {
    const s = game.roads.sample(i / stations);
    if (!s) continue;
    const fx = Math.cos(s.heading), fz = -Math.sin(s.heading);
    const rx = -fz, rz = fx;
    // Across the carriageway and out past the verge into the earthworks.
    for (const u of [-9, -6, -3, -1, 0, 1, 3, 6, 9, 12]) {
      const x = s.x + rx * u, z = s.z + rz * u;
      samples++;
      const d = surf(x, z);
      if (!d) { holes++; continue; }
      // Two drivable surfaces stacked with a big step between them is a crack
      // the physics can fall into.
      if (d.all.length > 1) {
        const step = d.all[0].y - d.all[1].y;
        if (step > 1.2 && d.all[0].kind !== d.all[1].kind) {
          cracks.push({ x: +x.toFixed(1), z: +z.toFixed(1), u, step: +step.toFixed(2), a: d.all[0].kind, b: d.all[1].kind });
        }
      }
    }
  }
  return { samples, holes, holePct: pct(holes, samples), cracks: cracks.length, worstCracks: cracks.sort((a, b) => b.step - a.step).slice(0, 8) };
}

/**
 * ACROSS THE ROAD, NOT ALONG IT.
 *
 * The sink audit walks the racing line, so it never leaves the carriageway. But
 * the specific report was "the car is at the EDGE of the road and it still falls
 * through", and the edge is where the crown, the verge, the earthworks and the
 * bare terrain all have to hand over to one another. Each handover is a place
 * the query and the mesh can part company.
 *
 * So: sweep laterally at every station and report the disagreement as a
 * function of distance from the centre line. A clean road is flat near zero and
 * stays flat all the way out; a bad handover shows as a spike at one offset.
 */
export function auditLateral(game, { stations = 300, out = 20, step = 1.0 } = {}) {
  const surf = makeRaycastSurface(game.scene);
  const bins = new Map();
  for (let i = 0; i < stations; i++) {
    const s = game.roads.sample(i / stations);
    if (!s) continue;
    const rx = Math.sin(s.heading), rz = Math.cos(s.heading);
    for (let u = -out; u <= out; u += step) {
      const x = s.x + rx * u, z = s.z + rz * u;
      const d = surf(x, z);
      if (!d) continue;
      const q = game.groundAt(x, z);
      const key = Math.round(u);
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push({
        sink: d.y - q.height, drawn: d.kind,
        phys: q.onBridge ? 'bridge' : q.onRoad ? 'road' : 'terrain',
      });
    }
  }
  const rows = [];
  for (const [u, list] of [...bins.entries()].sort((a, b) => a[0] - b[0])) {
    const st = stats(list.map((r) => r.sink));
    const mism = pct(list.filter((r) => r.drawn !== r.phys).length, list.length);
    rows.push({ u, n: st.n, mean: st.mean, p95: st.p95, max: st.max, mismatch: mism });
  }
  return { rows };
}

/**
 * WHERE ARE THE WHEELS, ACTUALLY?
 *
 * Everything else here measures the height FUNCTIONS. This measures the scene
 * graph: it takes the world position of the four wheel nodes the renderer is
 * about to draw, drops to the bottom of the tyre, and compares that against the
 * triangle underneath it.
 *
 * This is the only audit that can catch a sign error in the body pose, because
 * a mirrored pitch keeps the CENTRE of the car exactly right and buries one
 * axle while lifting the other. Reported per wheel and split by whether the car
 * is climbing or descending — a sign error shows up as front and rear having
 * equal and opposite errors that swap when the gradient does.
 */
export function auditWheelSeating(game, { seconds = 40, dt = 1 / 60, wheelR = 0.46 } = {}) {
  const surf = makeRaycastSurface(game.scene);
  const NAMES = ['FL', 'FR', 'RL', 'RR'];
  const per = [[], [], [], []];
  const climbing = [[], [], [], []];
  const descending = [[], [], [], []];
  const v3 = new THREE.Vector3();
  const frames = Math.round(seconds / dt);

  for (let f = 0; f < frames; f++) {
    game.update(dt, game.autopilotInput({ throttle: 1, aggression: 0.85 }));
    if (f % 6) continue;
    const v = game.vehicle;
    if (!v.onGround) continue;
    const view = game.carView;
    if (!view?.wheels) break;
    // Gradient along the car, from the pose the game itself computed.
    const grade = game._pose?.pitch ?? 0;
    for (let i = 0; i < 4; i++) {
      view.wheels[i].getWorldPosition(v3);
      const d = surf(v3.x, v3.z);
      if (!d) continue;
      const bottom = v3.y - wheelR;
      const err = d.y - bottom;                    // >0 = tyre is inside the ground
      per[i].push(err);
      if (grade > 0.05) climbing[i].push(err);
      else if (grade < -0.05) descending[i].push(err);
    }
  }

  const pack = (lists) => Object.fromEntries(NAMES.map((n, i) => [n, stats(lists[i])]));
  const flat = per.flat();
  return {
    samples: flat.length,
    all: stats(flat),
    over: { '0.10': pct(flat.filter((e) => e > 0.10).length, flat.length) },
    perWheel: pack(per),
    climbing: pack(climbing),
    descending: pack(descending),
  };
}

export function runAll(game, opts = {}) {
  return {
    sink: auditSink(game, opts),
    barrierFeet: auditBarrierFeet(game),
    cornerGuards: auditCornerGuards(game),
    deckOverdraw: auditDeckOverdraw(game),
    roadSolidity: auditRoadSolidity(game),
  };
}
