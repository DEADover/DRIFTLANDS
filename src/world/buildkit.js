import * as THREE from 'three';

/**
 * BUILDKIT — shared low-poly construction helpers for props.js and landmarks.js.
 *
 * Everything here produces flat-shadable, vertex-coloured BufferGeometry. No
 * textures, ever. A whole chalet or a whole fir tree ends up as ONE geometry
 * with a `color` attribute, so it can be drawn as a single instanced mesh or
 * merged into a single static batch.
 *
 * Colour policy: nothing in here invents a hex. Callers pass THREE.Color values
 * derived from the biome palette (see `derivePalette` below), so art direction
 * stays in render/palette.js.
 */

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

/** Triangle in the XY plane extruded along Z. The workhorse for roofs/signs. */
export function triPrism(ax, ay, bx, by, cx, cy, depth) {
  const h = depth / 2;
  const A0 = [ax, ay, -h], B0 = [bx, by, -h], C0 = [cx, cy, -h];
  const A1 = [ax, ay, h], B1 = [bx, by, h], C1 = [cx, cy, h];
  const v = [];
  const tri = (p, q, r) => { v.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]); };
  tri(A0, C0, B0);
  tri(A1, B1, C1);
  tri(A0, B0, B1); tri(A0, B1, A1);
  tri(B0, C0, C1); tri(B0, C1, B1);
  tri(C0, A0, A1); tri(C0, A1, C1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

/** Convex polygon in XY, extruded along Z. Points must wind counter-clockwise. */
export function prism(points, depth) {
  const geos = [];
  for (let i = 1; i < points.length - 1; i++) {
    geos.push(triPrism(
      points[0][0], points[0][1],
      points[i][0], points[i][1],
      points[i + 1][0], points[i + 1][1],
      depth
    ));
  }
  return mergePlain(geos);
}

/** Gable (ridged) roof. Ridge runs along local X. */
export function gableRoof(width, height, depth) {
  const g = triPrism(-depth / 2, 0, depth / 2, 0, 0, height, width);
  g.rotateY(Math.PI / 2);
  return g;
}

/** Hipped / pyramid roof over a rectangular plan. */
export function pyramidRoof(width, height, depth) {
  const hw = width / 2, hd = depth / 2;
  const apex = [0, height, 0];
  const c = [[-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd]];
  const v = [];
  const tri = (p, q, r) => v.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
  for (let i = 0; i < 4; i++) tri(c[i], c[(i + 1) % 4], apex);
  tri(c[0], c[2], c[1]); tri(c[0], c[3], c[2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

/** Merge without colour (position + normal only). */
export function mergePlain(geos) {
  let total = 0;
  const prep = [];
  for (const g0 of geos) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    if (!g.attributes.normal) g.computeVertexNormals();
    total += g.attributes.position.count;
    prep.push(g);
  }
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of prep) {
    pos.set(g.attributes.position.array, o * 3);
    nrm.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return out;
}

/**
 * Merge with a flat colour per part -> one geometry, `color` attribute filled.
 *
 * A part may also carry `top`: a SECOND colour blended in by how far the face
 * points at the sky. This is how the reference's boulders work and it cannot
 * be faked with lighting alone — a Lambert term multiplies whatever albedo it
 * is given, so a rock whose whole albedo is a mid grey can never produce a
 * bright pixel however the key light is aimed. In target_01 the planed-off top
 * of a meadow block is one of the three brightest things in the frame (with
 * the gravel and the water), and it is bright because the STONE is nearly
 * white up there and merely grey down the sides.
 */
export function mergeColored(parts) {
  let total = 0;
  const prep = [];
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    if (!g.attributes.normal) g.computeVertexNormals();
    total += g.attributes.position.count;
    prep.push({
      g, c: p.color, top: p.top, t0: p.t0 ?? 0.30, t1: p.t1 ?? 0.86,
      low: p.low, l0: p.l0 ?? -0.55,
    });
  }
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const { g, c, top, t0, t1, low, l0 } of prep) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nrm.set(g.attributes.normal.array, o * 3);
    if (top) {
      const na = g.attributes.normal.array;
      const span = Math.max(1e-4, t1 - t0);
      // THREE-STOP RAMP, and why stone needs one.
      //
      // Two stops (body -> sunlit top) is what produced the salmon boulders: to
      // get a bright crown at all the top stop had to be lerped most of the way
      // to a strongly warm highlight, and because EVERY face above t0 landed on
      // it, a chunky block ended up warm all over with no shadow side left. In
      // target_01 a meadow boulder is three clear planes — a cool dark
      // underside, a neutral grey flank, and a pale slightly-warm top — and the
      // separation between them is albedo, not lighting. `low` supplies the
      // bottom of that ramp for faces pointing at the ground.
      const lspan = Math.max(1e-4, t0 - l0);
      for (let i = 0; i < n; i++) {
        const ny = na[i * 3 + 1];
        let r, gg, b;
        if (low && ny < t0) {
          let t = (ny - l0) / lspan;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const k = t * t * (3 - 2 * t);
          r = low.r + (c.r - low.r) * k;
          gg = low.g + (c.g - low.g) * k;
          b = low.b + (c.b - low.b) * k;
        } else {
          let t = (ny - t0) / span;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const k = t * t * (3 - 2 * t);
          r = c.r + (top.r - c.r) * k;
          gg = c.g + (top.g - c.g) * k;
          b = c.b + (top.b - c.b) * k;
        }
        col[(o + i) * 3] = r; col[(o + i) * 3 + 1] = gg; col[(o + i) * 3 + 2] = b;
      }
      o += n;
      continue;
    }
    for (let i = 0; i < n; i++) {
      col[(o + i) * 3] = c.r; col[(o + i) * 3 + 1] = c.g; col[(o + i) * 3 + 2] = c.b;
    }
    o += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

/**
 * Accumulates coloured primitives under a transform stack, then bakes them into
 * one geometry. `push(...)` / `pop()` behave like an immediate-mode matrix stack
 * so a building can be authored in local coordinates and dropped anywhere.
 */
export class GeoBuilder {
  constructor() {
    this.parts = [];
    this._stack = [new THREE.Matrix4()];
    this.tris = 0;
  }

  get m() { return this._stack[this._stack.length - 1]; }

  push(x = 0, y = 0, z = 0, yaw = 0, scale = 1) {
    const m = new THREE.Matrix4().compose(
      _v.set(x, y, z),
      _q.setFromEuler(_e.set(0, yaw, 0)),
      _s.set(scale, scale, scale)
    );
    this._stack.push(this.m.clone().multiply(m));
    return this;
  }

  /** Push with an extra tilt about X and Z (for leaning poles, wonky ruins). */
  pushTilt(x, y, z, yaw, pitch, roll, scale = 1) {
    const m = new THREE.Matrix4().compose(
      _v.set(x, y, z),
      _q.setFromEuler(_e.set(pitch, yaw, roll, 'YXZ')),
      _s.set(scale, scale, scale)
    );
    this._stack.push(this.m.clone().multiply(m));
    return this;
  }

  pop() { if (this._stack.length > 1) this._stack.pop(); return this; }

  raw(geo, color) {
    geo.applyMatrix4(this.m);
    const c = color.isColor ? color : new THREE.Color(color);
    this.parts.push({ geo, color: c });
    this.tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    return this;
  }

  /** `raw`, but sky-facing facets fade to `top` and (optionally) ground-facing
   *  ones fade to `o.low`. See `mergeColored`. */
  rawLit(geo, color, top, o = {}) {
    geo.applyMatrix4(this.m);
    const C2 = (v) => (v.isColor ? v : new THREE.Color(v));
    this.parts.push({
      geo, color: C2(color), top: C2(top), t0: o.t0, t1: o.t1,
      low: o.low ? C2(o.low) : undefined, l0: o.l0,
    });
    this.tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    return this;
  }

  box(w, h, d, color, o = {}) {
    const g = new THREE.BoxGeometry(w, h, d);
    return this.raw(place(g, o), color);
  }

  cyl(rTop, rBot, h, seg, color, o = {}) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, o.open ?? false);
    return this.raw(place(g, o), color);
  }

  /** `o.open` drops the base cap — halves the triangle count on anything whose
   *  underside is buried in grass (flower heads, stems, tufts). */
  cone(r, h, seg, color, o = {}) {
    const g = new THREE.ConeGeometry(r, h, seg, 1, o.open ?? false);
    return this.raw(place(g, o), color);
  }

  blob(r, color, o = {}) {
    const g = new THREE.IcosahedronGeometry(r, o.detail ?? 0);
    return this.raw(place(g, o), color);
  }

  gable(w, h, d, color, o = {}) { return this.raw(place(gableRoof(w, h, d), o), color); }
  pyramid(w, h, d, color, o = {}) { return this.raw(place(pyramidRoof(w, h, d), o), color); }
  tri(ax, ay, bx, by, cx, cy, depth, color, o = {}) {
    return this.raw(place(triPrism(ax, ay, bx, by, cx, cy, depth), o), color);
  }

  build() { return mergeColored(this.parts); }
}

/** Local rotate-then-translate for a primitive inside the builder's frame. */
function place(g, o) {
  if (o.sx || o.sy || o.sz) g.scale(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
  if (o.rx) g.rotateX(o.rx);
  if (o.rz) g.rotateZ(o.rz);
  if (o.ry) g.rotateY(o.ry);
  g.translate(o.x ?? 0, o.y ?? 0, o.z ?? 0);
  return g;
}

/**
 * Per-CORNER displacement table for a polyhedron.
 *
 * THREE's IcosahedronGeometry (PolyhedronGeometry) is NON-INDEXED: each of the
 * twelve corners appears five times, once per adjacent face, as five separate
 * vertices at the same position. Jittering `pos` vertex-by-vertex therefore
 * pulls the five copies of a corner in five different directions, which tears
 * the solid open into folded, self-intersecting sheets whose recomputed normals
 * point every which way. That — not a scale bug — is what produced the large
 * pale angular "scraps of paper" scattered through the alpine meadow: a rock
 * with +/-42% independent corner jitter is not a rock, it is confetti.
 *
 * So: hash the ORIGINAL position, and hand every copy of a corner the SAME
 * displacement. The result stays a closed convex-ish solid with clean facets.
 */
function cornerTable(rng, pos, make) {
  const table = new Map();
  const key = (x, y, z) =>
    `${Math.round(x * 512)},${Math.round(y * 512)},${Math.round(z * 512)}`;
  const out = [];
  for (let i = 0; i < pos.count; i++) {
    const k = key(pos.getX(i), pos.getY(i), pos.getZ(i));
    let v = table.get(k);
    if (!v) table.set(k, (v = make()));
    out.push(v);
  }
  return out;
}

/** Randomised faceted rock — a chunky closed solid, never a folded sheet. */
export function rockGeom(rng, opts = {}) {
  const g = new THREE.IcosahedronGeometry(1, opts.detail ?? 0);
  const pos = g.attributes.position;
  const jx = opts.jitter ?? 0.30;
  const J = cornerTable(rng, pos, () => ({
    kx: rng.float(1 - jx, 1 + jx),
    ky: rng.float(0.62, 1.02),
    kz: rng.float(1 - jx, 1 + jx),
  }));
  for (let i = 0; i < pos.count; i++) {
    const j = J[i];
    const x0 = pos.getX(i), y0 = pos.getY(i), z0 = pos.getZ(i);
    // A gentle coherent swell so the facets are not all the same size.
    const k = 1 + Math.sin(x0 * 3.1 + z0 * 2.3) * jx * 0.30;
    pos.setXYZ(i, x0 * k * j.kx, y0 * j.ky, z0 * k * j.kz);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Faceted rock with a FLAT-ISH TOP — the shape that dominates the alpine
 * reference: a half-buried block whose upper faces have been planed off, so it
 * catches the key light as one bright polygon instead of a busy sparkle. The
 * top is squashed toward a plane rather than cut, which keeps the silhouette
 * irregular where it meets the grass.
 */
export function slabGeom(rng, opts = {}) {
  const g = new THREE.IcosahedronGeometry(1, opts.detail ?? 0);
  const pos = g.attributes.position;
  const jx = opts.jitter ?? 0.24;
  const top = opts.top ?? 0.66;      // height at which the plane starts
  const squash = opts.squash ?? 0.45; // how much of the peak survives
  // Same corner-coherent jitter as rockGeom. The old per-vertex version at
  // jitter 0.42 was the single worst-looking thing in the alpine frame.
  const J = cornerTable(rng, pos, () => ({
    kx: rng.float(1 - jx, 1 + jx),
    ky: rng.float(0.86, 1.14),
    kz: rng.float(1 - jx, 1 + jx),
  }));
  for (let i = 0; i < pos.count; i++) {
    const j = J[i];
    // The old shape ran y from -1.15 to +0.60 and was then dropped with its
    // origin 0.11 BELOW the ground, so five sixths of the rock was buried and
    // what showed was a 2.4-wide, 0.45-tall wafer: a chunky boulder rendered as
    // a beer mat. The mass is lifted so roughly the top 60% stands proud, and
    // the horizontal is pulled in, giving a block about twice as wide as it is
    // tall — which is what the reference's meadow boulders measure.
    let x = pos.getX(i) * j.kx * 0.88;
    let y = pos.getY(i) * j.ky * 0.86 + 0.16;
    let z = pos.getZ(i) * j.kz * 0.88;
    if (y > top) y = top + (y - top) * squash;
    // Flare the base outward so the rock looks bedded into the ground.
    if (y < 0) { const k = 1 + (-y) * 0.16; x *= k; z *= k; }
    pos.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * ANGULAR BLOCK — the OTHER rock silhouette, and the reason "different rocks"
 * was a shape note as well as a colour one.
 *
 * `rockGeom` and `slabGeom` are both a jittered icosahedron: twenty smallish
 * facets, a roughly spherical hull, no long straight edges. However far apart
 * their parameters are set they belong to one family, and a meadow furnished
 * entirely from that family reads as one rock repeated — which is exactly what
 * the client saw. target_01 mixes them with cleaved blocks: four big flat
 * faces, hard vertical edges, a planed top, the shape granite makes when it
 * splits along a joint.
 *
 * A jittered BoxGeometry gives that for twelve triangles. It is indexed with
 * four vertices per face, so the corner-coherent displacement table matters
 * here for the same reason it does on the icosahedron: three copies of each
 * corner must move together or the block tears open.
 */
export function blockGeom(rng, opts = {}) {
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const pos = g.attributes.position;
  const jx = opts.jitter ?? 0.26;
  const taper = opts.taper ?? 0.22;   // top narrower than base — weathered, not a crate
  const J = cornerTable(rng, pos, () => ({
    dx: rng.float(-jx, jx), dy: rng.float(-jx * 0.55, jx * 0.55), dz: rng.float(-jx, jx),
  }));
  for (let i = 0; i < pos.count; i++) {
    const j = J[i];
    const y = pos.getY(i);
    const k = y > 0 ? 1 - taper : 1 + taper * 0.35;
    pos.setXYZ(i, pos.getX(i) * (1 + j.dx) * k, y * (1 + j.dy), pos.getZ(i) * (1 + j.dz) * k);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * ONE TIER OF A CONIFER — a scalloped, drooping skirt, not a plain cone.
 *
 * A plain `ConeGeometry` is the wrong primitive for this and it took a side-by
 * -side crop of target_01 to see why. Every side facet of a cone shares the
 * SAME normal.y, so (a) the tier is one flat tone all the way round apart from
 * whatever the key light does to it, and (b) the vertex-colour ramp in
 * `mergeColored`, which keys off normal.y, cannot separate the top of a skirt
 * from its underside. Our firs were therefore a single green per tier with a
 * gentle Lambert wash, and the reference's are a mosaic of alternating bright
 * and dark triangles that reads as needles catching the sun.
 *
 * This builds the tier from an apex and a rim ring whose vertices ALTERNATE:
 * odd ones are pushed out to the full radius and dropped by `droop`, even ones
 * pulled in to `notch` of it and left level. Consequences, all of them wanted:
 *
 *   * the plan-view silhouette is a star with `seg/2` points — the scalloped
 *     skirt edge the reference has, instead of a smooth octagon;
 *   * adjacent facets tilt differently, so half of them face up-and-out and
 *     half down-and-out. The `low`/`top` ramp then gives a real light side and
 *     dark side WITHIN one tier, independent of where the sun is — which
 *     matters because instances are randomly yawed and no baked directional
 *     shading could survive that;
 *   * it costs exactly `seg` triangles, the same as an open cone.
 *
 * ---- ROUND 8: PER-FACET, NOT PER-FAMILY --------------------------------
 *
 * The first version alternated long/short rim vertices at two FIXED heights,
 * and shot that way every tier still came out one flat green. The reason is
 * geometric: the "long-then-short" facet and the "short-then-long" facet are
 * mirror images of each other, so they have the SAME normal.y, and a ramp that
 * keys off normal.y cannot separate them. A tier had two families of facet and
 * one value.
 *
 * Cropping target_01's fir at 8x shows what it actually is: every triangle in
 * a skirt is a different value, from #2a4d22 in the shade to #86b054 in the
 * sun, and that mosaic is most of what makes the reference's conifers read as
 * needles rather than as painted cones. So each rim vertex now gets its own
 * radius AND its own droop, which makes every facet its own plane. Rim
 * vertices are still shared between neighbours, so the surface stays closed
 * and the silhouette stays a star.
 */
export function firTier(r, h, seg, droop, notch, rng) {
  const v = [];
  const ax = 0, ay = h, az = 0;
  const rim = [];
  const f = rng ? (a, b) => rng.float(a, b) : (a, b) => (a + b) / 2;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const long = i % 2 === 0;
    // Long spurs reach the full radius and hang; short ones are pulled in and
    // sit high. The extra jitter on both is what breaks the mirror symmetry.
    // The jitter has to be WIDE. Shot at f(0.75,1.30) a skirt still resolved
    // into two values — a lit half and a dark half — because neighbouring
    // facets differed by only a couple of degrees of tilt and the ramp could
    // not tell them apart. target_01's skirt is a dozen values. At this spread
    // adjacent facets differ by fifteen or twenty degrees, which is the whole
    // mosaic and costs nothing.
    const rr = r * (long ? f(0.82, 1.12) : notch * f(0.70, 1.28));
    const dy = long ? -droop * f(0.40, 1.60) : -droop * f(-0.65, 0.65);
    rim.push([Math.cos(a) * rr, dy, Math.sin(a) * rr]);
  }
  // WINDING. The first version of this pushed (apex, rim[i], rim[i+1]), which
  // for a rim running (cos a, sin a) with +Y up is the INWARD face: every
  // computed normal pointed into the tree, so the ramp below read the wrong
  // sign and Lambert lit the far side. That is why this function sat unused for
  // three rounds while props.js kept building firs out of plain cones.
  for (let i = 0; i < seg; i++) {
    const p = rim[i], q = rim[(i + 1) % seg];
    v.push(ax, ay, az, q[0], q[1], q[2], p[0], p[1], p[2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

/**
 * ONE TIER OF A CONIFER, TAKE THREE — a ring of drooping two-facet FLAPS over a
 * shallow bright crown. This is the shape target_01 actually has, and the only
 * way to see it was to crop its fir at 6x (scratch/ref_trunk.png): a tier is not
 * a cone and not a star, it is six or seven little hanging TENTS. Each tent has
 * a ridge running from the tier's hub out and DOWN to its tip, so it shows two
 * facets that tilt in opposite directions round the trunk — a light half and a
 * dark half — and between two neighbouring tents there is a near-vertical wall
 * that reads as the shadowed interior of the tree.
 *
 * ---- WHY `firTier` COULD NOT PRODUCE THIS, MEASURED ------------------------
 *
 * `firTier` (kept below, still used for the leader) is an apex plus ONE rim ring
 * with alternating long/short vertices. Round 8 widened its jitter a long way
 * trying to make each facet its own value and it stayed flat, and the reason is
 * arithmetic, not tuning. Take a tier r = 1, apex 1.0 up, long rim at (1.0,
 * -0.55), short rim at (0.55, +0.10) and compute the two facets either side of a
 * long spur:
 *
 *     long-then-short   ny 0.519      short-then-long   ny 0.500
 *
 * They are MIRROR IMAGES, so their normal.y agrees to two percent however far
 * apart their radii are pushed — and `mergeColored`'s ramp keys off normal.y.
 * One ring can only ever give one value. Their AZIMUTHS also came out 19.6° and
 * 19.2°, i.e. both facets face the same way round the trunk, so the directional
 * key could not separate them either. A one-ring tier is a cone with a jagged
 * hem, and that is exactly what our firs read as.
 *
 * ---- WHAT TWO RINGS BUY, SAME MEASUREMENT ---------------------------------
 *
 * With an inner shoulder ring at 0.58r and the notch vertices tucked INSIDE it
 * at 0.50r, the four triangles of one flap-pair come out:
 *
 *     crown fan        ny  0.86     azimuth 30°    -> full lit rung
 *     flap west half   ny  0.445    azimuth 49°    -> mid
 *     flap east half   ny  0.445    azimuth 11°    -> mid, 39° round from its twin
 *     notch wall       ny -0.01     azimuth 30°    -> body (darkest) rung
 *
 * Three clean bands of normal.y for the albedo ramp to separate, and a 39°
 * azimuth split inside each flap for the key light to separate — which is the
 * "clearly lit side and shaded side within one tier" note. It costs 2 triangles
 * per rim vertex, i.e. `4 * (seg/2)` per tier.
 *
 * The notch vertex being tucked inside the shoulder ring also deepens the
 * silhouette: the outline zigzags between r and 0.50r instead of between r and
 * 0.9r, so the serrated edge survives being 40 px tall on screen.
 *
 * @param r     outer radius of the flap tips
 * @param hUp   height of the crown apex above the shoulder ring (keep SHALLOW,
 *              ~0.3r — that is what makes the crown facets bright)
 * @param drop  how far a flap tip hangs below the shoulder ring
 * @param seg   rim vertices; must be EVEN. seg/2 flaps.
 */
export function firFrond(r, hUp, drop, seg, o = {}, rng) {
  const f = rng ? (a, b) => rng.float(a, b) : (a, b) => (a + b) / 2;
  const half = Math.max(3, Math.round(seg / 2));
  const S = half * 2;
  /**
   * THE SHOULDER RING, SWEPT. At 0.55-0.70 the crown fan is a large near-flat
   * plateau, and once the tiers are evenly spaced the row above stops covering
   * it — so the tree renders as a stack of pale polygons with a fringe of thorns
   * round it, which is exactly the "flat colour per facet, reads as a cut-out"
   * note. At 0.28-0.42 the flaps reach nearly to the trunk, the crown fan
   * shrinks to a few small triangles at the axis, and what you see is rows of
   * pads with dark creases between them — the reference's structure.
   */
  const inner = o.inner ?? 0.50;   // shoulder ring, as a fraction of r
  /**
   * THE NOTCH RADIUS IS NOT A FREE PARAMETER — it is solved.
   *
   * The notch wall is the triangle (I[j], I[j+1], O[notch]), and it is vertical
   * (normal.y = 0, i.e. as dark as the ramp goes) exactly when the notch vertex
   * sits on the CHORD between the two shoulder vertices either side of it. That
   * chord's distance from the axis is `inner * cos(PI/half)`, which depends on
   * how many flaps the tier has — so a fixed 0.50 that gave a vertical wall at
   * seg 12 gave a 21-degree outward-leaning one at seg 8, and the darkest note
   * in the tier quietly went missing on the small species. `notchK` nudges it
   * either side of vertical; below 1 the wall overhangs and gets culled at this
   * camera, which is wasted geometry, so it stays at or just above 1.
   */
  const notch = o.notch ?? inner * Math.cos(Math.PI / half) * (o.notchK ?? 1.02);
  /**
   * NEGATIVE RESULT, KEPT SO IT IS NOT TRIED AGAIN. Solving the notch radius for
   * a vertical (darkest) wall pins it just inside the shoulder ring, so the
   * tier's plan outline is a star with points at r and valleys at ~0.31r, and in
   * the frame that reads as a thin spiky rosette rather than the broad dense cone
   * the reference has. The obvious fix — an extra "hem" vertex out at 0.86r
   * between two flap tips, to fill the V — does not work in this topology: the V
   * between two tips is ALREADY closed by the two flap facets that meet at the
   * notch vertex, so the hem triangles double-cover the flaps, and being lower
   * than the notch they wind inward. Shot, that put 7.3% of the frame in the
   * bottom luma bucket against the reference's 0.9% and printed 5.3% of it as
   * #171717. Filling the plan outline needs a THIRD RING (shoulder -> mid -> tip)
   * so the frill curls, which is 4*seg per tier instead of 2*seg — affordable
   * only if the conifer count comes down with it.
   */
  const spin = o.spin ?? 0;
  const A = [0, hUp, 0];
  const I = [], O = [];
  for (let j = 0; j < half; j++) {
    const a = (j / half) * Math.PI * 2 + spin;
    const rr = r * inner * f(0.90, 1.10);
    I.push([Math.cos(a) * rr, r * f(-0.045, 0.045), Math.sin(a) * rr]);
  }
  const da = (Math.PI * 2) / S;
  for (let i = 0; i < S; i++) {
    const long = i % 2 === 0;
    // ANGULAR jitter as well as radial. Without it the hem is a mathematically
    // regular star, and 15 000 instances of one regular star is exactly the "all
    // one shape" note — the yaw per instance hides nothing, because a regular
    // star looks the same from every yaw. Nudging each tip up to a third of a
    // segment round makes the flaps different WIDTHS, which is what an uneven
    // fringe actually is.
    const a = (i / S) * Math.PI * 2 + spin + da * f(-0.30, 0.30);
    const rr = long ? r * f(0.86, 1.10) : r * notch * f(0.88, 1.12);
    const y = long ? -drop * f(0.78, 1.30) : -drop * f(0.20, 0.52);
    O.push([Math.cos(a) * rr, y, Math.sin(a) * rr]);
  }
  const v = [];
  const T = (p, q, s) => {
    v.push(p[0], p[1], p[2], q[0], q[1], q[2], s[0], s[1], s[2]);
  };
  // WINDING. With the rim running (cos a, sin a) in (x, z) and +Y up, a triangle
  // is OUTWARD-facing as (upper-inner, lower[i+1], lower[i]) — the same
  // convention `firTier` had to be corrected to. Getting this backwards is what
  // left `firTier` unused for three rounds.
  for (let j = 0; j < half; j++) {
    const j1 = (j + 1) % half;
    const i0 = j * 2, i1 = i0 + 1, i2 = (i0 + 2) % S;
    T(A, I[j1], I[j]);        // crown fan   — shallow, brightest
    T(I[j], O[i1], O[i0]);    // flap, west half
    T(I[j], I[j1], O[i1]);    // notch wall  — near vertical, darkest
    T(I[j1], O[i2], O[i1]);   // flap, east half
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Palette derivation. Landmarks and props need more materials than the Palette
// declares (plaster, roof tile, rusted metal...). Rather than invent hexes we
// derive every one from an existing palette entry, so an art-direction change
// in palette.js still moves the whole world.
// ---------------------------------------------------------------------------

const C = (hex) => new THREE.Color(hex);
const off = (c, h, s, l) => c.clone().offsetHSL(h, s, l);

/**
 * DARKEN — and the reason `off(c, 0, 0, -x)` must never be used for it.
 *
 * THREE.Color stores LINEAR values, so `getHSL` reports a linear lightness. A
 * mid-brown timber like #6b4a30 measures l = 0.09 there, not the ~0.30 the hex
 * suggests, and `offsetHSL(0, 0.02, -0.09)` therefore lands it on exactly
 * black. Auditing every entry in this table found four that had collapsed:
 * trunkDark, woodDark, tar and (nearly) roofSlate — i.e. every shutter, door,
 * balcony rail, baluster and window surround on the alpine chalet was a
 * PURE BLACK box, which at this camera height is the strongest note a small
 * building can make. The chalet's windows were being blamed for it.
 *
 * Scaling is what "further into shadow" means physically and it cannot reach
 * black by accident: `dark(c, 0.45)` is always 45% of the light coming off c.
 */
const dark = (c, k) => c.clone().multiplyScalar(k);

/** Pull a colour k of the way toward its own luminance — i.e. desaturate it
 *  without changing how bright it is. Stone needs this: the palette's `rock` is
 *  a warm brown-grey and the reference's is a near-neutral one. */
function neutral(c, k) {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return c.clone().lerp(new THREE.Color(l, l, l), k);
}

export function derivePalette(p, biomeId) {
  const rock = C(p.rock);
  const rockDark = C(p.rockShadow);
  const trunk = C(p.trunk);
  const accent0 = C(p.accents[0]);
  const accent1 = C(p.accents[1] ?? p.accents[0]);
  const white = C(p.accents[p.accents.length - 1]);
  const edge = C(p.roadEdge);

  return {
    trunk,
    trunkDark: dark(off(trunk, 0, 0.02, 0), 0.42),
    bark: off(trunk, 0.01, -0.04, 0.05),
    birch: off(edge, 0.0, -0.22, 0.16),
    dead: off(trunk, 0.0, -0.30, 0.14),

    rock,
    rockDark,
    scree: off(rock, 0, -0.05, -0.05),
    stone: off(rock, 0, -0.04, -0.02),
    stoneDark: off(rockDark, 0, 0, -0.04),

    /**
     * THE STONE TRIAD — three planes of one grey rock, measured off target_01.
     *
     * The previous round built boulders as `rock` lerped a THIRD of the way to
     * plasterWarm (a tan road-edge colour) and then lerped its top plane 52-68%
     * toward `sunlit` (rgb 255,241,215). That albedo is rgb(225,207,181) before
     * anything is done to it, and the frame's grade — which adds 5% red and
     * 10.5% blue — landed the rendered crowns on rgb(232,184,184): red and blue
     * equal, green 45 below both. That is not stone, it is skin, and it is the
     * first thing the client saw.
     *
     * Sampled off target_01's meadow boulders instead:
     *
     *     sunlit top plane   rgb(200,184,145)   B/G 0.79   warm, not white
     *     side flank         rgb(152,140,112)   B/G 0.80   plain warm grey
     *     shadow underside   rgb( 96, 80, 80)   B/G 1.00   NEUTRAL, cool
     *
     * Two things fall out that the old code had backwards. The warmth belongs
     * to the LIT plane only — the shadow side of a reference boulder is
     * neutral, its blue equal to its green — and the lit plane is only a
     * QUARTER-step warm (B/G 0.79), not the near-yellow `sunlit` used before.
     * `sunlit` stays, because road gravel and grass crowns want it; stone does
     * not.
     *
     * Everything below is derived: `rock` desaturated toward its own luminance,
     * then lifted toward `white` (the palette's own last accent) for the top and
     * scaled down for the shadow. Blue is pulled back by a measured factor
     * rather than by lerping toward a yellow, because lerping toward yellow
     * takes green with it and the reference's stone keeps its green.
     *
     * The blue factors look brutal until you measure what the frame does to a
     * grey. Shot and sampled on the same boulder: an albedo of (114,108,97)
     * renders at (132,130,140) on a side face and (209,189,184) on a top one —
     * the hemisphere ambient is sky blue and the grade adds another 10% of blue
     * on top, so a NEUTRAL albedo comes out distinctly cool and a warm one comes
     * out pink. Every stone tone below is therefore pre-compensated: B/G ~0.63
     * in the albedo lands at B/G ~0.79 on screen, which is target_01's number.
     *
     * ---- ROUND 8 CORRECTION: THE PRE-COMPENSATION HAD OUTLIVED ITS CAUSE ----
     *
     * Everything above was written against a grade that has since been retuned
     * by the render agent. Sampled on the r10 hero frame, the pre-compensated
     * albedos (body B/G 0.76, top B/G 0.74) now render as rgb(232,220,186) on a
     * crown and rgb(196,186,152) on a flank — CREAM, near the colour of the
     * gravel, which is the client's "different rocks" complaint arriving as a
     * colour problem before it is a shape problem. Cropping target_01 at 3.4x
     * next to ours: its meadow boulder is a plain pale GREY solid,
     * rgb(210,206,198) on the crown, rgb(150,146,142) on the flank,
     * rgb(104,98,100) on the shadow side — B/G within 3% of unity everywhere,
     * and only the crown carries any warmth at all.
     *
     * So the triad is built neutral now and the warmth is spent where the
     * reference spends it — a couple of percent on the TOP face only. If a
     * later grade change makes them read cool again, warm the top, not the body:
     * a warm body is what made them flesh, twice.
     */
    stoneBody: (() => {
      // Cool-neutral mid grey. `rock` is a warm brown-grey, so almost all of
      // its chroma is thrown away; what is kept is its VALUE.
      // ...and then a percent of warmth is put BACK. Shot neutral, the blocks
      // came back lavender (rgb 184,188,200): the sky ambient is blue and a
      // literally neutral albedo cannot resist it. 3% of red over blue in the
      // albedo is enough to land the render on target_01's near-unity B/G.
      // Measured on the shot, not guessed: masking every near-neutral pixel of
      // the frame (max-min < 20% of max) gave ours rgb(147,137,148) against the
      // reference's rgb(152,142,137) in the same band — B/G 1.08 vs 0.96. So
      // the compensation needed is about 12% of blue and 4% of red, one tenth
      // of the 0.62 factor that produced cream.
      const g = neutral(rock, 0.90);
      g.multiplyScalar(0.62);
      g.r *= 1.02; g.b *= 0.66;
      return g;
    })(),
    stoneTop: (() => {
      // The CROWN, and its job is to be one of the three brightest things in
      // the frame. Cropping target_01's meadow boulder at 8x: the planed top is
      // rgb(232,228,214) — near white — while the flank beside it is
      // rgb(150,140,132) and the shadow face rgb(96,84,80). That is a range of
      // 2.4 stops WITHIN one rock, and it is the whole reason its stone reads
      // as a solid with light on it. Ours ran the entire solid inside 20 levels.
      // 0.56 toward white shot as literal WHITE paper — the crowns became the
      // brightest thing in the frame by a mile and the meadow filled with what
      // looked like discarded envelopes. 0.38 was still reading as paper once
      // the map carried four rock families instead of one; at 0.27, with the
      // warmth pushed a little further, a crown lands on the reference's
      // rgb(210,206,198) rather than on its rgb(235,231,220) blown highlight,
      // and only the handful of genuinely sky-facing facets get the latter.
      const g = neutral(rock, 0.90).lerp(white, 0.32);
      g.r *= 1.07; g.b *= 0.69;
      return g;
    })(),
    stoneLow: (() => {
      // The shadow side, and it has to be a CLEAR step, not a shading nuance:
      // in target_01 the dark face of a boulder is half the value of its flank.
      // Shot at 0.74 the whole solid read as one pale value with no dark side
      // left at all, which is most of why our stone looked like folded paper.
      const g = neutral(rockDark, 0.88).multiplyScalar(0.34);
      g.r *= 1.04; g.b *= 0.78;
      return g;
    })(),

    /**
     * BARE EARTH. target_01's meadow is not continuous turf: every few tens of
     * metres there is a scrape of open ground — under a fallen log, at the lip
     * of a bank, where a boulder train has slid — and those brown patches are a
     * quiet but large part of the "other" pixel population the frame is short
     * of. Derived from the trunk brown, pulled toward the road edge so it is
     * lighter and greyer than bark: soil in sun is not the colour of wood.
     */
    soil: off(trunk, 0.0, -0.16, 0.055).lerp(edge, 0.20),
    soilLit: off(trunk, 0.0, -0.24, 0.10).lerp(edge, 0.42),

    // Man-made
    plaster: off(edge, 0, -0.10, 0.16),
    plasterWarm: off(edge, -0.02, 0.05, 0.10),
    wood: off(trunk, 0.005, 0.06, 0.02),
    woodDark: dark(off(trunk, 0, 0.04, 0), 0.38),
    woodPale: off(trunk, 0.01, -0.10, 0.20),
    roofTile: off(accent0, -0.01, -0.12, -0.20),
    roofSlate: dark(off(rockDark, 0.02, 0.02, 0), 0.55),
    roofMetal: off(rock, 0.01, -0.12, 0.06),
    rust: dark(off(accent0, -0.03, -0.18, 0), 0.30),
    metal: off(rock, 0.0, -0.22, 0.04),
    metalDark: off(rockDark, 0, -0.15, -0.02),
    white,
    /**
     * THE FRAME'S HIGHLIGHT COLOUR — the tone every sunlit top plane blends
     * toward. Not pure white: sampled off target_01, the brightest natural
     * surfaces in it (boulder crowns, the gravel, sunlit grass) all sit around
     * rgb(170,145,95) — strongly warm, because they are lit by a low afternoon
     * sun through a warm sky. A neutral highlight at this camera height reads
     * as snow, which is the exact mistake the first pass at this made.
     */
    sunlit: white.clone().lerp(accent1, 0.34),
    signRed: accent0,
    signYellow: accent1,
    tar: dark(off(rockDark, 0, -0.1, 0), 0.45),
    glass: off(C(p.skyHorizon), 0, 0.05, -0.28),
    hay: off(C(p.ground[3] ?? p.ground[2]), 0.01, 0.12, 0.02),
    snow: off(C(p.ground[p.ground.length - 1]), 0, 0, 0.02),
    accents: p.accents.map(C),
    biomeId,
  };
}
